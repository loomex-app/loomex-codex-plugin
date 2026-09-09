---
name: loomex-follow
description: Follow one existing Loomex run, including accepted-answer continuations, until human input, completion, user stop, or an actionable error.
---

# Follow Loomex Run

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.
Read [the visual delivery contract](../loomex-workflows/references/visual-delivery.md) when showing a pending interaction card or falling back to headless reads.

Resolve the existing run, then read [monitoring guidance](../loomex-workflows/references/monitoring.md). For an accepted-answer continuation, discard the prior card/request state and call `loomex_run_get` first for the exact receipt run; acceptance is a trigger to verify, not authority over the run's next state. Follow the returned live `nextAction` through serial bounded waits and event paging. On a pending human request, read [interaction guidance](../loomex-workflows/references/interactions.md), show its form once and pause for the user. Do not let a same-request display deduplication hide a newly pending request with another request ID. Stop chat monitoring when asked; cancel the execution only if explicitly requested. Never create a run to recover monitoring or claim monitoring persists in an inactive chat.
