---
name: loomex-follow
description: Follow one existing Loomex run, including accepted-answer continuations, until human input, completion, user stop, or an actionable error.
---

# Follow Loomex Run

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.
Read [the visual delivery contract](../loomex-workflows/references/visual-delivery.md) when handling a pending interaction.

Resolve the existing run, then read [monitoring guidance](../loomex-workflows/references/monitoring.md). For an accepted-answer continuation, discard the prior card/request state and call `loomex_run_get` first for the exact receipt run; acceptance is a trigger to verify, not authority over the run's next state. Drain every required event page before advancing its cursor. For an active explicit follow, establish host scheduling capability and current-task binding, then apply durable registration state: create only when it is `not_attempted`, reconcile a known record for `attempt_in_flight` or `registered`, and keep `ambiguous` or unknown history live-only without creating a replacement. A host `automation_update` view takes the actual schema's ID only; verify the returned record before serial bounded waits. On a pending human request, read [interaction guidance](../loomex-workflows/references/interactions.md) and branch by its authoritative answer channel: handle chat long-text questions headlessly in chat, and show a UI-channel form once. Do not let same-request deduplication hide a newly pending request with another request ID. Stop chat monitoring when asked; cancel the execution only if explicitly requested. Never create a run to recover monitoring or claim monitoring persists in an inactive chat.

For explicit follow requests, also read [scheduled recovery guidance](../loomex-workflows/references/recovery.md). A same-task heartbeat is a best-effort recovery wake-up for this exact run; it does not replace the live chat loop, establish exclusive monitoring, or authorize a Loomex mutation.

When the installed plugin's lifecycle hook is trusted, Codex can send the exact
native session anchor and completed tool-use identifiers to the runner. This is
runner-owned continuity evidence, not a new follow request or execution
authority. Do not manufacture a `$loomex-follow` anchor, session ID, or tool
acknowledgement in chat; only an exact user prompt and native hook receipt may
activate that path. Continue to fresh-read the run and follow its authoritative
`nextAction` as usual.

## Live-turn completion boundary

For an explicit follow, an active-node status is commentary, never a final answer. After each quiet wait or progress update, execute the fresh nextAction in this same turn. Stop only for required human input, retrieved terminal results, an explicit user stop, or an actionable error. Creating a recovery heartbeat does not satisfy the live-follow request. Host interruption can still end a turn; a verified same-task heartbeat is recovery for that case, not proof of uninterrupted waiting.

## Preserve the workflow conversation

An unfinished followed run remains the context when the user supplies an idea, requirements, or review feedback in a later turn. Fresh-read that exact run before treating the message as standalone implementation work. For a pending chat question, read its current schema and submit the clear direct answer. If the question is not ready, retain the message in chat and continue following; do not build the idea yourself or invent a request ID. Research requests remain research, not submitted answers. Leave this flow only when the user explicitly changes the task. Existing files and provider completion do not satisfy workflow acceptance: follow through its review interaction and retrieve the authoritative terminal result.
