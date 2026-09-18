# Connection and organization scope

Loomex connection is owned by the local runner. The plugin has no credentials and does not perform backend sign-in itself. The user authenticates through the runner's browser device flow, while the runner stores and protects the resulting local authentication state.

The connection surface is available through the intended `loomex_connection_get` and `loomex_connection_view` tools. `loomex_connection_get` is the headless read for scripts, hosts without MCP Apps rendering, and recovery after a browser or UI interruption. `loomex_connection_view` focuses account connection only: sign-in, recovery, and sign-out. It shows the selected organization as context but does not offer organization selection. `loomex_organizations_view` is the dedicated visual organization picker. A visual card is a presentation surface; readiness, authentication, organization selection and logout results still come from the runner.

The connection flow is:

1. Read readiness and authentication state. An already connected runner is not sent through sign-in again.
2. For a requested sign-in, start the device flow and display only its verification URI, user code, expiry and polling interval.
3. Let the user finish in the browser. Poll at the returned interval until the runner reports success, expiry or a concrete error.
4. Read the connection state again after browser completion, a restart, a closed tab or an interrupted poll. Reopen the same connection view when the user asks to continue the visual flow.
5. List organizations and wait for an explicit organization choice when more than one is available.

The plugin never asks for passwords, tokens, recovery codes or provider credentials. Users should enter authentication data only in the browser device flow. The plugin does not provide a web organization-admin fallback; membership and scope come from the runner and backend authorization.

The selected organization is runner-wide for the authenticated installation. It is used by later workflow, workspace and run operations. Loomex never auto-selects an organization from a workflow name, workspace, previous task or failed operation. Use `$loomex:loomex-connect` to list available organizations and switch only after the user names the desired organization.

Logout is an explicit, safety-sensitive request. The runner may refuse logout while active managed work still depends on the connection. Preserve the returned cleanup or recovery state and explain what must finish before retrying. A successful logout clears local authentication state according to the runner contract; it does not delete workflows, organization data or workspace files. If a logout response is lost, read connection/auth status before considering another attempt.

## Headless tool workflow

Use the focused tools when visual delivery is unavailable or not requested:

- `loomex_readiness` and `loomex_auth_status` inspect local runner and authentication state.
- `loomex_auth_start` begins the browser device flow; `loomex_auth_poll` completes it.
- `loomex_organizations_list` lists available organizations; `loomex_organization_select` applies an explicit choice.
- `loomex_auth_logout` requests safe logout after the user explicitly asks for it.

These names describe the intended connection contract. The installed runner and UI worker are authoritative for the exact availability, response shape and lifecycle outcome. A host that cannot render the connection view must retain the headless path rather than inventing a browser interaction.

## Dedicated views and restoration

Connection and Organizations use separate content-addressed `ui://loomex/…` resources. Resource identity establishes the initial page and changes whenever the packaged HTML, design system, or browser application changes, preventing a host cache from pairing a new server with an old card. In-card navigation updates owner-local presentation state without opening another card. The `connection.views.create/get/update` API stores page and pending mutation arguments/key in the runner's protected SQLite presentation store, under a separate local scope that works before sign-in. It grants no backend authority. Remount always reads current authentication and organization data; loading and busy flags are never restored.

Organizations are fetched on opening and refresh, including when one is already selected. Accessible unenrolled entries remain selectable: explicit submission invokes the existing enrollment/selection operation. Search filters the complete returned list, with five entries per page. Failed refresh retains the old list as unverified and disables switching; only successful empty responses show an empty state. Selection affects subsequent operations, not existing run or preparation bindings.

Verification polling belongs to the active login flow. Copying, opening the browser and navigating do not cancel it. Hiding/unmounting suspends polling; visible restoration checks the current flow. Pending mutations retain their original arguments and idempotency key; retry first reads current state, then reuses that operation only if needed. No navigation or refresh initiates authentication, enrollment or logout.

The optional web-app destination comes from the runner's `webAppUrl`, configured at build time through `LOOMEX_WEB_APP_ORIGIN` and validated as an HTTPS origin. If unset, no web-app link is rendered. Verification links continue to come from the active authentication flow.
