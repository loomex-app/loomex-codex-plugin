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

## Progressive restoration (0.14.7)

All cards start with one skeleton only while the bounded owner-checked snapshot
is loading. Once it arrives, a bounded display projection replaces the generic
loader while the full session, domain state, answer draft, and pending operation
are reconciled. The projection has no editable answer, workspace, credential,
or mutation material. Controls remain inert until the exact authoritative read
completes. Resolved cards are displayed read-only.

Forward-session transitions retain this safe display state until the destination
finishes hydration. Stale callbacks cannot reveal a newer session. Snapshot and
verification failures preserve the readable projection and expose a retry for
the failed section. This is separate from quiet background autosave. The host
still owns iframe sizing.

The 2048 follow incident (01207e75-77bf-4731-af29-ca8fcb836380) again ended
with an active runner nextAction at sequence 69. No recovery or automation calls
were present in the follow task. Durable recovery support is available but was
not invoked by the host model. This release does not claim that host behavior is
fixed or that a schedule was registered for that run.

## Unified lifecycle (integration Phase 3)

`ViewRestorationCoordinator` is the lifecycle owner for all eight resources.
`SessionNavigationController` supplies the domain adapter for workflow, run,
setup/review, interaction and authoring pages; `ConnectionController` supplies
an adapter backed by the dedicated pre-enrollment connection store. Connection
hydration no longer has independent ready/loading flags.

The adapter stages are snapshot, display, authoritative verification, journal
reconciliation, permitted draft restoration, final projection, and readiness.
A display-only snapshot never grants authority, including a cached read-only
snapshot. A successful verification callback enables setup auto-preparation;
rendering a provisional snapshot cannot do so. Journal recovery is projected
again after draft restoration so an unresolved response keeps its exact answers
and retry identity locked.

Restoration, persistence, completion and refresh have independent state. The
Phase 2 mutation controller remains the sole owner of mutation stages and exact
operation tuples. The lifecycle does not copy journal arguments into display
state. Save status is aggregated across draft, presentation and connection
stores: a successful draft save cannot hide a presentation conflict. A save
retry may be offered with verified identity, but the mutation pipeline must
finish required durable writes before dispatch.

List navigation and refresh do not wait for presentation writes. Refresh keeps
existing content, and an unchanged request/schema retains mounted answer
controls. Different request or schema identities replace the form and invalidate
its draft scope. Conflict recovery offers explicit reload or reapplication;
reapplication reads the current revision, preserves saved recovery references,
and refuses a completed/forwarded view or unresolved saved operation. It never
changes an ambiguous domain operation's key.

The coordinator owns restoration/refresh deadlines, request lanes and cleanup.
A timeout fences late results; disposal settles local waits and releases polling
resources. Authentication polling is independently fenced by flow and request,
remains alive during copy/browser actions, and stops when hidden, expired,
replaced or disposed. Run monitoring remains owned by chat.

No persisted shape meaning changed in this phase. Connection search, page and
candidate are optional additions to its existing state object. Normal presentation
state remains version 1, and unknown declared versions fail closed. No browser
storage or additional home-directory store is used.

### Continuation delivery

The presentation session may contain a version-1 `continuationDelivery` record.
It stores only safe continuation text, purpose/identity, attempt ID and observed
host-delivery status. Sending is persisted before the host call; remount converts
an unfinished Sending to Unknown. Acknowledged does not prove execution or
monitoring. Unknown never automatically retries. Explicit rejection permits a
user-initiated delivery-only retry after an authoritative read. Domain journals,
accepted answers and approved Start remain independent of this record.

Start and interaction continuation use the same service and a self-contained
Markdown `ui/message`, including the JSON context block. They do not depend on a
separate `ui/update-model-context` attachment. Read-only completion remains intact
when presentation persistence or host delivery fails.
