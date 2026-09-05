---
name: loomex-workflows
description: Use the local Loomex runner to discover, author, validate, publish, execute, monitor, interact with, and retrieve artifacts from Loomex workflows.
---

# Loomex workflows

Use Loomex MCP tools when the user wants to work with Loomex workflows or local
Loomex runs. Start with `loomex_readiness`. If setup is incomplete, use the
focused authentication and organization tools and explain the next concrete
step. Never request, collect, or transmit a credential or secret value.

For authoring, inspect the builder catalog before constructing a definition.
Prefer the builder or editor lifecycle when the user is developing a workflow
conversationally. Prepare builder and editor sessions, present the exact
workspace/provider/`host_user/v1` binding, and commit only after the user accepts
it. Pass the preparation ID, digest, and confirmation key unchanged. Validate
before publishing. Secret input mappings are not a supported feature in version
0.1.0; report the validation error instead of treating a secret reference as an
ordinary value.

Finalize an editor with `confirm: false` to preview its exact proposed update.
Use `confirm: true` only after the user approves applying that preview.

Before running, ensure the canonical workspace is durably granted. Call
`loomex_run_prepare` and present its workflow/version, workspace, organization,
provider configuration, `host_user/v1` execution policy, and unlimited product
limits. `host_user/v1` lets provider processes act with the signed-in macOS
user's authority; the workspace grant records the user's selected root and is
not sandbox containment. Call `loomex_run_commit` only after the user accepts
that exact prepared binding. Pass back the returned preparation ID, binding
digest, and confirmation key unchanged.

Generate one UUID idempotency key per intended mutation and retain it until the
result is definitive. If a tool returns `NETWORK_AMBIGUOUS`, retry the same
mutation only with the same key. Never blindly repeat a write with a fresh key.

Runs can be unbounded in duration, output, concurrency, and aggregate artifact
size. Use `loomex_run_wait`, paged events, paged results, and artifact lists
rather than assuming a terminal result fits in one response. Surface typed
human interactions promptly and answer them only from the user's stated choice.
Treat run deletion and workspace revocation as destructive actions.
