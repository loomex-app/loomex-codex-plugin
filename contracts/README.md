# Local runner contract pin

The Loomex runner project owns the canonical `loomex.local-control/v2` schemas.
Protocol changes require an explicit, reviewed byte-for-byte sync of both runner
exports into this directory and an update to `contract-pin.json`. Release
packaging includes only these checked-in copies; it does not read or regenerate
contracts from another repository. The plugin test suite verifies their SHA-256
digests and rejects method or top-level schema drift.
