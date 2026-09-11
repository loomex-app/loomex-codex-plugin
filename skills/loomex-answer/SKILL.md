---
name: loomex-answer
description: Open and answer a pending Loomex run question or approval, then resume that same run after accepted submission.
---

# Answer Loomex Questions

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.
Read [the visual delivery contract](../loomex-workflows/references/visual-delivery.md) for the channel-specific interaction path.

Resolve the supplied request or run. With a run ID, read `loomex_run_get` for its pending request and follow its fresh `nextAction`; use `loomex_interactions_list` with the run filter when selection among requests is necessary. If neither identity is supplied, offer scoped pending-request selection. Never select an arbitrary request. Read [interaction guidance](../loomex-workflows/references/interactions.md). A bare invocation opens/asks; it does not submit defaults. For an authoritative `answerChannel: "chat"` long-text request, collect the answer in chat through `loomex_interaction_get`; for `answerChannel: "ui"`, use the one focused view. After verified acceptance, invoke `$loomex-follow` for the same run unless answer-only was requested. Treat the accepted receipt as a trigger for that fresh read, never as proof of the next run state.

Submit a typed answer by exact request ID and schema digest. Never send the question's `inputSpec.inputType` as a response routing category.

## Preserve the workflow conversation

An unfinished followed run remains the context when the user supplies an idea, requirements, or review feedback in a later turn. Fresh-read that exact run before treating the message as standalone implementation work. For a pending chat question, read its current schema and submit the clear direct answer. If the question is not ready, retain the message in chat and continue following; do not build the idea yourself or invent a request ID. Research requests remain research, not submitted answers. Leave this flow only when the user explicitly changes the task. Existing files and provider completion do not satisfy workflow acceptance: follow through its review interaction and retrieve the authoritative terminal result.
