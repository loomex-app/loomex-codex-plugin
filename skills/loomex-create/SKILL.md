---
name: loomex-create
description: Create a Loomex workflow from an idea through guided authoring or an explicitly supplied definition.
---

# Create Loomex Workflow

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.
Read [the visual delivery contract](../loomex-workflows/references/visual-delivery.md) for the exact authoring preparation card and payload handoff.

Read [authoring guidance](../loomex-workflows/references/authoring.md). Collect the idea and necessary authoring context, defaulting builder preparation to the actual local Codex task cwd when the user did not choose another workspace. Preserve any supplied model/provider preferences. Use the builder lifecycle for conversational creation; direct create/update only for a requested definition-based operation. Return a validated draft and the actual workflow/session identifiers. Publishing, activation and execution require their own requested scope.
