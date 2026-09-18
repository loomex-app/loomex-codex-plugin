import mutationRecovery from "../../contracts/mutation-recovery.json" with { type: "json" };
import { errorRecovery } from "../protocol.js";
import type { JsonObject } from "./contracts.js";
import type { RpcResult, UiData } from "./page-models.js";
import { normalizeUiRpcResult } from "./result-decoder.js";

export const MUTATION_PERSISTENCE_TOOLS = Object.freeze({
  create: "loomex_view_session_create",
  get: "loomex_view_session_get",
  update: "loomex_view_session_update",
  operationGet: "loomex_view_operation_get",
  operationSettle: "loomex_view_operation_settle",
} as const);

export const MUTATION_JOURNAL_METHODS = Object.freeze({
  loomex_interaction_respond: "interactions.respond",
  loomex_interaction_decide: "interactions.decide",
  loomex_builder_respond: "builder.respond",
  loomex_run_cancel: "runs.cancel",
  loomex_run_commit: "runs.commit",
  loomex_builder_commit: "builder.commit",
  loomex_editor_commit: "editor.commit",
  loomex_workspace_grant: "workspaces.grant",
  loomex_run_prepare: "runs.prepare",
  // Start handoffs carry the sealed preparation arguments and an idempotency
  // key.  They must use the durable operation journal rather than the
  // presentation-state snapshot.
  loomex_run_start_handoff_issue: "runs.start_handoff.issue",
  loomex_run_start_handoff_approve: "runs.start_handoff.approve",
} as const);

export type MutationToolName = keyof typeof MUTATION_JOURNAL_METHODS;
export type MutationJournalMethod = typeof MUTATION_JOURNAL_METHODS[MutationToolName];
export type MutationSettlementStatus = "completed" | "ambiguous";
export type PersistenceToolName = typeof MUTATION_PERSISTENCE_TOOLS[keyof typeof MUTATION_PERSISTENCE_TOOLS];

const JOURNAL_TOOLS = new Map<MutationJournalMethod, MutationToolName>(
  Object.entries(MUTATION_JOURNAL_METHODS).map(([tool, method]) => [method, tool as MutationToolName]),
);

const RESOLVED_INTERACTION_STATUSES = new Set(["resolved", "completed", "answered", "approved", "rejected"]);
const TRANSITION_TO_INACTIVE = new Set<MutationToolName>([
  "loomex_run_prepare", "loomex_run_commit", "loomex_builder_commit", "loomex_editor_commit",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MUTATION_OPERATION_BRAND: unique symbol = Symbol("loomex.mutation-operation");

export type OperationArguments = Readonly<JsonObject> & { readonly idempotencyKey: string };

export interface MutationReconciliation {
  readonly method: string;
  readonly params: Readonly<JsonObject>;
}

export interface MutationJournalAttempt {
  readonly viewSessionId: string;
  readonly expectedRevision: number;
  readonly state: Readonly<JsonObject>;
  readonly operation: {
    readonly method: MutationJournalMethod;
    readonly params: Readonly<JsonObject>;
    readonly idempotencyKey: string;
    readonly reconciliation?: MutationReconciliation;
  };
  readonly idempotencyKey: string;
}

export interface MutationSettlementAttempt {
  readonly viewSessionId: string;
  readonly operationId: string;
  readonly status: MutationSettlementStatus;
  readonly resultReference: Readonly<JsonObject>;
  readonly idempotencyKey: string;
}

export interface MutationSessionUpdateAttempt {
  readonly viewSessionId: string;
  readonly expectedRevision: number;
  readonly state: Readonly<JsonObject>;
  readonly status: string;
  readonly idempotencyKey: string;
}

export interface MutationTargetCreateAttempt {
  readonly kind: "prepare" | "monitor" | "authoring";
  readonly entityType: "preparation" | "execution" | "builderSession";
  readonly entityId: string;
  readonly state: Readonly<JsonObject>;
  readonly idempotencyKey: string;
}

export interface MutationSessionProjection {
  readonly viewSessionId: string;
  readonly revision: number;
  readonly state?: Readonly<JsonObject>;
  readonly status?: string;
  readonly kind?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly operation?: Readonly<JsonObject>;
}

export type OperationStage = "not_journaled" | "journal_write_uncertain" | "journaled" | "dispatched" | "outcome_uncertain" | "settled";

export interface MutationOperation {
  stage: OperationStage;
  readonly [MUTATION_OPERATION_BRAND]: true;
  readonly name: MutationToolName;
  readonly slot: string;
  readonly arguments: OperationArguments;
  readonly label?: string;
  uncertain: boolean;
  reconciled: boolean;
  operationId?: string;
  journalStatus?: string;
  viewSessionId?: string;
  sessionRevision?: number;
  sessionState?: Readonly<JsonObject>;
  resultReference?: Readonly<JsonObject>;
  targetSession?: MutationSessionProjection | null;
  successfulResult?: RpcResult;
  journalAttempt?: MutationJournalAttempt;
  journalConflict?: boolean;
  targetCreateAttempt?: MutationTargetCreateAttempt;
  transitionAttempt?: MutationSessionUpdateAttempt;
  transitionConflict?: boolean;
  readonly settlementAttempts: Map<string, MutationSettlementAttempt>;
}

export interface RestoredMutationOperation {
  readonly operationId: string;
  readonly method: string;
  readonly params: Readonly<JsonObject>;
  readonly idempotencyKey: string;
  readonly status?: string;
  readonly reconciliation?: Readonly<JsonObject> | null;
  readonly resultReference?: Readonly<JsonObject>;
}

export interface MutationTransport {
  beginAuthoritativeRequest(): number;
  isAuthoritativeRequestCurrent(epoch: number): boolean;
  callTool(name: string, arguments_: Readonly<JsonObject>): Promise<unknown>;
}

export interface MutationPersistence {
  ready(): boolean;
  currentSession(): MutationSessionProjection | null;
  flushCurrent(): Promise<boolean>;
  captureState(): Readonly<JsonObject>;
  call(tool: PersistenceToolName, arguments_: Readonly<JsonObject>): Promise<unknown>;
  acceptRevision(viewSessionId: string, revision: number): void;
}

export interface MutationPresentation {
  authoritativeFailure(error: unknown): void;
  present(result: RpcResult): void;
  observe(result: RpcResult): void;
  persistenceFailure(error: unknown): void;
  lock(operation: Readonly<MutationOperation>, reconciled: boolean, message?: string): void;
  unlock(operation: Readonly<MutationOperation>): void;
  /**
   * Switch the live presentation to a completed mutation's target session.
   * Implementations may need to hydrate that session before a successor
   * mutation is safe to journal, so callers must await the returned promise.
   */
  acceptTargetSession(target: MutationSessionProjection): void | Promise<void>;
}

export interface MutationControllerServices {
  readonly transport: MutationTransport;
  readonly persistence: MutationPersistence;
  readonly presentation: MutationPresentation;
  readonly dataOf: (result: RpcResult) => UiData;
  readonly createIdempotencyKey?: () => string;
}

export interface CallToolOptions {
  readonly present?: boolean;
  readonly observe?: boolean;
}

export interface MutationCallOutcome {
  readonly result: RpcResult;
  readonly operation: Readonly<MutationOperation>;
  readonly ambiguous: boolean;
}

export interface VerifiedInteractionOutcome extends MutationCallOutcome {
  readonly accepted: boolean;
  readonly resolution?: InteractionResolution;
}

export interface InteractionResolution {
  readonly runId?: string;
  readonly acceptedInteraction: {
    readonly requestId: string;
    readonly status: string;
  };
  readonly followContinuation?: unknown;
}

export interface ReconciliationOutcome {
  readonly state: "completed" | "pending" | "failed";
  readonly result: RpcResult;
  readonly resolution?: InteractionResolution;
}

export interface RestoreMutationOptions {
  readonly ownership?: "controller" | "run-local";
  readonly label?: string;
  readonly targetSession?: MutationSessionProjection | null;
}

/** Creates the strict retained tuple used by run-local mutation maps. */
export function createMutationOperation(
  name: MutationToolName,
  slot: string,
  args: Readonly<JsonObject>,
  label?: string,
  createIdempotencyKey: () => string = defaultIdempotencyKey,
): MutationOperation {
  const idempotencyKey = createIdempotencyKey();
  return {
    [MUTATION_OPERATION_BRAND]: true,
    name,
    slot,
    arguments: immutableCopy({ ...args, idempotencyKey }),
    ...(label !== undefined ? { label } : {}),
    stage: "not_journaled",
    uncertain: false,
    reconciled: false,
    settlementAttempts: new Map(),
  };
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function stringValue(value: unknown, limit = 4096): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function defaultIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  throw new Error("This host cannot generate a safe idempotency UUID.");
}

/** A detached, recursively frozen copy used for every retained mutation tuple. */
export function immutableCopy<Value>(value: Value): Value {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== "object" || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}

/** Structural equality for JSON-compatible journal values. Object key order is ignored. */
export function exactJsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => exactJsonEqual(item, right[index]));
  }
  const leftObject = object(left);
  const rightObject = object(right);
  if (leftObject === undefined || rightObject === undefined) return false;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && exactJsonEqual(leftObject[key], rightObject[key]));
}

