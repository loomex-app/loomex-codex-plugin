# Plugin development

The plugin is an ESM TypeScript project built as one bundled Node.js MCP server. Development and release validation use Node.js 24.20.0; `package.json` accepts Node `>=24.20.0 <25`, and `package-lock.json` pins dependency resolution.

## Local workflow

From the plugin repository:

```sh
npm ci
npm run typecheck
npm test
```

`npm run build` bundles `src/index.ts` and its local modules to `dist/server.js` for Node 24. `npm test` performs that build, bundles the TypeScript integration test, and runs it with Node's test runner. The MCP test starts a fake owner-only runner socket and exercises the compiled stdio server through the MCP SDK.

Useful source entry points are:

- `src/server.ts`: MCP server, tool registration, annotations, safe text projections, and per-method timeouts.
- `src/tool-catalog.ts`: focused MCP names, strict inputs, mutation metadata, and UI-resource associations.
- `src/ui-resources.ts` and [`compatibility-components.md`](compatibility-components.md): canonical UI identities, deprecated aliases, and the deterministic component export used by CI and cached-package checks.
- `src/local-control.ts`: socket ownership checks, framing, ambiguity classification, cancellation, and response validation.
- `src/protocol.ts` and `src/result-schemas.ts`: common envelope and strict method-specific result schemas.
- `src/ui.ts` and `assets/loomex-app.html`: optional portable MCP Apps resources.
- `contracts/`: vendored runner-owned v2 schema, method catalog, and digest pin.

## Contract changes

The runner owns `loomex.local-control/v2`. Change its canonical `runner/contracts/local-control.schema.json` and `runner/contracts/method-catalog.json` first. Then, as one reviewed change:

1. Copy both canonical files byte-for-byte into the plugin's `contracts/` directory.
2. Recompute their SHA-256 values and update `contracts/contract-pin.json`.
3. Update `src/tool-catalog.ts` for every externally exposed input and `src/result-schemas.ts` for every result shape.
4. Keep `protocol.negotiate` and `daemon.drain` runner-internal unless a new current decision explicitly exposes them.
5. Run type checking and the full MCP integration test.

The current release script packages the checked-in contract directory; it does not perform step 1. Never treat a successful package build alone as proof that the two repositories agree.

A mutating tool must accept a UUID `idempotencyKey`, must be marked mutating in the canonical catalog, and must preserve the key in an ambiguous result. Do not add automatic mutation retries. Any retry after `NETWORK_AMBIGUOUS` represents the same logical operation and uses the original key.

All input objects are strict. If a workflow-definition field can recursively contain arbitrary JSON, reject objects whose `source` is `secret`. There is no secret-input or provider-credential feature in this release.

## Tool and UI rules

Each public runner method needs one focused MCP definition and one method-specific strict result schema. Adapter-only fields must be declared in `localOnlyInputKeys`, stripped before local-control, and tested against the pinned runner schema. Tool text must distinguish workspace registration from execution authorization. The final run review states full-host authority; an already selected task workspace needs no separate grant dialog. Keep the prepare and commit operations separate; commit may only send the IDs and digest produced by the reviewed preparation.

All operations must work headlessly. Adding a UI resource cannot be the only way to complete a lifecycle step. UI resources must call registered tools through the MCP Apps bridge, render tool results as untrusted data, remain self-contained, and retain a CSP with no external network. The current resources support only inline display and must fail back to headless tools when initialization is unavailable.

Human-question resources treat the runner's `humanRequest.inputSpec` as the authoritative presentation contract. They render text, long text, date, rating, boolean, radio, and checkbox questions in single or mixed batch forms. The response schema supplies required-field hints and remains the generic custom-schema fallback when an input spec is absent. Unknown or malformed typed input specs fail visibly instead of being reinterpreted as another question type. Submissions contain answer fields only; prompt text, option labels, input types, and other server-authored metadata are never copied into the response. The UI never displays transport JSON or a raw JSON answer editor. Unsupported custom schemas direct users to the conversation and disable submission. Prepared runs retain readable authorization details; errors expose only a friendly message and an optional validated support reference.

