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

The backend remains authoritative for identities, organizations, workflow graphs and immutable versions, prepared execution bindings, executions, interactions, events, leases, artifacts, retention, and deletion policy. The runner owns browser device authentication, local credentials, the runner-wide selected organization, workspace grants, provider discovery, execution, process control, recovery journals, output spools, artifact transfer, and the local socket. The plugin owns MCP discovery, strict tool inputs and outputs, safe text projections, optional local task-context routing, and optional MCP Apps resources.

## Trust boundaries

| Boundary | Enforcement |
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

The plugin vendors exact copies in `contracts/` and records their SHA-256 digests in `contracts/contract-pin.json`. Contract export `0.1.2` keeps `loomex.local-control/v2` and adds fixed-text `validationIssueVersion: "v1"` issues behind the negotiated `error.validation-issues/v1` capability. A pre-extension client receives the original four-field error shape. The updated plugin requires the capability before sending an action, so an older runner fails negotiation with `COMPATIBILITY_ERROR`. The catalog contains 48 runner methods. The plugin exposes 46 public runner methods through 51 focused `loomex_*` MCP tools; deliberate view tools and run setup reuse existing read-only methods. Internal `protocol.negotiate` verifies required capabilities on each action connection before sending the action; `daemon.drain` remains reserved for runner installation and operations. Neither internal method appears as an MCP tool. Tests compare the exposed methods and top-level input/output fields to the pinned catalog and reject a hash mismatch.

The checked-in build script packages the plugin's vendored copies. It does not fetch or regenerate contracts and does not currently copy them from `../runner` during packaging. A protocol change therefore requires an explicit synchronized update and pin before either product is released. Product versions and protocol version `v2` are separate version axes.

## MCP tools and results

The catalog covers readiness, connection/authentication, organization selection, workspace grants, workflow authoring and publication, builder and editor sessions, preparation and commit, run monitoring, complete results, events, interactions, cancellation, deletion, artifacts, and large-response paging. The intended connection surface names are `loomex_connection_get` for the headless state read and `loomex_connection_view` for the focused interactive view; the runner and UI worker remain authoritative for their exact availability and result shape.

Every socket connection first negotiates `loomex.local-control/v2`, the complete public method capability set, the four semantic capabilities, and the exact frame bound. The runner version in that result is informational. The action is sent on that same connection only after the negotiation succeeds, and negotiation state is never cached across connections. A different runner release remains compatible when its protocol, capabilities, and frame bound match.

Every mutation takes a UUID idempotency key. The plugin sends it once and never automatically retries it. If the connection fails or the response is not definitive after a mutation may have been sent, it returns `NETWORK_AMBIGUOUS` with the retained key. Reconciliation must reuse that key for the same intended change. A nonmutating call retries exactly once only after a classified transport failure, opening a fresh connection and negotiating again within the original time budget. Valid runner errors and invalid responses are not retried.

Builder, editor, and run execution have separate prepare and commit tools. Prepare returns a canonical binding and a runner-generated confirmation key. Commit must present the unchanged preparation ID, binding digest, confirmation key, and a new logical mutation key. The server instructions require review of the exact workspace, organization, provider configuration, and `host_user/v1` authority before commit.

Runner results are parsed through method-specific strict schemas. Malformed envelopes, mismatched request IDs, unknown top-level result fields, oversized frames, and trailing data become safe typed failures. MCP `structuredContent` carries the validated result. A visual card must be able to render from `structuredContent` alone: component-only `_meta` may supplement presentation state but is never the sole source of a required projection. The companion text content includes only stable identifiers, state, status, cursors, response references, and checksums selected to a bounded depth. Runner-provided error messages are replaced with plugin-owned safe messages.

Results too large for one local frame become immutable spool references. `responses.read` returns base64 byte pages of at most 262,144 bytes plus offset and whole-response checksum; `responses.delete` explicitly discards a reference. Finite frames and pages are transport controls, not total output limits.

## Headless behavior and optional UI

All lifecycle operations are registered MCP tools and remain usable when a host does not render resources. The plugin registers eight stable optional resources for workflow browsing, run browsing, authoring, prepare review, monitoring, interactions, connection, and organizations. Every resource retains a headless tool path and shares one bundled HTML template; they advertise only the inline display mode.

