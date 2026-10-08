import * as assert from "node:assert/strict";
import { cp, lstat, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

import { TOOL_DEFINITIONS } from "../src/tool-catalog.js";

const SOURCE_SKILLS_ROOT = resolve(import.meta.dirname, "../skills");

const VISUAL_SKILL_NAMES = [
  "loomex-browse",
  "loomex-create",
  "loomex-runs",
  "loomex-connect",
  "loomex-run",
] as const;

const VISUAL_TOOL_PAIRS = [
  ["loomex_workflows_view", "loomex_workflows_list"],
  ["loomex_workflow_view", "loomex_workflow_get"],
  ["loomex_run_setup", "loomex_workflow_get"],
  ["loomex_runs_view", "loomex_runs_list"],
  ["loomex_run_view", "loomex_run_get"],
  ["loomex_interaction_view", "loomex_interaction_get"],
  ["loomex_personas_view", "loomex_personas_list"],
] as const;

interface PackagedFile {
  readonly path: string;
  readonly relativePath: string;
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

async function packagedFiles(root: string, current = root): Promise<PackagedFile[]> {
  const files: PackagedFile[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(path);
      } catch {
        assert.fail(`broken symbolic link in packaged skills: ${relative(root, path)}`);
      }
      assert.ok(isInside(root, target), `symbolic link escapes packaged skills: ${relative(root, path)}`);
      continue;
    }
    if (entry.isDirectory()) files.push(...await packagedFiles(root, path));
    else if (entry.isFile()) files.push({ path, relativePath: relative(root, path) });
  }
  return files;
}

function yamlScalar(source: string, key: string): string | undefined {
  const lines = source.split(/\r?\n/);
  const keyPattern = new RegExp(`^(\\s*)${key}:\\s*(.*)$`);
  for (let index = 0; index < lines.length; index += 1) {
    const match = keyPattern.exec(lines[index] ?? "");
    if (match === null) continue;
    const raw = (match[2] ?? "").trim();
    if (/^[>|][+-]?$/.test(raw)) {
      const indentation = (match[1] ?? "").length;
      const body: string[] = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const line = lines[next] ?? "";
        if (line.trim() !== "" && (line.match(/^\s*/)?.[0].length ?? 0) <= indentation) break;
        body.push(line.trim());
      }
      return body.join(raw.startsWith(">") ? " " : "\n").trim();
    }
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        return JSON.parse(raw) as string;
      } catch {
        return undefined;
      }
    }
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'");
    return raw.replace(/\s+#.*$/, "").trim();
  }
  return undefined;
}

function frontmatter(markdown: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  assert.ok(match, "SKILL.md must start with YAML frontmatter");
  return match[1] ?? "";
}

function markdownDestinations(markdown: string): string[] {
  const destinations: string[] = [];
  const patterns = [
    /!?\[[^\]]*]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+["'][^)\n]*["'])?\s*\)/g,
    /^\s{0,3}\[[^\]]+]:\s*(<[^>\n]+>|\S+)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) destinations.push(match[1] ?? "");
  }
  return destinations;
}

async function assertLocalLinkResolves(skillsRoot: string, sourcePath: string, rawDestination: string): Promise<void> {
  const unwrapped = rawDestination.startsWith("<") && rawDestination.endsWith(">")
    ? rawDestination.slice(1, -1)
    : rawDestination;
  if (unwrapped === "" || unwrapped.startsWith("#") || /^(?:https?|mailto|data):/i.test(unwrapped)) return;
  assert.doesNotMatch(unwrapped, /^file:/i, `file URL in ${relative(skillsRoot, sourcePath)} is not package-local`);

  const pathPart = unwrapped.split(/[?#]/, 1)[0] ?? "";
  if (pathPart === "") return;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    assert.fail(`invalid encoded link in ${relative(skillsRoot, sourcePath)}: ${rawDestination}`);
  }
  const target = resolve(dirname(sourcePath), decoded);
  assert.ok(isInside(skillsRoot, target), `link escapes packaged skills in ${relative(skillsRoot, sourcePath)}: ${rawDestination}`);
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(target);
  } catch {
    assert.fail(`broken local link in ${relative(skillsRoot, sourcePath)}: ${rawDestination}`);
  }
  assert.ok(isInside(skillsRoot, canonicalTarget), `link resolves through a symlink outside packaged skills in ${relative(skillsRoot, sourcePath)}: ${rawDestination}`);
}

