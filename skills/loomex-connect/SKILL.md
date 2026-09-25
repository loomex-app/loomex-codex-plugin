---
name: loomex-connect
description: Check Loomex connection, sign in safely, and report the selected organization context.
---

# Connect Loomex

Read [the operation contract](references/common.md) before using tools.
Read [the visual delivery contract](references/visual-delivery.md) when using the connection card.

Call the installed Loomex MCP tools directly through `mcp__loomex` (start with `mcp__loomex.loomex_connection_get`). In Codex, the Loomex namespace can be direct-only: its absence from `functions.exec` or `ALL_TOOLS` does not mean the plugin is unavailable. Follow the operation contract's tool-availability rules before reporting an installation problem.

For an explicit request to connect or sign in, first call `loomex_connection_get`. In a host that supports native Loomex views, open exactly one card: `loomex_organizations_view` when authenticated with no selected organization, or `loomex_connection_view` otherwise. The Connection card owns explicit sign-in and recovery, and advances to organization selection in the same card when authentication completes. Do not start a second flow, repeat the organization's list in chat, or ask the user to select an organization in chat while a native picker is available. A card observes runner authority; opening it never authorizes authentication or selects an organization.

For a headless check, call `loomex_readiness` and `loomex_auth_status`. If the runner is already ready and authenticated, report its selected organization and do not restart sign-in. Organization scope is runner-wide; it is not chosen implicitly for each request. If there is no selected organization, call `loomex_organizations_list`, ask the user to choose one, then call `loomex_organization_select` for that choice. For a headless sign-in request, reuse an unexpired `browser_pending` flow or start one flow with `loomex_auth_start` and a retained idempotency key when signed out or expired. Fresh-read `loomex_connection_get` and provide its current URL as a Markdown link. Do not claim which browser the host will open. Never expose passwords, authorization codes, PKCE verifiers or tokens.

When the authoritative state is `recovery_pending`, use `loomex_auth_recover` only for an explicit connect or recovery request. It reconciles the exact credential operation already stored by the runner and never starts a new login. Re-read connection state afterward. A backend outage retains the pending operation and is retryable; an unavailable or expired recovery requires the explicit Reconnect flow. Never clear recovery flags, invent a replacement operation, or delete credentials as a shortcut.

The runner owns the browser callback and credential exchange. A Sign in click in the card starts or reconciles one flow, verifies its current URL, and asks the runner to launch that exact URL once. The pending card offers Open browser again and a copyable link in a fallback disclosure. The card cannot append an assistant message to the existing chat turn. Never treat a browser launch request as authentication completion. The runner's callback and a fresh connection read establish completion.

If the user returns after closing the browser, a restart, or an interrupted local observation, read the exact connection/auth state again and reopen the existing connection view when requested. Do not start a second browser flow while the first one is still valid. A lost final response is recovered with a fresh status read, not by replaying a mutation.

Use `loomex_auth_logout` only when logout is explicitly requested. Safe logout must refuse while the runner reports active managed work that requires the connection; explain the returned recovery step and preserve the local cleanup evidence. A successful logout removes the runner's local authentication state according to the runner contract; it does not delete workflows, workspace files or backend organization data.

List organizations and select only the organization the user chose. Switching is an explicit runner-wide scope change and must not happen as a side effect of a failed lookup or workflow operation. Report connection state, selected organization and any remaining setup requirement.

The Connection card owns sign-in and sign-out. After sign-in, it shows organization selection within the same card when needed. A new Connect command from an authenticated installation without a selected organization opens the dedicated Organizations view. Do not open a second card or repeat its displayed status in chat.
