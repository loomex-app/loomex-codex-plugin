# Loomex command skills

Loomex ships focused skill entry points alongside natural-language access. Select a skill from the host skill picker or mention it explicitly (`$loomex:loomex-run` in this installed Codex CLI). These are model-guided workflows over the existing MCP tools, not native slash commands, a shell parser, or a direct-execution API. The installed Codex catalog prefixes these skills with `loomex:`; select that entry from the picker for an explicit invocation.

## Available commands

| Skill | Purpose |
| --- | --- |
| `loomex-connect` | Connect Loomex |
| `loomex-workspaces` | Loomex Workspaces |
| `loomex-browse` | Browse Loomex Workflows |
| `loomex-inspect` | Inspect Loomex Workflow |
| `loomex-create` | Create Loomex Workflow |
| `loomex-edit` | Edit Loomex Workflow |
| `loomex-publish` | Publish Loomex Workflow |
| `loomex-run` | Run Loomex Workflow |
| `loomex-runs` | List Loomex Runs |
| `loomex-status` | Loomex Run Status |
| `loomex-follow` | Follow Loomex Run |
| `loomex-answer` | Answer Loomex Questions |
| `loomex-results` | Loomex Run Results |
| `loomex-cancel` | Cancel Loomex Run |
| `loomex-delete-run` | Delete Loomex Run |

## Examples

```text
$loomex:loomex-browse idea
$loomex:loomex-run Idea to Implementation in /Users/me/Projects/example
$loomex:loomex-status <run-id>
$loomex:loomex-follow <run-id>
$loomex:loomex-answer <run-id>
$loomex:loomex-results <run-id>
```

Text after the skill expresses your intent; it is not parsed as shell arguments. Missing workflow, version, workspace or required inputs are collected before execution. Ambiguous names produce a selection. Run IDs refer to existing executions and never cause a new run. `status` reads once; `follow` monitors in the active conversation and pauses for your questions.

`run` opens setup, reviews the exact preparation, and starts only after acceptance. Publishing and activation remain separate. Invoking cancel or delete without an identified target prompts selection; an explicit authorized request for an exact target does not need redundant confirmation. Deleting a run does not delete its workflow or workspace.

Natural-language requests remain supported. `loomex-workflows` routes help and requests spanning multiple operations. All focused skills share packaged guidance for identity, authorization, pagination and idempotent recovery. No backend endpoints, runner policies or MCP tool schemas change in this release.

## Maintenance and verification

Keep operational invariants in `skills/loomex-workflows/references/`; entry skills own their task-specific route. Automatic invocation remains enabled by default. Every new skill has picker metadata and a default prompt. Integrity tests check packaged relative links and live tool names; independent fixture-based evaluation checks behavior. These tests do not prove model compliance on every host.

Release packaging includes the complete skills tree. After updating the plugin, reopen the skill picker or start a fresh task if commands have not appeared. Do not create deprecated custom prompt files as an alternate command installation.

Sources: [official skills guidance](https://learn.chatgpt.com/docs/build-skills), [custom prompt deprecation](https://learn.chatgpt.com/docs/custom-prompts).
