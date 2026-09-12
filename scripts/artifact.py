#!/usr/bin/env python3
"""Create and verify Loomex's deterministic release envelope."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tarfile
import tempfile


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def inventory(root: Path) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if path.is_symlink():
            raise SystemExit(f"release payload may not contain symlinks: {relative}")
        if not path.is_file():
            continue
        result.append({
            "path": relative.as_posix(),
            "sha256": digest(path),
            "size": path.stat().st_size,
            "mode": stat.S_IMODE(path.stat().st_mode),
        })
    return result


def source_paths(root: Path, excluded: set[Path] | None = None) -> list[Path]:
    """Return the source files represented by a checkout, including untracked work."""
    git = root / ".git"
    if git.exists():
        deleted = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--deleted", "-z"],
            check=True, capture_output=True,
        ).stdout.split(b"\0")
        if any(deleted):
            raise SystemExit("source checkout has tracked deletions; restore them before release")
        try:
            listed = subprocess.run(
                ["git", "-C", str(root), "ls-files", "-co", "--exclude-standard", "-z"],
                check=True, capture_output=True,
            ).stdout.split(b"\0")
            paths = [root / item.decode() for item in listed if item]
        except (OSError, subprocess.CalledProcessError):
            paths = []
    else:
        paths = [path for path in root.rglob("*") if path.is_file()]
    result = []
    excluded = excluded or set()
    for path in sorted(paths):
        relative = path.relative_to(root)
        if path.resolve() in excluded:
            continue
        if path.is_symlink():
            raise SystemExit(f"source input may not be a symlink: {relative}")
        if path.is_file():
            result.append(path)
    return result


def validate_source_data(data: object, root: Path | None = None, expected_revision: str | None = None) -> None:
    if not isinstance(data, dict) or set(data) != {"schema", "sourceRevision", "files"} or data.get("schema") != "app.loomex.source-content/v1":
        raise SystemExit("source content manifest has an unsupported schema")
    revision = data.get("sourceRevision")
    if not isinstance(revision, str) or not revision or (expected_revision is not None and revision != expected_revision):
        raise SystemExit("source content manifest revision mismatch")
    files = data.get("files")
    if not isinstance(files, list):
        raise SystemExit("source content manifest has invalid files")
    previous = ""
    expected = {}
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "size", "mode"}:
            raise SystemExit("source content manifest entry is invalid")
        path = entry.get("path")
        if not isinstance(path, str) or path <= previous:
            raise SystemExit("source content manifest paths are not deterministic")
        validate_member(path)
        sha = entry.get("sha256")
        if not isinstance(sha, str) or len(sha) != 64 or any(char not in "0123456789abcdef" for char in sha):
            raise SystemExit("source content manifest digest is invalid")
        size, mode = entry.get("size"), entry.get("mode")
        if (
            type(size) is not int
            or size < 0
            or type(mode) is not int
            or mode < 0
            or mode > 0o7777
        ):
            raise SystemExit("source content manifest entry metadata is invalid")
        previous = path
        expected[path] = entry
    if not expected:
        raise SystemExit("source content manifest must not be empty")
    if root is not None:
        if not root.is_dir():
            raise SystemExit("source root directory does not exist")
        actual = {
            item["path"]: item
            for item in source_manifest(root, str(revision))["files"]
        }
        if set(actual) != set(expected):
            raise SystemExit("source content paths changed")
        for path, entry in expected.items():
            observed = actual.get(path)
            if observed is None or observed != entry:
                raise SystemExit(f"source content changed: {path}")


def source_manifest(root: Path, source_revision: str, excluded: set[Path] | None = None) -> dict[str, object]:
    if not root.is_dir():
        raise SystemExit("source root directory does not exist")
    files = []
    for path in source_paths(root, excluded):
        relative = path.relative_to(root)
        files.append({
            "path": relative.as_posix(),
            "sha256": digest(path),
            "size": path.stat().st_size,
            "mode": stat.S_IMODE(path.stat().st_mode),
        })
    if not files:
        raise SystemExit("source content manifest must not be empty")
    return {
        "schema": "app.loomex.source-content/v1",
        "sourceRevision": source_revision,
        "files": files,
    }


def deterministic_tar(root: Path, output: Path, epoch: int) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=epoch) as zipped:
            with tarfile.open(fileobj=zipped, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for path in sorted(root.rglob("*")):
                    relative = path.relative_to(root).as_posix()
                    info = archive.gettarinfo(str(path), relative)
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    info.mtime = epoch
                    if info.isfile():
                        with path.open("rb") as handle:
                            archive.addfile(info, handle)
                    elif info.isdir():
                        archive.addfile(info)
                    else:
                        raise SystemExit(f"unsupported payload entry: {relative}")


def canonical(data: object) -> bytes:
    return (json.dumps(data, sort_keys=True, separators=(",", ":")) + "\n").encode()


def openssl(*arguments: str) -> None:
    subprocess.run(["openssl", *arguments], check=True)


def validate_member(name: str) -> None:
    value = PurePosixPath(name)
    if (
        value.is_absolute()
        or ".." in value.parts
        or not value.parts
        or "\\" in name
        or value.as_posix() != name
    ):
        raise SystemExit(f"unsafe archive member: {name}")


def create(args: argparse.Namespace) -> None:
    root = Path(args.payload).resolve()
    destination = Path(args.output).resolve()
    if not root.is_dir():
        raise SystemExit("payload directory does not exist")
    if args.unsigned_development == bool(args.signing_key):
        raise SystemExit("choose exactly one of --signing-key or --unsigned-development")
    if not args.source_manifest:
        raise SystemExit("new release creation requires --source-manifest")
    epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))
    try:
        destination.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        raise SystemExit("release output already exists")
    archive = destination / "payload.tar.gz"
    deterministic_tar(root, archive, epoch)
    files = inventory(root)
    manifest = {
        "schema": "app.loomex.release/v1",
        "project": args.project,
        "version": args.version,
        "platform": args.platform,
        "sourceRevision": args.source_revision,
        "sourceDateEpoch": epoch,
        "developmentOnly": args.unsigned_development,
        "payload": {"file": archive.name, "sha256": digest(archive), "files": files},
    }
    if args.source_manifest:
        source_path = Path(args.source_manifest).resolve()
        source_bytes = source_path.read_bytes()
        source_data = json.loads(source_bytes)
        if canonical(source_data) != source_bytes:
            raise SystemExit("source content manifest is not canonical")
        validate_source_data(source_data, expected_revision=args.source_revision)
        if args.source_root:
            validate_source_data(source_data, Path(args.source_root).resolve(), args.source_revision)
        companion = destination / "source-content.json"
        companion.write_bytes(source_bytes)
        manifest["sourceContent"] = {
            "file": companion.name,
            "sha256": digest(companion),
            "files": len(source_data["files"]),
        }
    manifest_path = destination / "manifest.json"
    manifest_path.write_bytes(canonical(manifest))
    signature = destination / "manifest.sig"
    if args.signing_key:
        openssl("dgst", "-sha256", "-sign", args.signing_key,
                "-out", str(signature), str(manifest_path))
    else:
        signature.unlink(missing_ok=True)


def load_verified(args: argparse.Namespace) -> tuple[Path, dict[str, object]]:
    release = Path(args.release).resolve()
    manifest_path = release / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if canonical(manifest) != manifest_path.read_bytes():
        raise SystemExit("manifest is not canonical JSON")
    if manifest.get("schema") != "app.loomex.release/v1":
        raise SystemExit("unsupported release manifest schema")
    if args.project and manifest.get("project") != args.project:
        raise SystemExit("artifact project provenance mismatch")
    if args.platform and manifest.get("platform") != args.platform:
        raise SystemExit("artifact platform mismatch")
    signature = release / "manifest.sig"
    if manifest.get("developmentOnly"):
        if not args.allow_unsigned_development:
            raise SystemExit("unsigned development artifact rejected")
        if signature.exists():
            raise SystemExit("development artifact unexpectedly contains a signature")
    else:
        if not args.public_key or not signature.is_file():
            raise SystemExit("signed artifact and trusted public key are required")
        openssl("dgst", "-sha256", "-verify", args.public_key,
                "-signature", str(signature), str(manifest_path))
    archive_name = str(manifest["payload"]["file"])
    validate_member(archive_name)
    archive = release / archive_name
    if digest(archive) != manifest["payload"]["sha256"]:
        raise SystemExit("payload digest mismatch")
    source_content = manifest.get("sourceContent")
    if source_content is not None:
        if not isinstance(source_content, dict) or set(source_content) != {"file", "sha256", "files"}:
            raise SystemExit("invalid source content provenance")
        source_name = str(source_content.get("file", ""))
        validate_member(source_name)
        source_file = release / source_name
        if (
            not isinstance(source_content.get("sha256"), str)
            or len(source_content["sha256"]) != 64
            or type(source_content.get("files")) is not int
            or source_content["files"] <= 0
        ):
            raise SystemExit("invalid source content provenance")
        if not source_file.is_file() or digest(source_file) != source_content.get("sha256"):
            raise SystemExit("source content manifest digest mismatch")
        source_bytes = source_file.read_bytes()
        source_data = json.loads(source_bytes)
        if canonical(source_data) != source_bytes:
            raise SystemExit("source content manifest is not canonical")
        validate_source_data(
            source_data,
            Path(args.source_root).resolve() if args.source_root else None,
            str(manifest["sourceRevision"]),
        )
        source_files = source_data.get("files")
        if source_content.get("files") != len(source_files):
            raise SystemExit("source content manifest inventory mismatch")
    elif not args.allow_legacy_source_provenance:
        raise SystemExit(
            "release lacks source provenance; pass --allow-legacy-source-provenance "
            "only for documented historical artifact inspection"
        )
    return archive, manifest


def verify_or_extract(args: argparse.Namespace) -> None:
    archive, manifest = load_verified(args)
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        with tarfile.open(archive, "r:gz") as source:
            for member in source.getmembers():
                validate_member(member.name)
                if member.issym() or member.islnk() or member.isdev():
                    raise SystemExit(f"unsupported archive member: {member.name}")
            for member in source.getmembers():
                source.extract(member, root)
        actual = inventory(root)
        if actual != manifest["payload"]["files"]:
            raise SystemExit("payload inventory mismatch")
        if args.extract:
            destination = Path(args.extract).resolve()
            if destination.exists():
                raise SystemExit("extraction destination already exists")
            shutil.copytree(root, destination)


parser = argparse.ArgumentParser()
sub = parser.add_subparsers(required=True)
source = sub.add_parser("source-manifest")
source.add_argument("--root", required=True)
source.add_argument("--output", required=True)
source.add_argument("--source-revision", required=True)
source.add_argument("--snapshot")
def write_source_manifest(args: argparse.Namespace) -> None:
    output = Path(args.output).resolve()
    if output.exists():
        raise SystemExit("source manifest output already exists")
    root = Path(args.root).resolve()
    data = source_manifest(root, args.source_revision, {output})
    output.write_bytes(canonical(data))
    if args.snapshot:
        destination = Path(args.snapshot).resolve()
        if destination.exists():
            raise SystemExit("source snapshot output already exists")
        destination.mkdir(parents=True)
        for entry in data["files"]:
            source_file = root / entry["path"]
            target = destination / entry["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_file, target)
        validate_source_data(data, destination, args.source_revision)
source.set_defaults(run=write_source_manifest)
make = sub.add_parser("create")
make.add_argument("--payload", required=True)
make.add_argument("--output", required=True)
make.add_argument("--project", required=True)
make.add_argument("--version", required=True)
make.add_argument("--platform", required=True)
make.add_argument("--source-revision", required=True)
make.add_argument("--source-manifest")
make.add_argument("--source-root")
make.add_argument("--signing-key")
make.add_argument("--unsigned-development", action="store_true")
make.set_defaults(run=create)
for command in ("verify", "extract"):
    item = sub.add_parser(command)
    item.add_argument("--release", required=True)
    item.add_argument("--project")
    item.add_argument("--platform")
    item.add_argument("--public-key")
    item.add_argument("--source-root")
    item.add_argument("--allow-unsigned-development", action="store_true")
    item.add_argument("--allow-legacy-source-provenance", action="store_true")
    if command == "extract":
        item.add_argument("--extract", required=True)
    else:
        item.set_defaults(extract=None)
    item.set_defaults(run=verify_or_extract)
args = parser.parse_args()
args.run(args)
