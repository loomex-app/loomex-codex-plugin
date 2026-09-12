import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../src/ui-app/contracts.js";
import {
  createJournalRestorationController,
  restoredOperationSlot,
  type JournalRestorationServices,
} from "../src/ui-app/journal-restoration.js";
import {
  createMutationController,
  type MutationOperation,
  type MutationSessionProjection,
} from "../src/ui-app/mutation-controller.js";
import type { PreparedRun, RpcResult, UiData } from "../src/ui-app/page-models.js";

const sourceViewId = "10000000-0000-4000-8000-000000000001";
const targetViewId = "20000000-0000-4000-8000-000000000002";
const operationId = "30000000-0000-4000-8000-000000000003";
const idempotencyKey = "40000000-0000-4000-8000-000000000004";
const requestId = "50000000-0000-4000-8000-000000000005";
const runId = "60000000-0000-4000-8000-000000000006";
const preparationId = "70000000-0000-4000-8000-000000000007";
const builderSessionId = "80000000-0000-4000-8000-000000000008";
const returnViewId = "90000000-0000-4000-8000-000000000009";

function source(): MutationSessionProjection {
  return {
    viewSessionId: sourceViewId,
    revision: 1,
    state: { screen: "review", returnBrowserViewSessionId: returnViewId },
    operation: { operationId },
  };
}

function storedOperation(
  method: string,
  params: Readonly<JsonObject>,
  status = "completed",
  resultReference?: Readonly<JsonObject>,
): JsonObject {
  return {
    operationId,
    method,
    params: { ...params, idempotencyKey },
    idempotencyKey,
    status,
    ...(resultReference !== undefined ? { resultReference } : {}),
  };
}

interface Harness {
  readonly services: JournalRestorationServices;
  readonly retained: Readonly<MutationOperation>[];
  readonly removed: string[];
  readonly locks: Array<{ slot: string; reconciled: boolean }>;
  readonly activated: Array<{ kind: string; id: string; returnView?: string }>;
  readonly errors: unknown[];
  readonly renders: number[];
  setOperation(value: unknown): void;
  setTarget(value: unknown): void;
  setToolResult(value: RpcResult): void;
  setRunActive(value: boolean): void;
  setEpoch(value: number): void;
  expireDuringOperationRead(): void;
  expireDuringTransition(): void;
}

