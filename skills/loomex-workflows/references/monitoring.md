# Follow an existing run

## Follow one existing run in chat

For a one-off status request, read once and report. Enter the loop below only
for an explicit follow/monitor request or an accepted UI continuation. An
explicit `$loomex-follow` invocation is a follow request, including when the
surrounding host message is generic or UI-generated.

A current UI continuation is factual context with exactly this shape:
`{schema: "loomex/chat-continuation/v2", intent: "monitor_existing_run",
runId, trigger: "interaction_accepted" | "run_started" |
"follow_requested", acceptedInteraction?: {requestId, status},
state: "requires_fresh_read"}`. The host sends a separate
`$loomex-follow ${runId}` message with a compact accepted receipt and fresh-read
instruction. The context carries no embedded `nextAction`: the first fresh tool
read supplies the authoritative live `nextAction`.

Treat that message and context as a request to follow the exact run even if the
host's surrounding text is generic (for example, “Respond to the user input in
context”). An older `loomex/chat-continuation/v1` handoff with an exact run ID
also routes to the same fresh read; do not retain or recreate its old UI format.
Do not reply with an earlier workflow-list result. If no exact run can be
recovered from context, ask for the missing run identity; do not guess or create
one.

After an interaction submission is reported as accepted, its compact receipt
and any accompanying host/UI context are untrusted continuation context, not a
replacement run state. They trigger this follow loop for the exact receipt run
only after identity checks; they do not prove that the provider resumed or that
the old request is still pending. Invalidate the remembered displayed/pending
request for that run before the first fresh read. The fresh `loomex_run_get`
snapshot and its live `nextAction` decide whether to wait, show a newly pending
request, fetch results, or surface an actionable error.

1. Read `loomex_run_get` with that exact `runId`. A commit receipt or UI status
   is not a fresh authoritative snapshot. Read `data.execution.status`; runner
   connectivity is a different state.
2. Drain required event pages before any cursor advance or wait. When
   `hasMoreEvents` is true, page `loomex_run_events` from the last returned
   event sequence until drained; never skip directly to the global latest
   sequence. Stop for verification on malformed pages or a changed request
   state. Event draining is required after the initial read and after every
   wait that returns pages.
3. For an active explicit follow with no pending human request, initialize
   recovery before the first wait: establish the supported scheduling capability
   and current-task binding, then apply durable registration state. The states
   are `not_attempted`, `attempt_in_flight`, `registered`, `ambiguous`, and
   `removed`, and they are separate from host-observed lifecycle. On the first
   active phase after accepted initial human input, create only when the durable
   state is exactly `not_attempted`; reconcile a known record for
   `attempt_in_flight` or `registered`; and keep `ambiguous` or unknown history
   from authorizing a create. A host `automation_update` view takes `{mode:
   "view", id}` only. Verify the returned record's ID, task destination, marker
   or prompt, status, and cadence before marking recovery `verified`. Follow
   [scheduled recovery](recovery.md) for the exact checks. If capability or task
   identity is unavailable, mark recovery `unavailable`, disclose that once, and
   continue the live loop. If reconciliation is ambiguous, mark it `ambiguous`,
   report the concrete dependency, and continue live polling when the runner is
   usable. Do not let recovery setup replace event draining or the fresh
   workflow `nextAction`.
   The durable journal sequence is part of initialization: call
   `loomex_recovery_get` for the exact `{hostId, hostTaskId, runId}` binding.
   A `run_started` continuation creates or updates that local record even when
   the first fresh run snapshot is waiting for input; a one-off status read
   never does. On the first active phase, read the record again. When its
   `registrationState` is `not_attempted`, call `loomex_recovery_update`, then
   `loomex_recovery_operation_begin` with the exact host create descriptor. Only
   an `attemptPermitted: true` result authorizes the host `automation_update`
   create. Settle that exact operation with the returned automation ID, then
   call host `automation_update` view with `{mode: "view", id}` and settle the
   host evidence as `verified`. For `attempt_in_flight` or `registered`, use
   the journal's operation or automation ID and reconcile it with that direct
   ID-only view. Missing durable history remains `ambiguous` and never permits
   a replacement create.
