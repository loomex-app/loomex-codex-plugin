import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../src/ui-app/contracts.js";
import {
  createMutationController,
  createMutationOperation,
  dispatchJournaledOperation,
  immutableCopy,
  type MutationControllerServices,
  type MutationOperation,
  type MutationPresentation,
  type MutationSessionProjection,
} from "../src/ui-app/mutation-controller.js";
import type { RpcResult, UiData } from "../src/ui-app/page-models.js";

const viewSessionId = "10000000-0000-4000-8000-000000000001";
const originIdentity = { organizationId: viewSessionId, accountSubject: "owner", installationId: viewSessionId };
const requestId = "20000000-0000-4000-8000-000000000002";
const runId = "30000000-0000-4000-8000-000000000003";

function record(value: unknown): JsonObject {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}

function keyFactory(): () => string {
  let value = 0;
  return () => `40000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

interface Harness {
  readonly services: MutationControllerServices;
  readonly toolCalls: Array<{ name: string; arguments_: Readonly<JsonObject> }>;
  readonly persistenceCalls: Array<{ name: string; arguments_: Readonly<JsonObject> }>;
  readonly locks: Array<{ operation: Readonly<MutationOperation>; reconciled: boolean; message?: string }>;
  readonly presentations: RpcResult[];
  readonly settlements: Readonly<JsonObject>[];
  readonly accepted: Array<{ requestId: string; viewSessionId: string; settlementsAtBoundary: number }>;
  readonly session: MutationSessionProjection;
  setToolResult(result: RpcResult): void;
  loseNextJournalResponse(): void;
  advanceRevisionDuringFlush(): void;
}

function harness(initialResult: RpcResult): Harness {
  const toolCalls: Array<{ name: string; arguments_: Readonly<JsonObject> }> = [];
  const persistenceCalls: Array<{ name: string; arguments_: Readonly<JsonObject> }> = [];
  const locks: Array<{ operation: Readonly<MutationOperation>; reconciled: boolean; message?: string }> = [];
  const presentations: RpcResult[] = [];
  const settlements: Readonly<JsonObject>[] = [];
  const accepted: Array<{ requestId: string; viewSessionId: string; settlementsAtBoundary: number }> = [];
  let result = initialResult;
  let loseJournalResponse = false;
  let advanceOnFlush = false;
  let revision = 0;
  let journal: JsonObject | undefined;
  const session: MutationSessionProjection = { viewSessionId, originIdentity, currentOriginIdentity: originIdentity, revision: 0, state: { screen: "interaction" } };
  const presentation: MutationPresentation = {
    authoritativeFailure: () => undefined,
    present: (incoming) => { presentations.push(incoming); },
    observe: () => undefined,
    persistenceFailure: () => undefined,
    lock: (operation, reconciled, message) => {
      locks.push({ operation, reconciled, ...(message !== undefined ? { message } : {}) });
    },
    unlock: () => undefined,
    acceptTargetSession: () => undefined,
    acceptInteraction: (acceptedRequestId, acceptedViewSessionId) => {
      accepted.push({ requestId: acceptedRequestId, viewSessionId: acceptedViewSessionId, settlementsAtBoundary: settlements.length });
    },
  };
  const services: MutationControllerServices = {
    createIdempotencyKey: keyFactory(),
    dataOf: (incoming) => incoming.structuredContent?.data ?? {},
    transport: {
      beginAuthoritativeRequest: () => 1,
      isAuthoritativeRequestCurrent: () => true,
      callTool: async (name, arguments_) => {
        toolCalls.push({ name, arguments_: immutableCopy(arguments_) });
        return immutableCopy(result);
      },
    },
    persistence: {
      ready: () => true,
      currentSession: () => ({ ...session, revision }),
      flushCurrent: async () => {
        if (advanceOnFlush) {
          advanceOnFlush = false;
          revision += 1;
        }
        return true;
      },
      captureState: () => ({ screen: "interaction", answerPhase: "review" }),
      acceptRevision: (_id, acceptedRevision) => { revision = acceptedRevision; },
      call: async (name, arguments_) => {
        persistenceCalls.push({ name, arguments_: immutableCopy(arguments_) });
        if (name === "loomex_view_session_update") {
          const update = record(arguments_);
          if (record(update.operation)) {
            if (update.expectedRevision !== revision) {
              throw Object.assign(new Error("revision conflict"), { code: "REVISION_CONFLICT" });
            }
            revision += 1;
            const attempted = record(update.operation);
            journal = {
              originIdentity,
              operationId: "50000000-0000-4000-8000-000000000005",
              status: "pending",
              method: attempted.method,
              params: attempted.params,
              idempotencyKey: attempted.idempotencyKey,
              reconciliation: attempted.reconciliation,
            };
            if (loseJournalResponse) {
              loseJournalResponse = false;
              throw Object.assign(new Error("lost response"), { code: "NETWORK_AMBIGUOUS" });
            }
            return { viewSessionId, originIdentity, currentOriginIdentity: originIdentity, revision, state: update.state, operation: journal };
          }
          return { viewSessionId, revision: ++revision, state: update.state, status: update.status };
        }
        if (name === "loomex_view_session_get") {
          return { viewSessionId, originIdentity, currentOriginIdentity: originIdentity, revision, state: { screen: "interaction" }, ...(journal ? { operation: journal } : {}) };
        }
        if (name === "loomex_view_operation_get") return journal ?? {};
        if (name === "loomex_view_operation_settle") {
          settlements.push(immutableCopy(arguments_));
          return {};
        }
        throw new Error(`Unexpected persistence call: ${name}`);
      },
    },
    presentation,
  };
  return {
    services,
    toolCalls,
    persistenceCalls,
    locks,
    presentations,
    settlements,
    accepted,
    session,
    setToolResult: (next) => { result = next; },
    loseNextJournalResponse: () => { loseJournalResponse = true; },
    advanceRevisionDuringFlush: () => { advanceOnFlush = true; },
  };
}

function authoritativeInteraction(): UiData {
  return {
    humanRequest: {
      id: requestId,
      status: "pending",
      execution: { id: runId },
    },
  };
}

test("an ambiguous interaction retry preserves the exact arguments, idempotency key, and settlement attempt", async () => {
  const ambiguous: RpcResult = {
    isError: true,
    structuredContent: { ok: false, error: { code: "NETWORK_AMBIGUOUS", message: "Lost response" } },
  };
  const state = harness(ambiguous);
  const controller = createMutationController(state.services);
  const originalAnswer = { answer: { details: "original" } };

  const first = await controller.callVerifiedInteractionMutation(
    "loomex_interaction_respond", `interaction:respond:${requestId}`,
    { requestId, ...originalAnswer }, authoritativeInteraction(),
  );
  originalAnswer.answer.details = "changed after dispatch";
  const second = await controller.callVerifiedInteractionMutation(
    "loomex_interaction_respond", `interaction:respond:${requestId}`,
    { requestId, answer: { details: "replacement" } }, authoritativeInteraction(),
  );

  assert.equal(first.ambiguous, true);
  assert.equal(second.ambiguous, true);
  assert.equal(controller.size, 1);
  assert.deepEqual(state.toolCalls[1], state.toolCalls[0]);
  assert.equal(record(record(state.toolCalls[0]?.arguments_).answer).details, "original");
  assert.equal(state.settlements.length, 2);
  assert.deepEqual(state.settlements[1], state.settlements[0]);
  assert.equal(state.locks.length, 2);
});

test("a lost journal response is reconciled by the recorded exact operation before dispatch", async () => {
  const accepted: RpcResult = {
    structuredContent: {
      ok: true,
      data: { requestId, requestStatus: "answered", executionId: runId },
    },
  };
  const state = harness(accepted);
  state.loseNextJournalResponse();
  const controller = createMutationController(state.services);
  const outcome = await controller.callVerifiedInteractionMutation(
    "loomex_interaction_respond", `interaction:respond:${requestId}`,
    { requestId, answer: { details: "approved" } }, authoritativeInteraction(),
  );

  assert.equal(outcome.accepted, true);
  assert.equal(state.toolCalls.length, 1);
  assert.deepEqual(
    state.persistenceCalls.map((call) => call.name),
    ["loomex_view_session_update", "loomex_view_session_get", "loomex_view_operation_get", "loomex_view_operation_settle"],
  );
  assert.equal(controller.size, 0);
  assert.deepEqual(state.accepted, [{ requestId, viewSessionId, settlementsAtBoundary: 0 }],
    "the exact accepted request freezes view writes before operation settlement");
});

test("journaling snapshots the session revision after flushing pending view state", async () => {
  const state = harness({
    structuredContent: { ok: true, data: { requestId, requestStatus: "answered", executionId: runId } },
  });
  state.advanceRevisionDuringFlush();
  const controller = createMutationController(state.services);

  const outcome = await controller.callVerifiedInteractionMutation(
    "loomex_interaction_respond", `interaction:respond:${requestId}`,
    { requestId, answer: { details: "saved before dispatch" } }, authoritativeInteraction(),
  );

  assert.equal(outcome.accepted, true);
  assert.equal(state.toolCalls.length, 1);
  assert.equal(state.persistenceCalls[0]?.arguments_.expectedRevision, 1);
});

test("concurrent journal requests serialize and record an operation only once", async () => {
  const state = harness({ structuredContent: { ok: true, data: {} } });
  const controller = createMutationController(state.services);
  const operation = controller.operation("loomex_interaction_decide", `interaction:approve:${requestId}`, {
    requestId,
    decision: "approve",
  });

  const [first, second] = await Promise.all([controller.journal(operation), controller.journal(operation)]);

  assert.equal(first.operationId, second.operationId);
  assert.equal(
    state.persistenceCalls.filter((call) => call.name === "loomex_view_session_update").length,
    1,
  );
});

test("run-local operations use the same exact tuple factory and journal services without entering the controller map", async () => {
  const state = harness({ structuredContent: { ok: true, data: {} } });
  const controller = createMutationController(state.services);
  const operation = createMutationOperation(
    "loomex_run_cancel",
    `run:cancel:${runId}`,
    { runId, reason: "Stop requested" },
    "cancellation",
    keyFactory(),
  );

  await controller.journal(operation);
  await controller.settle(operation, "completed", {
    structuredContent: { ok: true, data: { execution: { id: runId } } },
  });

  assert.equal(operation.label, "cancellation");
  assert.equal(operation.journalStatus, "completed");
  assert.equal(controller.size, 0);
  assert.equal(state.settlements.length, 1);
});

test("run-local journal conflicts reconcile against the exact recorded operation", async () => {
  const state = harness({ structuredContent: { ok: true, data: {} } });
  const controller = createMutationController(state.services);
  const operation = createMutationOperation(
    "loomex_run_cancel", `run:cancel:${runId}`, { runId, reason: "Stop requested" }, "cancellation", keyFactory(),
  );
  await controller.journal(operation);
  const recordedOperationId = operation.operationId;
  delete operation.operationId;
  operation.journalConflict = true;

  await controller.recoverOperationConflicts(operation);

  assert.equal(operation.operationId, recordedOperationId);
  assert.equal(operation.journalStatus, "pending");
  assert.equal(operation.journalConflict, false);
  assert.equal(controller.size, 0);
});

test("completed operations restore as run-local state only after the saved next-view identity is verified", () => {
  const state = harness({ structuredContent: { ok: true, data: {} } });
  const controller = createMutationController(state.services);
  const idempotencyKey = "70000000-0000-4000-8000-000000000007";
  const monitorViewId = "80000000-0000-4000-8000-000000000008";
  const record = {
    operationId: "90000000-0000-4000-8000-000000000009",
    method: "runs.commit",
    params: { preparationId: "a0000000-0000-4000-8000-00000000000a", idempotencyKey },
    idempotencyKey,
    status: "completed",
    resultReference: { executionId: runId, nextViewSessionId: monitorViewId },
  } as const;
  const target = {
    viewSessionId: monitorViewId,
    revision: 1,
    kind: "monitor",
    entityType: "execution",
    entityId: runId,
    state: { screen: "monitor", executionId: runId },
  } as const;

  const restored = controller.restore(record, state.session, {
    ownership: "run-local",
    label: "start",
    targetSession: target,
  });
  assert.equal(restored.label, "start");
  assert.deepEqual(restored.targetSession, target);
  assert.equal(controller.size, 0);
  assert.throws(() => controller.restore(record, state.session, {
    ownership: "run-local",
    targetSession: { ...target, entityId: requestId },
  }), /binding could not be verified/);
});

test("an unverified receipt remains locked until authoritative reconciliation proves the exact request and run", async () => {
  const wrongRun = "60000000-0000-4000-8000-000000000006";
  const state = harness({
    structuredContent: {
      ok: true,
      data: { requestId, requestStatus: "answered", executionId: wrongRun },
    },
  });
  const controller = createMutationController(state.services);
  const call = await controller.callVerifiedInteractionMutation(
    "loomex_interaction_respond", `interaction:respond:${requestId}`,
    { requestId, answer: { details: "approved" } }, authoritativeInteraction(),
  );
  assert.equal(call.accepted, false);
  assert.equal(call.ambiguous, true);
  assert.equal(controller.size, 1);
  assert.match(state.locks[0]?.message ?? "", /did not confirm the exact request/);

  const operation = controller.get(`interaction:respond:${requestId}`);
  assert.ok(operation);
  const reconciled = await controller.reconcile({
    structuredContent: {
      ok: true,
      data: {
        humanRequest: { id: requestId, status: "answered", execution: { id: runId } },
        execution: { id: runId },
      },
    },
  }, operation, authoritativeInteraction());

  assert.equal(reconciled.state, "completed");
  assert.equal(reconciled.resolution?.runId, runId);
  assert.equal(controller.size, 0);
  assert.equal(state.toolCalls.length, 1);
  assert.deepEqual(state.accepted, [{ requestId, viewSessionId, settlementsAtBoundary: 1 }],
    "a fresh resolved read reaches the same acceptance boundary before its final settlement");
});

test("an exact standalone interaction receipt is accepted without inventing run authority", async () => {
  const state = harness({
    structuredContent: { ok: true, data: { requestId, requestStatus: "answered" } },
  });
  const controller = createMutationController(state.services);

  const outcome = await controller.callVerifiedInteractionMutation(
    "loomex_interaction_respond", `interaction:respond:${requestId}`,
    { requestId, answer: { details: "standalone" } },
    { humanRequest: { id: requestId, status: "pending" } },
  );

  assert.equal(outcome.accepted, true);
  assert.equal(outcome.resolution?.runId, undefined);
  assert.deepEqual(outcome.resolution?.acceptedInteraction, { requestId, status: "answered" });
  assert.equal(controller.size, 0);
});

test("restored unbound or foreign origin never adopts the current identity for redispatch", async () => {
  for (const savedOrigin of [undefined, { ...originIdentity, installationId: requestId }, { ...originIdentity, accountSubject: "other" }, { ...originIdentity, organizationId: requestId }]) {
    const state = harness({ structuredContent: { ok: true, data: {} } });
    const controller = createMutationController(state.services);
    const record = { operationId: runId, method: "runs.cancel", params: { runId, reason: "stop", idempotencyKey: requestId }, idempotencyKey: requestId, status: "pending", ...(savedOrigin ? { originIdentity: savedOrigin } : {}) };
    const restored = controller.restore(record, state.session);
    await assert.rejects(controller.callMutation("loomex_run_cancel", restored.slot, {}), /earlier connection|original connection/);
    assert.equal(state.toolCalls.length, 0);
    assert.equal(controller.get(restored.slot), restored);
    assert.deepEqual(restored.originIdentity, savedOrigin ?? null);
    assert.equal(restored.arguments.idempotencyKey, requestId);
  }
});

test("same-origin restored action dispatches its exact retained arguments after a fresh owner read", async () => {
  const state = harness({ structuredContent: { ok: true, data: {} } });
  const controller = createMutationController(state.services);
  const record = { originIdentity, operationId: runId, method: "runs.cancel", params: { runId, reason: "stop", idempotencyKey: requestId }, idempotencyKey: requestId, status: "pending" };
  const restored = controller.restore(record, state.session);
  await controller.callMutation("loomex_run_cancel", restored.slot, { reason: "changed" });
  assert.deepEqual(state.toolCalls[0]?.arguments_, record.params);
  assert.ok(state.persistenceCalls.some(call => call.name === "loomex_view_session_get"));
});

test("an unbound legacy action can still reconcile canonical accepted state without redispatch", async () => {
  const state = harness({});
  const controller = createMutationController(state.services);
  const restored = controller.restore({ operationId: runId, method: "interactions.respond", params: { requestId, answer: {}, idempotencyKey: requestId }, idempotencyKey: requestId, status: "ambiguous" }, state.session);
  const authoritative = { humanRequest: { id: requestId, status: "resolved", execution: { id: runId } } };
  assert.equal((await controller.reconcile({ structuredContent: { ok: true, data: authoritative } }, restored, authoritative)).state, "completed");
  assert.equal(state.toolCalls.length, 0);
  assert.equal(controller.size, 0);
});

test("exact journal-conflict adoption preserves the recorded origin before dispatch", async () => {
  for (const savedOrigin of [originIdentity, undefined, { ...originIdentity, installationId: requestId }]) {
    const state = harness({ structuredContent: { ok: true, data: {} } });
    const operation = createMutationOperation("loomex_run_cancel", `run:cancel:${runId}`, { runId, reason: "Stop requested" }, "cancellation", keyFactory());
    let intended: JsonObject | undefined;
    const current = { ...state.session, revision: 1, operation: { operationId: runId, status: "pending" } };
    state.services.persistence.call = async (name, args) => {
      if (name === "loomex_view_session_update") {
        intended = record(args.operation);
        throw Object.assign(new Error("An exact operation was recorded before the journal response."), { code: "OPERATION_PENDING" });
      }
      if (name === "loomex_view_session_get") return current;
      if (name === "loomex_view_operation_get") {
        assert.ok(intended);
        return { ...intended, operationId: runId, status: "pending", ...(savedOrigin ? { originIdentity: savedOrigin } : {}) };
      }
      throw new Error(`Unexpected persistence call: ${name}`);
    };
    const controller = createMutationController(state.services);
    await assert.rejects(controller.journal(operation), /exact operation was recorded/);
    assert.equal(operation.originIdentity, undefined, "the factory has no origin before owner-checked journal adoption");
    assert.equal(operation.journalConflict, true);
    await controller.recoverOperationConflicts(operation);
    assert.equal(operation.operationId, runId);
    assert.deepEqual(operation.originIdentity, savedOrigin ?? null);
    assert.deepEqual(operation.dispatchOriginIdentity, originIdentity);
    assert.equal(operation.arguments.idempotencyKey, intended?.idempotencyKey);
    let dispatches = 0;
    const dispatch = () => { dispatches++; return Promise.resolve({ structuredContent: { ok: true, data: {} } }); };
    if (savedOrigin === originIdentity) await dispatchJournaledOperation(operation, dispatch);
    else await assert.rejects(dispatchJournaledOperation(operation, dispatch), /earlier connection|original connection/);
    assert.equal(dispatches, savedOrigin === originIdentity ? 1 : 0);
  }
});
