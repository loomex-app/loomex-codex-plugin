import { z } from "zod";
import type { JsonValue } from "./protocol.js";

type ObjectValue = Record<string, JsonValue>;
const PAGE_PREVIEW = 8;
const ACTIVE = new Set(["queued", "pending", "running", "waiting", "paused", "canceling", "cancelling"]);
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

/**
 * Advisory lifecycle data for an explicit follow loop. A one-off status read
 * must still be reported once; these fields never create a schedule or imply
 * polling after the current chat turn ends.
 */
function monitoring(summary: ObjectValue, status: string, identityValid: boolean): ObjectValue {
  if (!identityValid || summary.stateNeedsVerification === true) {
    return { state: "needs_attention", recoveryAction: "pause", continuePolling: false };
  }
  const tool = object(summary.nextAction).tool;
  if (tool === "loomex_run_events") {
    return { state: "active", recoveryAction: "ensure", continuePolling: true };
  }
  if (tool === "loomex_interaction_view" || tool === "loomex_interaction_get") {
    return { state: "needs_input", recoveryAction: "pause", continuePolling: false };
  }
  if (tool === "loomex_run_result" || TERMINAL.has(status)) {
    return { state: "terminal", recoveryAction: "remove", continuePolling: false };
  }
  if (tool === "loomex_run_wait") {
    return { state: "active", recoveryAction: "ensure", continuePolling: true };
  }
  return { state: "needs_attention", recoveryAction: "pause", continuePolling: false };
}

/** Model-facing run state must never be overwritten by nested runner/context fields. */
export function runSummary(method: string, data: ObjectValue): ObjectValue | undefined {
  if (!method.startsWith("runs.") && !method.startsWith("interactions.")) return undefined;
  if (typeof data.responseRef === "string") return {
    ...fields(data, ["responseRef", "sizeBytes", "nextOffset", "checksumSha256", "encoding"]),
    originatingOperationComplete: true,
    doNotReplayOriginatingOperation: true,
    ...(uuid(data.responseRef) ? { nextAction: { tool: "loomex_response_read", arguments: { responseRef: data.responseRef, offset: 0 } } }
      : { stateNeedsVerification: true }),
  };
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
  const organizations = [rawExecution.organizationId, rawRequest.organizationId, requestExecution.organizationId]
    .filter((value) => value !== undefined && value !== null);
  const organizationConsistent = organizations.every((value) => uuid(value)) && new Set(organizations).size <= 1;
  const requestBelongsToRun = uuid(rawExecution.id) && uuid(requestExecution.id) && requestExecution.id === rawExecution.id && organizationConsistent;
  const status = String(execution.status || "").toLowerCase();
  const pendingRequest = request.status === "pending";
  // A commit/cancel receipt is not the authoritative monitoring baseline.
  if ((method === "runs.commit" || method === "runs.cancel") && uuid(rawExecution.id)) {
    summary.nextAction = { tool: "loomex_run_get", arguments: { runId: rawExecution.id } };
  } else if ((method === "runs.get" || method === "runs.wait" || method === "runs.events") && uuid(rawExecution.id)) {
    if (!organizationConsistent) {
      summary.stateNeedsVerification = true;
    } else if (data.hasMoreEvents === true) {
      const events = Array.isArray(data.events) ? data.events : [];
      const sequences = events.map(event => object(event).sequence);
      const last = sequences.at(-1);
      if (typeof last === "number" && Number.isSafeInteger(last) && last >= 0 &&
          typeof data.latestSequence === "number" && Number.isSafeInteger(data.latestSequence) && data.latestSequence > last &&
          sequences.every((value, index) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
            (index === 0 || value > (sequences[index - 1] as number)))) {
        summary.nextAction = { tool: "loomex_run_events", arguments: { runId: rawExecution.id, afterSequence: last } };
      } else summary.stateNeedsVerification = true;
    } else if (TERMINAL.has(status)) {
      if (status !== "deleted") summary.nextAction = { tool: "loomex_run_result", arguments: { runId: rawExecution.id } };
    } else if (pendingRequest) {
      if (uuid(rawRequest.id) && requestBelongsToRun) {
        summary.requiresUserInput = true;
        summary.nextAction = { tool: "loomex_interaction_view", arguments: { requestId: rawRequest.id } };
        summary.headlessAction = { tool: "loomex_interaction_get", arguments: { requestId: rawRequest.id } };
      } else summary.stateNeedsVerification = true;
    } else if (data.humanRequest !== undefined && data.humanRequest !== null ||
        data.waitState === "agent_dispatch_required" || data.waitState === "human_action_required") {
      summary.stateNeedsVerification = true;
    } else if (ACTIVE.has(status)) {
      summary.nextAction = { tool: "loomex_run_wait", arguments: { runId: rawExecution.id, timeoutSeconds: 30,
        ...(Number.isSafeInteger(data.latestSequence) && typeof data.latestSequence === "number" && data.latestSequence >= 0
          ? { afterSequence: data.latestSequence } : {}) } };
    }
  } else if (method === "interactions.get" && pendingRequest && uuid(rawRequest.id) && uuid(requestExecution.id) && organizationConsistent &&
      (!rawExecution.id || requestBelongsToRun) && !TERMINAL.has(status)) {
    summary.requiresUserInput = true;
    summary.awaitingUserAnswer = true;
  }
  if ((method === "runs.get" || method === "runs.wait" || method === "runs.events") && uuid(rawExecution.id)) {
    summary.monitoring = monitoring(summary, status, organizationConsistent);
  }
  return summary;
}
