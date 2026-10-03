#!/usr/bin/env node
// Record integrity for generated, packaged UI assets. This is intentionally
// independent from the frontend checkout used by sync-design-system.mjs.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDesignConsumers } from "./design-consumers.mjs";
import { compileBrowserApplication } from "./browser-build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
if (args.some((arg) => arg !== "--check")) throw new Error("Usage: sync-ui-assets.mjs [--check]");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const read = (name) => readFile(resolve(root, "assets", name), "utf8");
const browserAssetPath = resolve(root, "assets/browser-application.js");

const designSnapshot = JSON.parse(await read("frontend-design-system.json"));
await verifyDesignConsumers(root, designSnapshot);
const { code: browserCode } = await compileBrowserApplication(root);
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
