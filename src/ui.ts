import { renderUiHtml } from "./ui-template.js";

import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import {
  AUTHORING_UI_URI,
  BROWSER_UI_URI,
  INTERACTION_UI_URI,
  MONITOR_UI_URI,
  PREPARE_UI_URI,
} from "./tool-catalog.js";

const RESOURCES = [
  { name: "loomex-browser", uri: BROWSER_UI_URI, mode: "browser" },
  { name: "loomex-authoring", uri: AUTHORING_UI_URI, mode: "authoring" },
  { name: "loomex-prepare", uri: PREPARE_UI_URI, mode: "prepare" },
  { name: "loomex-monitor", uri: MONITOR_UI_URI, mode: "monitor" },
  { name: "loomex-interaction", uri: INTERACTION_UI_URI, mode: "interaction" },
] as const;

// Stable resource identities avoid retaining a deleted release URI in a host task.
// Only previously shipped identities are accepted by the compatibility template.
const CACHED_RELEASES = new Set(["0.2.3", "0.2.4", "0.2.5", "0.2.6", "0.2.7"]);

function resourceContents(uri: string, mode: string) {
  return { contents: [{
    uri,
    mimeType: "text/html;profile=mcp-app",
    text: renderUiHtml(mode),
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } },
  }] };
}

export function registerUiResources(server: McpServer): void {
  for (const resource of RESOURCES) {
    server.registerResource(resource.name, resource.uri, {
      title: `Loomex ${resource.mode}`,
      description: `Optional Loomex ${resource.mode} interface. All operations remain available as headless tools.`,
      mimeType: "text/html;profile=mcp-app",
    }, async () => resourceContents(resource.uri, resource.mode));
  }
  server.registerResource("loomex-cached-ui", new ResourceTemplate("ui://loomex/{view}-{version}.html", { list: undefined }), {
    description: "Compatibility for UI references retained by earlier Codex tasks.",
    mimeType: "text/html;profile=mcp-app",
  }, async (uri, variables) => {
    const view = variables.view;
    const version = variables.version;
    const resource = typeof view === "string" ? RESOURCES.find((item) => item.mode === view) : undefined;
    if (!resource || typeof version !== "string" || (!CACHED_RELEASES.has(version) || (view === "browser" && version !== "0.2.7"))) {
      throw new McpError(ErrorCode.InvalidParams, "Unsupported Loomex UI resource");
    }
    return resourceContents(uri.href, resource.mode);
  });
}
