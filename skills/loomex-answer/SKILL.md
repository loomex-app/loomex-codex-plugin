---
name: loomex-answer
description: Open and answer a pending Loomex run question or approval, then resume that same run after accepted submission.
---

# Answer Loomex Questions

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.
Read [the visual delivery contract](../loomex-workflows/references/visual-delivery.md) for the channel-specific interaction path.

Resolve the supplied request or run. With a run ID, read `loomex_run_get` for its pending request and follow its fresh `nextAction`; use `loomex_interactions_list` with the run filter when selection among requests is necessary. If neither identity is supplied, offer scoped pending-request selection. Never select an arbitrary request. Read [interaction guidance](../loomex-workflows/references/interactions.md). A bare invocation opens/asks; it does not submit defaults. For an authoritative `answerChannel: "chat"` long-text request, collect the answer in chat through `loomex_interaction_get`; for `answerChannel: "ui"`, use the one focused view. After verified acceptance, invoke `$loomex-follow` for the same run unless answer-only was requested. Treat the accepted receipt as a trigger for that fresh read, never as proof of the next run state.
