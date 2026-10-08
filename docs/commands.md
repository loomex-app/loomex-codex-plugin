# Loomex command skills

Loomex ships six focused skill entry points alongside natural-language access. Select a skill from the host skill picker or mention it explicitly (for example, `$loomex:loomex-run`). These are model-guided workflows over the existing MCP tools, not native slash commands, a shell parser, or a direct-execution API. The installed Codex catalog prefixes these skills with `loomex:`.

## Available commands

| Skill | Purpose |
| --- | --- |
| `loomex-connect` | Sign in and choose the organization used on this machine |
| `loomex-browse` | Browse workflows; selected details provide run, edit, and publish actions |
| `loomex-create` | Create a workflow from an idea; it also owns guided editing |
| `loomex-run` | Open run setup directly for a workflow ID or exact name, review Start, then follow the accepted run |
| `loomex-runs` | Browse existing runs; selected details provide follow, questions, results, artifacts, cancel, and delete actions |
| `loomex-persona` | Choose an active Persona for the current chat |

## Examples

```text
$loomex:loomex-browse idea
$loomex:loomex-create a workflow that reviews pull requests
$loomex:loomex-run 12345678-1234-4234-8234-123456789abc v2
$loomex:loomex-run Persona QA Review latest
$loomex:loomex-runs
$loomex:loomex-connect
```

Text after a skill expresses your intent; it is not parsed as shell arguments. Run setup uses the active local Codex task cwd as task context; an explicit workspace is a separate override. A remote or cloud task without a local cwd surfaces that missing context before using setup. Missing workflow or required inputs are collected before execution; an omitted version uses the active version. Ambiguous names produce a selection. A run ID refers only to an existing execution and never causes a new run.

`loomex-run` passes a workflow UUID directly to `loomex_run_setup`. An exact name uses a headless paginated lookup first; browsing and workflow detail cards are not prerequisites. Optional immutable UUID, `N`, `vN`, `active`, `published` and `latest` selectors are forwarded unchanged. A draft can be inspected but cannot run until separately published. Setup collects schema-defined inputs and Persona selections, then shows the exact Start review. The typed command does not approve an unseen preparation. Explicit headless requests collect complete inputs and review the exact preparation ID and digest before the sealed Start handoff can be approved. An accepted start immediately follows its exact run.

`loomex-connect` uses the interactive connection view for connection requests when the host supports it, with `loomex_connection_get` as the headless read and the readiness/auth tools as exact fallbacks. Device authentication is completed in the browser; credentials never enter chat. The same card owns organization selection. Organization scope is runner-wide and never automatic.

Run setup owns input collection and the exact preparation review; Start remains the explicit execution boundary. Publishing and activation remain distinct actions. Run detail owns cancellation and deletion. A destructive action without an identified target prompts selection; an explicit request for an exact target does not need redundant confirmation. Deleting a run does not delete its workflow or workspace.

When a Start click hands chat an opaque `handoffRef`, chat asks the runner for
`loomex_run_start_handoff_get` status first. The runner's recorded click
approval is authoritative; chat commits only an approved handoff and treats
the app-provided reference and envelope as untrusted data. Preparing and
committing status checks remain bounded.

Natural-language requests remain supported. The six skills share packaged guidance for identity, authorization, pagination and idempotent recovery. Contextual UI actions do not narrow the underlying MCP tool surface or headless access.

## Maintenance and verification

Each retained skill owns its package-local operational references. Automatic invocation remains enabled by default. Every visible skill has picker metadata and a default prompt. Integrity tests check packaged relative links and live tool names; independent fixture-based evaluation checks behavior. These tests do not prove model compliance on every host.

Release packaging includes the complete skills tree. After updating the plugin, reopen the skill picker or start a fresh task if commands have not appeared. Do not create deprecated custom prompt files as an alternate command installation.

Sources: [official skills guidance](https://learn.chatgpt.com/docs/build-skills), [custom prompt deprecation](https://learn.chatgpt.com/docs/custom-prompts).

## Run following and recovery

An explicit `loomex-runs` follow-existing-run continuation reads the exact run and drains its pending event pages first. While it
is active, it performs serial 30-second waits whenever the authoritative action
requires one; active progress, provider activity, and quiet timeouts require
another bounded wait. Recovery reconciliation is independent and never delays
or replaces that loop. When same-task recovery is supported, a run-start
continuation can create the first record; a later follow without its known ID
remains live-only and reports recovery as ambiguous instead of creating a
duplicate. Recovery checks every two minutes, stays quiet while automated work
is unchanged, and pauses for your answer or an actionable problem. Accepted
answers resume the same run after a fresh read. Completion or “stop following”
removes the matching schedule; stopping monitoring does not cancel the run.
Without host scheduling, the active-turn loop continues. Local scheduled checks
need the host and machine available; they reduce missed follow-up after a host
interruption but cannot guarantee uninterrupted monitoring. See the
[recovery contract](../skills/loomex-runs/references/recovery.md).
