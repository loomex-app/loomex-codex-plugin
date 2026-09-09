import { validateDesignSystem } from "./design-system.js";
import { readFileSync } from "node:fs";

const asset = (name: string) => readFileSync(new URL(`../assets/${name}`, import.meta.url), "utf8");
const template = asset("loomex-app.html");
const foundation = asset("frontend-design-system.css");
const provenance = validateDesignSystem(JSON.parse(asset("frontend-design-system.json")), template, foundation);

/** One offline renderer for every MCP resource and the browser harness. */
export function renderUiHtml(mode: string): string {
  if (!["browser", "authoring", "prepare", "monitor", "interaction"].includes(mode)) throw new Error("Unknown UI mode");
  return template.replace("__LOOMEX_DESIGN_SYSTEM__", () => foundation)
    .replace("__LOOMEX_STATUS_CLASSES__", () => JSON.stringify(provenance.statusClasses).replaceAll("<", "\\u003c"))
    .replace("__LOOMEX_MODE__", mode);
}
