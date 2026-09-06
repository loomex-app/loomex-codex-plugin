#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == "--install-base" ]]; then base="${2:?}"; shift 2; else base="${HOME:?}/Library/Application Support/Loomex/plugin"; fi
[[ $# -eq 0 ]] || { echo "usage: $0 [--install-base DIR]" >&2; exit 2; }
base="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$base")"
[[ "$base" != / && "$base" != "${HOME:-}" ]] || { echo "unsafe install base" >&2; exit 1; }
current="$base/current"
if [[ ! -L "$current" ]]; then echo "Loomex plugin is not installed"; exit 0; fi
metadata_root="$base/.agents"
marketplace_dir="$metadata_root/plugins"
marketplace="$marketplace_dir/marketplace.json"
receipt="$base/install-receipt.json"
[[ -d "$metadata_root" && ! -L "$metadata_root" && -d "$marketplace_dir" && ! -L "$marketplace_dir" ]] || { echo "marketplace metadata directories must be regular directories" >&2; exit 1; }
[[ "$(cd "$metadata_root" && pwd -P)" == "$metadata_root" && "$(cd "$marketplace_dir" && pwd -P)" == "$marketplace_dir" ]] || { echo "marketplace metadata escaped the install base" >&2; exit 1; }
[[ -f "$marketplace" && ! -L "$marketplace" && -f "$receipt" && ! -L "$receipt" ]] || { echo "complete Loomex plugin ownership metadata is required" >&2; exit 1; }
target="$(readlink "$current")"
target="$(python3 - "$base" "$base/versions" "$current" "$target" "$marketplace" "$receipt" <<'PY'
import json,re,sys
from pathlib import Path
base=Path(sys.argv[1]); versions_raw=Path(sys.argv[2]); current=Path(sys.argv[3]); raw=Path(sys.argv[4]); marketplace=Path(sys.argv[5]); receipt=Path(sys.argv[6])
if versions_raw.is_symlink(): raise SystemExit('versions directory may not be a symlink')
versions=versions_raw.resolve(strict=True)
if not raw.is_absolute(): raw=current.parent/raw
if raw.is_symlink(): raise SystemExit('refusing symlinked uninstall target')
target=raw.resolve(strict=True)
if target.parent != versions or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',target.name): raise SystemExit('refusing non-version uninstall target')
owned=json.loads(receipt.read_text())
expected={'schema':'app.loomex.plugin.install-receipt/v1','currentPath':str(current),'versionsPath':str(versions),'marketplacePath':str(marketplace)}
if owned!=expected: raise SystemExit('unexpected plugin ownership receipt')
catalog=json.loads(marketplace.read_text()); entries=catalog.get('plugins'); plugin=json.loads((target/'plugin/.codex-plugin/plugin.json').read_text())
if catalog.get('name')!='loomex-private' or not isinstance(entries,list) or len(entries)!=1 or entries[0].get('name')!='loomex' or entries[0].get('version')!=plugin.get('version') or entries[0].get('source')!={'source':'local','path':'./current/plugin'}: raise SystemExit('unexpected installed marketplace metadata')
print(target)
PY
)"
rm "$current"
rm -rf "$target"
rm -f "$marketplace" "$marketplace.new" "$receipt" "$receipt.new"
rmdir "$marketplace_dir" "$metadata_root" "$base/versions" "$base" 2>/dev/null || true
echo "Removed the Loomex plugin payload. Remove the loomex-private marketplace in Codex after disabling the plugin."
