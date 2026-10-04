---
name: loomex-create
description: Create or edit a Loomex workflow through its hidden core authoring execution in the current chat; retain explicit definition imports as low-level capabilities.
---

# Create Loomex Workflow

Read [the operation contract](references/common.md) before using tools.
Read [the visual delivery contract](references/visual-delivery.md) for the saved-workflow summary view and its headless fallback.

Read [authoring guidance](references/authoring.md). New conversational creation calls `loomex_builder_start` with the user's original prompt and one retained key. Conversational edits use `loomex_editor_start` with the exact target, requested changes and fresh draft baseline. These tools start real hidden core workflow executions; follow their returned execution through the existing run and interaction tools in this same chat. Complete verified current-chat agent tasks, present typed human questions, and keep following until human input, an actionable observation failure or the complete terminal result. Do not construct and save a definition directly to replace the internal graph. A bare create request needs its idea; a bound Edit click with no changes needs the requested change. Preserve the original prompt instead of asking for it again. After authoritative accepted draft saving, show one compact draft summary. Publishing, activation and execution require their own requested scope.
