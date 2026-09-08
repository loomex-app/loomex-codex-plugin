---
name: loomex-workflows
description: Use the local Loomex runner to discover, author, validate, publish, execute, monitor, interact with, and retrieve artifacts from Loomex workflows.
---

# Loomex workflows

The runner executes workflows. This conversation owns monitoring. Custom UIs
collect inputs and explicit decisions; they never poll a run in the background.
Never request, collect, or transmit credentials or secret values.

## Start or discover

For a new workflow request, check `loomex_readiness`, then use the focused
setup/authentication/organization tools if needed. Use `loomex_workflows_list`
for headless discovery and `loomex_workflows_view` when showing a browsable list.
Do not list workflows when the user or UI supplies an existing run ID.

Start a new run with `loomex_run_setup` to collect required inputs and workspace.
Do not open `loomex_workflow_view` merely to run a workflow. Read the selected
version's input schema. Headlessly, ask for missing required values instead of
preparing empty inputs. Preserve user-supplied values; defaults are not consent.
Where `settings.workspaceInputField` applies, use the runner-confirmed canonical
workspace path for that input.

Grant the chosen canonical workspace durably before `loomex_run_prepare`.
Present the exact workflow/version, organization, workspace, providers,
`host_user/v1` policy and unlimited product limits. This policy permits provider
processes to use the signed-in macOS user's authority; workspace selection is
not sandbox containment. Commit only after the user accepts this binding.
Return preparation ID, digest and confirmation key unchanged. A Start click in
the reviewed UI commits once and hands the accepted run back to chat.

Generate one UUID idempotency key per intended mutation. After ambiguity, retain
and retry the same exact arguments/key. A confirmed mutation stays consumed even
if the UI-to-chat handoff fails. Never start another run to recover monitoring.

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

## Answers and authoring

`inputSpec` owns question text, stable option IDs, types, Other behavior and
rating bounds. `responseSchema` owns the payload. Supported controls include
text, long_text, date, rating, boolean, radio and checkbox in single or mixed
batches. Dates use YYYY-MM-DD; ratings use the supplied integer bounds. Submit
only values and stable question/option IDs, not copied prompts or labels.

Inspect `loomex_builder_catalog` before authoring. Prefer builder/editor
lifecycles for conversational authoring. Prepare and explicitly review their
workspace/provider/host policy before commit. Validate before publishing.
Secret-reference mappings are unsupported. Preview editor finalization with
`confirm: false`; apply with `confirm: true` only after approval of that preview.

Execution duration, concurrency, cumulative output and artifact size have no
product quotas. Use paged events, results, responses and artifacts through their
end markers rather than assuming a terminal result fits one response. Treat run
deletion and workspace revocation as destructive operations.
