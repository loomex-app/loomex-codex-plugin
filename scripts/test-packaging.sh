#!/bin/bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd -P)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/existing-output"
if "$repo/scripts/build-release.sh" --unsigned-development --output "$fixture/existing-output" >/dev/null 2>&1; then echo "build replaced an existing output directory" >&2; exit 1; fi
payload="$fixture/payload"
base="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$fixture/install")"; root="$base/versions/0.1.0"
mkdir -p "$payload/plugin/.codex-plugin" "$payload/plugin/dist" "$payload/plugin/hooks" "$payload/plugin/runtime/bin" "$payload/plugin/assets"
cp "$repo/.codex-plugin/plugin.json" "$payload/plugin/.codex-plugin/plugin.json"
cp "$repo/package.json" "$payload/plugin/package.json"
cp -R "$repo/contracts" "$payload/plugin/contracts"
rm -rf "$payload/plugin/skills"
cp -R "$repo/skills" "$payload/plugin/skills"
# The upgrade fixture uses two fixed synthetic versions, independent of the release under test.
python3 - "$payload/plugin/.codex-plugin/plugin.json" <<'PYFIXTURE'
import json,sys
from pathlib import Path
path=Path(sys.argv[1]); manifest=json.loads(path.read_text()); manifest['version']='0.1.0'
path.write_text(json.dumps(manifest)+'\n')
PYFIXTURE
cp "$repo/hooks/hooks.json" "$payload/plugin/hooks/hooks.json"
cp "$repo/hooks/lifecycle-adapter.mjs" "$payload/plugin/hooks/lifecycle-adapter.mjs"
cp -R "$repo/assets/." "$payload/plugin/assets/"
printf 'console.log("test")\n' > "$payload/plugin/dist/server.js"
cp "$(command -v node)" "$payload/plugin/runtime/bin/node"; chmod 0755 "$payload/plugin/runtime/bin/node"
cp "$repo/dist/server.js" "$payload/plugin/dist/server.js"
cp "$repo/dist/lifecycle.mjs" "$payload/plugin/dist/lifecycle.mjs"
cp "$repo/dist/compatibility-export.mjs" "$payload/plugin/dist/compatibility-export.mjs"
cp "$repo/dist/compatibility-check.mjs" "$payload/plugin/dist/compatibility-check.mjs"
cp "$repo/scripts/mcp.template.json" "$payload/plugin/.mcp.template.json"
mkdir -p "$payload/.agents/plugins"
printf '%s\n' '{"name":"loomex-private","plugins":[{"name":"loomex","version":"0.1.0","source":{"source":"local","path":"./plugin"}}]}' > "$payload/.agents/plugins/marketplace.json"
python3 "$repo/scripts/validate_package.py" "$payload" --template
for component in lifecycle.mjs compatibility-export.mjs compatibility-check.mjs; do
  rm "$payload/plugin/dist/$component"
  if python3 "$repo/scripts/validate_package.py" "$payload" --template 2>/dev/null; then
    echo "package validation accepted missing compatibility bundle: $component" >&2; exit 1
  fi
  cp "$repo/dist/$component" "$payload/plugin/dist/$component"
done
touch "$payload/plugin/.env"
if python3 "$repo/scripts/validate_package.py" "$payload" --template 2>/dev/null; then echo "forbidden development file accepted" >&2; exit 1; fi
rm "$payload/plugin/.env"
python3 "$repo/scripts/artifact.py" source-manifest --root "$payload" --output "$fixture/source-content.json" --source-revision test
if python3 "$repo/scripts/artifact.py" source-manifest --root "$fixture/no-such-source-root" --output "$fixture/nonexistent-source.json" --source-revision test 2>/dev/null; then
  echo "source manifest accepted a nonexistent source root" >&2; exit 1
fi
cp "$fixture/source-content.json" "$fixture/invalid-source-content.json"
python3 - "$fixture/invalid-source-content.json" <<'PY'
import json,sys
from pathlib import Path
path=Path(sys.argv[1]); data=json.loads(path.read_text())
data['files'][0]['path']='./'+data['files'][0]['path']
data['files'][0]['mode']=True
path.write_text(json.dumps(data,sort_keys=True,separators=(',',':'))+'\n')
PY
if python3 "$repo/scripts/artifact.py" create --payload "$payload" --output "$fixture/invalid-source-release" --project loomex-plugin --version 0.1.0 --platform darwin-arm64 --source-revision test --source-manifest "$fixture/invalid-source-content.json" --unsigned-development 2>/dev/null; then
  echo "artifact create accepted noncanonical or boolean source metadata" >&2; exit 1
