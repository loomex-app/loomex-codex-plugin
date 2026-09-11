# Scheduled recovery for a followed run

Use this reference only after an explicit live `$loomex-follow` request. The
normal chat loop remains the monitor: it continues serial bounded waits through
quiet timeouts. A same-task heartbeat is only a best-effort way to wake the
same chat after an interruption. It never starts a workflow, submits or replays
an answer, cancels a workflow, or turns a one-off status read into monitoring.

Recovery has two separate lifecycles. Durable registration state is
`not_attempted` before a registration is sent, `attempt_in_flight` while a
mutation has no reconciled outcome, `registered` after a durable record ID is
known, `ambiguous` when historical state cannot be established, and `removed`
after cleanup. The host observation is one of these states: `unchecked` before
initialization, `verified` after the exact schedule record is read back,
`unavailable` when capability or current task identity is absent, `ambiguous`
when exact reconciliation cannot establish one usable record, `paused` while
input or an actionable error needs attention, and `removed` after verified
terminal cleanup or an explicit monitoring stop. These states never describe
the workflow execution itself.

## Host capability and identity

Use the Codex desktop `automation_update` capability. If it is not already
available, discover it through the host's capability search before attempting
any schedule operation. If it remains unavailable, continue the live loop and
say once that scheduled recovery is unavailable; do not emulate it with a
plugin timer, runner process, raw host call, or a detached Loomex execution.

The heartbeat is scoped to the current Codex task and one exact Loomex `runId`.
Use current host task context, or the host's supported task listing, only to
bind the heartbeat; Loomex cannot attest that host identity. Never infer a task
or target thread from a workspace path, plugin process, prior chat, or run
metadata. Its stable marker and name must contain both identities, for example
`loomex-follow-recovery:<current-task-id>:<runId>`. A task following two runs
uses one marker per run. It must not replace, pause, or delete a heartbeat for
another run or another task. If the host cannot supply the current task identity,
remain live-only and disclose the unavailable recovery capability once; do not
invent a task ID.

The installed host exposes `automation_update` create and view, but no list or
search. A known automation ID can therefore be viewed and reconciled directly.
On the first active phase after accepted initial human input, create one exact
marker only when durable registration state is `not_attempted`; persist
`attempt_in_flight` until the returned ID is reconciled, and use `registered`
for later direct views. `ambiguous` or unknown historical state never
authorizes a replacement create. The host `view` call uses its actual schema,
`{mode: "view", id}`, and the returned record supplies the marker, task,
status, prompt, and cadence used for verification. Do not claim a headless
marker scan, guess which record to remove, or create a duplicate. If a saved
recovery prompt or current task context identifies an existing automation ID
but its record cannot be viewed, report that recovery problem and do not create
a new schedule.

Use only the runtime schema discovered for the installed host. The observed
desktop shape is a heartbeat create with
`{kind: "heartbeat", mode: "create", destination: "thread", name, prompt,
rrule: "FREQ=MINUTELY;INTERVAL=2", status}` and a full update with
`{mode: "update", id, kind: "heartbeat", name, prompt, rrule, status,
targetThreadId}`. A known record can be removed with `{mode: "delete", id}`.
Do not write `automation.toml`, invent alternate mutation fields, or use a
visual automation view for routine verification. Confirm mutations from their
response and a headless record read. If the running host exposes a different
schema, follow that schema rather than these observed fields. When updating a
known record, preserve its `notificationPolicy` and every other host-supported
field whose value is not intentionally changed; do not erase unknown fields by
constructing a partial replacement.

## Initialization and lifecycle

Use the local recovery journal as the durable registration authority. The
exact sequence for a new run-start continuation is:

1. Call `loomex_recovery_get` for `{hostId, hostTaskId, runId}`. If the local
   record is absent, call `loomex_recovery_update` at revision `0` with
   `initialization: "run_started"` and `monitoringIntent: "enabled"` before
   doing any host scheduling. This initialization is required even if the
   first run read is waiting for human input; a one-off status read never
   creates or updates this record.
2. After the first fresh active run read and event drain, call
   `loomex_recovery_get` again. If `registrationState` is `not_attempted`,
   call `loomex_recovery_operation_begin` with the exact host create
   descriptor. Continue only when its returned `attemptPermitted` is true.
