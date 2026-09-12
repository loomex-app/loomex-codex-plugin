import * as assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";

import {
  createPluginCompatibilityComponents,
  runnerOutputSchemaDigest,
  validateSkillAndHookReferences,
  validateToolMappings,
} from "../src/compatibility-export.js";
import { TOOL_DEFINITIONS } from "../src/tool-catalog.js";

const execFile = promisify(execFileCallback);

async function filesUnder(root: string, current = root): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) paths.push(...await filesUnder(root, path));
    else if (entry.isFile()) paths.push(path.slice(root.length + 1));
  }
  return paths.sort();
}

async function packageLayout() {
  const skillRoot = "skills";
  const skillFiles = (await filesUnder(skillRoot)).filter((path) => /\.(?:md|ya?ml)$/.test(path));
  return {
    manifest: JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8")),
    hooks: JSON.parse(await readFile("hooks/hooks.json", "utf8")),
    files: (await filesUnder("hooks")).map((path) => `hooks/${path}`),
    skills: await Promise.all(skillFiles.map(async (path) => ({
      path: `skills/${path}`,
      source: await readFile(join(skillRoot, path), "utf8"),
    }))),
  };
}

test("plugin component export is deterministic and covers the evaluated public catalog", async () => {
  const layout = await packageLayout();
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { name: string; version: string };
  const runnerCatalog = JSON.parse(await readFile("contracts/method-catalog.json", "utf8")) as { methods: Parameters<typeof validateToolMappings>[0] };
  validateToolMappings(runnerCatalog.methods);

  const first = createPluginCompatibilityComponents(packageJson, layout, runnerCatalog.methods);
  const second = createPluginCompatibilityComponents(packageJson, layout, runnerCatalog.methods);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.schemaVersion, "loomex.plugin-compatibility-components/v1");
  assert.equal(first.tools.length, 71);
  assert.equal(first.resources.length, 7);
  assert.equal(first.skills.length, 17);
  assert.equal(first.hooks.length, 5);
  assert.ok(first.resources.every((resource) => Array.isArray(resource.aliases)));
  assert.ok(first.tools.every((tool) => tool.inputSchema !== undefined));
  assert.ok(first.tools.every((tool) => typeof tool.runnerOutputSchemaSha256 === "string" && /^[a-f0-9]{64}$/.test(tool.runnerOutputSchemaSha256 as string)));
  const artifactDownload = runnerCatalog.methods.find((method) => method.name === "artifacts.download");
  assert.ok(artifactDownload);
  // This is the runner's compact sorted JSON plus terminal newline digest.
  assert.equal(runnerOutputSchemaDigest(artifactDownload.outputSchema), "6537798ab0a9ce9421698f615761ad72678e89d06053aa82a06bb37b4711ef54");
});

test("component export rejects stale skill tools and hook entrypoints", async () => {
  const layout = await packageLayout();
  const staleSkill = layout.skills.find((skill) => skill.path === "skills/loomex-answer/SKILL.md");
  assert.ok(staleSkill);
  assert.throws(() => validateSkillAndHookReferences({
    ...layout,
    skills: [{ ...staleSkill, source: `${staleSkill.source}\nloomex_retired_tool` }],
  }), /unknown tool/);

  const invalidHooks = structuredClone(layout.hooks) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  invalidHooks.hooks.SessionStart![0]!.hooks[0]!.command = "node hooks/other.mjs";
  assert.throws(() => validateSkillAndHookReferences({ ...layout, hooks: invalidHooks }), /lifecycle adapter/);
});

test("tool mapping validation fences mapped field schema drift", async () => {
  const runnerCatalog = JSON.parse(await readFile("contracts/method-catalog.json", "utf8")) as {
    methods: Array<{ name: string; inputSchema: { properties: Record<string, unknown> }; outputSchema: unknown }>;
  };
  const update = TOOL_DEFINITIONS.find(({ name }) => name === "loomex_view_session_update");
  assert.ok(update);
  const statusSchema = update.inputSchema.shape.status;
  assert.ok(statusSchema);
  assert.equal(z.safeParse(statusSchema, "active").success, true);
  assert.equal(z.safeParse(statusSchema, "resolved").success, true);
  assert.equal(z.safeParse(statusSchema, "arbitrary").success, false);

  const incompatible = structuredClone(runnerCatalog.methods);
  const runnerUpdate = incompatible.find(({ name }) => name === "presentation.sessions.update");
  assert.ok(runnerUpdate);
  runnerUpdate.inputSchema.properties.status = { type: "string", enum: ["active"] };
  assert.throws(() => validateToolMappings(incompatible), /loomex_view_session_update\.status.*outside the runner enum/);
});