fi
cp "$payload/plugin/package.json" "$fixture/package.json.original"
printf '\n' >> "$payload/plugin/package.json"
if python3 "$repo/scripts/artifact.py" create --payload "$payload" --output "$fixture/mutation-rejected" --project loomex-plugin --version 0.1.0 --platform darwin-arm64 --source-revision test --source-manifest "$fixture/source-content.json" --source-root "$payload" --unsigned-development 2>/dev/null; then
  echo "source mutation after capture was accepted" >&2; exit 1
fi
cp "$fixture/package.json.original" "$payload/plugin/package.json"
release="$fixture/release"
SOURCE_DATE_EPOCH=1 python3 "$repo/scripts/artifact.py" create --payload "$payload" --output "$release" --project loomex-plugin --version 0.1.0 --platform darwin-arm64 --source-revision test --source-manifest "$fixture/source-content.json" --unsigned-development
SOURCE_DATE_EPOCH=1 python3 "$repo/scripts/artifact.py" create --payload "$payload" --output "$fixture/release-repeat" --project loomex-plugin --version 0.1.0 --platform darwin-arm64 --source-revision test --source-manifest "$fixture/source-content.json" --unsigned-development
cmp "$release/manifest.json" "$fixture/release-repeat/manifest.json"; cmp "$release/payload.tar.gz" "$fixture/release-repeat/payload.tar.gz"
if SOURCE_DATE_EPOCH=1 python3 "$repo/scripts/artifact.py" create --payload "$payload" --output "$release" --project loomex-plugin --version 0.1.0 --platform darwin-arm64 --source-revision test --unsigned-development 2>/dev/null; then echo "artifact create overwrote an existing output" >&2; exit 1; fi
mkdir "$fixture/extract-existing"; printf preserve > "$fixture/extract-existing/sentinel"
if python3 "$repo/scripts/artifact.py" extract --release "$release" --project loomex-plugin --platform darwin-arm64 --allow-unsigned-development --extract "$fixture/extract-existing" 2>/dev/null; then echo "artifact extract overwrote an existing destination" >&2; exit 1; fi
test "$(cat "$fixture/extract-existing/sentinel")" = preserve
python3 "$repo/scripts/artifact.py" verify --release "$release" --project loomex-plugin --platform darwin-arm64 --allow-unsigned-development
python3 "$repo/scripts/artifact.py" verify --release "$release" --project loomex-plugin --platform darwin-arm64 --allow-unsigned-development --source-root "$payload"
if python3 "$repo/scripts/artifact.py" verify --release "$release" --project loomex-plugin --platform darwin-arm64 --allow-unsigned-development --source-root "$fixture/no-such-source-root" 2>/dev/null; then
  echo "release verification accepted a nonexistent source root" >&2; exit 1
fi
cp "$payload/plugin/package.json" "$fixture/package.json.before-verify-mutation"
printf '\n' >> "$payload/plugin/package.json"
if python3 "$repo/scripts/artifact.py" verify --release "$release" --project loomex-plugin --platform darwin-arm64 --allow-unsigned-development --source-root "$payload" 2>/dev/null; then
  echo "release verification accepted a post-capture source mutation" >&2; exit 1
fi
cp "$fixture/package.json.before-verify-mutation" "$payload/plugin/package.json"
legacy_files_release="$fixture/invalid-source-file-count"; cp -R "$release" "$legacy_files_release"
python3 - "$legacy_files_release/manifest.json" <<'PY'
import json,sys
from pathlib import Path
path=Path(sys.argv[1]); data=json.loads(path.read_text()); data['sourceContent']['files']=True
path.write_text(json.dumps(data,sort_keys=True,separators=(',',':'))+'\n')
PY
if python3 "$repo/scripts/artifact.py" verify --release "$legacy_files_release" --project loomex-plugin --platform darwin-arm64 --allow-unsigned-development 2>/dev/null; then
  echo "release verification accepted boolean source file count" >&2; exit 1
