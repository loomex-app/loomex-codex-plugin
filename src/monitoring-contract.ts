/**
 * Canonical, host-owned contract for monitoring an existing Loomex run.
 *
 * The runner is authoritative for execution and nextAction. Codex is the only
 * component that can inspect, create, pause, or remove a scheduled recovery,
 * so this contract deliberately records required work and observed evidence
 * separately. A projection can never claim a scheduler mutation occurred.
 */
export const MONITORING_CONTRACT_VERSION = "loomex-monitoring/v2";

/**
 * A deliberately small, replay-safe continuation envelope shared by generated
 * chat followups and the lifecycle hook. The receipt is opaque to the plugin:
 * only the runner can verify it. The generated command is intentionally a
 * complete, receipt-bound request to follow an existing run; run identifiers
 * copied from a card or transcript cannot activate monitoring on their own.
 */
/** Versioned, user-visible generated Markdown envelope. */
export const FOLLOW_CONTINUATION_SCHEMA_VERSION = "loomex-runs-follow-existing-run-continuation/v2" as const;
/** The legacy text envelope and the runner lifecycle wire shape. */
export const LEGACY_FOLLOW_CONTINUATION_SCHEMA_VERSION = "loomex.follow-session.continuation/v1" as const;
export const FOLLOW_GENERATED_FORMAT_VERSION = FOLLOW_CONTINUATION_SCHEMA_VERSION;
export const FOLLOW_COMMAND = "$loomex-runs" as const;
export const FOLLOW_EXISTING_RUN_INTENT = "follow-existing-run" as const;
export const FOLLOW_GENERATED_MARKDOWN_INSTRUCTIONS = [
  "Follow the exact existing Loomex run identified above: first call `loomex_run_get` with this run ID, then follow its authoritative `nextAction`.",
  "While the fresh authoritative `nextAction` is `loomex_run_wait` or `loomex_run_events`, do not final-answer: drain required event pages, then call the next action. Active progress, provider activity, and quiet timeouts require another bounded wait. Hooks and schedules are not prerequisites.",
  "Final-answer only after presenting verified user input, retrieving the complete authoritative terminal result, an actionable observation failure, or an explicit user stop. Each wait is bounded; do not add hidden indefinite waits or UI polling.",
  "Do not start another run or resubmit an accepted response.",
] as const;

export type FollowContinuation = {
  schemaVersion: typeof FOLLOW_CONTINUATION_SCHEMA_VERSION;
  source: "generated_markdown";
  runId: string;
  /** Opaque, base64url receipt verified by the local runner. */
  receipt?: string;
};

/** A complete generated continuation issued before the command migration. */
export type LegacyFollowContinuation = Omit<FollowContinuation, "schemaVersion"> & {
  schemaVersion: typeof LEGACY_FOLLOW_CONTINUATION_SCHEMA_VERSION;
};

export type ParsedFollowContinuation = FollowContinuation | LegacyFollowContinuation;

const FOLLOW_RUN_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FOLLOW_RECEIPT = "[A-Za-z0-9_-]{16,2048}";
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Previously issued complete v2 envelopes remain readable with their receipt. */
const PREVIOUS_FOLLOW_GENERATED_MARKDOWN_INSTRUCTIONS = [
  "Follow the exact existing Loomex run identified above: first call `loomex_run_get` with this run ID, then follow its authoritative `nextAction`.",
  "Do not start another run or resubmit an accepted response.",
] as const;
const FOLLOW_GENERATED_PATTERN = new RegExp(
  `^${escapeRegex(FOLLOW_COMMAND)} ${escapeRegex(FOLLOW_EXISTING_RUN_INTENT)} (${FOLLOW_RUN_ID})\\n\\n<!-- ${escapeRegex(FOLLOW_GENERATED_FORMAT_VERSION)} receipt=(${FOLLOW_RECEIPT}) -->\\n\\n(?:${[FOLLOW_GENERATED_MARKDOWN_INSTRUCTIONS, PREVIOUS_FOLLOW_GENERATED_MARKDOWN_INSTRUCTIONS].map((instructions) => instructions.map(escapeRegex).join("\\n\\n")).join("|")})$`,
  "i",
);
/** Complete receipts issued before the command migration remain valid. */
const LEGACY_FOLLOW_GENERATED_PATTERN = new RegExp(
  `^\\$loomex-follow (${FOLLOW_RUN_ID})\\n\\n<!-- loomex-follow-continuation/v1 receipt=(${FOLLOW_RECEIPT}) -->\\n\\n${[
    "Follow this exact Loomex run: first call `loomex_run_get` with this run ID, then follow its authoritative `nextAction`.",
    "Do not start another run or resubmit an accepted response.",
  ].map(escapeRegex).join("\\n\\n")}$`,
  "i",
);

