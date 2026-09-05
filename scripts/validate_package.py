#!/usr/bin/env python3
"""Validate the release allowlist, manifest paths, and MCP entrypoint binding."""
import argparse
import json
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
for path in root.rglob("*"):
    relative = path.relative_to(root)
    if any(part in FORBIDDEN_PARTS or part.startswith(".env") or part.endswith((".pem",".key",".log")) or "credential" in part.lower() or "secret" in part.lower() for part in relative.parts):
        raise SystemExit(f"forbidden packaged path: {relative}")
marketplace=json.loads((root/".agents/plugins/marketplace.json").read_text())
entries=marketplace.get("plugins",[])
if len(entries)!=1 or entries[0].get("name")!="loomex" or entries[0].get("version")!=args.expected_version or entries[0].get("source",{}).get("path")!="./plugin":
    raise SystemExit("private marketplace descriptor mismatch")
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
if command.resolve(strict=False) != (expected / "runtime" / "bin" / "node").resolve(strict=False):
    raise SystemExit("MCP command does not bind the packaged runtime")
if Path(arguments[0]).resolve(strict=False) != (expected / "plugin" / "dist" / "server.js").resolve(strict=False):
    raise SystemExit("MCP argument does not bind the packaged server")
if not (root / "runtime" / "bin" / "node").is_file() or not (root / "plugin" / "dist" / "server.js").is_file():
    raise SystemExit("MCP runtime or server entrypoint is missing")
