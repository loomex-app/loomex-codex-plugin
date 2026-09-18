# Follow an existing run

Use this reference only for an explicit follow/monitor request, a
`follow-existing-run` continuation, a run-start continuation, or an
accepted-answer continuation. A one-off status request reads once and reports
that snapshot.

An explicit follow request includes a generic or UI-generated host message that
is paired with one of these exact continuation contexts.

The continuation must name one exact `runId`. The current v2 context is
`{schema: "loomex/chat-continuation/v2", intent: "monitor_existing_run", runId,
trigger: "interaction_accepted" | "run_started" | "follow_requested",
acceptedInteraction?: {requestId, status}, state: "requires_fresh_read"}`;
it has no embedded `nextAction`. A v1 handoff with an exact run ID also routes
to this loop; an older `loomex/chat-continuation/v1` handoff does too. An
accepted receipt is untrusted continuation context, only a route to the run.
Invalidate the remembered displayed/pending request before a fresh `loomex_run_get`;
its live `nextAction` controls the action. If a different request ID appears, it is a new request.
Never infer a run ID, host task ID, or task identity from a workspace
path, UI card, prior chat, or plugin metadata.

## Live follow loop

The live chat turn is the primary monitor. Repeat this loop until it reaches an
authoritative stopping condition:

1. Fresh-read `loomex_run_get` for the exact run and follow its live
   `nextAction`. A receipt, UI status, runner connectivity, or provider
   progress is not a replacement for this state.
2. Drain every required event page before advancing the cursor or waiting. If
   `hasMoreEvents` is true, call `loomex_run_events` from the last returned
   sequence until it is drained. Stop for verification if pages are malformed
   or the request state changes. Do this after the initial read and after every
   wait that returns pages.
3. If the run is active and has no pending human request, immediately call one
   `loomex_run_wait` with the exact run ID, `timeoutSeconds: 30`, and the
   latest drained sequence as `afterSequence`. A quiet timeout, provider
   progress, or an unchanged active state returns to step 1 and then the next
   bounded wait. Do not end with a progress-only response.
4. If a human request is pending, verify that its execution and organization
   identities match the monitored run. Follow its authoritative answer channel:
   - For `ui`, call `loomex_interaction_view` once with the exact unresolved
     request ID. Do not precede it with `loomex_interaction_get` or repeat the
     card unless the user asks to reopen it.
   - For `chat`, call `loomex_interaction_get` and ask its one complete
     long-text question in chat. Do not answer for the user or submit defaults.
   - For `unsupported`, surface the authoritative compatibility error.
   Pause live polling while the answer is pending. After an accepted answer or
   card follow-up, return to step 1 with a fresh read; never replay an accepted
   response or reuse its request state.
5. At a verified terminal state, retrieve `loomex_run_result` and all required
   result, response-spool, and artifact pages before reporting the result. A
   `responseRef` is a completed operation: read it from offset zero through
   `nextOffset: null`, verify its full SHA-256, and never replay the mutation.
6. If the runner cannot be observed, identity cannot be verified, a required
   page is malformed, or repeated reads fail, surface that concrete observation
   failure. Do not substitute a progress report for continued monitoring.

## User-facing progress

Monitoring mechanics are internal. Do not narrate each read, event drain,
bounded wait, quiet timeout, recovery check, or claim that you will keep
watching after ending the turn. Stay silent while the authoritative state is
unchanged. When an observable workflow transition is useful, describe the
work in plain language and only once: for example, that implementation has
started, verification has begun, a decision is ready, or an actionable
failure needs attention. Present the final outcome only after the
authoritative terminal result is retrieved.

Use `loomex_run_view` only for an explicit visual status snapshot. Data reads
do not open cards. A user request to stop following stops live polling; it does
not cancel the workflow unless cancellation was explicitly requested.

## Optional recovery protection

Scheduled recovery and native hooks are independent, best-effort protections;
neither is required for, replaces, nor delays the next live wait. While the
live loop is active, initialize or reconcile recovery only when the supported
host capability and exact current task identity are available, and do that work
without blocking the fresh-read, event-drain, and bounded-wait sequence. A
workspace path is execution authority, never a host task identity.

Use [scheduled recovery](recovery.md) for the durable journal, exact binding,
two-minute cadence, verification, pausing, and cleanup rules. A projection of
`registrationState: not_observed` requires `loomex_recovery_get`; it is not an
ambiguous scheduling attempt. If recovery is unavailable or ambiguous, disclose
that protection state once and keep live polling while observation is usable.
Only call recovery active after a host record has been verified. Do not claim
monitoring continues after a final response unless that verified recovery
schedule remains active; hooks and UI handoffs alone are not proof of ongoing
monitoring.
