#!/usr/bin/env python3
"""Wrap a verified compiled release envelope for an exact paired GitHub release."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
REPOSITORY = 'loomex-app/loomex-codex-plugin'

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def canonical(data):
    return (json.dumps(data, sort_keys=True, separators=(',', ':')) + '\n').encode()

def regular(path):
    if not path.is_file() or path.is_symlink():
        raise ValueError(f'regular file required: {path}')

def qualify_components(plugin, stage, temporary, source_revision):
    # Compare compiled bytes first, then export source identity through the
    # actual packaged checker. This preserves its native JSON byte format.
    for name in ['server.js', 'lifecycle.mjs', 'compatibility-check.mjs', 'compatibility-export.mjs']:
        source_bundle = ROOT / 'dist' / name
        regular(source_bundle)
        if digest(source_bundle) != digest(plugin / 'dist' / name):
            raise ValueError(f'clean source compiled bundle differs from verified payload: {name}')
    qualified = temporary / 'qualified-components.json'
    subprocess.run([str(plugin / 'runtime/bin/node'), str(plugin / 'dist/compatibility-check.mjs'), '--package-root', str(ROOT), '--source-root', str(ROOT), '--output', str(qualified)], check=True)
    qualified_data = json.loads(qualified.read_text())
    source_identity = qualified_data.pop('source', None)
    if source_identity != {'headRevision': source_revision, 'workingTree': 'clean'} or qualified_data != json.loads((stage / 'plugin-components.json').read_text()):
        raise ValueError('qualified compiled component export differs from packaged components')
    shutil.copyfile(qualified, stage / 'plugin-components.json')

def package(release, output, tag, source_revision, preview, public_key=None, qualify_clean_source=False):
    # Check the caller's lexical destinations before resolving: a dangling
    # symlink must not redirect a create-only archive or checksum to new bytes.
    lexical_output = Path(output).absolute()
    lexical_checksum = lexical_output.with_suffix(lexical_output.suffix + '.sha256')
    if lexical_output.exists() or lexical_output.is_symlink() or lexical_checksum.exists() or lexical_checksum.is_symlink():
        raise ValueError('create-only output and checksum destinations must not exist or be symbolic links')
    if lexical_output.parent.is_symlink():
        raise ValueError('create-only output parent may not be a symbolic link')
    release, output = Path(release).resolve(), lexical_output.resolve()
    manifest = json.loads((release / 'manifest.json').read_text())
    version = manifest['version']
    expected_tag = rf'runner-v[0-9]+\.[0-9]+\.[0-9]+-plugin-v{re.escape(version)}'
    if not re.fullmatch(expected_tag, tag):
        raise ValueError('paired tag must match plugin envelope version')
    if manifest.get('project') != 'loomex-plugin' or manifest.get('platform') != 'darwin-arm64':
        raise ValueError('unsupported plugin envelope identity')
    if not re.fullmatch('[0-9a-f]{40}', source_revision) or manifest.get('sourceRevision') != source_revision:
        raise ValueError('exact full source revision must match envelope')
    if manifest.get('developmentOnly') is not preview:
        raise ValueError('preview policy must match envelope developmentOnly')
    expected_name = f'loomex-plugin-{version}-darwin-arm64.tar.gz'
    if output.name != expected_name or output.exists() or output.with_suffix(output.suffix + '.sha256').exists():
        raise ValueError(f'create-only output must be named {expected_name}')
    if qualify_clean_source:
        head = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', '--verify', 'HEAD'], text=True).strip()
        status = subprocess.check_output(['git', '-C', str(ROOT), 'status', '--porcelain=v1', '--untracked-files=all'], text=True).strip()
        if head != source_revision:
            raise ValueError('clean source HEAD must match exact envelope source revision')
        if status:
            raise ValueError('clean source qualification requires a clean checkout')
    command = ['python3', str(ROOT / 'scripts/artifact.py'), 'extract', '--release', str(release), '--project', 'loomex-plugin', '--platform', 'darwin-arm64']
    if qualify_clean_source:
        command += ['--source-root', str(ROOT)]
    if preview:
        command += ['--allow-unsigned-development']
    elif public_key:
        command += ['--public-key', str(public_key)]
    else:
        raise ValueError('production requires trusted manifest public key')
    allowed = {'manifest.json', 'payload.tar.gz', 'source-content.json', 'lifecycle.mjs', 'lifecycle-runtime/node'}
    if not preview:
        allowed.add('manifest.sig')
    actual = set()
    for path in release.rglob('*'):
        if path.is_symlink() or (not path.is_file() and not path.is_dir()):
            raise ValueError('release contains unsupported filesystem member')
        if path.is_file():
            actual.add(path.relative_to(release).as_posix())
    if actual != allowed:
        raise ValueError(f'envelope inventory mismatch: {sorted(actual ^ allowed)}')
    with tempfile.TemporaryDirectory() as temporary:
        temporary = Path(temporary)
        payload = temporary / 'payload'
        subprocess.run(command + ['--extract', str(payload)], check=True)
        plugin = payload / 'plugin'
        for name in ['dist/server.js', 'dist/lifecycle.mjs', 'dist/compatibility-check.mjs', 'dist/compatibility-export.mjs', 'runtime/bin/node', 'runtime/LICENSE', '.codex-plugin/plugin.json']:
            regular(plugin / name)
        if json.loads((plugin / 'package.json').read_text())['version'] != version or json.loads((plugin / '.codex-plugin/plugin.json').read_text())['version'] != version:
            raise ValueError('payload version differs from envelope')
        if not (plugin / 'licenses').is_dir() or not any((plugin / 'licenses').rglob('*')):
            raise ValueError('third-party licenses are required')
        runtime_version = subprocess.check_output([str(plugin / 'runtime/bin/node'), '--version'], text=True).strip()
        if runtime_version != 'v24.20.0':
            raise ValueError('packaged Node runtime must be v24.20.0')
        stage = temporary / 'stage'
        shutil.copytree(release, stage)
        source = json.loads((release / 'source-content.json').read_text())
        source_files = {entry['path']: entry for entry in source['files']}
        for name in ['install.sh', 'lifecycle.sh', 'uninstall.sh']:
            relative = f'scripts/{name}'
            path = ROOT / relative
            regular(path)
            entry = source_files.get(relative)
            if not entry or digest(path) != entry['sha256'] or path.stat().st_size != entry['size'] or stat.S_IMODE(path.stat().st_mode) != entry['mode']:
                raise ValueError(f'launcher source does not match build provenance: {relative}')
            target = stage / relative
            target.parent.mkdir(exist_ok=True)
            shutil.copy2(path, target)
        subprocess.run([str(plugin / 'runtime/bin/node'), str(plugin / 'dist/compatibility-check.mjs'), '--package-root', str(plugin), '--output', str(stage / 'plugin-components.json')], check=True)
        if qualify_clean_source:
            qualify_components(plugin, stage, temporary, source_revision)
        inventory = [{'path': p.relative_to(stage).as_posix(), 'sha256': digest(p), 'size': p.stat().st_size, 'mode': stat.S_IMODE(p.stat().st_mode)} for p in sorted(stage.rglob('*')) if p.is_file()]
        metadata = {'schema': 'app.loomex.plugin-public-distribution/v1', 'repository': REPOSITORY, 'releaseTag': tag, 'version': version, 'sourceRevision': source_revision, 'platform': 'darwin-arm64', 'developmentOnly': preview, 'manifestSha256': digest(stage / 'manifest.json'), 'files': inventory}
        (stage / 'public-distribution.json').write_bytes(canonical(metadata))
        output.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive create, deterministic bytes, flat envelope: no checkout or source tree.
        raw = output.open('xb')
        try:
            with raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as zipped, tarfile.open(fileobj=zipped, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                for path in sorted(stage.rglob('*')):
                    if not path.is_file():
                        continue
                    info = archive.gettarinfo(str(path), arcname=path.relative_to(stage).as_posix())
                    info.uid = info.gid = info.mtime = 0
                    info.uname = info.gname = ''
                    with path.open('rb') as data:
                        archive.addfile(info, data)
            with output.with_suffix(output.suffix + '.sha256').open('x') as checksum:
                checksum.write(f'{digest(output)}  {output.name}\n')
        except Exception:
            output.unlink(missing_ok=True)
            raise
    return metadata

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--release-tag', required=True)
    parser.add_argument('--source-revision', required=True)
    parser.add_argument('--unsigned-development', '--unsigned-preview', dest='unsigned_preview', action='store_true')
    parser.add_argument('--public-key')
    parser.add_argument('--qualify-clean-source', action='store_true')
    args = parser.parse_args()
    try:
        result = package(args.release, args.output, args.release_tag, args.source_revision, args.unsigned_preview, args.public_key, args.qualify_clean_source)
        print(json.dumps({key: result[key] for key in ['releaseTag', 'sourceRevision', 'version', 'developmentOnly', 'manifestSha256']}))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'public packaging rejected: {error}\n')
