# Loomex Codex plugin

Current workspace installation and delivery status: [authoritative reliability status](../planning/plugin-runner-integration/reliability-persona-performance-2026-10-03/current-status.md). Source package versions and historical examples below do not establish an installed candidate.

This private macOS arm64 plugin connects Codex desktop and Codex CLI to the
signed Loomex runner over an owner-checked Unix socket. The plugin contains no
Loomex credentials and makes no backend or provider calls itself.

See [architecture](docs/architecture.md) for component ownership and trust
boundaries, and [development](docs/development.md) for contract synchronization,
testing, and packaging rules.

The installed plugin also contains a reviewed-and-trusted Codex lifecycle-hook
bridge for durable follow sessions. See [lifecycle hooks](docs/lifecycle-hooks.md)
for its socket boundary, exact event payloads, and hook-trust activation steps.

## Command skills

Use five focused skills: connect, browse, create, runs, and persona. Their contextual
cards expose the actions that depend on the selected item, including
organization selection, workflow editing and publishing, run preparation,
human responses, results, cancellation, and deletion. See [the command
guide](docs/commands.md) for the entry points and examples. Connection details
and browser device-flow safety are documented in [connection](docs/connection.md).
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

Visual entry points use direct MCP Apps invocation when the host supports it;
each packaged skill carries its visual-delivery contract for the native and
headless paths. On hosts that gate direct invocation,
diagnostics should verify that the supported
`features.code_mode.direct_only_tool_namespaces` setting includes
`mcp__loomex`. The plugin advertises the namespace and visual resources but
cannot change that host setting. Installed transport and browser-resource
checks do not prove that a native Codex card rendered; record that only from
an authorized host observation.


Custom views consume the frontend design system through a pinned, compiled CSS artifact. The shared renderer inlines it offline for every MCP resource. See [design-system.md](docs/design-system.md) for canonical sources, sync/check commands, dark-mode behavior and accessibility adaptations.

Read-only installed checks are available through `scripts/lifecycle.sh diagnostics`; see [diagnostics and host routing](docs/diagnostics.md).

## Public preview distribution

The public component repository is `loomex-app/loomex-codex-plugin`. End users
install the exact compatible runner and plugin through the unified installer
attached to a reviewed paired release in `loomex-app/loomex-runner`. The release
set binds both source revisions, versions, archive checksums, and passing
compatibility evidence. Select an explicit `preview-runner-vX.Y.Z-plugin-vX.Y.Z`
tag; mixing `latest` assets is unsupported. The local Codex marketplace identity
remains `loomex-private`, with plugin name `loomex`.

Unsigned previews require explicit unsafe development opt-in and an isolated
test installation. They have no Apple signing, notarization, or production
assurance. Publication is a separate maintainer decision after reviewing the
draft and paired compatibility evidence. See [public distribution](docs/public-distribution.md)
for exact archive contents, install commands, and release checkpoints.
