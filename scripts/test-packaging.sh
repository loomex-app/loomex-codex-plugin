#!/bin/bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd -P)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/existing-output"
if "$repo/scripts/build-release.sh" --unsigned-development --output "$fixture/existing-output" >/dev/null 2>&1; then echo "build replaced an existing output directory" >&2; exit 1; fi
payload="$fixture/payload"
base="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$fixture/install")"; root="$base/versions/0.1.0"
mkdir -p "$payload/plugin/.codex-plugin" "$payload/plugin/dist" "$payload/plugin/skills/a" "$payload/plugin/hooks" "$payload/plugin/runtime/bin" "$payload/plugin/assets"
cp "$repo/.codex-plugin/plugin.json" "$payload/plugin/.codex-plugin/plugin.json"
# The upgrade fixture uses two fixed synthetic versions, independent of the release under test.
python3 - "$payload/plugin/.codex-plugin/plugin.json" <<'PYFIXTURE'
import json,sys
from pathlib import Path
path=Path(sys.argv[1]); manifest=json.loads(path.read_text()); manifest['version']='0.1.0'
path.write_text(json.dumps(manifest)+'\n')
PYFIXTURE
printf '# test\n' > "$payload/plugin/skills/a/SKILL.md"
cp "$repo/hooks/hooks.json" "$payload/plugin/hooks/hooks.json"
cp "$repo/hooks/lifecycle-adapter.mjs" "$payload/plugin/hooks/lifecycle-adapter.mjs"
cp -R "$repo/assets/." "$payload/plugin/assets/"
printf 'console.log("test")\n' > "$payload/plugin/dist/server.js"
cp "$(command -v node)" "$payload/plugin/runtime/bin/node"; chmod 0755 "$payload/plugin/runtime/bin/node"
cp "$repo/dist/server.js" "$payload/plugin/dist/server.js"
cp "$repo/scripts/mcp.template.json" "$payload/plugin/.mcp.template.json"
mkdir -p "$payload/.agents/plugins"
printf '%s\n' '{"name":"loomex-private","plugins":[{"name":"loomex","version":"0.1.0","source":{"source":"local","path":"./plugin"}}]}' > "$payload/.agents/plugins/marketplace.json"
python3 "$repo/scripts/validate_package.py" "$payload" --template
touch "$payload/plugin/.env"
if python3 "$repo/scripts/validate_package.py" "$payload" --template 2>/dev/null; then echo "forbidden development file accepted" >&2; exit 1; fi
rm "$payload/plugin/.env"
release="$fixture/release"
SOURCE_DATE_EPOCH=1 python3 "$repo/scripts/artifact.py" create --payload "$payload" --output "$release" --project loomex-plugin --version 0.1.0 --platform darwin-arm64 --source-revision test --unsigned-development
SOURCE_DATE_EPOCH=1 python3 "$repo/scripts/artifact.py" create --payload "$payload" --output "$fixture/release-repeat" --project loomex-plugin --version 0.1.0 --platform darwin-arm64 --source-revision test --unsigned-development
cmp "$release/manifest.json" "$fixture/release-repeat/manifest.json"; cmp "$release/payload.tar.gz" "$fixture/release-repeat/payload.tar.gz"
if SOURCE_DATE_EPOCH=1 python3 "$repo/scripts/artifact.py" create --payload "$payload" --output "$release" --project loomex-plugin --version 0.1.0 --platform darwin-arm64 --source-revision test --unsigned-development 2>/dev/null; then echo "artifact create overwrote an existing output" >&2; exit 1; fi
mkdir "$fixture/extract-existing"; printf preserve > "$fixture/extract-existing/sentinel"
if python3 "$repo/scripts/artifact.py" extract --release "$release" --project loomex-plugin --platform darwin-arm64 --allow-unsigned-development --extract "$fixture/extract-existing" 2>/dev/null; then echo "artifact extract overwrote an existing destination" >&2; exit 1; fi
test "$(cat "$fixture/extract-existing/sentinel")" = preserve
python3 "$repo/scripts/artifact.py" verify --release "$release" --project loomex-plugin --platform darwin-arm64 --allow-unsigned-development
python3 - "$release/manifest.json" <<'PY'
import json,sys
files={item["path"] for item in json.load(open(sys.argv[1]))["payload"]["files"]}
assert "plugin/hooks/hooks.json" in files
assert "plugin/hooks/lifecycle-adapter.mjs" in files
assert "plugin/runtime/bin/node" in files
PY
if python3 "$repo/scripts/artifact.py" verify --release "$release" --project loomex-plugin --platform darwin-arm64 2>/dev/null; then echo "unsigned release was accepted" >&2; exit 1; fi
cp "$release/payload.tar.gz" "$fixture/original.tar.gz"
printf x >> "$release/payload.tar.gz"
if python3 "$repo/scripts/artifact.py" verify --release "$release" --project loomex-plugin --platform darwin-arm64 --allow-unsigned-development 2>/dev/null; then echo "tampered release was accepted" >&2; exit 1; fi
mv "$fixture/original.tar.gz" "$release/payload.tar.gz"
LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 "$repo/scripts/install.sh" "$release" --allow-unsigned-development --install-base "$base"
test -L "$base/current"
python3 "$repo/scripts/validate_package.py" "$root"
grep -Fq "$base/current/plugin/runtime/bin/node" "$root/plugin/.mcp.json"
grep -Fq "$base/current/plugin/dist/server.js" "$root/plugin/.mcp.json"
# Codex caches the plugin directory alone. Its MCP and hook launchers must
# resolve without relying on a sibling runtime directory or development PATH.
"$root/plugin/runtime/bin/node" "$root/plugin/dist/server.js" </dev/null >"$fixture/cached-mcp.out" 2>"$fixture/cached-mcp.err" &
cached_mcp_pid=$!
sleep 0.2
kill -0 "$cached_mcp_pid"
kill "$cached_mcp_pid"
wait "$cached_mcp_pid" 2>/dev/null || [[ $? -eq 143 ]]
test ! -s "$fixture/cached-mcp.err"
printf '%s' '{"session_id":"packaging-session","cwd":"/tmp","hook_event_name":"SessionStart"}' \
  | "$root/plugin/runtime/bin/node" "$root/plugin/hooks/lifecycle-adapter.mjs" >/dev/null
