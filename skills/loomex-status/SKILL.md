---
name: loomex-status
description: Read the current state of one existing Loomex run once; does not continuously monitor it.
---

# Loomex Run Status

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.
Read [the visual delivery contract](../loomex-workflows/references/visual-delivery.md) for the status snapshot view and headless fallback boundary.

Resolve one existing run and call `loomex_run_get` once. Report its authoritative execution state, meaningful current stage and whether human input is pending. Fetch only response pages needed to read this snapshot. Do not follow nextAction into waits, retrieve unrelated catalog state, open question cards or start another run. For an explicitly requested visual snapshot use `loomex_run_view`. Suggest follow or answer when relevant, but do not invoke them unless requested.
