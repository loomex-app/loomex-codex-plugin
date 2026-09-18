#!/usr/bin/env node
// Record integrity for generated, packaged UI assets. This is intentionally
// independent from the frontend checkout used by sync-design-system.mjs.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { verifyDesignConsumers } from "./design-consumers.mjs";
import { checkRetiredUiPaths } from "./retired-ui-paths.mjs";
import { browserCoverage } from "./browser-coverage.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
if (args.some((arg) => arg !== "--check")) throw new Error("Usage: sync-ui-assets.mjs [--check]");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const read = (name) => readFile(resolve(root, "assets", name), "utf8");
const browserAssetPath = resolve(root, "assets/browser-application.js");

async function compileBrowserApplication() {
  const outputDirectory = await mkdtemp(join(tmpdir(), "loomex-ui-build-"));
  const outputPath = join(outputDirectory, "browser-application.js");
  try {
    const result = await build({
      metafile: true,
      absWorkingDir: root,
      bundle: true,
      charset: "utf8",
      entryPoints: ["src/ui-app/app.ts"],
      format: "iife",
      legalComments: "none",
      // esbuild otherwise emits dependency-layout comments such as
      // `node_modules/.pnpm/...` into the browser asset. Those vary between a
      // developer's package manager and the clean npm release build despite
      // identical executable code, making integrity checks non-reproducible.
      minifyWhitespace: true,
      logLevel: "silent",
      outfile: outputPath,
      platform: "browser",
      sourcemap: false,
      target: "es2022",
      write: true,
    });
    const failures = browserCoverage(root, Object.keys(result.metafile.inputs));
    if (failures.length) throw new Error(failures.join("\n"));
    const code = await readFile(outputPath, "utf8");
    const retirementFailures = checkRetiredUiPaths(Object.keys(result.metafile.inputs), code, await read("loomex-app.html"));
    if (retirementFailures.length) throw new Error(retirementFailures.join("\n"));
    return code;
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
}

const designSnapshot = JSON.parse(await read("frontend-design-system.json"));
await verifyDesignConsumers(root, designSnapshot);
const browserCode = await compileBrowserApplication();
const template = await read("loomex-app.html");
const foundation = await read("frontend-design-system.css");
const manifest = {
  schema: "loomex/plugin-ui-assets/v2",
  templateSha256: digest(template),
  foundationSha256: digest(foundation),
  browserCodeSha256: digest(browserCode),
};
const path = resolve(root, "assets/ui-artifacts.json");
const output = JSON.stringify(manifest, null, 2) + "\n";
if (check) {
  if (await readFile(path, "utf8") !== output) throw new Error("Stale or tampered packaged UI assets. Run npm run ui:sync.");
  if (await readFile(browserAssetPath, "utf8") !== browserCode) throw new Error("Stale compiled browser application asset. Run npm run ui:sync.");
} else {
  await writeFile(path, output);
  await writeFile(browserAssetPath, browserCode);
}
console.log(`${check ? "Verified" : "Recorded"} packaged UI assets`);