/** Render the only generated Markdown continuation accepted by the hook. */
export function formatFollowContinuationMarkdown(runId: string, receipt: string): string {
  if (!new RegExp(`^${FOLLOW_RUN_ID}$`, "i").test(runId) || !new RegExp(`^${FOLLOW_RECEIPT}$`).test(receipt)) {
    throw new TypeError("invalid Loomex follow continuation identity");
  }
  return `${FOLLOW_COMMAND} ${FOLLOW_EXISTING_RUN_INTENT} ${runId}\n\n<!-- ${FOLLOW_GENERATED_FORMAT_VERSION} receipt=${receipt} -->\n\n${FOLLOW_GENERATED_MARKDOWN_INSTRUCTIONS.join("\n\n")}`;
}

/**
 * Use this when the runner did not issue a receipt. It intentionally contains
 * the command only as inline code, so it cannot activate the lifecycle hook.
 */
export function formatManualFollowInstruction(runId: string): string {
  if (!new RegExp(`^${FOLLOW_RUN_ID}$`, "i").test(runId)) {
    throw new TypeError("invalid Loomex follow run identity");
  }
  return `To continue monitoring this exact Loomex run, submit \`${FOLLOW_COMMAND} ${FOLLOW_EXISTING_RUN_INTENT} ${runId}\`.`;
}

/**
 * Recognize only complete receipt-bound formatter output. During transition,
 * accept the complete prior v1 envelope too. Quoted, fenced, embedded, edited,
 * or bare command text is inert.
 */
export function parseFollowContinuation(value: unknown): ParsedFollowContinuation | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  const generated = value.match(FOLLOW_GENERATED_PATTERN);
  if (generated?.[1] !== undefined && generated[2] !== undefined) {
    return {
      schemaVersion: FOLLOW_CONTINUATION_SCHEMA_VERSION,
      source: "generated_markdown",
      runId: generated[1].toLowerCase(),
      receipt: generated[2],
    };
  }
  const legacy = value.match(LEGACY_FOLLOW_GENERATED_PATTERN);
  if (legacy?.[1] !== undefined && legacy[2] !== undefined) {
    return {
      schemaVersion: LEGACY_FOLLOW_CONTINUATION_SCHEMA_VERSION,
      source: "generated_markdown",
      runId: legacy[1].toLowerCase(),
      receipt: legacy[2],
    };
  }
  return undefined;
}

export const RECOVERY_LIFECYCLE_STATES = [
  "unchecked",
  "verified",
  "unavailable",
  "ambiguous",
  "paused",
  "removed",
] as const;

export type RecoveryLifecycleState = (typeof RECOVERY_LIFECYCLE_STATES)[number];
/**
 * Durable intent state for registration. This is deliberately separate from
 * the host's observed schedule lifecycle: the runner cannot infer either one
 * from execution metadata, and an unknown history is unsafe to treat as a
 * first registration.
 */
export const RECOVERY_REGISTRATION_STATES = [
  "not_attempted",
  "attempt_in_flight",
  "registered",
  "ambiguous",
  "removed",
] as const;

export type RecoveryRegistrationState = (typeof RECOVERY_REGISTRATION_STATES)[number];
export type MonitoringState = "active" | "needs_input" | "terminal" | "needs_attention";
/** Whether an explicitly requested live follow continues after this observation. */
export type LiveFollowDisposition =
  | "continue"
  | "await_user"
  | "terminal_result_pending"
  | "finished"
  | "observation_blocked";
