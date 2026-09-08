---
name: loomex-follow
description: Monitor one existing Loomex run in chat until human input, completion, user stop, or an actionable error.
---

# Follow Loomex Run

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.

Resolve the existing run, then read [monitoring guidance](../loomex-workflows/references/monitoring.md). Use the exact run identity through serial bounded waits and event paging. On a pending human request, read [interaction guidance](../loomex-workflows/references/interactions.md), show its form once and pause for the user. Stop chat monitoring when asked; cancel the execution only if explicitly requested. Never create a run to recover monitoring or claim monitoring persists in an inactive chat.
