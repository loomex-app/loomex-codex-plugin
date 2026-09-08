---
name: loomex-run
description: Collect inputs, prepare, explicitly start, and follow a new Loomex workflow run; never resumes by starting again.
---

# Run Loomex Workflow

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.

Resolve the requested workflow and version. Read [execution guidance](../loomex-workflows/references/execution.md) and follow setup, missing-input collection, exact preparation and review. Preserve workspace, model/provider and reasoning preferences, asking only for unresolved required choices. After accepted Start, read [monitoring guidance](../loomex-workflows/references/monitoring.md) and follow that exact run. If an existing run ID or monitor_existing_run continuation was supplied, use monitoring directly instead of creating a run. For preparation-only or no-monitor requests honor that narrower scope.
