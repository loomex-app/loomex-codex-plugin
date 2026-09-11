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
mkdir -p "$base"
lock_dir="$base/.lifecycle.lock"
stage="$base/.stage-$version"
stage_cleanup=0
cleanup_lock() { rm -f "$lock_dir/pid"; rmdir "$lock_dir" 2>/dev/null || true; }
cleanup_stage() { ((stage_cleanup)) && rm -rf "$stage" || true; }
cleanup() {
  cleanup_stage
  cleanup_lock
}
if ! mkdir "$lock_dir" 2>/dev/null; then
  if [[ -f "$lock_dir/pid" ]] && ! kill -0 "$(cat "$lock_dir/pid" 2>/dev/null)" 2>/dev/null; then
    rm -f "$lock_dir/pid"; rmdir "$lock_dir" 2>/dev/null || true
    mkdir "$lock_dir" || { echo "plugin lifecycle lock is busy" >&2; exit 1; }
  else
    echo "plugin lifecycle operation already in progress" >&2; exit 1
  fi
fi
printf '%s\n' "$$" > "$lock_dir/pid"
trap cleanup EXIT
lifecycle="$base/lifecycle.json"
write_lifecycle() {
  python3 - "$lifecycle" "$1" <<'PY'
import json,os,sys
from pathlib import Path
out=Path(sys.argv[1]); tmp=out.with_name(out.name+'.new')
with tmp.open('w') as f:
 json.dump(json.loads(sys.argv[2]),f,sort_keys=True); f.write('\n'); f.flush(); os.fsync(f.fileno())
os.replace(tmp,out); fd=os.open(out.parent,os.O_RDONLY); os.fsync(fd); os.close(fd)
PY
}
fail_phase() { [[ "${LOOMEX_PLUGIN_INSTALL_FAIL_PHASE:-}" == "$1" ]] || return 0; echo "fault injection: install phase $1" >&2; exit 97; }
versions="$base/versions"
[[ ! -L "$versions" ]] || { echo "versions directory may not be a symlink" >&2; exit 1; }
mkdir -p "$versions"
[[ "$(cd "$versions" && pwd -P)" == "$versions" ]] || { echo "versions directory escaped the install base" >&2; exit 1; }
install_root="$versions/$version"
current="$base/current"
marketplace_dir="$base/.agents/plugins"
marketplace="$marketplace_dir/marketplace.json"
ownership_receipt="$base/install-receipt.json"
[[ ! -L "$stage" ]] || { echo "plugin staging path may not be a symlink" >&2; exit 1; }
mkdir -p "$stage"
payload_root="$stage/payload"
if [[ ! -d "$payload_root" && -d "$install_root" && -f "$lifecycle" ]]; then payload_root="$install_root"; fi
verify=(extract --release "$release" --project loomex-plugin --platform darwin-arm64 --extract "$stage/payload")
if [[ -n "$public_key" ]]; then verify+=(--public-key "$public_key"); fi
if ((allow_dev)); then
  [[ "${LOOMEX_ALLOW_UNSAFE_DEV_INSTALL:-}" == "1" ]] || { echo "set LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 for isolated development installs" >&2; exit 1; }
  verify+=(--allow-unsigned-development)
fi
if [[ "$payload_root" == "$stage/payload" && ! -d "$stage/payload" ]]; then python3 "$repo/scripts/artifact.py" "${verify[@]}"; fi
development="$(python3 -c 'import json,sys; print(str(json.load(open(sys.argv[1]))["developmentOnly"]).lower())' "$manifest")"
if [[ "$development" == false ]]; then codesign --verify --deep --strict --verbose=2 "$payload_root/plugin/runtime/bin/node"; spctl --assess --type execute --verbose=2 "$payload_root/plugin/runtime/bin/node"; fi
python3 "$repo/scripts/validate_package.py" "$payload_root" --template --expected-version "$version"
python3 "$repo/scripts/render_mcp.py" --payload-root "$payload_root" --installed-root "$base/current" --output "$payload_root/plugin/.mcp.json"
python3 "$repo/scripts/validate_package.py" "$payload_root" --expected-root "$base/current" --expected-version "$version"
rm -f "$stage/marketplace.json"
python3 "$repo/scripts/render_marketplace.py" --template "$payload_root/.agents/plugins/marketplace.json" --expected-version "$version" --output "$stage/marketplace.json"

