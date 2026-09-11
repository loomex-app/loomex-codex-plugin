#!/bin/bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd -P)"; fixture="$(mktemp -d)"; trap 'rm -rf "$fixture"' EXIT
(cd "$repo" && npm run build && npm run test:compile)
lock="$repo/scripts/node-runtime.lock.json"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$lock")"
url="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["url"])' "$lock")"
sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$lock")"
curl --fail --show-error --location --retry 5 --retry-all-errors --continue-at - "$url" -o "$fixture/node.tar.gz"
echo "$sha  $fixture/node.tar.gz" | shasum -a 256 -c -
mkdir "$fixture/node"; tar -xzf "$fixture/node.tar.gz" -C "$fixture/node" --strip-components=1
actual="$($fixture/node/bin/node --version)"
[[ "$actual" == "v$version" ]] || { echo "pinned runtime reported $actual" >&2; exit 1; }
"$fixture/node/bin/node" "$repo/dist/server.js" </dev/null >/dev/null 2>"$fixture/server.stderr" || {
  # A stdio MCP process may exit when its input closes, but must start under the pinned runtime.
  ! grep -Eq 'SyntaxError|ERR_MODULE_NOT_FOUND|bad CPU type' "$fixture/server.stderr"
}
(
  cd "$repo"
  "$fixture/node/bin/node" --test .test-dist/hooks.test.js
)
echo "pinned Node runtime $actual verified"
