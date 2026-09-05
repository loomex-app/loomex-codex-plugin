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
    if value.is_absolute() or ".." in value.parts or not value.parts:
        raise SystemExit(f"unsafe archive member: {name}")


def create(args: argparse.Namespace) -> None:
    root = Path(args.payload).resolve()
    destination = Path(args.output).resolve()
    if not root.is_dir():
        raise SystemExit("payload directory does not exist")
    if args.unsigned_development == bool(args.signing_key):
        raise SystemExit("choose exactly one of --signing-key or --unsigned-development")
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
    archive = release / str(manifest["payload"]["file"])
    if digest(archive) != manifest["payload"]["sha256"]:
        raise SystemExit("payload digest mismatch")
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
make = sub.add_parser("create")
make.add_argument("--payload", required=True)
make.add_argument("--output", required=True)
make.add_argument("--project", required=True)
make.add_argument("--version", required=True)
make.add_argument("--platform", required=True)
make.add_argument("--source-revision", required=True)
make.add_argument("--signing-key")
make.add_argument("--unsigned-development", action="store_true")
make.set_defaults(run=create)
for command in ("verify", "extract"):
    item = sub.add_parser(command)
    item.add_argument("--release", required=True)
    item.add_argument("--project")
    item.add_argument("--platform")
    item.add_argument("--public-key")
    item.add_argument("--allow-unsigned-development", action="store_true")
    if command == "extract":
        item.add_argument("--extract", required=True)
    else:
        item.set_defaults(extract=None)
    item.set_defaults(run=verify_or_extract)
args = parser.parse_args()
args.run(args)
