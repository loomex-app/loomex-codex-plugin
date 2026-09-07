import * as assert from "node:assert/strict";
import { test } from "node:test";
import { runSummary } from "../src/run-summary.js";

const runId = "adc7b3ba-1979-47d2-ac14-638ed91c5f82";
const requestId = "8081f734-5175-492b-b412-b1d88d8e3a7d";
const data = {
  execution: { id: runId, status: "waiting", workflowName: "Idea to Implementation", currentNodeName: "Describe Your Idea",
    input: { _loomexRunner: { id: "internal-runner", confirmationKey: "private-confirmation" } } },
  humanRequest: { id: requestId, status: "pending", type: "long_text", execution: { id: runId },
    inputSpec: { inputType: "long_text", question: "What would you like to build?" },
    prompt: "private-prompt", answer: "private-answer" },
  waitState: "human_action_required", runner: { id: "runner-id", status: "online", name: "Runner name" },
  events: [{ payload: "private-event" }], latestSequence: 7, hasMoreEvents: false, timedOut: false,
  details: { id: "detail-id", status: "private-state" },
};

test("run summaries preserve execution and request identities without leaking nested context", () => {
  for (const method of ["runs.get", "runs.wait", "runs.events", "runs.result", "runs.commit", "interactions.get"]) {
    const result = runSummary(method, data);
    assert.deepEqual(result?.execution, { id: runId, status: "waiting", workflowName: "Idea to Implementation", currentNodeName: "Describe Your Idea" });
    assert.deepEqual(result?.nextAction, method === "interactions.get" ? undefined : { tool: "loomex_interaction_get", arguments: { requestId } });
    assert.match(JSON.stringify(result), /What would you like to build/);
    assert.doesNotMatch(JSON.stringify(result), /private-|runner-id|internal-runner|Runner name|online|detail-id/);
  }
});

test("stale or mismatched human requests cannot become actionable summaries", () => {
  for (const changed of [
    { ...data, humanRequest: { ...data.humanRequest, status: "resolved" } },
    { ...data, humanRequest: { ...data.humanRequest, execution: { id: "other-run" } } },
    ... ["completed", "succeeded", "expired", "SUCCEEDED", "EXPIRED"].map(status => ({ ...data, execution: { ...data.execution, status } })),
    { ...data, execution: { status: "waiting" } },
    { ...data, execution: { id: "invalid" }, humanRequest: { ...data.humanRequest, execution: { id: "invalid" } } },
    { ...data, humanRequest: { ...data.humanRequest, id: "invalid" } },
    { ...data, execution: { id: "11111111-1111-1111-1111-111111111111" }, humanRequest: { ...data.humanRequest, execution: { id: "11111111-1111-1111-1111-111111111111" } } },
    { ...data, execution: { id: "a".repeat(161) }, humanRequest: { ...data.humanRequest, execution: { id: "a".repeat(160) + "b" } } },
  ]) assert.equal(runSummary("runs.get", changed)?.nextAction, undefined);
});

test("question and list previews remain bounded while preserving counts and pagination", () => {
  const request = { ...data.humanRequest, inputSpec: { collectionMode: "batch", questions:
    Array.from({ length: 40 }, (_, i) => ({ id: `q-${i}`, inputType: "text", question: "Q".repeat(1000), options: [{ value: "private-option" }] })) } };
  const result = runSummary("interactions.get", { humanRequest: request });
  assert.ok(JSON.stringify(result).length < 6000);
  assert.match(JSON.stringify(result), /"questionCount":40/);
  assert.match(JSON.stringify(result), /"truncated":true/);
  assert.doesNotMatch(JSON.stringify(result), /private-option/);
  const list = runSummary("runs.list", { executions: Array.from({ length: 40 }, () => data.execution), nextCursor: "next" });
  assert.equal(list?.count, 40);
  assert.equal(list?.truncated, true);
  assert.equal(list?.nextCursor, "next");
  assert.equal((list?.executions as unknown[]).length, 8);
});

test("resolution and spool summaries retain read-only continuation without secrets", () => {
  assert.deepEqual(runSummary("interactions.respond", { requestId, requestStatus: "resolved", executionId: runId, executionStatus: "running", error: null }), {
    requestId, requestStatus: "resolved", executionId: runId, executionStatus: "running", hasError: false,
    nextAction: { tool: "loomex_run_get", arguments: { runId } },
  });
  for (const executionId of ["invalid", "11111111-1111-1111-1111-111111111111"])
    assert.equal(runSummary("interactions.respond", { executionId })?.nextAction, undefined);
  assert.doesNotMatch(JSON.stringify(runSummary("interactions.decide", { requestId, error: { token: "private-token" } })), /private-token/);
  assert.deepEqual(runSummary("runs.result", { responseRef: requestId, sizeBytes: 50000, nextOffset: 0, checksumSha256: "a".repeat(64), encoding: "json" }), {
    responseRef: requestId, sizeBytes: 50000, nextOffset: 0, checksumSha256: "a".repeat(64), encoding: "json",
  });
  assert.doesNotMatch(JSON.stringify(runSummary("runs.prepare", { preparationId: requestId, confirmationKey: "private-confirmation", binding: data.execution.input })), /private-confirmation|internal-runner/);
});
