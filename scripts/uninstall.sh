#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == "--install-base" ]]; then base="${2:?}"; shift 2; else base="${HOME:?}/Library/Application Support/Loomex/plugin"; fi
[[ $# -eq 0 ]] || { echo "usage: $0 [--install-base DIR]" >&2; exit 2; }
base="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$base")"
[[ "$base" != / && "$base" != "${HOME:-}" ]] || { echo "unsafe install base" >&2; exit 1; }
current="$base/current"
if [[ ! -L "$current" ]]; then echo "Loomex plugin is not installed"; exit 0; fi
target="$(readlink "$current")"
target="$(python3 - "$base/versions" "$current" "$target" <<'PY'
import re,sys
from pathlib import Path
versions_raw=Path(sys.argv[1]); current=Path(sys.argv[2]); raw=Path(sys.argv[3])
if versions_raw.is_symlink(): raise SystemExit('versions directory may not be a symlink')
versions=versions_raw.resolve(strict=True)
if not raw.is_absolute(): raw=current.parent/raw
if raw.is_symlink(): raise SystemExit('refusing symlinked uninstall target')
target=raw.resolve(strict=True)
if target.parent != versions or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',target.name): raise SystemExit('refusing non-version uninstall target')
print(target)
PY
)"
rm "$current"
rm -rf "$target"
rmdir "$base/versions" "$base" 2>/dev/null || true
echo "Removed the Loomex plugin payload. Remove the loomex-private marketplace in Codex after disabling the plugin."