registered_marketplace="$base"
python3 - "$base/.agents/plugins/marketplace.json" "$base/install-receipt.json" "$base" <<'PY'
import json,sys
marketplace=json.load(open(sys.argv[1])); receipt=json.load(open(sys.argv[2])); base=sys.argv[3]
assert marketplace['plugins'][0]['source']=={'source':'local','path':'./current/plugin'}
assert marketplace['plugins'][0]['version']=='0.1.0'
assert receipt=={'schema':'app.loomex.plugin.install-receipt/v1','currentPath':f'{base}/current','versionsPath':f'{base}/versions','marketplacePath':f'{base}/.agents/plugins/marketplace.json'}
PY
payload2="$fixture/payload2"; cp -R "$payload" "$payload2"
python3 - "$payload2" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1])
for path in (root/'plugin/.codex-plugin/plugin.json',root/'.agents/plugins/marketplace.json'):
 data=json.loads(path.read_text())
 if 'plugins' in data: data['plugins'][0]['version']='0.1.1'
 else: data['version']='0.1.1'
 path.write_text(json.dumps(data,indent=2)+'\n')
PY
release2="$fixture/release2"
SOURCE_DATE_EPOCH=2 python3 "$repo/scripts/artifact.py" create --payload "$payload2" --output "$release2" --project loomex-plugin --version 0.1.1 --platform darwin-arm64 --source-revision test2 --unsigned-development
if LOOMEX_PLUGIN_INSTALL_FAIL_PHASE=marketplace LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 "$repo/scripts/install.sh" "$release2" --allow-unsigned-development --install-base "$base" >/dev/null 2>&1; then
  echo "install fault injection did not interrupt" >&2; exit 1
fi
test -f "$base/lifecycle.json"
test ! -e "$base/.lifecycle.lock"
LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 "$repo/scripts/install.sh" "$release2" --allow-unsigned-development --install-base "$base"
test ! -e "$base/lifecycle.json"
test -f "$registered_marketplace/.agents/plugins/marketplace.json"
test -x "$registered_marketplace/current/plugin/runtime/bin/node"
test -f "$registered_marketplace/current/plugin/dist/server.js"
grep -Fq "$registered_marketplace/current/plugin/runtime/bin/node" "$base/versions/0.1.1/plugin/.mcp.json"
python3 - "$registered_marketplace/.agents/plugins/marketplace.json" <<'PY'
import json,sys
entry=json.load(open(sys.argv[1]))['plugins'][0]
assert entry['version']=='0.1.1' and entry['source']=={'source':'local','path':'./current/plugin'}
PY
test ! -e "$root"
printf preserve > "$base/.agents/plugins/unrelated-sentinel"
outside_metadata="$fixture/outside-metadata"; mkdir -p "$outside_metadata/plugins"
cp "$base/.agents/plugins/marketplace.json" "$outside_metadata/plugins/marketplace.json"
mv "$base/.agents" "$base/.agents-owned"
ln -s "$outside_metadata" "$base/.agents"
if "$repo/scripts/uninstall.sh" --install-base "$base" >/dev/null 2>&1; then echo "uninstall followed a symlinked marketplace metadata parent" >&2; exit 1; fi
test -f "$outside_metadata/plugins/marketplace.json"
unlink "$base/.agents"
mv "$base/.agents-owned" "$base/.agents"
if LOOMEX_PLUGIN_UNINSTALL_FAIL_PHASE=payload "$repo/scripts/uninstall.sh" --install-base "$base" >/dev/null 2>&1; then
  echo "uninstall fault injection did not interrupt" >&2; exit 1
fi
test -f "$base/lifecycle.json"
"$repo/scripts/uninstall.sh" --install-base "$base"
test ! -e "$base/lifecycle.json"
test ! -e "$base/versions/0.1.1"
test "$(cat "$base/.agents/plugins/unrelated-sentinel")" = preserve
test ! -e "$base/.agents/plugins/marketplace.json"
test ! -e "$base/install-receipt.json"

collision_base="$fixture/metadata-collision"
mkdir -p "$collision_base/.agents/plugins"
printf preserve > "$collision_base/.agents/plugins/marketplace.json"
if LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 "$repo/scripts/install.sh" "$release" --allow-unsigned-development --install-base "$collision_base" >/dev/null 2>&1; then echo "installer overwrote unowned marketplace metadata" >&2; exit 1; fi
test "$(cat "$collision_base/.agents/plugins/marketplace.json")" = preserve
for attack in traversal symlink; do
  attack_base="$fixture/$attack-install"; victim="$fixture/$attack-victim"
  mkdir -p "$attack_base/versions" "$victim"; printf preserve > "$victim/sentinel"
  if [[ "$attack" == traversal ]]; then ln -s "$victim" "$attack_base/current"; else ln -s "$victim" "$attack_base/versions/9.9.9"; ln -s "$attack_base/versions/9.9.9" "$attack_base/current"; fi
  if "$repo/scripts/uninstall.sh" --install-base "$attack_base" >/dev/null 2>&1; then echo "unsafe $attack uninstall target accepted" >&2; exit 1; fi
  test "$(cat "$victim/sentinel")" = preserve
done
echo "plugin packaging tests passed"
