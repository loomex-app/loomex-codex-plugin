---
name: loomex-workspaces
description: List or manage Loomex workspace execution grants; does not run workflows.
---

# Loomex Workspaces

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.

This is an advanced workspace-management command, not a prerequisite screen during a normal run. Registration alone never authorizes a command or workflow execution; every run still requires its exact preparation confirmation.

With no mutation request, call `loomex_workspaces_list`. For grant/revoke, resolve the user's selected organization and exact absolute workspace path; explain that host_user/v1 is host-user execution, not containment. Use `loomex_workspace_grant` or `loomex_workspace_revoke` only for the selected scope and report the authoritative canonical path/result. A revoke removes a remembered grant; do not claim it canceled active execution or deleted workspace files.
