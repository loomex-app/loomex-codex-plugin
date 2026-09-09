---
name: loomex-edit
description: Edit an existing Loomex workflow through a reviewed authoring session or an explicit draft change.
---

# Edit Loomex Workflow

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.
Read [the visual delivery contract](../loomex-workflows/references/visual-delivery.md) for the exact authoring preparation card and payload handoff.

Resolve the existing workflow and read its current draft/version. Read [authoring guidance](../loomex-workflows/references/authoring.md) and use the editor lifecycle for conversational edits, defaulting editor preparation to the actual local Codex task cwd when the user did not choose another workspace. Preserve untouched behavior and concurrent-version checks. Preview the final update before applying it. Return the applied draft changes and validation result; do not silently publish or activate.
