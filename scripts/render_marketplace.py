#!/usr/bin/env python3
"""Derive the stable installed marketplace descriptor from its verified template."""

import argparse
import json
import os
import re
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--template", required=True)
parser.add_argument("--expected-version", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.expected_version):
    raise SystemExit("invalid marketplace version")
data = json.loads(Path(args.template).read_text())
entries = data.get("plugins")
if (
    data.get("name") != "loomex-private"
    or not isinstance(entries, list)
    or len(entries) != 1
    or entries[0].get("name") != "loomex"
    or entries[0].get("version") != args.expected_version
    or entries[0].get("source") != {"source": "local", "path": "./plugin"}
):
    raise SystemExit("verified marketplace template has an unexpected identity or source")
entries[0]["source"]["path"] = "./current/plugin"
out = Path(args.output)
encoded = (json.dumps(data, indent=2, sort_keys=True) + "\n").encode()
with out.open("xb") as handle:
    handle.write(encoded)
    handle.flush()
    os.fsync(handle.fileno())
