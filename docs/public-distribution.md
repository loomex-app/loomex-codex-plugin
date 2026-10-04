# Immutable public distribution

Public repository: `loomex-app/loomex-codex-plugin`. The paired release and unified
installer are distributed by `loomex-app/loomex-runner`. An explicit release set
selects one exact runner revision and one exact plugin revision, their versions,
platform, component manifest hashes, outer archive hashes and sizes, and passing
compatibility evidence. The initial public channel is an unsigned development
preview for isolated evaluation; it does not carry production assurance.

The release-set schema is `app.loomex.release-set/v2`. Its initial paired tag is
`preview-runner-v<RUNNER_VERSION>-plugin-v<PLUGIN_VERSION>`. Component URLs use
that exact tag in `releases/download`; they never use `latest`. Both component
assets live on the runner's paired release. A plugin draft may mirror its
component archive, but is not an independently selected compatible installation.

The release set seals an explicit `deployment` profile. The initial local
preview uses `{"profile":"local-development","apiOrigin":"http://127.0.0.1:28080/","webAppOrigin":null}`;
null preserves the runner’s unset web application origin. Its verified runner
metadata is `metadata/local-development-origin.json`. The unified installer
passes the existing `--development-api-origin` option and requires the explicit
unsafe development opt-in. A `cloud-preview` profile instead binds a canonical
HTTPS DNS API root and uses `--preview-api-origin` with the same opt-in. Version 1
release sets and mixed profile metadata are rejected; changing profiles requires
a separately verified release set. The plugin envelope and lifecycle command
remain identical for these profiles.

## What is shipped

`loomex-plugin-<VERSION>-darwin-arm64-preview.tar.gz` is a flat archive with:

- The unchanged existing release envelope: `manifest.json`,
  `source-content.json`, and `payload.tar.gz`; production also includes `manifest.sig`.
- The manifest-bound bootstrap `lifecycle-runtime/node` and `lifecycle.mjs`.
- `scripts/install.sh`, `scripts/lifecycle.sh`, and `scripts/uninstall.sh`, whose
  bytes, modes, and sizes match the source manifest used by the compiled build.
- `plugin-components.json`, exported by the packaged Node and compiled
  compatibility checker from the actual extracted plugin payload. Public CI uses
  `--qualify-clean-source`: it verifies a clean exact HEAD and the full recorded
  source inventory, rebuilds source bundles and requires byte equality with the
  verified payload, then exports the matching clean source identity through the
  packaged checker. Dirty local qualification archives omit this identity and
  cannot satisfy the required clean paired release gate.
- `public-distribution.json`, binding the exact paired tag, component repository,
  source revision, version, preview policy, manifest hash, and outer file inventory.

The nested payload includes `.codex-plugin`, canonical MCP resources/tools,
assets, hooks, skills, contracts, bundled server and compatibility modules,
lifecycle manager, runtime licenses, dependency licenses, and Node.js 24.20.0.
Neither outer nor inner archive requires npm, Python, a source checkout, system
Node, Git, or credentials for installation. Python is only a maintainer packaging
dependency. Checkout metadata, environment files, test outputs, and dependencies
used for building are excluded. The outer SHA-256 and size are carried by the
paired release set; the adjacent `.tar.gz.sha256` is a convenient checksum
sidecar, not an independent trust root. Outer metadata is a hashed inventory,
not an additional signature.

## Maintainer checkpoint

1. Freeze the reviewed plugin source revision and version; regenerate the
   committed offline frontend assets before freezing. Select the compatible
   runner revision and establish passing compatibility evidence.
2. Run `preview-release.yml` on that exact commit with the runner's exact SemVer.
   It invokes `build-release.sh --unsigned-development` first. That builder
   compiles and tests before creating the provenance-bound envelope. Only then
   does `package-public-release.py` verify and export its compiled components.
   Regression tests consume that built envelope; source-only output is insufficient.
3. Download the candidate Actions artifact and review the paired tag, hashes,
   source revisions, preview policy, and compatibility evidence. Actions artifacts
   are candidate transport, not published public releases.
