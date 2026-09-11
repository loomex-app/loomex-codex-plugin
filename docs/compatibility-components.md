# Plugin component compatibility export

`npm run compatibility:export` evaluates the current Zod tool schemas and writes a deterministic JSON document to standard output. Pass `--output <new-file>` through to `dist/compatibility-check.mjs` when a durable artifact is needed. `npm run compatibility:check` performs the same export checks and prints only its schema version, component counts, and SHA-256.

The document uses `loomex.plugin-compatibility-components/v1` and contains the package identity, alphabetized tool records, canonical UI resources and deprecated aliases, required runner capabilities, skill tool references, and lifecycle hook bindings. A tool record contains its evaluated input JSON Schema, adapter-local fields, runner aliases and omissions, its mapped runner `outputSchema` SHA-256, and its canonical UI resource URI when it opens a card. The output digest binds the runner response contract before the adapter applies its MCP result schema or compact model projection; it does not describe an MCP envelope. The document intentionally does not claim backend-route or installed-host compatibility; those are separate components of the combined compatibility manifest.

The checker can inspect a package root directly:

```sh
node /path/to/cached/plugin/dist/compatibility-check.mjs --package-root /path/to/cached/plugin --check
```

It imports that package's bundled `dist/compatibility-export.mjs`, then reads its pinned runner method catalog, package manifest, skills, and hooks. This makes a cached-package check evaluate the packaged catalog instead of the source checkout.

The check fails if an evaluated tool input no longer maps exactly to a public runner method, a local-only key is absent from its Zod schema, an alias is ambiguous, a required `method:*` capability is missing, a UI URI is unknown or duplicated, a skill names an unknown tool, or a hook does not target the packaged lifecycle adapter.

## UI resource migration

New tool metadata must use an entry in `src/ui-resources.ts` and its canonical `ui://loomex/<view>.html` URI. Historical `ui://loomex/<view>-0.2.x.html` identities are explicit deprecated aliases in that same registry; they are only for restoring already-open cards and resolve to the canonical resource's renderer. Do not add an alias merely to rename a new view.

Removing or changing an alias requires a new compatibility-manifest version, an explicit catalog migration note, and cached-package evidence that no supported installed task still depends on it. Until then, leave the alias in the registry and keep its replacement URI stable. The template registration reads the same registry, so the export, MCP discovery, and alias handling cannot drift independently.
