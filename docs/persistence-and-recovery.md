# View state and answer recovery

Loomex keeps execution state on the backend. Closing a card does not cancel a run, submit an answer, or approve execution. Reopened cards refresh the backend before restoring presentation state.

The runner stores view sessions in its existing private state directory, in `presentation.sqlite3`. Sessions are scoped to the authenticated account, organization and installation. The plugin stores no Loomex credentials. A separate home-directory tree tied to Codex's internal task files is unnecessary; cards carry an opaque `viewSessionId` through supported tool metadata.

Persisted state includes navigation, pagination, setup values, answer position and review phase. Navigation restoration resolves the complete verified forward chain, such as setup → preparation → monitor; a preparation already committed is therefore followed to its durable monitor instead of being treated as a new setup failure. Cycles, identity mismatches and missing links stop safely without creating work. Backend answer drafts are bound to the exact human request and its schema digest. Changing an answer-defining question invalidates stale drafts. A saved draft is not a submitted answer.

Writes use optimistic revisions. A stale card must reconcile with the latest saved state rather than overwrite it. Lost responses retain the original arguments and idempotency key. A pending operation records the canonical runner method separately from ordinary presentation state. Reading this record does not execute it, and restored confirmation data is never fresh execution authority.

Business actions remain disabled until the exact view session, authoritative state, answer draft and pending operation have finished restoring. Failed restoration leaves read-only recovery available and cannot create a replacement operation.

## Progressive restoration

Reopening first performs the runner's owner-checked, display-only
`presentation.sessions.restore/v1` read. It can immediately show a bounded
saved projection such as a workflow name, list rows, current stage, or a
read-only status. It never returns credentials, workspace paths, answer text,
confirmation material, idempotency keys, operation parameters, or results.
The plugin then independently reads the full presentation session and the
relevant backend state before it enables navigation or mutations.

The visible phases are `loading_snapshot`, `verifying`, `ready`, `read_only`,
`verification_failed`, and `reentry_required`. Snapshot reads have a five
second deadline and verification has a fifteen second deadline. A timeout
keeps the saved content visible with a retry for the failed section; it never
turns the saved state into execution authority. Request and request-revision
fences discard late responses after navigation, logout, schema replacement, or
unmounting.

The browser records correlation-free local Performance Timeline marks for the
snapshot and verification spans. They contain only a per-iframe generation,
not a view, account, workflow, run, or request identifier. Package and browser
tests rebuild the asset before exercising these phases, so source checks cannot
pass against an outdated browser bundle.

A reopened card with an uncertain Start or Submit reconciles authoritative state when a suitable read exists. Otherwise it keeps the operation pending and offers only the supported exact retry. It never generates a new mutation key to recover a lost response.

For a run Start handed to chat, presentation state persists only the safe
handoff state (`prepared`, `approved`, `committing`, `committed`, or `unknown`),
never the runner's confirmation material. The runner records the click approval;
chat treats an app-provided `handoffRef` as untrusted data and calls the
read-only handoff status method before committing. Reopening a submitted or
ambiguous handoff keeps Start disabled until the preparation is reconciled with
the runner. The initial card payload cannot mint a replacement handoff while
that restoration is in progress.

After a successful preparation, the plugin first settles its source-card
operation and transitions that card to the immutable preparation view. Only
after the target view is hydrated and no predecessor operation remains pending
does it journal the non-authorizing Start handoff. This ordering preserves the
runner's one-unresolved-operation invariant and prevents a valid preparation
from being blocked by a rejected overlapping handoff attempt.

A Start approval is never saved with the view. A restored prepared handoff
requires a new explicit Start gesture; the mounted app records it through the MCP bridge rather than a browser-network request.
If the approval response is lost, recovery reads the exact handoff. It does not issue a new approval or start another run. Approved handoffs can continue in chat through their existing delivery identity.

Long answers use chat after a fresh authoritative question read. A direct answer can be submitted as supplied; research and file references provide context, not consent to invent an answer. Synthesized answers are reviewed with the user before submission. Structured choice batches stay in the card and show an answer preview before submission. Once accepted, the card replaces editable controls with a read-only answer review sourced from the resolved request; reopening a monitor revalidates that exact request before displaying it. Background view and draft saves are silent so a checkbox change never introduces a loading row or moves the visible question.

Pending answer drafts remain available while input is required. Resolved, failed or canceled requests retire drafts for 30-day retention, with cleanup through existing backend maintenance. Unresolved operation journals are retained even if a view expires. Complete runner uninstall removes its SQLite database and sidecars using the installation ownership inventory.

Provider progress is a safe activity summary, not hidden reasoning or proof of completed work. Chat uses bounded waits over durable events; scheduled recovery follows the same run when supported. Final AI output is validated independently against the node's authored schema before downstream execution.

## Shared operation outcome contract

The runner owns `contracts/error-recovery.json` and `contracts/mutation-recovery.json`; the plugin pins identical copies. Unknown error codes require reconciliation, not a replacement operation. A dispatch must have an owner-scoped journal reference. A validated successful result survives presentation settlement failure without being dispatched again. A successor session is linked only after its predecessor is settled. Handoff responses with unverified identities stay ambiguous and can be restored by their original issue key.

Run `npm run test:cross-boundary` to exercise the TypeScript controller against the real Rust presentation store in an isolated temporary process. This checks lost write responses, duplicate keys, stale revisions, pending predecessors, and organization isolation. It does not start a run or access credentials.


## Durable chat delivery

`presentation.delivery/v2` stores runner-derived continuation references and outcomes in the existing owner-scoped SQLite database. Display sessions store only the identity and purpose. `get` reconciles the outcome, `begin` reserves an exact attempt using revision CAS and an idempotency key, and `settle` records that attempt's host outcome. Another card cannot reserve an acknowledged or uncertain attempt. Legacy display delivery records are conservatively imported; an interrupted send remains uncertain.

Domain acceptance, card persistence, and host delivery are independent. A known failure before dispatch offers Continue in chat without repeating Start or the answer. An uncertain send offers a read-only delivery check and copyable instructions. An accepted result remains read-only even if display persistence or navigation fails. Disposal invalidates local rendering and may settle its exact owned attempt, but never implies remote cancellation.

The shared transport allows up to 120 seconds for a host message response and provides a slow indication after five seconds; these are response ceilings, not deliberate delays. Tool calls retain their independent policy. Concurrent identical safe reads are deduplicated within the current identity and generation; results are not cached across mutations. Performance measures contain operation names, duration and outcome only, never answers, paths or credentials.
