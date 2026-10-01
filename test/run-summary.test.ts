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
  const result = runSummary("runs.get", { execution: data.execution, humanRequest: request });
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

test("focused interaction read preserves every typed choice and submission field without unrelated request data", () => {
  const questions = Array.from({ length: 12 }, (_, index) => ({
    id: `question_${index + 1}`, inputType: index === 0 ? "rating" : index === 1 ? "date" : index === 2 ? "boolean" : index === 3 ? "text" : index % 2 ? "checkbox" : "radio",
    question: `Select ${index + 1}`,
    options: index < 4 ? [] : Array.from({ length: 4 }, (_, option) => ({ id: `q${index + 1}_option${option + 1}`, label: `Choice ${option + 1}` })),
    allowOther: index >= 4, otherLabel: "Something else", ...(index === 0 ? { minimum: 0, maximum: 5 } : {}),
    privateOutput: "hidden-option-context",
  }));
  const request = {
    ...data.humanRequest, answerChannel: "ui", schemaDigest: "a".repeat(64),
    inputSpec: { schemaVersion: "loomex.human-input/v2", collectionMode: "batch", inputType: "radio",
      question: "Choose options", questions, privateInput: "hidden-input-context" },
    responseSchema: { type: "object", properties: { answers: { type: "array", items: {
      type: "object", oneOf: [{ properties: { questionId: { const: "question_5" }, value: { enum: ["q5_option1", "q5_option2"] } }, required: ["questionId", "value"] }],
    } } }, required: ["answers"] },
    answer: { values: ["must-not-leak"] }, providerOutput: "hidden-provider-output",
  };
  const result = runSummary("interactions.get", { execution: data.execution, humanRequest: request });
  const projected = result?.humanRequest as Record<string, any>;
  assert.equal(result?.awaitingUserAnswer, true);
  assert.equal(projected.id, requestId);
  assert.equal(projected.answerChannel, "ui");
  assert.equal(projected.schemaDigest, "a".repeat(64));
  assert.equal(projected.inputSpec.questions.length, questions.length);
  assert.equal(projected.inputSpec.questions[11].id, "question_12");
  assert.deepEqual(projected.inputSpec.questions[11].options, questions[11]!.options);
  assert.equal(projected.inputSpec.questions[11].allowOther, true);
  assert.equal(projected.inputSpec.questions[11].otherLabel, "Something else");
  assert.equal(projected.inputSpec.questions[0].minimum, 0);
  assert.equal(projected.inputSpec.questions[0].maximum, 5);
  assert.equal(projected.inputSpec.questions[11].truncated, undefined);
  assert.equal(projected.inputSpec.truncated, undefined);
  assert.deepEqual(result?.responseSchema, request.responseSchema);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|hidden-option-context|hidden-input-context|hidden-provider-output/);
  const stale = runSummary("interactions.get", { execution: data.execution,
    humanRequest: { ...request, execution: { id: "4a6abfa2-0054-4592-8781-d671145dbdcb" } } });
  assert.equal((stale?.humanRequest as Record<string, any>).inputSpec.questions.length, 8);
  assert.equal(stale?.responseSchema, undefined);
});

test("chat interaction keeps only the filtered submission schema and preserves null for an absent schema", () => {
  const request = { ...data.humanRequest, answerChannel: "chat", schemaDigest: "c".repeat(64),
    inputSpec: { inputType: "long_text", question: "Explain the design" },
    responseSchema: { type: "object", description: "private provider prompt", properties: {
      value: { type: "string", minLength: 1, description: "private field prompt",
        allOf: [{ type: "string", privateRef: "private schema internals" }] },
    }, required: ["value"], privateKey: "private schema root" } };
  const projected = runSummary("interactions.get", { execution: data.execution, humanRequest: request });
  assert.equal(projected?.answerChannel, "chat");
  assert.deepEqual(projected?.responseSchema, { type: "object", properties: {
    value: { type: "string", minLength: 1, allOf: [{ type: "string" }] },
  }, required: ["value"] });
  assert.doesNotMatch(JSON.stringify(projected), /private provider prompt|private field prompt|private schema internals|private schema root/);
  for (const absent of [undefined, null]) {
    const noSchema = { ...request, ...(absent === undefined ? { responseSchema: undefined } : { responseSchema: null }) };
    const result = runSummary("interactions.get", { execution: data.execution, humanRequest: noSchema as any });
    assert.equal(result?.responseSchema, null);
    assert.equal(result?.awaitingUserAnswer, true);
  }
});

test("oversized focused interaction fails explicitly without a partial answer schema", () => {
  const request = { ...data.humanRequest, answerChannel: "ui", schemaDigest: "d".repeat(64),
    inputSpec: { schemaVersion: "loomex.human-input/v2", collectionMode: "batch", inputType: "text",
      question: "Complete all fields", questions: Array.from({ length: 50 }, (_, index) => ({
        id: `q${index + 1}`, inputType: "text", question: `Question ${index + 1}: ${"unique oversized text ".repeat(300)}`,
        options: [], allowOther: false,
      })) },
    responseSchema: { type: "object", properties: { answers: { type: "array" } }, required: ["answers"] } };
  const result = runSummary("interactions.get", { execution: data.execution, humanRequest: request });
  assert.deepEqual(result?.answerIssue, { code: "INTERACTION_SCHEMA_TOO_LARGE",
    message: "The pending question schema exceeds the headless response limit. Open the interaction view or shorten the questions and choices before answering." });
  assert.equal(result?.headlessSchemaComplete, false);
  assert.equal(result?.awaitingUserAnswer, undefined);
  assert.equal((result?.humanRequest as Record<string, unknown>).inputSpec, undefined);
  assert.equal(result?.responseSchema, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 2048);
  assert.doesNotMatch(JSON.stringify(result), /unique oversized text/);
});