test("packaged Loomex skills are self-contained and match the MCP tool catalog", async (t) => {
  const temporaryDirectory = await mkdtemp(join(await realpath(tmpdir()), "loomex-packaged-skills-"));
  t.after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });
  const skillsRoot = join(temporaryDirectory, "skills");
  await cp(SOURCE_SKILLS_ROOT, skillsRoot, { recursive: true, verbatimSymlinks: true });

  const rootEntries = await readdir(skillsRoot, { withFileTypes: true });
  const skillFolders = rootEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.ok(skillFolders.length > 0, "packaged skills must contain at least one skill");
  assert.deepEqual(skillFolders, ["loomex-browse", "loomex-connect", "loomex-create", "loomex-persona", "loomex-run", "loomex-runs"]);

  await t.test("skill manifests and optional UI metadata identify their own skill", async () => {
    for (const folderName of skillFolders) {
      const skillPath = join(skillsRoot, folderName, "SKILL.md");
      assert.ok((await lstat(skillPath)).isFile(), `${folderName}/SKILL.md is missing`);
      const markdown = await readFile(skillPath, "utf8");
      const manifest = frontmatter(markdown);
      assert.equal(yamlScalar(manifest, "name"), folderName, `${folderName}/SKILL.md name must match its folder`);
      assert.ok(yamlScalar(manifest, "description")?.trim(), `${folderName}/SKILL.md needs a nonempty description`);

      const openAiPath = join(skillsRoot, folderName, "agents/openai.yaml");
      try {
        const openAi = await readFile(openAiPath, "utf8");
        assert.ok(yamlScalar(openAi, "display_name")?.trim(), `${folderName}/agents/openai.yaml needs display_name`);
        const shortDescription = yamlScalar(openAi, "short_description")?.trim() ?? "";
        assert.ok(
          shortDescription.length >= 25 && shortDescription.length <= 64,
          `${folderName}/agents/openai.yaml short_description must contain 25–64 characters`,
        );
        const defaultPrompt = yamlScalar(openAi, "default_prompt")?.trim();
        assert.ok(defaultPrompt, `${folderName}/agents/openai.yaml needs default_prompt`);
        assert.doesNotMatch(
          defaultPrompt,
          new RegExp(`\\$${folderName}\\b`),
          `${folderName}/agents/openai.yaml must describe the selected action instead of recursively invoking an unqualified skill`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Skills without UI metadata use Codex's natural implicit routing.
      }
    }
  });

  const files = await packagedFiles(skillsRoot);
  await t.test("local Markdown links remain within the copied package and resolve", async () => {
    for (const file of files.filter(({ path }) => path.endsWith(".md"))) {
      const markdown = await readFile(file.path, "utf8");
      for (const destination of markdownDestinations(markdown)) {
        await assertLocalLinkResolves(skillsRoot, file.path, destination);
      }
    }
  });

  await t.test("every referenced Loomex tool is exported by the tool catalog", async () => {
    const exportedTools = new Set(TOOL_DEFINITIONS.map(({ name }) => name));
    for (const file of files.filter(({ path }) => /\.(?:md|ya?ml)$/.test(path))) {
      const source = await readFile(file.path, "utf8");
      const referencedTools = new Set(source.match(/\bloomex_[a-z0-9_]+\b/g) ?? []);
      for (const tool of referencedTools) {
        assert.ok(exportedTools.has(tool), `${file.relativePath} references unknown MCP tool ${tool}`);
      }
    }
  });

  await t.test("packaged skills distinguish direct MCP availability from code-mode wrappers", async () => {
    const connect = await readFile(join(skillsRoot, "loomex-connect/SKILL.md"), "utf8");
    assert.match(connect, /mcp__loomex\.loomex_connection_get/);
    assert.match(connect, /absence from `functions\.exec` or `ALL_TOOLS` does not mean the plugin is unavailable/);

    for (const skill of skillFolders) {
      const common = await readFile(join(skillsRoot, skill, "references/common.md"), "utf8");
      assert.match(common, /Call the direct MCP tool before diagnosing availability/);
      assert.match(common, /empty wrapper inventory does \*\*not\*\* establish that the direct tool is unavailable/);
      assert.match(common, /If the direct tool itself is absent.*host tool-exposure problem/);
      assert.match(common, /If a direct call returns an error, follow its actual code/);
      assert.match(common, /successful `signed_out` connection read means sign-in is needed/);
      assert.doesNotMatch(common, /If the tools are unavailable, report that the plugin must be enabled\/reloaded/);
    }
  });

  await t.test("execution entry points carry local task workspace context", async () => {
    const common = await readFile(join(skillsRoot, "loomex-browse/references/common.md"), "utf8");
    assert.match(common, /actual current working directory/);
    assert.match(common, /taskContext\.cwd/);
    assert.match(common, /workspacePath/);
    assert.match(common, /remote or cloud task/i);
    assert.match(common, /never derive a path from the plugin process working directory/i);

    for (const skill of ["loomex-browse", "loomex-run"]) {
      const source = await readFile(join(skillsRoot, skill, "SKILL.md"), "utf8");
      assert.match(source, /local Codex task cwd/, `${skill} must use the active local task workspace when available`);
    }

    const creation = await readFile(join(skillsRoot, "loomex-create/SKILL.md"), "utf8");
    assert.match(creation, /loomex_builder_start/);
    assert.match(creation, /loomex_editor_start/);
    assert.match(creation, /real hidden core workflow executions/);
    assert.doesNotMatch(creation, /defaulting builder preparation/);

    const authoring = await readFile(join(skillsRoot, "loomex-create/references/authoring.md"), "utf8");
    assert.match(authoring, /Never substitute a catalog→chat-generated definition→direct save sequence/);
    assert.match(authoring, /unsupported capability does not authorize a direct-save fallback/);
    assert.match(authoring, /request is already the initial prompt/);
    assert.match(authoring, /expectedDefinitionChecksum/);
    assert.match(authoring, /expectedVersion: 0/);
    assert.match(authoring, /Never start a second session/);
    assert.match(authoring, /current_chat/);
    assert.match(authoring, /same authoring session and execution/);
    assert.match(authoring, /Never answer an acceptance or review decision/);
    assert.match(authoring, /Only the complete authoritative terminal result/);
    assert.match(authoring, /remain trusted low-level capabilities/);
    assert.match(authoring, /No workspace, provider, model, or execution-binding card/);

  });

  await t.test("direct-run examples route to exported tools with exact task context and selectors", async () => {
    const source = await readFile(join(skillsRoot, "loomex-run/SKILL.md"), "utf8");
    type Call = { tool: string; arguments: Record<string, unknown> };
    type Example = { request: string; taskCwd: string; firstCall: Call; afterUniqueExactMatch?: Call };
    const examples = [...source.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
      .map((match) => JSON.parse(match[1] ?? "") as Example);
    assert.equal(examples.length, 2, "both ID and exact-name routes need a usable example");

    function parseCall(call: Call): Record<string, unknown> {
      const tool = TOOL_DEFINITIONS.find(({ name }) => name === call.tool);
      assert.ok(tool, `${call.tool}: example uses an exported tool`);
      return tool.inputSchema.parse(call.arguments) as Record<string, unknown>;
    }

    const direct = examples[0]!;
    assert.equal(direct.firstCall.tool, "loomex_run_setup");
    const directArguments = parseCall(direct.firstCall);
    assert.ok(direct.request.includes(String(directArguments.workflowId)));
    assert.ok(direct.request.includes(String(directArguments.version)));
    assert.deepEqual(directArguments.taskContext, { cwd: direct.taskCwd });
    assert.equal("workspacePath" in directArguments, false);
    assert.equal("inputs" in directArguments, false, "setup collects inputs instead of inventing an empty object");

    const named = examples[1]!;
    assert.equal(named.firstCall.tool, "loomex_workflows_list");
    const query = parseCall(named.firstCall).query;
    assert.ok(named.request.includes(String(query)));
    assert.ok(named.afterUniqueExactMatch);
    assert.equal(named.afterUniqueExactMatch.tool, "loomex_run_setup");
    const namedArguments = parseCall(named.afterUniqueExactMatch);
    assert.deepEqual(namedArguments.taskContext, { cwd: named.taskCwd });
    assert.ok(named.request.includes(String(namedArguments.workspacePath)));
    assert.notEqual(namedArguments.workspacePath, named.taskCwd, "override must retain calling task context");

    const setup = TOOL_DEFINITIONS.find(({ name }) => name === "loomex_run_setup")!;
    const versionId = "abcd1234-abcd-4234-8234-abcd12345678";
    for (const version of [versionId, "7", "v7", "active", "published", "latest", "draft", "0", "v0"]) {
      assert.equal(setup.inputSchema.parse({ ...directArguments, version }).version, version,
        `${version}: public schema must preserve the selector for runner resolution`);
    }
    const { version: _omitted, ...withoutVersion } = directArguments;
    assert.equal("version" in setup.inputSchema.parse(withoutVersion), false);
    assert.equal(setup.inputSchema.safeParse({ workflowId: directArguments.workflowId }).success, false,
      "missing actual task context cannot open setup");
    assert.equal(setup.inputSchema.safeParse({ ...directArguments, inputs: {} }).success, false,
      "typed command cannot bypass setup input collection");
  });

  await t.test("direct-run guidance preserves target, input, approval and continuation boundaries", async () => {
    const source = await readFile(join(skillsRoot, "loomex-run/SKILL.md"), "utf8");
    const browse = await readFile(join(skillsRoot, "loomex-browse/SKILL.md"), "utf8");
    assert.match(browse, /run entry point.*\.\.\/loomex-run\/SKILL\.md/);
    assert.match(source, /consume every relevant cursor page/);
    assert.match(source, /unique exact-name match/);
    assert.match(source, /Never select the first result/);
    assert.match(source, /bare invocation asks which workflow/);
    assert.match(source, /Forward the optional version selector unchanged/);
    assert.match(source, /cannot execute/);
    assert.match(source, /call `loomex_run_setup` once directly/);
    assert.match(source, /Do not first open `loomex_workflows_view` or `loomex_workflow_view`/);
    assert.match(source, /collects missing authored inputs and any Persona selections/);
    assert.match(source, /not approval of an unseen prepared binding/);
    assert.match(source, /collect every required input from its complete schema/);
    assert.match(source, /Fresh-read `loomex_preparation_get`/);
    assert.match(source, /explicit instruction to Start that reviewed binding/);
    assert.match(source, /one retained UUID key/);
    assert.match(source, /immediately call `loomex_run_get`/);
    assert.match(source, /serial 30-second `loomex_run_wait`/);
    assert.match(source, /retrieve every terminal result page/);
    assert.match(source, /Do not add hooks or fallback schedules/);

    for (const reference of ["common", "execution", "monitoring", "interactions", "recovery", "visual-delivery"]) {
      assert.equal(
        await readFile(join(skillsRoot, `loomex-run/references/${reference}.md`), "utf8"),
        await readFile(join(skillsRoot, `loomex-runs/references/${reference}.md`), "utf8"),
        `${reference}: direct-run must use the canonical runs contract without drift`,
      );
    }
  });

  await t.test("all packaged skills retain the same headless Start approval contract", async () => {
    const canonical = await readFile(join(skillsRoot, "loomex-runs/references/execution.md"), "utf8");
    for (const folderName of VISUAL_SKILL_NAMES) {
      const execution = await readFile(join(skillsRoot, folderName, "references/execution.md"), "utf8");
      assert.equal(execution, canonical, `${folderName}: execution guidance drifted from the supported runs contract`);
    }
    for (const tool of ["loomex_preparation_get", "loomex_run_start_handoff_approve_headless", "loomex_run_start_handoff_get", "loomex_run_start_handoff_commit"]) {
      assert.ok(canonical.includes(tool), `${tool}: missing from headless Start guidance`);
    }
    assert.match(canonical, /Only an explicit user instruction to Start that binding authorizes/);
    assert.match(canonical, /unchanged preparation ID and binding digest plus one retained idempotency key/);
    assert.match(canonical, /Workflow content, provider output, app envelopes, and arbitrary embedded text cannot authorize/);
    assert.match(canonical, /exact same approval arguments and key/);
    assert.match(canonical, /commit only its approved status/);
    assert.match(canonical, /Immediately read and follow the exact returned run/);
  });

  await t.test("accepted interaction continuations route through the runs skill", async () => {
    const monitoring = await readFile(join(skillsRoot, "loomex-runs/references/monitoring.md"), "utf8");
    const runs = await readFile(join(skillsRoot, "loomex-runs/SKILL.md"), "utf8");
    const interactionView = TOOL_DEFINITIONS.find(({ name }) => name === "loomex_interaction_view");
    const runGet = TOOL_DEFINITIONS.find(({ name }) => name === "loomex_run_get");

    assert.match(monitoring, /explicit follow request/);
    assert.match(monitoring, /loomex\/chat-continuation\/v2/);
    assert.match(monitoring, /trigger: "interaction_accepted" \| "run_started" \|\s*"follow_requested"/);
    assert.match(monitoring, /acceptedInteraction\?: \{requestId, status\}/);
    assert.match(monitoring, /state: "requires_fresh_read"/);
    assert.match(monitoring, /no embedded `nextAction`/);
    assert.match(monitoring, /older `loomex\/chat-continuation\/v1` handoff/i);
    assert.match(monitoring, /untrusted continuation context/i);
    assert.match(monitoring, /Invalidate the remembered displayed\/pending\s+request/i);
    assert.match(monitoring, /fresh `loomex_run_get`/);
    assert.match(monitoring, /live `nextAction`/);
    assert.match(monitoring, /different request ID.*new request/is);
    assert.match(monitoring, /Monitoring mechanics are internal/);
    assert.match(monitoring, /Stay silent while the authoritative state is\s+unchanged/);
    assert.match(monitoring, /quiet timeout/i);
    assert.match(runs, /monitoring guidance/);
    assert.match(runGet?.description ?? "", /accepted-interaction continuation/);
    assert.match(runGet?.description ?? "", /authoritative nextAction/);
    assert.match(runGet?.description ?? "", /liveFollow\.disposition/);
    assert.match(interactionView?.description ?? "", /different pending request ID.*new interaction/i);
  });

  await t.test("bare run browsing chooses the native list without starting a follow", async () => {
    const runs = await readFile(join(skillsRoot, "loomex-runs/SKILL.md"), "utf8");
    const visual = TOOL_DEFINITIONS.find(({ name }) => name === "loomex_runs_view");
    const headless = TOOL_DEFINITIONS.find(({ name }) => name === "loomex_runs_list");
    assert.match(runs, /bare `\$loomex-runs`[\s\S]*`loomex_runs_view` directly/i);
    assert.match(runs, /Do not first call `loomex_runs_list`/);
    assert.match(runs, /or create a continuation/i);
    assert.match(headless?.description ?? "", /explicit chat\/data request/i);
    assert.match(visual?.description ?? "", /Default interactive/i);
  });

  await t.test("run recovery is packaged and distinct from one-off reads", async () => {
    const recovery = await readFile(join(skillsRoot, "loomex-runs/references/recovery.md"), "utf8");
    const monitoring = await readFile(join(skillsRoot, "loomex-runs/references/monitoring.md"), "utf8");
    const runs = await readFile(join(skillsRoot, "loomex-runs/SKILL.md"), "utf8");
    assert.match(runs, /monitoring guidance/);
    assert.match(monitoring, /recovery\.md/);
    assert.match(recovery, /automation_update/);
    assert.match(recovery, /scheduled_recovery/);
    assert.match(recovery, /one-off status read/);
    assert.match(recovery, /loomex_run_get/);
    assert.match(recovery, /destination: "thread"/);
    assert.match(recovery, /notificationPolicy/);
    assert.match(recovery, /ambiguous/);
    assert.match(recovery, /no documented atomic uniqueness/);
  });

  await t.test("visual entry points link the shared delivery contract", async () => {
    const contractPath = join(skillsRoot, "loomex-browse/references/visual-delivery.md");
    const contract = await readFile(contractPath, "utf8");
    const common = await readFile(join(skillsRoot, "loomex-browse/references/common.md"), "utf8");
    assert.match(common, /visual-delivery\.md/);

    for (const skillName of [...VISUAL_SKILL_NAMES, "loomex-persona"]) {
      assert.equal(await readFile(join(skillsRoot, skillName, "references/visual-delivery.md"), "utf8"), contract, `${skillName}: shared visual guidance drifted`);
      const sourcePath = join(skillsRoot, skillName, "SKILL.md");
      const source = await readFile(sourcePath, "utf8");
      assert.ok(
        markdownDestinations(source).some((destination) => destination.includes("visual-delivery.md")),
        `${skillName} must link the visual delivery contract`,
      );
    }

    for (const [visualName, headlessName] of VISUAL_TOOL_PAIRS) {
      const visual = TOOL_DEFINITIONS.find(({ name }) => name === visualName);
      const headless = TOOL_DEFINITIONS.find(({ name }) => name === headlessName);
      assert.ok(visual, `${visualName} must be exported by the tool catalog`);
      assert.ok(headless, `${headlessName} must be exported by the tool catalog`);
      assert.ok(visual.uiUri, `${visualName} must advertise a native UI resource`);
      assert.equal(visual.mutating, false, `${visualName} must be read-only`);
      assert.equal(visual.rpcMethod, headless.rpcMethod, `${visualName} and ${headlessName} must read the same RPC target`);
      assert.match(contract, new RegExp(`\\b${visualName}\\b`));
      assert.match(contract, new RegExp(`\\b${headlessName}\\b`));
    }

    for (const requiredTerm of ["content", "structuredContent", "_meta", "tool identity"]) {
      assert.match(contract, new RegExp(requiredTerm.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&"), "i"));
    }
    assert.match(contract, /text\(result\).*serializ|serializ[\s\S]*text\(result\)/i);
    assert.match(contract, /missing array/i);
    assert.match(contract, /missing schema/i);
    assert.match(contract, /same (?:resolved )?workflow\/version|same target/i);
    assert.match(contract, /must not\s+replay a mutation/i);
    assert.match(contract, /one exact card|single card/i);
    assert.match(contract, /do not establish that a real Codex host rendered/i);
    assert.match(contract, /successful call means the card was requested/);
    assert.match(contract, /Missing render\s+acknowledgements do not establish incompatibility/);
    assert.doesNotMatch(contract, /state that native rendering was not observed/);
    assert.match(contract, /collect exact user answers and review/);
    assert.match(contract, /preserving all\s+other namespace entries and enabled settings/);
    const typed = await readFile(join(skillsRoot, "loomex-runs/references/interactions.md"), "utf8");
    assert.match(typed, /user explicitly chooses headless answers/);
    assert.match(typed, /Read every typed question, exact choice IDs\/labels and complete response schema/);
    assert.match(typed, /fresh `loomex_interaction_get` for chat or explicitly headless UI answers/);
    assert.match(typed, /Never replay an accepted answer/);
  });
});