function harness(): Harness {
  const retained: Readonly<MutationOperation>[] = [];
  const removed: string[] = [];
  const locks: Array<{ slot: string; reconciled: boolean }> = [];
  const activated: Array<{ kind: string; id: string; returnView?: string }> = [];
  const errors: unknown[] = [];
  const renders: number[] = [];
  let operation: unknown = {};
  let target: unknown = {};
  let toolResult: RpcResult = {};
  let runActive = false;
  let epoch = 1;
  let expireOnRead = false;
  let expireOnTransition = false;
  let revision = 1;
  let keySequence = 0;
  const mutation = createMutationController({
    createIdempotencyKey: () => `a0000000-0000-4000-8000-${String(++keySequence).padStart(12, "0")}`,
    dataOf: (result) => result.structuredContent?.data ?? {},
    transport: {
      beginAuthoritativeRequest: () => 1,
      isAuthoritativeRequestCurrent: () => true,
      callTool: async () => toolResult,
    },
    persistence: {
      ready: () => true,
      currentSession: () => source(),
      flushCurrent: async () => true,
      captureState: () => source().state ?? {},
      acceptRevision: (_id, next) => { revision = next; },
      call: async (name, args) => {
        if (name === "loomex_view_session_get") {
          return { viewSessionId: sourceViewId, revision, state: source().state };
        }
        if (name === "loomex_view_session_update") {
          if (expireOnTransition) epoch += 1;
          return { viewSessionId: sourceViewId, revision: ++revision, state: args.state, status: args.status };
        }
        if (name === "loomex_view_operation_settle") return {};
        throw new Error(`Unexpected mutation persistence call: ${name}`);
      },
    },
    presentation: {
      authoritativeFailure: () => undefined,
      present: () => undefined,
      observe: () => undefined,
      persistenceFailure: (error) => { errors.push(error); },
      lock: (entry, reconciled) => { locks.push({ slot: entry.slot, reconciled }); },
      unlock: () => undefined,
      acceptTargetSession: () => undefined,
    },
  });
  const services: JournalRestorationServices = {
    mutation,
    hydrationEpoch: () => epoch,
    currentSessionId: () => sourceViewId,
    readOperation: async () => {
      if (expireOnRead) epoch += 1;
      return operation;
    },
    readSession: async () => target,
    callTool: async () => toolResult,
    dataOf: (result) => result.structuredContent?.data ?? {},
    runFlowActive: () => runActive,
    retainRunOperation: (entry) => { retained.push(entry); },
    removeRunOperation: (slot) => { removed.push(slot); },
    authoritativeData: () => ({ humanRequest: { id: requestId, status: "pending", execution: { id: runId } } }),
    activatePreparation: (prepared: PreparedRun, returnView, _sourceView) => {
      runActive = true;
      activated.push({ kind: "prepare", id: String(prepared.preparationId), returnView });
    },
    activateMonitor: (data: UiData, returnView) => {
      runActive = true;
      activated.push({ kind: "monitor", id: String(data.execution?.id), returnView });
    },
    activateAuthoring: (data: UiData) => {
      activated.push({ kind: "authoring", id: String(data.builderSession?.id) });
    },
    renderCurrent: () => { renders.push(renders.length + 1); },
    setError: (error) => { errors.push(error); },
  };
  return {
    services,
    retained,
    removed,
    locks,
    activated,
    errors,
    renders,
    setOperation: (value) => { operation = value; },
    setTarget: (value) => { target = value; },
    setToolResult: (value) => { toolResult = value; },
    setRunActive: (value) => { runActive = value; },
    setEpoch: (value) => { epoch = value; },
    expireDuringOperationRead: () => { expireOnRead = true; },
    expireDuringTransition: () => { expireOnTransition = true; },
  };
}

test("restored operation slots preserve every exact mutation identity", () => {
  const cases = [
    ["interactions.respond", { requestId }, `interaction:respond:${requestId}`],
    ["interactions.decide", { requestId, decision: "reject" }, `interaction:reject:${requestId}`],
    ["builder.respond", { sessionId: builderSessionId }, `builder:respond:${builderSessionId}`],
    ["runs.cancel", { runId }, `run:cancel:${runId}`],
    ["runs.commit", { preparationId }, `loomex_run_commit:${preparationId}`],
    ["builder.commit", { preparationId }, `loomex_builder_commit:${preparationId}`],
    ["editor.commit", { preparationId }, `loomex_editor_commit:${preparationId}`],
    ["workspaces.grant", { workspacePath: "/workspace" }, "workspace:/workspace"],
    ["runs.prepare", { versionId: "v1", workspacePath: "/workspace" }, "prepare:v1:/workspace"],
  ] as const;
  for (const [method, params, expected] of cases) {
    assert.equal(restoredOperationSlot({ operationId, method, params, idempotencyKey }), expected);
  }
});

test("an unresolved journal operation restores through the branded controller with its exact key", async () => {
  const state = harness();
  state.setOperation(storedOperation("interactions.respond", { requestId, answer: { value: "kept" } }, "pending"));
  const restoration = createJournalRestorationController(state.services);

  assert.equal(await restoration.restore(source(), 1), true);
  const restored = state.services.mutation.current();
  assert.ok(restored);
  assert.equal(restored.arguments.idempotencyKey, idempotencyKey);
  assert.equal(restored.slot, `interaction:respond:${requestId}`);
  assert.equal(restoration.restoredOperationId, operationId);
  assert.deepEqual(state.locks, [{ slot: restored.slot, reconciled: true }]);
});

test("a hydration epoch change after the journal read prevents stale state adoption", async () => {
  const state = harness();
  state.setOperation(storedOperation("interactions.respond", { requestId }, "pending"));
  state.expireDuringOperationRead();
  const restoration = createJournalRestorationController(state.services);

  assert.equal(await restoration.restore(source(), 1), false);
  assert.equal(restoration.restoredOperationId, "");
  assert.equal(state.services.mutation.size, 0);
  assert.equal(state.errors.length, 0);
});