test("oversized or deeply nested chat submission schemas fail without exposing a partial contract", () => {
  const base = { ...data.humanRequest, answerChannel: "chat", schemaDigest: "e".repeat(64),
    inputSpec: { inputType: "long_text", question: "Explain" } };
  const oversized = runSummary("interactions.get", { execution: data.execution, humanRequest: {
    ...base, responseSchema: { type: "object", properties: { value: { type: "string", enum: ["private oversized schema ".repeat(13000)] } } },
  } });
  assert.equal((oversized?.answerIssue as Record<string, unknown>).code, "INTERACTION_SCHEMA_TOO_LARGE");
  assert.equal(oversized?.responseSchema, undefined);
  assert.equal(oversized?.question, undefined);
  assert.doesNotMatch(JSON.stringify(oversized), /private oversized schema/);

  let nested: Record<string, unknown> = { type: "string", privateValue: "private deep schema" };
  for (let i = 0; i < 14; i++) nested = { type: "array", items: nested };
  const deep = runSummary("interactions.get", { execution: data.execution, humanRequest: { ...base, responseSchema: nested as any } });
  assert.equal((deep?.answerIssue as Record<string, unknown>).code, "INTERACTION_SCHEMA_UNSUPPORTED");
  assert.equal(deep?.responseSchema, undefined);
  assert.equal((deep?.humanRequest as Record<string, unknown>).inputSpec, undefined);
  assert.doesNotMatch(JSON.stringify(deep), /private deep schema/);
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

test("terminal result read carries the bounded public completion result", () => {
  const publicResult = {
    version: 1, summary: "Implementation complete.", changedFiles: ["plugin/src/run-summary.ts"],
    artifacts: ["report.md"], verification: ["Focused tests passed"], limitations: ["No release install"],
    providerTranscript: "private-provider-transcript", credentials: { token: "private-token" },
  };
  const execution = { id: runId, status: "completed", organizationId, result: publicResult,
    input: { confirmationKey: "private-confirmation" } };
  const result = runSummary("runs.result", { execution, latestSequence: 9, hasMoreEvents: false });
  assert.deepEqual(result?.result, {
    version: 1, summary: "Implementation complete.", changedFiles: ["plugin/src/run-summary.ts"],
    artifacts: ["report.md"], verification: ["Focused tests passed"], limitations: ["No release install"],
  });
  assert.equal(result?.nextAction, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-provider-transcript|private-token|private-confirmation/);
  assert.equal(runSummary("runs.get", { execution })?.result, undefined);
  assert.equal(runSummary("runs.result", { execution: { ...execution, status: "running" } })?.result, undefined);
  assert.equal(runSummary("runs.result", { execution: { ...execution, result: { ...publicResult, version: 2 } } })?.result, undefined);
});

test("large public completion fields mark clipping and remain bounded", () => {
  const marker = "private-backend-field";
  const publicResult = { version: 1, summary: "S".repeat(200_000),
    changedFiles: Array.from({ length: 100 }, (_, index) => `${index}:` + "f".repeat(3000)),
    artifacts: ["artifact"], verification: ["verified"], limitations: ["limited"], secret: marker };
  const result = runSummary("runs.result", { execution: { id: runId, status: "completed", organizationId, result: publicResult } });
  const projected = result?.result as Record<string, unknown>;
  assert.equal(projected.version, 1);
  assert.equal(projected.truncated, true);
  assert.equal((projected.summary as string).length, 4096);
  assert.equal((projected.changedFiles as string[]).length, 8);
  assert.equal((projected.changedFiles as string[])[0]?.length, 512);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 12_000);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
});

test("completion result inspects only a fixed prefix of large arrays", () => {
  const inspected: number[] = [];
  const virtualItems = new Proxy(["seed"], {
    get(target, property, receiver) {
      if (property === "length") return 1_000_000;
      if (typeof property === "string" && /^\d+$/.test(property)) {
        const index = Number(property);
        inspected.push(index);
        if (index > 8) throw new Error("Completion projection scanned too far");
        return `file-${index}`;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const result = runSummary("runs.result", { execution: { id: runId, status: "completed", organizationId,
    result: { version: 1, changedFiles: virtualItems } } });
  assert.deepEqual((result?.result as Record<string, unknown>).changedFiles,
    Array.from({ length: 8 }, (_, index) => `file-${index}`));
  assert.equal((result?.result as Record<string, unknown>).truncated, true);
  assert.deepEqual(inspected, Array.from({ length: 9 }, (_, index) => index));

  const malformed = runSummary("runs.result", { execution: { id: runId, status: "completed", organizationId,
    result: { version: 1, summary: "Valid result", artifacts: ["safe", { token: "private-token" }] } } });
  assert.equal((malformed?.result as Record<string, unknown>).artifacts, undefined);
  assert.doesNotMatch(JSON.stringify(malformed), /private-token/);
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

test("terminal failures retain actionable diagnostics without raw provider output", () => {
  const result = runSummary("runs.result", {
    execution: {
      id: runId, status: "failed", organizationId,
      error: {
        code: "WORKFLOW_RUNTIME_NODE_FAILED", message: "private provider output",
        provider: "codex", model: "gpt-5.6-luna", nodeKey: "requirements_agent",
        retryable: false, rawOutput: "private-token and command output",
        details: { pluginAgentError: { details: { error: {
          code: "PROVIDER_USAGE_LIMIT", message: "You've hit your usage limit: private-token", provider: "codex", model: "gpt-5.6-luna",
        } } } },
      },
    }, latestSequence: 20, hasMoreEvents: false, timedOut: false, events: [],
  });
  assert.deepEqual(result?.failure, {
    code: "PROVIDER_USAGE_LIMIT", message: "The provider usage limit was reached. Wait for provider availability, then start a new run.",
    provider: "codex", model: "gpt-5.6-luna", nodeKey: "requirements_agent", retryable: false,
    category: "provider_limit",
  });
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
});

test("unsupported account model gives a safe targeted recovery", () => {
  const result = runSummary("runs.result", {
    execution: { id: runId, status: "failed", organizationId,
      error: { code: "WORKFLOW_RUNTIME_NODE_FAILED", details: { pluginAgentError: { details: { error: {
        code: "PROVIDER_MODEL_UNAVAILABLE", provider: "codex", model: "gpt-6-sol",
        message: "private provider output",
      } } } } } },
    latestSequence: 4, hasMoreEvents: false, events: [],
  });
  const failure = result?.failure as { code?: string; message?: string } | undefined;
  assert.equal(failure?.code, "PROVIDER_MODEL_UNAVAILABLE");
  assert.equal(failure?.message,
    "The configured provider account cannot use this model. Select an available model and prepare a new run.");
  assert.doesNotMatch(JSON.stringify(result), /private provider output/);
});

test("provider completion remains distinct from authoritative workflow completion", () => {
  const result = runSummary("runs.wait", {
    execution: { id: runId, status: "running", organizationId }, latestSequence: 18,
    hasMoreEvents: false, timedOut: false, events: [],
    progress: { version: 1, activeNodes: [], latestActivity: { kind: "activity.completed", summary: "Provider completed work" } },
  });
  assert.equal(result?.providerCompletionPending, true);
  assert.deepEqual(result?.nextAction, { tool: "loomex_run_wait", arguments: { runId, timeoutSeconds: 30, afterSequence: 18 } });
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

test("lost runner observation stops waits only after event pages are drained", () => {
  const lost = { execution: { id: runId, status: "waiting", organizationId },
    waitState: "observation_lost", latestSequence: 423, hasMoreEvents: false, timedOut: true,
    automation: { phase: "observation_lost", retryable: false, code: "RUNNER_OBSERVATION_LOST",
      message: "private runner details", sessionId: "private-session" } };
  for (const method of ["runs.get", "runs.wait", "runs.events"]) {
    const output = runSummary(method, lost);
    assert.equal(output?.nextAction, undefined);
    assert.deepEqual(output?.observationIssue, { code: "RUNNER_OBSERVATION_LOST",
      message: "The runner stopped reporting before this step acknowledged an outcome. Review the run before taking another action." });
    assert.deepEqual(output?.monitoring, monitoringContract({ state: "needs_attention", observation: "runner_observation_lost" }));
    assert.doesNotMatch(JSON.stringify(output), /private runner details|private-session/);

    const page = runSummary(method, { ...lost, events: [{ sequence: 420 }, { sequence: 421 }], hasMoreEvents: true });
    assert.deepEqual(page?.nextAction, { tool: "loomex_run_events", arguments: { runId, afterSequence: 421 } });
    assert.equal(page?.observationIssue, undefined);
    assert.deepEqual(page?.monitoring, monitoringContract({ state: "active", eventPagesPending: true,
      observation: "event_pages_pending" }));

    const terminal = runSummary(method, { ...lost, execution: { ...lost.execution, status: "failed" } });
    assert.deepEqual(terminal?.nextAction, { tool: "loomex_run_result", arguments: { runId } });
    assert.equal(terminal?.observationIssue, undefined);

    const question = runSummary(method, { ...lost, humanRequest: data.humanRequest });
    assert.deepEqual(question?.nextAction, { tool: "loomex_interaction_view", arguments: { requestId } });
    assert.equal(question?.observationIssue, undefined);
  }
  const healthyQuiet = runSummary("runs.wait", { ...lost, waitState: "automated_progress" });
  assert.deepEqual(healthyQuiet?.nextAction, { tool: "loomex_run_wait", arguments: { runId, timeoutSeconds: 30, afterSequence: 423 } });
  assert.equal(healthyQuiet?.observationIssue, undefined);
});

test("exhausted backend continuation blocks only after pages drain and preserves input and terminal precedence", () => {
  const code = "WORKFLOW_CONTINUATION_OBSERVATION_LOST";
  const lost = { execution: { id: runId, status: "running", organizationId },
    waitState: "observation_lost", latestSequence: 423, hasMoreEvents: false,
    automation: { phase: "observation_lost", retryable: false, code,
      message: "private worker exception", updatedAt: "private timestamp", checkpoint: "private checkpoint" } };
  for (const method of ["runs.get", "runs.wait", "runs.events"]) {
    const output = runSummary(method, lost);
    assert.deepEqual(output?.observationIssue, { code,
      message: "This step stopped before its result could be confirmed. Review the run before taking another action." });
    assert.equal(output?.nextAction, undefined);
    assert.deepEqual(output?.monitoring, monitoringContract({ state: "needs_attention", observation: "actionable_error" }));
    assert.doesNotMatch(JSON.stringify(output), /private|runner stopped|provider failure/);
    const page = runSummary(method, { ...lost, events: [{sequence:421},{sequence:422}], hasMoreEvents:true });
    assert.deepEqual(page?.nextAction, { tool:"loomex_run_events", arguments:{runId,afterSequence:422} });
    assert.equal(page?.observationIssue, undefined);
    assert.equal((page?.monitoring as any).liveFollow.disposition,"continue");
    const input = runSummary(method,{...lost,humanRequest:data.humanRequest});
    assert.deepEqual(input?.nextAction,{tool:"loomex_interaction_view",arguments:{requestId}});
    assert.equal(input?.observationIssue,undefined);
    const terminal = runSummary(method,{...lost,execution:{...lost.execution,status:"completed"}});
    assert.deepEqual(terminal?.nextAction,{tool:"loomex_run_result",arguments:{runId}});
    assert.equal(terminal?.observationIssue,undefined);
    assert.equal((terminal?.monitoring as any).liveFollow.disposition,"terminal_result_pending");
  }
  const result = runSummary("runs.result",{...lost,execution:{...lost.execution,status:"completed"}});
  assert.equal((result?.monitoring as any).liveFollow.disposition,"finished");
  assert.equal(result?.observationIssue,undefined);
});

test("continuation observation requires the verified exhausted contract and complete pagination", () => {
  const lost = {execution:{id:runId,status:"running",organizationId},waitState:"observation_lost",
    latestSequence:423,hasMoreEvents:false,
    automation:{phase:"observation_lost",retryable:false,code:"WORKFLOW_CONTINUATION_OBSERVATION_LOST"}};
  for (const automation of [{...lost.automation,phase:"other"},{...lost.automation,retryable:true},
    {...lost.automation,retryable:"false"}]) {
    const output=runSummary("runs.wait",{...lost,automation});
    assert.equal(output?.observationIssue,undefined);
    assert.equal(output?.stateNeedsVerification,true);
  }
  for (const flag of [undefined,null,"false",0]) {
    const output=runSummary("runs.wait",{...lost,hasMoreEvents:flag as any});
    assert.equal(output?.observationIssue,undefined);
    assert.equal(output?.stateNeedsVerification,true);
  }
  const healthy=runSummary("runs.wait",{...lost,waitState:"automated_progress"});
  assert.equal(healthy?.observationIssue,undefined);
  assert.deepEqual(healthy?.nextAction,{tool:"loomex_run_wait",arguments:{runId,timeoutSeconds:30,afterSequence:423}});
});

test("lost observation requires explicit complete event pagination", () => {
  const base = { execution: { id: runId, status: "waiting", organizationId },
    waitState: "observation_lost", latestSequence: 423, events: [{ sequence: 420 }] };
  for (const flag of [undefined, null, "false", 0]) {
    const output = runSummary("runs.wait", { ...base, ...(flag === undefined ? {} : { hasMoreEvents: flag }) });
    assert.equal(output?.nextAction, undefined);
    assert.equal(output?.observationIssue, undefined);
    assert.equal(output?.stateNeedsVerification, true);
    assert.deepEqual(output?.monitoring, monitoringContract({ state: "needs_attention" }));
  }
  const complete = runSummary("runs.wait", { ...base, hasMoreEvents: false });
  assert.equal((complete?.observationIssue as { code: string }).code, "RUNNER_OBSERVATION_LOST");
});

test("unknown wait states and arbitrary automation content cannot reach chat", () => {
  const output = runSummary("runs.get", { execution: { id: runId, status: "running", organizationId },
    latestSequence: 8, waitState: "private provider prompt", automation: { phase: "observation_lost",
      message: "private stderr" } });
  assert.equal(output?.waitState, undefined);
  assert.equal(output?.observationIssue, undefined);
  assert.deepEqual(output?.nextAction, { tool: "loomex_run_wait", arguments: { runId, timeoutSeconds: 30, afterSequence: 8 } });
  assert.doesNotMatch(JSON.stringify(output), /private provider prompt|private stderr/);
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

test("progress preview is bounded, deduplicated and leaves the event cursor intact", () => {
  const events = Array.from({ length: 20 }, (_, index) => ({
    eventType: "ai.progress.v1", sequence: index + 1,
    payload: { eventId: `event-${index}`, nodeExecutionId: requestId, kind: "tool.updated",
      summary: "private prompt and stderr", command: "private command", timestamp: 1000 + index },
  }));
  events.push({ eventType: "ai.progress.v1", sequence: 21, payload: {
    eventId: "event-19", nodeExecutionId: requestId, kind: "tool.updated",
    summary: "private prompt and stderr", command: "private command", timestamp: 1019,
  } });
  const result = runSummary("runs.events", {
    execution: { id: runId, status: "running", organizationId }, latestSequence: 100,
    hasMoreEvents: true, events,
    progress: { version: 1, elapsedSeconds: 80, waitState: "running", activeNodes: [
      { nodeExecutionId: requestId, nodeName: "Build", elapsedSeconds: 80, lastActivity: {
        kind: "tool.updated", summary: "private prompt", timestamp: 1019,
      } },
    ], latestActivity: { kind: "tool.updated", summary: "private prompt", timestamp: 1019 } },
  });
  const preview = result?.progressEvents as Array<Record<string, unknown>>;
  assert.equal(preview.length, 8);
  assert.equal(result?.progressEventPageCount, 20);
  assert.equal(result?.progressEventsTruncated, true);
  assert.deepEqual(preview[7], { kind: "tool.updated", summary: "Provider is using a tool",
    sequence: 20, timestamp: 1019, nodeExecutionId: requestId, nodeName: "Build" });
  assert.deepEqual(result?.nextAction, { tool: "loomex_run_events", arguments: { runId, afterSequence: 21 } });
  assert.equal((result?.progress as any).elapsedSeconds, 80);
  assert.equal((result?.progress as any).latestActivity.summary, "Provider is using a tool");
  assert.ok(JSON.stringify(result).length < 4000);
  assert.doesNotMatch(JSON.stringify(result), /private prompt|private command|stderr/);
});

test("unknown progress payloads never become activity previews", () => {
  const result = runSummary("runs.get", { execution: { id: runId, status: "running", organizationId },
    events: [
      { eventType: "workflow_runtime.node.started", sequence: 1, payload: { kind: "tool.started", summary: "private" } },
      { eventType: "ai.progress.v1", sequence: 2, payload: { eventId: "bad", kind: "arbitrary", summary: "private" } },
    ], progress: { version: 1, activeNodes: [], latestActivity: { kind: "arbitrary", summary: "private" } },
  });
  assert.deepEqual(result?.progressEvents, []);
  assert.equal((result?.progress as any).latestActivity, null);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test("out-of-order progress is previewed by sequence without trusting payload labels", () => {
  const event = (sequence: number) => ({ eventType: "ai.progress.v1", sequence,
    payload: { eventId: `event-${sequence}`, nodeExecutionId: requestId,
      nodeName: "private payload label", kind: "activity.updated", summary: "private model text", timestamp: sequence } });
  const result = runSummary("runs.events", { execution: { id: runId, status: "running", organizationId },
    latestSequence: 3, hasMoreEvents: false, events: [event(3), event(1), event(2)],
    progress: { version: 1, activeNodes: [{ nodeExecutionId: requestId, nodeName: "Build" }] },
  });
  assert.deepEqual((result?.progressEvents as Array<{ sequence: number }>).map((item) => item.sequence), [1, 2, 3]);
  assert.deepEqual((result?.progressEvents as Array<{ nodeName: string }>).map((item) => item.nodeName), ["Build", "Build", "Build"]);
  assert.equal(result?.progressEventsTruncated, false);
  assert.doesNotMatch(JSON.stringify(result), /private payload label|private model text/);
});

test("AI public status stays separate from fixed activity and preserves the event cursor", () => {
  const publicStatus = (sequence: number, eventId = `status-${sequence}`) => ({
    eventType: "ai.public-status.v1", sequence,
    payload: { version: 1, eventId, jobId: runId, nodeExecutionId: requestId,
      attempt: 2, timestamp: 1000 + sequence, provenance: "ai_reported",
      text: "Reviewing [changes](https://example.test) *now*", summary: "private provider output" },
  });
  const result = runSummary("runs.events", {
    execution: { id: runId, status: "running", organizationId },
    events: [{ eventType: "ai.progress.v1", sequence: 2,
      payload: { eventId: "fixed-2", nodeExecutionId: requestId, kind: "tool.updated",
        timestamp: 1002, summary: "private tool args" } }, publicStatus(3), publicStatus(4), publicStatus(5, "status-3")],
    latestSequence: 7, hasMoreEvents: true,
    progress: { version: 1, activeNodes: [{ nodeExecutionId: requestId, nodeName: "Build",
      waitState: "processing_result", lastActivity: { kind: "activity.completed", timestamp: 1000 } }] },
  });
  assert.deepEqual((result?.progressEvents as Array<{ sequence: number }>).map(item => item.sequence), [2]);
  const statuses = result?.publicStatusEvents as Array<Record<string, unknown>>;
  assert.deepEqual(statuses.map(item => item.sequence), [3, 4]);
  assert.equal(result?.publicStatusEventPageCount, 2);
  const first = statuses[0];
  assert.ok(first);
  assert.equal(first.nodeName, "Build");
  assert.equal(first.provenance, "ai_reported");
  assert.equal(first.trust, "untrusted_display_only");
  assert.equal(first.text, "Reviewing \\[changes\\]\\(https\\:\\/\\/example\\.test\\) \\*now\\*");
  assert.equal((result?.progress as any).activeNodes[0].waitState, "processing_result");
  assert.deepEqual(result?.nextAction, { tool: "loomex_run_events", arguments: { runId, afterSequence: 5 } });
  assert.doesNotMatch(JSON.stringify(result), /private provider output|private tool args/);
});

test("malformed and oversized public status is omitted while valid status remains bounded", () => {
  const valid = Array.from({ length: 12 }, (_, index) => ({ eventType: "ai.public-status.v1", sequence: index + 1,
    payload: { version: 1, eventId: `event-${index}`, jobId: runId, nodeExecutionId: requestId,
      attempt: 1, timestamp: index + 1, text: `Step ${index}`, provenance: "ai_reported" } }));
  const invalid = [
    { version: 1, eventId: "wrong-provenance", jobId: runId, nodeExecutionId: requestId,
      attempt: 1, timestamp: 1, text: "private", provenance: "verified" },
    { version: 1, eventId: "multiline", jobId: runId, nodeExecutionId: requestId,
      attempt: 1, timestamp: 1, text: "private\ntext", provenance: "ai_reported" },
    { version: 1, eventId: "oversized", jobId: runId, nodeExecutionId: requestId,
      attempt: 1, timestamp: 1, text: "private".repeat(41), provenance: "ai_reported" },
    { version: 1, eventId: "invalid id", jobId: runId, nodeExecutionId: requestId,
      attempt: 1, timestamp: 1, text: "private", provenance: "ai_reported" },
    { version: 1, eventId: "x".repeat(221), jobId: runId, nodeExecutionId: requestId,
      attempt: 1, timestamp: 1, text: "private", provenance: "ai_reported" },
  ].map((payload, index) => ({ eventType: "ai.public-status.v1", sequence: 13 + index, payload }));
  const result = runSummary("runs.get", { execution: { id: runId, status: "running", organizationId },
    events: [...valid, ...invalid], latestSequence: 20, hasMoreEvents: true,
    progress: { version: 1, activeNodes: [] } });
  assert.equal(result?.publicStatusEventPageCount, 12);
  assert.equal((result?.publicStatusEvents as unknown[]).length, 8);
  assert.equal(result?.publicStatusEventsTruncated, true);
  assert.deepEqual(result?.nextAction, { tool: "loomex_run_events", arguments: { runId, afterSequence: 17 } });
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test("backend milestones use fixed copy and never infer draft persistence from names", () => {
  const events = [
    { eventType: "workflow_runtime.node.started", sequence: 1,
      milestone: { kind: "node.started", summary: "private prompt", nodeExecutionId: requestId,
        nodeName: "Validate [link](https://example.test)", timestamp: "2026-09-26T10:00:00Z" } },
    { eventType: "workflow_runtime.node.completed", sequence: 2,
      milestone: { kind: "draft.saved", summary: "private output", nodeExecutionId: requestId,
        nodeName: "Save Draft", timestamp: "2026-09-26T10:01:00Z" } },
    { eventType: "workflow_runtime.node.started", sequence: 3,
      payload: { nodeName: "Save Draft", summary: "private draft claim" } },
    { eventType: "ai.public-status.v1", sequence: 4,
      payload: { version: 1, eventId: "ai:4", jobId: runId, nodeExecutionId: requestId,
        attempt: 1, timestamp: 4, text: "Draft saved", provenance: "ai_reported" } },
    { eventType: "workflow_runtime.node.started", sequence: 5,
      milestone: { kind: "draft.saved", summary: "private forged milestone", nodeExecutionId: requestId } },
    { eventType: "workflow_runtime.draft.validation_started", sequence: 6,
      milestone: { kind: "draft.validation_started", summary: "private validation prompt",
        nodeExecutionId: requestId, nodeName: "Validate", timestamp: "2026-09-26T10:02:00Z" } },
    { eventType: "workflow_runtime.draft.validation_passed", sequence: 7,
      milestone: { kind: "draft.validation_passed", summary: "private validation output",
        nodeExecutionId: requestId, nodeName: "Validate", timestamp: "2026-09-26T10:03:00Z" } },
    { eventType: "workflow_runtime.node.started", sequence: 8,
      milestone: { kind: "draft.repair_started", summary: "private false repair",
        nodeExecutionId: requestId, nodeName: "Designer", timestamp: "2026-09-26T10:04:00Z" } },
    { eventType: "workflow_runtime.draft.repair_branch_selected", sequence: 9,
      milestone: { kind: "draft.repair_started", summary: "private branch detail",
        nodeExecutionId: requestId, nodeName: "Repair gate", timestamp: "2026-09-26T10:05:00Z" } },
    { eventType: "workflow_runtime.draft.validation_started", sequence: 10,
      milestone: { kind: "draft.validation_started", summary: "private unbound validation",
        nodeExecutionId: null, nodeName: null, timestamp: "2026-09-26T10:06:00Z" } },
  ];
  const result = runSummary("runs.events", { execution: { id: runId, status: "running", organizationId },
    events, latestSequence: 10, hasMoreEvents: false });
  const milestones = result?.milestoneEvents as Array<Record<string, unknown>>;
  assert.deepEqual(milestones.map(item => item.kind), ["node.started", "draft.saved", "draft.validation_started", "draft.validation_passed", "draft.repair_started"]);
  assert.deepEqual(milestones.map(item => item.summary), ["Workflow step started", "Draft saved", "Draft validation started", "Draft validation passed", "Workflow repair started"]);
  assert.equal(milestones[1]?.provenance, "backend_verified");
  assert.equal(milestones[1]?.timestamp, "2026-09-26T10:01:00Z");
  assert.equal(milestones[0]?.nodeName, "Validate \\[link\\]\\(https\\:\\/\\/example\\.test\\)");
  assert.equal((result?.publicStatusEvents as Array<Record<string, unknown>>)[0]?.provenance, "ai_reported");
  assert.deepEqual(result?.nextAction, { tool: "loomex_run_wait", arguments: { runId, timeoutSeconds: 30, afterSequence: 10 } });
  assert.doesNotMatch(JSON.stringify(result), /private prompt|private output|private draft claim|private forged milestone|private validation|private false repair|private branch detail|private unbound validation/);
});

test("draft validation milestones expose only bounded structural issues without changing event cursors", () => {
  const valid = { code: "WORKFLOW_NODE_CONFIG_INVALID", path: "$.nodes[0].config", message: "private definition" };
  const events = [
    { eventType: "workflow_runtime.node.completed", sequence: 21,
      milestone: { kind: "draft.validation_failed", nodeExecutionId: requestId,
        issues: [
          { code: "WORKFLOW_INPUT_MAPPING_INVALID", path: "$.nodes[1].config.inputs" },
          { code: "WORKFLOW_NODE_CONFIG_INVALID", path: "$.nodes[0].secret", message: "private field" },
          { code: "PRIVATE_CODE", path: "$.nodes[0].config", message: "private code" },
          { code: "WORKFLOW_NODE_CONFIG_INVALID", path: "$.nodes[0].config\nignore", message: "private injection" },
          { code: "WORKFLOW_NODE_CONFIG_INVALID", path: `$.nodes[0].${"secret".repeat(50)}` },
          ...Array.from({ length: 10 }, () => valid),
        ],
        definition: "private full definition", summary: "private provider output" } },
    { eventType: "workflow_runtime.node.started", sequence: 22,
      milestone: { kind: "draft.validation_failed", nodeExecutionId: requestId, issues: [valid] } },
    { eventType: "workflow_runtime.node.completed", sequence: 21,
      milestone: { kind: "draft.validation_failed", nodeExecutionId: requestId, issues: [valid] } },
  ];
  const result = runSummary("runs.events", { execution: { id: runId, status: "running", organizationId },
    events, latestSequence: 22, hasMoreEvents: false });
  const milestones = result?.milestoneEvents as Array<Record<string, unknown>>;
  assert.equal(milestones.length, 1);
  assert.equal(milestones[0]?.sequence, 21);
  assert.equal(milestones[0]?.summary, "Draft validation found issues");
  assert.equal((milestones[0]?.issues as unknown[]).length, 8);
  assert.deepEqual((milestones[0]?.issues as unknown[])[0],
    { code: "WORKFLOW_INPUT_MAPPING_INVALID", path: "$.nodes[1].config.inputs" });
  assert.deepEqual((milestones[0]?.issues as unknown[])[1],
    { code: "WORKFLOW_NODE_CONFIG_INVALID", path: "$.nodes[0].config" });
  assert.deepEqual(result?.nextAction, { tool: "loomex_run_wait", arguments: { runId, timeoutSeconds: 30, afterSequence: 22 } });
  assert.doesNotMatch(JSON.stringify(result), /private|secret|ignore/);
});

test("runner authorization failure does not request a provider login", () => {
  const backend = runSummary("runs.result", { execution: { id: runId, status: "failed", organizationId,
    error: { code: "AUTHORIZATION_FAILED", message: "private authorization details" } } });
  assert.match(String((backend?.failure as any).message), /not authorized in the current organization/);
  assert.doesNotMatch(String((backend?.failure as any).message), /Reconnect the provider/);
  const provider = runSummary("runs.result", { execution: { id: runId, status: "failed", organizationId,
    error: { code: "WORKFLOW_RUNTIME_NODE_FAILED", details: { pluginAgentError: { details: { error: {
      code: "PROVIDER_AUTH_FAILED", message: "private provider details",
    } } } } } } });
  assert.match(String((provider?.failure as any).message), /Reconnect the provider/);
});

test("terminal failure categories distinguish runner outcome, artifact delivery, and authentication", () => {
  const nested = (code: string) => runSummary("runs.result", {
    execution: { id: runId, status: "failed", organizationId,
      error: { code: "WORKFLOW_RUNTIME_NODE_FAILED", message: "private stderr",
        details: { pluginAgentError: { details: { error: { code, provider: "codex", model: "private model",
          message: "private prompt", rawOutput: "private output" } } } } } },
  })?.failure as { code: string; category: string; message: string };
  for (const code of ["RUNNER_OPERATION_INDETERMINATE", "RUNNER_LEASE_INDETERMINATE",
    "RUNNER_CANCELLATION_INDETERMINATE", "EXECUTION_INDETERMINATE", "HTTP_REQUEST_INDETERMINATE"]) {
    const failure = nested(code);
    assert.equal(failure.code, code);
    assert.equal(failure.category, "runner_outcome_indeterminate");
    assert.match(failure.message, /outcome could not be confirmed/);
    assert.doesNotMatch(failure.message, /start a new run|Reconnect the provider/);
    assert.doesNotMatch(JSON.stringify(failure), /private stderr|private prompt|private output/);
  }
  assert.equal(nested("ARTIFACT_FINALIZATION_FAILED").category, "artifact_delivery");
  assert.match(nested("ARTIFACT_FINALIZATION_FAILED").message, /output delivery/);
  for (const code of ["RUNNER_PROOF_INVALID", "RUNNER_PROOF_STALE", "RUNNER_TOKEN_INVALID"]) {
    assert.equal(nested(code).category, "runner_authority");
    assert.doesNotMatch(nested(code).message, /Reconnect the provider/);
  }
  assert.equal(nested("PROVIDER_AUTH_FAILED").category, "provider_authentication");
  assert.equal(nested("PROVIDER_EXECUTION_FAILED").category, "provider_failure");
  assert.equal(nested("AUTHORIZATION_FAILED").category, "workflow_authorization");
  assert.doesNotMatch(JSON.stringify(nested("RUNNER_OPERATION_INDETERMINATE")), /private stderr|private prompt|private output/);
});

test("an attempted draft save never becomes a persistence claim in a run summary", () => {
  const output = runSummary("runs.get", { execution: { id: runId, status: "waiting", organizationId,
    currentNodeName: "Save Draft" }, latestSequence: 23, hasMoreEvents: false,
    events: [{ sequence: 23, eventType: "workflow_runtime.node.completed", payload: {
      status: "validation_failed", draft: "private unsaved design" } }],
    progress: { version: 1, activeNodes: [], latestActivity: null } });
  assert.equal((output?.execution as { currentNodeName: string }).currentNodeName, "Save Draft");
  assert.equal(output?.savedDraft, undefined);
  assert.doesNotMatch(JSON.stringify(output), /private unsaved design|draft saved/i);
});


test("monitoring observations stay bounded, categorical, and private", () => {
  const records = Array.from({length: 10}, (_, i) => ({
    binding: {hostId:"codex",hostSessionId:`session-${i}`,hostTaskId:`task-${i}`,kind:"host_session_unverified_task",verifiedHostTask:false},
    lifecycle:"active",hookCount:0,hostHookObserved:false,activationState:"hook_not_observed",requiredAction:"wait",privatePrompt:"must-not-appear",
  }));
  const input = {execution:{id:runId,status:"running",organizationId}, details:{monitoring:{schemaVersion:"loomex.monitoring-observation/v1",runId,
    follow:{records,recordCount:10,hookDiagnostics:{records:[
      {event:"UserPromptSubmit",outcome:"accepted",code:"CONTINUATION_RECEIVED",observedAt:9,privatePayload:"must-not-appear"},
      {event:"PostToolUse",outcome:"rejected",code:"TOOL_ASSOCIATION_REJECTED",observedAt:8},
      {event:"PostToolUse",outcome:"rejected",code:"RUNNER_INTERNAL_ERROR",observedAt:7},
    ]}},
    recovery:{records:[{binding:{hostId:"codex",hostTaskId:"task-private"},registrationState:"registered",recordedLifecycle:"verified",automationIdRecorded:true,hostEvidenceRecorded:true}]},
  }}};
  const output = runSummary("runs.get",input);
  const evidence = output?.monitoringEvidence as {guarantee:string;follow:{records:Array<{activation:string;binding:{kind:string}}>;truncated:boolean;hookDiagnostics:{records:Array<{classification:string}>}};recovery:{records:Array<{bindingRecorded:boolean}>}};
  assert.equal(evidence.guarantee,"none");
  assert.equal(evidence.follow.records.length,3);
  assert.equal(evidence.follow.truncated,true);
  assert.deepEqual(evidence.follow.records[0], {binding:{kind:"host_session_unverified_task",verifiedHostTask:false},activation:"hook_not_observed",hookObserved:false,lifecycle:"active",requiredAction:"wait"});
  assert.deepEqual(evidence.follow.hookDiagnostics.records.map((row) => row.classification), ["runner_accepted","payload_or_association_rejected","runner_error"]);
  assert.deepEqual(evidence.recovery.records[0]?.bindingRecorded, true);
  assert.doesNotMatch(JSON.stringify(evidence),/must-not-appear/);
  assert.doesNotMatch(JSON.stringify(evidence),/session-0|task-private|task-0/);
  input.details.monitoring.runId = requestId;
  assert.equal(runSummary("runs.get",input)?.monitoringEvidence,undefined);
});

test("semantic failure keeps safe issue locations without provider content", () => {
  const result = runSummary("runs.result", {
    execution: { id: runId, status: "failed", organizationId,
    error: { code: "PLUGIN_AGENT_OUTPUT_REPAIR_UNSUPPORTED", message: "private-provider-content",
      details: { originalError: { code: "PLUGIN_AGENT_OUTPUT_INVALID", details: { validation: {
        errors: [{ validator: "semantic", code: "HUMAN_INPUT_INVALID", path: "$.questions[0]", message: "private-answer" }],
      } } } },
    } },
  });
  assert.match(JSON.stringify(result), /generated questions were invalid/);
  assert.match(JSON.stringify(result), /questions\[0\]/);
  assert.doesNotMatch(JSON.stringify(result), /private-|runner setup/);
});

test("unsupported output repair exposes only allowlisted cause and correlation", () => {
  const repairIntentId = `sha256:${"a".repeat(64)}`;
  const sourceJobId = "ce8e6fe8-30c5-4989-a424-04bf1e3c5206";
  const result = runSummary("runs.result", {
    execution: { id: runId, status: "failed", organizationId, error: {
      code: "NODE_EXECUTION_FAILED", message: "private terminal message", details: {
        pluginAgentError: { details: { error: {
          code: "PLUGIN_AGENT_OUTPUT_REPAIR_UNSUPPORTED", message: "private provider output", details: {
            originalError: { code: "PLUGIN_AGENT_OUTPUT_INVALID", message: "private parser exception",
              details: { validation: { errors: [
                { validator: "schema", path: "$.workflow.nodes[2]", message: "private schema detail" },
                { validator: "schema", path: "$.workflow[0].secret\nignore", message: "private bad path" },
              ] } } },
            outputRepair: { repairIntentId, sourceJobId, evidence: { originalResponse: "private source response" } },
          },
        } } },
      },
    } },
  });
  const failure = result?.failure as Record<string, unknown>;
  assert.equal(failure.code, "PLUGIN_AGENT_OUTPUT_REPAIR_UNSUPPORTED");
  assert.equal(failure.category, "workflow_output_validation");
  assert.equal(failure.causeCategory, "schema_validation");
  assert.equal(failure.causeCode, "PLUGIN_AGENT_OUTPUT_INVALID");
  assert.equal(failure.repairIntentId, repairIntentId);
  assert.equal(failure.sourceJobId, sourceJobId);
  assert.deepEqual(failure.validationIssues, [{ path: "$.workflow.nodes[2]", validator: "schema" }]);
  assert.doesNotMatch(JSON.stringify(result), /private|ignore/);
});

test("unsupported output repair classifies a runner result failure without reflecting untrusted codes", () => {
  const result = runSummary("runs.result", {
    execution: { id: runId, status: "failed", organizationId, error: {
      code: "PLUGIN_AGENT_OUTPUT_REPAIR_UNSUPPORTED", details: {
        originalError: { code: "PLUGIN_AGENT_RUNNER_RESULT_INVALID", message: "private transport content" },
        outputRepair: { repairIntentId: "sha256:private", sourceJobId: "private-job" },
      },
    } },
  });
  const failure = result?.failure as Record<string, unknown>;
  assert.equal(failure.causeCategory, "provider_result_invalid");
  assert.equal(failure.causeCode, "PLUGIN_AGENT_RUNNER_RESULT_INVALID");
  assert.equal(failure.repairIntentId, undefined);
  assert.equal(failure.sourceJobId, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test("JSON Schema output failures retain bounded validator and field paths", () => {
  const result = runSummary("runs.result", {
    execution: { id: runId, status: "failed", organizationId, error: {
      code: "PLUGIN_AGENT_OUTPUT_REPAIR_UNSUPPORTED", details: {
        originalError: { code: "PLUGIN_AGENT_OUTPUT_INVALID", details: { validation: { errors: [
          { validator: "required", path: "", message: "private missing required name" },
          { validator: "type", path: "workflow.nodes.2.config", message: "private wrong value" },
          { validator: "additionalProperties", path: "workflow.nodes.2", message: "private extra field" },
          { validator: "private-validator", path: "workflow.nodes.2", message: "private arbitrary code" },
          { validator: "required", path: "$.workflow[0].secret\nignore", message: "private injected path" },
          { validator: "required", path: `workflow.${"secret".repeat(50)}`, message: "private oversized path" },
        ] } } },
      },
    } },
  });
  const failure = result?.failure as Record<string, unknown>;
  assert.equal(failure.causeCategory, "schema_validation");
  assert.deepEqual(failure.validationIssues, [
    { path: "$", validator: "required" },
    { path: "$.workflow.nodes[2].config", validator: "type" },
    { path: "$.workflow.nodes[2]", validator: "additionalProperties" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private|ignore|secret/);
});

test("output-validation paths stop before arbitrary property and credential names", () => {
  const result = runSummary("runs.result", {
    execution: { id: runId, status: "failed", organizationId, error: {
      code: "PLUGIN_AGENT_OUTPUT_REPAIR_UNSUPPORTED", details: {
        originalError: { code: "PLUGIN_AGENT_OUTPUT_INVALID", details: { validation: { errors: [
          { validator: "type", path: "definition" },
          { validator: "required", path: "$.workflow.nodes[2].api_key" },
          { validator: "additionalProperties", path: "definition.nodes.3.config.secret" },
          { validator: "semantic", code: "HUMAN_INPUT_INVALID", path: "$.questions[0].password" },
          { validator: "type", path: "$.credential_token" },
        ] } } },
      },
    } },
  });
  const failure = result?.failure as Record<string, unknown>;
  assert.deepEqual(failure.validationIssues, [
    { path: "$.definition", validator: "type" },
    { path: "$.workflow.nodes[2]", validator: "required" },
    { path: "$.definition.nodes[3].config", validator: "additionalProperties" },
    { path: "$.questions[0]", validator: "semantic", code: "HUMAN_INPUT_INVALID" },
    { path: "$", validator: "type" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /api_key|secret|password|credential_token/);
});


test("public status draft issues retain only fixed codes and structural paths", () => {
  const output=runSummary("runs.events",{execution:{id:runId,status:"running",organizationId},
    events:[{eventType:"workflow_runtime.node.completed",sequence:27,milestone:{kind:"draft.validation_failed",
      nodeExecutionId:requestId,issues:[
        {code:"WORKFLOW_PUBLIC_STATUS_INVALID",path:"$.nodes[2].config.publicStatus",message:"private malformed definition"},
        {code:"WORKFLOW_PUBLIC_STATUS_INVALID",path:"$.nodes[2].config.publicStatus.private",message:"private property"},
        {code:"WORKFLOW_PUBLIC_STATUS_INVALID",path:"$.nodes[2].config.arbitrary",message:"private property"},
        {code:"PRIVATE_CODE",path:"$.nodes[2].config.publicStatus"},
      ]}}],latestSequence:27,hasMoreEvents:false});
  assert.deepEqual((output?.milestoneEvents as Array<any>)[0].issues,
    [{code:"WORKFLOW_PUBLIC_STATUS_INVALID",path:"$.nodes[2].config.publicStatus"}]);
  assert.doesNotMatch(JSON.stringify(output),/private|arbitrary|PRIVATE_CODE/);
  assert.deepEqual(output?.nextAction,{tool:"loomex_run_wait",arguments:{runId,timeoutSeconds:30,afterSequence:27}});
});

test("continuation recovery projects only safe exact-run identity after blocked observation", () => {
  const recovery = { schemaVersion: "loomex.continuation-recovery/v1", executionId: runId,
    deliveryId: requestId, continuationDigest: "a".repeat(64), checkpoint: "private checkpoint", answer: "private answer" };
  const lost = { execution: { id: runId, status: "running", organizationId }, waitState: "observation_lost",
    latestSequence: 423, hasMoreEvents: false, automation: { phase: "observation_lost", retryable: false,
      code: "WORKFLOW_CONTINUATION_OBSERVATION_LOST", recovery } };
  const output = runSummary("runs.get", lost);
  assert.deepEqual(output?.continuationRecovery, { schemaVersion: recovery.schemaVersion, executionId: runId,
    deliveryId: requestId, continuationDigest: recovery.continuationDigest, requiresExplicitUserAuthorization: true });
  assert.equal(output?.nextAction, undefined);
  assert.doesNotMatch(JSON.stringify(output), /private checkpoint|private answer|loomex_run_continuation_requeue/);
  for (const invalid of [{ ...recovery, executionId: requestId }, { ...recovery, deliveryId: "invalid" },
    { ...recovery, continuationDigest: "A".repeat(64) }, { ...recovery, schemaVersion: "other" }]) {
    assert.equal(runSummary("runs.get", { ...lost, automation: { ...lost.automation, recovery: invalid } })?.continuationRecovery, undefined);
  }
  for (const state of [{ ...lost, events: [{ sequence: 422 }], hasMoreEvents: true },
    { ...lost, humanRequest: data.humanRequest }, { ...lost, execution: { ...lost.execution, status: "completed" } },
    { ...lost, execution: { id: runId, status: "running" } }, { ...lost, waitState: "automated_progress" }]) {
    assert.equal(runSummary("runs.get", state)?.continuationRecovery, undefined);
  }
});