The resources use `ui/initialize`, tool result notifications, and `tools/call` through `window.parent.postMessage`. They do not depend on `window.openai`. The embedded CSP denies all external connections, resources, frames, forms, and images; no HTTP URL is present in the resource. Sensitive-looking fields such as tokens, credentials, authorization material, and confirmation keys are masked in the display. Initialization uses the bridge's single five-second request deadline for every view. A result arriving before that handshake is queued, and a timeout or rejected handshake exits the skeleton with a local retry action. Retrying reconnects and reconciles the existing card; it never replays a workflow action.

The UI is a convenience surface, not proof of user authorization. In particular, the runner's persisted confirmation binding controls whether a prepared operation can start.

For interaction and authoring requests, `humanRequest.inputSpec` owns question copy and control selection. The UI supports short text, long text, calendar dates, bounded integer ratings, explicit Yes/No booleans, one-choice radios, and multi-choice checkboxes. Mixed batches return stable `questionId` values. Selecting Other reveals a required text field. The UI validates without inventing a default answer, retains the draft after a runner error, and sends only `value`, `values`, `otherText`, and batch `questionId` answer fields. The trusted response schema remains available for custom schemas without an input spec and for headless clients. An ambiguous mutation freezes its entire argument object and answer controls. Refresh reconciles authoritative state; a still-pending request may retry the frozen arguments, while a resolved request removes the form.

## Execution policy and excluded features

The plugin only describes and transports `host_user/v1` work. Under that policy, a runner child has the full permissions of the signed-in macOS user. A workspace grant binds an exact root for working-directory validation and artifact references; it is not a filesystem or network sandbox. Provider and command processes may affect other host paths, services, and external systems available to that user.

The current execution policy has no product deadline, global or per-workspace concurrency cap, cumulative stdout/stderr/provider-output cap, artifact count cap, or artifact byte cap. Pagination and chunk sizes remain bounded so work can resume safely. The plugin adds no secret-input model, secret prompt, secret store, or provider-login flow. Provider authentication remains in each provider CLI's host-owned store.

## Current decisions and release status

The current authority is the clean-slate plan, especially the [baseline](../../planning/plugin-runner-clean-slate/README.md), [requirements and acceptance matrix](../../planning/plugin-runner-clean-slate/requirements-capability-acceptance.md), [runtime contract](../../planning/plugin-runner-clean-slate/runtime-contract.md), [authentication contract](../../planning/plugin-runner-clean-slate/auth-contract.md), and [superseded decision index](../../planning/plugin-runner-clean-slate/superseded-decisions-index.md). Historical ADRs remain evidence only to the extent carried forward by that index.

This document describes current source behavior and intended trust boundaries. It does not establish production readiness. Apple signing and notarization, an actually signed installed LaunchAgent lifecycle, deployed backend migrations, real Desktop UI behavior, the three-provider matrix, and confirmation of historical remote credential revocation remain open in the [release gates](../../planning/plugin-runner-clean-slate/release-gates.md).

Workflow discovery through `loomex_workflows_list` is headless; `loomex_workflows_view` deliberately opens the browser. Search and cursor navigation use read-only list calls; workflow details use `loomex_workflow_get`. Original query parameters are carried in result metadata for remounts. Workflow names and descriptions are rendered as text. Prepare run enters the integrated setup form using the read-only `loomex_run_setup` tool. `loomex_workflow_get` is a quiet data lookup; `loomex_workflow_view` explicitly renders details. The three view/setup tools require local-only `taskContext.cwd` from the calling Codex task and accept a user-selected `workspacePath` override only alongside it. The server validates those fields, removes them before local-control RPC, and returns them in `loomex/taskWorkspace` result metadata so browse, detail, refresh, pagination, and Prepare actions retain one task selection. Missing context fails input validation; the plugin never guesses from its process cwd, environment, earlier task state, saved view, or an iframe host API. The path remains a suggestion until the normal workspace grant and preparation checks return the canonical binding.

Both typed run requests and browser actions use setup to collect required workflow inputs before preparing. New workflow definitions keep workspace selection outside their input schema. The UI still reads legacy `settings.workspaceInputField` mappings and binds them to the runner-confirmed canonical workspace for old stored versions. Before enabling Start, the UI asks the runner to seal the exact reviewed preparation in one owner-scoped start-handoff reference and updates the current model context. The click approval is authoritative at the runner. The Start gesture then sends only that opaque reference through `ui/message`; chat first calls `loomex_run_start_handoff_get` and commits only when the runner reports approval. Failed reads lock actions until recovery succeeds.

