#!/bin/bash
set -euo pipefail

usage() {
  echo "usage: $0 (--production | --unsigned-development) [--output DIR]" >&2
  exit 2
}

mode=""
output=""
while (($#)); do
  case "$1" in
    --production|--unsigned-development) mode="$1"; shift ;;
    --output) output="${2:?}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$mode" ]] || usage
repo="$(cd "$(dirname "$0")/.." && pwd -P)"
version="$(node -p "require('$repo/package.json').version")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "package version is not SemVer: $version" >&2; exit 1; }
output="${output:-$repo/release/loomex-plugin-$version-darwin-arm64}"
[[ ! -e "$output" ]] || { echo "output already exists; refusing to replace it: $output" >&2; exit 1; }

if [[ "$mode" == "--production" ]]; then
  : "${LOOMEX_CODESIGN_IDENTITY:?production requires LOOMEX_CODESIGN_IDENTITY}"
  : "${LOOMEX_NOTARY_PROFILE:?production requires LOOMEX_NOTARY_PROFILE}"
  : "${LOOMEX_MANIFEST_SIGNING_KEY:?production requires LOOMEX_MANIFEST_SIGNING_KEY}"
  security find-identity -v -p codesigning | grep -Fq "${LOOMEX_CODESIGN_IDENTITY}" || {
    echo "configured production signing identity is unavailable" >&2; exit 1;
  }
  [[ "$LOOMEX_CODESIGN_IDENTITY" == Developer\ ID\ Application:* ]] || { echo "production requires a Developer ID Application identity" >&2; exit 1; }
  openssl rsa -in "$LOOMEX_MANIFEST_SIGNING_KEY" -check -noout >/dev/null
  [[ -z "$(git -C "$repo" status --porcelain)" ]] || { echo "production release requires a clean source tree" >&2; exit 1; }
  revision="$(git -C "$repo" rev-parse --verify HEAD)"
fi

temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
build_root="$repo"
if [[ "$mode" == "--production" ]]; then
  mkdir "$temporary/source"
  git -C "$repo" archive "$revision" | tar -x -C "$temporary/source"
  build_root="$temporary/source"
  [[ "$(node -p "require('$build_root/package.json').version")" == "$version" ]] || { echo "snapshot version changed during build" >&2; exit 1; }
fi
(cd "$build_root" && npm ci && npm run typecheck && npm test)
payload="$temporary/payload"
mkdir -p "$payload/plugin/.codex-plugin" "$payload/plugin/assets" "$payload/plugin/hooks" "$payload/plugin/runtime/bin"
cp "$build_root/.codex-plugin/plugin.json" "$payload/plugin/.codex-plugin/plugin.json"
cp "$build_root/scripts/mcp.template.json" "$payload/plugin/.mcp.template.json"
cp "$build_root/package.json" "$payload/plugin/package.json"
cp -R "$build_root/assets/." "$payload/plugin/assets/"
cp -R "$build_root/hooks/." "$payload/plugin/hooks/"
[[ ! -d "$build_root/contracts" ]] || cp -R "$build_root/contracts" "$payload/plugin/contracts"
[[ ! -d "$build_root/skills" ]] || cp -R "$build_root/skills" "$payload/plugin/skills"
mkdir -p "$payload/plugin/dist"
cp "$build_root/dist/server.js" "$payload/plugin/dist/server.js"
cp "$build_root/dist/compatibility-export.mjs" "$payload/plugin/dist/compatibility-export.mjs"
cp "$build_root/dist/compatibility-check.mjs" "$payload/plugin/dist/compatibility-check.mjs"

runtime_url="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["url"])' "$build_root/scripts/node-runtime.lock.json")"
runtime_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$build_root/scripts/node-runtime.lock.json")"
runtime_archive="${LOOMEX_NODE_ARCHIVE:-$temporary/node.tar.gz}"
if [[ -z "${LOOMEX_NODE_ARCHIVE:-}" ]]; then curl --fail --show-error --location --retry 5 --retry-all-errors --continue-at - "$runtime_url" -o "$runtime_archive"; fi
echo "$runtime_sha  $runtime_archive" | shasum -a 256 -c -
mkdir -p "$temporary/node"
tar -xzf "$runtime_archive" -C "$temporary/node" --strip-components=1
cp "$temporary/node/bin/node" "$payload/plugin/runtime/bin/node"
chmod 0755 "$payload/plugin/runtime/bin/node"
cp "$temporary/node/LICENSE" "$payload/plugin/runtime/LICENSE"
mkdir -p "$payload/.agents/plugins"
python3 - "$version" "$payload/.agents/plugins/marketplace.json" <<'PY'
import json,sys
from pathlib import Path
version,out=sys.argv[1:]
data={"name":"loomex-private","owner":{"name":"Loomex"},"plugins":[{"name":"loomex","description":"Local Loomex workflow runner for Codex","version":version,"source":{"source":"local","path":"./plugin"},"category":"developer-tools","policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"}}]}
Path(out).write_text(json.dumps(data,indent=2)+"\n")
PY
python3 "$build_root/scripts/validate_package.py" "$payload" --template --expected-version "$version"

if [[ "$mode" == "--production" ]]; then
  codesign --force --timestamp --options runtime --entitlements "$build_root/scripts/node.entitlements.plist" --sign "$LOOMEX_CODESIGN_IDENTITY" "$payload/plugin/runtime/bin/node"
  "$payload/plugin/runtime/bin/node" -e 'if (new Function("return 42")() !== 42) process.exit(1)'
else
  echo "WARNING: building unsigned development artifact for isolated testing only" >&2
fi
python3 - "$payload" "${HOME:?}" <<'PY'
import sys
from pathlib import Path
root=Path(sys.argv[1]); needle=sys.argv[2].encode()
for path in root.rglob('*'):
 if path.is_file() and needle in path.read_bytes(): raise SystemExit(f'payload embeds build home path: {path.relative_to(root)}')
PY
revision="${revision:-$(git -C "$repo" rev-parse HEAD 2>/dev/null || printf unknown)}"
release_stage="$temporary/release"
arguments=(create --payload "$payload" --output "$release_stage" --project loomex-plugin --version "$version" --platform darwin-arm64 --source-revision "$revision")
if [[ "$mode" == "--production" ]]; then
  arguments+=(--signing-key "$LOOMEX_MANIFEST_SIGNING_KEY")
else
  arguments+=(--unsigned-development)
fi
python3 "$build_root/scripts/artifact.py" "${arguments[@]}"

if [[ "$mode" == "--production" ]]; then
  ditto -c -k --keepParent "$payload" "$temporary/notary.zip"
  xcrun notarytool submit "$temporary/notary.zip" --keychain-profile "$LOOMEX_NOTARY_PROFILE" --wait --output-format json > "$temporary/notary.json"
  python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["status"]=="Accepted"' "$temporary/notary.json"
  codesign --verify --deep --strict --verbose=2 "$payload/plugin/runtime/bin/node"
  spctl --assess --type execute --verbose=2 "$payload/plugin/runtime/bin/node"
fi
[[ ! -e "$output" ]] || { echo "output appeared during build; refusing to replace it: $output" >&2; exit 1; }
mkdir -p "$(dirname "$output")"
mv "$release_stage" "$output"
echo "$output"
