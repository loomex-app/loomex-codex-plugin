---
name: loomex-delete-run
description: Delete one selected Loomex run record and its owned retained data; does not delete workflows or workspace files.
---

# Delete Loomex Run

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.

Resolve the exact run and read `loomex_run_get`. Establish the deletion scope before mutation and preserve the user's explicit authorization for that identified target. If active, do not silently cancel it to make deletion possible; explain the separate cancellation requirement. Call `loomex_run_delete` only for the selected terminal run. Report actual deletion/retention outcome, not that all bytes or audit records vanished. Backend retention rules preserve uploaded inputs, shared referenced blobs and user workspace files. Do not delete the workflow, grants or local workspace. Reconcile ambiguous deletion through reads using the same mutation key, never select a replacement run.

Apply [recovery schedule cleanup](../loomex-workflows/references/recovery.md) to any matching task/run monitor. A stop-following request removes or pauses that recovery without canceling execution. On confirmed terminal/deleted state remove the matching recovery; an accepted cancellation request alone is not a terminal result. Preserve unrelated schedules.