Canonical UI addresses are content-addressed (`ui://loomex/authoring-<asset-revision>.html`, etc.) so a host cache cannot pair an updated MCP server with an older browser bundle. The revision incorporates the release version plus packaged HTML, design-system, and browser-code digests. Explicit compatibility templates serve only the former unversioned addresses and allowlisted cached 0.2.3–0.2.7 addresses, including `ui://loomex/connection.html` and `ui://loomex/authoring-0.2.3.html`. Unknown views/releases remain errors. Compatibility changes resource lookup only; it does not recover or authorize old preparation state.

Run and interaction text summaries use method-aware, namespaced projections. Routine workflow listings, run status/wait reads, and interaction reads use bounded projections in model-facing structured content, so accumulated node history and previous outputs do not enter the conversation on every poll. Complete event/result pages remain available from their focused headless reads; chat interaction projections preserve the exact singular question, response schema, answer channel, and schema digest required to answer. Visual tools put the canonical runner response only in component hydration metadata and expose bounded projections to the model. Execution status is read only from `data.execution`; runner connectivity cannot overwrite it. Pending request identifiers and bounded authored input-spec question previews support headless continuation. Progress distinguishes observed runner facts from reported user-facing detail: it reports only meaningful stage changes and never exposes private reasoning, traces, or invented percentages. Summaries exclude execution inputs, internal runner bindings, answers, prompts and arbitrary details.

Run execution belongs to the runner; monitoring belongs to an active chat turn. A one-off status request reads once. An explicit monitor request or accepted `monitor_existing_run` continuation reads the exact execution and follows serial, bounded 30-second waits. Event pages drain from their last returned sequence before advancing to the global cursor. Invalid identities or inconsistent projections stop continuation. Normalized provider activity is persisted as an event and wakes the backend wait, but the runner coalesces a complete page containing only non-actionable `ai.progress.v1` activity into the same bounded wait. Dispatch recovery, user input, terminal state, non-progress events, paginated event pages and the deadline remain visible to chat.

`loomex_run_get`, `loomex_run_wait` and `loomex_interaction_get` are headless. Separate `loomex_run_view` and `loomex_interaction_view` render intentional snapshots/forms. A pending request's authoritative `answerChannel` selects the path: `chat` gives the exact singular long-text question, schema and revision to the headless read, while `ui` gives the focused form view. `unsupported` surfaces the authoritative compatibility error and pauses without a fallback form. The UI has no scheduled run reads or waits; explicit Refresh reads once. UI forms display one question at a time, retain drafts during navigation, and show an editable answer preview before final submission.

An approved Start or accepted human response has an owner-scoped continuation in the runner's presentation database, separate from disposable card state. Start approval registers the immutable handoff reference before returning; the chat reads that reference and commits only an approved handoff. Accepted answers register their runner-issued continuation receipt. `ContinuationDeliveryController` reads, reserves and settles a revision-fenced delivery attempt before and after the single standard `ui/message` call. The complete continuation context travels in that message as labelled fenced JSON; no separate model-context write is required. A failed presentation save cannot suppress delivery or repeat the accepted domain operation.

Codex owns the behavior of `ui/message`: it may send directly or present a follow-up dialog depending on host gesture state and policy. The plugin does not fabricate gestures or promise dialog-free sending. Known non-delivery can be continued explicitly; an ambiguous response remains uncertain and never automatically resends. Reopening reads the same durable delivery identity, including a previously accepted request that no longer appears in the current run snapshot. A host acknowledgement means receipt, not proof that a model turn ran or monitoring continues. Large accepted results are recovered from immutable response pages with checksum verification, never by repeating their originating mutation.

## Command entry points

Four focused plugin skills expose user goals through the same MCP tools: Connect, Browse, Create, and Runs. Contextual cards own selected-item actions, so their underlying MCP operations remain available without becoming separate picker commands. Package-local references own identity resolution, exact execution review, monitoring and human continuation. Skill invocation is model-guided; it does not bypass confirmation or act as a deterministic shell command. See [command guide](commands.md).


## Presentation and chat continuation

