# Loomex Codex plugin

Use Loomex workflows from Codex chat: browse and create workflows, prepare a run,
answer its questions, follow progress, retrieve results and artifacts, or choose
an AI Persona. The plugin connects Codex desktop and CLI to the
[Loomex runner](https://github.com/loomex-app/loomex-runner) on your Mac through an
owner-checked local socket. The runner handles authentication and job execution;
the plugin contains no Loomex credentials and makes no backend or provider calls
itself.

## Version 1.0.0 preview and installation

Plugin **1.0.0** is paired with runner **1.0.0** in the
[authoritative paired release](https://github.com/loomex-app/loomex-runner/releases/tag/preview-runner-v1.0.0-plugin-v1.0.0),
tagged `preview-runner-v1.0.0-plugin-v1.0.0`. The
[plugin release](https://github.com/loomex-app/loomex-codex-plugin/releases/tag/preview-runner-v1.0.0-plugin-v1.0.0)
mirrors the identical plugin archive; use the paired installer to select compatible
components.

This is an **unsigned local-development prerelease for macOS Apple Silicon**,
without Developer ID signing or notarization. It requires explicit development
consent and an existing compatible backend at **`http://127.0.0.1:28080/`**.
The release does not include a backend or configured web app, and cannot connect
to a hosted cloud backend. It has not been promoted to a latest stable release.

Follow the runner's [verified installation instructions](https://github.com/loomex-app/loomex-runner#install):
download and inspect `install-preview.sh`, verify its pinned checksum, then run
it with `LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1` and `--allow-unsigned-preview`.
The default installs both components and registers `loomex@loomex-private` using
the supported Codex CLI when available. Do not mix assets from different tags.
The release-set SHA-256 is
`906cca85109be51819ebe6ba5c3d8de6b4ff9bbe8b427f86f5592f1ce0906cdd`.

You need Codex desktop or CLI and any provider CLIs required by your workflows,
with their own account access. The plugin includes its pinned Node.js runtime;
you do not need npm, system Node, Python, or a source checkout to install it.
If the Codex CLI is unavailable, the installer reports the local marketplace root
for supported GUI import. If the host has no local import, install the supported
Codex CLI and retry the same release set. Installation does not force login,
organization selection, workflow execution, or hook trust.

## Get started in Codex

Open a fresh chat or refresh the skill picker after installation. Select a Loomex
skill or write a natural-language request such as “Connect to Loomex” or “Show my
Loomex workflows.” These are chat skills, not shell or native slash commands.

| Chat skill | What it does |
| --- | --- |
| `$loomex:loomex-connect` | Check your connection, sign in, and choose an organization |
| `$loomex:loomex-browse` | Find workflows and inspect run, edit, and publish actions |
| `$loomex:loomex-create` | Create or edit a workflow through guided review |
| `$loomex:loomex-runs` | Find runs, follow progress, answer questions, and retrieve results |
| `$loomex:loomex-persona` | Choose an active Persona for this chat |

Start with `$loomex:loomex-connect`, then `$loomex:loomex-browse`. When running a
workflow, supply its required inputs and review the exact workspace, provider,
and execution policy before choosing **Start**. Your current local Codex task
directory is the initial workspace suggestion; an explicit path takes precedence.
Workflow creation and editing include human review and acceptance. Saving a draft,
publishing it, and running it are separate actions.

Connection credentials stay with the runner and never need to be pasted into
chat. Provider login and model access remain with the provider CLIs. Workflow
jobs use your OS user's host permissions; workspace approval is not a filesystem
sandbox.

The plugin presents interactive cards on supported hosts and follows runs in chat
when requested. Host support and configuration determine whether a card renders.
Review and trust the packaged lifecycle hooks separately in Codex; installation
alone does not activate that trust or guarantee follow-up delivery. See
[connection](docs/connection.md), [lifecycle hooks](docs/lifecycle-hooks.md), and
[diagnostics](docs/diagnostics.md) for troubleshooting.

## Updates and removal

Update through a complete reviewed paired release. If installation or registration
is interrupted, preserve its verified release assets and use the supported owner
recovery flow. Do not remove lifecycle journals, edit Codex caches, or delete
installed versions manually. See [public distribution](docs/public-distribution.md)
for offline assets and registration, and [release and lifecycle](docs/release.md)
for status, resume, rollback, repair, pruning, and uninstall. Remove or disable the
plugin's Codex registration as part of removal; runner uninstall is separate.

## Development

Use the pinned Node.js 24 runtime described in [development](docs/development.md):

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Read [architecture](docs/architecture.md) and
[compatibility contracts](docs/compatibility-components.md) before changing the
bridge. Low-level MCP tools are separate from the chat skills. The local protocol
is `loomex.local-control/v2`; mutating tools use UUID idempotency keys. Reconcile
an ambiguous result with the original key rather than issuing another change.

The published plugin was built from
[`349cbbbca34bfe172714088f633bc7bf656b378c`](https://github.com/loomex-app/loomex-codex-plugin/commit/349cbbbca34bfe172714088f633bc7bf656b378c),
paired with runner
[`031ea7aa612786cb76b24bf98fe3c0644058c71c`](https://github.com/loomex-app/loomex-runner/commit/031ea7aa612786cb76b24bf98fe3c0644058c71c).
Later source or documentation changes do not change those immutable release bytes.
