import type { JsonObject } from "./contracts.js";
import {
  MUTATION_JOURNAL_METHODS,
  decodeMutationSessionProjection,
  type MutationController,
  type MutationOperation,
  type MutationSessionProjection,
  type MutationToolName,
  type RestoredMutationOperation,
} from "./mutation-controller.js";
import { uiResultFailed } from "./result-decoder.js";
import type { PreparedRun, RpcResult, UiData } from "./page-models.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOURNAL_TOOLS = new Map<string, MutationToolName>(
  Object.entries(MUTATION_JOURNAL_METHODS).map(([tool, method]) => [method, tool as MutationToolName]),
);
const COMPLETED_TRANSITION_TOOLS = new Set<MutationToolName>([
  "loomex_run_prepare", "loomex_run_commit", "loomex_builder_commit", "loomex_editor_commit",
]);

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function text(value: unknown, limit = 4096): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function executionId(data: UiData): string {
  return text(object(data.execution)?.id, 128);
}

function builderSessionId(data: UiData): string {
  return text(object(data.builderSession)?.id, 128);
}

function resultViewSession(result: RpcResult): MutationSessionProjection | undefined {
  try {
    return decodeMutationSessionProjection(object(result._meta)?.["loomex/viewSession"]);
  } catch {
    return undefined;
  }
}

function operationLabel(operation: RestoredMutationOperation, name: MutationToolName): string {
  if (name === "loomex_run_commit") return "start";
  if (name === "loomex_run_prepare") return "review";
  if (name === "loomex_workspace_grant") return "workspace check";
  if (name === "loomex_run_cancel") return "cancellation";
  if (name === "loomex_interaction_decide") return operation.params.decision === "reject" ? "rejection" : "approval";
  return "response";
}

export function restoredOperationSlot(operation: RestoredMutationOperation): string {
  const name = JOURNAL_TOOLS.get(operation.method);
  if (name === "loomex_interaction_respond") return `interaction:respond:${String(operation.params.requestId ?? "")}`;
  if (name === "loomex_interaction_decide") {
    return `interaction:${String(operation.params.decision ?? "")}:${String(operation.params.requestId ?? "")}`;
  }
  if (name === "loomex_builder_respond") return `builder:respond:${String(operation.params.sessionId ?? "")}`;
  if (name === "loomex_run_cancel") return `run:cancel:${String(operation.params.runId ?? "")}`;
  if (name === "loomex_run_commit" || name === "loomex_builder_commit" || name === "loomex_editor_commit") {
    return `${name}:${String(operation.params.preparationId ?? "")}`;
  }
  if (name === "loomex_workspace_grant") return `workspace:${String(operation.params.workspacePath ?? "")}`;
  if (name === "loomex_run_prepare") {
    return `prepare:${String(operation.params.versionId ?? "")}:${String(operation.params.workspacePath ?? "")}`;
  }
  if (name === "loomex_run_start_handoff_issue") {
    return `start-handoff:issue:${String(operation.params.preparationId ?? "")}`;
  }
  if (name === "loomex_run_start_handoff_approve") {
    return `start-handoff:approve:${String(operation.params.handoffRef ?? "")}`;
  }
  return `restored:${operation.operationId}`;
}

export interface JournalRestorationServices {
  readonly mutation: MutationController;
  hydrationEpoch(): number;
  currentSessionId(): string;
  readOperation(viewSessionId: string, operationId: string): Promise<unknown>;
  readSession(viewSessionId: string): Promise<unknown>;
  callTool(name: string, args: Readonly<JsonObject>, present: boolean): Promise<RpcResult>;
  dataOf(result: RpcResult): UiData;
  runFlowActive(): boolean;
  retainRunOperation(operation: Readonly<MutationOperation>): void;
  removeRunOperation(slot: string): void;
  authoritativeData(): UiData;
  activatePreparation(preparation: PreparedRun, returnBrowserViewSessionId: string, sourceViewSessionId: string): void;
  activateMonitor(data: UiData, returnBrowserViewSessionId: string): void;
  activateAuthoring(data: UiData): void;
  renderCurrent(): void;
  setError(error: unknown): void;
}

export class JournalRestorationController {
  readonly #services: JournalRestorationServices;
  #restoredOperationId = "";
  #restoredViewSessionId = "";

  constructor(services: JournalRestorationServices) {
    this.#services = services;
  }