export type RecoveryRequiredAction =
  | "read_registration_journal"
  | "initialize_and_verify"
  | "reconcile_and_verify"
  | "report_ambiguous"
  | "pause_before_input"
  | "pause_before_error"
  | "retrieve_result_then_remove"
  | "remove"
  | "none";
export type MonitoringObservation =
  | "active"
  | "quiet_timeout"
  | "event_pages_pending"
  | "human_input_required"
  | "terminal_result_pending"
  | "terminal_result_retrieved"
  | "actionable_error";

/**
 * Evidence may only come from a supported host capability or its returned
 * record. Runner execution metadata is never valid recovery evidence.
 */
export interface RecoveryEvidence {
  observedLifecycle: RecoveryLifecycleState;
  evidence:
    | "host_schedule_not_observed"
    | "host_schedule_record"
    | "host_capability_unavailable"
    | "host_operation_ambiguous";
}

export const UNCHECKED_RECOVERY_EVIDENCE: RecoveryEvidence = Object.freeze({
  observedLifecycle: "unchecked",
  evidence: "host_schedule_not_observed",
});

export const RECOVERY_MARKER_TEMPLATE = "loomex-follow-recovery:<host-task-id>:<run-id>";
export const RECOVERY_CADENCE = "two_minutes";

export interface MonitoringContract {
  contract: typeof MONITORING_CONTRACT_VERSION;
  state: MonitoringState;
  observation: MonitoringObservation;
  /** The runner did not observe a host schedule; this is never inferred. */
  recovery: {
    /** Durable registration state, independent of host record status. */
    registrationState: RecoveryRegistrationState | "not_observed";
    observedLifecycle: RecoveryLifecycleState;
    evidence: RecoveryEvidence["evidence"];
    requiredLifecycle: RecoveryLifecycleState;
    requiredAction: RecoveryRequiredAction;
    initialization: "after_event_pages" | "ready_to_initialize" | "not_applicable";
    appliesTo: "explicit_follow_or_continuation";
    markerTemplate: typeof RECOVERY_MARKER_TEMPLATE;
    cadence: typeof RECOVERY_CADENCE;
  };
  /**
   * nextAction remains the only authoritative runner action. Disposition says
   * whether to keep following after completing it, never a replacement action.
   * Recovery availability and registration do not gate bounded live waits.
   */
  liveFollow: {
    mode: "continue_when_explicit" | "stop";
    disposition: LiveFollowDisposition;
    nextAction: "authoritative_runner_action";
  };
}

export interface MonitoringContractOptions {
  state: MonitoringState;
  /** Event pages must be consumed before recovery initialization. */
  eventPagesPending?: boolean;
  /** A result must be consumed before terminal cleanup. */
  resultPending?: boolean;
  observation?: MonitoringObservation;
  /** Host-observed evidence, never inferred from runner output. */
  recoveryEvidence?: RecoveryEvidence;
  /** Durable host registration state, when supplied by the continuation. */
  recoveryRegistrationState?: RecoveryRegistrationState;
}

/**
 * Build the compact projection included beside a runner nextAction. Its
 * lifecycle is intentionally unchecked: the runner has no host automation
 * read channel. Host orchestration and transcript diagnostics track verified,
 * unavailable, ambiguous, paused, or removed observations separately.
 */
