# View state and workflow continuation

A card is a projection of authoritative state, not the execution controller.

| State | Owner and restoration |
| --- | --- |
| Browser query, cursor stack, selected workflow/version, unsent search | Runner presentation session; reload exact metadata before restoring navigation |
| Setup fields and workspace edit intent | Presentation session bound to workflow/version; rerender controls from current schema |
| Preparation and run transition | Durable operation journal and forward-session references; reconcile receipt before showing the destination |
| Interaction answers, question position, review phase | Backend request draft bound to request/schema digest; fresh request state takes precedence |
| Submitted answers and editability | Backend resolved request; render read-only even if the saved phase says review. A resolved view session is re-read against the exact request on remount before showing the completed card |
| Disclosure expansion and document reading position | Presentation session; restore after final hydration render, position only on the same screen |
| Builder response draft and phase | Authoring presentation session; authoritative builder state determines whether submission remains valid |
| Execution progress, approval requirement, completion | Backend run and node state; always refresh before reporting or offering an action |
| Recovery attempt and schedule identity | Runner recovery journal plus actual host schedule read-back |

Do not persist spinners, pending button flags, connectivity, disabled attributes,
DOM nodes, credentials, or a second copy of authoritative execution state.
Autosave remains serialized with revision and idempotency checks. Explicit
submission waits for durable writes. Visibility/pagehide flushes reduce loss on
closure but are best effort: an iframe can be destroyed before the RPC completes.
Only an acknowledged write counts as saved. The host owns scrolling outside the
iframe; the plugin restores only its own document reading position.

Terminal executions and resolved interaction cards may mark their presentation
session `resolved` after authoritative hydration. That marker is a lifecycle
hint for restoration, never a substitute for the backend run or request state;
the remount read still decides whether the card is complete and read-only.

## Incident: missing final approval

Run e481abc0-6436-4a29-95f0-794911f98089 remained at idea_input. The chat ended
its live checks and treated the subsequent idea as standalone development work;
there was no interaction response or workflow implementation execution. Therefore
approval was never reached. Keep an unfinished run as conversation context,
fresh-read it on an idea/feedback message, then route a clear answer through the
exact pending request schema. Do not execute the workflow's implementation in
the host chat or equate local files with terminal workflow completion. This is
host guidance, not a guarantee that the host model will obey it. Live acceptance
must verify actual response submission and the approval node.

## Preparation restoration (0.13.2)

Following a saved setup-to-preparation link must adopt the verified
`loomex/preparationReview` metadata returned by `loomex_preparation_get`, using
the same identity/digest validation as a newly rendered preparation. The saved
session contains navigation references, not review authority. Dropping that
metadata made a valid restored preparation fail `preparationReviewable`, leaving
Start disabled after loading. Preparation refresh also preserves the returned
metadata. Missing or mismatched metadata continues to fail closed.

A browser regression reproduces the setup-forward-session remount, waits for
both authoritative restoration and persistence hydration, and verifies that
Start submits the original preparation ID, binding digest, and confirmation key.

## Restoration loading (0.13.3)

All cards start with a single restoration skeleton. Content and actions remain
inert and visually hidden while the exact session, domain state, answer draft,
and pending operation are reconciled. Forward-session transitions retain the
loader until the destination finishes hydration. Stale hydration callbacks
cannot reveal a newer session. Errors release the loader so retry controls are
accessible. This loader is separate from background autosave, which stays quiet.
The reserved initial height reduces collapse; the host still owns iframe sizing.

The 2048 follow incident (01207e75-77bf-4731-af29-ca8fcb836380) again ended
with an active runner nextAction at sequence 69. No recovery or automation calls
were present in the follow task. Durable recovery support is available but was
not invoked by the host model. This release does not claim that host behavior is
fixed or that a schedule was registered for that run.
