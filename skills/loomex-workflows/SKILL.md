---
name: loomex-workflows
description: Help with Loomex capabilities or coordinate a request spanning multiple workflow operations; focused command skills cover individual actions.
---

# Loomex workflows

The runner executes; active chat turns monitor. Use the user's requested scope to choose the focused entry below. Read only the relevant skill and its linked references. These are explicit skill entry points as well as natural-language workflows, not native slash commands or a shell parser.

- [Connect Loomex](../loomex-connect/SKILL.md): Check Loomex readiness and sign-in.
- [Loomex Workspaces](../loomex-workspaces/SKILL.md): Manage Loomex workspace access.
- [Browse Loomex Workflows](../loomex-browse/SKILL.md): Browse and search available workflows.
- [Inspect Loomex Workflow](../loomex-inspect/SKILL.md): Inspect workflow inputs and behavior.
- [Create Loomex Workflow](../loomex-create/SKILL.md): Build a workflow from your idea.
- [Edit Loomex Workflow](../loomex-edit/SKILL.md): Review and edit an existing workflow.
- [Publish Loomex Workflow](../loomex-publish/SKILL.md): Validate and publish workflow versions.
- [Run Loomex Workflow](../loomex-run/SKILL.md): Prepare and start a workflow safely.
- [List Loomex Runs](../loomex-runs/SKILL.md): Find existing workflow executions.
- [Loomex Run Status](../loomex-status/SKILL.md): Check one run without continuous polling.
- [Follow Loomex Run](../loomex-follow/SKILL.md): Follow a run and surface its next question.
- [Answer Loomex Questions](../loomex-answer/SKILL.md): Answer a pending question or approval.
- [Loomex Run Results](../loomex-results/SKILL.md): Read run results and download artifacts.
- [Cancel Loomex Run](../loomex-cancel/SKILL.md): Cancel the selected workflow execution.
- [Delete Loomex Run](../loomex-delete-run/SKILL.md): Delete a selected run and owned retained data.

For `loomex/chat-continuation/v2` with intent `monitor_existing_run`, its
separate explicit `$loomex-follow ${runId}` message, or an older v1 handoff
with an exact run ID, read [Follow Loomex Run](../loomex-follow/SKILL.md) and
use that run ID even if the host's message is generic. V2 is factual context
with `state: "requires_fresh_read"`; its compact accepted receipt requires a
fresh `loomex_run_get`, and the snapshot's live `nextAction`, rather than prior
displayed/pending request memory, controls continuation. Never answer such a
handoff with a stale workflow list or start a duplicate run.

For multi-operation requests, preserve the requested sequence and existing authorization while honoring each operation's input and review boundaries. A request to author does not by itself authorize publication or execution. Missing information should lead to a focused question, not guessed inputs. Shared scope and mutation rules are in [the operation contract](references/common.md).