After `NETWORK_AMBIGUOUS` or `IDEMPOTENCY_REQUEST_IN_PROGRESS`, the UI retains an immutable copy of the complete tool arguments, including the UUID. It locks the displayed answer controls and offers an explicit server-state refresh. If the request remains pending, retry sends that exact retained argument object even if the DOM was changed outside the UI. If refresh reports an answered or resolved request, the form and retry action are removed.

The browser suite uses the pinned Playwright dependency. A normal `npm test` runs it when a local Chromium browser is available and otherwise records a skip. The release gate is explicit and does not skip:

```sh
npx playwright install chromium
npm run test:ui
```

Set `LOOMEX_BROWSER_EXECUTABLE` to exercise another local Chromium executable. Set `LOOMEX_UI_SCREENSHOT_DIR` when running `npm run test:ui` to capture light, dark, and narrow-viewport review images.

The plugin must not read Keychain, accept backend or provider credentials, call the backend, execute provider binaries, or infer authority from UI state. Its socket client should expose only safe error codes and correlation IDs, never arbitrary runner error text.

## Validation

Run the source checks before review:

```sh
npm ci
npm run typecheck
npm test
./scripts/test-packaging.sh
./scripts/test-node-runtime.sh
```

The test suite currently checks:

- exact contract hashes and catalog/schema coverage;
- unique focused 0.2.5 tool discovery and strict schemas;
- same-connection capability negotiation before each owner-checked local action;
- rejection of unknown inputs and secret-source definitions before RPC;
- exactly one classified read transport retry and no automatic replay after an ambiguous mutation;
- safe error redaction and malformed-result rejection;
- large-response spool projections;
- refusal of a group/world-accessible socket;
- five portable UI resources with CSP and no external URL or legacy host bridge; and
- authoritative seven-type question rendering and answer-only submissions in a real browser, including mixed batches, Other fields, accessible control names, validation, draft preservation, duplicate-click suppression, immutable ambiguous retry, and read reconciliation.

Packaging tests build deterministic fixture manifests, reject forbidden development or credential-like paths, detect tampering, verify explicit unsafe-development installation, and uninstall only the versioned fixture. The Node runtime test downloads the exact `darwin-arm64` archive pinned in `scripts/node-runtime.lock.json`, verifies its SHA-256, and starts the compiled server with that runtime. It requires network access to the pinned Node distribution URL.

CI runs these checks on macOS arm64 and also validates a packaged development plugin with Codex CLI 0.146.0. These are source and fixture validations. They do not authenticate a real Loomex account, deploy or migrate the backend, execute real provider sessions, prove Desktop UI behavior or accessibility in every supported Codex surface, qualify a production-signed artifact, or confirm revocation of historical remote credentials.

## Packaging boundaries

Release packaging creates a versioned plugin tree plus a bundled Node runtime. It renders `.mcp.json` with absolute paths to the installed runtime and compiled server, so the installed plugin does not depend on the host `PATH`, current directory, raw TypeScript, or global npm modules.

Production packaging requires a clean Git revision, a Developer ID Application identity, a Keychain notarization profile, and an RSA manifest-signing key. It signs the bundled Node executable with hardened runtime and a secure timestamp, submits the payload for notarization, and performs `codesign` and `spctl` verification. Unsigned development output is accepted only with both the build/install development flag and `LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1`.

Do not put `.env` files, keys, credentials, logs, caches, source-control metadata, test output, or dependency trees into an artifact. See `scripts/validate_package.py` for the enforced inventory.

## Decision and release references

