import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { LocalControlClient, toolErrorOutput } from "./local-control.js";
import {
  buildPreparationReview,
  preparationReviewBinding,
  type PreparationReviewClient,
} from "./preparation-review.js";
import { ToolOutputSchema, type JsonValue, type ToolOutput } from "./protocol.js";
import { resultSchemaFor } from "./result-schemas.js";
import { TOOL_DEFINITIONS, type ToolDefinition } from "./tool-catalog.js";
import { registerUiResources } from "./ui.js";

function toParams(input: unknown): Record<string, JsonValue> {
  return input as Record<string, JsonValue>;
}

function findStableFields(value: JsonValue, depth = 0): Record<string, JsonValue> {
  if (depth > 2 || value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      /(^|_)(id|status|state|name|nextCursor|nextOffset|nextSequence|responseRef|checksumSha256)$/i.test(key) ||
      /(Id|Ids)$/.test(key)
    ) {
      output[key] = child;
    } else if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      Object.assign(output, findStableFields(child, depth + 1));
    }
    if (Object.keys(output).length >= 16) break;
  }
  return output;
}

function contentFor(output: ToolOutput): string {
  if (!output.ok) {
    return JSON.stringify({
      ok: false,
      method: output.method,
      requestId: output.requestId,
      error: output.error,
      ...(output.idempotencyKey === undefined ? {} : { idempotencyKey: output.idempotencyKey }),
    });
  }
  return JSON.stringify({
    ok: true,
    method: output.method,
    requestId: output.requestId,
    ...(output.data === undefined ? {} : findStableFields(output.data)),
  });
}

function timeoutFor(definition: ToolDefinition, params: Record<string, JsonValue>): number {
  if (definition.rpcMethod === "runs.wait" || definition.rpcMethod === "builder.get") {
    const requested = typeof params.timeoutSeconds === "number" ? params.timeoutSeconds : 45;
    const seconds = Math.min(requested, 45);
    return seconds * 1000 + 5000;
  }
  return 30_000;
}

export function createServer(client: PreparationReviewClient = new LocalControlClient()): McpServer {
  const server = new McpServer(
    { name: "loomex", version: "0.2.3" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "Use focused Loomex tools through the owner-checked local runner. Mutations require a retained UUID idempotency key. Prepare builder sessions, editor sessions, and runs; review each exact host_user/v1 binding with the user; then commit it unchanged. Never request credentials or secret inputs. Page events, results, responses, and artifacts until complete.",
    },
  );

  registerUiResources(server);

  for (const definition of TOOL_DEFINITIONS) {
    const resultSchema = resultSchemaFor(definition.rpcMethod);
    if (resultSchema === undefined) {
      throw new Error(`Missing local-control result schema for ${definition.rpcMethod}`);
    }
    const outputSchema = ToolOutputSchema.extend({ data: resultSchema.optional() }).strict();
    const uiMeta =
      definition.uiUri === undefined
        ? {}
        : {
            ui: { resourceUri: definition.uiUri },
            "openai/outputTemplate": definition.uiUri,
          };
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema,
        annotations: {
          title: definition.title,
          readOnlyHint: !definition.mutating,
          destructiveHint: definition.destructive,
          idempotentHint: true,
          openWorldHint: true,
        },
        _meta: {
          ...uiMeta,
          "openai/toolInvocation/invoking": `${definition.title}…`,
          "openai/toolInvocation/invoked": `${definition.title} complete.`,
        },
      },
      async (input, extra) => {
        const parsed = definition.inputSchema.parse(input);
        const params = toParams(parsed);
        try {
          const output = await client.call(definition.rpcMethod, params, {
            mutating: definition.mutating,
            signal: extra.signal,
            timeoutMs: timeoutFor(definition, params),
          });
          const reviewBinding = preparationReviewBinding(definition.rpcMethod, output);
          const preparationReview =
            reviewBinding === undefined
              ? undefined
              : await buildPreparationReview(client, reviewBinding, extra.signal).catch(
                  () => undefined,
                );
          return {
            structuredContent: output,
            content: [{ type: "text", text: contentFor(output) }],
            ...(preparationReview === undefined
              ? {}
              : { _meta: { "loomex/preparationReview": preparationReview } }),
          };
        } catch (error) {
          const output = toolErrorOutput(definition.rpcMethod, error);
          return {
            isError: true,
            structuredContent: output,
            content: [{ type: "text", text: contentFor(output) }],
          };
        }
      },
    );
  }

  return server;
}
