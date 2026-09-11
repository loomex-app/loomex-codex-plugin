import * as assert from "node:assert/strict";
import { test } from "node:test";
import { runSummary } from "../src/run-summary.js";
import { monitoringContract } from "../src/monitoring-contract.js";

const runId = "adc7b3ba-1979-47d2-ac14-638ed91c5f82";
const requestId = "8081f734-5175-492b-b412-b1d88d8e3a7d";
const organizationId = "dd6244ea-2f21-48bd-a9da-4d2ac161882a";
const data = {
  execution: { id: runId, status: "waiting", workflowName: "Idea to Implementation", currentNodeName: "Describe Your Idea",
    organizationId,
    input: { _loomexRunner: { id: "internal-runner", confirmationKey: "private-confirmation" } } },
  humanRequest: { id: requestId, status: "pending", type: "long_text", execution: { id: runId },
    organizationId,
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
    assert.deepEqual(result?.nextAction, method === "runs.commit" ? { tool: "loomex_run_get", arguments: { runId } }
      : ["runs.get", "runs.wait", "runs.events"].includes(method) ? { tool: "loomex_interaction_view", arguments: { requestId } } : undefined);
    assert.match(JSON.stringify(result), /What would you like to build/);
    assert.doesNotMatch(JSON.stringify(result), /private-|runner-id|internal-runner|Runner name|online|detail-id/);
  }
});

test("stale or mismatched human requests cannot become answer actions", () => {
  for (const changed of [
    { ...data, humanRequest: { ...data.humanRequest, status: "resolved" } },
    { ...data, humanRequest: { ...data.humanRequest, execution: { id: "other-run" } } },
    ... ["completed", "succeeded", "expired", "SUCCEEDED", "EXPIRED"].map(status => ({ ...data, execution: { ...data.execution, status } })),
    { ...data, execution: { status: "waiting" } },
    { ...data, execution: { id: "invalid" }, humanRequest: { ...data.humanRequest, execution: { id: "invalid" } } },
    { ...data, humanRequest: { ...data.humanRequest, id: "invalid" } },
    { ...data, execution: { id: "11111111-1111-1111-1111-111111111111" }, humanRequest: { ...data.humanRequest, execution: { id: "11111111-1111-1111-1111-111111111111" } } },
    { ...data, execution: { id: "a".repeat(161) }, humanRequest: { ...data.humanRequest, execution: { id: "a".repeat(160) + "b" } } },
  ]) {
    const next = runSummary("runs.get", changed)?.nextAction as { tool?: string } | undefined;
    assert.notEqual(next?.tool, "loomex_interaction_get");
    assert.notEqual(next?.tool, "loomex_interaction_view");
  }
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
    originatingOperationComplete: true, doNotReplayOriginatingOperation: true,
    nextAction: { tool: "loomex_response_read", arguments: { responseRef: requestId, offset: 0 } },
  });
  assert.doesNotMatch(JSON.stringify(runSummary("runs.prepare", { preparationId: requestId, confirmationKey: "private-confirmation", binding: data.execution.input })), /private-confirmation|internal-runner/);
});

test("chat continuation advances the exact run through baseline, bounded waits, question and result", () => {
  const active = { execution: { id: runId, status: "running", organizationId }, latestSequence: 23, timedOut: true };
  assert.deepEqual(runSummary("runs.commit", active)?.nextAction, { tool: "loomex_run_get", arguments: { runId } });
  for (const method of ["runs.get", "runs.wait"]) {
    assert.deepEqual(runSummary(method, active)?.nextAction, { tool: "loomex_run_wait", arguments: { runId, timeoutSeconds: 30, afterSequence: 23 } });
    assert.deepEqual(runSummary(method, data)?.nextAction, { tool: "loomex_interaction_view", arguments: { requestId } });
    assert.equal(runSummary(method, data)?.requiresUserInput, true);
    for (const status of ["completed", "failed", "canceled", "EXPIRED"]) {
      assert.deepEqual(runSummary(method, { ...active, execution: { ...active.execution, status } })?.nextAction,
        { tool: "loomex_run_result", arguments: { runId } });
    }
  }
  for (const snapshot of [data, { humanRequest: data.humanRequest }]) {
    assert.equal(runSummary("interactions.get", snapshot)?.awaitingUserAnswer, true);
    assert.equal(runSummary("interactions.get", snapshot)?.presentationAction, undefined);
    assert.equal(runSummary("interactions.get", snapshot)?.nextAction, undefined);
  }
  assert.equal(runSummary("runs.result", { ...active, execution: { ...active.execution, status: "completed" } })?.nextAction, undefined);
  assert.equal(runSummary("runs.get", { ...active, execution: { ...active.execution, status: "deleted" } })?.nextAction, undefined);
  assert.equal(runSummary("runs.get", { execution: { id: runId, status: "unknown_state" } })?.nextAction, undefined);
  assert.doesNotMatch(JSON.stringify(runSummary("runs.wait", active)), /loomex_workflows_list|loomex_run_commit|loomex_run_prepare/);
});

