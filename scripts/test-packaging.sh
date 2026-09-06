#!/bin/bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd -P)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/existing-output"
if "$repo/scripts/build-release.sh" --unsigned-development --output "$fixture/existing-output" >/dev/null 2>&1; then echo "build replaced an existing output directory" >&2; exit 1; fi
payload="$fixture/payload"
base="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$fixture/install")"; root="$base/versions/0.1.0"
mkdir -p "$payload/plugin/.codex-plugin" "$payload/plugin/dist" "$payload/plugin/skills/a" "$payload/runtime/bin"
cp "$repo/.codex-plugin/plugin.json" "$payload/plugin/.codex-plugin/plugin.json"
printf '# test\n' > "$payload/plugin/skills/a/SKILL.md"
printf 'console.log("test")\n' > "$payload/plugin/dist/server.js"
printf '#!/bin/sh\n' > "$payload/runtime/bin/node"; chmod 0755 "$payload/runtime/bin/node"
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
if python3 "$repo/scripts/artifact.py" verify --release "$release" --project loomex-plugin --platform darwin-arm64 2>/dev/null; then echo "unsigned release was accepted" >&2; exit 1; fi
cp "$release/payload.tar.gz" "$fixture/original.tar.gz"
printf x >> "$release/payload.tar.gz"
if python3 "$repo/scripts/artifact.py" verify --release "$release" --project loomex-plugin --platform darwin-arm64 --allow-unsigned-development 2>/dev/null; then echo "tampered release was accepted" >&2; exit 1; fi
mv "$fixture/original.tar.gz" "$release/payload.tar.gz"
LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 "$repo/scripts/install.sh" "$release" --allow-unsigned-development --install-base "$base"
test -L "$base/current"
python3 "$repo/scripts/validate_package.py" "$root"
grep -Fq "$base/current/runtime/bin/node" "$root/plugin/.mcp.json"
grep -Fq "$base/current/plugin/dist/server.js" "$root/plugin/.mcp.json"
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
LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 "$repo/scripts/install.sh" "$release2" --allow-unsigned-development --install-base "$base"
test -f "$registered_marketplace/.agents/plugins/marketplace.json"
test -x "$registered_marketplace/current/runtime/bin/node"
test -f "$registered_marketplace/current/plugin/dist/server.js"
grep -Fq "$registered_marketplace/current/runtime/bin/node" "$base/versions/0.1.1/plugin/.mcp.json"
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
"$repo/scripts/uninstall.sh" --install-base "$base"
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
