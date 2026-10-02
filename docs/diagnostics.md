# Read-only plugin diagnostics

Run `scripts/lifecycle.sh diagnostics` against an installed plugin, optionally
with `--install-base DIR`. The shell finds the installed pinned runtime and
packaged lifecycle manager. The action runs before mutation locks, bootstrap
creation or journal handling. It never repairs state, rewrites Codex settings,
creates a presentation session, invokes a visual tool, starts authentication,
changes scopes, creates a context, answers a question, or starts a run.

The JSON contract is `app.loomex.plugin.diagnostics/v1`, defined and decoded by
`src/lifecycle/diagnostics-contract.ts`. Every named check appears once, with
an independent `verified`, `failed` or `unknown` state and a fixed code.
Failure of one check does not turn every later check into failure. Missing
observations remain unknown. Successful installation or parsed settings do not
prove a native card rendered in the current conversation.

Checks cover current machine paths, ownership receipt, the complete retained
package inventory, generated absolute launcher paths, the actual packaged MCP
process version/tool descriptors, all nine freshly read visual resources,
owner-checked socket and negotiated runner compatibility, explicit build-metadata availability, available fingerprint statistics, parsed Codex routing, and known
service destinations. MCP inspection uses initialization, tools/resources
listing and resource reads only. It does not invoke any tool or reproduce an
existing mutation. Runner diagnostics is a discovery read; no provider file
content is hashed for this report. Package inventory verification hashes the
installed plugin payload against its existing receipt.

Plugin diagnostics does not execute the runner CLI or call `connection.get`:
legacy CLI diagnostics and authenticated connection reads can access native
credentials or resume a login listener. `runner_build` is therefore unknown
with `CREDENTIAL_FREE_BUILD_METADATA_UNAVAILABLE`, and
`frontend_destination` is unknown with
`CREDENTIAL_FREE_DESTINATION_UNAVAILABLE`. No credential-free canonical build
or frontend configuration field is available to this action. The new runner's
separate explicit `loomex diagnostics` command reports its own CLI build;
that does not prove the daemon build, which remains independently unknown.

Internal plugin diagnostics requests `includeFingerprintDiagnostics: true`
only when negotiation advertises `diagnostics.fingerprint/v1`; older daemons
receive ordinary `{}` and statistics remain unknown. The public readiness tool
keeps its empty input and ordinary status response. Backend destination also
remains unknown without a safe canonical field. Configured URLs, when examined
elsewhere, must exclude query strings/fragments and reject embedded credentials;
a loopback URL requires that service on this machine. Plugin diagnostics does
not look up destinations through authentication or start a process to discover
them. Missing receipt/inventory verification never permits an authentication
read. Safe socket/status/config checks remain independent.

The selected Codex `config.toml` is parsed by the pinned pure-JavaScript
`smol-toml` parser, bundled into `lifecycle.mjs` through the existing esbuild
and locked `npm ci` build. The retained BSD-3-Clause notice is packaged under
`plugin/licenses/smol-toml-LICENSE`. Diagnostics reports only the relevant
namespace array and explicit enabled setting, never the full config. Config
inspection does not resolve all running-host layers or prove effective routing.

If the routing check reports `routing_missing`, manually merge `mcp__loomex`
into the existing array, retaining every other namespace and enabled setting:

```toml
[features.code_mode]
direct_only_tool_namespaces = ["mcp__loomex"]
```

This is an example to merge, not a replacement configuration. The plugin never
writes it. A missing render acknowledgement does not imply a routing failure
or authorize a second card. Invoke available visual tools directly through the
host MCP surface. Use headless reads only for an explicit user choice,
unavailable direct invocation, or established host UI incompatibility.

Supported installation regenerates the machine-specific launcher paths.
Copying another machine's cache is unsupported. Resource/browser fixture
checks, installed CLI/MCP checks and actual native card observations are
separate evidence.

## Optional operator stage timings

Set `LOOMEX_DIAGNOSTICS_TIMINGS=1` for an operator-controlled MCP process to
emit `loomex.plugin.operator-timing/v1` JSON lines on stderr for preparation
review enrichment and presentation persistence. The ordinary 30-second local
request budget and the existing five-second optional enrichment/persistence
budgets stay unchanged. Timings use a monotonic clock and report only the fixed
stage/method, duration, optional correlation UUID and definitive-success,
definitive-failure or unknown outcome. Prompts, workflow bodies, answers,
provider content and credentials are excluded. Logging failure never changes
an accepted result. These records are diagnostics, not card messages or
execution authority. A successful preparation remains accepted when optional
review enrichment or presentation persistence is unavailable; reconcile the
same preparation instead of preparing a replacement.

For a disabled Start action, use the existing preparation review and lifecycle
explanation to identify missing verification, stale/expired binding or an
unresolved original operation. Diagnostics does not enable Start, reapprove,
commit, or manufacture proof of readiness.
