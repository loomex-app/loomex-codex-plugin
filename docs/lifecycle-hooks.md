# Lifecycle hooks

The Loomex plugin includes `hooks/hooks.json`. Once the installed plugin hook
definition has been reviewed and trusted in Codex, its command uses the
runtime packaged inside the cached plugin root at `$PLUGIN_ROOT/runtime/bin/node` to run
`$PLUGIN_ROOT/hooks/lifecycle-adapter.mjs`. It does not use the development
machine's Node binary, `PATH`, project files, transcript contents, providers,
or workflow commands.

Codex invokes the adapter for `SessionStart`, `UserPromptSubmit`,
`PostToolUse`, `Stop`, and `Interrupt`. The adapter accepts only the native
hook envelope fields needed to keep a runner-owned follow session anchored:

- Every event sends a UUID event ID, the bounded native session ID, and an
  available turn ID. When Codex exposes a turn or tool-use identity, the event
  ID is deterministically derived from that identity so a redelivery keeps its
  idempotency key. The adapter does not send `cwd` or treat a workspace path as
  a task identity. Codex does not expose a documented verified task ID in this
  hook envelope, so the runner retains an explicitly unverified task sentinel
  for a live session and never uses it to register recovery.
- `UserPromptSubmit` recognizes only the versioned continuation grammar below.
  It sends a compact `continuation` identity, never submitted prompt text.
- `PostToolUse` sends the tool name and tool-use ID. For a known run-scoped
  Loomex tool, it additionally sends a `tool.association` only when the
  documented native `tool_input` and `tool_response` independently contain the
  same exact run ID. The interaction read tools
  `loomex_interaction_get` and `loomex_interaction_view` additionally require
  an exact input request ID plus an exact response request/run identity; their
  association contains only those IDs.
  It never forwards either payload, an undocumented digest, tool arguments,
  output, or a transcript.
  Codex may identify an MCP call as either its fully qualified bridge name
  (`mcp__loomex__loomex_run_wait`) or its server-local name
  (`loomex_run_wait`). The adapter normalizes only those documented Loomex
  names before the runner validates the binding; unknown names remain inert.

## Continuation grammar

The current generated continuation contract is
`loomex-runs-follow-existing-run-continuation/v2`. Only a complete generated,
receipt-bound continuation activates lifecycle following. A run ID or bare
command does not activate monitoring. Complete legacy v1 generated receipts
remain accepted only to finish already-issued handoffs.

```text
$loomex-runs follow-existing-run <run-id>
```

For an interaction read association, `requestId` appears in the top-level,
request, and response identity objects. `runId` appears only in the top-level
and response identity objects because the strict interaction input schema is
`{requestId}`. A mismatched request ID or missing response run identity omits
`association` entirely; the runner verifies the response run belongs to that
request ID.

Plugin-generated Markdown must use this complete, byte-for-byte grammar. The
receipt is opaque base64url data (16–2048 characters) supplied by the runner;
the runner verifies its signature and binding before acting.

```markdown
$loomex-runs follow-existing-run <run-id>

<!-- loomex-runs-follow-existing-run-continuation/v2 receipt=<runner-receipt> -->

Follow the exact existing Loomex run identified above: first call `loomex_run_get` with this run ID, then follow its authoritative `nextAction`.

While the fresh authoritative `nextAction` is `loomex_run_wait` or `loomex_run_events`, do not final-answer: drain required event pages, then call the next action. Active progress, provider activity, and quiet timeouts require another bounded wait. Hooks and schedules are not prerequisites.

Final-answer only after presenting verified user input, retrieving the complete authoritative terminal result, an actionable observation failure, or an explicit user stop. Each wait is bounded; do not add hidden indefinite waits or UI polling.

Do not start another run or resubmit an accepted response.
```

The generated formatter and parser are exported from
`src/monitoring-contract.ts` as `formatFollowContinuationMarkdown` and
`parseFollowContinuation`. Quoted, fenced, embedded, edited, or newline-suffixed
forms are inert. The first command line is visible; the receipt comment is not
accepted on its own. `formatFollowContinuationMarkdown` accepts only a runner-
issued opaque receipt. If no receipt is available, callers must use
`formatManualFollowInstruction`, which renders the command as inline code and
cannot activate the hook.

The local-control request is versioned and requires runner capability
`follow.session.lifecycle/v1`:

```json
{
  "method": "follow.session.lifecycle",
  "params": {
    "schemaVersion": "loomex.follow-session.lifecycle/v1",
    "event": "PostToolUse",
    "eventId": "…",
    "session": { "id": "…", "turnId": "…" },
    "tool": {
      "name": "mcp__loomex__loomex_run_wait",
      "useId": "…",
      "association": {
        "schemaVersion": "loomex.follow-session.tool-association/v1",
        "runId": "…",
        "request": { "runId": "…" },
        "response": { "runId": "…" }
      }
    }
  }
}
```

The runner response is strict and versioned:

```json
{
  "schemaVersion": "loomex.follow-session.decision/v1",
  "decision": "allow"
}
```

`decision: "continue"` is the only response that makes the `Stop` hook write
the documented blocking form `{"decision":"block","reason":"…"}`. A
missing socket, unsafe owner or permissions, malformed response, unsupported
capability, and the five-second adapter budget all fail open. The adapter emits
no nonstandard allow payload in that case. `Stop` has
a ten-second outer hook timeout; `Interrupt` uses Codex's supported three-second
outer maximum and still fails open.

Set `LOOMEX_HOOK_DIAGNOSTICS=1` only while troubleshooting the local hook. It
writes one bounded stderr line with the event name and outcome code. It never
logs prompts, paths, session IDs, tool payloads, runner responses, transcripts,
or receipts.

Run projections include bounded, categorical monitoring evidence for the exact
run. A `handoff_pending` activation means the UI issued a continuation but no
native hook has yet been observed. `hook_not_observed` identifies a missing or
not-yet-observed native delivery, while `hook_observed` confirms that a native
hook was processed. Hook diagnostics classify a rejected payload or association
separately from a runner error, without returning raw runner error text. The
projection never exposes host session IDs, host task IDs, workspace paths,
prompts, tool payloads, receipts, or runner responses. It is not proof that
live following or scheduled recovery is active. Terminal projections retain a
small safe failure summary (code, message, provider/model, failing node, and
retryability) and never expose raw provider output.

The runner retains the exact host-session association and a short,
owner-scoped hook-delivery diagnostic trail for the associated run. It records
only the hook event, accepted/rejected outcome, a fixed classification code,
and observation time; it hashes the delivery ID and never stores workspace
paths, prompts, tool payloads, receipts, or runner responses. An MCP App
handoff has no verified Codex task ID, so its pending record is receipt-scoped
and cannot be used to register scheduled recovery. Only a future documented
native task identifier could establish that durable binding.

The socket must be the current user's Unix-domain socket at
`${LOOMEX_STATE_DIR:-~/.local/share/loomex/runner}/control.sock`, with its
parent directory and socket both owned by that user and not group/world
accessible. This repeats the MCP bridge's owner/mode boundary before a
connection is opened.

Plugin hooks are inactive until the user reviews and trusts their exact
definition through Codex's hook management UI. Installing or enabling the
plugin does not grant that trust. If hooks are disabled by host policy or not
trusted, normal MCP follow operations remain available; the plugin never edits
Codex trust configuration itself.
