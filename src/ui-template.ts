import { validateDesignSystem } from "./design-system.js";
import {
  FOLLOW_COMMAND,
  FOLLOW_GENERATED_MARKDOWN_INSTRUCTIONS,
  formatFollowContinuationContext,
  formatFollowContinuationMarkdown,
} from "./monitoring-contract.js";
import { readFileSync } from "node:fs";

const asset = (name: string) => readFileSync(new URL(`../assets/${name}`, import.meta.url), "utf8");
const template = asset("loomex-app.html");
const foundation = asset("frontend-design-system.css");
const persistence = asset("loomex-persistence.js");
const provenance = validateDesignSystem(JSON.parse(asset("frontend-design-system.json")), template, foundation);

// The app is an inline CSP-constrained document, so it cannot import a module
// at runtime. Inject the canonical formatter body and its private constants
// from the hooks contract instead of maintaining a second formatter.
const followFormatter = `(() => {
  const FOLLOW_COMMAND = ${JSON.stringify(FOLLOW_COMMAND)};
  const FOLLOW_GENERATED_MARKDOWN_INSTRUCTIONS = ${JSON.stringify(FOLLOW_GENERATED_MARKDOWN_INSTRUCTIONS)};
  const FOLLOW_RUN_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const FOLLOW_RECEIPT = "[A-Za-z0-9_-]{16,2048}";
  return (${formatFollowContinuationMarkdown.toString()});
})()`;
const followContextFormatter = `(${formatFollowContinuationContext.toString()})`;

/** One offline renderer for every MCP resource and the browser harness. */
export function renderUiHtml(mode: string): string {
  if (!["browser", "authoring", "prepare", "monitor", "interaction", "connection", "organizations"].includes(mode)) throw new Error("Unknown UI mode");
  return template.replace("__LOOMEX_DESIGN_SYSTEM__", () => foundation)
    .replace("__LOOMEX_PERSISTENCE__", () => persistence)
    .replace("__LOOMEX_FOLLOW_FORMATTER__", () => followFormatter)
    .replace("__LOOMEX_FOLLOW_CONTEXT_FORMATTER__", () => followContextFormatter)
    .replace("__LOOMEX_STATUS_CLASSES__", () => JSON.stringify(provenance.statusClasses).replaceAll("<", "\\u003c"))
    .replace("__LOOMEX_MODE__", mode);
}