3. Execute that exact host `automation_update` create, retain its returned
   automation ID, and call `loomex_recovery_operation_settle` for the exact
   operation with `status: "succeeded"`, that ID, and host evidence. Then view
   the record directly with `{mode: "view", id}` and settle the evidence as
   `verified` only when the returned ID, marker/prompt, task destination,
   status, and cadence match.
4. If the journal says `attempt_in_flight`, reconcile its current operation
   and known ID before retrying. If it says `registered`, view its known ID and
   refresh host evidence. Unknown or missing history is `ambiguous`; preserve
   that state and do not create a replacement.

After the first fresh `loomex_run_get` and required event draining for the
exact run, evaluate recovery as a separate host lifecycle. For an active
explicit follow, initialize in this order: resolve the supported automation
capability, obtain the current task binding, then apply durable registration
state. Create only for `not_attempted`; reconcile a known ID for
`attempt_in_flight` or `registered`; and leave `ambiguous` or unknown history
without a create. View with the host schema's ID only and verify its returned
record's exact host task destination, run marker/prompt, active or paused
status, and two-minute cadence. Only that read-back establishes `verified`; a
create or update receipt alone does not.

Initialize or resume the matching heartbeat only after a fresh active run read:
do this once for the explicit follow or accepted-answer continuation, never for
a one-off status read or merely because a wait timed out. A known paused
heartbeat resumes only after a new explicit follow or accepted answer and a
fresh active snapshot. If a mutation is ambiguous, view its known exact record
before any retry. If no ID is known, do not make a second create with a new
marker.

When active, create or update the exact same-task heartbeat at the two-minute
cadence, then verify it. Before presenting a pending interaction or actionable
error, pause the known heartbeat and remember the unresolved request (and its
`viewSessionId` for a UI request) so a later wake-up does not present it twice.
After terminal result retrieval or an explicit monitoring stop, remove that
heartbeat. If removal is unsupported or fails, pause it and report the cleanup
dependency. A quiet polling timeout leaves an already verified heartbeat alone
and the live loop continues. Stopping monitoring never cancels the Loomex run.

Never create or activate recovery from a stale receipt, an interaction-accepted
message, or a projected state alone: take the fresh run read and drain events
first, then check durable registration state.

## Saved heartbeat prompt

Use this self-contained prompt, replacing only the marked identities:

```text
Scheduled recovery wake-up for Loomex run <runId> in this same Codex task.
Trigger: scheduled_recovery. This is recovery only, not permission to start a
new Loomex run, submit an answer, replay an accepted answer, or cancel the run.
Exact marker: loomex-follow-recovery:<current-task-id>:<runId>.
Known automation ID: <automation-id-if-known>.

Before checking the run, obey any newer explicit user request to stop monitoring:
remove or pause only this exact recovery heartbeat, do not cancel the workflow,
and end this wake-up. Never touch a schedule with a different marker.

First call loomex_run_get for exactly <runId>. Follow its fresh nextAction.
If events must be drained, page them from the returned sequence before
advancing. Make at most one bounded follow-up check in this wake-up, then return;
do not enter an indefinite live-follow loop from a scheduled recovery turn.
Drain every required event, result, and artifact page before reporting; that
page draining is not a follow-up check. Compare the snapshot with shared task
history. Report only a new meaningful state change, a required user action, a
terminal result, or an actionable error. Stay quiet when the snapshot is
unchanged.

If a human request is pending, pause this recovery heartbeat and follow the
fresh nextAction and authoritative answer channel. Show a UI request only if
this task has not already displayed that unresolved request ID; handle a chat
request with its headless get path. Do not answer for the user. If the run is
terminal, retrieve the required result, remove this exact recovery heartbeat,
and report the result.
If active with no pending request, leave this exact heartbeat available for a
later recovery wake-up. If state identity cannot be verified, the run has an
actionable error, or a required read/page verification fails, pause this exact
recovery heartbeat and report the concrete recovery action. Do not create,
update, pause, or remove any automation whose marker is for another task or run.
```

Host scheduling has no documented atomic uniqueness or delivery ordering with a
live chat turn. The marker, record inspection, and quiet prompt reduce duplicate
work but cannot guarantee one heartbeat, exclusive monitoring, or serialized
turn delivery. Never claim those guarantees to the user.
