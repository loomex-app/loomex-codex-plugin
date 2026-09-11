#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == "--install-base" ]]; then base="${2:?}"; shift 2; else base="${HOME:?}/Library/Application Support/Loomex/plugin"; fi
[[ $# -eq 0 ]] || { echo "usage: $0 [--install-base DIR]" >&2; exit 2; }
base="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$base")"
[[ "$base" != / && "$base" != "${HOME:-}" ]] || { echo "unsafe install base" >&2; exit 1; }
if [[ ! -d "$base" ]]; then echo "Loomex plugin is not installed"; exit 0; fi
lock_dir="$base/.lifecycle.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  if [[ -f "$lock_dir/pid" ]] && ! kill -0 "$(cat "$lock_dir/pid" 2>/dev/null)" 2>/dev/null; then rm -f "$lock_dir/pid"; rmdir "$lock_dir" 2>/dev/null || true; mkdir "$lock_dir" || { echo "plugin lifecycle lock is busy" >&2; exit 1; }; else echo "plugin lifecycle operation already in progress" >&2; exit 1; fi
fi
printf '%s\n' "$$" > "$lock_dir/pid"
cleanup_lock() { rm -f "$lock_dir/pid"; rmdir "$lock_dir" 2>/dev/null || true; }
trap cleanup_lock EXIT
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
fail_phase() { [[ "${LOOMEX_PLUGIN_UNINSTALL_FAIL_PHASE:-}" == "$1" ]] || return 0; echo "fault injection: uninstall phase $1" >&2; exit 97; }
current="$base/current"; versions="$base/versions"; metadata_root="$base/.agents"; marketplace_dir="$metadata_root/plugins"; marketplace="$marketplace_dir/marketplace.json"; receipt="$base/install-receipt.json"; target=""
if [[ -f "$lifecycle" ]]; then
 target="$(python3 - "$lifecycle" "$current" "$versions" "$marketplace" "$receipt" <<'PY'
import json,re,sys
from pathlib import Path
d=json.load(open(sys.argv[1])); target=Path(d.get('target','')); current=Path(sys.argv[2]); versions=Path(sys.argv[3]); marketplace=Path(sys.argv[4]); receipt=Path(sys.argv[5])
if d.get('schema')!='app.loomex.plugin.lifecycle/v1' or d.get('operation')!='uninstall': raise SystemExit('unfinished plugin lifecycle is not an uninstall')
for key,path in [('current',current),('versions',versions),('marketplace',marketplace),('receipt',receipt)]:
 if d.get(key)!=str(path): raise SystemExit('uninstall lifecycle target mismatch')
if target.parent != versions.resolve() or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',target.name): raise SystemExit('unsafe uninstall lifecycle target')
print(target)
PY
)"
else
 [[ -L "$current" ]] || { echo "Loomex plugin is not installed"; exit 0; }
 [[ -d "$metadata_root" && ! -L "$metadata_root" && -d "$marketplace_dir" && ! -L "$marketplace_dir" ]] || { echo "marketplace metadata directories must be regular directories" >&2; exit 1; }
 [[ -f "$marketplace" && ! -L "$marketplace" && -f "$receipt" && ! -L "$receipt" ]] || { echo "complete Loomex plugin ownership metadata is required" >&2; exit 1; }
 target="$(python3 - "$versions" "$current" "$(readlink "$current")" "$marketplace" "$receipt" <<'PY'
import json,re,sys
from pathlib import Path
versions_raw,current,raw,marketplace,receipt=map(Path,sys.argv[1:]); versions=versions_raw.resolve(strict=True)
if not raw.is_absolute(): raw=current.parent/raw
if raw.is_symlink(): raise SystemExit('refusing symlinked uninstall target')
target=raw.resolve(strict=True)
if target.parent!=versions or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',target.name): raise SystemExit('refusing non-version uninstall target')
owned=json.loads(receipt.read_text()); expected={'schema':'app.loomex.plugin.install-receipt/v1','currentPath':str(current),'versionsPath':str(versions),'marketplacePath':str(marketplace)}
if owned!=expected: raise SystemExit('unexpected plugin ownership receipt')
catalog=json.loads(marketplace.read_text()); entries=catalog.get('plugins'); plugin=json.loads((target/'plugin/.codex-plugin/plugin.json').read_text())
if catalog.get('name')!='loomex-private' or not isinstance(entries,list) or len(entries)!=1 or entries[0].get('name')!='loomex' or entries[0].get('version')!=plugin.get('version') or entries[0].get('source')!={'source':'local','path':'./current/plugin'}: raise SystemExit('unexpected installed marketplace metadata')
print(target)
PY
)"
 write_lifecycle "$(python3 - "$target" "$current" "$versions" "$marketplace" "$receipt" <<'PY'
import json,sys; t,c,v,m,r=sys.argv[1:]; print(json.dumps({'schema':'app.loomex.plugin.lifecycle/v1','operation':'uninstall','target':t,'current':c,'versions':v,'marketplace':m,'receipt':r,'phase':'prepared'}))
PY
)"
fi
fail_phase prepared
if [[ -L "$current" ]]; then rm -f "$current"; fi
write_lifecycle "$(python3 - "$lifecycle" <<'PY'
import json,sys; d=json.load(open(sys.argv[1])); d['phase']='current'; print(json.dumps(d))
PY
)"
fail_phase current
if [[ -d "$target" && ! -L "$target" ]]; then rm -rf "$target"; fi
write_lifecycle "$(python3 - "$lifecycle" <<'PY'
import json,sys; d=json.load(open(sys.argv[1])); d['phase']='payload'; print(json.dumps(d))
PY
)"
fail_phase payload
rm -f "$marketplace" "$marketplace.new" "$receipt" "$receipt.new"
write_lifecycle "$(python3 - "$lifecycle" <<'PY'
import json,sys; d=json.load(open(sys.argv[1])); d['phase']='metadata'; print(json.dumps(d))
PY
)"
fail_phase metadata
rm -f "$lifecycle"
cleanup_lock
trap - EXIT
rmdir "$marketplace_dir" "$metadata_root" "$versions" "$base" 2>/dev/null || true
echo "Removed the Loomex plugin payload. Remove the loomex-private marketplace in Codex after disabling the plugin."
