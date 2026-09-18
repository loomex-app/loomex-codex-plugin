import type { RecoveryRegistrationState } from "../src/monitoring-contract.js";

export type MonitoringProjection = {
  readonly execution?: { readonly id?: string };
  readonly monitoring?: {
    readonly state?: string;
    readonly recovery?: {
      readonly observedLifecycle?: string;
      readonly requiredLifecycle?: string;
      readonly requiredAction?: string;
    };
    readonly liveFollow?: {
      readonly mode?: string;
      readonly nextAction?: string;
    };
  };
  readonly nextAction?: {
    readonly tool?: string;
    readonly arguments?: Record<string, unknown>;
  };
};

export type TranscriptEntry =
  | { readonly kind: "follow"; readonly runId: string; readonly taskId: string; readonly trigger: "run_started" | "explicit_follow" | "interaction_accepted"; readonly knownAutomationId?: string }
  | { readonly kind: "projection"; readonly method: "runs.get" | "runs.wait" | "runs.events"; readonly projection: MonitoringProjection }
  | { readonly kind: "tool"; readonly name: string; readonly arguments?: Record<string, unknown>; readonly result?: Record<string, unknown> }
  /** Raw host recorder event. It is normalized before contract checking. */
  | { readonly kind: "host_event"; readonly name?: string; readonly method?: string; readonly toolName?: string; readonly tool?: string; readonly arguments?: Record<string, unknown>; readonly input?: Record<string, unknown>; readonly params?: Record<string, unknown>; readonly result?: Record<string, unknown>; readonly output?: Record<string, unknown>; readonly response?: Record<string, unknown>; readonly event?: Record<string, unknown> }
  | { readonly kind: "assistant_final"; readonly text: string; readonly recoveryEstablished?: boolean };

export interface TranscriptIssue {
  readonly code: "final_before_poll" | "recovery_initialization_missing" | "recovery_claim_unverified" | "duplicate_request_presentation" | "stale_request_presentation" | "recovery_create_unpermitted" | "recovery_host_mutation_unpermitted" | "follow_identity_unverified" | "poll_retry_without_observation";
  readonly message: string;
}

function requestId(entry: Extract<TranscriptEntry, { kind: "tool" }>): string | undefined {
  const value = entry.arguments?.requestId;
  return typeof value === "string" ? value : undefined;
}

/** Accept recorder output from the host without making host-only fields part
 * of the plugin's fictional automation input schema. */
export function normalizeMonitoringTranscript(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.flatMap((entry) => {
    if (entry.kind !== "host_event") return [entry];
    const source = (entry.event ?? entry) as Record<string, unknown>;
    const name = typeof source.name === "string" ? source.name :
      typeof source.method === "string" ? source.method :
        typeof source.toolName === "string" ? source.toolName :
          typeof source.tool === "string" ? source.tool : entry.name;
    if (name === undefined) return [];
    const args = source.arguments ?? source.input ?? source.params ?? entry.arguments;
    const result = source.result ?? source.output ?? source.response ?? entry.result;
    return [{ kind: "tool", name,
      ...(args !== null && typeof args === "object" && !Array.isArray(args) ? { arguments: args as Record<string, unknown> } : {}),
      ...(result !== null && typeof result === "object" && !Array.isArray(result) ? { result: result as Record<string, unknown> } : {}),
    } as TranscriptEntry];
  }) as TranscriptEntry[];
}

function isPolling(projection: MonitoringProjection | undefined): boolean {
  const tool = projection?.nextAction?.tool;
  return projection?.monitoring?.liveFollow?.mode === "continue_when_explicit" ||
    tool === "loomex_run_wait" || tool === "loomex_run_events";
}

