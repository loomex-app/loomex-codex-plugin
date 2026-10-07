# Loomex Codex plugin

Use Loomex workflows from Codex chat: browse and create workflows, prepare a run,
answer its questions, follow progress, retrieve results and artifacts, or choose
an AI Persona. The plugin connects Codex desktop and CLI to the
[Loomex runner](https://github.com/loomex-app/loomex-runner) on your Mac through an
owner-checked local socket. The runner handles authentication and job execution;
the plugin contains no Loomex credentials and makes no backend or provider calls
itself.

## Install

Install using the instructions in the runner's
[paired GitHub release](https://github.com/loomex-app/loomex-runner/releases/latest).
The paired installer selects compatible runner and plugin components. Review the
release's platform, backend, and signing prerequisites before installation.
[Plugin releases](https://github.com/loomex-app/loomex-codex-plugin/releases)
provide component downloads; use the paired instructions for installation.

You need Codex desktop or CLI, a compatible Loomex backend, and any provider CLIs
required by your workflows, with their own account access. The release instructions
specify the backend configuration and Codex registration requirements. The plugin
includes its Node.js runtime. Installation does not force login, organization
selection, workflow execution, or hook trust.

The installer installs both components. For the current unsigned distribution,
review the release prerequisites, then run:

```sh
loomex_installer="$(mktemp)" &&
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  https://github.com/loomex-app/loomex-runner/releases/latest/download/install.sh \
  -o "$loomex_installer" &&
LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 /bin/bash "$loomex_installer" --allow-unsigned-development
```

The downloaded launcher pins one exact release manifest and installer. The paired
packages remain hash-verified; unsigned builds require the explicit opt-in above.
Restart Codex afterward. A compatible backend must already be running.

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

Follow the paired GitHub release's instructions to update. If installation or
registration is interrupted, preserve its verified assets and use the supported
owner recovery flow. Do not remove lifecycle journals, edit Codex caches, or delete
installed versions manually. See [distribution](docs/public-distribution.md) for
registration, and [lifecycle details](docs/release.md) for status, resume, rollback,
repair, pruning, and uninstall. Remove or disable the plugin's Codex registration
as part of removal; runner uninstall is separate.

## Development

Use the pinned Node.js runtime described in [development](docs/development.md):

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Read [architecture](docs/architecture.md) and
[compatibility contracts](docs/compatibility-components.md) before changing the
bridge. Low-level MCP tools are separate from the chat skills. Mutating tools use
UUID idempotency keys. Reconcile an ambiguous result with the original key rather
than issuing another change.