fi
python3 - "$release/manifest.json" <<'PY'
import json,sys
manifest=json.load(open(sys.argv[1]))
assert manifest["sourceContent"]["file"] == "source-content.json"
assert manifest["sourceContent"]["files"] > 0
files={item["path"] for item in manifest["payload"]["files"]}
assert "plugin/hooks/hooks.json" in files
assert "plugin/hooks/lifecycle-adapter.mjs" in files
assert "plugin/runtime/bin/node" in files
assert "plugin/dist/lifecycle.mjs" in files
assert "plugin/dist/compatibility-export.mjs" in files
assert "plugin/dist/compatibility-check.mjs" in files
assert manifest["bootstrap"]["runtime"]["file"] == "lifecycle-runtime/node"
assert manifest["bootstrap"]["manager"]["file"] == "lifecycle.mjs"
PY
if python3 "$repo/scripts/artifact.py" verify --release "$release" --project loomex-plugin --platform darwin-arm64 2>/dev/null; then echo "unsigned release was accepted" >&2; exit 1; fi
cp "$release/payload.tar.gz" "$fixture/original.tar.gz"
printf x >> "$release/payload.tar.gz"
if python3 "$repo/scripts/artifact.py" verify --release "$release" --project loomex-plugin --platform darwin-arm64 --allow-unsigned-development 2>/dev/null; then echo "tampered release was accepted" >&2; exit 1; fi
mv "$fixture/original.tar.gz" "$release/payload.tar.gz"
# The shell launcher uses these two release-side bootstrap assets. The manager
# verifies the archive and installs its own retained helper before mutation.
mkdir -p "$release/lifecycle-runtime"
cp "$payload/plugin/runtime/bin/node" "$release/lifecycle-runtime/node"
chmod 0755 "$release/lifecycle-runtime/node"
cp "$payload/plugin/dist/lifecycle.mjs" "$release/lifecycle.mjs"
cp "$release/lifecycle.mjs" "$fixture/lifecycle.mjs.original"
printf x >> "$release/lifecycle.mjs"
if LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 "$repo/scripts/install.sh" "$release" --allow-unsigned-development --install-base "$base" >/dev/null 2>&1; then
  echo "installer accepted a tampered bootstrap manager" >&2; exit 1
fi
mv "$fixture/lifecycle.mjs.original" "$release/lifecycle.mjs"
# New releases require provenance. Historical release inspection remains an
# explicit opt-in so it cannot silently qualify a new candidate.
legacy_release="$fixture/legacy-release"; cp -R "$release" "$legacy_release"
python3 - "$legacy_release/manifest.json" <<'PY'
import json,sys
from pathlib import Path
path=Path(sys.argv[1]); manifest=json.loads(path.read_text()); manifest.pop("sourceContent")
path.write_text(json.dumps(manifest,sort_keys=True,separators=(",", ":"))+"\n")
PY
rm "$legacy_release/source-content.json"
if python3 "$repo/scripts/artifact.py" verify --release "$legacy_release" --project loomex-plugin --platform darwin-arm64 --allow-unsigned-development 2>/dev/null; then
  echo "provenance-free release was accepted without explicit legacy opt-in" >&2; exit 1
fi
python3 "$repo/scripts/artifact.py" verify --release "$legacy_release" --project loomex-plugin --platform darwin-arm64 --allow-unsigned-development --allow-legacy-source-provenance
LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 "$repo/scripts/install.sh" "$release" --allow-unsigned-development --install-base "$base"
test -L "$base/current"
# First installation has no in-root lock anchor yet.  Concurrent installers
# serialize on the narrowly scoped sibling bootstrap lock; one may establish
# ownership and the other must not write a competing lifecycle transaction.
bootstrap_base="$fixture/bootstrap-first-install"
( LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 "$repo/scripts/install.sh" "$release" --allow-unsigned-development --install-base "$bootstrap_base" >"$fixture/bootstrap-one.out" 2>&1 ) & bootstrap_one=$!
( LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 "$repo/scripts/install.sh" "$release" --allow-unsigned-development --install-base "$bootstrap_base" >"$fixture/bootstrap-two.out" 2>&1 ) & bootstrap_two=$!
set +e
wait "$bootstrap_one"; bootstrap_one_status=$?
wait "$bootstrap_two"; bootstrap_two_status=$?
set -e
if [[ "$bootstrap_one_status" -eq 0 && "$bootstrap_two_status" -eq 0 ]]; then
  echo "two first installers both mutated the install root" >&2; exit 1
