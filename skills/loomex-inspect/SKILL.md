---
name: loomex-inspect
description: Inspect a selected Loomex workflow and its version, inputs, steps, and providers; does not start it.
---

# Inspect Loomex Workflow

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.

Resolve the workflow and requested immutable version. Use `loomex_workflow_view` for a visual inspection, passing the actual local Codex task cwd as `taskContext.cwd` when available and an explicit user workspace as `workspacePath`; this preserves workspace context if the user later chooses Prepare. Use `loomex_workflow_get` headlessly. Show important inputs, behavior, provider configuration and publication/activation state from authoritative data. Read spooled details completely when needed. Do not prepare or run it unless separately requested.