function rpcResult(value: unknown): RpcResult {
  return normalizeUiRpcResult(value) as RpcResult;
}

function resultFailed(result: RpcResult): boolean {
  return result.isError === true || result.structuredContent?.ok === false;
}

function errorCodeOf(result: RpcResult): string | undefined {
  const error = object(result.structuredContent?.error);
  return typeof error?.code === "string" ? error.code : undefined;
}

function humanRequest(data: UiData): JsonObject | undefined {
  return object(data.humanRequest);
}

function humanRequestResolved(request: JsonObject | undefined): boolean {
  if (request === undefined) return false;
  const status = String(request.status ?? "").toLowerCase();
  return RESOLVED_INTERACTION_STATUSES.has(status) || ["cancelled", "canceled", "expired"].includes(status) ||
    (request.answer !== undefined && request.answer !== null);
}

function executionId(data: UiData): string {
  return stringValue(object(data.execution)?.id, 128);
}

function builderSessionId(data: UiData): string {
  return stringValue(object(data.builderSession)?.id, 128);
}

function projection(value: unknown): MutationSessionProjection {
  const supplied = object(value);
  const viewSessionId = stringValue(supplied?.viewSessionId, 64);
  const revision = supplied?.revision;
  if (!isUuid(viewSessionId) || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("The saved view session could not be verified.");
  }
  const state = object(supplied?.state);
  const operation = object(supplied?.operation);
  return {
    viewSessionId,
    revision,
    ...(state !== undefined ? { state: immutableCopy(state) } : {}),
    ...(typeof supplied?.status === "string" ? { status: supplied.status } : {}),
    ...(typeof supplied?.kind === "string" ? { kind: supplied.kind } : {}),
    ...(typeof supplied?.entityType === "string" ? { entityType: supplied.entityType } : {}),
    ...(typeof supplied?.entityId === "string" ? { entityId: supplied.entityId } : {}),
    ...(operation !== undefined ? { operation: immutableCopy(operation) } : {}),
  };
}

export function decodeMutationSessionProjection(value: unknown): MutationSessionProjection {
  return projection(value);
}

function viewSessionProjection(result: RpcResult): MutationSessionProjection | undefined {
  try {
    return projection(object(result._meta)?.["loomex/viewSession"]);
  } catch {
    return undefined;
  }
}

