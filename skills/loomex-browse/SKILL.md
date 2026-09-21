---
name: loomex-browse
description: Browse Loomex workflows and handle selected workflow details, runs, edits, publishing, and activation.
---

# Browse Loomex Workflows

Read [the operation contract](references/common.md) before using tools.
Read [the visual delivery contract](references/visual-delivery.md) when presenting the catalog or using its headless fallback.

Call `loomex_workflows_view`, preserving the user's search and organization and always passing the actual local Codex task cwd as `taskContext.cwd`. Pass `workspacePath` as well only for an explicit user override; it does not replace task context. Use `loomex_workflows_list` for a headless host, when only data is requested, or when the active task cwd is unavailable. Follow cursor pages as requested; do not present the current page as the complete catalog. Show names/descriptions and relevant state rather than an unnecessary UUID list. Opening or searching the catalog never prepares or starts execution.

This skill owns workflow discovery and the selected workflow detail view. When the user asks for details, resolve the selected workflow and version, then call `loomex_workflow_view` with the same task context or `loomex_workflow_get` headlessly. When the user asks to edit an existing workflow, use the active-chat draft route in [authoring guidance](references/authoring.md): preserve untouched behavior, read the current workflow again for a fresh expected version, validate the candidate, and save it with `loomex_workflow_update`. When the user asks to run a workflow, use [execution guidance](references/execution.md) and the exact setup and preparation flow. When the user asks to publish, validate and publish the selected draft with `loomex_workflow_publish`; publishing makes that immutable version current for future runs. Use `loomex_workflow_activate` only to explicitly restore a historical published version. A detail, edit, publish, activation or run request must resolve the target before mutation and must not create a second card or repeat card content in chat.
