import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../src/ui-app/contracts.js";
import { acceptedDraftRequestId } from "../src/ui-app/interaction-controller.js";
import type { HumanRequest } from "../src/ui-app/page-models.js";
import { RequestDraftController, type RequestDraftServices } from "../src/ui-app/request-draft-controller.js";

const sessionId = "b3cc8197-6fbe-468a-b751-7f058af551da";
const requestA = "d7a42fd4-8b91-4227-8406-c4a8f8a680c5";
const requestB = "e929b4f2-9a95-4464-86db-f5593072fa34";
const digest = "a".repeat(64);

test("accepted draft identity uses only explicit or exactly matching retained operation arguments", () => {
  const retained = {
    name: "loomex_interaction_respond" as const,
    slot: `interaction:respond:${requestA}`,
    arguments: { requestId: requestA, answer: { response: "first" } },
  };
  assert.equal(acceptedDraftRequestId("loomex_interaction_decide", "interaction:approve:explicit", {
    requestId: requestB,
  }, retained), requestB);
  assert.equal(acceptedDraftRequestId(retained.name, retained.slot, {}, retained), requestA);
  assert.equal(acceptedDraftRequestId(retained.name, "interaction:respond:different-slot", {}, retained), undefined);
  assert.equal(acceptedDraftRequestId("loomex_interaction_decide", retained.slot, {}, retained), undefined);
});

test("accepted mutation presentation cannot erase its cleanup tuple or detach a replacement request", async () => {
  let request: HumanRequest = { id: requestA, schemaDigest: digest };
  let answer: JsonObject = { response: "first" };
  let keySequence = 0;
  let revision = 0;
  const calls: Array<{ readonly name: string; readonly args: JsonObject }> = [];
  const host: RequestDraftServices = {
    draftRequest: () => request,
    inputSupported: () => true,
    sessionId: () => sessionId,
    hydrationReady: () => true,
    hydrationEpoch: () => 1,
    validId: (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value),
    persistenceTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "loomex_interaction_draft_delete") return {};
      revision += 1;
      return { draft: {
        requestId: args.requestId,
        revision,
        schemaDigest: args.expectedSchemaDigest,
        answers: args.answers,
        currentQuestionId: args.currentQuestionId,
        phase: args.phase,
      } };
    },
    answers: () => answer,
    currentQuestionId: () => null,
    phase: () => "answer",
    uuid: () => `00000000-0000-4000-8000-${String(++keySequence).padStart(12, "0")}`,
    exactEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    restoreAnswers: () => undefined,
    showQuestion: () => undefined,
    beginReview: () => undefined,
    status: () => undefined,
    markViewDirty: () => undefined,
    flushView: async () => true,
    persistenceBlocked: () => false,
    setError: () => undefined,
  };
  const controller = new RequestDraftController(host);
  controller.scheduleInteractionDraft();
  assert.equal(await controller.flushInteractionDraft(), true);

  const cleanup = controller.captureAcceptedDraft(requestA);
  assert.ok(cleanup);

  // The verified mutation presents its accepted result before its promise
  // resolves. Model that presentation replacing request A with request B.
  const outcome = await (async () => {
    request = { id: requestB, schemaDigest: digest };
    answer = { response: "replacement" };
    controller.synchronizeInteractionDraftScope();
    controller.scheduleInteractionDraft();
    assert.equal(await controller.flushInteractionDraft(), true);
    return { accepted: true, requestId: requestA } as const;
  })();

  if (outcome.accepted && cleanup.requestId === outcome.requestId) {
    assert.equal(await controller.deleteAcceptedDraft(cleanup), true);
  }

  assert.equal(controller.state.draft?.requestId, requestB);
  assert.deepEqual(calls.map(({ name, args }) => ({ name, requestId: args.requestId })), [
    { name: "loomex_interaction_draft_update", requestId: requestA },
    { name: "loomex_interaction_draft_update", requestId: requestB },
    { name: "loomex_interaction_draft_delete", requestId: requestA },
  ]);
  assert.deepEqual(calls.at(-1)?.args, {
    requestId: requestA,
    expectedRevision: 1,
    expectedSchemaDigest: digest,
    idempotencyKey: cleanup.idempotencyKey,
  });
});
