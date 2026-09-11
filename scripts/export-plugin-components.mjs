#!/usr/bin/env node
/** Print a deterministic plugin component contract from a source or cached package. */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  throw new Error("usage: export-plugin-components.mjs --package-root DIR [--output FILE] [--check]");
}

function argumentsFor(argv) {
  let packageRoot;
  let output;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--package-root") packageRoot = argv[++index];
    else if (argument === "--output") output = argv[++index];
    else if (argument === "--check") check = true;
    else usage();
  }
  if (typeof packageRoot !== "string" || packageRoot.length === 0 || (output !== undefined && typeof output !== "string")) usage();
  return { packageRoot: resolve(packageRoot), output: output === undefined ? undefined : resolve(output), check };
}

async function filesUnder(root, current = root) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`package component check rejects symbolic links: ${relative(root, path)}`);
    if (entry.isDirectory()) result.push(...await filesUnder(root, path));
    else if (entry.isFile()) result.push(relative(root, path));
  }
  return result.sort();
}

async function skillsUnder(root) {
  const skillRoot = join(root, "skills");
  const files = await filesUnder(skillRoot);
  const skills = await Promise.all(files
    .filter((path) => /\.(?:md|ya?ml)$/.test(path))
    .map(async (path) => ({ path: `skills/${path}`, source: await readFile(join(skillRoot, path), "utf8") })));
  return skills.sort((left, right) => left.path.localeCompare(right.path));
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const options = argumentsFor(process.argv.slice(2));
if (!isAbsolute(options.packageRoot)) usage();
const exporterPath = join(options.packageRoot, "dist", "compatibility-export.mjs");
const exporter = await import(pathToFileURL(exporterPath).href);
const [packageJson, hooks, catalog, files, skills] = await Promise.all([
  readFile(join(options.packageRoot, "package.json"), "utf8").then(JSON.parse),
  readFile(join(options.packageRoot, "hooks", "hooks.json"), "utf8").then(JSON.parse),
  readFile(join(options.packageRoot, "contracts", "method-catalog.json"), "utf8").then(JSON.parse),
  filesUnder(join(options.packageRoot, "hooks")).then((files) => files.map((file) => `hooks/${file}`)),
  skillsUnder(options.packageRoot),
]);

if (!Array.isArray(catalog.methods)) throw new Error("runner method catalog has no methods array");
exporter.validateToolMappings(catalog.methods);
const components = exporter.createPluginCompatibilityComponents(packageJson, {
  manifest: JSON.parse(await readFile(join(options.packageRoot, ".codex-plugin", "plugin.json"), "utf8")),
  hooks,
  files,
  skills,
}, catalog.methods);
const artifact = canonicalJson(components);
if (options.output !== undefined) await writeFile(options.output, artifact, { flag: "wx" });
if (options.check) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: components.schemaVersion,
    toolCount: components.tools.length,
    resourceCount: components.resources.length,
    skillCount: components.skills.length,
    hookCount: components.hooks.length,
    sha256: createHash("sha256").update(artifact).digest("hex"),
  })}\n`);
} else if (options.output === undefined) {
  process.stdout.write(artifact);
}
