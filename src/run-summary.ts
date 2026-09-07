import { z } from "zod";
import type { JsonValue } from "./protocol.js";

type ObjectValue = Record<string, JsonValue>;
const PAGE_PREVIEW = 8;
const TERMINAL = new Set(["completed", "failed", "canceled", "cancelled", "deleted", "succeeded", "expired"]);

const uuidSchema = z.uuid();
function uuid(value: JsonValue | undefined): value is string {
  return typeof value === "string" && uuidSchema.safeParse(value).success;
}
function object(value: JsonValue | undefined): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function fields(value: ObjectValue, keys: readonly string[], maxLength = 160): ObjectValue {
  const result: ObjectValue = {};
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string") result[key] = item.slice(0, maxLength);
    else if (item === null || typeof item === "boolean" || typeof item === "number") result[key] = item;
  }
  return result;
}
function run(value: JsonValue | undefined): ObjectValue {
  return fields(object(value), ["id", "status", "workflowName", "name", "workflowId", "workflowVersionId", "currentNodeName", "stageLabel"]);
}
function question(value: JsonValue | undefined): ObjectValue {
  const spec = object(value);
  return { ...fields(spec, ["id", "schemaVersion", "collectionMode", "inputType"]), ...fields(spec, ["question"], 500) };
}
function interaction(value: JsonValue | undefined): ObjectValue {
  const request = object(value);
  const spec = object(request.inputSpec);
  const result: ObjectValue = fields(request, ["id", "status", "type", "title"]);
  const execution = object(request.execution);
  if (typeof execution.id === "string") result.executionId = execution.id.slice(0, 160);
  if (Object.keys(spec).length) {
    result.inputSpec = question(spec);
    if (Array.isArray(spec.questions)) {
      result.inputSpec = { ...object(result.inputSpec), questions: spec.questions.slice(0, PAGE_PREVIEW).map(question),
        questionCount: spec.questions.length, truncated: spec.questions.length > PAGE_PREVIEW };
    }
  }
  return result;
}
function page(data: ObjectValue, key: string, project: (value: JsonValue) => ObjectValue): ObjectValue {
  const items = Array.isArray(data[key]) ? data[key] : [];
  return { [key]: items.slice(0, PAGE_PREVIEW).map(project), count: items.length,
    truncated: items.length > PAGE_PREVIEW, ...fields(data, ["nextCursor", "executionId"]) };
}

/** Model-facing run state must never be overwritten by nested runner/context fields. */
export function runSummary(method: string, data: ObjectValue): ObjectValue | undefined {
  if (!method.startsWith("runs.") && !method.startsWith("interactions.")) return undefined;
  if (typeof data.responseRef === "string") return fields(data, ["responseRef", "sizeBytes", "nextOffset", "checksumSha256", "encoding"]);
  if (method === "runs.list") return page(data, "executions", run);
  if (method === "interactions.list") return page(data, "humanRequests", (value) => fields(object(value), ["id", "status", "type", "title"]));
  if (method === "interactions.respond" || method === "interactions.decide") {
    return { ...fields(data, ["requestId", "requestStatus", "executionId", "executionStatus"]), hasError: data.error != null,
      ...(uuid(data.executionId) ? { nextAction: { tool: "loomex_run_get", arguments: { runId: data.executionId } } } : {}) };
  }
  if (method === "runs.prepare") return { ...fields(data, ["preparationId", "expiresAt"]), requiresConfirmation: true };
  if (method === "runs.delete") return fields(data, ["executionId", "deleted", "deletedAt", "retainedForAudit"]);
  const execution = run(data.execution);
  const request = interaction(data.humanRequest);
  const summary: ObjectValue = { execution, ...fields(data, ["waitState", "latestSequence", "hasMoreEvents", "timedOut", "preparationId", "executionPolicy"]) };
  if (typeof request.id === "string") summary.humanRequest = request;
  if (Array.isArray(data.events)) summary.eventCount = data.events.length;
  if (Array.isArray(data.jobs)) summary.jobCount = data.jobs.length;
  const rawExecution = object(data.execution);
  const rawRequest = object(data.humanRequest);
  const requestExecution = object(rawRequest.execution);
  const requestBelongsToRun = uuid(rawExecution.id) && uuid(requestExecution.id) && requestExecution.id === rawExecution.id;
  if (method.startsWith("runs.") && request.status === "pending" && uuid(rawRequest.id) && requestBelongsToRun && !TERMINAL.has(String(execution.status).toLowerCase())) {
    summary.nextAction = { tool: "loomex_interaction_get", arguments: { requestId: rawRequest.id } };
  }
  return summary;
}