test("a journal record with a different parameter idempotency key is rejected", async () => {
  const state = harness();
  state.setOperation({
    ...storedOperation("interactions.respond", { requestId }, "pending"),
    params: { requestId, idempotencyKey: "b0000000-0000-4000-8000-00000000000b" },
  });
  const restoration = createJournalRestorationController(state.services);

  assert.equal(await restoration.restore(source(), 1), false);
  assert.equal(state.services.mutation.size, 0);
  assert.match(String(state.errors[0]), /exact idempotency key/);
});

test("completed prepare, run, and authoring operations validate targets before restoring their domains", async (t) => {
  const cases = [
    {
      name: "prepare",
      method: "runs.prepare",
      reference: { preparationId, nextViewSessionId: targetViewId },
      target: { kind: "prepare", entityType: "preparation", entityId: preparationId },
      result: { structuredContent: { ok: true, data: { status: "valid", preparation: { preparationId } } } },
    },
    {
      name: "monitor",
      method: "runs.commit",
      reference: { executionId: runId, nextViewSessionId: targetViewId },
      target: { kind: "monitor", entityType: "execution", entityId: runId },
      result: { structuredContent: { ok: true, data: { execution: { id: runId } } } },
    },
    {
      name: "authoring",
      method: "builder.commit",
      reference: { builderSessionId, nextViewSessionId: targetViewId },
      target: { kind: "authoring", entityType: "builderSession", entityId: builderSessionId },
      result: {
        structuredContent: { ok: true, data: { builderSession: { id: builderSessionId } } },
        _meta: { "loomex/viewSession": {
          viewSessionId: targetViewId, revision: 1, kind: "authoring", entityType: "builderSession", entityId: builderSessionId,
        } },
      },
    },
  ] as const;
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const state = harness();
      state.setOperation(storedOperation(entry.method, { preparationId }, "completed", entry.reference));
      state.setTarget({ viewSessionId: targetViewId, revision: 1, state: {}, ...entry.target });
      state.setToolResult(entry.result as RpcResult);
      const restoration = createJournalRestorationController(state.services);

      assert.equal(await restoration.restore(source(), 1), true);
      assert.deepEqual(state.activated, [{ kind: entry.name, id: entry.target.entityId, ...(entry.name !== "authoring" ? { returnView: returnViewId } : {}) }]);
      assert.equal(restoration.restoredOperationId, operationId);
      assert.equal(state.errors.length, 0);
      assert.equal(state.renders.length, 1);
    });
  }
});

test("a completed operation cannot bind a target for a different entity", async () => {
  const state = harness();
  state.setOperation(storedOperation("runs.commit", { preparationId }, "completed", {
    executionId: runId,
    nextViewSessionId: targetViewId,
  }));
  state.setTarget({
    viewSessionId: targetViewId,
    revision: 1,
    kind: "monitor",
    entityType: "execution",
    entityId: requestId,
  });
  state.setToolResult({ structuredContent: { ok: true, data: { execution: { id: runId } } } });
  const restoration = createJournalRestorationController(state.services);

  assert.equal(await restoration.restore(source(), 1), false);
  assert.equal(restoration.restoredOperationId, "");
  assert.equal(state.activated.length, 0);
  assert.match(String(state.errors[0]), /binding could not be verified/);
});

test("a hydration change during the completed transition cannot activate stale domain state", async () => {
  const state = harness();
  state.setOperation(storedOperation("runs.commit", { preparationId }, "completed", {
    executionId: runId,
    nextViewSessionId: targetViewId,
  }));
  state.setTarget({
    viewSessionId: targetViewId,
    revision: 1,
    kind: "monitor",
    entityType: "execution",
    entityId: runId,
  });
  state.setToolResult({ structuredContent: { ok: true, data: { execution: { id: runId } } } });
  state.expireDuringTransition();
  const restoration = createJournalRestorationController(state.services);

  assert.equal(await restoration.restore(source(), 1), false);
  assert.equal(restoration.restoredOperationId, "");
  assert.equal(state.activated.length, 0);
  assert.equal(state.renders.length, 0);
});
