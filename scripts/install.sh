#!/bin/bash
set -euo pipefail

usage() { echo "usage: $0 RELEASE_DIR [--public-key FILE | --allow-unsigned-development] [--install-base DIR]" >&2; exit 2; }
[[ $# -ge 1 ]] || usage
release="$(cd "$1" && pwd -P)"; shift
public_key=""; allow_dev=0; install_base=""
while (($#)); do
  case "$1" in
    --public-key) public_key="${2:?}"; shift 2 ;;
    --allow-unsigned-development) allow_dev=1; shift ;;
    --install-base) install_base="${2:?}"; shift 2 ;;
    *) usage ;;
  esac
done
repo="$(cd "$(dirname "$0")/.." && pwd -P)"
manifest="$release/manifest.json"
[[ -f "$manifest" ]] || { echo "release manifest missing" >&2; exit 1; }
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$manifest")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "invalid release version" >&2; exit 1; }
base="${install_base:-${HOME:?}/Library/Application Support/Loomex/plugin}"
base="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$base")"
[[ "$base" != / && "$base" != "${HOME:-}" ]] || { echo "unsafe install base" >&2; exit 1; }
versions="$base/versions"
[[ ! -L "$versions" ]] || { echo "versions directory may not be a symlink" >&2; exit 1; }
mkdir -p "$versions"
[[ "$(cd "$versions" && pwd -P)" == "$versions" ]] || { echo "versions directory escaped the install base" >&2; exit 1; }
install_root="$versions/$version"
current="$base/current"
stage="$(mktemp -d "$base/.stage.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
verify=(extract --release "$release" --project loomex-plugin --platform darwin-arm64 --extract "$stage/payload")
if [[ -n "$public_key" ]]; then verify+=(--public-key "$public_key"); fi
if ((allow_dev)); then
  [[ "${LOOMEX_ALLOW_UNSAFE_DEV_INSTALL:-}" == "1" ]] || { echo "set LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 for isolated development installs" >&2; exit 1; }
  verify+=(--allow-unsigned-development)
fi
python3 "$repo/scripts/artifact.py" "${verify[@]}"
development="$(python3 -c 'import json,sys; print(str(json.load(open(sys.argv[1]))["developmentOnly"]).lower())' "$manifest")"
if [[ "$development" == false ]]; then codesign --verify --deep --strict --verbose=2 "$stage/payload/runtime/bin/node"; spctl --assess --type execute --verbose=2 "$stage/payload/runtime/bin/node"; fi
python3 "$repo/scripts/validate_package.py" "$stage/payload" --template --expected-version "$version"
python3 "$repo/scripts/render_mcp.py" --payload-root "$stage/payload" --installed-root "$base/current" --output "$stage/payload/plugin/.mcp.json"
python3 "$repo/scripts/validate_package.py" "$stage/payload" --expected-root "$base/current" --expected-version "$version"
if [[ -e "$install_root" ]]; then
  echo "version $version is already installed; refusing to overwrite signed files" >&2
  exit 1
fi
old=""; [[ -L "$current" ]] && old="$(readlink "$current")"
mv "$stage/payload" "$install_root"
ln -s "$install_root" "$base/.current.new"
mv -fh "$base/.current.new" "$current"
if [[ -n "$old" && "$old" != "$install_root" ]]; then
  old="$(python3 - "$versions" "$current" "$old" <<'PY'
import re,sys
from pathlib import Path
versions_raw=Path(sys.argv[1]); current=Path(sys.argv[2]); raw=Path(sys.argv[3])
if versions_raw.is_symlink(): raise SystemExit('versions directory may not be a symlink')
versions=versions_raw.resolve(strict=True)
if not raw.is_absolute(): raw=current.parent/raw
if raw.is_symlink(): raise SystemExit('refusing symlinked previous version')
target=raw.resolve(strict=True)
if target.parent != versions or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',target.name): raise SystemExit('refusing unexpected previous target')
print(target)
PY
)"
  rm -rf "$old"
fi
trap - EXIT
rm -rf "$stage"
echo "Installed Loomex plugin $version at $install_root"
echo "Private marketplace root: $base/current"
echo "Register it with Codex, then install the loomex plugin from loomex-private."