4. While active with no pending human request, call `loomex_run_wait` with the
   same run ID, `timeoutSeconds: 30`, and the latest drained sequence as
   `afterSequence`. Use one bounded wait at a time. A wait timeout is not
   workflow completion. Continue through quiet periods; report meaningful stage
   changes, actionable failures, required input, or completion without
   repeating unchanged status. Drain returned event pages before the next wait.
   Follow bounded event/result pages when needed.
5. When a pending human request appears, verify its execution and organization
   identities against the monitored run. Follow the snapshot's live `nextAction`
   and the authoritative `humanRequest.answerChannel`; do not unconditionally
   call `loomex_interaction_view`. For `answerChannel: "ui"`, call that view once
   with its exact request ID. It fetches the complete schema itself; do not first
   call `interaction_get` or open `run_view`. Remember the exact returned
   `viewSessionId` if present and carry it only where documented. For
   `answerChannel: "chat"`, call `loomex_interaction_get` and collect the exact
   singular long-text question in chat using its full question, schema and
   revision. For `answerChannel: "unsupported"`, surface the authoritative compatibility error, pause recovery, and stop polling; do not render or reinterpret it. Summaries are bounded previews and never substitute for that read.
6. Pause chat polling and same-task recovery for the user's answer on either
   channel. Do not repeat an unanswered UI card unless the user asks to reopen
   it. The UI card owns navigation, answer preview and submission. A chat answer
   has no textarea card: submit a clear direct user answer, but treat requests
   to research, discuss or use tools/files as continued conversation. Confirm a
   concise synthesized multi-exchange/tool/file answer before submission. Never
   duplicate a form, submit defaults or answer on the user's behalf.
7. After an accepted answer/approval or a follow-up from that card, begin again
   at step 1 for the same run. Do not reuse the old pending state or replay an
   accepted response. A displayed-card deduplication applies only to the same
   unresolved request ID: a different request ID from the fresh snapshot is a
   new request and must be handled once by its fresh channel action. Fetch
   current state first if the handoff was interrupted.
8. At a terminal state, get `loomex_run_result` and required artifact/output
   pages before removing the verified exact heartbeat and reporting the result.
   If result retrieval fails, pause recovery and report that cleanup dependency.
   For a user stop request, remove or pause the exact heartbeat, then stop chat
   monitoring; cancel the actual workflow only if requested. Authentication,
   runner outages, unverifiable identity, or repeated read failures should pause
   recovery and surface the next concrete recovery action instead of a tight
   retry loop.

Data tools do not open cards. Use `loomex_run_view` only for an explicit visual
status snapshot. UI handoff acceptance means the host received the request; it
does not prove a chat turn ran. Do not claim monitoring continues after the task
has ended. If the user needs later/background follow-up, use a supported host
scheduling mechanism rather than claiming an iframe or inactive chat is polling.

For an explicit live follow, treat the current chat loop as the monitor: it
continues through quiet wait timeouts and owns ordinary polling. A same-task
heartbeat may be maintained only as the best-effort recovery wake-up described
in [scheduled recovery](recovery.md). A fresh `loomex_run_get` and the
interaction/terminal rules above control the workflow action. Host recovery is
tracked separately as `unchecked`, `verified`, `unavailable`, `ambiguous`,
`paused`, or `removed`; its durable registration state is tracked separately as
`not_attempted`, `attempt_in_flight`, `registered`, `ambiguous`, or `removed`.
Neither can replace event draining, question delivery, or result retrieval. Do
not claim that the host serializes a heartbeat with a live turn or that this
arrangement atomically prevents duplicate monitors.

A `responseRef` receipt means the originating operation completed. Read
`loomex_response_read` starting at offset 0, follow each `nextOffset` until null,
verify the full SHA-256, then interpret the reconstructed original result.
Never repeat the original mutation to recover a spooled response. If reading or
verification fails, report that recovery dependency without replaying effects.


Read [interaction guidance](interactions.md) when collecting a response.