  get restoredOperationId(): string { return this.#restoredOperationId; }

  reset(): void {
    this.#restoredOperationId = "";
    this.#restoredViewSessionId = "";
  }

  async restore(source: MutationSessionProjection, epoch: number): Promise<boolean> {
    if (source.viewSessionId !== this.#restoredViewSessionId) {
      this.#restoredOperationId = "";
      this.#restoredViewSessionId = source.viewSessionId;
    }
    const reference = object(source.operation);
    const operationId = text(reference?.operationId, 128);
    if (!operationId || operationId === this.#restoredOperationId) return true;
    try {
      const rawOperation = await this.#services.readOperation(source.viewSessionId, operationId);
      if (!this.#current(source, epoch)) return false;
      const record = this.#services.mutation.decodeRestoredOperation(rawOperation);
      if (record.operationId !== operationId) throw new Error("The saved operation identity did not match its view reference.");
      const name = JOURNAL_TOOLS.get(record.method);
      if (name === undefined) throw new Error("The saved operation method is not supported by this view.");

      if (record.status === "completed" && COMPLETED_TRANSITION_TOOLS.has(name)) {
        return await this.#restoreCompletedTransition(record, name, source, epoch);
      }
      if (record.status === "completed") {
        this.#restoredOperationId = record.operationId;
        return true;
      }

      const runLocal = this.#services.runFlowActive();
      const restored = this.#services.mutation.restore(record, source, {
        ownership: runLocal ? "run-local" : "controller",
        ...(runLocal ? { label: operationLabel(record, name) } : {}),
      });
      if (runLocal) this.#services.retainRunOperation(restored);
      const authoritative = this.#services.authoritativeData();
      if (!this.#services.mutation.operationStillPending(restored, authoritative) &&
          this.#services.mutation.operationReconciled(restored, authoritative, authoritative)) {
        await this.#services.mutation.settle(restored, "completed", {
          structuredContent: { ok: true, data: authoritative },
        });
        if (!this.#current(source, epoch)) return false;
        await this.#services.mutation.transitionAfterSuccess(restored);
        if (!this.#current(source, epoch)) return false;
        if (runLocal) this.#services.removeRunOperation(restored.slot);
        else this.#services.mutation.clearOperation(restored);
        this.#restoredOperationId = record.operationId;
        return true;
      }
      this.#services.renderCurrent();
      this.#services.mutation.lock(restored, record.status === "pending");
      this.#restoredOperationId = record.operationId;
      return true;
    } catch (error: unknown) {
      this.#services.setError(error);
      return false;
    }
  }

  async #restoreCompletedTransition(
    record: RestoredMutationOperation,
    name: MutationToolName,
    source: MutationSessionProjection,
    epoch: number,
  ): Promise<boolean> {
    const resultReference = record.resultReference ?? {};
    const nextViewSessionId = text(resultReference.nextViewSessionId, 64);
    if (!uuid(nextViewSessionId)) throw new Error("The completed action is missing its durable next-view reference.");
    const target = decodeMutationSessionProjection(await this.#services.readSession(nextViewSessionId));
    if (!this.#current(source, epoch)) return false;
    const returnView = text(source.state?.returnBrowserViewSessionId, 64);
    let restored: Readonly<MutationOperation>;
    let activate: () => void;

    if (name === "loomex_run_prepare") {
      const preparationId = text(resultReference.preparationId, 64);
      if (!uuid(preparationId)) throw new Error("The completed preparation identity could not be verified.");
      const result = await this.#services.callTool("loomex_preparation_get", { preparationId }, false);
      if (!this.#current(source, epoch)) return false;
      const data = this.#services.dataOf(result);
      const preparation = data.preparation;
      if (uiResultFailed(result) || data.status !== "valid" || preparation?.preparationId !== preparationId) {
        throw new Error("The completed preparation could not be restored safely.");
      }
      restored = this.#services.mutation.restore(record, source, {
        ownership: "run-local", label: "review", targetSession: target,
      });
      activate = () => { this.#services.activatePreparation(preparation, returnView, source.viewSessionId); };
    } else if (name === "loomex_run_commit") {
      const runId = text(resultReference.executionId, 64);
      if (!uuid(runId)) throw new Error("The completed run identity could not be verified.");
      const result = await this.#services.callTool("loomex_run_get", { runId }, false);
      if (!this.#current(source, epoch)) return false;
      const data = this.#services.dataOf(result);
      if (uiResultFailed(result) || executionId(data) !== runId) {
        throw new Error("The completed run start could not be restored safely.");
      }
      restored = this.#services.mutation.restore(record, source, {
        ownership: "run-local", label: "start", targetSession: target,
      });
      activate = () => { this.#services.activateMonitor(data, returnView); };
    } else {
      const sessionId = text(resultReference.builderSessionId, 64);
      if (!uuid(sessionId)) throw new Error("The completed authoring identity could not be verified.");
      const result = await this.#services.callTool("loomex_builder_get", {
        sessionId,
        viewSessionId: target.viewSessionId,
      }, false);
      if (!this.#current(source, epoch)) return false;
      const data = this.#services.dataOf(result);
      if (uiResultFailed(result) || builderSessionId(data) !== sessionId ||
          resultViewSession(result)?.viewSessionId !== target.viewSessionId) {
        throw new Error("The completed authoring session could not be restored safely.");
      }
      restored = this.#services.mutation.restore(record, source, {
        ownership: "controller", targetSession: target,
      });
      activate = () => { this.#services.activateAuthoring(data); };
    }

    await this.#services.mutation.transitionAfterSuccess(restored);
    if (!this.#current(source, epoch)) return false;
    activate();
    if (this.#services.runFlowActive()) this.#services.removeRunOperation(restored.slot);
    else this.#services.mutation.clearOperation(restored);
    this.#restoredOperationId = record.operationId;
    this.#services.renderCurrent();
    return true;
  }

  #current(source: MutationSessionProjection, epoch: number): boolean {
    return this.#services.hydrationEpoch() === epoch && this.#services.currentSessionId() === source.viewSessionId;
  }
}

export function createJournalRestorationController(services: JournalRestorationServices): JournalRestorationController {
  return new JournalRestorationController(services);
}