Use the [clean-slate baseline](../../planning/plugin-runner-clean-slate/README.md), [runtime contract](../../planning/plugin-runner-clean-slate/runtime-contract.md), [requirements matrix](../../planning/plugin-runner-clean-slate/requirements-capability-acceptance.md), and [superseded decision index](../../planning/plugin-runner-clean-slate/superseded-decisions-index.md) when behavior changes. The [release gate list](../../planning/plugin-runner-clean-slate/release-gates.md) records verification that still needs real environments. A passing local test run must not be reported as satisfying those gates.

### Prepared execution presentation

The prepare view leads with verified workflow/organization names and the exact version number, workspace, AI provider/model, startup inputs and macOS execution authority. Internal identifiers and provider installation fingerprints are available in a collapsed reference section. Startup provider overrides remain visible. No raw JSON is shown.

The provider list confirms the selected model and installed adapter only. Account-specific model access remains unknown until the provider accepts a turn. A provider model rejection is shown with a targeted, safe recovery message; it never authorizes an automatic model substitution or run replay.

Successful preparation tools may attach `loomex/preparationReview` in MCP result `_meta`. Workflow and organization names use bounded read-only lookups; provider/model labels come only from the prepared root and referenced-workflow model-resolution snapshots. This display-only projection is resolved and is matched by schema version, preparation ID, binding digest, workflow/version IDs and organization ID before use. A failed or mismatched name lookup must never invent a label, modify the binding, or turn a successful preparation into a failed mutation. The UI disables Start until a complete, valid, matching name projection is available, and directs unresolved reviews to the conversation. Commit arguments remain the original preparation ID, digest, confirmation key and idempotency UUID.

The prepare view's runner check is a read-only status check that retains preparation state. Content resize notifications use the standard [MCP Apps size-changed notification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) so hosts can fit the view as cards wrap or references expand. Browser tests cover mobile/light/dark layouts, hidden references, name binding, and unchanged commit arguments after a status check.

### Shared design system

Every custom view uses the tokens and components documented in [design-system.md](design-system.md). Styling must not branch on `data-mode`; differences come from semantic components and action variants. Content-size reporting applies to all five resources. Run the shared browser visual matrix when changing tokens, shell layout, forms, status messages or actions.

Workflow browser coverage exercises search, empty results, forward/back cursor pages, details/back, read failure and recovery, text-safe labels, task-workspace metadata retention, manual and explicit workspace selection, and preparation handoff without execution. Verify an installed cached package discovers five resources and the list tool advertises the browser resource.

### Native visual tool delivery

Visual commands must retain their native MCP invocation identity and complete structured result. Generic executor text output, including `text(result)`, is not a renderer. Follow the package-local visual delivery contract for the relevant retained skill (for example, [`loomex-browse`](../skills/loomex-browse/references/visual-delivery.md)) for visual entry points and headless recovery.

Codex supports a narrowly scoped routing configuration in its user config:

```toml
[features.code_mode]
direct_only_tool_namespaces = ["mcp__loomex"]
```

Merge this into existing configuration, preserving other namespaces and the existing enabled state. Do not disable code mode globally or rewrite unrelated settings. The plugin cannot enforce this host setting. Restart the desktop host after changing routing so the active task receives the new tool surface. See the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Regression checks distinguish explicitly empty pages from missing or malformed payloads. Test native structured data, hydration metadata, safe model-facing page summaries and typed-schema availability. Then test an installed Codex direct invocation both with the normal host configuration and with code mode enabled in an isolated process. Record native desktop rendering separately; a successful CLI call or browser harness does not establish that the desktop mounted a card.

### Frontend design-system delivery

The custom views consume a generated offline export of the frontend UI CSS, not a separate theme. When changing styles or utility classes, run `npm run design:sync` and `npm run design:check` against the intended frontend checkout, then review the generated CSS/provenance diff. The UI renderer verifies the packaged CSS hash before serving a resource. Follow [design-system.md](design-system.md) for source ownership, fixed dark-mode semantics, and accessibility adaptations. Set `LOOMEX_DESIGN_SCREENSHOT_DIR` while running the Chromium suite to inspect every resource and its error state.
