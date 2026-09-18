---
name: loomex-create
description: Create or edit a Loomex workflow through guided authoring or an explicitly supplied definition.
---

# Create Loomex Workflow

Read [the operation contract](references/common.md) before using tools.
Read [the visual delivery contract](references/visual-delivery.md) for the exact authoring preparation card and payload handoff.

Read [authoring guidance](references/authoring.md). Collect the idea and necessary authoring context, defaulting builder preparation to the actual local Codex task cwd when the user did not choose another workspace. Preserve any supplied model/provider preferences. Use the builder lifecycle for conversational creation; direct create/update only for a requested definition-based operation. For an existing workflow edit, resolve its current version and use the same reviewed editor lifecycle. Return a validated draft and the actual workflow/session identifiers. Publishing, activation and execution require their own requested scope. Keep the authoring flow in one preparation/review surface and do not duplicate its card content in chat.
