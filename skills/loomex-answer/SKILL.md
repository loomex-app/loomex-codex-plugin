---
name: loomex-answer
description: Open and answer a pending Loomex run question or approval, then resume that same run after accepted submission.
---

# Answer Loomex Questions

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.

Resolve the supplied request or run. With a run ID, read `loomex_run_get` for its pending request; use `loomex_interactions_list` with the run filter when selection among requests is necessary. If neither identity is supplied, offer scoped pending-request selection. Never select an arbitrary request. Read [interaction guidance](../loomex-workflows/references/interactions.md), fetch the exact request and collect explicit typed answers or the approval decision. A bare invocation opens/asks; it does not submit defaults. After verified acceptance continue that run unless answer-only was requested.
