---
name: loomex-publish
description: Validate and publish a Loomex workflow draft, or activate a specifically selected published version.
---

# Publish Loomex Workflow

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.

Choose the requested operation before inspecting a draft:

- **Activate an existing published version only:** Resolve the workflow and requested version with `loomex_workflow_get`. Verify that this immutable published version belongs to the selected workflow. Use its versionId with `loomex_workflow_activate` under the user's explicit activation authorization. Do not validate, publish or modify an unrelated current draft. Report the active version.
- **Publish a draft:** Read the current draft with `loomex_workflow_get` and validate that exact definition with `loomex_workflow_validate`. If validation fails, report actionable issues without publishing or silently rewriting it. Review the intended publication and preserve authorization already supplied for that exact operation. Call `loomex_workflow_publish` with expectedVersion from the authoritative draft when available. On conflict, read/review the new draft rather than overwriting it. Publication alone does not activate.
- **Publish and activate:** Complete the publication branch, verify the returned published version belongs to the selected workflow, then activate that exact version only when activation was explicitly requested. Report publication and activation outcomes separately; an activation failure does not justify republishing an accepted version.
