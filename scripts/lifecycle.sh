#!/bin/bash
set -euo pipefail

usage() { echo "usage: $0 {status|resume|rollback|repair} [--install-base DIR] [--version X.Y.Z] [--public-key FILE | --allow-unsigned-development]" >&2; exit 2; }
[[ $# -ge 1 ]] || usage
action="$1"; shift
case "$action" in status|resume|rollback|repair) ;; *) usage ;; esac
base="${HOME:?}/Library/Application Support/Loomex/plugin"
arguments=()
while (($#)); do
  case "$1" in
    --install-base) base="${2:?}"; shift 2 ;;
    --version|--public-key) arguments+=("$1" "${2:?}"); shift 2 ;;
    --allow-unsigned-development) arguments+=("$1"); shift ;;
    *) usage ;;
  esac
done
helper="$base/.lifecycle-runtime"
if [[ ! -x "$helper/node" || ! -f "$helper/lifecycle.mjs" ]]; then
  for candidate in "$base"/.lifecycle-runtime.recovery-*; do
    [[ -d "$candidate" && -x "$candidate/node" && -f "$candidate/lifecycle.mjs" ]] || continue
    helper="$candidate"
    break
  done
fi
runtime="$helper/node"
manager="$helper/lifecycle.mjs"
terminal="$base/lifecycle.terminal.json"
terminal_complete_without_helper() {
  [[ -f "$terminal" && ! -L "$terminal" && ! -e "$base/.lifecycle-runtime" ]] || return 1
  for candidate in "$base"/.lifecycle-runtime.recovery-*; do [[ ! -e "$candidate" ]] || return 1; done
  grep -Fq '"schema":"app.loomex.plugin.lifecycle/v2"' "$terminal" \
    && grep -Fq '"operation":"uninstall"' "$terminal" \
    && grep -Fq '"phase":"complete"' "$terminal" \
    && grep -Fq '"recoveryHelper":"' "$terminal"
}
if terminal_complete_without_helper; then
  case "$action" in
    status) printf '%s\n' '{"schema":"app.loomex.plugin.lifecycle-status/v1","current":null,"versions":[],"operation":{"operation":"uninstall","phase":"complete","terminal":true,"recoveryRequired":false}}'; exit 0 ;;
    resume) rm "$terminal"; printf '%s\n' '{"schema":"app.loomex.plugin.lifecycle-result/v1","action":"resume","status":"completed","terminal":true}'; exit 0 ;;
    *) echo "terminal Loomex plugin cleanup is complete; run lifecycle.sh resume or uninstall.sh to remove its terminal record" >&2; exit 1 ;;
  esac
fi
[[ -x "$runtime" && -f "$manager" ]] || { echo "Loomex plugin lifecycle helper is not installed" >&2; exit 1; }
exec "$runtime" "$manager" "$action" --install-base "$base" "${arguments[@]+${arguments[@]}}"