4. To stage a plugin component mirror, first create the reviewed paired Git tag
   pointing to the built plugin commit. Configure the GitHub environment
   `preview-release-review` with required maintainer reviewers, then dispatch
   with `stage_draft=true`. The protected job checks tag-to-commit identity and
   creates only a draft prerelease with `--verify-tag --draft --prerelease`.
   Existing drafts are not silently overwritten. No workflow publishes a release.
5. Assemble the runner's paired draft with both immutable archives, unified
   installer, release set, and passing compatibility evidence. Publication and
   signing remain explicit decisions after this review. Do not run a published
   installer until its complete release set is attached.

A GitHub environment name alone does not enforce review: required reviewers must
be configured in repository settings. The production workflow keeps its mandatory
Developer ID, Apple notarization, and manifest-signing secrets and verification.
Production archive export additionally requires a trusted manifest public key.
Unsigned preview does not bypass or claim any production checks.

For a local candidate, use the pinned Node on PATH, run the complete builder,
then package with the exact envelope revision:

```sh
./scripts/build-release.sh --unsigned-development --output /tmp/plugin-envelope
python3 scripts/package-public-release.py --release /tmp/plugin-envelope \
  --output /tmp/public/loomex-plugin-1.0.0-darwin-arm64-preview.tar.gz \
  --release-tag preview-runner-v1.0.0-plugin-v1.0.0 \
  --source-revision "$(git rev-parse HEAD)" --unsigned-preview
python3 scripts/test-public-release.py --release /tmp/plugin-envelope \
  --release-tag preview-runner-v1.0.0-plugin-v1.0.0
```

These versions are examples; use the frozen versions and commit of the actual
candidate. Dirty development snapshots retain content-level provenance but do
not establish that all contents belong to the claimed commit. Public maintainers
must build the reviewed clean commit in Actions before release staging.

## Installation and maintenance

The unified runner installer verifies the paired release set and outer component
checksums before safe extraction, then delegates to each owner's packaged
installer. The plugin delegate command is:

```sh
LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 "$EXTRACTED_PLUGIN/scripts/install.sh" \
  "$EXTRACTED_PLUGIN" --allow-unsigned-development --install-base "$PLUGIN_BASE"
```

The user must explicitly accept the unsigned development policy. This command is
for an isolated preview base chosen by the unified installer; do not infer opt-in
from a tag or archive. A production install requires the trusted manifest public
key and production checks instead. The bootstrap verifies bound runtime and
manager bytes before running the bundled manager. An exact healthy current release can be verified again after a host registration
failure without restaging or changing activation metadata. Same-version different
releases, modified installed bytes, a missing/altered/symlinked durable helper
(including changed file modes), noncurrent retained versions, and unrelated
unfinished journals are refused. A broken helper requires explicit repair; retry
verification does not rewrite it. The owner manager then verifies
the complete envelope and inventory, derives `.mcp.json` absolute paths, switches
`current` atomically, and maintains the durable ownership journal and receipt.

Register the stable plugin base in Codex as the `loomex-private` marketplace,
then add `loomex@loomex-private` through the user-visible installation flow.
Review and trust the packaged lifecycle hooks separately in Codex. Diagnostics
and routine local lifecycle operations use the extracted `scripts/lifecycle.sh`;
it launches the installed durable helper, so keeping the source checkout is
unnecessary. Use the same exact base with each command:

```sh
"$EXTRACTED_PLUGIN/scripts/lifecycle.sh" status --install-base "$PLUGIN_BASE"
"$EXTRACTED_PLUGIN/scripts/lifecycle.sh" diagnostics --install-base "$PLUGIN_BASE"
"$EXTRACTED_PLUGIN/scripts/uninstall.sh" --install-base "$PLUGIN_BASE"
```

For resume, rollback, repair, and prune, keep the release's required signature or
unsafe preview opt-in policy. See [release and lifecycle details](release.md).
Disable/remove the marketplace in Codex as part of uninstall; host registration
and hook trust are owned by Codex. Never delete versions or journals manually.

Public source visibility does not itself grant an open-source license. Review and
approve Loomex's distribution license/terms before publication; this change
preserves the bundled third-party notices and does not invent an application
license. The preview draft remains pending that maintainer review.

GitHub's [release-create CLI documentation](https://cli.github.com/manual/gh_release_create)
defines the draft, prerelease, and existing-tag flags used here. GitHub's
[environment documentation](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
describes required-reviewer protection for the staging checkpoint.
