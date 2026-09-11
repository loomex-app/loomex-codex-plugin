---
name: loomex-browse
description: Browse or search available Loomex workflows visually, without starting one.
---

# Browse Loomex Workflows

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.
Read [the visual delivery contract](../loomex-workflows/references/visual-delivery.md) when presenting the catalog or using its headless fallback.

Call `loomex_workflows_view`, preserving the user's search and organization and always passing the actual local Codex task cwd as `taskContext.cwd`. Pass `workspacePath` as well only for an explicit user override; it does not replace task context. Use `loomex_workflows_list` for a headless host, when only data is requested, or when the active task cwd is unavailable. Follow cursor pages as requested; do not present the current page as the complete catalog. Show names/descriptions and relevant state rather than an unnecessary UUID list. Opening or searching the catalog never prepares or starts execution.
