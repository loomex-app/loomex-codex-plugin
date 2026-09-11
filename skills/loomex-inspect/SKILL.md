---
name: loomex-inspect
description: Inspect a selected Loomex workflow and its version, inputs, steps, and providers; does not start it.
---

# Inspect Loomex Workflow

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.
Read [the visual delivery contract](../loomex-workflows/references/visual-delivery.md) when presenting workflow details or using its headless fallback.

Resolve the workflow and requested immutable version. Use `loomex_workflow_view` for a visual inspection only with the actual local Codex task cwd in `taskContext.cwd`; pass an explicit user workspace as `workspacePath` while retaining task context. This preserves the calling task boundary if the user later chooses Prepare. Use `loomex_workflow_get` headlessly when the task cwd is unavailable. Show important inputs, behavior, provider configuration and publication/activation state from authoritative data. Read spooled details completely when needed. Do not prepare or run it unless separately requested.
