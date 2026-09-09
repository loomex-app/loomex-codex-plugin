---
name: loomex-cancel
description: Cancel one explicitly selected Loomex execution; distinct from stopping chat monitoring.
---

# Cancel Loomex Run

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.

Resolve the exact run and read `loomex_run_get`. An explicit request to cancel this identified run supplies authorization; a bare command with no target requires selection. If the user only wants to stop following, stop monitoring without cancellation. For actual cancellation call `loomex_run_cancel` with the supplied reason, or the truthful nonempty fallback `User requested cancellation.` when none was provided, and a retained idempotency key. Report cancellation requested, managed execution stopped, and indeterminate effects separately from the authoritative result. Use read-only bounded follow-up if needed to establish cancellation outcome; do not treat lease expiry or a missing leader as proof that every child or external effect stopped. Terminal runs need no repeated cancellation.

Apply [recovery schedule cleanup](../loomex-workflows/references/recovery.md) to any matching task/run monitor. A stop-following request removes or pauses that recovery without canceling execution. On confirmed terminal/deleted state remove the matching recovery; an accepted cancellation request alone is not a terminal result. Preserve unrelated schedules.
