# Loomex Codex plugin

This private macOS arm64 plugin connects Codex desktop and Codex CLI to the
signed Loomex runner over an owner-checked Unix socket. The plugin contains no
Loomex credentials and makes no backend or provider calls itself.

See [architecture](docs/architecture.md) for component ownership and trust
boundaries, and [development](docs/development.md) for contract synchronization,
testing, and packaging rules.

## Command skills

Use focused skills to browse, author, run, follow, answer, and retrieve results.
See [the command guide](docs/commands.md) for all 15 entry points and examples.
Natural-language access remains available.

## Development

Requires the pinned Node.js 24 runtime used by release packaging.

```sh
npm ci
npm run typecheck
npm test
```

`npm run build` creates the compiled MCP server at `dist/server.js`. Release
packaging generates `.mcp.json` with absolute paths to a bundled, pinned Node
runtime and this compiled file; the released plugin never launches raw
TypeScript and does not depend on the desktop application's `PATH` or working
directory.

The local RPC protocol is `loomex.local-control/v2`. All mutating tools require
a UUID idempotency key. Reuse that key after an ambiguous transport failure.
Never create a new key merely to retry the same intended change.

Builder sessions, editor sessions, and workflow execution use two-step
prepare/commit operations. Each prepare tool returns the canonical workspace,
provider and execution policy binding, digest, and confirmation key. Call its
matching commit tool only after those facts have been reviewed and accepted.

Local task entry points default workspace selection to the actual Codex task
working directory supplied by the calling skill. An explicit user path wins.
This context is handled inside the plugin and is never inferred from the MCP
server process or forwarded as a runner protocol field; grants and prepared
bindings still establish the canonical execution workspace.
