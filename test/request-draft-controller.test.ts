import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../src/ui-app/contracts.js";
import type { HumanRequest } from "../src/ui-app/page-models.js";
import { RequestDraftController, type RequestDraftServices } from "../src/ui-app/request-draft-controller.js";

const sessionId = "b3cc8197-6fbe-468a-b751-7f058af551da";
const requestA = "d7a42fd4-8b91-4227-8406-c4a8f8a680c5";
const requestB = "e929b4f2-9a95-4464-86db-f5593072fa34";
const digest = "a".repeat(64);

type Call = { readonly name: string; readonly args: JsonObject };
type Deferred = { readonly promise: Promise<JsonObject>; resolve(value: JsonObject): void; reject(reason: Error): void };
type Subject = {
  readonly controller: RequestDraftController;
  readonly calls: Call[];
  readonly errors: Error[];
  readonly statuses: (Error | undefined)[];
  setRequest(id: string): void;
  setAnswers(value: JsonObject): void;
  setResponder(value: (name: string, args: JsonObject) => Promise<JsonObject>): void;
};

function deferred(): Deferred {
  let resolvePromise: ((value: JsonObject) => void) | undefined;
  let rejectPromise: ((reason: Error) => void) | undefined;
  const promise = new Promise<JsonObject>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return {
    promise,
    resolve(value) { resolvePromise?.(value); },
    reject(reason) { rejectPromise?.(reason); },
  };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function saved(args: JsonObject, revision: number, requestId = args.requestId): JsonObject {
  return { draft: {
    requestId,
    revision,
    schemaDigest: args.expectedSchemaDigest,
    answers: args.answers,
    currentQuestionId: args.currentQuestionId,
    phase: args.phase,
  } };
}

function fixture(overrides: Partial<RequestDraftServices> = {}): Subject {
  let currentRequest: HumanRequest = { id: requestA, schemaDigest: digest };
  let answers: JsonObject = { response: "first" };
  let mutation = 0;
  let responder: (name: string, args: JsonObject) => Promise<JsonObject> = async (_name, args) => saved(args, 1);
  const calls: Call[] = [];
  const errors: Error[] = [];
  const statuses: (Error | undefined)[] = [];
  const host: RequestDraftServices = {
    draftRequest: () => currentRequest,
    inputSupported: () => true,
    sessionId: () => sessionId,
    hydrationReady: () => true,
    hydrationEpoch: () => 1,
    validId: (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value),
    persistenceTool: async (name, args) => {
      calls.push({ name, args });
      return responder(name, args);
    },
    answers: () => answers,
    currentQuestionId: () => null,
    phase: () => "answer",
    uuid: () => `00000000-0000-4000-8000-${String(++mutation).padStart(12, "0")}`,
    exactEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    restoreAnswers: () => undefined,
    showQuestion: () => undefined,
    beginReview: () => undefined,
    status: (_status, error) => { statuses.push(error); },
    markViewDirty: () => undefined,
    flushView: async () => true,
    persistenceBlocked: () => false,
    setError: error => { errors.push(error); },
    ...overrides,
  };
  return {
    controller: new RequestDraftController(host), calls, errors, statuses,
    setRequest(id) { currentRequest = { id, schemaDigest: digest }; },
    setAnswers(value) { answers = value; },
    setResponder(value) { responder = value; },
  };
}

test("draft identity fences a request by session and schema digest", () => {
  const { controller } = fixture();
  assert.equal(controller.identity()?.key, `${sessionId}:${requestA}:${digest}`);
  assert.equal(controller.requestSchemaDigest({ id: requestA, schemaDigest: "invalid" }), undefined);
});

test("edits arriving during a save are drained by a second exact mutation", async () => {
  const subject = fixture();
  const first = deferred();
  const second = deferred();
  let responses = 0;
  subject.setResponder(async (_name, args) => ++responses === 1 ? first.promise : second.promise);
  subject.controller.synchronizeInteractionDraftScope();
  subject.controller.scheduleInteractionDraft();
  const savedAll = subject.controller.flushInteractionDraft();
  assert.equal(subject.calls.length, 1);
  subject.setAnswers({ response: "second" });
  subject.controller.scheduleInteractionDraft();
  first.resolve(saved(subject.calls[0]!.args, 1));
  await nextTurn();
  assert.equal(subject.calls.length, 2);
  second.resolve(saved(subject.calls[1]!.args, 2));
  assert.equal(await savedAll, true);
  assert.deepEqual(subject.calls[1]!.args.answers, { response: "second" });
});

test("concurrent flushes wait for the complete dirty drain", async () => {
  const subject = fixture();
  const first = deferred();
  const second = deferred();
  let responses = 0;
  subject.setResponder(async (_name, args) => ++responses === 1 ? first.promise : second.promise);
  subject.controller.scheduleInteractionDraft();
  const one = subject.controller.flushInteractionDraft();
  subject.setAnswers({ response: "second" });
  subject.controller.scheduleInteractionDraft();
  const two = subject.controller.flushInteractionDraft();
  let secondFinished = false;
  void two.then(() => { secondFinished = true; });
  first.resolve(saved(subject.calls[0]!.args, 1));
  await nextTurn();
  assert.equal(subject.calls.length, 2);
  assert.equal(secondFinished, false);
  second.resolve(saved(subject.calls[1]!.args, 2));
  assert.equal(await one, true);
  assert.equal(await two, true);
});

test("malformed and wrong-request receipts retain the dirty attempt for retry", async () => {
  const subject = fixture();
  subject.controller.scheduleInteractionDraft();
  subject.setResponder(async () => ({ draft: {} }));
  assert.equal(await subject.controller.flushInteractionDraft(), false);
  assert.equal(subject.controller.state.dirty, true);
  const key = subject.calls[0]!.args.idempotencyKey;
  subject.setResponder(async (_name, args) => saved(args, 1, requestB));
  assert.equal(await subject.controller.flushInteractionDraft(), false);
  assert.equal(subject.calls.filter(call => call.name === "loomex_interaction_draft_update")[1]!.args.idempotencyKey, key);
  assert.equal(subject.controller.state.dirty, true);
});

test("draft loading rejects a receipt bound to a different request", async () => {
  const subject = fixture();
  subject.setResponder(async (_name, args) => saved({
    requestId: requestB,
    expectedSchemaDigest: args.requestId === requestA ? digest : "",
    answers: { response: "wrong" },
    currentQuestionId: null,
    phase: "answer",
  }, 1, requestB));
  assert.equal(await subject.controller.loadInteractionDraft({ id: requestA, schemaDigest: digest }), false);
  assert.equal(subject.controller.state.draft, null);
});

test("a delayed receipt for a replaced request is ignored", async () => {
  const subject = fixture();
  const delayed = deferred();
  let updates = 0;
  subject.setResponder(async (_name, args) => ++updates === 1 ? delayed.promise : saved(args, 1));
  subject.controller.scheduleInteractionDraft();
  const first = subject.controller.flushInteractionDraft();
  subject.setRequest(requestB);
  subject.controller.synchronizeInteractionDraftScope();
  subject.controller.scheduleInteractionDraft();
  const second = subject.controller.flushInteractionDraft();
  delayed.resolve(saved(subject.calls[0]!.args, 1));
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(subject.calls.length, 2);
  assert.equal(subject.controller.state.draft?.requestId, requestB);
  assert.equal(subject.controller.state.scope?.identity.requestId, requestB);
});

test("a failed mutation retries its exact idempotency tuple", async () => {
  const subject = fixture();
  let failed = false;
  subject.setResponder(async (_name, args) => {
    if (!failed) {
      failed = true;
      throw Object.assign(new Error("conflict"), { code: "CONFLICT" });
    }
    return saved(args, 1);
  });
  subject.controller.scheduleInteractionDraft();
  assert.equal(await subject.controller.flushInteractionDraft(), false);
  assert.equal(await subject.controller.flushInteractionDraft(), true);
  assert.deepEqual(subject.calls[1]!.args, subject.calls[0]!.args);
});

test("run-preparation persistence failures use the action label rather than claiming an answer was submitted", async () => {
  const subject = fixture({
    flushView: async () => false,
    viewFailure: () => new Error("The durable view store rejected the call"),
    persistenceActionLabel: () => "run preparation",
  });
  assert.equal(await subject.controller.flushCurrentPersistence(), false);
  assert.equal(subject.errors.length, 1);
  assert.equal(subject.errors[0]!.message, "The run preparation could not be saved. Save it before starting.");
  assert.equal((subject.errors[0] as Error & { code?: string }).code, "PRESENTATION_SAVE_FAILED");
});

test("dispose fences scheduled and in-flight persistence", async () => {
  const subject = fixture();
  const delayed = deferred();
  subject.setResponder(async () => delayed.promise);
  subject.controller.scheduleInteractionDraft();
  const saving = subject.controller.flushInteractionDraft();
  subject.controller.dispose();
  delayed.resolve(saved(subject.calls[0]!.args, 1));
  assert.equal(await saving, false);
  assert.equal(await subject.controller.flushInteractionDraft(), false);
  assert.equal(subject.controller.state.draft, null);
});

test("accepted cleanup keeps its captured deletion tuple and preserves a replacement draft", async () => {
  const subject = fixture();
  subject.controller.scheduleInteractionDraft();
  assert.equal(await subject.controller.flushInteractionDraft(), true);
  const cleanup = subject.controller.captureAcceptedDraft(requestA);
  assert.ok(cleanup);
  subject.setRequest(requestB);
  subject.controller.synchronizeInteractionDraftScope();
  subject.controller.scheduleInteractionDraft();
  assert.equal(await subject.controller.flushInteractionDraft(), true);
  assert.equal(subject.controller.state.draft?.requestId, requestB);
  assert.equal(await subject.controller.deleteAcceptedDraft(cleanup), true);
  const deletion = subject.calls.at(-1);
  assert.equal(deletion?.name, "loomex_interaction_draft_delete");
  assert.deepEqual(deletion?.args, {
    requestId: requestA,
    expectedRevision: 1,
    expectedSchemaDigest: digest,
    idempotencyKey: cleanup.idempotencyKey,
  });
  assert.equal(subject.controller.state.draft?.requestId, requestB);
});

test("restore retains the original failure and clears it after successful recovery", async () => {
  const subject = fixture();
  const failure = Object.assign(new Error("The host returned incomplete draft data."), { code: "UI_SUCCESS_DATA_INVALID" });
  subject.setResponder(async () => { throw failure; });
  assert.equal(await subject.controller.loadInteractionDraft({ id: requestA, schemaDigest: digest }), false);
  assert.equal(subject.controller.lastFailure, failure);
  subject.setResponder(async () => ({ draft: null }));
  assert.equal(await subject.controller.loadInteractionDraft({ id: requestA, schemaDigest: digest }), true);
  assert.equal(subject.controller.lastFailure, null);
});

test("submission retains the draft save failure and request replacement clears it", async () => {
  const subject = fixture();
  const failure = Object.assign(new Error("Draft write could not be verified."), { code: "HOST_TIMEOUT" });
  subject.setResponder(async () => { throw failure; });
  subject.controller.scheduleInteractionDraft();
  assert.equal(await subject.controller.flushCurrentPersistence(), false);
  assert.equal(subject.controller.lastFailure, failure);
  assert.equal(subject.errors.at(-1)?.cause, failure);
  assert.equal(subject.errors.at(-1)?.message, "Your answers could not be saved. Save them before submitting.");
  assert.equal(subject.statuses.at(-1), failure);
  subject.controller.detachInteractionDraft();
  assert.equal(subject.controller.lastFailure, null);
});


test("a mismatched acknowledgement reconciles a landed draft without repeating the write", async () => {
  const subject = fixture();
  let receipt: JsonObject = {};
  subject.setResponder(async (name, args) => {
    if (name === "loomex_interaction_draft_update") { receipt = saved(args, 1); return { draft: {} }; }
    return receipt;
  });
  subject.controller.scheduleInteractionDraft();
  assert.equal(await subject.controller.flushCurrentPersistence(), true);
  assert.deepEqual(subject.calls.map(call => call.name), ["loomex_interaction_draft_update", "loomex_interaction_draft_get"]);
  assert.equal(subject.controller.state.dirty, false);
});

test("a changed authoritative answer remains blocked and identifies the mismatch without exposing answers", async () => {
  const subject = fixture();
  let receipt: JsonObject = {};
  subject.setResponder(async (name, args) => {
    if (name === "loomex_interaction_draft_update") receipt = saved({ ...args, answers: { response: "different private answer" } }, 1);
    return receipt;
  });
  subject.controller.scheduleInteractionDraft();
  assert.equal(await subject.controller.flushCurrentPersistence(), false);
  assert.match(subject.controller.lastFailure?.message ?? "", /\(answers\)/);
  assert.doesNotMatch(subject.controller.lastFailure?.message ?? "", /different private answer/);
  assert.equal(subject.controller.state.dirty, true);
});


test("review saves canonical null position even while the last question remains mounted", async () => {
  const subject = fixture({ phase: () => "review", currentQuestionId: () => "last-question" });
  subject.controller.scheduleInteractionDraft();
  assert.equal(await subject.controller.flushCurrentPersistence(), true);
  assert.equal(subject.calls[0]!.args.currentQuestionId, null);
});

test("a review receipt and remount accept an omitted null navigation field", async () => {
  const subject = fixture({ phase: () => "review" });
  let receipt: JsonObject;
  subject.setResponder(async (_name, args) => {
    receipt = saved(args, 1);
    delete (receipt.draft as JsonObject).currentQuestionId;
    return receipt;
  });
  subject.controller.scheduleInteractionDraft();
  assert.equal(await subject.controller.flushCurrentPersistence(), true);
  assert.equal(subject.controller.state.draft?.currentQuestionId, null);
  subject.setResponder(async () => receipt);
  assert.equal(await subject.controller.loadInteractionDraft({ id: requestA, schemaDigest: digest }), true);
});

test("a different nonempty question position still fails verification", async () => {
  const subject = fixture();
  let receipt: JsonObject;
  subject.setResponder(async (name, args) => {
    if (name.endsWith("update")) receipt = saved({ ...args, currentQuestionId: "different-question" }, 1);
    return receipt;
  });
  subject.controller.scheduleInteractionDraft();
  assert.equal(await subject.controller.flushCurrentPersistence(), false);
  assert.match(subject.controller.lastFailure?.message ?? "", /question position/);
});

test("explicit draft reapplication retains local answers and uses a fresh confirmed revision",async()=>{
 const subject=fixture();subject.setAnswers({response:"local"});
 subject.setResponder(async()=>{throw Object.assign(new Error("conflict"),{code:"INTERACTION_DRAFT_CONFLICT"});});
 subject.controller.scheduleInteractionDraft();assert.equal(await subject.controller.flushInteractionDraft(),false);
 const first=subject.calls[0]!.args;
 subject.setResponder(async(name,args)=>name==="loomex_interaction_draft_get" ? saved({...first,answers:{response:"remote"}},4) : saved(args,5));
 assert.equal(await subject.controller.reapplyLocal(),true);
 const last=subject.calls.at(-1)!.args;assert.equal(last.expectedRevision,4);assert.deepEqual(last.answers,{response:"local"});assert.notEqual(last.idempotencyKey,first.idempotencyKey);subject.controller.dispose();
});
