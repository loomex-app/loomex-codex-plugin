import { z } from "zod";
import type { JsonValue } from "./protocol.js";
import { monitoringContract } from "./monitoring-contract.js";

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

const FOLLOW_ACTIVATION_STATES = new Set(["handoff_pending", "hook_observed", "hook_not_observed"]);
const FOLLOW_BINDING_KINDS = new Set(["ui_workspace_handoff", "host_session_unverified_task", "verified_host_task"]);
const FOLLOW_LIFECYCLES = new Set(["handoff_pending", "active", "terminal", "superseded", "paused", "failed"]);
const FOLLOW_REQUIRED_ACTIONS = new Set(["none", "wait", "drain_events", "handoff", "result_read", "pause"]);
const RECOVERY_REGISTRATION_STATES = new Set(["not_attempted", "attempt_in_flight", "registered", "ambiguous", "removed"]);
const RECOVERY_LIFECYCLES = new Set(["unchecked", "verified", "unavailable", "ambiguous", "paused", "removed"]);
const DIAGNOSTIC_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "Interrupt"]);
const DIAGNOSTIC_OUTCOMES = new Set(["accepted", "rejected"]);

function enumField(value: JsonValue | undefined, allowed: ReadonlySet<string>): string | undefined {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}
function timestamp(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Keep runner-originated diagnostic labels categorical.  A local-control
 * failure may evolve its fixed code independently, so classify known stable
 * families while never reflecting arbitrary runner error text or identifiers.
 */
function diagnosticClass(outcome: string | undefined, code: JsonValue | undefined): string {
  if (outcome === "accepted") return "runner_accepted";
  const value = typeof code === "string" ? code : "";
  if (/(?:ASSOCIATION|CONTINUATION|PAYLOAD|INVALID_REQUEST|HANDOFF_MISMATCH)/.test(value)) {
    return "payload_or_association_rejected";
  }
  if (/(?:RUNNER|INTERNAL|UNAVAILABLE|DATABASE|STORE)/.test(value)) return "runner_error";
  return "runner_rejected";
}

function followRecord(value: JsonValue): ObjectValue {
  const source = object(value);
  const binding = object(source.binding);
  const activation = enumField(source.activationState, FOLLOW_ACTIVATION_STATES) ?? "unknown";
  const result: ObjectValue = {
    // Do not expose host session or task identifiers to the model. The runner
    // retains the exact association; this projection only proves its class.
    binding: {
      kind: enumField(binding.kind, FOLLOW_BINDING_KINDS) ?? "unknown",
      verifiedHostTask: binding.verifiedHostTask === true,
    },
    activation,
    hookObserved: source.hostHookObserved === true,
  };
  const lifecycle = enumField(source.lifecycle, FOLLOW_LIFECYCLES);
  const requiredAction = enumField(source.requiredAction, FOLLOW_REQUIRED_ACTIONS);
  const updatedAt = timestamp(source.updatedAt);
  if (lifecycle !== undefined) result.lifecycle = lifecycle;
  if (requiredAction !== undefined) result.requiredAction = requiredAction;
  if (updatedAt !== undefined) result.updatedAt = updatedAt;
  return result;
}

function recoveryRecord(value: JsonValue): ObjectValue {
  const source = object(value);
  const binding = object(source.binding);
  const result: ObjectValue = {
    // Recovery binding IDs are host-owned. Their presence is useful evidence,
    // but their raw values are never needed in a model-facing run summary.
    bindingRecorded: typeof binding.hostId === "string" && typeof binding.hostTaskId === "string",
  };
  const registrationState = enumField(source.registrationState, RECOVERY_REGISTRATION_STATES);
  const lifecycle = enumField(source.recordedLifecycle, RECOVERY_LIFECYCLES);
  const observedAt = timestamp(source.observedAt);
  const updatedAt = timestamp(source.updatedAt);
  if (registrationState !== undefined) result.registrationState = registrationState;
  if (lifecycle !== undefined) result.recordedLifecycle = lifecycle;
  if (source.automationIdRecorded === true) result.automationIdRecorded = true;
  if (source.hostEvidenceRecorded === true) result.hostEvidenceRecorded = true;
  if (source.previouslyVerified === true) result.previouslyVerified = true;
  if (source.operationPending === true) result.operationPending = true;
  if (observedAt !== undefined) result.observedAt = observedAt;
  if (updatedAt !== undefined) result.updatedAt = updatedAt;
  return result;
}

function hookDiagnostic(value: JsonValue): ObjectValue {
  const source = object(value);
  const event = enumField(source.event, DIAGNOSTIC_EVENTS);
  const outcome = enumField(source.outcome, DIAGNOSTIC_OUTCOMES);
  const observedAt = timestamp(source.observedAt);
  const result: ObjectValue = { classification: diagnosticClass(outcome, source.code) };
  if (event !== undefined) result.event = event;
  if (outcome !== undefined) result.outcome = outcome;
  if (observedAt !== undefined) result.observedAt = observedAt;
  return result;
}

/** Prior runner observations stay run-scoped and never become host guarantees. */
function monitoringEvidence(data: ObjectValue, runId: JsonValue | undefined): ObjectValue | undefined {
  const value = object(object(data.details).monitoring);
  if (value.schemaVersion !== "loomex.monitoring-observation/v1" || !uuid(runId) || value.runId !== runId) return undefined;
  const result: ObjectValue = { schemaVersion: value.schemaVersion, runId, guarantee: "none", freshHostVerificationRequired: true };
  for (const section of ["follow", "recovery"] as const) {
    const source = object(value[section]);
    const records = Array.isArray(source.records) ? source.records : [];
    result[section] = {
      records: records.slice(0, 3).map(item => section === "follow" ? followRecord(item) : recoveryRecord(item)),
      recordCount: typeof source.recordCount === "number" ? source.recordCount : records.length,
      truncated: source.truncated === true || records.length > 3,
    };
    if (section === "follow") {
      const diagnostics = object(source.hookDiagnostics);
      const diagnosticRows = Array.isArray(diagnostics.records) ? diagnostics.records : [];
      result[section].hookDiagnostics = {
        records: diagnosticRows.slice(0, 3).map(hookDiagnostic),
        recordCount: typeof diagnostics.recordCount === "number" ? diagnostics.recordCount : diagnosticRows.length,
        truncated: diagnostics.truncated === true || diagnosticRows.length > 3,
      };
    }
  }
  return result;
}

function run(value: JsonValue | undefined): ObjectValue {
  return fields(object(value), ["id", "status", "workflowName", "name", "workflowId", "workflowVersionId", "currentNodeName", "stageLabel"]);
}

/**
 * Terminal errors are useful to a caller, but backend/provider error objects
 * may contain raw command output, credentials, or arbitrary nested context.
 * Keep only the stable, user-actionable fields at the MCP boundary.
 */
function failure(value: JsonValue | undefined): ObjectValue | undefined {
  const source = object(value);
  const details = object(source.details);
  const pluginAgent = object(details.pluginAgentError);
  const providerError = object(object(pluginAgent.details).error);
  const effective = Object.keys(providerError).length > 0 ? providerError : source;
  const result = fields(effective, ["code", "provider", "model", "retryable", "recoverable", "retryAfterSeconds"]);
  for (const [key, fallback] of Object.entries(fields(source, ["provider", "model", "retryable", "recoverable", "retryAfterSeconds"]))) {
    if (result[key] === undefined) result[key] = fallback;
  }
  const node = fields(source, ["nodeKey", "nodeName"]);
  Object.assign(result, node);
  const code = String(result.code ?? source.code ?? "");
  const message = [effective.message, source.message].find((candidate): candidate is string => typeof candidate === "string");
  const original = object(object(effective.details).originalError);
  const validation = object(object(original.details).validation);
  const directValidation = object(object(effective.details).validation);
  const errors = Array.isArray(validation.errors) ? validation.errors
    : Array.isArray(directValidation.errors) ? directValidation.errors : [];
  const semanticIssues = errors.map(object).filter((issue) => issue.validator === "semantic"
    && issue.code === "HUMAN_INPUT_INVALID" && typeof issue.path === "string"
    && /^\$\.[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(issue.path));
  if (["PLUGIN_AGENT_OUTPUT_INVALID", "PLUGIN_AGENT_OUTPUT_REPAIR_UNSUPPORTED"].includes(code)) {
    result.message = semanticIssues.length
      ? "The generated questions were invalid. No question form was created; automatic output repair is unavailable."
      : "The AI output did not satisfy the workflow contract. Automatic output repair is unavailable.";
    if (semanticIssues.length) {
      result.validationIssues = semanticIssues.slice(0, 5).map((issue) => fields(issue, ["path", "code"], 200));
    }
  } else if (/usage\s+limit|rate\s+limit/i.test(message ?? "") || /USAGE_LIMIT|RATE_LIMIT/i.test(code)) {
    result.message = "The provider usage limit was reached. Wait for provider availability, then start a new run.";
  } else if (code === "PROVIDER_MODEL_UNAVAILABLE") {
    result.message = "The configured provider account cannot use this model. Select an available model and prepare a new run.";
  } else if (/AUTH|CREDENTIAL|LOGIN/i.test(code)) {
    result.message = "The provider could not authenticate. Reconnect the provider, then start a new run.";
  } else if (/UNAVAILABLE|NOT_FOUND|NOT_INSTALLED/i.test(code)) {
    result.message = "The configured provider is unavailable. Correct the local provider setup, then start a new run.";
  } else if (Object.keys(result).length > 0) {
    result.message = "The workflow node failed. Review the runner setup and start a new run when it is ready.";
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
function question(value: JsonValue | undefined): ObjectValue {
  const spec = object(value);
  return { ...fields(spec, ["id", "schemaVersion", "collectionMode", "inputType"]), ...fields(spec, ["question"], 500) };
}
function interaction(value: JsonValue | undefined): ObjectValue {
  const request = object(value);
  const spec = object(request.inputSpec);
  const result: ObjectValue = fields(request, ["id", "status", "type", "title", "answerChannel", "schemaDigest"]);
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
 * A runner snapshot can describe the required host recovery transition, but
 * cannot observe or perform scheduler work. `nextAction` remains independent
 * and authoritative for execution data.
 */
function monitoring(summary: ObjectValue, status: string, identityValid: boolean): ObjectValue {
  if (!identityValid || summary.stateNeedsVerification === true) {
    return monitoringContract({ state: "needs_attention" }) as unknown as ObjectValue;
  }
  const tool = object(summary.nextAction).tool;
  if (tool === "loomex_run_events") {
    return monitoringContract({ state: "active", eventPagesPending: true, observation: "event_pages_pending" }) as unknown as ObjectValue;
  }
  if (tool === "loomex_interaction_view" || tool === "loomex_interaction_get") {
    return monitoringContract({ state: "needs_input" }) as unknown as ObjectValue;
  }
  if (tool === "loomex_run_result" || TERMINAL.has(status)) {
    return monitoringContract({ state: "terminal", resultPending: tool === "loomex_run_result" }) as unknown as ObjectValue;
  }
  if (tool === "loomex_run_wait") {
    return monitoringContract({ state: "active", observation: summary.timedOut === true ? "quiet_timeout" : "active" }) as unknown as ObjectValue;
  }
  return monitoringContract({ state: "needs_attention" }) as unknown as ObjectValue;
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
  const progress = object(data.progress);
  if (progress.version === 1 && Array.isArray(progress.activeNodes)) {
    const activity = (value: JsonValue | undefined) => value == null ? null : fields(object(value), ["eventId", "nodeExecutionId", "jobId", "attempt", "timestamp", "kind", "summary", "provenance"]);
    summary.progress = {
      version: 1,
      activeNodes: progress.activeNodes.slice(0, PAGE_PREVIEW).map((value) => {
        const node = object(value);
        return { ...fields(node, ["nodeExecutionId", "nodeName", "status", "attempt", "elapsedSeconds", "waitState"]), lastActivity: activity(node.lastActivity) };
      }),
      count: progress.activeNodeCount ?? progress.activeNodes.length, truncated: progress.hasMore === true || progress.activeNodesTruncated === true || progress.activeNodes.length > PAGE_PREVIEW,
      hasMore: progress.hasMore === true,
      latestActivity: activity(progress.latestActivity),
    };
    const latestActivity = object(progress.latestActivity);
    // Provider activity is not workflow completion. This explicit marker lets
    // chat explain the short delivery/finalization interval without claiming
    // that a node is paused or completed before the backend says so.
    if (ACTIVE.has(String(execution.status || "").toLowerCase()) &&
      typeof latestActivity.kind === "string" && /(?:completed|finished)$/i.test(latestActivity.kind)) {
      summary.providerCompletionPending = true;
    }
  }
  if (typeof request.id === "string") summary.humanRequest = request;
  if (Array.isArray(data.events)) summary.eventCount = data.events.length;
  if (Array.isArray(data.jobs)) summary.jobCount = data.jobs.length;
  const rawExecution = object(data.execution);
  const rawRequest = object(data.humanRequest);
  const requestExecution = object(rawRequest.execution);
  const organizations = [rawExecution.organizationId, rawRequest.organizationId, requestExecution.organizationId]
    .filter((value) => value !== undefined && value !== null);
  // Follow-up and human-answer actions cross an organization boundary. Older
  // non-actionable snapshots may omit this identity, but an absent identity is
  // never sufficient authority to direct the user or model to act.
  const organizationConsistent = organizations.length > 0 && organizations.every((value) => uuid(value)) && new Set(organizations).size <= 1;
  const requestBelongsToRun = uuid(rawExecution.id) && uuid(requestExecution.id) && requestExecution.id === rawExecution.id && organizationConsistent;
  const status = String(execution.status || "").toLowerCase();
  if (["failed", "error", "rejected", "expired"].includes(status)) {
    const projectedFailure = failure(rawExecution.error) ?? failure(data.error);
    if (projectedFailure !== undefined) summary.failure = projectedFailure;
  }
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
      if (rawRequest.answerChannel === "unsupported") {
        summary.stateNeedsVerification = true;
        summary.answerIssue = fields(object(rawRequest.answerIssue), ["code", "message"]);
      } else if (uuid(rawRequest.id) && requestBelongsToRun) {
        summary.requiresUserInput = true;
        summary.nextAction = { tool: rawRequest.answerChannel === "chat" ? "loomex_interaction_get" : "loomex_interaction_view", arguments: { requestId: rawRequest.id } };
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
    if (rawRequest.answerChannel === "unsupported") {
      summary.stateNeedsVerification = true;
      summary.answerIssue = fields(object(rawRequest.answerIssue), ["code", "message"]);
      return summary;
    }
    summary.requiresUserInput = true;
    summary.awaitingUserAnswer = true;
    if (rawRequest.answerChannel === "chat") {
      summary.answerChannel = "chat";
      const exactQuestion = object(rawRequest.inputSpec).question ?? rawRequest.prompt ?? "";
      summary.question = typeof exactQuestion === "string" ? exactQuestion : "";
      summary.responseSchema = rawRequest.responseSchema ?? null;
      summary.schemaDigest = rawRequest.schemaDigest ?? null;
      summary.answerInstruction = "Ask this question directly in chat. Submit a clear direct user answer after a fresh request read; research requests are not answers. Review synthesized answers with the user first. Never open a textarea or replay an accepted answer.";
    }
  }
  if ((method === "runs.get" || method === "runs.wait" || method === "runs.events" || method === "runs.result") && uuid(rawExecution.id)) {
    summary.monitoring = monitoring(summary, status, organizationConsistent);
    const evidence = monitoringEvidence(data, rawExecution.id);
    if (evidence) summary.monitoringEvidence = evidence;
  }
  return summary;
}
