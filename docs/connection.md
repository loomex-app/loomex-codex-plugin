# Connection and organization scope

Loomex connection is owned by the local runner. The plugin has no credentials and does not perform backend sign-in itself. The user signs in through a runner-owned authorization-code and PKCE flow in a browser. The runner stores the resulting credentials in the native credential store.

The connection surface is available through `loomex_connection_get` and `loomex_connection_view`. The data tool is the headless read and recovery path. Connection handles sign-in, recovery and sign-out, then advances to organization selection within the same card when needed. A later Connect command for an authenticated installation without a selected organization opens the dedicated `loomex_organizations_view`. The runner remains authoritative for authentication and organization scope.

In Codex, use the direct `mcp__loomex` tool surface for connection reads and actions. When `features.code_mode.direct_only_tool_namespaces` includes `mcp__loomex`, the `functions.exec` wrapper and its `ALL_TOOLS` inventory intentionally omit those tools. Their absence there is not an installation or runner-health failure. Diagnose availability through direct tool exposure and an actual direct call; distinguish an absent direct tool from a returned runner error or a successful `signed_out` state.

The connection flow is:

1. Read readiness and authentication state. An already connected runner is not sent through sign-in again.
2. In a UI-capable host, open one Connection card and let the user explicitly start sign-in there. After the runner accepts Start, the card verifies the current flow and asks the local runner to launch its sealed authorization URL once through an app-only operation. The pending card offers Open browser again; its copyable URL stays in a disclosure until requested or launching fails. For headless sign-in, reuse a pending flow or start one with the focused auth tool, then present the current URL in chat. An OS launch acknowledgement does not prove that the page loaded or that sign-in completed.
3. The runner receives the loopback callback and completes the credential exchange. The visible card reads local connection state every five seconds as a quiet background observation. Only changed connection state updates the card; explicit Refresh uses the visible refresh lifecycle.
4. Once the runner confirms sign-in and no organization is selected, show Organizations in the same card and fetch the authoritative list. Remount verifies state before enabling selection. A new Connect request may open the dedicated Organizations resource directly.
5. Wait for an explicit organization choice, including when only one organization is available. Headless hosts list organizations and ask in chat.

The plugin never asks for passwords, authorization codes, PKCE verifiers, tokens or provider credentials. Users enter their account credentials only on the backend's browser page. That page cannot be embedded in the MCP card: it requires a first-party browser origin for its CSRF-protected form and denies framing. Moving the form into the card would require a separately designed, reviewed authentication protocol rather than passing credentials through the plugin. Membership and scope come from the runner and backend authorization.

The selected organization is runner-wide for the authenticated installation. It is used by later workflow, workspace and run operations. Loomex never auto-selects an organization from a workflow name, workspace, previous task or failed operation. Use `$loomex:loomex-connect` to list available organizations and switch only after the user names the desired organization.

Logout is an explicit, safety-sensitive request. The runner stops admitting new work, lets idle lease and heartbeat sessions close, then revokes credentials. It refuses to interrupt an active provider job; that job must finish before retrying. Preserve the returned cleanup or recovery state and explain what must finish. A successful logout clears local authentication state according to the runner contract; it does not delete workflows, organization data or workspace files. If a logout response is lost, read connection/auth status before considering another attempt.

## Headless tool workflow

Use the focused tools when visual delivery is unavailable or not requested:

- `loomex_readiness` and `loomex_auth_status` inspect local runner and authentication state.
- `loomex_auth_start` begins browser authentication; the runner completes it after its callback. `loomex_auth_cancel` cancels one pending flow without signing out.
- `loomex_organizations_list` lists available organizations; `loomex_organization_select` applies an explicit choice.
- `loomex_auth_logout` requests safe logout after the user explicitly asks for it.

These names describe the intended connection contract. The installed runner and UI worker are authoritative for the exact availability, response shape and lifecycle outcome. A host that cannot render the connection view must retain the headless path rather than inventing a browser interaction.

## Dedicated views and restoration

Connection and Organizations use separate content-addressed `ui://loomex/…` resources. Resource identity establishes the initial page and changes whenever the packaged HTML, design system, or browser application changes, preventing a host cache from pairing a new server with an old card. In-card navigation updates owner-local presentation state without opening another card. The `connection.views.create/get/update` API stores page and pending mutation arguments/key in the runner's protected SQLite presentation store, under a separate local scope that works before sign-in. It grants no backend authority. Remount always reads current authentication and organization data; loading and busy flags are never restored.

Organizations are fetched on opening and refresh, including when one is already selected. Accessible unenrolled entries remain selectable: explicit submission invokes the existing enrollment/selection operation. Search filters the complete returned list, with five entries per page. Failed refresh retains the old list as unverified and disables switching; only successful empty responses show an empty state. Selection affects subsequent operations, not existing run or preparation bindings.

Verification polling belongs to the active login flow. Copying, opening the browser and navigating do not cancel it. Hiding/unmounting suspends polling; visible restoration checks the current flow. Pending mutations retain their original arguments and idempotency key; retry first reads current state, then reuses that operation only if needed. No navigation or refresh initiates authentication, enrollment or logout.

The loopback callback page uses the frontend-owned browser-auth stylesheet embedded in the runner binary. The backend approval and runner completion pages share the generated design export while remaining independently deployable. The callback reports sign-in success only after the runner has durably stored credentials; organization selection still happens in the card.

The optional web-app destination comes from the runner's `webAppUrl`, configured at build time through `LOOMEX_WEB_APP_ORIGIN` and validated as an HTTPS origin. If unset, no web-app link is rendered. Verification links continue to come from the active authentication flow.