fi
if [[ "$bootstrap_one_status" -ne 0 && "$bootstrap_two_status" -ne 0 ]]; then
  echo "no first installer established the install root" >&2; exit 1
fi
test -L "$bootstrap_base/current"
test ! -e "$bootstrap_base/lifecycle.json"
python3 "$repo/scripts/validate_package.py" "$root"
grep -Fq "$base/current/plugin/runtime/bin/node" "$root/plugin/.mcp.json"
grep -Fq "$base/current/plugin/dist/server.js" "$root/plugin/.mcp.json"
# This uses the installed payload's bundled checker, exporter, contract, and
# pinned runtime. It must not depend on this source checkout or PATH Node.
"$root/plugin/runtime/bin/node" "$root/plugin/dist/compatibility-check.mjs" --package-root "$root/plugin" --check > "$fixture/cached-components.json"
"$root/plugin/runtime/bin/node" "$repo/dist/compatibility-check.mjs" --package-root "$repo" --check > "$fixture/source-components.json"
python3 - "$fixture/cached-components.json" "$fixture/source-components.json" <<'PY'
import json,sys
result=json.load(open(sys.argv[1]))
assert result["schemaVersion"] == "loomex.plugin-compatibility-components/v1"
expected=json.load(open(sys.argv[2]))
for field in ("toolCount", "resourceCount", "skillCount", "hookCount"):
    assert result[field] == expected[field], field
assert isinstance(result["sha256"], str) and len(result["sha256"]) == 64
PY
# Codex caches the plugin directory alone. Its MCP and hook launchers must
# resolve without relying on a sibling runtime directory or development PATH.
cached_mcp_input="$fixture/cached-mcp.stdin"
mkfifo "$cached_mcp_input"
"$root/plugin/runtime/bin/node" "$root/plugin/dist/server.js" <"$cached_mcp_input" >"$fixture/cached-mcp.out" 2>"$fixture/cached-mcp.err" &
cached_mcp_pid=$!
# Keep stdin open so the stdio MCP transport remains alive for this cached
# payload launcher check; /dev/null closes immediately and only tests EOF.
exec 9>"$cached_mcp_input"
sleep 0.2
if ! kill -0 "$cached_mcp_pid" 2>/dev/null; then
  cat "$fixture/cached-mcp.err" >&2
  exit 1
fi
kill "$cached_mcp_pid"
wait "$cached_mcp_pid" 2>/dev/null || [[ $? -eq 143 ]]
exec 9>&-
test ! -s "$fixture/cached-mcp.err"
printf '%s' '{"session_id":"packaging-session","cwd":"/tmp","hook_event_name":"SessionStart"}' \
  | "$root/plugin/runtime/bin/node" "$root/plugin/hooks/lifecycle-adapter.mjs" >/dev/null
registered_marketplace="$base"
python3 - "$base/.agents/plugins/marketplace.json" "$base/install-receipt.json" "$base" <<'PY'
import json,sys
marketplace=json.load(open(sys.argv[1])); receipt=json.load(open(sys.argv[2])); base=sys.argv[3]
assert marketplace['plugins'][0]['source']=={'source':'local','path':'./current/plugin'}
assert marketplace['plugins'][0]['version']=='0.1.0'
assert receipt['schema']=='app.loomex.plugin.install-receipt/v2'
assert receipt['currentPath']==f'{base}/current' and receipt['versionsPath']==f'{base}/versions' and receipt['marketplacePath']==f'{base}/.agents/plugins/marketplace.json'
assert set(receipt['versions'])=={'0.1.0'} and len(receipt['versions']['0.1.0']['payloadInventorySha256'])==64
PY
# `lifecycle.sh` must also work with its optional forwarded-argument array
# empty; macOS Bash with nounset otherwise treats an empty array as unbound.
"$repo/scripts/lifecycle.sh" status --install-base "$base" > "$fixture/lifecycle-status-no-optional-args.json"
grep -Fq '"schema": "app.loomex.plugin.lifecycle-status/v1"' "$fixture/lifecycle-status-no-optional-args.json"
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
python3 "$repo/scripts/artifact.py" source-manifest --root "$payload2" --output "$fixture/source-content-2.json" --source-revision test2
SOURCE_DATE_EPOCH=2 python3 "$repo/scripts/artifact.py" create --payload "$payload2" --output "$release2" --project loomex-plugin --version 0.1.1 --platform darwin-arm64 --source-revision test2 --source-manifest "$fixture/source-content-2.json" --unsigned-development
mkdir -p "$release2/lifecycle-runtime"
cp "$payload2/plugin/runtime/bin/node" "$release2/lifecycle-runtime/node"
chmod 0755 "$release2/lifecycle-runtime/node"
cp "$payload2/plugin/dist/lifecycle.mjs" "$release2/lifecycle.mjs"
if LOOMEX_PLUGIN_INSTALL_FAIL_PHASE=bytes LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 "$repo/scripts/install.sh" "$release2" --allow-unsigned-development --install-base "$base" >/dev/null 2>&1; then
  echo "install fault injection did not interrupt" >&2; exit 1
