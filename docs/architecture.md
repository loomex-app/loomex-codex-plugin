# Plugin architecture

The Loomex plugin is a TypeScript stdio MCP server for Codex desktop and Codex CLI. It is a local presentation and protocol adapter. It does not authenticate to Loomex, call the Loomex backend, invoke provider CLIs, or execute workflows. Those responsibilities belong to the per-user Rust runner and the canonical backend.

## Topology and ownership

```text
Codex host
  | stdio MCP
  v
Loomex TypeScript plugin
  | owner-checked Unix socket, loomex.local-control/v2
  v
Loomex Rust runner
  | signed HTTPS requests and durable job delivery
  v
Canonical Loomex backend
  | leased argv jobs
  v
Codex / Claude / Gemini CLI and command processes
```

The backend remains authoritative for identities, organizations, workflow graphs and immutable versions, prepared execution bindings, executions, interactions, events, leases, artifacts, retention, and deletion policy. The runner owns local credentials, workspace grants, provider discovery, execution, process control, recovery journals, output spools, artifact transfer, and the local socket. The plugin owns MCP discovery, strict tool inputs and outputs, safe text projections, and optional MCP Apps resources.

## Trust boundaries

| Boundary | Enforcement in 0.2.4 |
| --- | --- |
| Codex host to plugin | MCP SDK validates the registered strict Zod input schema. Unknown fields fail before local RPC. Workflow definitions containing an object with `source: "secret"` are rejected. |
| Plugin to runner | The plugin requires an absolute state directory, then checks that the socket parent is an owner-only directory and the socket is an owner-only Unix socket owned by the effective UID. The runner independently checks the peer UID. |
| Runner to backend | The runner alone reads Loomex credentials, signs scoped HTTP requests, selects an enrolled organization credential, and exposes only catalogued backend operations locally. |
| Backend to host execution | A backend job is insufficient by itself. The runner requires the matching locally persisted prepare/commit authorization, organization, installation, workspace identity, binding digest, provider snapshot, and `host_user/v1` policy before spawn. |
| Optional UI to tool | The UI calls the same registered MCP tools through the portable MCP Apps bridge. UI copy, annotations, and buttons are presentation; tool, runner, and backend checks remain authoritative. |

The local socket is credential-free in the sense that its request and result contract contains no Loomex bearer tokens, refresh tokens, signing keys, or provider credentials. It is still a privileged owner-local control channel: any same-UID process that can reach an owner-only socket can request catalogued operations. The prepare/commit binding and backend authorization remain required for execution.

## Local protocol and contract pin

The wire protocol is `loomex.local-control/v2`. The runner project owns the canonical files in `runner/contracts/`:

- `local-control.schema.json` defines the newline-delimited request and response envelopes and the 1,048,576-byte frame limit.
- `method-catalog.json` defines method inputs, result projections, mutation flags, destructive flags, and retry semantics.

The plugin vendors exact copies in `contracts/` and records their SHA-256 digests in `contracts/contract-pin.json`. Contract export `0.1.2` keeps `loomex.local-control/v2` and adds fixed-text `validationIssueVersion: "v1"` issues behind the negotiated `error.validation-issues/v1` capability. A pre-extension client receives the original four-field error shape. The updated plugin requires the capability before sending an action, so an older runner fails negotiation with `COMPATIBILITY_ERROR`. The catalog contains 48 runner methods. The plugin exposes 46 as focused `loomex_*` MCP tools. Internal `protocol.negotiate` verifies required capabilities on each action connection before sending the action; `daemon.drain` remains reserved for runner installation and operations. Neither internal method appears as an MCP tool. Tests compare the exposed methods and top-level input/output fields to the pinned catalog and reject a hash mismatch.

The checked-in build script packages the plugin's vendored copies. It does not fetch or regenerate contracts and does not currently copy them from `../runner` during packaging. A protocol change therefore requires an explicit synchronized update and pin before either product is released. Product version `0.2.4` and protocol version `v2` are separate version axes.

## MCP tools and results

The catalog covers readiness, authentication, organization selection, workspace grants, workflow authoring and publication, builder and editor sessions, preparation and commit, run monitoring, complete results, events, interactions, cancellation, deletion, artifacts, and large-response paging.

Every socket connection first negotiates `loomex.local-control/v2`, the complete public method capability set, the four semantic capabilities, and the exact frame bound. The runner version in that result is informational. The action is sent on that same connection only after the negotiation succeeds, and negotiation state is never cached across connections. A different runner release remains compatible when its protocol, capabilities, and frame bound match.

