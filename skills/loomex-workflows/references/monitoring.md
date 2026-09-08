# Follow an existing run

## Follow one existing run in chat

For a one-off status request, read once and report. Enter the loop below only
for an explicit follow/monitor request or an accepted UI continuation.

A UI continuation contains `loomex/chat-continuation/v1`, the intent
`monitor_existing_run`, an exact `runId`, and the next read action. Its
`ui/update-model-context` and follow-up text carry the same safe run identity.
Treat either as a request to follow that run, even if the host's user message is
generic (for example, “Respond to the user input in context”). Do not reply with
an earlier workflow-list result. If no exact run can be recovered from context,
ask for the missing run identity; do not guess or create one.

1. Read `loomex_run_get` with that exact `runId`. A commit receipt or UI status
   is not a fresh authoritative snapshot. Read `data.execution.status`; runner
   connectivity is a different state.
2. While active with no pending human request, call `loomex_run_wait` with the
   same run ID, `timeoutSeconds: 30`, and the latest sequence as `afterSequence`.
   If `hasMoreEvents` is true, first page `loomex_run_events` from the last
   returned event sequence until drained; never skip directly to the global
   latest sequence. Stop for verification on malformed pages or request state.
   Use one bounded wait at a time. A wait timeout is not workflow completion.
   Continue waiting through quiet periods; report meaningful stage changes,
   actionable failures, required input or completion without repeating unchanged
   status. Follow bounded event/result pages when needed.
3. When a pending human request appears, fetch `loomex_interaction_get` with
   its exact request ID. Verify its execution and organization identities match
   the monitored run. Use the complete `structuredContent.data.humanRequest`,
   including `inputSpec` and `responseSchema`; text summaries are only previews.
4. In this UI-enabled workflow, call `loomex_interaction_view` once for that
   pending request. The card shows one question at a time, previous/next arrows,
   and an answer review before explicit submission. Pause chat polling and await
   the user's answers. Do not open the same unanswered card repeatedly, submit
   defaults, answer on the user's behalf, or poll continuously while awaiting
   input. A headless host asks the user directly and sends only explicit answers.
5. After an accepted answer/approval or a follow-up from that card, read and
   follow the same run again. Do not replay an accepted response. Fetch current
   state first if the handoff was interrupted.
6. At a terminal state, get `loomex_run_result` and required artifact/output
   pages, report the result, and stop polling. For a user stop request, stop chat
   monitoring; cancel the actual workflow only if requested. Authentication,
   runner outages, unverifiable identity, or repeated read failures should be
   surfaced with the next concrete recovery action instead of a tight retry loop.

Data tools do not open cards. Use `loomex_run_view` only for an explicit visual
status snapshot. UI handoff acceptance means the host received the request; it
does not prove a chat turn ran. Do not claim monitoring continues after the task
has ended. If the user needs later/background follow-up, use a supported host
scheduling mechanism rather than claiming an iframe or inactive chat is polling.

A `responseRef` receipt means the originating operation completed. Read
`loomex_response_read` starting at offset 0, follow each `nextOffset` until null,
verify the full SHA-256, then interpret the reconstructed original result.
Never repeat the original mutation to recover a spooled response. If reading or
verification fails, report that recovery dependency without replaying effects.


Read [interaction guidance](interactions.md) when collecting a response.
