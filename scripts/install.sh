#!/bin/bash
set -euo pipefail

usage() { echo "usage: $0 RELEASE_DIR [--public-key FILE | --allow-unsigned-development] [--install-base DIR]" >&2; exit 2; }
[[ $# -ge 1 ]] || usage
release="$(cd "$1" && pwd -P)"; shift
runtime="$release/lifecycle-runtime/node"
manager="$release/lifecycle.mjs"
[[ -x "$runtime" && -f "$manager" ]] || { echo "release lifecycle runtime is missing" >&2; exit 1; }

public_key=""
remaining=("$@")
for ((index=0; index<${#remaining[@]}; index+=1)); do
  if [[ "${remaining[$index]}" == "--public-key" ]]; then
    (( index + 1 < ${#remaining[@]} )) || usage
    public_key="${remaining[$((index + 1))]}"
    ((index+=1))
  fi
done
if grep -Fq '"developmentOnly":false' "$release/manifest.json"; then
  [[ -n "$public_key" ]] || { echo "signed artifact and trusted public key are required" >&2; exit 1; }
  openssl dgst -sha256 -verify "$public_key" -signature "$release/manifest.sig" "$release/manifest.json" >/dev/null || { echo "release manifest signature mismatch" >&2; exit 1; }
fi
bootstrap_hash() {
  local role="$1" file="$2"
  sed -nE "s/.*\\\"${role}\\\":\\{\\\"file\\\":\\\"${file//\//\\/}\\\",\\\"mode\\\":[0-9]+,\\\"sha256\\\":\\\"([0-9a-f]{64})\\\",\\\"size\\\":[0-9]+\\}.*/\\1/p" "$release/manifest.json"
}
expected_runtime="$(bootstrap_hash runtime lifecycle-runtime/node)"
expected_manager="$(bootstrap_hash manager lifecycle.mjs)"
[[ ${#expected_runtime} -eq 64 && ${#expected_manager} -eq 64 ]] || { echo "release bootstrap manifest is invalid" >&2; exit 1; }
[[ "$(shasum -a 256 "$runtime" | awk '{print $1}')" == "$expected_runtime" && "$(shasum -a 256 "$manager" | awk '{print $1}')" == "$expected_manager" ]] || { echo "release bootstrap digest mismatch" >&2; exit 1; }

# The release-side pinned runtime is only a bootstrap. The manager verifies the
# release archive before extracting it and installs a durable copy for resume,
# rollback, repair, status, and uninstall. Do not add source-tree helpers here.
exec "$runtime" "$manager" install --release "$release" "$@"