test("component export changes when a mapped runner output schema changes", async () => {
  const layout = await packageLayout();
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { name: string; version: string };
  const runnerCatalog = JSON.parse(await readFile("contracts/method-catalog.json", "utf8")) as { methods: Parameters<typeof validateToolMappings>[0] };
  const changedMethods = structuredClone(runnerCatalog.methods) as Array<{
    name: string;
    inputSchema: { properties: Record<string, unknown>; required?: readonly string[] };
    outputSchema: unknown;
  }>;
  const changedMethod = changedMethods.find((method) => method.name === "presentation.sessions.update");
  assert.ok(changedMethod);
  changedMethod.outputSchema = { oneOf: [{ type: "object", properties: { changed: { type: "boolean" } } }] };
  const original = createPluginCompatibilityComponents(packageJson, layout, runnerCatalog.methods);
  const changed = createPluginCompatibilityComponents(packageJson, layout, changedMethods);
  const originalTool = original.tools.find((tool) => tool.name === "loomex_view_session_update");
  const changedTool = changed.tools.find((tool) => tool.name === "loomex_view_session_update");
  assert.ok(originalTool && changedTool);
  assert.notEqual(originalTool.runnerOutputSchemaSha256, changedTool.runnerOutputSchemaSha256);
});

test("cached-package compatibility checker evaluates its bundled exporter", async (t) => {
  const cachedRoot = await mkdtemp(join(tmpdir(), "loomex-component-cache-"));
  t.after(async () => { await rm(cachedRoot, { recursive: true, force: true }); });
  await mkdir(join(cachedRoot, "dist"));
  await mkdir(join(cachedRoot, "assets"));
  await Promise.all([
    cp("package.json", join(cachedRoot, "package.json")),
    cp(".codex-plugin", join(cachedRoot, ".codex-plugin"), { recursive: true }),
    cp("contracts", join(cachedRoot, "contracts"), { recursive: true }),
    cp("hooks", join(cachedRoot, "hooks"), { recursive: true }),
    cp("skills", join(cachedRoot, "skills"), { recursive: true }),
    cp("assets/ui-artifacts.json", join(cachedRoot, "assets/ui-artifacts.json")),
    cp("assets/loomex-app.html", join(cachedRoot, "assets/loomex-app.html")),
    cp("assets/frontend-design-system.css", join(cachedRoot, "assets/frontend-design-system.css")),
    cp("assets/browser-application.js", join(cachedRoot, "assets/browser-application.js")),
    cp("dist/compatibility-export.mjs", join(cachedRoot, "dist/compatibility-export.mjs"), { recursive: false }),
    cp("dist/compatibility-check.mjs", join(cachedRoot, "dist/compatibility-check.mjs"), { recursive: false }),
  ]);
  const { stdout } = await execFile(process.execPath, [
    join(cachedRoot, "dist/compatibility-check.mjs"),
    "--package-root", cachedRoot,
    "--check",
  ]);
  const result = JSON.parse(stdout) as { toolCount: number; resourceCount: number; skillCount: number; hookCount: number; sha256: string };
  assert.deepEqual({ ...result, sha256: typeof result.sha256 }, {
    schemaVersion: "loomex.plugin-compatibility-components/v1",
    toolCount: 71,
    resourceCount: 7,
    skillCount: 17,
    hookCount: 5,
    sha256: "string",
  });
  assert.equal("source" in result, false);
  await rm(join(cachedRoot, "assets/browser-application.js"));
  await assert.rejects(execFile(process.execPath, [
    join(cachedRoot, "dist/compatibility-check.mjs"), "--package-root", cachedRoot, "--check",
  ]), /browser-application|ENOENT/);
});

test("source compatibility export binds identity only to the exported source tree", async () => {
  const { stdout } = await execFile(process.execPath, [
    "dist/compatibility-check.mjs",
    "--package-root", process.cwd(),
    "--source-root", process.cwd(),
    "--check",
  ]);
  const result = JSON.parse(stdout) as { source?: { headRevision: string; workingTree: string } };
  assert.match(result.source?.headRevision ?? "", /^[a-f0-9]{40}$/);
  assert.match(result.source?.workingTree ?? "", /^(?:clean|dirty)$/);

  const unrelated = await mkdtemp(join(tmpdir(), "loomex-other-source-"));
  try {
    await assert.rejects(execFile(process.execPath, [
      "dist/compatibility-check.mjs",
      "--package-root", process.cwd(),
      "--source-root", unrelated,
      "--check",
    ]), /same directory/);
  } finally {
    await rm(unrelated, { recursive: true, force: true });
  }
});
