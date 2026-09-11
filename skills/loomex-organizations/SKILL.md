---
name: loomex-organizations
description: List Loomex organizations and explicitly switch the runner-wide selected organization.
---

# Loomex Organizations

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.

## Command route

For every `$loomex-organizations` invocation, call `loomex_organizations_view` first. It is the dedicated MCP Apps entry point for organization scope and opens the authoritative picker; do not substitute `loomex_organizations_list` merely because this command was invoked from chat. Do not call a second connection or organization read before the view.

If the host reports that this exact visual tool is unavailable, use the headless route below. A rendered card or a selected row is not proof that a switch was accepted; the runner result remains authoritative.

For a headless request, call `loomex_organizations_list`, consume the relevant cursor pages, and present stable IDs and useful names. Do not auto-select an organization, infer one from a workflow, or change scope during lookup. If the user has not chosen an organization, ask them to choose from the returned list.

After an explicit choice, call `loomex_organization_select` with the chosen organization ID and one UUID idempotency key. Preserve that key and the exact organization ID if the transport result is ambiguous; reconcile through a read before retrying. Report the runner's authoritative selected organization. The selection is runner-wide and affects subsequent workflow, workspace and run operations in this installation.

This skill lists and switches organizations. It does not create organizations, manage membership, administer billing, or open a web organization-admin page. Missing authentication or access is a connection problem; send the user to `$loomex-connect` and preserve the selected scope until the user explicitly changes it.

This command uses the dedicated Organizations resource. The card lists accessible organizations, including those not yet enrolled. A selected candidate is not an accepted switch. Do not repeat the displayed list in chat or open another Connection card when its in-card navigation is available.