function reconciliationFor(name: MutationToolName, args: Readonly<JsonObject>): MutationReconciliation | undefined {
  const method = MUTATION_JOURNAL_METHODS[name];
  const rules: Readonly<Record<string, {method:string;identity:string}>> = mutationRecovery.reconciliation;
  const rule=rules[method];
  if (!rule) return undefined;
  const identity=args[rule.identity];
  if (typeof identity !== "string") throw new Error("The reconciliation identity is missing.");
  return {method:rule.method,params:immutableCopy({[rule.identity]:identity})};
}

function normalizedReconciliation(value: unknown): JsonObject | null {
  const supplied = object(value);
  return supplied !== undefined && Object.keys(supplied).length > 0 ? supplied : null;
}

function operationReference(result: RpcResult, operation: MutationOperation, data: UiData): JsonObject {
  const request = humanRequest(data);
  const isAuthoringCommit = operation.name === "loomex_builder_commit" || operation.name === "loomex_editor_commit";
  const builderId = isAuthoringCommit
    ? stringValue(data.builderSessionId, 64) || stringValue(data.sessionId, 64)
    : builderSessionId(data);
  return immutableCopy({
    ok: !resultFailed(result),
    errorCode: errorCodeOf(result) ?? null,
    requestId: stringValue(data.requestId ?? request?.id, 64) || null,
    executionId: stringValue(data.executionId, 64) || executionId(data) || null,
    preparationId: stringValue(data.preparationId, 64) || null,
    builderSessionId: builderId || null,
    handoffRef: stringValue(data.handoffRef, 64) || null,
    lifecycle: stringValue(data.lifecycle, 32) || null,
    runId: stringValue(data.runId, 64) || null,
    nextViewSessionId: operation.targetSession?.viewSessionId ?? null,
  });
}

function operationSlot(record: RestoredMutationOperation): string {
  const tool = JOURNAL_TOOLS.get(record.method as MutationJournalMethod);
  if (tool === "loomex_interaction_respond") return `interaction:respond:${String(record.params.requestId ?? "")}`;
  if (tool === "loomex_interaction_decide") return `interaction:${String(record.params.decision ?? "")}:${String(record.params.requestId ?? "")}`;
  if (tool === "loomex_builder_respond") return `builder:respond:${String(record.params.sessionId ?? "")}`;
  if (tool === "loomex_run_cancel") return `run:cancel:${String(record.params.runId ?? "")}`;
  if (tool === "loomex_run_commit" || tool === "loomex_builder_commit" || tool === "loomex_editor_commit") {
    return `${tool}:${String(record.params.preparationId ?? "")}`;
  }
  if (tool === "loomex_workspace_grant") return `workspace:${String(record.params.workspacePath ?? "")}`;
  if (tool === "loomex_run_prepare") return `prepare:${String(record.params.versionId ?? "")}:${String(record.params.workspacePath ?? "")}`;
  if (tool === "loomex_run_start_handoff_issue") return `start-handoff:issue:${String(record.params.preparationId ?? "")}`;
  if (tool === "loomex_run_start_handoff_approve") return `start-handoff:approve:${String(record.params.handoffRef ?? "")}`;
  return `restored:${record.operationId}`;
}

/** Owns durable mutation attempts, exact retries, settlement, and reconciliation. */
export class MutationController {
  readonly #services: MutationControllerServices;
  readonly #operations = new Map<string, MutationOperation>();
  readonly #keys = new Map<string, string>();
  readonly #createKey: () => string;
  #journalQueue: Promise<void> = Promise.resolve();

  constructor(services: MutationControllerServices) {
    this.#services = services;
    this.#createKey = services.createIdempotencyKey ?? defaultIdempotencyKey;
  }