for directory in "$base/.agents" "$marketplace_dir"; do
  [[ ! -L "$directory" ]] || { echo "marketplace metadata directory may not be a symlink" >&2; exit 1; }
done
if [[ ! -f "$lifecycle" && ( -e "$current" || -L "$current" ) ]]; then
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
elif [[ ! -f "$lifecycle" ]]; then
  for path in "$marketplace" "$marketplace.new" "$ownership_receipt" "$ownership_receipt.new"; do
    [[ ! -e "$path" && ! -L "$path" ]] || { echo "unowned marketplace metadata already exists: $path" >&2; exit 1; }
  done
fi
resuming=0
if [[ -f "$lifecycle" ]]; then
  resuming=1
  python3 - "$lifecycle" "$version" "$install_root" "$stage" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
if d.get('schema')!='app.loomex.plugin.lifecycle/v1' or d.get('operation')!='install': raise SystemExit('unfinished plugin lifecycle is not an install')
if d.get('version')!=sys.argv[2] or d.get('installRoot')!=sys.argv[3] or d.get('stage')!=sys.argv[4]: raise SystemExit('unfinished install targets a different release')
PY
else
  write_lifecycle "$(python3 - "$version" "$install_root" "$stage" "$current" "$marketplace" "$ownership_receipt" <<'PY'
import json,sys
v,root,stage,current,marketplace,receipt=sys.argv[1:]
print(json.dumps({'schema':'app.loomex.plugin.lifecycle/v1','operation':'install','version':v,'installRoot':root,'stage':stage,'current':current,'marketplace':marketplace,'receipt':receipt,'oldTarget':None,'phase':'prepared'}))
PY
)"
fi
fail_phase prepared
if [[ -e "$install_root" && "$resuming" -eq 0 ]]; then
  echo "version $version is already installed; refusing to overwrite signed files" >&2
  exit 1
fi
mkdir -p "$marketplace_dir"
if [[ ! -f "$stage/install-receipt.json" ]]; then python3 - "$base" "$versions" "$current" "$marketplace" "$stage/install-receipt.json" <<'PY'
import json,os,sys
from pathlib import Path
base,versions,current,marketplace,out=map(Path,sys.argv[1:])
data={'schema':'app.loomex.plugin.install-receipt/v1','currentPath':str(current),'versionsPath':str(versions.resolve(strict=True)),'marketplacePath':str(marketplace)}
with out.open('x') as handle:
 json.dump(data,handle,sort_keys=True); handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
PY
fi
old=""; [[ -L "$current" ]] && old="$(readlink "$current")"
if [[ -f "$lifecycle" ]]; then old="$(python3 - "$lifecycle" "$old" <<'PY'
import json,sys
print(json.load(open(sys.argv[1])).get('oldTarget') or sys.argv[2])
PY
)"; fi
write_lifecycle "$(python3 - "$lifecycle" "$old" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d['oldTarget']=sys.argv[2]; d['phase']='prepared'; print(json.dumps(d))
PY
)"
if [[ ! -e "$install_root" ]]; then mv "$stage/payload" "$install_root"; fi
write_lifecycle "$(python3 - "$lifecycle" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d['phase']='bytes'; print(json.dumps(d))
PY
)"
fail_phase bytes
ln -s "$install_root" "$base/.current.new"
mv -fh "$base/.current.new" "$current"
write_lifecycle "$(python3 - "$lifecycle" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d['phase']='current'; print(json.dumps(d))
PY
)"
fail_phase current
rm -f "$marketplace.new" "$ownership_receipt.new"
cp "$stage/marketplace.json" "$marketplace.new"
mv -f "$marketplace.new" "$marketplace"
write_lifecycle "$(python3 - "$lifecycle" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d['phase']='marketplace'; print(json.dumps(d))
PY
)"
fail_phase marketplace
cp "$stage/install-receipt.json" "$ownership_receipt.new"
mv -f "$ownership_receipt.new" "$ownership_receipt"
write_lifecycle "$(python3 - "$lifecycle" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d['phase']='receipt'; print(json.dumps(d))
PY
)"
fail_phase receipt
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
write_lifecycle "$(python3 - "$lifecycle" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d['phase']='complete'; print(json.dumps(d))
PY
)"
fail_phase complete
rm -f "$lifecycle"
stage_cleanup=1
trap - EXIT
cleanup_lock
rm -rf "$stage"
echo "Installed Loomex plugin $version at $install_root"
echo "Private marketplace root: $base"
echo "Register it with Codex, then install the loomex plugin from loomex-private."