fi
test -f "$base/lifecycle.json"
test ! -e "$base/.lifecycle.lock"
# A bytes checkpoint is not authorization to activate altered retained bytes.
printf '\nchanged install evidence\n' >> "$base/versions/0.1.1/plugin/dist/server.js"
if LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 "$repo/scripts/install.sh" "$release2" --allow-unsigned-development --install-base "$base" >/dev/null 2>&1; then
  echo "install resume accepted changed bytes after the bytes checkpoint" >&2; exit 1
fi
test -f "$base/lifecycle.json"
test "$(basename "$(readlink "$base/current")")" = 0.1.0
cp "$payload2/plugin/dist/server.js" "$base/versions/0.1.1/plugin/dist/server.js"
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
# Administrative lifecycle commands use the retained package helper and never
# need the source checkout, Python, or npm after the first install.
"$repo/scripts/lifecycle.sh" status --install-base "$base" > "$fixture/lifecycle-status.json"
grep -Fq '"current": "0.1.1"' "$fixture/lifecycle-status.json"
# A retained version is a rollback artifact, not merely a directory name.  A
# changed retained payload must be rejected before current is moved.
printf '\nchanged rollback evidence\n' >> "$base/versions/0.1.0/plugin/dist/server.js"
if "$repo/scripts/lifecycle.sh" rollback --install-base "$base" --version 0.1.0 >/dev/null 2>&1; then
  echo "rollback accepted changed retained package bytes" >&2; exit 1
fi
cp "$payload/plugin/dist/server.js" "$base/versions/0.1.0/plugin/dist/server.js"
"$repo/scripts/lifecycle.sh" rollback --install-base "$base" --version 0.1.0
test "$(basename "$(readlink "$base/current")")" = 0.1.0
"$repo/scripts/lifecycle.sh" repair --install-base "$base"
"$repo/scripts/lifecycle.sh" rollback --install-base "$base" --version 0.1.1
test "$(basename "$(readlink "$base/current")")" = 0.1.1
# The first repair checkpoint is durable. A later state-write failure keeps
# that exact operation for repair/resume instead of reporting a completed run.
if LOOMEX_PLUGIN_LIFECYCLE_FAIL_WRITE=after-first "$repo/scripts/lifecycle.sh" repair --install-base "$base" >/dev/null 2>&1; then
  echo "lifecycle durable-write fault injection did not interrupt" >&2; exit 1
