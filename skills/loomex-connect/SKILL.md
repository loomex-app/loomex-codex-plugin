---
name: loomex-connect
description: Check runner readiness, sign-in, and organization selection for Loomex connection or access requests.
---

# Connect Loomex

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.

Check `loomex_readiness` and `loomex_auth_status`. If already ready, report the selected organization; do not restart sign-in. For requested sign-in use `loomex_auth_start`, display the verification URI/user code, and poll `loomex_auth_poll` at the returned interval until completion, expiry or a concrete error. The user completes browser authentication; never request credentials. List organizations and select the one the user chose. If multiple organizations remain possible, ask for selection. Use `loomex_auth_logout` only when logout is explicitly requested, preserving recoverable cleanup outcomes. Report connection status and any remaining setup requirement.
