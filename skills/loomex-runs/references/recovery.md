# Scheduled recovery for a followed run

Use this reference only for an explicit live follow or its run-start/accepted-answer
continuation. Serial bounded chat waits remain the primary monitor. A same-task
heartbeat can wake the chat after interruption; it never starts or cancels a
workflow, submits or replays an answer, or turns a one-off status read into a
follow. Recovery cannot delay or replace live polling.

## Authority and host binding

The runner recovery store is a journal, not a scheduler. Its record preserves
host-reported intent and evidence; it cannot inspect or attest a host task,
automation, current delivery, atomic uniqueness, or exclusive turn ownership.
`registrationState: not_observed` in a run projection requires an exact
`loomex_recovery_get` before any scheduling decision, not a create.

Discover the installed host's supported `automation_update` capability and exact
current task identity. Use current host context or a supported host task listing;
never infer identity from a workspace path, plugin process, hook/session ID, UI
card, prior chat, or run metadata. Loomex cannot attest that identity. If either
capability or identity is unavailable, say once that scheduled recovery is
unavailable and continue live-only. Do not emulate recovery with a timer,
runner process, raw host call, or detached execution.

Bind every journal operation and heartbeat to `{hostId, hostTaskId, runId}`.
Use `loomex-follow-recovery:<current-task-id>:<runId>` as its exact marker/name. One task
following two runs has one marker per run; never touch another task/run's record.
Do not expose private host-session identifiers.

Use only the installed host's runtime schema. The observed desktop shapes are:

- Create: `{kind: "heartbeat", mode: "create", destination: "thread", name,
  prompt, rrule: "FREQ=MINUTELY;INTERVAL=2", status}`.
- View: `{mode: "view", id}` using only the known automation ID.
- Update: `{mode: "update", id, kind: "heartbeat", name, prompt, rrule, status,
  targetThreadId}`; preserve `notificationPolicy` and every other supported field
  unless intentionally changed.
- Remove: `{mode: "delete", id}`.

The observed host has create/view but no list/search. Never scan for markers,
write `automation.toml`, invent mutation fields, guess an ID, use visual views for
routine verification, or create a replacement because a known record is unreadable.
Follow a differing installed schema instead of these examples.

## Durable registration and host observation

These states describe recovery, not workflow execution:

| Durable `registrationState` | Meaning and permitted action |
| --- | --- |
| `not_attempted` | No registration sent; a journaled create may be attempted. |
| `attempt_in_flight` | Mutation has no reconciled outcome; reconcile its exact operation/known ID. |
| `registered` | Durable host ID known; view that ID directly. |
| `ambiguous` | Historical state unknown; preserve it without a replacement create. |
| `removed` | Cleanup recorded. |

Host `lifecycle` is `unchecked` before initialization, `verified` after matching
host read-back, `unavailable` when capability/identity is absent, `ambiguous` when
reconciliation fails, `paused` for input/actionable errors, or `removed` after
cleanup. An actual supported host record is required for a host lifecycle claim
other than `unchecked`; unavailable capability can be disclosed without pretending
a record exists. A create/update receipt or journal claim alone never proves
recovery active.

## Initialization and operations

Begin with a fresh exact `loomex_run_get` and drain every required event page.
Handle recovery separately from its authoritative `nextAction`:

1. When the exact supported binding is available, call `loomex_recovery_get`.
   For a run-start continuation with no record, initialize once at revision `0`
   using `loomex_recovery_update`, `initialization: "run_started"`, and
   `monitoringIntent: "enabled"`, even if the first snapshot awaits human input.
   One-off status reads and listings never initialize or mutate recovery.
2. On the first active phase after accepted initial human input, get the journal
   again. Only exact `not_attempted` permits a create. For `attempt_in_flight`
   reconcile its recorded operation/known ID; for `registered` view its known ID.
   Unknown history remains `ambiguous` and cannot authorize a create.
3. For `not_attempted`, call `loomex_recovery_operation_begin` at the fresh
   revision with the exact host-create arguments and retained UUID key. Execute
   that exact host `automation_update` create only if `attemptPermitted: true`.
   Never settle an unperformed create as successful or skip the host mutation.
4. Retain the actual returned automation ID, then call `{mode: "view", id}`.
   Settle the exact operation once through `loomex_recovery_operation_settle`
   with the actual host outcome, ID and evidence. Record `verified` only if the returned ID,
   marker/prompt, exact task destination, intended active/paused status, and
   two-minute cadence all match. Journal assertions cannot replace this read.
   A successful create with failed read-back is recorded with its known ID and
   `unchecked` lifecycle, not fabricated verification. A crash before settlement
   may leave the create in flight: retain/reconcile the known ID; without one,
   preserve ambiguity and never repeat the host create. Fresh direct host views
   can establish current host-observed verification while durable lifecycle stays
   `unchecked`; do not pretend a later view updated the journal. A completed
   journal operation cannot be settled again. This work never blocks live waits.
5. On ambiguity, retain the exact arguments/key and `attempt_in_flight` until
   reconciled. View a known exact ID before any retry. Without an ID, preserve
   ambiguity; do not create a duplicate with a new marker/key or settle success.

Initialize/resume only once for an explicit follow or accepted-answer continuation
with a fresh active snapshot, never from a stale/accepted receipt or projected
state alone. A known paused heartbeat resumes only after that explicit follow or
accepted answer. Quiet waits do not write recovery checkpoints, update/resume
schedules, or reinitialize the journal; leave verified recovery alone and take
the next bounded live wait.

Before presenting verified pending input or an actionable observation error,
pause known exact recovery. Remember the unresolved request ID and UI
`viewSessionId` to avoid duplicate presentation. After complete terminal result
retrieval or explicit user stop, remove known exact recovery. If removal fails
or is unsupported, pause it and report the cleanup dependency without withholding
verified input or a retrieved result. Failed result retrieval pauses recovery and
reports the dependency. Stopping chat following never cancels execution.

## Saved heartbeat prompt

Use this self-contained prompt, replacing only the marked identities:

```text
Scheduled recovery wake-up for Loomex run <runId> in this same Codex task.
Trigger: scheduled_recovery. Recovery only: never start a new run, submit or
replay an answer, or cancel execution.
Exact marker: loomex-follow-recovery:<current-task-id>:<runId>.
Known automation ID: <automation-id-if-known>.

Obey newer explicit user instructions to stop monitoring: remove or pause only
this exact heartbeat, leave execution running, and end the wake-up.

First call loomex_run_get for exactly <runId> and follow its fresh nextAction.
Drain every required event page before advancing the cursor. This is a one-shot
recovery read; do not enter the live-follow wait loop. Drain complete result,
response-spool, and required artifact pages before reporting; page draining is
not another status check. Compare with task history and notify only for a new
meaningful change, required user action, terminal result, or actionable error.
Stay quiet when unchanged or non-actionable.

For pending human input, pause this heartbeat and follow the authoritative
answer channel. Show a UI request once per unresolved request ID; use the
headless question read for chat. Never answer for the user. For a terminal run,
retrieve the complete result, remove this heartbeat, and report the result.
For active state without input, leave this heartbeat for a later wake-up.
If identity, observation, or required page verification fails, pause this
heartbeat and report the concrete recovery action. Never mutate an automation
for another task or run.
```

Host scheduling has no documented atomic uniqueness or delivery ordering with a
live chat turn. Markers, inspection and quiet prompts reduce duplicate work;
never guarantee one heartbeat, exclusive monitoring, serialized turns, native
hook delivery, or uninterrupted following.