A pending request verified by the run projection follows that fresh projection's
`nextAction` and authoritative `answerChannel`. A `ui` request leads to one
`loomex_interaction_view` call; the view performs the authoritative read and
returns `awaitingUserAnswer`, with no self-referential presentation action. Its
exact returned `viewSessionId` persists for an explicit reopen only. A `chat`
request leads to `loomex_interaction_get`, which returns its exact singular
long-text question, complete schema and revision without rendering a textarea
card. An `unsupported` request surfaces its compatibility error and pauses. The conversation pauses until the user answers or explicitly asks to
reopen a UI form. Shared skills and UI continuation text follow the same
sequence; previews never substitute for complete schemas. A continuation
identifies the exact existing run and starts with a fresh read, not a repeated
commit or accepted answer.

## One run-preparation flow

A current task path or explicit override selects the workspace without another prompt. Workspace registration validates and records that canonical scope; it is not execution authorization. The UI performs registration and preparation as one ordered pipeline, skipping the setup form when there are no authored inputs and the workspace is known. Missing values still require input. Ambiguous outcomes stop the pipeline and preserve the exact operation for an explicit retry. A repeated setup notification must preserve the current flow, including its pending/accepted preparation, instead of creating another one.

The single review displays the canonical workspace and host-user permissions. Start remains the explicit commit boundary, and runner checks remain unchanged. Workspace list/grant/revoke tools are advanced management operations; normal runs do not open an extra grant screen or ask for the same path twice.

Setup notifications cannot replace the owner of an in-flight or uncertain mutation; the exact operation must settle or be retried first. For a settled flow, an identical nonempty request ID and workflow/version/organization may retain its review when repeated metadata is omitted. A new context-free request clears the previous task path, and an explicit changed path requires fresh preparation.

## Accepted interaction handoff

The model-context update contains a compact `loomex/chat-continuation/v2`
lifecycle record: exact run, trigger, and verified request ID/status after an
accepted interaction. It contains no answer or authored workflow text. A
separate receipt-bound `$loomex-runs follow-existing-run` message requires a fresh run read and event draining
before cursor advancement, then serial bounded waits while the authoritative
action requires them. Recovery is independent and never delays live waits.
Start, follow and accepted-answer handoffs are distinct; retries and
manual fallback preserve the original accepted receipt. The UI does not poll or
infer the next pending question.

An accepted receipt invalidates the previous pending-card assumption, but does not establish the current run state. Chat must read the exact run and follow its current `nextAction`. Host acknowledgement means the message was accepted, not that the model has performed that read. Agent routing and regression tests harden this boundary without claiming control over a host model's compliance.

## Monitoring recovery

Explicit follow requests begin with a fresh exact-run read and required event
page draining. While the run is active, the host resolves scheduling capability
and current task binding, uses a known heartbeat ID and reads the resulting
record back before serial 30-second live waits begin. A run-start continuation
may create the first heartbeat and must read it back. A later follow with a
lost or ambiguous ID cannot find it again by marker on the installed host, so
it leaves recovery ambiguous rather than creating another heartbeat. Recovery state
is host evidence: `unchecked`, `verified`, `unavailable`, `ambiguous`,
`paused`, or `removed`. The runner and backend continue to own execution. The
plugin does not call private Codex APIs or schedule from an iframe. Runner
projections intentionally remain `unchecked`; verified, unavailable, ambiguous,
paused, and removed are host-orchestration observations and diagnostic evidence,
not runner facts. The fresh run snapshot's `nextAction` remains the workflow
directive; host recovery state cannot replace event draining, input delivery, or
result retrieval. Event pages take precedence; quiet timeouts remain active.
One-off status reads do not opt into recovery.

The packaged [recovery contract](../skills/loomex-runs/references/recovery.md)
owns host capability discovery, exact task/run schedule reuse, record
verification after mutations, and lifecycle handling. A recovery wake performs
a bounded fresh check and returns quietly on unchanged automated work. Questions
pause recovery before their exact request is presented; accepted answers discard
the old request state and read the run fresh before recovery resumes. After a
terminal result is retrieved, cleanup removes the matching schedule. Unavailable
or ambiguous scheduling is disclosed while live following remains usable.

Host scheduling is model-mediated: the documented API has no atomic uniqueness key or exclusive monitor lease, and delivery depends on host availability. Shared task context deduplicates already displayed request IDs but cannot guarantee exactly-once presentation during concurrent turns. Do not describe this as an always-running or exactly-once notification service. Stronger delivery would require a supported host coordination/event API; no backend execution changes can provide that host guarantee.
