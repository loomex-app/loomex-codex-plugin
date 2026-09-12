import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PreparationReviewClient } from "./preparation-review.js";
import type { JsonValue, ToolOutput } from "./protocol.js";
import type { ToolDefinition } from "./tool-catalog.js";

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
const nil = "00000000-0000-0000-0000-000000000000";
const reentryCodes = new Set(["VIEW_SESSION_NOT_FOUND", "VIEW_SESSION_EXPIRED"]);

/**
 * Presentation storage is optional to the domain call, but its failures are
 * still useful to the card.  Keep the runner's error code intact so the UI
 * can distinguish a safe re-entry from a temporary unavailable store.
 */
function viewPersistenceError(
  error: Pick<ToolOutput, "error"> | Error | undefined,
  fallback: { code: string; message: string; retryable?: boolean },
): Record<string, JsonValue> {
  const candidate = error && typeof error === "object" && "error" in error ? error.error : error;
  const source = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
  const code = typeof source.code === "string" && source.code ? source.code : fallback.code;
  const message = typeof source.message === "string" && source.message ? source.message : fallback.message;
  const retryable = typeof source.retryable === "boolean" ? source.retryable : Boolean(fallback.retryable);
  const correlationId = typeof source.correlationId === "string"
    ? source.correlationId
    : undefined;
  return {
    "loomex/viewPersistence": {
      status: reentryCodes.has(code) ? "reentry" : "unavailable",
      code,
      message,
      retryable,
      ...(correlationId ? { correlationId } : {}),
    },
  };
}

/** Local view identity is a navigation key, never an execution authorization. */
export async function viewSessionMeta(client: PreparationReviewClient, definition: ToolDefinition,
  input: Record<string, JsonValue>, output: ToolOutput, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
  if (!definition.uiUri || !output.ok || !output.data || output.data.responseRef) return {};
  // Connection navigation is owner-local and available before authentication;
  // domain state is always re-read and never restored as authority.
  const connectionView = ["connection.html", "organizations.html"].some(view => definition.uiUri!.endsWith(view));
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
  if (!kind || !z.uuid().safeParse(entityId).success) {
    return viewPersistenceError(undefined, {
      code: "VIEW_SESSION_BINDING_INVALID",
      message: "This view does not have a valid presentation identity.",
    });
  }
  try {
    const restoring = typeof input.viewSessionId === "string";
    const session = await client.call(connectionView ? (restoring ? "connection.views.get" : "connection.views.create") : (restoring ? "presentation.sessions.get" : "presentation.sessions.create"),
      restoring ? { viewSessionId: input.viewSessionId! } : {
        kind, entityType, entityId, state: {}, idempotencyKey: randomUUID(),
      }, { mutating: !restoring, ...(signal ? {signal} : {}), timeoutMs: 5000 });
    if (!session.ok) return viewPersistenceError(session, {
      code: "VIEW_SESSION_UNAVAILABLE",
      message: "The saved view could not be read.",
      retryable: true,
    });
    if (!session.data || session.data.responseRef || !z.uuid().safeParse(session.data.viewSessionId).success) {
      return viewPersistenceError(undefined, {
        code: "VIEW_SESSION_INVALID_RESPONSE",
        message: "The saved view returned an invalid response.",
      });
    }
    if (session.data.kind !== kind || session.data.entityType !== entityType || session.data.entityId !== entityId) {
      return viewPersistenceError(undefined, {
        code: "VIEW_SESSION_BINDING_MISMATCH",
        message: "The saved view belongs to a different Loomex card.",
      });
    }
    return { "loomex/viewSession": session.data };
  } catch (error) {
    return viewPersistenceError(error instanceof Error ? error : undefined, {
      code: "VIEW_SESSION_UNAVAILABLE",
      message: "The saved view could not be read.",
      retryable: true,
    });
  }
}