Every mutation takes a UUID idempotency key. The plugin sends it once and never automatically retries it. If the connection fails or the response is not definitive after a mutation may have been sent, it returns `NETWORK_AMBIGUOUS` with the retained key. Reconciliation must reuse that key for the same intended change. A nonmutating call retries exactly once only after a classified transport failure, opening a fresh connection and negotiating again within the original time budget. Valid runner errors and invalid responses are not retried.

Builder, editor, and run execution have separate prepare and commit tools. Prepare returns a canonical binding and a runner-generated confirmation key. Commit must present the unchanged preparation ID, binding digest, confirmation key, and a new logical mutation key. The server instructions require review of the exact workspace, organization, provider configuration, and `host_user/v1` authority before commit.

Runner results are parsed through method-specific strict schemas. Malformed envelopes, mismatched request IDs, unknown top-level result fields, oversized frames, and trailing data become safe typed failures. MCP `structuredContent` carries the validated result. The companion text content includes only stable identifiers, state, status, cursors, response references, and checksums selected to a bounded depth. Runner-provided error messages are replaced with plugin-owned safe messages.

Results too large for one local frame become immutable spool references. `responses.read` returns base64 byte pages of at most 262,144 bytes plus offset and whole-response checksum; `responses.delete` explicitly discards a reference. Finite frames and pages are transport controls, not total output limits.

## Headless behavior and optional UI

All lifecycle operations are registered MCP tools and remain usable when a host does not render resources. The plugin registers four versioned optional resources for authoring, prepare review, monitoring, and interactions. They are four modes of one bundled HTML template and advertise only the inline display mode.

The resources use `ui/initialize`, tool result notifications, and `tools/call` through `window.parent.postMessage`. They do not depend on `window.openai`. The embedded CSP denies all external connections, resources, frames, forms, and images; no HTTP URL is present in the resource. Sensitive-looking fields such as tokens, credentials, authorization material, and confirmation keys are masked in the display. If the portable bridge does not initialize within three seconds, the resource reports that headless tools remain available.

The UI is a convenience surface, not proof of user authorization. In particular, the runner's persisted confirmation binding controls whether a prepared operation can start.

For interaction and authoring requests, `humanRequest.inputSpec` owns question copy and control selection. The UI supports short text, long text, calendar dates, bounded integer ratings, explicit Yes/No booleans, one-choice radios, and multi-choice checkboxes. Mixed batches return stable `questionId` values. Selecting Other reveals a required text field. The UI validates without inventing a default answer, retains the draft after a runner error, and sends only `value`, `values`, `otherText`, and batch `questionId` answer fields. The trusted response schema remains available for custom schemas without an input spec and for headless clients. An ambiguous mutation freezes its entire argument object and answer controls. Refresh reconciles authoritative state; a still-pending request may retry the frozen arguments, while a resolved request removes the form.

## Execution policy and excluded features

The plugin only describes and transports `host_user/v1` work. Under that policy, a runner child has the full permissions of the signed-in macOS user. A workspace grant binds an exact root for working-directory validation and artifact references; it is not a filesystem or network sandbox. Provider and command processes may affect other host paths, services, and external systems available to that user.

The 0.2.4 policy has no product deadline, global or per-workspace concurrency cap, cumulative stdout/stderr/provider-output cap, artifact count cap, or artifact byte cap. Pagination and chunk sizes remain bounded so work can resume safely. The plugin adds no secret-input model, secret prompt, secret store, or provider-login flow. Provider authentication remains in each provider CLI's host-owned store.

## Current decisions and release status

The current authority is the clean-slate plan, especially the [baseline](../../planning/plugin-runner-clean-slate/README.md), [requirements and acceptance matrix](../../planning/plugin-runner-clean-slate/requirements-capability-acceptance.md), [runtime contract](../../planning/plugin-runner-clean-slate/runtime-contract.md), [authentication contract](../../planning/plugin-runner-clean-slate/auth-contract.md), and [superseded decision index](../../planning/plugin-runner-clean-slate/superseded-decisions-index.md). Historical ADRs remain evidence only to the extent carried forward by that index.

This document describes current source behavior and intended trust boundaries. It does not establish production readiness. Apple signing and notarization, an actually signed installed LaunchAgent lifecycle, deployed backend migrations, real Desktop UI behavior, the three-provider matrix, and confirmation of historical remote credential revocation remain open in the [release gates](../../planning/plugin-runner-clean-slate/release-gates.md).
