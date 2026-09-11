import { renderUiHtml } from "./ui-template.js";

import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { UI_RESOURCE_REGISTRY, uiResourceForLegacyAlias } from "./ui-resources.js";

function resourceContents(uri: string, mode: string) {
  return { contents: [{
    uri,
    mimeType: "text/html;profile=mcp-app",
    text: renderUiHtml(mode),
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } },
  }] };
}

export function registerUiResources(server: McpServer): void {
  for (const resource of UI_RESOURCE_REGISTRY) {
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
    const resource = typeof view === "string" && typeof version === "string"
      ? uiResourceForLegacyAlias(uri.href)
      : undefined;
    if (!resource) {
      throw new McpError(ErrorCode.InvalidParams, "Unsupported Loomex UI resource");
    }
    return resourceContents(uri.href, resource.mode);
  });
}
