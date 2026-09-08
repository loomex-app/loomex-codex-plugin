---
name: loomex-browse
description: Browse or search available Loomex workflows visually, without starting one.
---

# Browse Loomex Workflows

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.

Call `loomex_workflows_view`, preserving the user's search and organization and passing the actual local Codex task cwd as `taskContext.cwd` when available. Pass `workspacePath` as well only for an explicit user override. Use `loomex_workflows_list` for a headless host or when only data is requested. Follow cursor pages as requested; do not present the current page as the complete catalog. Show names/descriptions and relevant state rather than an unnecessary UUID list. Opening or searching the catalog never prepares or starts execution.