  get size(): number { return this.#operations.size; }

  current(): Readonly<MutationOperation> | undefined {
    return this.#operations.values().next().value;
  }

  get(slot: string): Readonly<MutationOperation> | undefined {
    return this.#operations.get(slot);
  }

  values(): readonly Readonly<MutationOperation>[] {
    return [...this.#operations.values()];
  }

  clear(): void {
    this.#operations.clear();
    this.#keys.clear();
  }

  clearOperation(operation: Readonly<MutationOperation>): void {
    const owned = this.#operations.get(operation.slot);
    if (owned === undefined) {
      this.#mutable(operation);
      return;
    }
    if (owned !== operation) throw new Error("The retained operation identity changed. Refresh before continuing.");
    this.#operations.delete(owned.slot);
    this.#keys.delete(owned.slot);
  }

  operation(name: MutationToolName, slot: string, args: Readonly<JsonObject>, label?: string): Readonly<MutationOperation> {
    return this.#operation(name, slot, args, label);
  }

  #operation(name: MutationToolName, slot: string, args: Readonly<JsonObject>, label?: string): MutationOperation {
    const retained = this.#operations.get(slot);
    if (retained !== undefined) {
      if (retained.name !== name) throw new Error("The retained operation does not match this action. Refresh before continuing.");
      return retained;
    }
    const operation = createMutationOperation(name, slot, args, label, this.#createKey);
    this.#keys.set(slot, operation.arguments.idempotencyKey);
    this.#operations.set(slot, operation);
    return operation;
  }

  restore(
    record: RestoredMutationOperation,
    session: MutationSessionProjection,
    options: RestoreMutationOptions = {},
  ): Readonly<MutationOperation> {
    const name = JOURNAL_TOOLS.get(record.method as MutationJournalMethod);
    if (name === undefined) throw new Error("The saved operation method is not supported by this view.");
    if (record.params.idempotencyKey !== record.idempotencyKey) {
      throw new Error("The saved operation does not retain its exact idempotency key.");
    }
    const slot = operationSlot(record);
    const operation: MutationOperation = {
      [MUTATION_OPERATION_BRAND]: true,
      name,
      slot,
      arguments: immutableCopy({ ...record.params, idempotencyKey: record.idempotencyKey }),
      ...(options.label !== undefined ? { label: options.label } : {}),
      stage: record.status === "completed" ? "settled" : "outcome_uncertain",
      uncertain: record.status !== "completed",
      reconciled: false,
      operationId: record.operationId,
      ...(record.status !== undefined ? { journalStatus: record.status } : {}),
      viewSessionId: session.viewSessionId,
      sessionRevision: session.revision,
      sessionState: immutableCopy(session.state ?? {}),
      ...(record.resultReference !== undefined ? { resultReference: immutableCopy(record.resultReference) } : {}),
      settlementAttempts: new Map(),
    };
    if (options.targetSession != null) this.#attachTarget(operation, options.targetSession);
    if ((options.ownership ?? "controller") === "controller") {
      this.#keys.set(slot, record.idempotencyKey);
      this.#operations.set(slot, operation);
    }
    return operation;
  }

  acceptTarget(operation: Readonly<MutationOperation>, target: MutationSessionProjection): void {
    this.#attachTarget(this.#mutable(operation), target);
  }

  decodeRestoredOperation(value: unknown): RestoredMutationOperation {
    return this.#restoredOperation(value);
  }

  lock(operation: Readonly<MutationOperation>, reconciled: boolean, message?: string): void {
    const retained = this.#mutable(operation);
    retained.uncertain = true;
    retained.reconciled = reconciled || retained.reconciled;
    this.#services.presentation.lock(retained, reconciled, message);
  }

  async callTool(name: string, args: Readonly<JsonObject>, options: CallToolOptions = {}): Promise<RpcResult> {
    const present = options.present ?? true;
    const observe = options.observe ?? true;
    const authoritative = present || observe;
    const epoch = authoritative ? this.#services.transport.beginAuthoritativeRequest() : undefined;
    let result: RpcResult;
    try {
      result = rpcResult(await this.#services.transport.callTool(name, immutableCopy(args)));
    } catch (error: unknown) {
      if (authoritative) this.#services.presentation.authoritativeFailure(error);
      throw error;
    }
    if (epoch !== undefined && !this.#services.transport.isAuthoritativeRequestCurrent(epoch)) return result;
    if (present) this.#services.presentation.present(result);
    else if (observe && !resultFailed(result)) this.#services.presentation.observe(result);
    return result;
  }

  async journal(operation: Readonly<MutationOperation>): Promise<Readonly<MutationOperation>> {
    const retained = this.#mutable(operation);
    const pending = this.#journalQueue.catch(() => undefined).then(() => this.#journalNow(retained));
    this.#journalQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async #journalNow(operation: MutationOperation): Promise<MutationOperation> {
    this.#requireReady();
    if (operation.operationId !== undefined) return operation;
    if (this.#services.persistence.currentSession() === null) {
      throw new Error("This action cannot continue until durable view storage is verified.");
    }
    if (operation.journalAttempt === undefined) {
      if (!await this.#services.persistence.flushCurrent()) throw new Error("Save this view before continuing.");
      const session = this.#services.persistence.currentSession();
      if (session === null) throw new Error("The saved view changed while this action was being recorded.");
      const reconciliation = reconciliationFor(operation.name, operation.arguments);
      operation.journalAttempt = immutableCopy({
        viewSessionId: session.viewSessionId,
        expectedRevision: session.revision,
        state: this.#services.persistence.captureState(),
        operation: {
          method: MUTATION_JOURNAL_METHODS[operation.name],
          params: operation.arguments,
          idempotencyKey: operation.arguments.idempotencyKey,
          ...(reconciliation !== undefined ? { reconciliation } : {}),
        },
        idempotencyKey: this.#createKey(),
      });
    }
    const attempt = operation.journalAttempt;
    let persisted: MutationSessionProjection;
    try {
      persisted = projection(await this.#services.persistence.call(MUTATION_PERSISTENCE_TOOLS.update, immutableCopy({ ...attempt })));
    } catch (error: unknown) {
      const code = errorCode(error);
      if (errorRecovery(code || "INTERNAL").outcome !== "unknown") {
        operation.stage = "not_journaled";
        if (/CONFLICT|STALE/.test(code) || code === "OPERATION_PENDING") operation.journalConflict = true;
        this.#services.presentation.persistenceFailure(error);
        throw error;
      }
      operation.stage = "journal_write_uncertain";
      persisted = await this.#reconcileLostJournalWrite(attempt);
    }
    const reference = object(persisted.operation);
    const operationId = stringValue(reference?.operationId, 128);
    if (!operationId) throw new Error("The pending action was not durably recorded.");
    this.#services.persistence.acceptRevision(persisted.viewSessionId, persisted.revision);
    operation.operationId = operationId;
    operation.stage = "journaled";
    operation.journalStatus = stringValue(reference?.status, 40);
    operation.viewSessionId = attempt.viewSessionId;
    operation.sessionRevision = persisted.revision;
    operation.sessionState = immutableCopy(this.#services.persistence.captureState());
    return operation;
  }

  async settle(operation: Readonly<MutationOperation>, status: MutationSettlementStatus, result: RpcResult): Promise<void> {
    const retained = this.#mutable(operation);
    if (retained.operationId === undefined || retained.viewSessionId === undefined) return;
    if (status === "completed" && !resultFailed(result)) retained.successfulResult = immutableCopy(result);
    const resultReference = operationReference(result, retained, this.#services.dataOf(result));
    const signature = JSON.stringify([status, resultReference]);
    let attempt = retained.settlementAttempts.get(signature);
    if (attempt === undefined) {
      attempt = immutableCopy({
        viewSessionId: retained.viewSessionId,
        operationId: retained.operationId,
        status,
        resultReference,
        idempotencyKey: this.#createKey(),
      });
      retained.settlementAttempts.set(signature, attempt);
    }
    await this.#services.persistence.call(MUTATION_PERSISTENCE_TOOLS.operationSettle, immutableCopy({ ...attempt }));
    retained.journalStatus = status;
    retained.stage = status === "completed" ? "settled" : "outcome_uncertain";
  }

  async transitionAfterSuccess(operation: Readonly<MutationOperation>): Promise<void> {
    const retained = this.#mutable(operation);
    if (!TRANSITION_TO_INACTIVE.has(retained.name) || retained.viewSessionId === undefined) return;
    if (retained.journalStatus !== "completed") throw new Error("The predecessor must be settled before changing view sessions.");
    const target = retained.targetSession;
    if (target == null || target.viewSessionId === retained.viewSessionId) {
      throw new Error("The completed action could not be linked to its durable next view.");
    }
    try {
      if (retained.transitionAttempt === undefined) {
        const current = projection(await this.#services.persistence.call(MUTATION_PERSISTENCE_TOOLS.get, {
          viewSessionId: retained.viewSessionId,
        }));
        const forward = {
          viewSessionId: target.viewSessionId,
          kind: target.kind,
          entityType: target.entityType,
          entityId: target.entityId,
        };
        retained.transitionAttempt = immutableCopy({
          viewSessionId: retained.viewSessionId,
          expectedRevision: current.revision,
          state: { ...(current.state ?? retained.sessionState ?? {}), forwardSession: forward },
          status: "inactive",
          idempotencyKey: this.#createKey(),
        });
      }
      const updated = await this.#exactSessionUpdate(retained.transitionAttempt);
      this.#services.persistence.acceptRevision(retained.viewSessionId, updated.revision);
      // A successor mutation must belong to the target card.  In particular,
      // do not let run-start handoff issuance race the source card's completed
      // preparation operation, which the runner correctly keeps exclusive
      // until its transition has landed.
      await this.#services.presentation.acceptTargetSession(target);
    } catch (error: unknown) {
      if (/CONFLICT|STALE/.test(errorCode(error))) retained.transitionConflict = true;
      this.#services.presentation.persistenceFailure(error);
      throw error;
    }
  }

  async callMutation(name: MutationToolName, slot: string, args: Readonly<JsonObject>): Promise<MutationCallOutcome> {
    this.#requireReady();
    const operation = this.#operation(name, slot, args);
    if (operation.journalStatus === "completed" && operation.targetSession != null) {
      await this.transitionAfterSuccess(operation);
      this.clearOperation(operation);
      return { result: { structuredContent: { ok: true, data: {} } }, operation, ambiguous: false };
    }
    await this.journal(operation);
    let result = operation.successfulResult !== undefined
      ? immutableCopy(operation.successfulResult)
      : await dispatchJournaledOperation(operation, () => this.callTool(operation.name, operation.arguments, {
        present: false,
        observe: !["loomex_run_commit", "loomex_builder_commit", "loomex_editor_commit"].includes(operation.name),
      }));
    const mutationResult = result;
    const uncertain = resultFailed(result) && errorRecovery(errorCodeOf(result) ?? "INTERNAL").outcome === "unknown";
    if (!uncertain && !resultFailed(result)) result = await this.#verifySuccessfulTarget(operation, result);
    await this.settle(operation, uncertain ? "ambiguous" : "completed", mutationResult);
    this.#services.presentation.present(result);
    if (!uncertain && !resultFailed(result)) await this.transitionAfterSuccess(operation);
    if (uncertain) {
      operation.uncertain = true;
      this.#services.presentation.lock(operation, false);
    } else {
      this.#services.presentation.unlock(operation);
      this.clearOperation(operation);
    }
    return { result, operation, ambiguous: uncertain };
  }

  async callVerifiedInteractionMutation(
    name: "loomex_interaction_respond" | "loomex_interaction_decide",
    slot: string,
    args: Readonly<JsonObject>,
    authoritativeData: UiData,
  ): Promise<VerifiedInteractionOutcome> {
    this.#requireReady();
    const operation = this.#operation(name, slot, args);
    await this.journal(operation);
    const result = await dispatchJournaledOperation(operation, () => this.callTool(operation.name, operation.arguments, { present: false }));
    const uncertain = resultFailed(result) && errorRecovery(errorCodeOf(result) ?? "INTERNAL").outcome === "unknown";
    if (resultFailed(result)) {
      await this.settle(operation, uncertain ? "ambiguous" : "completed", result);
      this.#services.presentation.present(result);
      if (uncertain) {
        operation.uncertain = true;
        this.#services.presentation.lock(operation, false);
      } else {
        this.#services.presentation.unlock(operation);
        this.clearOperation(operation);
      }
      return { result, accepted: false, operation, ambiguous: uncertain };
    }
    const resolution = this.#interactionReceipt(operation, result, authoritativeData);
    if (resolution === undefined) {
      await this.settle(operation, "ambiguous", result);
      operation.uncertain = true;
      this.#services.presentation.lock(operation, false,
        "The runner did not confirm the exact request as accepted. The reviewed response remains locked. Refresh to reconcile, or retry that exact response and operation ID.");
      return { result, accepted: false, operation, ambiguous: true };
    }
    await this.settle(operation, "completed", result);
    await this.transitionAfterSuccess(operation);
    this.clearOperation(operation);
    this.#services.presentation.present(this.#resolvedInteractionResult(authoritativeData, operation, result));
    return { result, accepted: true, operation, ambiguous: false, resolution };
  }

  operationStillPending(operation: Readonly<MutationOperation>, data: UiData): boolean {
    if (operation.name === "loomex_interaction_respond" || operation.name === "loomex_interaction_decide") {
      const request = humanRequest(data);
      if (request === undefined || request.id !== operation.arguments.requestId) return false;
      return !humanRequestResolved(request);
    }
    if (operation.name === "loomex_builder_respond") {
      return builderSessionId(data) === operation.arguments.sessionId && humanRequest(data) !== undefined;
    }
    return true;
  }

  operationReconciled(operation: Readonly<MutationOperation>, data: UiData, authoritativeData: UiData): boolean {
    if (operation.name === "loomex_interaction_respond" || operation.name === "loomex_interaction_decide") {
      return this.#reconciledInteraction(operation, data, authoritativeData) !== undefined;
    }
    if (operation.name === "loomex_builder_respond") {
      return builderSessionId(data) === operation.arguments.sessionId && humanRequest(data) === undefined;
    }
    return false;
  }

  async reconcile(
    result: RpcResult,
    operation: Readonly<MutationOperation>,
    authoritativeData: UiData,
  ): Promise<ReconciliationOutcome> {
    const owned = this.#mutable(operation);
    if (resultFailed(result)) {
      this.#services.presentation.present(result);
      owned.uncertain = true;
      owned.reconciled = true;
      this.#services.presentation.lock(owned, true);
      return { state: "failed", result };
    }
    const incoming = this.#services.dataOf(result);
    const resolution = this.#reconciledInteraction(owned, incoming, authoritativeData);
    if (resolution !== undefined || this.operationReconciled(owned, incoming, authoritativeData)) {
      await this.settle(owned, "completed", result);
      await this.transitionAfterSuccess(owned);
      this.clearOperation(owned);
      this.#services.presentation.present(result);
      return { state: "completed", result, ...(resolution !== undefined ? { resolution } : {}) };
    }
    owned.uncertain = true;
    owned.reconciled = true;
    this.#services.presentation.lock(owned, true);
    return { state: "pending", result };
  }

  async recoverConflictedAttempts(externalOperations: Iterable<Readonly<MutationOperation>> = []): Promise<void> {
    const operations = new Set<MutationOperation>(this.#operations.values());
    for (const external of externalOperations) operations.add(this.#mutable(external));
    for (const operation of operations) {
      await this.#recoverOperationConflicts(operation);
    }
  }

  async recoverOperationConflicts(operation: Readonly<MutationOperation>): Promise<void> {
    await this.#recoverOperationConflicts(this.#mutable(operation));
  }

  async #recoverOperationConflicts(operation: MutationOperation): Promise<void> {
      if (operation.journalConflict === true && operation.journalAttempt !== undefined) {
        const current = projection(await this.#services.persistence.call(MUTATION_PERSISTENCE_TOOLS.get, {
          viewSessionId: operation.journalAttempt.viewSessionId,
        }));
        const reference = object(current.operation);
        const operationId = stringValue(reference?.operationId, 128);
        if (operationId) {
          const recorded = this.#restoredOperation(await this.#services.persistence.call(MUTATION_PERSISTENCE_TOOLS.operationGet, {
            viewSessionId: current.viewSessionId,
            operationId,
          }));
          this.#assertSameJournalOperation(recorded, operation.journalAttempt.operation);
          operation.operationId = recorded.operationId;
          if (recorded.status !== undefined) operation.journalStatus = recorded.status;
          operation.viewSessionId = current.viewSessionId;
          operation.sessionRevision = current.revision;
        } else {
          delete operation.journalAttempt;
        }
        operation.journalConflict = false;
      }
      if (operation.transitionConflict === true && operation.transitionAttempt !== undefined) {
        const current = projection(await this.#services.persistence.call(MUTATION_PERSISTENCE_TOOLS.get, {
          viewSessionId: operation.transitionAttempt.viewSessionId,
        }));
        const landed = current.revision > operation.transitionAttempt.expectedRevision &&
          exactJsonEqual(current.state, operation.transitionAttempt.state) && current.status === operation.transitionAttempt.status;
        if (!landed) delete operation.transitionAttempt;
        operation.transitionConflict = false;
      }
  }

  #mutable(operation: Readonly<MutationOperation>): MutationOperation {
    const owned = this.#operations.get(operation.slot);
    if (owned !== undefined) {
      if (owned !== operation) throw new Error("The retained operation identity changed. Refresh before continuing.");
      return owned;
    }
    if (operation[MUTATION_OPERATION_BRAND] !== true ||
        !Object.hasOwn(MUTATION_JOURNAL_METHODS, operation.name) || !operation.slot ||
        operation.arguments.idempotencyKey === "" ||
        (this.#keys.has(operation.slot) && operation.arguments.idempotencyKey !== this.#keys.get(operation.slot)) ||
        !(operation.settlementAttempts instanceof Map)) {
      throw new Error("The retained operation could not be verified.");
    }
    // The pure factory and the public interface expose the same object with a
    // read-only view. Validation above establishes the mutable runtime shape.
    return operation as MutationOperation;
  }

  #attachTarget(operation: MutationOperation, target: MutationSessionProjection): void {
    if (!isUuid(target.viewSessionId) || !Number.isSafeInteger(target.revision) || target.revision < 0) {
      throw new Error("The durable next-view session could not be verified.");
    }
    const reference = operation.resultReference ??
      (operation.successfulResult !== undefined
        ? operationReference(operation.successfulResult, operation, this.#services.dataOf(operation.successfulResult))
        : {});
    const expectedViewSessionId = stringValue(reference.nextViewSessionId, 64);
    if (expectedViewSessionId && target.viewSessionId !== expectedViewSessionId) {
      throw new Error("The durable next-view reference did not match the restored target.");
    }
    const expected = operation.name === "loomex_run_prepare"
      ? { kind: "prepare", entityType: "preparation", entityId: stringValue(reference.preparationId, 64) }
      : operation.name === "loomex_run_commit"
        ? { kind: "monitor", entityType: "execution", entityId: stringValue(reference.executionId, 64) }
        : operation.name === "loomex_builder_commit" || operation.name === "loomex_editor_commit"
          ? { kind: "authoring", entityType: "builderSession", entityId: stringValue(reference.builderSessionId, 64) }
          : undefined;
    if (expected === undefined || !isUuid(expected.entityId) || target.kind !== expected.kind ||
        target.entityType !== expected.entityType || target.entityId !== expected.entityId) {
      throw new Error("The durable next-view binding could not be verified for this operation.");
    }
    operation.targetSession = immutableCopy(target);
  }

  #requireReady(): void {
    if (!this.#services.persistence.ready()) {
      throw new Error("Wait for the saved view and pending action to finish restoring before continuing.");
    }
  }

  async #reconcileLostJournalWrite(attempt: MutationJournalAttempt): Promise<MutationSessionProjection> {
    const current = projection(await this.#services.persistence.call(MUTATION_PERSISTENCE_TOOLS.get, {
      viewSessionId: attempt.viewSessionId,
    }));
    const reference = object(current.operation);
    const operationId = stringValue(reference?.operationId, 128);
    if (!operationId) {
      if (current.revision !== attempt.expectedRevision) {
        throw new Error("The pending action could not be matched to the durable journal. Reload this view before continuing.");
      }
      return projection(await this.#services.persistence.call(MUTATION_PERSISTENCE_TOOLS.update, immutableCopy({ ...attempt })));
    }
    const recorded = this.#restoredOperation(await this.#services.persistence.call(MUTATION_PERSISTENCE_TOOLS.operationGet, {
      viewSessionId: current.viewSessionId,
      operationId,
    }));
    this.#assertSameJournalOperation(recorded, attempt.operation);
    return current;
  }

  #assertSameJournalOperation(recorded: RestoredMutationOperation, intended: MutationJournalAttempt["operation"]): void {
    if (recorded.method !== intended.method || recorded.idempotencyKey !== intended.idempotencyKey ||
        !exactJsonEqual(recorded.params, intended.params) ||
        !exactJsonEqual(normalizedReconciliation(recorded.reconciliation), normalizedReconciliation(intended.reconciliation))) {
      throw new Error("A different pending action is already recorded for this view. Reload before continuing.");
    }
  }

  #restoredOperation(value: unknown): RestoredMutationOperation {
    const supplied = object(value);
    const operationId = stringValue(supplied?.operationId, 128);
    const method = stringValue(supplied?.method, 128);
    const params = object(supplied?.params);
    const idempotencyKey = stringValue(supplied?.idempotencyKey, 128);
    if (!operationId || !method || params === undefined || !idempotencyKey) {
      throw new Error("The saved operation could not be verified.");
    }
    if (params.idempotencyKey !== idempotencyKey) {
      throw new Error("The saved operation does not retain its exact idempotency key.");
    }
    const reconciliation = object(supplied?.reconciliation);
    const resultReference = object(supplied?.resultReference);
    return {
      operationId,
      method,
      params: immutableCopy(params),
      idempotencyKey,
      ...(typeof supplied?.status === "string" ? { status: supplied.status } : {}),
      ...(reconciliation !== undefined ? { reconciliation: immutableCopy(reconciliation) } : {}),
      ...(resultReference !== undefined ? { resultReference: immutableCopy(resultReference) } : {}),
    };
  }

  async #exactSessionUpdate(attempt: MutationSessionUpdateAttempt): Promise<MutationSessionProjection> {
    try {
      return projection(await this.#services.persistence.call(MUTATION_PERSISTENCE_TOOLS.update, immutableCopy({ ...attempt })));
    } catch (error: unknown) {
      if (errorRecovery(errorCode(error) || "INTERNAL").outcome !== "unknown") throw error;
      const current = projection(await this.#services.persistence.call(MUTATION_PERSISTENCE_TOOLS.get, {
        viewSessionId: attempt.viewSessionId,
      }));
      if (current.revision > attempt.expectedRevision && exactJsonEqual(current.state, attempt.state) && current.status === attempt.status) {
        return current;
      }
      if (current.revision === attempt.expectedRevision) {
        return projection(await this.#services.persistence.call(MUTATION_PERSISTENCE_TOOLS.update, immutableCopy({ ...attempt })));
      }
      throw new Error("The saved view update could not be reconciled. Reload before continuing.");
    }
  }

  async #verifySuccessfulTarget(operation: MutationOperation, result: RpcResult): Promise<RpcResult> {
    const observedTarget = viewSessionProjection(result);
    if (observedTarget !== undefined) operation.targetSession = observedTarget;
    if (operation.name === "loomex_run_commit") return this.#verifyRunCommitTarget(operation, result);
    if (operation.name === "loomex_builder_commit" || operation.name === "loomex_editor_commit") {
      return this.#verifyAuthoringCommitTarget(operation, result);
    }
    if (operation.name === "loomex_run_prepare") await this.#verifyPreparationTarget(operation, result);
    return result;
  }

  async #verifyPreparationTarget(operation: MutationOperation, result: RpcResult): Promise<void> {
    const preparationId = stringValue(this.#services.dataOf(result).preparationId, 64);
    if (!isUuid(preparationId)) throw new Error("The preparation identity could not be verified.");
    operation.successfulResult ??= immutableCopy(result);
    await this.#ensureTarget(operation, {
      kind: "prepare", entityType: "preparation", entityId: preparationId,
      state: { schemaVersion: 1, screen: "review", preparationId },
    });
  }

  async #verifyRunCommitTarget(operation: MutationOperation, result: RpcResult): Promise<RpcResult> {
    const data = this.#services.dataOf(result);
    const runId = executionId(data);
    if (!isUuid(runId) || data.preparationId !== operation.arguments.preparationId || data.executionPolicy !== "host_user/v1") {
      throw new Error("The runner did not return a run bound to the exact preparation and execution policy.");
    }
    operation.successfulResult ??= immutableCopy(result);
    const snapshot = await this.callTool("loomex_run_get", { runId }, { present: false });
    if (resultFailed(snapshot) || executionId(this.#services.dataOf(snapshot)) !== runId) {
      throw new Error("The started run could not be verified before opening its monitor.");
    }
    await this.#ensureTarget(operation, {
      kind: "monitor", entityType: "execution", entityId: runId,
      state: { schemaVersion: 1, screen: "monitor", executionId: runId },
    });
    return snapshot;
  }

  async #verifyAuthoringCommitTarget(operation: MutationOperation, result: RpcResult): Promise<RpcResult> {
    const data = this.#services.dataOf(result);
    const builderId = stringValue(data.builderSessionId, 64);
    const sessionId = stringValue(data.sessionId, 64);
    const execution = stringValue(data.executionId, 64);
    if (!isUuid(builderId) || builderId !== sessionId || !isUuid(execution) ||
        data.preparationId !== operation.arguments.preparationId || data.executionPolicy !== "host_user/v1") {
      throw new Error("The authoring session identity could not be verified against the reviewed preparation.");
    }
    operation.successfulResult ??= immutableCopy(result);
    const target = await this.#ensureTarget(operation, {
      kind: "authoring", entityType: "builderSession", entityId: sessionId,
      state: { schemaVersion: 1, screen: "authoring", builderSessionId: sessionId },
    });
    const authoring = await this.callTool("loomex_builder_get", {
      sessionId,
      viewSessionId: target.viewSessionId,
    }, { present: false });
    if (resultFailed(authoring) || builderSessionId(this.#services.dataOf(authoring)) !== sessionId ||
        viewSessionProjection(authoring)?.viewSessionId !== target.viewSessionId) {
      throw new Error("The new authoring session could not be loaded into its durable view.");
    }
    return authoring;
  }

  async #ensureTarget(
    operation: MutationOperation,
    target: Omit<MutationTargetCreateAttempt, "idempotencyKey">,
  ): Promise<MutationSessionProjection> {
    if (operation.targetCreateAttempt === undefined) {
      operation.targetCreateAttempt = immutableCopy({ ...target, idempotencyKey: this.#createKey() });
    }
    if (operation.targetSession == null) {
      operation.targetSession = projection(await this.#services.persistence.call(
        MUTATION_PERSISTENCE_TOOLS.create,
        immutableCopy({ ...operation.targetCreateAttempt }),
      ));
    }
    const session = operation.targetSession;
    if (session.kind !== target.kind || session.entityType !== target.entityType || session.entityId !== target.entityId) {
      throw new Error("The durable next-view binding could not be verified.");
    }
    return session;
  }

  #interactionReceipt(
    operation: Readonly<MutationOperation>,
    result: RpcResult,
    authoritativeData: UiData,
  ): InteractionResolution | undefined {
    if (resultFailed(result)) return undefined;
    const receipt = this.#services.dataOf(result);
    const status = String(receipt.requestStatus ?? "").toLowerCase();
    if (receipt.requestId !== operation.arguments.requestId || !RESOLVED_INTERACTION_STATUSES.has(status) ||
        (receipt.error !== undefined && receipt.error !== null)) {
      return undefined;
    }
    const expectedRunId = stringValue(object(humanRequest(authoritativeData)?.execution)?.id, 128);
    const receivedRunId = stringValue(receipt.executionId, 128) || executionId(receipt);
    if (expectedRunId && (!isUuid(expectedRunId) || receivedRunId !== expectedRunId)) return undefined;
    const runId = expectedRunId || (isUuid(receivedRunId) ? receivedRunId : "");
    return {
      ...(runId ? { runId } : {}),
      acceptedInteraction: { requestId: String(receipt.requestId), status },
      ...(object(receipt.details)?.followContinuation !== undefined
        ? { followContinuation: object(receipt.details)?.followContinuation }
        : {}),
    };
  }

  #reconciledInteraction(
    operation: Readonly<MutationOperation>,
    data: UiData,
    authoritativeData: UiData,
  ): InteractionResolution | undefined {
    const request = humanRequest(data);
    const status = String(request?.status ?? "").toLowerCase();
    if (request === undefined || request.id !== operation.arguments.requestId ||
        !RESOLVED_INTERACTION_STATUSES.has(status) || (request.error !== undefined && request.error !== null)) {
      return undefined;
    }
    const expectedRunId = stringValue(object(humanRequest(authoritativeData)?.execution)?.id, 128);
    const receivedRunId = stringValue(object(request.execution)?.id, 128) || executionId(data);
    if (expectedRunId && receivedRunId && expectedRunId !== receivedRunId) return undefined;
    if (expectedRunId && !isUuid(expectedRunId)) return undefined;
    const runId = receivedRunId || expectedRunId;
    if (runId && !isUuid(runId)) return undefined;
    return {
      ...(runId ? { runId } : {}),
      acceptedInteraction: { requestId: String(request.id), status },
      ...(object(data.details)?.followContinuation !== undefined
        ? { followContinuation: object(data.details)?.followContinuation }
        : {}),
    };
  }

  #resolvedInteractionResult(authoritativeData: UiData, operation: MutationOperation, result: RpcResult): RpcResult {
    const request = humanRequest(authoritativeData);
    const receipt = this.#services.dataOf(result);
    if (request === undefined) return result;
    const status = String(receipt.requestStatus ?? request.status ?? "resolved").toLowerCase();
    const answer = operation.name === "loomex_interaction_respond" ? operation.arguments.answer : undefined;
    const resolvedRequest: JsonObject = immutableCopy({
      ...request,
      status,
      ...(answer !== undefined ? { answer } : {}),
    });
    return rpcResult({ structuredContent: { ok: true, data: { ...authoritativeData, humanRequest: resolvedRequest } } });
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return stringValue(object(error)?.code, 128);
}

export function createMutationController(services: MutationControllerServices): MutationController {
  return new MutationController(services);
}

/** One dispatch boundary for controller-owned and page-owned journal attempts. */
export async function dispatchJournaledOperation(operation: MutationOperation, dispatch: () => Promise<RpcResult>): Promise<RpcResult> {
  if (!operation.operationId || !operation.viewSessionId) throw new Error("The operation must be journaled before dispatch.");
  if (operation.successfulResult) return immutableCopy(operation.successfulResult);
  operation.stage = "dispatched";
  try {
    const result = await dispatch();
    if (resultFailed(result) && errorRecovery(errorCodeOf(result) ?? "INTERNAL").outcome === "unknown") operation.stage = "outcome_uncertain";
    return result;
  } catch (error) {
    operation.stage = "outcome_uncertain";
    operation.uncertain = true;
    throw error;
  }
}