export function monitoringContract(options: MonitoringContractOptions): MonitoringContract {
  // Missing observation is not a journaled ambiguous create. Read the exact
  // journal before deciding whether to initialize, reconcile or report ambiguity.
  const registrationState: RecoveryRegistrationState | "not_observed" = options.recoveryRegistrationState ?? "not_observed";
  const base = {
    registrationState,
    ...(options.recoveryEvidence ?? UNCHECKED_RECOVERY_EVIDENCE),
    appliesTo: "explicit_follow_or_continuation" as const,
    markerTemplate: RECOVERY_MARKER_TEMPLATE as typeof RECOVERY_MARKER_TEMPLATE,
    cadence: RECOVERY_CADENCE as typeof RECOVERY_CADENCE,
  };

  if (options.state === "active") {
    const requiredAction = registrationState === "not_observed"
      ? "read_registration_journal"
      : registrationState === "not_attempted"
      ? "initialize_and_verify"
      : registrationState === "ambiguous"
        ? "report_ambiguous"
        : registrationState === "removed"
          ? "none"
          : "reconcile_and_verify";
    return {
      contract: MONITORING_CONTRACT_VERSION,
      state: "active",
      observation: options.observation ?? "active",
      recovery: {
        ...base,
        requiredLifecycle: "verified",
        requiredAction,
        initialization: options.eventPagesPending ? "after_event_pages" : "ready_to_initialize",
      },
      liveFollow: { mode: "continue_when_explicit", disposition: "continue", nextAction: "authoritative_runner_action" },
    };
  }
  if (options.state === "needs_input") {
    return {
      contract: MONITORING_CONTRACT_VERSION,
      state: "needs_input",
      observation: options.observation ?? "human_input_required",
      recovery: {
        ...base,
        requiredLifecycle: "paused",
        requiredAction: "pause_before_input",
        initialization: "not_applicable",
      },
      liveFollow: { mode: "stop", disposition: "await_user", nextAction: "authoritative_runner_action" },
    };
  }
  if (options.state === "terminal") {
    const observation = options.observation ?? (options.resultPending ? "terminal_result_pending" : "terminal_result_retrieved");
    const resultPending = observation === "terminal_result_pending";
    return {
      contract: MONITORING_CONTRACT_VERSION,
      state: "terminal",
      observation,
      recovery: {
        ...base,
        requiredLifecycle: "removed",
        requiredAction: resultPending ? "retrieve_result_then_remove" : "remove",
        initialization: "not_applicable",
      },
      liveFollow: { mode: "stop", disposition: resultPending ? "terminal_result_pending" : "finished", nextAction: "authoritative_runner_action" },
    };
  }
  return {
    contract: MONITORING_CONTRACT_VERSION,
    state: "needs_attention",
    observation: options.observation ?? "actionable_error",
    recovery: {
      ...base,
      requiredLifecycle: "paused",
      requiredAction: "pause_before_error",
      initialization: "not_applicable",
    },
    liveFollow: { mode: "stop", disposition: "observation_blocked", nextAction: "authoritative_runner_action" },
  };
}

/**
 * Shared model instructions. Keep schedule handling independent from a
 * runner's nextAction so event draining, input delivery, and result retrieval
 * cannot be replaced by scheduler work.
 */