function recordFromResult(result: Record<string, unknown>): Record<string, unknown> {
  const nested = [result.structuredContent, result.data, result.automation, result.record];
  for (const value of nested) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const candidate = value as Record<string, unknown>;
      if (candidate.data !== null && typeof candidate.data === "object" && !Array.isArray(candidate.data)) {
        const data = candidate.data as Record<string, unknown>;
        if (data.automation !== null && typeof data.automation === "object" && !Array.isArray(data.automation)) {
          return data.automation as Record<string, unknown>;
        }
        if (typeof data.id === "string") return data;
      }
      if (candidate.automation !== null && typeof candidate.automation === "object" && !Array.isArray(candidate.automation)) {
        return candidate.automation as Record<string, unknown>;
      }
      if (candidate.record !== null && typeof candidate.record === "object" && !Array.isArray(candidate.record)) {
        return candidate.record as Record<string, unknown>;
      }
      if (typeof candidate.id === "string") return candidate;
    }
  }
  return result;
}

function recoveryRecordFromResult(result: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidates = [result, result.data, result.structuredContent];
  for (const candidateValue of candidates) {
    if (candidateValue === null || typeof candidateValue !== "object" || Array.isArray(candidateValue)) continue;
    const candidate = candidateValue as Record<string, unknown>;
    if (candidate.recovery !== null && typeof candidate.recovery === "object" && !Array.isArray(candidate.recovery)) {
      return candidate.recovery as Record<string, unknown>;
    }
  }
  return undefined;
}

function markerParts(record: Record<string, unknown>): { marker: string; taskId: string; runId: string } | undefined {
  const values = [record.marker, record.prompt, record.name].filter((value): value is string => typeof value === "string");
  for (const value of values) {
    const match = value.match(/loomex-follow-recovery:([^:\s]+):([^\s.]+(?:-[^\s.]+)*)/);
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      return { marker: `loomex-follow-recovery:${match[1]}:${match[2]}`, taskId: match[1], runId: match[2] };
    }
  }
  return undefined;
}

function recoveryVerification(entry: Extract<TranscriptEntry, { kind: "tool" }>): { id: string; runId: string; taskId: string; status: "ACTIVE" | "PAUSED" } | undefined {
  if (entry.name !== "automation_update") return undefined;
  const result = recordFromResult(entry.result ?? {});
  const id = entry.arguments?.id;
  const parts = markerParts(result);
  if (!(result.kind === "heartbeat" &&
    entry.arguments?.mode === "view" &&
    typeof id === "string" && result.id === id &&
    (result.status === "ACTIVE" || result.status === "PAUSED") &&
    parts !== undefined && result.targetThreadId === parts.taskId &&
    result.rrule === "FREQ=MINUTELY;INTERVAL=2")) return undefined;
  if (parts === undefined) return undefined;
  return { id, runId: parts.runId, taskId: parts.taskId, status: result.status as "ACTIVE" | "PAUSED" };
}

function createResultId(entry: Extract<TranscriptEntry, { kind: "tool" }>): string | undefined {
  if (entry.name !== "automation_update" || entry.arguments?.mode !== "create") return undefined;
  const result = recordFromResult(entry.result ?? {});
  return typeof result.id === "string" ? result.id : undefined;
}

function responseAccepted(entry: Extract<TranscriptEntry, { kind: "tool" }>): boolean {
  // Legacy transcript entries omit a result and represent an accepted tool
  // action. When a result exists, an explicit failure must preserve the
  // pending request and force a fresh authoritative read.
  const result = entry.result;
  if (result === undefined) return true;
  if (result.ok === false || result.error !== undefined) return false;
  const data = result.data;
  if (data !== null && typeof data === "object" && !Array.isArray(data) &&
      ((data as Record<string, unknown>).ok === false || (data as Record<string, unknown>).error !== undefined)) return false;
  const nestedData = data !== null && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown> : undefined;
  const status = result.requestStatus ?? result.status ?? nestedData?.requestStatus ?? nestedData?.status;
  return status !== "failed" && status !== "error" && status !== "rejected";
}

function claimsRecovery(entry: Extract<TranscriptEntry, { kind: "assistant_final" }>): boolean {
  return entry.recoveryEstablished === true ||
    /\b(?:recovery|heartbeat)\b[\s\S]*\b(?:active|configured|established|verified)\b/i.test(entry.text);
}

