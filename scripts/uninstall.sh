#!/bin/bash
set -euo pipefail

base="${HOME:?}/Library/Application Support/Loomex/plugin"
if [[ "${1:-}" == "--install-base" ]]; then base="${2:?}"; shift 2; fi
[[ $# -eq 0 ]] || { echo "usage: $0 [--install-base DIR]" >&2; exit 2; }

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
  rm "$terminal"
  echo "Removed the Loomex plugin terminal cleanup record"
  exit 0
fi
if [[ ! -x "$runtime" || ! -f "$manager" ]]; then
  if [[ -e "$base/current" || -e "$base/versions" || -e "$base/install-receipt.json" || -e "$base/.agents" ]]; then
    echo "complete Loomex plugin lifecycle helper is required" >&2; exit 1
  fi
  echo "Loomex plugin is not installed"; exit 0
fi
exec "$runtime" "$manager" uninstall --install-base "$base"
