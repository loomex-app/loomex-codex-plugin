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
marketplace_dir="$base/.agents/plugins"
marketplace="$marketplace_dir/marketplace.json"
ownership_receipt="$base/install-receipt.json"
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
python3 "$repo/scripts/render_marketplace.py" --template "$stage/payload/.agents/plugins/marketplace.json" --expected-version "$version" --output "$stage/marketplace.json"

for directory in "$base/.agents" "$marketplace_dir"; do
  [[ ! -L "$directory" ]] || { echo "marketplace metadata directory may not be a symlink" >&2; exit 1; }
done
if [[ -e "$current" || -L "$current" ]]; then
  [[ -L "$current" && -f "$marketplace" && ! -L "$marketplace" && -f "$ownership_receipt" && ! -L "$ownership_receipt" ]] || { echo "incomplete plugin ownership metadata" >&2; exit 1; }
  python3 - "$base" "$versions" "$current" "$marketplace" "$ownership_receipt" <<'PY'
import json,re,sys
from pathlib import Path
base,versions,current,marketplace,receipt=map(Path,sys.argv[1:])
versions=versions.resolve(strict=True)
raw=Path(current.readlink())
if not raw.is_absolute(): raw=current.parent/raw
if raw.is_symlink(): raise SystemExit('current target may not be a symlink')
target=raw.resolve(strict=True)
if target.parent!=versions or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',target.name): raise SystemExit('current target is not an installed version')
owned=json.loads(receipt.read_text())
expected={'schema':'app.loomex.plugin.install-receipt/v1','currentPath':str(current),'versionsPath':str(versions),'marketplacePath':str(marketplace)}
if owned!=expected: raise SystemExit('unexpected plugin ownership receipt')
catalog=json.loads(marketplace.read_text()); entries=catalog.get('plugins')
plugin=json.loads((target/'plugin/.codex-plugin/plugin.json').read_text())
if catalog.get('name')!='loomex-private' or not isinstance(entries,list) or len(entries)!=1 or entries[0].get('name')!='loomex' or entries[0].get('version')!=plugin.get('version') or entries[0].get('source')!={'source':'local','path':'./current/plugin'}: raise SystemExit('unexpected installed marketplace metadata')
PY
else
  for path in "$marketplace" "$marketplace.new" "$ownership_receipt" "$ownership_receipt.new"; do
    [[ ! -e "$path" && ! -L "$path" ]] || { echo "unowned marketplace metadata already exists: $path" >&2; exit 1; }
  done
fi
if [[ -e "$install_root" ]]; then
  echo "version $version is already installed; refusing to overwrite signed files" >&2
  exit 1
fi
mkdir -p "$marketplace_dir"
python3 - "$base" "$versions" "$current" "$marketplace" "$stage/install-receipt.json" <<'PY'
import json,os,sys
from pathlib import Path
base,versions,current,marketplace,out=map(Path,sys.argv[1:])
data={'schema':'app.loomex.plugin.install-receipt/v1','currentPath':str(current),'versionsPath':str(versions.resolve(strict=True)),'marketplacePath':str(marketplace)}
with out.open('x') as handle:
 json.dump(data,handle,sort_keys=True); handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
PY
old=""; [[ -L "$current" ]] && old="$(readlink "$current")"
mv "$stage/payload" "$install_root"
ln -s "$install_root" "$base/.current.new"
mv -fh "$base/.current.new" "$current"
rm -f "$marketplace.new" "$ownership_receipt.new"
cp "$stage/marketplace.json" "$marketplace.new"
mv -f "$marketplace.new" "$marketplace"
cp "$stage/install-receipt.json" "$ownership_receipt.new"
mv -f "$ownership_receipt.new" "$ownership_receipt"
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
echo "Private marketplace root: $base"
echo "Register it with Codex, then install the loomex plugin from loomex-private."