fi
test -f "$base/lifecycle.json"
"$repo/scripts/lifecycle.sh" status --install-base "$base" > "$fixture/recovery-status.json"
grep -Fq '"operation": "repair"' "$fixture/recovery-status.json"
grep -Fq '"recoveryRequired": true' "$fixture/recovery-status.json"
"$repo/scripts/lifecycle.sh" repair --install-base "$base" > "$fixture/repair-result.json"
grep -Fq '"schema": "app.loomex.plugin.lifecycle-result/v1"' "$fixture/repair-result.json"
test ! -e "$base/lifecycle.json"
# Lock recovery only accepts a lock whose owner is positively known dead. The
# fixtures below use a non-existent PID and an old creation date so they are
# deterministic without waiting for a clock timeout.
write_stale_lock() {
  local lock_path="$1" token="$2"
  rm -rf "$lock_path"
  mkdir "$lock_path"
  printf '%s\n' '{"schema":"app.loomex.plugin.lock/v1","token":"'"$token"'","pid":999999,"processStart":"stale","host":"'"$(hostname)"'","createdAt":"2000-01-01T00:00:00.000Z"}' > "$lock_path/owner.json"
}
assert_no_recovery_locks() {
  test ! -e "$base/.lifecycle.lock"
  if compgen -G "$base/.lifecycle.lock.recovery*" >/dev/null; then
    echo "stale lifecycle recovery guard remained" >&2; exit 1
  fi
}
# A process can die while it owns the recovery guard. The next operation must
# reclaim that guard through its own nested guard, finish recovery, and remove
# every temporary lock.
write_stale_lock "$base/.lifecycle.lock" stale-primary-with-dead-guard
write_stale_lock "$base/.lifecycle.lock.recovery" dead-recovery-guard
"$repo/scripts/lifecycle.sh" repair --install-base "$base"
assert_no_recovery_locks
# Two contenders use independent FIFO gates, so both are released without a
# shared-reader race or arbitrary delay. A contender may finish a serialized
# repair or lose the active-lock race; any failure must be that exact outcome.
write_stale_lock "$base/.lifecycle.lock" stale-two-contenders
contender_one_gate="$fixture/lifecycle-contender-one-gate"
contender_two_gate="$fixture/lifecycle-contender-two-gate"
mkfifo "$contender_one_gate" "$contender_two_gate"
( read -r _ < "$contender_one_gate"; "$repo/scripts/lifecycle.sh" repair --install-base "$base" >"$fixture/lifecycle-contender-one.out" 2>&1 ) & lock_one=$!
( read -r _ < "$contender_two_gate"; "$repo/scripts/lifecycle.sh" repair --install-base "$base" >"$fixture/lifecycle-contender-two.out" 2>&1 ) & lock_two=$!
exec 8>"$contender_one_gate"
exec 9>"$contender_two_gate"
printf 'go\n' >&8
printf 'go\n' >&9
exec 8>&-
exec 9>&-
set +e
wait "$lock_one"; lock_one_status=$?
wait "$lock_two"; lock_two_status=$?
set -e
if [[ "$lock_one_status" -ne 0 && "$lock_one_status" -ne 1 ]]; then
  echo "first lifecycle contender exited unexpectedly: $lock_one_status" >&2; exit 1
fi
if [[ "$lock_two_status" -ne 0 && "$lock_two_status" -ne 1 ]]; then
  echo "second lifecycle contender exited unexpectedly: $lock_two_status" >&2; exit 1
fi
if [[ "$lock_one_status" -ne 0 && "$lock_two_status" -ne 0 ]]; then
  echo "no lifecycle contender completed stale-lock recovery" >&2; exit 1
fi
if [[ "$lock_one_status" -ne 0 ]]; then grep -Fq 'plugin lifecycle operation already in progress' "$fixture/lifecycle-contender-one.out"; fi
if [[ "$lock_two_status" -ne 0 ]]; then grep -Fq 'plugin lifecycle operation already in progress' "$fixture/lifecycle-contender-two.out"; fi
assert_no_recovery_locks
# An unavailable liveness probe is uncertain, never evidence that it is safe
# to move the lock. The retained stale lock can later be recovered normally.
write_stale_lock "$base/.lifecycle.lock" stale-liveness-unknown
if LOOMEX_PLUGIN_LOCK_TEST_LIVENESS=unknown "$repo/scripts/lifecycle.sh" repair --install-base "$base" >/dev/null 2>&1; then
  echo "lifecycle recovery stole a lock when liveness was uncertain" >&2; exit 1
fi
grep -Fq '"token":"stale-liveness-unknown"' "$base/.lifecycle.lock/owner.json"
test ! -e "$base/.lifecycle.lock.recovery"
rm -rf "$base/.lifecycle.lock"
# If ownership changes after the initial stale read, the exact-owner recheck
# must preserve the new lock and report a recoverable busy outcome.
write_stale_lock "$base/.lifecycle.lock" stale-before-new-owner
if LOOMEX_PLUGIN_LOCK_TEST_REPLACE_OWNER_BEFORE_REREAD=1 "$repo/scripts/lifecycle.sh" repair --install-base "$base" >/dev/null 2>&1; then
  echo "lifecycle recovery accepted a replaced lock owner" >&2; exit 1
