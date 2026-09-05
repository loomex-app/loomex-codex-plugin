#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();

process.on("SIGINT", () => {
  void server.close().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void server.close().finally(() => process.exit(0));
});

try {
  await server.connect(transport);
} catch {
  process.exitCode = 1;
}
