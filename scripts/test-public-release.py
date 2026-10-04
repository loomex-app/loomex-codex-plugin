#!/usr/bin/env python3
"""Regression tests against a built envelope; never fabricate compiled provenance."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
import sys
import subprocess
from unittest.mock import patch
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('public_release', Path(__file__).with_name('package-public-release.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class DistributionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.release = RELEASE
        self.manifest = json.loads((RELEASE / 'manifest.json').read_text())
        self.name = f'loomex-plugin-{self.manifest["version"]}-darwin-arm64-preview.tar.gz'

    def tearDown(self):
        self.temporary.cleanup()

    def package(self, **changes):
        arguments = dict(release=self.release, output=self.root / self.name, tag=TAG, source_revision=self.manifest['sourceRevision'], preview=True)
        arguments.update(changes)
        return module.package(**arguments)

    def test_complete_flat_distribution_and_deterministic_bytes(self):
        metadata = self.package()
        output = self.root / self.name
        other = self.root / 'other' / self.name
        self.package(output=other)
        self.assertEqual(module.digest(output), module.digest(other))
        with tarfile.open(output) as archive:
            members = archive.getmembers()
            names = {m.name for m in members}
            self.assertTrue(all(m.isfile() and not m.name.startswith('/') and '..' not in Path(m.name).parts for m in members))
            self.assertEqual(names, {e['path'] for e in metadata['files']} | {'public-distribution.json'})
            for entry in metadata['files']:
                member = archive.getmember(entry['path'])
                data = archive.extractfile(member).read()
                self.assertEqual(hashlib.sha256(data).hexdigest(), entry['sha256'])
                self.assertEqual(len(data), entry['size'])
                self.assertEqual(member.mode, entry['mode'])
            for launcher in ['install.sh', 'lifecycle.sh', 'uninstall.sh']:
                self.assertEqual(archive.getmember('scripts/' + launcher).mode, 0o755)
            components = json.load(archive.extractfile('plugin-components.json'))
            self.assertTrue(components['tools'])
            self.assertTrue(components['resources'])
            self.assertTrue(components['hooks'])
            self.assertNotIn('source', components)  # copied package cannot claim clean checkout identity
            self.assertEqual(metadata['repository'], 'loomex-app/loomex-codex-plugin')
        self.assertEqual(output.with_suffix('.gz.sha256').read_text(), f'{module.digest(output)}  {self.name}\n')

    def test_tag_version_and_preview_policy(self):
        for tag in ['latest', 'preview-runner-v0.5.1-plugin-v99.99.99', TAG.removeprefix('preview-'), TAG + '/../../escape']:
            with self.subTest(tag=tag), self.assertRaisesRegex(ValueError, 'paired tag'):
                self.package(tag=tag)
        with self.assertRaisesRegex(ValueError, 'preview policy'):
            self.package(preview=False, tag=TAG.removeprefix('preview-'))

    def test_source_identity(self):
        for revision in ['unknown', 'f' * 40, self.manifest['sourceRevision'][:8]]:
            with self.subTest(revision=revision), self.assertRaisesRegex(ValueError, 'source revision'):
                self.package(source_revision=revision)

    def test_clean_source_qualification_refuses_dirty_and_mismatched_heads(self):
        with patch.object(module.subprocess, 'check_output', side_effect=[self.manifest['sourceRevision'], ' M package.json']):
            with self.assertRaisesRegex(ValueError, 'requires a clean checkout'):
                self.package(qualify_clean_source=True)
        with patch.object(module.subprocess, 'check_output', side_effect=['f' * 40, '']):
            with self.assertRaisesRegex(ValueError, 'HEAD must match'):
                self.package(qualify_clean_source=True)

    def test_clean_source_qualification_rejects_stale_actual_compiled_bytes(self):
        payload = self.root / 'payload'
        subprocess.run(['python3', str(module.ROOT / 'scripts/artifact.py'), 'extract', '--release', str(RELEASE), '--allow-unsigned-development', '--extract', str(payload)], check=True)
        source = self.root / 'source'
        (source / 'dist').mkdir(parents=True)
        for name in ['server.js', 'lifecycle.mjs', 'compatibility-check.mjs', 'compatibility-export.mjs']:
            shutil.copy2(payload / 'plugin/dist' / name, source / 'dist' / name)
        with (source / 'dist/compatibility-export.mjs').open('a') as bundle:
            bundle.write('\n// stale compiled artifact\n')
        original = module.ROOT
        module.ROOT = source
        try:
            with self.assertRaisesRegex(ValueError, 'compiled bundle differs'):
                module.qualify_components(payload / 'plugin', self.root, self.root, self.manifest['sourceRevision'])
        finally:
            module.ROOT = original

    def test_create_only_and_filename(self):
        with self.assertRaisesRegex(ValueError, 'create-only'):
            self.package(output=self.root / 'latest.tar.gz')
        (self.root / self.name).write_text('owned elsewhere')
        with self.assertRaisesRegex(ValueError, 'create-only'):
            self.package()
        self.assertEqual((self.root / self.name).read_text(), 'owned elsewhere')

    def test_dangling_output_checksum_and_parent_links_are_not_followed(self):
        destination = self.root / self.name
        foreign = self.root / 'foreign' / self.name
        destination.symlink_to(foreign)
        with self.assertRaisesRegex(ValueError, 'create-only'):
            self.package()
        self.assertTrue(destination.is_symlink())
        self.assertFalse(foreign.exists())
        destination.unlink()
        checksum = destination.with_suffix('.gz.sha256')
        checksum.symlink_to(self.root / 'foreign.sha256')
        with self.assertRaisesRegex(ValueError, 'create-only'):
            self.package()
        self.assertFalse(destination.exists())
        self.assertFalse((self.root / 'foreign.sha256').exists())
        checksum.unlink()
        parent = self.root / 'linked-parent'
        foreign.parent.mkdir()
        parent.symlink_to(foreign.parent, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'parent may not'):
            self.package(output=parent / self.name)
        self.assertFalse(foreign.exists())

    def test_envelope_inventory_and_links(self):
        copied = self.root / 'release'
        shutil.copytree(RELEASE, copied)
        (copied / '.env').write_text('not a permitted release member')
        with self.assertRaisesRegex(ValueError, 'inventory mismatch'):
            self.package(release=copied)
        (copied / '.env').unlink()
        (copied / 'checkout').symlink_to(module.ROOT, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'unsupported filesystem member'):
            self.package(release=copied)

    def test_launcher_bytes_require_actual_build_source_provenance(self):
        source = self.root / 'source'
        (source / 'scripts').mkdir(parents=True)
        for name in ['install.sh', 'lifecycle.sh', 'uninstall.sh']:
            shutil.copy2(module.ROOT / 'scripts' / name, source / 'scripts' / name)
        (source / 'scripts/install.sh').write_text('# changed after build\n')
        original = module.ROOT
        # Keep artifact verifier from the real checkout, only mutate launchers after extraction.
        shutil.copy2(original / 'scripts/artifact.py', source / 'scripts/artifact.py')
        module.ROOT = source
        try:
            with self.assertRaisesRegex(ValueError, 'launcher source does not match'):
                self.package()
        finally:
            module.ROOT = original

    def test_workflow_preserves_production_and_preview_gates(self):
        production = (module.ROOT / '.github/workflows/release.yml').read_text()
        preview = (module.ROOT / '.github/workflows/preview-release.yml').read_text()
        for gate in ['CERTIFICATE_P12_BASE64', 'APPLE_TEAM_ID', 'MANIFEST_KEY_BASE64', 'build-release.sh --production', '--public-key']:
            self.assertIn(gate, production)
        for gate in ['build-release.sh --unsigned-development', '--unsigned-preview', 'environment: preview-release-review', '--verify-tag --draft --prerelease', 'node-version: 24.20.0', 'test-public-release.py', '--qualify-clean-source']:
            self.assertIn(gate, preview)
        self.assertLess(preview.index('build-release.sh --unsigned-development'), preview.index('package-public-release.py'))
        self.assertNotIn('gh release publish', preview)
        self.assertNotIn('releases/latest', preview)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True, type=Path)
    parser.add_argument('--release-tag', required=True)
    arguments = parser.parse_args()
    RELEASE = arguments.release.resolve()
    TAG = arguments.release_tag
    unittest.main(argv=['test-public-release.py'], verbosity=2)
