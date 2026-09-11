# Interaction release verification

The 0.12.5 cached package differed from the 0.12.5 working tree. Testing the
working tree therefore did not establish that Codex was using those fixes.
Version 0.12.9 packages the current interaction lifecycle and follow contract.

## Required behavior

- Single-question drafts use the backend node ID, falling back to `answer`
  only when no node ID exists. Batch drafts retain authored question IDs.
- Reopening reads the exact request before restoring a saved review. Accepted
  requests render submitted answers without an editable form or another handoff.
- Successful chat handoff is not a second answer-review card.
- Run timestamps are visible text, not information-button tooltips.
- An active live-follow update is commentary followed by another bounded wait.
  Terminal results, human input, user stop and actionable failures end the loop.
  Host interruption remains possible; verified same-task recovery is a fallback,
  not a claim that the plugin controls the host's turn lifetime.

## Package acceptance

Use the pinned Node runtime. Regenerate the design-system export after changing
the package version; its manifest is version-bound. Run the browser tests with
real Chromium, including single acceptance, stale pending remounts, draft races,
and ambiguous-response recovery. Recovery fixtures must return a request for
the initial authoritative read, not consume a future mutation receipt there.

After packaging, reinstall through Codex's supported local marketplace flow.
Compare cached UI and skill hashes with the packaged source. Verify MCP discovery
from the installed launcher. A passing source test alone is not installed-host
acceptance. Existing cards and loaded MCP processes may still retain old bytes;
test the new package in a fresh task without starting a replacement for an
existing workflow run.
