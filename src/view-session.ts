import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PreparationReviewClient } from "./preparation-review.js";
import type { JsonValue, ToolOutput } from "./protocol.js";
import type { ToolDefinition } from "./tool-catalog.js";

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
const nil = "00000000-0000-0000-0000-000000000000";

/** Local view identity is a navigation key, never an execution authorization. */
export async function viewSessionMeta(client: PreparationReviewClient, definition: ToolDefinition,
  input: Record<string, JsonValue>, output: ToolOutput, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
  if (!definition.uiUri || !output.ok || !output.data || output.data.responseRef) return {};
  const data = output.data;
  const request = object(data.humanRequest);
  const kind = definition.uiUri.split("/").at(-1)?.replace(".html", "");
  if (kind === "interaction" && request.answerChannel === "chat") return { "loomex/answerChannel": "chat" };
  let entityType = "catalog";
  let entityId: JsonValue = nil;
  if (kind === "interaction") { entityType = "request"; entityId = request.id ?? input.requestId ?? null; }
  else if (kind === "monitor") { entityType = "execution"; entityId = object(data.execution).id ?? input.runId ?? null; }
  else if (kind === "prepare" || kind === "authoring") {
    if (typeof data.preparationId === "string") { entityType = "preparation"; entityId = data.preparationId; }
    else if (kind === "authoring" && (object(data.builderSession).id || input.sessionId)) {
      entityType = "builderSession"; entityId = object(data.builderSession).id ?? input.sessionId ?? null;
    } else { entityType = "workflow"; entityId = object(data.workflow).id ?? input.workflowId ?? null; }
  }
  if (!kind || !z.uuid().safeParse(entityId).success) return { "loomex/viewPersistence": { status: "unavailable" } };
  try {
    const restoring = typeof input.viewSessionId === "string";
    const session = await client.call(restoring ? "presentation.sessions.get" : "presentation.sessions.create",
      restoring ? { viewSessionId: input.viewSessionId! } : {
        kind, entityType, entityId, state: {}, idempotencyKey: randomUUID(),
      }, { mutating: !restoring, ...(signal ? {signal} : {}), timeoutMs: 5000 });
    if (!session.ok || !session.data || session.data.responseRef || !z.uuid().safeParse(session.data.viewSessionId).success) throw new Error("View persistence unavailable");
    if (session.data.kind !== kind || session.data.entityType !== entityType || session.data.entityId !== entityId) throw new Error("View binding mismatch");
    return { "loomex/viewSession": session.data };
  } catch {
    return { "loomex/viewPersistence": { status: "unavailable" } };
  }
}
