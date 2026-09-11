#!/usr/bin/env python3
"""Validate the release allowlist, manifest paths, and MCP entrypoint binding."""
import argparse
import json
import subprocess
from pathlib import Path, PurePosixPath

FORBIDDEN_PARTS = {
    ".git", ".env", "credentials", "credential", "secrets", "node_modules",
    ".test-dist", ".cache", ".npm", "coverage", "__pycache__", ".DS_Store",
}

parser = argparse.ArgumentParser()
parser.add_argument("root")
parser.add_argument("--expected-root")
parser.add_argument("--template", action="store_true")
parser.add_argument("--expected-version", default="0.1.0")
args = parser.parse_args()
root = Path(args.root).resolve()
expected = Path(args.expected_root).resolve() if args.expected_root else root
plugin = root / "plugin"
manifest = json.loads((plugin / ".codex-plugin" / "plugin.json").read_text())
if manifest.get("version") != args.expected_version or manifest.get("name") != "loomex":
    raise SystemExit("unexpected plugin identity")
for field in ("skills", "mcpServers"):
    value = manifest.get(field)
    if not isinstance(value, str) or not value.startswith("./"):
        raise SystemExit(f"manifest {field} must be a ./ path")
    relative = PurePosixPath(value[2:])
    if ".." in relative.parts or relative.is_absolute():
        raise SystemExit(f"manifest {field} escapes plugin root")
    if not (plugin / relative).exists() and not (args.template and field == "mcpServers" and (plugin / ".mcp.template.json").is_file()):
        raise SystemExit(f"manifest {field} target is missing")
hooks_path = manifest.get("hooks")
if not isinstance(hooks_path, str) or not hooks_path.startswith("./"):
    raise SystemExit("manifest hooks must be a ./ path")
hooks_relative = PurePosixPath(hooks_path[2:])
if ".." in hooks_relative.parts or hooks_relative.is_absolute() or hooks_relative.as_posix() != "hooks/hooks.json":
    raise SystemExit("manifest hooks must point to hooks/hooks.json within plugin root")
hooks_file = plugin / hooks_relative
if not hooks_file.is_file():
    raise SystemExit("plugin hooks manifest is missing")
hooks = json.loads(hooks_file.read_text())
events = hooks.get("hooks") if isinstance(hooks, dict) else None
required_events = {"SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "Interrupt"}
if not isinstance(events, dict) or set(events) != required_events:
    raise SystemExit("plugin hooks manifest has an unexpected event set")
for event, groups in events.items():
    if not isinstance(groups, list) or len(groups) != 1 or not isinstance(groups[0], dict):
        raise SystemExit(f"plugin hook {event} must contain one command group")
    handlers = groups[0].get("hooks")
    if not isinstance(handlers, list) or len(handlers) != 1 or not isinstance(handlers[0], dict):
        raise SystemExit(f"plugin hook {event} must contain one command handler")
    handler = handlers[0]
    if handler.get("type") != "command" or handler.get("command") != "\"$PLUGIN_ROOT/runtime/bin/node\" \"$PLUGIN_ROOT/hooks/lifecycle-adapter.mjs\"":
        raise SystemExit(f"plugin hook {event} does not bind the packaged runtime and adapter")
    expected_timeout = 3 if event == "Interrupt" else 10
    if handler.get("timeout") != expected_timeout:
        raise SystemExit(f"plugin hook {event} has an invalid timeout")
if not (plugin / "hooks" / "lifecycle-adapter.mjs").is_file():
    raise SystemExit("plugin lifecycle adapter is missing")
if not (plugin / "runtime" / "bin" / "node").is_file():
    raise SystemExit("plugin runtime is missing")
for path in root.rglob("*"):
    relative = path.relative_to(root)
    if any(part in FORBIDDEN_PARTS or part.startswith(".env") or part.endswith((".pem",".key",".log")) or "credential" in part.lower() or "secret" in part.lower() for part in relative.parts):
        raise SystemExit(f"forbidden packaged path: {relative}")
marketplace=json.loads((root/".agents/plugins/marketplace.json").read_text())
entries=marketplace.get("plugins",[])
if len(entries)!=1 or entries[0].get("name")!="loomex" or entries[0].get("version")!=args.expected_version or entries[0].get("source",{}).get("path")!="./plugin":
    raise SystemExit("private marketplace descriptor mismatch")
for component in ("compatibility-export.mjs", "compatibility-check.mjs"):
    if not (root / "plugin" / "dist" / component).is_file():
        raise SystemExit(f"plugin compatibility bundle is missing: dist/{component}")
try:
    subprocess.run(
        [
            str(plugin / "runtime" / "bin" / "node"),
            str(plugin / "dist" / "compatibility-check.mjs"),
            "--package-root",
            str(plugin),
            "--check",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
except (OSError, subprocess.CalledProcessError) as exc:
    detail = exc.stderr.strip() if isinstance(exc, subprocess.CalledProcessError) and exc.stderr else str(exc)
    raise SystemExit(f"plugin compatibility bundle could not be evaluated from the package: {detail}") from exc
if args.template:
    template=(plugin/".mcp.template.json").read_text()
    if template.count("__LOOMEX_NODE__") != 1 or template.count("__LOOMEX_PLUGIN_SERVER__") != 1:
        raise SystemExit("MCP template placeholders are invalid")
    raise SystemExit(0)
mcp = json.loads((plugin / ".mcp.json").read_text())
if set(mcp) != {"mcpServers"}:
    raise SystemExit(".mcp.json must contain only mcpServers")
server = mcp.get("mcpServers", {}).get("loomex", {})
command = Path(server.get("command", ""))
arguments = server.get("args", [])
if not command.is_absolute() or len(arguments) != 1 or not Path(arguments[0]).is_absolute():
    raise SystemExit("MCP launcher paths must be absolute")
if command.resolve(strict=False) != (expected / "plugin" / "runtime" / "bin" / "node").resolve(strict=False):
    raise SystemExit("MCP command does not bind the packaged runtime")
if Path(arguments[0]).resolve(strict=False) != (expected / "plugin" / "dist" / "server.js").resolve(strict=False):
    raise SystemExit("MCP argument does not bind the packaged server")
if not (root / "plugin" / "runtime" / "bin" / "node").is_file() or not (root / "plugin" / "dist" / "server.js").is_file():
    raise SystemExit("MCP runtime or server entrypoint is missing")
