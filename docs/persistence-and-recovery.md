# View state and answer recovery

Loomex keeps execution state on the backend. Closing a card does not cancel a run, submit an answer, or approve execution. Reopened cards refresh the backend before restoring presentation state.

The runner stores view sessions in its existing private state directory, in `presentation.sqlite3`. Sessions are scoped to the authenticated account, organization and installation. The plugin stores no Loomex credentials. A separate home-directory tree tied to Codex's internal task files is unnecessary; cards carry an opaque `viewSessionId` through supported tool metadata.

Persisted state includes navigation, pagination, setup values, answer position and review phase. Navigation restoration resolves the complete verified forward chain, such as setup → preparation → monitor; a preparation already committed is therefore followed to its durable monitor instead of being treated as a new setup failure. Cycles, identity mismatches and missing links stop safely without creating work. Backend answer drafts are bound to the exact human request and its schema digest. Changing an answer-defining question invalidates stale drafts. A saved draft is not a submitted answer.

Writes use optimistic revisions. A stale card must reconcile with the latest saved state rather than overwrite it. Lost responses retain the original arguments and idempotency key. A pending operation records the canonical runner method separately from ordinary presentation state. Reading this record does not execute it, and restored confirmation data is never fresh execution authority.

Business actions remain disabled until the exact view session, authoritative state, answer draft and pending operation have finished restoring. Failed restoration leaves read-only recovery available and cannot create a replacement operation.

A reopened card with an uncertain Start or Submit reconciles authoritative state when a suitable read exists. Otherwise it keeps the operation pending and offers only the supported exact retry. It never generates a new mutation key to recover a lost response.

Long answers use chat after a fresh authoritative question read. A direct answer can be submitted as supplied; research and file references provide context, not consent to invent an answer. Synthesized answers are reviewed with the user before submission. Structured choice batches stay in the card and show an answer preview before submission. Once accepted, the card replaces editable controls with a read-only answer review sourced from the resolved request; reopening a monitor revalidates that exact request before displaying it. Background view and draft saves are silent so a checkbox change never introduces a loading row or moves the visible question.

Pending answer drafts remain available while input is required. Resolved, failed or canceled requests retire drafts for 30-day retention, with cleanup through existing backend maintenance. Unresolved operation journals are retained even if a view expires. Complete runner uninstall removes its SQLite database and sidecars using the installation ownership inventory.

Provider progress is a safe activity summary, not hidden reasoning or proof of completed work. Chat uses bounded waits over durable events; scheduled recovery follows the same run when supported. Final AI output is validated independently against the node's authored schema before downstream execution.
