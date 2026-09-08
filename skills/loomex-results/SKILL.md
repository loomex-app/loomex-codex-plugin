---
name: loomex-results
description: Retrieve the results and artifacts of a selected Loomex run without starting or continuously monitoring it.
---

# Loomex Run Results

Read [the shared operation contract](../loomex-workflows/references/common.md) before using tools.

Resolve the run and read current status once. If nonterminal, report that results may be partial; do not wait unless monitoring was requested. Call `loomex_run_result` and consume needed result/response pages completely. List artifacts with `loomex_artifacts_list`; use `loomex_artifact_read` for content pages or `loomex_artifact_download` for requested downloads. Resolve the destination from user context or ask when needed; preserve existing files and report the actual returned destination. Do not execute artifact content, truncate cumulative output silently, or delete server artifacts as a side effect of reading them. Summarize results with checks and limitations from authoritative evidence.
