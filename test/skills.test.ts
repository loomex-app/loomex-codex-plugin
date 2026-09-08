import * as assert from "node:assert/strict";
import { cp, lstat, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

import { TOOL_DEFINITIONS } from "../src/tool-catalog.js";

const SOURCE_SKILLS_ROOT = resolve(import.meta.dirname, "../skills");

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
        assert.ok(defaultPrompt.includes(`$${folderName}`), `${folderName}/agents/openai.yaml default_prompt must mention $${folderName}`);
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

  await t.test("execution entry points carry local task workspace context", async () => {
    const common = await readFile(join(skillsRoot, "loomex-workflows/references/common.md"), "utf8");
    assert.match(common, /actual current working directory/);
    assert.match(common, /taskContext\.cwd/);
    assert.match(common, /workspacePath/);
    assert.match(common, /remote or cloud task/i);
    assert.match(common, /never derive a path from the plugin process working directory/i);

    for (const skill of ["loomex-run", "loomex-browse", "loomex-inspect", "loomex-create", "loomex-edit"]) {
      const source = await readFile(join(skillsRoot, skill, "SKILL.md"), "utf8");
      assert.match(source, /local Codex task cwd/, `${skill} must use the active local task workspace when available`);
    }

    const authoring = await readFile(join(skillsRoot, "loomex-workflows/references/authoring.md"), "utf8");
    assert.match(authoring, /Do not add a project-directory input or `settings\.workspaceInputField`/);
    assert.match(authoring, /Existing stored versions.*remain valid and readable/);
    assert.match(authoring, /"source": "execution_context", "value": "workspace\.path"/);
  });
});
