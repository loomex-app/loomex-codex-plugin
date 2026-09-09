# Visual delivery contract

Loomex has two delivery paths for a read: a native MCP Apps view and a
headless data read. Keep those paths explicit. A visual skill may request a
native card when the current host supports direct MCP UI invocation; otherwise
it must read the same target with the paired data tool and describe the
available data.

## Native MCP UI invocation

Call the visual tool itself through the host's MCP tool surface when it is
available. The current visual entry points are:

| Visual purpose | Native tool | Headless fallback |
| --- | --- | --- |
| Browse workflows | `loomex_workflows_view` | `loomex_workflows_list` |
| Inspect a workflow | `loomex_workflow_view` | `loomex_workflow_get` |
| Set up a run | `loomex_run_setup` | `loomex_workflow_get` for the schema and setup facts |
| Show run status | `loomex_run_view` | `loomex_run_get` |
| Show a UI-channel pending interaction | `loomex_interaction_view` | unavailable: `answerChannel: "ui"` requires its focused view |
| Read a chat-channel pending interaction | no visual card | `loomex_interaction_get` |

The visual tool is the UI bridge. Wrapping a tool result in generic execution
text such as `text(result)` only serializes a value into the conversation; it
does not invoke or prove a native UI surface. Do not replace a visual call
with a shell command, provider CLI, raw backend request or a hand-written
rendering.

Preserve the MCP result's `content`, `structuredContent`, and `_meta` when
passing it through the host. In particular, retain the visual resource
metadata, `loomex/taskWorkspace`, preparation review metadata and any other
hydration data. Keep the originating visual tool name and the exact stable
workflow, version, run or request identity. Do not flatten the result into
text and then claim that the card opened.

A returned result or a descriptor containing a resource URI proves that the
tool was called and that a view may be available. It does not by itself prove
that the host rendered the view. Say that a view opened or was rendered only
when the host supplies direct evidence of that event. Otherwise report the
tool result and state that native rendering was not observed.

## One exact card per visual operation

The visual tool owns the card for its operation. Keep one exact card for the
selected target and operation:

- A run setup card carries the selected workflow/version, the task workspace
  context or explicit workspace, collected inputs, and any preparation review
  binding. It does not start a run by being displayed.
- A preparation card carries the exact canonical workspace and provider/
  execution binding returned by prepare. Review and commit remain separate;
  never create a second card with guessed or rewritten facts.
- A UI-channel interaction card carries the exact pending request, run and
  organization identities plus its complete typed schema. Let the card own
  question navigation, answer preview and submission; do not prefetch it into
  a second form or submit from a duplicate card. Persist the exact returned
  `viewSessionId` when available and carry only that documented value on an
  explicit reopen; never invent a Codex or host session ID.

For all three cases, a handoff or follow-up preserves the same IDs and sealed
arguments. An accepted mutation remains accepted if a later UI handoff fails;
the handoff must not replay it. A status view is a snapshot and does not start
polling. A UI-channel pending interaction is shown once and is reopened only on
explicit request.

## Headless fallback and payload truth

If direct native invocation is unavailable, use the paired headless tool above
against the same resolved workflow/version, run ID or request ID. Preserve the
same query, cursor, workspace choice and preparation/interaction identity.
Headless fallback is a read or a focused question for the user; it must not
replay a mutation, create a new run, prepare again, answer on the user's
behalf, or manufacture a replacement card. A chat-channel long-text request is
the deliberate exception to visual delivery: its `interaction_get` data is
presented in chat and answered there, with no textarea card. For run setup, `loomex_workflow_get`
can expose the input schema and workflow facts, but setup and preparation
authorization still follow [execution guidance](execution.md).

Treat authoritative payload shape as evidence. An explicitly returned empty
array means empty. A missing array, missing object, missing schema,
truncated/spooled page or malformed visual payload means unavailable or
invalid; it is not an empty catalog, an empty answer form or a successful
render. Follow response pages from offset zero through completion when the
result contains a `responseRef`, and report an inability to verify the full
payload rather than filling the gap with defaults.

## Verification scope

Some Codex hosts require direct tool invocation to be enabled for the Loomex
namespace. For those hosts, diagnostics should verify the supported host
setting `features.code_mode.direct_only_tool_namespaces` includes
`mcp__loomex`, alongside the installed tool descriptors and visual resource
metadata. This is host configuration: the plugin can advertise its visual
tools but cannot enable or enforce the host setting.

Installed transport checks can verify that the packaged skill links resolve,
the MCP server advertises the intended visual resource metadata, the paired
tools return the canonical `content` and `structuredContent`, and the cached
HTML resource renders in a browser harness. Those checks verify transport and
resource behavior. They do not establish that a real Codex host rendered a
native card in a conversation.

Record native rendering only from an authorized host observation that includes
the relevant tool identity and rendered surface. Keep that observation
separate from source-only, installed-transport and browser-resource tests.
