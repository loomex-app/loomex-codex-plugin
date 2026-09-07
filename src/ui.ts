import { readFileSync } from "node:fs";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  AUTHORING_UI_URI,
  BROWSER_UI_URI,
  INTERACTION_UI_URI,
  MONITOR_UI_URI,
  PREPARE_UI_URI,
} from "./tool-catalog.js";

const UI_TEMPLATE = readFileSync(
  new URL("../assets/loomex-app.html", import.meta.url),
  "utf8",
);

const RESOURCES = [
  { name: "loomex-browser", uri: BROWSER_UI_URI, mode: "browser" },
  { name: "loomex-authoring", uri: AUTHORING_UI_URI, mode: "authoring" },
  { name: "loomex-prepare", uri: PREPARE_UI_URI, mode: "prepare" },
  { name: "loomex-monitor", uri: MONITOR_UI_URI, mode: "monitor" },
  { name: "loomex-interaction", uri: INTERACTION_UI_URI, mode: "interaction" },
] as const;

export function registerUiResources(server: McpServer): void {
  for (const resource of RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: `Loomex ${resource.mode}`,
        description: `Optional Loomex ${resource.mode} interface. All operations remain available as headless tools.`,
        mimeType: "text/html;profile=mcp-app",
      },
      async () => ({
        contents: [
          {
            uri: resource.uri,
            mimeType: "text/html;profile=mcp-app",
            text: UI_TEMPLATE.replace("__LOOMEX_MODE__", resource.mode),
            _meta: {
              ui: {
                prefersBorder: true,
                csp: {
                  connectDomains: [],
                  resourceDomains: [],
                  frameDomains: [],
                },
              },
            },
          },
        ],
      }),
    );
  }
}
