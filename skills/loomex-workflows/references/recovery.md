# Scheduled recovery for a followed run

Use this reference only after an explicit live `$loomex-follow` request. The
normal chat loop remains the monitor: it continues serial bounded waits through
quiet timeouts. A same-task heartbeat is only a best-effort way to wake the
same chat after an interruption. It never starts a workflow, submits or replays
an answer, cancels a workflow, or turns a one-off status read into monitoring.

## Host capability and identity

Use the Codex desktop `automation_update` capability. If it is not already
available, discover it through the host's capability search before attempting
any schedule operation. If it remains unavailable, continue the live loop and
say once that scheduled recovery is unavailable; do not emulate it with a
plugin timer, runner process, raw host call, or a detached Loomex execution.

The heartbeat is scoped to the current Codex task and one exact Loomex `runId`.
Use the host-provided current task identity only; never infer a task or target
thread from a workspace path, plugin process, prior chat, or run metadata. Its
stable marker and name must contain both identities, for example
`loomex-follow-recovery:<current-task-id>:<runId>`. A task following two runs
uses one marker per run. It must not replace, pause, or delete a heartbeat for
another run or another task. If the host cannot supply the current task identity,
remain live-only and disclose the unavailable recovery capability once; do not
invent a task ID.

Before creating anything, headlessly inspect the existing automation records
for that exact marker and current task/run binding. Preserve all nonmatching
records. If exactly one matching record is usable, update that record rather
than creating another. If records conflict, are duplicated, or a prior create
has an ambiguous outcome, inspect their current records and report the concrete
recovery problem. Do not blindly create a replacement or guess which record to
delete. If the saved recovery prompt or current task context identifies an
existing automation ID but its record cannot be read, report that recovery
problem and do not create a new schedule.

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

## Lifecycle

After the first fresh `loomex_run_get` for the exact run, use the advisory
projection only to select the schedule lifecycle. `ensure` is for the initial
active explicit follow and for an accepted-answer continuation that has a fresh
active state; it is not repeated on every quiet wait or status read. A paused
heartbeat is resumed only after a new explicit follow or an accepted answer,
followed by that fresh active state.

1. `ensure`: create or update the one matching same-task heartbeat at the
   two-minute cadence. Use the host's active status value only when the fresh
   run is active and has no pending human request.
2. `pause`: update the known matching heartbeat to the host's paused status.
   A pending interaction pauses recovery before its verified request is shown.
   Remember the displayed request in shared task history, so that a later
   recovery wake-up does not show the same unresolved request twice.
3. `remove`: delete the known matching heartbeat after a terminal result is
   retrieved or the user explicitly stops monitoring. If deletion is unsupported
   or fails without an ambiguous result, pause that exact known heartbeat and
   report the limitation. Stopping monitoring does not cancel the Loomex run.
4. `continuePolling`: make no schedule mutation solely because of a quiet
   polling timeout. Continue the live loop and leave a valid recovery heartbeat
   alone.

Never create or activate recovery from a stale receipt, an interaction-accepted
message, or a projected state alone: take the fresh run read first. If a host
mutation result is ambiguous, reconcile the exact marker/record before any
retry; do not make a second create with a new marker.

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

If a human request is pending, pause this recovery heartbeat and show the
verified request only if this task has not already displayed that unresolved
request ID. Do not answer for the user. If the run is terminal, retrieve the
required result, remove this exact recovery heartbeat, and report the result.
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
