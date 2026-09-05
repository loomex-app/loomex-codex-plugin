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

All input objects are strict. If a workflow-definition field can recursively contain arbitrary JSON, retain the 0.1.0 rejection of objects whose `source` is `secret`. There is no secret-input or provider-credential feature in this release.

## Tool and UI rules

Each public runner method needs one focused MCP definition and one method-specific strict result schema. Tool text must state full-host authority wherever the user grants a workspace or approves execution. Keep the prepare and commit operations separate; commit may only send the IDs and digest produced by the reviewed preparation.

All operations must work headlessly. Adding a UI resource cannot be the only way to complete a lifecycle step. UI resources must call registered tools through the MCP Apps bridge, render tool results as untrusted data, remain self-contained, and retain a CSP with no external network. The current resources support only inline display and must fail back to headless tools when initialization is unavailable.

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
- unique focused 0.1.0 tool discovery and strict schemas;
- same-connection capability negotiation before each owner-checked local action;
- rejection of unknown inputs and secret-source definitions before RPC;
- exactly one classified read transport retry and no automatic replay after an ambiguous mutation;
- safe error redaction and malformed-result rejection;
- large-response spool projections;
- refusal of a group/world-accessible socket; and
- four portable UI resources with CSP and no external URL or legacy host bridge.

Packaging tests build deterministic fixture manifests, reject forbidden development or credential-like paths, detect tampering, verify explicit unsafe-development installation, and uninstall only the versioned fixture. The Node runtime test downloads the exact `darwin-arm64` archive pinned in `scripts/node-runtime.lock.json`, verifies its SHA-256, and starts the compiled server with that runtime. It requires network access to the pinned Node distribution URL.

CI runs these checks on macOS arm64 and also validates a packaged development plugin with Codex CLI 0.146.0. These are source and fixture validations. They do not authenticate a real Loomex account, deploy or migrate the backend, execute real provider sessions, prove Desktop UI behavior or accessibility in every supported Codex surface, qualify a production-signed artifact, or confirm revocation of historical remote credentials.

## Packaging boundaries

Release packaging creates a versioned plugin tree plus a bundled Node runtime. It renders `.mcp.json` with absolute paths to the installed runtime and compiled server, so the installed plugin does not depend on the host `PATH`, current directory, raw TypeScript, or global npm modules.

Production packaging requires a clean Git revision, a Developer ID Application identity, a Keychain notarization profile, and an RSA manifest-signing key. It signs the bundled Node executable with hardened runtime and a secure timestamp, submits the payload for notarization, and performs `codesign` and `spctl` verification. Unsigned development output is accepted only with both the build/install development flag and `LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1`.

Do not put `.env` files, keys, credentials, logs, caches, source-control metadata, test output, or dependency trees into an artifact. See `scripts/validate_package.py` for the enforced inventory.

## Decision and release references

Use the [clean-slate baseline](../../planning/plugin-runner-clean-slate/README.md), [runtime contract](../../planning/plugin-runner-clean-slate/runtime-contract.md), [requirements matrix](../../planning/plugin-runner-clean-slate/requirements-capability-acceptance.md), and [superseded decision index](../../planning/plugin-runner-clean-slate/superseded-decisions-index.md) when behavior changes. The [release gate list](../../planning/plugin-runner-clean-slate/release-gates.md) records verification that still needs real environments. A passing local test run must not be reported as satisfying those gates.
