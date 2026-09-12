#!/usr/bin/env node
/** Print a deterministic plugin component contract from a source or cached package. */
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

function usage() {
  throw new Error("usage: export-plugin-components.mjs --package-root DIR [--source-root DIR] [--output FILE] [--check]");
}

function argumentsFor(argv) {
  let packageRoot;
  let sourceRoot;
  let output;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--package-root") packageRoot = argv[++index];
    else if (argument === "--source-root") sourceRoot = argv[++index];
    else if (argument === "--output") output = argv[++index];
    else if (argument === "--check") check = true;
    else usage();
  }
  if (typeof packageRoot !== "string" || packageRoot.length === 0 ||
      (sourceRoot !== undefined && (typeof sourceRoot !== "string" || sourceRoot.length === 0)) ||
      (output !== undefined && typeof output !== "string")) usage();
  return {
    packageRoot: resolve(packageRoot),
    sourceRoot: sourceRoot === undefined ? undefined : resolve(sourceRoot),
    output: output === undefined ? undefined : resolve(output),
    check,
  };
}

const execFileAsync = promisify(execFile);

async function verifyUiAssets(packageRoot) {
  const assetsRoot = join(packageRoot, "assets");
  const [manifest, template, foundation, browserCode] = await Promise.all([
    readFile(join(assetsRoot, "ui-artifacts.json"), "utf8").then(JSON.parse),
    readFile(join(assetsRoot, "loomex-app.html"), "utf8"),
    readFile(join(assetsRoot, "frontend-design-system.css"), "utf8"),
    readFile(join(assetsRoot, "browser-application.js"), "utf8"),
  ]);
  if (manifest.schema !== "loomex/plugin-ui-assets/v2") throw new Error("packaged UI asset manifest has an unsupported schema");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  for (const [key, value] of [["templateSha256", template], ["foundationSha256", foundation], ["browserCodeSha256", browserCode]]) {
    if (manifest[key] !== hash(value)) throw new Error(`stale or tampered packaged UI asset: ${key}`);
  }
}

async function sourceIdentity(packageRoot, sourceRoot) {
  if (sourceRoot === undefined) return undefined;
  const [canonicalPackageRoot, canonicalSourceRoot] = await Promise.all([realpath(packageRoot), realpath(sourceRoot)]);
  if (canonicalPackageRoot !== canonicalSourceRoot) {
    throw new Error("source-root must identify the same directory as package-root; cached packages cannot claim source identity");
  }
  let revision;
  let status;
  try {
    ({ stdout: revision } = await execFileAsync("git", ["-C", canonicalSourceRoot, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" }));
    ({ stdout: status } = await execFileAsync("git", ["-C", canonicalSourceRoot, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" }));
  } catch (error) {
    throw new Error(`cannot establish source identity: ${error instanceof Error ? error.message : String(error)}`);
  }
  const headRevision = revision.trim();
  if (!/^[a-f0-9]{40,64}$/.test(headRevision)) throw new Error("source identity has an invalid HEAD revision");
  return { headRevision, workingTree: status.trim() === "" ? "clean" : "dirty" };
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
await verifyUiAssets(options.packageRoot);
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
const source = await sourceIdentity(options.packageRoot, options.sourceRoot);
const exported = source === undefined ? components : { ...components, source };
const artifact = canonicalJson(exported);
if (options.output !== undefined) await writeFile(options.output, artifact, { flag: "wx" });
if (options.check) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: exported.schemaVersion,
    toolCount: exported.tools.length,
    resourceCount: exported.resources.length,
    skillCount: exported.skills.length,
    hookCount: exported.hooks.length,
    ...(source === undefined ? {} : { source }),
    sha256: createHash("sha256").update(artifact).digest("hex"),
  })}\n`);
} else if (options.output === undefined) {
  process.stdout.write(artifact);
}
