---
name: loomex-connect
description: Check Loomex connection, sign in safely, and report the selected organization context.
---

# Connect Loomex

Read [the operation contract](references/common.md) before using tools.
Read [the visual delivery contract](references/visual-delivery.md) when using the connection card.

Use the connection view for an interactive request when the host supports it: call `loomex_connection_view`, which reads the authoritative connection state and presents sign-in, recovery, sign-out and organization selection actions in one flow. The view is a convenience surface and does not authorize an action by itself. If a visual view cannot be opened or the user asks for a headless result, use `loomex_connection_get` and the focused headless tools below.

For a headless check, call `loomex_readiness` and `loomex_auth_status`. If the runner is already ready and authenticated, report its selected organization and do not restart sign-in. Organization scope is runner-wide; it is not chosen implicitly for each request. If there is no selected organization, call `loomex_organizations_list`, ask the user to choose one, then call `loomex_organization_select` for that choice.

For requested sign-in, use `loomex_auth_start`, show only the returned verification URI, user code, expiry and polling interval, then poll `loomex_auth_poll` at that interval until completion, expiry or a concrete error. The user completes authentication in the browser or device flow. Never request, receive or paste credentials, tokens, recovery codes or provider secrets into chat. Do not use a web organization-admin page as a plugin fallback; organization membership and selection belong to the runner's connection flow.

If the user returns after closing the browser, a restart, or an interrupted poll, read the exact connection/auth state again and reopen the existing connection view when requested. Do not start a second device flow while the first one is still valid. A lost final response is recovered with a fresh status read, not by replaying a mutation.

Use `loomex_auth_logout` only when logout is explicitly requested. Safe logout must refuse while the runner reports active managed work that requires the connection; explain the returned recovery step and preserve the local cleanup evidence. A successful logout removes the runner's local authentication state according to the runner contract; it does not delete workflows, workspace files or backend organization data.

List organizations and select only the organization the user chose. Switching is an explicit runner-wide scope change and must not happen as a side effect of a failed lookup or workflow operation. Report connection state, selected organization and any remaining setup requirement.

The Connection card owns sign-in and sign-out. Its organization action navigates within the same card. Do not open a second card or repeat its displayed status in chat.