test("invalid question identities and organization substitutions pause chat continuation", () => {
  for (const humanRequest of [
    { ...data.humanRequest, id: "invalid" },
    { ...data.humanRequest, execution: { id: "cb0a8e45-9c68-4ae0-bc60-09300d9848b3" } },
    { ...data.humanRequest, organizationId: "cb0a8e45-9c68-4ae0-bc60-09300d9848b3", execution: { id: runId, organizationId: requestId } },
  ]) {
    const output = runSummary("runs.get", { ...data, humanRequest });
    assert.equal(output?.nextAction, undefined);
    assert.equal(output?.stateNeedsVerification, true);
    assert.equal(runSummary("interactions.get", { ...data, humanRequest })?.presentationAction, undefined);
  }
  for (const latestSequence of [-1, 1.5, "23", Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(runSummary("runs.wait", { execution: { id: runId, status: "running", organizationId }, latestSequence })?.nextAction,
      { tool: "loomex_run_wait", arguments: { runId, timeoutSeconds: 30 } });
  }
});

test("missing organization identities never produce monitoring or human-answer actions", () => {
  const unscopedExecution = { id: runId, status: "waiting" };
  const unscopedRequest = { id: requestId, status: "pending", execution: { id: runId } };
  for (const method of ["runs.get", "runs.wait", "runs.events"]) {
    const result = runSummary(method, { execution: unscopedExecution, humanRequest: unscopedRequest });
    assert.equal(result?.nextAction, undefined);
    assert.equal(result?.requiresUserInput, undefined);
    assert.equal(result?.stateNeedsVerification, true);
    assert.deepEqual(result?.monitoring, monitoringContract({ state: "needs_attention" }));
  }
  const interactionResult = runSummary("interactions.get", { humanRequest: unscopedRequest });
  assert.equal(interactionResult?.awaitingUserAnswer, undefined);
  assert.equal(interactionResult?.requiresUserInput, undefined);
});


test("monitoring drains event pages before questions, waits or terminal results", () => {
  for (const method of ["runs.get", "runs.wait", "runs.events"]) {
    for (const status of ["waiting", "completed"]) {
      const snapshot = { ...data, execution: { ...data.execution, status }, events: [{ sequence: 2 }], latestSequence: 3, hasMoreEvents: true };
      assert.deepEqual(runSummary(method, snapshot)?.nextAction, { tool: "loomex_run_events", arguments: { runId, afterSequence: 2 } });
      for (const events of [[], [{ sequence: -1 }], [{ sequence: 2 }, { sequence: 1 }]]) {
        assert.equal(runSummary(method, { ...snapshot, events })?.stateNeedsVerification, true);
        assert.equal(runSummary(method, { ...snapshot, events })?.nextAction, undefined);
      }
    }
  }
});

test("unverifiable human or dispatch states never enter a rapid wait loop", () => {
  for (const humanRequest of [{}, { ...data.humanRequest, status: "resolved" }, "malformed"]) {
    const result = runSummary("runs.wait", { ...data, humanRequest });
    assert.equal(result?.stateNeedsVerification, true);
    assert.equal(result?.nextAction, undefined);
  }
  assert.equal(runSummary("runs.wait", { execution: data.execution, waitState: "agent_dispatch_required" })?.nextAction, undefined);
  const receipt = runSummary("runs.commit", { responseRef: requestId, nextOffset: 5 });
  assert.equal(receipt?.doNotReplayOriginatingOperation, true);
  assert.deepEqual(receipt?.nextAction, { tool: "loomex_response_read", arguments: { responseRef: requestId, offset: 0 } });
});


test("truncated event pages cannot advance beyond the authoritative sequence", () => {
  for (const latestSequence of [undefined, 2, 1, -1, 2.5, Number.MAX_SAFE_INTEGER + 1]) {
    const snapshot = { execution: data.execution, events: [{ sequence: 2 }], hasMoreEvents: true,
      ...(latestSequence === undefined ? {} : { latestSequence }) };
    assert.equal(runSummary("runs.events", snapshot)?.nextAction, undefined);
    assert.equal(runSummary("runs.events", snapshot)?.stateNeedsVerification, true);
  }
});

 test("a displayed interaction pauses for the user instead of requesting another card", () => {
  const displayed = runSummary("interactions.get", data);
  assert.equal(displayed?.awaitingUserAnswer, true);
  assert.equal(displayed?.presentationAction, undefined);
  assert.equal(displayed?.nextAction, undefined);
  assert.deepEqual(runSummary("runs.get", data)?.headlessAction, { tool: "loomex_interaction_get", arguments: { requestId } });
});

test("monitoring remains active across quiet waits until a new question arrives", () => {
  const quiet = { execution: { id: runId, status: "RUNNING", organizationId }, latestSequence: 23, timedOut: true };
  const activeMonitoring = monitoringContract({ state: "active", observation: "quiet_timeout" });
  for (let poll = 0; poll < 7; poll += 1) {
    const result = runSummary("runs.wait", quiet);
    assert.deepEqual(result?.monitoring, activeMonitoring);
    assert.deepEqual(result?.nextAction, { tool: "loomex_run_wait", arguments: { runId, timeoutSeconds: 30, afterSequence: 23 } });
  }

  const newQuestion = { ...quiet, execution: { ...quiet.execution, status: "WAITING" }, humanRequest: data.humanRequest };
  const result = runSummary("runs.wait", newQuestion);
  assert.deepEqual(result?.monitoring, monitoringContract({ state: "needs_input" }));
  assert.deepEqual(result?.nextAction, { tool: "loomex_interaction_view", arguments: { requestId } });
});

test("monitoring lifecycle follows pagination, verified actions and terminal state", () => {
  const pageResult = runSummary("runs.get", {
    execution: { id: runId, status: "COMPLETED", organizationId },
    humanRequest: data.humanRequest,
    events: [{ sequence: 4 }], latestSequence: 5, hasMoreEvents: true,
  });
  assert.deepEqual(pageResult?.monitoring, monitoringContract({ state: "active", eventPagesPending: true, observation: "event_pages_pending" }));
  assert.deepEqual(pageResult?.nextAction, { tool: "loomex_run_events", arguments: { runId, afterSequence: 4 } });

  for (const status of ["COMPLETED", "FAILED", "CANCELED", "DELETED"]) {
    const result = runSummary("runs.wait", { execution: { id: runId, status, organizationId }, timedOut: true });
    assert.deepEqual(result?.monitoring, monitoringContract({ state: "terminal", resultPending: status !== "DELETED" }));
    assert.deepEqual(result?.nextAction, status === "DELETED" ? undefined : { tool: "loomex_run_result", arguments: { runId } });
  }

  const actionable = runSummary("runs.get", {
    execution: { id: runId, status: "WAITING" }, humanRequest: { status: "pending" }, waitState: "human_action_required",
  });
  assert.deepEqual(actionable?.monitoring, monitoringContract({ state: "needs_attention" }));
  assert.equal(actionable?.nextAction, undefined);
});

test("monitoring does not call malformed identities terminal", () => {
  const invalidRun = runSummary("runs.get", { execution: { id: "invalid", status: "COMPLETED" } });
  assert.equal(invalidRun?.monitoring, undefined);

  const invalidOrganization = runSummary("runs.get", {
    execution: { id: runId, status: "COMPLETED", organizationId: "invalid" },
  });
  assert.deepEqual(invalidOrganization?.monitoring, monitoringContract({ state: "needs_attention" }));
  assert.equal(invalidOrganization?.nextAction, undefined);
  assert.equal(invalidOrganization?.stateNeedsVerification, true);
  for (const status of ["RUNNING", "WAITING"]) {
    const invalid = runSummary("runs.wait", {
      execution: { id: runId, status, organizationId: "invalid" },
      humanRequest: data.humanRequest,
      events: [{ sequence: 4 }], latestSequence: 5, hasMoreEvents: true,
    });
    assert.equal(invalid?.nextAction, undefined);
    assert.deepEqual(invalid?.monitoring, monitoringContract({ state: "needs_attention" }));
  }
});

test("authoritative chat questions route headlessly and retain submission context", () => {
  const responseSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
  const humanRequest = { ...data.humanRequest, answerChannel: "chat", schemaDigest: "a".repeat(64), responseSchema };
  const result = runSummary("runs.wait", { ...data, humanRequest });
  assert.deepEqual(result?.nextAction, { tool: "loomex_interaction_get", arguments: { requestId } });
  assert.deepEqual(result?.monitoring, monitoringContract({ state: "needs_input" }));
  const question = runSummary("interactions.get", { humanRequest });
  assert.equal(question?.answerChannel, "chat");
  assert.equal(question?.question, "What would you like to build?");
  assert.deepEqual(question?.responseSchema, responseSchema);
  assert.equal(question?.schemaDigest, "a".repeat(64));
  assert.equal(question?.awaitingUserAnswer, true);
});

test("progress summaries preserve silence and omitted backend activity", () => {
  const result=runSummary("runs.get", {execution:{id:runId,status:"RUNNING"},progress:{version:1,activeNodes:[{nodeExecutionId:requestId,nodeName:"Build",lastActivity:null}],latestActivity:null,hasMore:true}});
  const progress=result?.progress as any;
  assert.equal(progress.truncated,true);
  assert.equal(progress.hasMore,true);
  assert.equal(progress.latestActivity,null);
  assert.equal(progress.activeNodes[0].lastActivity,null);
});
