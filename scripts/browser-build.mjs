import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { browserCoverage } from "./browser-coverage.mjs";
import { checkRetiredUiPaths } from "./retired-ui-paths.mjs";

/** Compile and check the complete packaged browser graph without writing assets. */
export async function compileBrowserApplication(root) {
  const result = await build({
    metafile: true,
    absWorkingDir: root,
    bundle: true,
    charset: "utf8",
    entryPoints: ["src/ui-app/app.ts"],
    format: "iife",
    legalComments: "none",
    // Full minification also removes dependency-layout comments, keeping the
    // browser artifact independent of npm versus pnpm installation paths.
    minify: true,
    logLevel: "silent",
    outfile: "browser-application.js",
    platform: "browser",
    sourcemap: false,
    target: "es2022",
    write: false,
  });
  const inputs = Object.keys(result.metafile.inputs);
  const failures = browserCoverage(root, inputs);
  if (failures.length) throw new Error(failures.join("\n"));
  const code = result.outputFiles[0].text;
  const template = await readFile(resolve(root, "assets/loomex-app.html"), "utf8");
  const retirementFailures = checkRetiredUiPaths(inputs, code, template);
  if (retirementFailures.length) throw new Error(retirementFailures.join("\n"));
  return { code, inputs };
}