fi
grep -Fq '"token":"fixture-new-owner"' "$base/.lifecycle.lock/owner.json"
test ! -e "$base/.lifecycle.lock.recovery"
rm -rf "$base/.lifecycle.lock"
# Versions are retained so the lifecycle manager can offer a verified rollback.
test -d "$root"
printf preserve > "$base/.agents/plugins/unrelated-sentinel"
outside_metadata="$fixture/outside-metadata"; mkdir -p "$outside_metadata/plugins"
cp "$base/.agents/plugins/marketplace.json" "$outside_metadata/plugins/marketplace.json"
mv "$base/.agents" "$base/.agents-owned"
ln -s "$outside_metadata" "$base/.agents"
if "$repo/scripts/uninstall.sh" --install-base "$base" >/dev/null 2>&1; then echo "uninstall followed a symlinked marketplace metadata parent" >&2; exit 1; fi
test -f "$outside_metadata/plugins/marketplace.json"
unlink "$base/.agents"
mv "$base/.agents-owned" "$base/.agents"
if LOOMEX_PLUGIN_UNINSTALL_FAIL_PHASE=current "$repo/scripts/uninstall.sh" --install-base "$base" >/dev/null 2>&1; then
  echo "uninstall fault injection did not interrupt" >&2; exit 1
fi
test -f "$base/lifecycle.json"
# Current has already been removed, so this exercises a resumable uninstall.
# A version modified after the journal was created must remain on disk.
test ! -e "$base/current"
printf '\nchanged uninstall evidence\n' >> "$base/versions/0.1.1/plugin/dist/server.js"
if "$repo/scripts/uninstall.sh" --install-base "$base" >/dev/null 2>&1; then
  echo "resumed uninstall deleted changed package bytes" >&2; exit 1
fi
test -d "$base/versions/0.1.1"
cp "$payload2/plugin/dist/server.js" "$base/versions/0.1.1/plugin/dist/server.js"
if LOOMEX_PLUGIN_UNINSTALL_FAIL_PHASE=after-terminal-journal "$repo/scripts/uninstall.sh" --install-base "$base" >/dev/null 2>&1; then
  echo "terminal helper cleanup fault injection did not interrupt" >&2; exit 1
fi
test ! -e "$base/lifecycle.json"
test -f "$base/lifecycle.terminal.json"
test ! -e "$base/.lifecycle-runtime"
recovery_helper=""
for candidate in "$base"/.lifecycle-runtime.recovery-*; do
  [[ -d "$candidate" && -x "$candidate/node" && -f "$candidate/lifecycle.mjs" ]] || continue
  recovery_helper="$candidate"
done
test -n "$recovery_helper"
"$repo/scripts/lifecycle.sh" status --install-base "$base" > "$fixture/uninstall-recovery-status.json"
grep -Fq '"phase": "complete"' "$fixture/uninstall-recovery-status.json"
grep -Fq '"recoveryRequired": true' "$fixture/uninstall-recovery-status.json"
# The retained helper can also fail after it has deleted itself but before the
# terminal marker is unlinked.  That marker is recognizably complete and the
# launchers clear only that exact terminal record; active journals never take
# this path.
if LOOMEX_PLUGIN_UNINSTALL_FAIL_PHASE=after-helper-delete "$repo/scripts/uninstall.sh" --install-base "$base" >/dev/null 2>&1; then
  echo "post-helper-delete fault injection did not interrupt" >&2; exit 1
fi
test ! -e "$recovery_helper"
test -f "$base/lifecycle.terminal.json"
"$repo/scripts/lifecycle.sh" status --install-base "$base" > "$fixture/terminal-no-helper-status.json"
grep -Fq '"terminal":true' "$fixture/terminal-no-helper-status.json"
"$repo/scripts/uninstall.sh" --install-base "$base"
test ! -e "$base/lifecycle.json"
test ! -e "$base/lifecycle.terminal.json"
test ! -e "$recovery_helper"
test ! -e "$base/versions/0.1.1"
test ! -e "$base/versions/0.1.0"
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