/**
 * Checks host-visible monitoring behavior. This intentionally receives a
 * transcript instead of reading implementation details, so a future host or
 * transport can use the same contract with its own tool recorder.
 */
export function checkMonitoringTranscript(entries: readonly TranscriptEntry[]): TranscriptIssue[] {
  const normalizedEntries = normalizeMonitoringTranscript(entries);
  const issues: TranscriptIssue[] = [];
  let latestProjection: MonitoringProjection | undefined;
  let follow: Extract<TranscriptEntry, { kind: "follow" }> | undefined;
  let recoveryVerified: { id: string; runId: string; taskId: string; status: "ACTIVE" | "PAUSED" } | undefined;
  let expectedVerificationId: string | undefined;
  let followIdentityValid = true;
  let durableRecordInitialized = false;
  let registrationState: RecoveryRegistrationState | undefined;
  let recoveryOperationPermitted = false;
  let recoveryOperationKind: string | undefined;
  let recoveryOperationSettled = false;
  const displayedRequests = new Set<string>();
  const resolvedRequests = new Set<string>();
  let freshReadRequired = false;
  // A wait is a response to one authoritative projection.  In particular, a
  // tool failure does not authorize reissuing that wait from memory: a fresh
  // runner observation must still say that waiting is the next action.
  let expectedPollTool: string | undefined;

  for (const entry of normalizedEntries) {
    if (entry.kind === "follow") {
      follow = entry;
      recoveryVerified = undefined;
      expectedVerificationId = entry.knownAutomationId;
      followIdentityValid = true;
      durableRecordInitialized = false;
      registrationState = entry.knownAutomationId === undefined ? undefined : "registered";
      recoveryOperationPermitted = entry.knownAutomationId !== undefined;
      recoveryOperationSettled = entry.knownAutomationId !== undefined;
      continue;
    }
    if (entry.kind === "projection") {
      latestProjection = entry.projection;
      expectedPollTool = isPolling(entry.projection) ? entry.projection.nextAction?.tool : undefined;
      if (follow !== undefined && entry.projection.execution?.id !== follow.runId) {
        followIdentityValid = false;
        issues.push({ code: "follow_identity_unverified", message: "authoritative monitoring projection does not match the followed run" });
      }
      if (freshReadRequired && entry.method === "runs.get") freshReadRequired = false;
      continue;
    }

    if (entry.kind === "tool") {
      if ((entry.name === "loomex_run_wait" || entry.name === "loomex_run_events") &&
          entry.name !== expectedPollTool) {
        issues.push({
          code: "poll_retry_without_observation",
          message: `${entry.name} was retried without a fresh authoritative projection requiring it`,
        });
      }
      if (entry.name === expectedPollTool) expectedPollTool = undefined;
      const result = entry.result ?? {};
      if (entry.name === "loomex_recovery_get") {
        const recovery = recoveryRecordFromResult(result);
        const found = result.found ?? (result.data !== null && typeof result.data === "object" && !Array.isArray(result.data) ? (result.data as Record<string, unknown>).found : undefined);
        durableRecordInitialized = found === true;
        if (recovery !== undefined && typeof recovery.registrationState === "string") registrationState = recovery.registrationState as RecoveryRegistrationState;
      }
      if (entry.name === "loomex_recovery_update" || entry.name === "loomex_recovery_operation_begin" || entry.name === "loomex_recovery_operation_settle") {
        durableRecordInitialized = true;
        const recovery = recoveryRecordFromResult(result);
        if (recovery !== undefined && typeof recovery.registrationState === "string") registrationState = recovery.registrationState as RecoveryRegistrationState;
      }
      if (entry.name === "loomex_recovery_operation_begin") {
        recoveryOperationPermitted = result.attemptPermitted === true ||
          (result.data !== null && typeof result.data === "object" && !Array.isArray(result.data) && (result.data as Record<string, unknown>).attemptPermitted === true);
        const operation = result.operation ??
          (result.data !== null && typeof result.data === "object" && !Array.isArray(result.data)
            ? (result.data as Record<string, unknown>).operation
            : undefined);
        recoveryOperationKind = operation !== null && typeof operation === "object" && !Array.isArray(operation)
          ? (operation as Record<string, unknown>).kind as string | undefined
          : undefined;
      }
      if (entry.name === "loomex_recovery_operation_settle" && (result.status === "succeeded" || result.operation !== undefined || (result.data !== null && typeof result.data === "object" && !Array.isArray(result.data)))) {
        recoveryOperationSettled = true;
        const settled = recoveryRecordFromResult(result);
        const automationId = settled?.automationId;
        if (typeof automationId === "string") expectedVerificationId = automationId;
      }
      const hostMutation = entry.name === "automation_update" &&
        ["create", "update", "pause", "remove"].includes(String(entry.arguments?.mode));
      if (hostMutation && (!recoveryOperationPermitted || recoveryOperationKind !== entry.arguments?.mode)) {
        issues.push({
          code: entry.arguments?.mode === "create" ? "recovery_create_unpermitted" : "recovery_host_mutation_unpermitted",
          message: entry.arguments?.mode === "create"
            ? "recovery creation requires a matching durable journal permit"
            : "every recovery host mutation requires its matching durable journal permit",
        });
      }
      if (entry.name === "automation_update" && entry.arguments?.mode === "create" && recoveryOperationPermitted && recoveryOperationKind === "create" &&
          (registrationState !== "not_attempted" && registrationState !== "attempt_in_flight")) {
        issues.push({ code: "recovery_create_unpermitted", message: "recovery creation requires durable registration state not_attempted" });
      }
      if (entry.name === "automation_update" && entry.arguments?.mode === "create" &&
          registrationState === "not_attempted" && recoveryOperationPermitted && follow?.knownAutomationId === undefined) {
        const id = createResultId(entry);
        if (id !== undefined) expectedVerificationId = id;
      }
      const verification = recoveryVerification(entry);
      if (verification !== undefined && verification.id === expectedVerificationId) recoveryVerified = verification;
      if ((entry.name === "loomex_interaction_respond" || entry.name === "loomex_interaction_decide") && requestId(entry) !== undefined && responseAccepted(entry)) {
        // A definitive answer invalidates the old card. The next run read must
        // decide whether the same request is still pending before it is shown.
        const id = requestId(entry)!;
        displayedRequests.delete(id);
        resolvedRequests.add(id);
        freshReadRequired = true;
      }
      if ((entry.name === "loomex_interaction_view" || entry.name === "loomex_interaction_get")) {
        if (follow?.trigger === "run_started" && !durableRecordInitialized) {
          issues.push({ code: "recovery_initialization_missing", message: "run-start continuation presented input without initializing its durable recovery record" });
        }
        const id = requestId(entry);
        if (freshReadRequired || (id !== undefined && resolvedRequests.has(id))) {
          issues.push({ code: "stale_request_presentation", message: `request ${id ?? "unknown"} was presented without a fresh run read or after acceptance` });
        }
        if (id !== undefined && displayedRequests.has(id)) {
          issues.push({ code: "duplicate_request_presentation", message: `request ${id} was presented twice without a new authoritative request` });
        }
        if (id !== undefined) displayedRequests.add(id);
      }
      continue;
    }

    if (entry.kind !== "assistant_final") continue;
    // A one-off status snapshot may legitimately end here.  Only a declared
    // live follow turns an active runner action into an obligation to wait.
    if (follow !== undefined && isPolling(latestProjection)) {
      issues.push({ code: "final_before_poll", message: `final text appeared while nextAction still requires ${latestProjection?.nextAction?.tool ?? "polling"}` });
    }
    const activeRecoveryMatchesFollow = followIdentityValid && recoveryVerified?.status === "ACTIVE" &&
      recoveryOperationSettled &&
      recoveryVerified.runId === follow?.runId && recoveryVerified.taskId === follow?.taskId;
    if (claimsRecovery(entry) && !activeRecoveryMatchesFollow) {
      issues.push({ code: "recovery_claim_unverified", message: "recovery was claimed without a matching active heartbeat receipt" });
    }
  }

  return issues;
}
