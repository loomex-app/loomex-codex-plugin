#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--payload-root", required=True)
parser.add_argument("--installed-root", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
payload = Path(args.payload_root).resolve()
installed = Path(os.path.abspath(args.installed_root))
payload_node = payload / "runtime" / "bin" / "node"
payload_server = payload / "plugin" / "dist" / "server.js"
if not payload_node.is_file() or not payload_server.is_file():
    raise SystemExit("installed Node runtime or MCP entrypoint is missing")
node = installed / "runtime" / "bin" / "node"
server = installed / "plugin" / "dist" / "server.js"
payload = {"mcpServers": {"loomex": {"command": str(node), "args": [str(server)]}}}
Path(args.output).write_text(json.dumps(payload, indent=2) + "\n")