export const MONITORING_MODEL_INSTRUCTIONS = [
  "An unfinished followed run remains the conversation context across turns. If the user supplies an idea, requirements, or feedback for it, fresh-read that exact run before treating the message as standalone implementation work. If a matching chat question is pending, fresh-read its schema and submit the direct answer; if no question is ready, keep the message in chat and continue the run without executing its implementation yourself. Only an explicit change of task leaves this flow. Files existing or a provider finishing never replace the workflow acceptance node; report workflow completion only from its authoritative terminal result.",
  "A one-off status read reports its snapshot only; it never creates, reconciles, pauses, or removes recovery.",
  "For an explicit follow, run-start continuation, accepted-answer continuation, or scheduled recovery, first read the exact run. Treat an accepted interaction receipt as invalidating any remembered pending form.",
  "Always drain every required event page before advancing its cursor or initializing recovery. nextAction is the authoritative runner action and is separate from host recovery work.",
  "Bounded live following is the primary monitoring path. Hooks, host task identity, recovery registration, and schedules are never prerequisites to loomex_run_wait. When supported host recovery is available, registrationState not_observed requires loomex_recovery_get for the exact supported host/task/run binding before deciding any scheduler mutation; it does not authorize creating a schedule. Never infer hook activation from installed plugin metadata or an unbound UI follow record.",
  "monitoringEvidence is bounded diagnostic context only. hook_not_observed means no native delivery has been observed for that run; handoff_pending means only that a UI handoff was recorded; hook_observed confirms a processed native hook. Categorical diagnostics distinguish a rejected payload or association from a runner error when the runner reports one. Do not infer a host task ID, reuse a workspace path as one, or expose private host-session identifiers.",
  "Handle supported host scheduling and the current task identity independently of live polling. Durable recovery registration is separate from host-observed lifecycle: not_attempted, attempt_in_flight, registered, ambiguous, and removed. On the first active phase after accepted initial human input, create only when the durable registration state is exactly not_attempted; attempt_in_flight and registered require reconciliation of their known record, and ambiguous or unknown history never authorizes a create. View a known record with the host schema's ID only, then verify the returned same-task, same-run record before calling recovery verified. Use the two-minute cadence. If task identity or host scheduling is unavailable, report recovery unavailable once and continue live polling.",
  "For supported host recovery, use the durable journal as the registration authority: for a run-start continuation call loomex_recovery_get and initialize the local record with loomex_recovery_update even when the first run read is waiting for input; one-off status reads never do this. Missing identity, unavailable capabilities, or an ambiguous recovery operation cannot stop bounded live polling. On the first active phase, get the record again. For not_attempted, update if needed, begin the exact host create with loomex_recovery_operation_begin, and create only after attemptPermitted is true; settle the returned automation ID with loomex_recovery_operation_settle, then verify with host automation view using its ID only. For attempt_in_flight or registered, reconcile the journal's known operation or ID. Unknown history remains ambiguous. If schedule creation or update is ambiguous, persist attempt_in_flight and view the known exact record before any retry. If no record ID is known, preserve ambiguous registration rather than creating a duplicate. Do not claim recovery is active without verification.",
  "For an explicit live follow, use one 30-second loomex_run_wait at a time. liveFollow.disposition continue requires completing the fresh authoritative nextAction, draining every required event page, and calling another bounded wait while the run remains active. Active progress, provider activity, and quiet timeouts cannot end the turn with a final answer. await_user pauses for verified input; terminal_result_pending requires complete result retrieval before finished; observation_blocked surfaces an actionable observation failure. An explicit user stop also ends chat following. Never use hidden indefinite waits or UI polling. A scheduled recovery turn reads once, drains pages, reports only a new actionable state, and does not enter the live follow loop.",
  "Before presenting human input or an actionable observation error, pause any known exact recovery. After complete terminal result retrieval, remove it; if removal fails, pause it and report the cleanup dependency. User stop removes or pauses any known recovery and never cancels execution. Recovery cleanup failure is reported without withholding verified input or a retrieved result.",
  "Recovery lifecycle values are unchecked, verified, unavailable, ambiguous, paused, and removed. Only an actual supported host record is evidence for any value other than unchecked; host delivery and uninterrupted live following are not guaranteed.",
] as const;

export const RUN_GET_MONITORING_DESCRIPTION =
  "Read current authoritative state for one exact run. A one-off status request ends with this snapshot. An explicit follow, run-start continuation, or accepted-interaction continuation must fresh-read and drain required event pages, then follow authoritative nextAction and liveFollow.disposition. continue requires another bounded wait while active, including after progress, provider activity, or quiet timeout; do not final-answer while nextAction is run_wait or run_events. Hooks and schedules never gate live polling. Monitoring evidence and optional host recovery are separate from the runner action.";

export const RUN_WAIT_MONITORING_DESCRIPTION =
  "Wait for one bounded run change (currently at most 45 seconds). For an explicit live follow, fresh-read and drain required pages, then use serial 30-second waits independently of hooks or schedules. After active progress, provider activity, or quiet timeout, disposition continue requires completing authoritative nextAction and another bounded wait; do not final-answer while nextAction is run_wait or run_events. Pause only for verified input, terminal result retrieval, an actionable observation failure, or explicit user stop. Scheduled recovery is a one-shot read; never add hidden indefinite waits or UI polling.";
