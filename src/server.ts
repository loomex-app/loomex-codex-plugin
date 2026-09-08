import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { LocalControlClient, toolErrorOutput } from "./local-control.js";
import {
  buildPreparationReview,
  preparationReviewBinding,
  type PreparationReviewClient,
} from "./preparation-review.js";
import { ToolOutputSchema, type JsonValue, type ToolOutput } from "./protocol.js";
import { resultSchemaFor } from "./result-schemas.js";
import { APP_CALLABLE_TOOLS, TOOL_DEFINITIONS, type ToolDefinition } from "./tool-catalog.js";
import { runSummary } from "./run-summary.js";
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
    ...(output.data === undefined ? {} : (runSummary(output.method, output.data) ?? findStableFields(output.data))),
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
    { name: "loomex", version: "0.4.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "Use focused Loomex tools through the owner-checked runner. Execution belongs to the runner; monitoring belongs to this conversation. For a new run use loomex_run_setup to collect required inputs and an authorized workspace, then commit only the exact reviewed binding. For a one-off status request, read loomex_run_get once and report; do not enter monitoring. Only an explicit follow/monitor request or a monitor_existing_run UI continuation starts the monitoring loop: begin with loomex_run_get using that exact runId and follow returned nextAction; while active, call loomex_run_wait with timeoutSeconds 30 and the fully consumed event sequence, one call at a time. A wait timeout is not completion. Continue until a required human interaction, terminal result, user stop, or actionable error; avoid repetitive status narration. Fetch pending questions with loomex_interaction_get and display loomex_interaction_view once, or ask headlessly. Never answer for the user or continue polling while waiting for their answer. After a confirmed answer, read and follow the same run. Data reads do not open UI; view tools are intentional presentation. UI handoffs carry exact run identity in acknowledged model context as well as the user message; do not substitute a stale workflow-list response or start a duplicate run. Host acceptance of a message is not evidence that monitoring occurred. Retain one UUID idempotency key per mutation and exact arguments for ambiguous retries. Review host_user/v1 authority explicitly; never request credentials or secret inputs. Drain hasMoreEvents pages from the last returned event sequence before advancing to latestSequence. Spool receipts mean the originating operation completed: read response pages from offset 0 through nextOffset null, verify the complete checksum and interpret the original result; never replay the originating mutation. Page results and artifacts until complete.",
    },
  );

  registerUiResources(server);

  for (const definition of TOOL_DEFINITIONS) {
    const resultSchema = resultSchemaFor(definition.rpcMethod);
    if (resultSchema === undefined) {
      throw new Error(`Missing local-control result schema for ${definition.rpcMethod}`);
    }
    const outputSchema = ToolOutputSchema.extend({ data: resultSchema.optional() }).strict();
    const appCallable = APP_CALLABLE_TOOLS.has(definition.name);
    const uiMeta = {
      ui: {
        visibility: appCallable ? ["model", "app"] : ["model"],
        ...(definition.uiUri === undefined ? {} : { resourceUri: definition.uiUri }),
      },
      "openai/widgetAccessible": appCallable,
      ...(definition.uiUri === undefined ? {} : { "openai/outputTemplate": definition.uiUri }),
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
            ...(definition.rpcMethod === "workflows.list" ? { _meta: { "loomex/workflowListQuery": params } } : {}),
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
