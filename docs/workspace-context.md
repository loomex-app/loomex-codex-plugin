# Codex project directory context

Run setup, workflow browsing and details require the active task's actual `taskContext.cwd`. When a supported Codex interface supplies the current project's complete directory membership, callers may also supply `taskContext.projectDirectories`. Do not substitute filesystem permissions, unrelated folders, plugin cwd, prior chats or private host storage. The current supported project interface exposes one path, so automatic multi-directory discovery is not yet qualified.

Without an override, setup includes verified project directories plus explicitly selected `additionalWorkspacePaths`. A `workspacePath` override replaces the project set; only explicitly selected extras remain. Changing the primary directory in setup clears inherited extras. Existing setup controls expose additional paths under the directory disclosure, one absolute path per line. Five list items, shared styling and the existing lifecycle remain unchanged.

The runner canonicalizes and deduplicates all roots, registers them using the existing grant store, and seals the exact set into preparation. The UI displays the primary path and an expandable count of additional directories. Additional roots require negotiated `execution.workspace-set/v1` plus qualified provider support. Unsupported providers fail before Start; roots are never silently omitted.

Headless calls and the terminal RPC client accept the same `additionalWorkspacePaths` array for workspace grant and run preparation. Retain original mutation keys after ambiguity. Restoration verifies the original preparation, not current project membership. Completed Start remains read-only, and native workflow authoring remains chat-based without workspace/provider cards.

The runner owns the detailed protocol specification at `runner/docs/workspace-set.md`; the plugin pins exact exported contracts. No home-directory persistence layer or UI run polling is introduced.
