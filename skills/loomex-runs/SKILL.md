---
name: loomex-runs
description: List existing Loomex runs with optional workflow or status filters; does not monitor or start them.
---

# List Loomex Runs

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.

Call `loomex_runs_list` in the selected organization, resolving a workflow name only if a workflow filter was requested. Preserve status filters and consume requested cursor pages. Present useful workflow names, status and time, keeping stable IDs available for follow-up selection. Do not turn a listing into continuous monitoring, open many status cards, or start another run.
