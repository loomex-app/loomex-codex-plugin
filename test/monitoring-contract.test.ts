import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { runSummary } from "../src/run-summary.js";
import { MONITORING_CONTRACT_VERSION, RECOVERY_CADENCE, RECOVERY_MARKER_TEMPLATE } from "../src/monitoring-contract.js";
import { checkMonitoringTranscript, type TranscriptEntry } from "./monitoring-transcript.js";

const runId = "adc7b3ba-1979-47d2-ac14-638ed91c5f82";
const requestA = "8081f734-5175-492b-b412-b1d88d8e3a7d";
const requestB = "8e313122-4210-4d2a-a163-bd86a30016af";
const organizationId = "dd6244ea-2f21-48bd-a9da-4d2ac161882a";

function summarize(method: string, data: Record<string, unknown>) {
  const execution = data.execution && typeof data.execution === "object" && !Array.isArray(data.execution)
    ? { ...(data.execution as Record<string, unknown>), organizationId }
    : data.execution;
  const humanRequest = data.humanRequest && typeof data.humanRequest === "object" && !Array.isArray(data.humanRequest)
    ? {
      ...(data.humanRequest as Record<string, unknown>), organizationId,
      execution: {
        ...((data.humanRequest as { execution?: Record<string, unknown> }).execution ?? {}),
        organizationId,
      },
    }
    : data.humanRequest;
  return runSummary(method, { ...data, ...(execution === undefined ? {} : { execution }), ...(humanRequest === undefined ? {} : { humanRequest }) } as never);
}

function projection(method: string, data: Record<string, unknown>): TranscriptEntry {
  const summary = summarize(method, data);
  assert.ok(summary, `${method} should produce a projection`);
  assert.ok(["runs.get", "runs.wait", "runs.events"].includes(method), `unsupported monitoring projection method: ${method}`);
  return { kind: "projection", method: method as "runs.get" | "runs.wait" | "runs.events", projection: summary as never };
}

function action(summary: ReturnType<typeof runSummary>): Extract<TranscriptEntry, { kind: "tool" }> {
  const next = summary?.nextAction as { tool?: string; arguments?: Record<string, unknown> } | undefined;
  assert.ok(next?.tool, "projection must expose a next action");
  return next.arguments === undefined
    ? { kind: "tool", name: next.tool }
    : { kind: "tool", name: next.tool, arguments: next.arguments };
}

test("controlled follow sequence drains event cursors, survives quiet waits, then presents one request", () => {
  const transcript: TranscriptEntry[] = [{ kind: "follow", runId, taskId: "task", trigger: "run_started" }];
  const first = {
    execution: { id: runId, status: "running" },
    events: [{ sequence: 4 }], latestSequence: 5, hasMoreEvents: true,
  };
  transcript.push(projection("runs.get", first));
  transcript.push(action(summarize("runs.get", first)));

  const drained = {
    execution: { id: runId, status: "running" },
    events: [{ sequence: 5 }], latestSequence: 5, hasMoreEvents: false,
  };
  transcript.push(projection("runs.events", drained));
  transcript.push({ kind: "tool", name: "loomex_recovery_get", result: { found: false } });
  transcript.push({ kind: "tool", name: "loomex_recovery_update", result: { recovery: { registrationState: "not_attempted" } } });
  transcript.push({ kind: "tool", name: "loomex_recovery_operation_begin", result: { recovery: { registrationState: "attempt_in_flight" }, operation: { kind: "create" }, attemptPermitted: true } });
  transcript.push({ kind: "tool", name: "automation_update", arguments: { mode: "create" }, result: {
    id: "automation-1", kind: "heartbeat", marker: `loomex-follow-recovery:task:${runId}`, status: "ACTIVE",
  } });
  transcript.push({ kind: "tool", name: "loomex_recovery_operation_settle", result: { recovery: { registrationState: "registered", automationId: "automation-1" }, operation: { status: "succeeded" } } });
  transcript.push({ kind: "tool", name: "automation_update", arguments: { mode: "view", id: "automation-1" }, result: {
    id: "automation-1", kind: "heartbeat", marker: `loomex-follow-recovery:task:${runId}`, status: "ACTIVE", targetThreadId: "task",
    prompt: `Exact marker: loomex-follow-recovery:task:${runId}`, rrule: "FREQ=MINUTELY;INTERVAL=2",
  } });
  const waitAction = action(summarize("runs.events", drained));
  transcript.push(waitAction);
  assert.equal(waitAction.name, "loomex_run_wait");
  assert.deepEqual(waitAction.arguments, { runId, timeoutSeconds: 30, afterSequence: 5 });

  const quiet = { ...drained, timedOut: true };
  for (let count = 0; count < 4; count += 1) {
    transcript.push(projection("runs.wait", quiet));
    const quietAction = action(summarize("runs.wait", quiet));
    transcript.push(quietAction);
    assert.equal(quietAction.name, "loomex_run_wait");
    assert.deepEqual(quietAction.arguments, { runId, timeoutSeconds: 30, afterSequence: 5 });
  }

  const pending = {
    execution: { id: runId, status: "waiting" },
    humanRequest: { id: requestA, status: "pending", execution: { id: runId } },
    waitState: "human_action_required",
  };
  transcript.push(projection("runs.wait", pending));
  const questionAction = action(summarize("runs.wait", pending));
  transcript.push(questionAction);
  assert.equal(questionAction.name, "loomex_interaction_view");
  assert.deepEqual(questionAction.arguments, { requestId: requestA });
  assert.deepEqual(transcript.filter((entry) => entry.kind === "tool").map((entry) => entry.name), [
    "loomex_run_events", "loomex_recovery_get", "loomex_recovery_update", "loomex_recovery_operation_begin", "automation_update", "loomex_recovery_operation_settle", "automation_update", "loomex_run_wait", "loomex_run_wait", "loomex_run_wait", "loomex_run_wait", "loomex_run_wait", "loomex_interaction_view",
  ]);
  assert.equal(transcript.findIndex((entry) => entry.kind === "tool" && entry.name === "automation_update") <
    transcript.findIndex((entry) => entry.kind === "tool" && entry.name === "loomex_run_wait"), true,
    "recovery initialization follows event-page draining and precedes serial waits");
});

test("accepted answer invalidates the old request and fresh state alone can present a new request", () => {
  const accepted: TranscriptEntry[] = [{ kind: "follow", runId, taskId: "task", trigger: "interaction_accepted", knownAutomationId: "automation-1" }];
  const pending = { execution: { id: runId, status: "waiting" }, humanRequest: { id: requestA, status: "pending", execution: { id: runId } } };
  accepted.push(projection("runs.wait", pending));
  accepted.push(action(summarize("runs.wait", pending)));
  accepted.push({ kind: "tool", name: "loomex_interaction_respond", arguments: { requestId: requestA, answer: { value: "approved" } } });

  const freshActive = { execution: { id: runId, status: "running" }, latestSequence: 7, hasMoreEvents: false };
  accepted.push(projection("runs.get", freshActive));
  const resume = action(summarize("runs.get", freshActive));
  accepted.push(resume);
  assert.equal(resume.name, "loomex_run_wait");
  assert.equal(accepted.filter((entry) => entry.kind === "tool" && entry.name === "loomex_interaction_view").length, 1);

  const newPending = { execution: { id: runId, status: "waiting" }, humanRequest: { id: requestB, status: "pending", execution: { id: runId } } };
  accepted.push(projection("runs.wait", newPending));
  const nextQuestion = action(summarize("runs.wait", newPending));
  accepted.push(nextQuestion);
  assert.deepEqual(nextQuestion.arguments, { requestId: requestB });
  assert.deepEqual(checkMonitoringTranscript(accepted), []);
});

test("accepted approvals and responses require a fresh run read and never reopen their resolved request", () => {
  const approval: TranscriptEntry[] = [
    projection("runs.wait", { execution: { id: runId, status: "waiting" }, humanRequest: { id: requestA, status: "pending", execution: { id: runId } } }),
    { kind: "tool", name: "loomex_interaction_view", arguments: { requestId: requestA } },
    { kind: "tool", name: "loomex_interaction_decide", arguments: { requestId: requestA, decision: "approve" } },
    { kind: "tool", name: "loomex_interaction_view", arguments: { requestId: requestA } },
  ];
  assert.deepEqual(checkMonitoringTranscript(approval).map((issue) => issue.code), ["stale_request_presentation"]);

  approval.push(projection("runs.get", { execution: { id: runId, status: "waiting" }, humanRequest: { id: requestA, status: "pending", execution: { id: runId } } }));
  approval.push({ kind: "tool", name: "loomex_interaction_view", arguments: { requestId: requestA } });
  assert.deepEqual(checkMonitoringTranscript(approval).map((issue) => issue.code), ["stale_request_presentation", "stale_request_presentation", "duplicate_request_presentation"]);
});

test("one-off status and advisory recovery do not become schedule evidence", () => {
  const status = summarize("runs.get", { execution: { id: runId, status: "running" } });
  assert.deepEqual(status?.monitoring, {
    contract: MONITORING_CONTRACT_VERSION,
    state: "active",
    observation: "active",
    recovery: {
      observedLifecycle: "unchecked",
      evidence: "host_schedule_not_observed",
      requiredLifecycle: "verified",
      registrationState: "ambiguous",
      requiredAction: "report_ambiguous",
      initialization: "ready_to_initialize",
      appliesTo: "explicit_follow_or_continuation",
      markerTemplate: RECOVERY_MARKER_TEMPLATE,
      cadence: RECOVERY_CADENCE,
    },
    liveFollow: { mode: "continue_when_explicit", nextAction: "authoritative_runner_action" },
  });

  const oneOff: TranscriptEntry[] = [
    { kind: "follow", runId, taskId: "task-a", trigger: "explicit_follow", knownAutomationId: "automation-1" },
    projection("runs.get", { execution: { id: runId, status: "running" } }),
    { kind: "tool", name: "loomex_run_get", arguments: { runId } },
  ];
  assert.deepEqual(checkMonitoringTranscript(oneOff), []);

  const claimedWithoutReceipt = [...oneOff, { kind: "assistant_final", text: "I will keep watching this run.", recoveryEstablished: true } satisfies TranscriptEntry];
  assert.deepEqual(checkMonitoringTranscript(claimedWithoutReceipt).map((issue) => issue.code), ["final_before_poll", "recovery_initialization_missing", "recovery_claim_unverified"]);

  const createdButUnverified = [
    ...oneOff,
    { kind: "tool", name: "automation_update", arguments: { mode: "create" }, result: { id: "automation-1", kind: "heartbeat", marker: `loomex-follow-recovery:task-a:${runId}`, status: "ACTIVE" } },
    { kind: "assistant_final", text: "Recovery is configured for this run.", recoveryEstablished: true },
  ] satisfies TranscriptEntry[];
  assert.deepEqual(checkMonitoringTranscript(createdButUnverified).map((issue) => issue.code), ["recovery_create_unpermitted", "final_before_poll", "recovery_claim_unverified"]);

  const verified = [
    ...oneOff,
    { kind: "tool", name: "automation_update", arguments: { mode: "view", id: "automation-1" }, result: {
      id: "automation-1", kind: "heartbeat", marker: `loomex-follow-recovery:task-a:${runId}`, status: "ACTIVE", targetThreadId: "task-a",
      prompt: `Exact marker: loomex-follow-recovery:task-a:${runId}`, rrule: "FREQ=MINUTELY;INTERVAL=2",
    } },
    { kind: "assistant_final", text: "Recovery is configured for this run.", recoveryEstablished: true },
  ] satisfies TranscriptEntry[];
  assert.deepEqual(checkMonitoringTranscript(verified).map((issue) => issue.code), ["final_before_poll"]);

  const wrongRunReceipt = [
    ...oneOff,
    { kind: "tool", name: "automation_update", arguments: { mode: "view", id: "automation-1" }, result: {
      id: "automation-1", kind: "heartbeat", marker: `loomex-follow-recovery:task-a:${requestB}`, status: "ACTIVE", targetThreadId: "task-a", prompt: `Exact marker: loomex-follow-recovery:task-a:${requestB}`, rrule: "FREQ=MINUTELY;INTERVAL=2",
    } },
    { kind: "assistant_final", text: "Recovery is configured for this run." },
  ] satisfies TranscriptEntry[];
  assert.deepEqual(checkMonitoringTranscript(wrongRunReceipt).map((issue) => issue.code), ["final_before_poll", "recovery_claim_unverified"]);

  const wrongTaskReceipt = [
    ...oneOff,
    { kind: "tool", name: "automation_update", arguments: { mode: "view", id: "automation-1" }, result: {
      id: "automation-1", kind: "heartbeat", marker: `loomex-follow-recovery:task-a:${runId}`, status: "ACTIVE", targetThreadId: "task-b", prompt: `Exact marker: loomex-follow-recovery:task-a:${runId}`, rrule: "FREQ=MINUTELY;INTERVAL=2",
    } },
    { kind: "assistant_final", text: "Recovery is configured for this run." },
  ] satisfies TranscriptEntry[];
  assert.deepEqual(checkMonitoringTranscript(wrongTaskReceipt).map((issue) => issue.code), ["final_before_poll", "recovery_claim_unverified"]);
});

test("transcript checker catches duplicate request cards and final answers that abandon polling", () => {
  const pending = summarize("runs.wait", {
    execution: { id: runId, status: "waiting" },
    humanRequest: { id: requestA, status: "pending", execution: { id: runId } },
  } as never);
  assert.ok(pending);
  const transcript: TranscriptEntry[] = [
    { kind: "follow", runId, taskId: "task", trigger: "explicit_follow" },
    { kind: "projection", method: "runs.wait", projection: pending as never },
    { kind: "tool", name: "loomex_interaction_view", arguments: { requestId: requestA } },
    { kind: "tool", name: "loomex_interaction_view", arguments: { requestId: requestA } },
    { kind: "projection", method: "runs.wait", projection: summarize("runs.wait", { execution: { id: runId, status: "running" } }) as never },
    { kind: "assistant_final", text: "The run is still in progress." },
  ];
  assert.deepEqual(checkMonitoringTranscript(transcript).map((issue) => issue.code), ["duplicate_request_presentation", "final_before_poll", "recovery_initialization_missing"]);
});

test("recovery verification cannot cross task/run boundaries or turn a paused heartbeat into active recovery", () => {
  const base: TranscriptEntry[] = [
    { kind: "follow", runId, taskId: "task-a", trigger: "explicit_follow", knownAutomationId: "automation-1" },
    projection("runs.get", { execution: { id: runId, status: "running" } }),
  ];
  const crossRun = [...base, {
    kind: "tool", name: "automation_update", arguments: { mode: "view", id: "automation-1" }, result: {
      id: "automation-1", kind: "heartbeat", marker: `loomex-follow-recovery:task-a:${requestB}`, status: "ACTIVE", targetThreadId: "task-a",
      prompt: `Exact marker: loomex-follow-recovery:task-a:${requestB}`, rrule: "FREQ=MINUTELY;INTERVAL=2",
    },
  }, { kind: "assistant_final", text: "Recovery is configured for this run." }] satisfies TranscriptEntry[];
  assert.deepEqual(checkMonitoringTranscript(crossRun).map((issue) => issue.code), ["final_before_poll", "recovery_claim_unverified"]);

  const paused = [...base, {
    kind: "tool", name: "automation_update", arguments: { mode: "view", id: "automation-1" }, result: {
      id: "automation-1", kind: "heartbeat", marker: `loomex-follow-recovery:task-a:${runId}`, status: "PAUSED", targetThreadId: "task-a",
      prompt: `Exact marker: loomex-follow-recovery:task-a:${runId}`, rrule: "FREQ=MINUTELY;INTERVAL=2",
    },
  }, { kind: "assistant_final", text: "Recovery is configured for this run." }] satisfies TranscriptEntry[];
  assert.deepEqual(checkMonitoringTranscript(paused).map((issue) => issue.code), ["final_before_poll", "recovery_claim_unverified"]);

  const forbiddenCreate = [...base, { kind: "tool", name: "automation_update", arguments: { mode: "create" } }] satisfies TranscriptEntry[];
  assert.deepEqual(checkMonitoringTranscript(forbiddenCreate).map((issue) => issue.code), ["recovery_create_unpermitted"]);
});

test("the follow identity and first create result bind later recovery verification", () => {
  const started: TranscriptEntry[] = [
    { kind: "follow", runId, taskId: "task-a", trigger: "explicit_follow" },
    projection("runs.get", { execution: { id: runId, status: "running" } }),
    { kind: "tool", name: "loomex_recovery_update", result: { recovery: { registrationState: "not_attempted" } } },
    { kind: "tool", name: "loomex_recovery_operation_begin", result: { recovery: { registrationState: "attempt_in_flight" }, operation: { kind: "create" }, attemptPermitted: true } },
    { kind: "tool", name: "automation_update", arguments: { mode: "create" }, result: { id: "created-id" } },
    { kind: "tool", name: "automation_update", arguments: { mode: "view", id: "other-id" }, result: {
      id: "other-id", kind: "heartbeat", marker: `loomex-follow-recovery:task-a:${runId}`, status: "ACTIVE", targetThreadId: "task-a",
      prompt: `Exact marker: loomex-follow-recovery:task-a:${runId}`, rrule: "FREQ=MINUTELY;INTERVAL=2",
    } },
    { kind: "assistant_final", text: "Recovery is configured for this run." },
  ];
  assert.deepEqual(checkMonitoringTranscript(started).map((issue) => issue.code), ["final_before_poll", "recovery_claim_unverified"]);

  const wrongProjection: TranscriptEntry[] = [
    { kind: "follow", runId, taskId: "task-a", trigger: "explicit_follow", knownAutomationId: "automation-1" },
    projection("runs.get", { execution: { id: requestB, status: "running" } }),
    { kind: "assistant_final", text: "Recovery is configured for this run." },
  ];
  assert.deepEqual(checkMonitoringTranscript(wrongProjection).map((issue) => issue.code), ["follow_identity_unverified", "final_before_poll", "recovery_initialization_missing", "recovery_claim_unverified"]);
});

test("durable registration state governs creation independently of continuation trigger", () => {
  const activeProjection = projection("runs.get", { execution: { id: runId, status: "running" } });
  const create = { kind: "tool", name: "automation_update", arguments: { mode: "create" }, result: {
    id: "automation-1", kind: "heartbeat", marker: `loomex-follow-recovery:task-a:${runId}`, status: "ACTIVE",
  } } satisfies TranscriptEntry;
  const allowed: TranscriptEntry[] = [
    { kind: "follow", runId, taskId: "task-a", trigger: "interaction_accepted" },
    activeProjection,
    { kind: "tool", name: "loomex_recovery_update", result: { recovery: { registrationState: "not_attempted" } } },
    { kind: "tool", name: "loomex_recovery_operation_begin", result: { recovery: { registrationState: "attempt_in_flight" }, operation: { kind: "create" }, attemptPermitted: true } },
    create,
  ];
  assert.deepEqual(checkMonitoringTranscript(allowed), []);

  for (const registrationState of ["attempt_in_flight", "registered", "ambiguous", undefined] as const) {
    const follow: TranscriptEntry = { kind: "follow", runId, taskId: "task-a", trigger: "run_started" };
    const state: TranscriptEntry[] = registrationState === undefined ? [] : [{ kind: "tool", name: "loomex_recovery_update", result: { recovery: { registrationState } } }];
    assert.equal(checkMonitoringTranscript([follow, activeProjection, ...state, create]).some((issue) => issue.code === "recovery_create_unpermitted"), true, registrationState ?? "unknown history");
  }
});

test("host automation events normalize to an ID-only view and failed answers remain pending", () => {
  const hostView: TranscriptEntry = {
    kind: "host_event", method: "automation_update", input: { mode: "view", id: "automation-1" }, output: {
      id: "automation-1", kind: "heartbeat", status: "ACTIVE", targetThreadId: "task-a",
      prompt: `Scheduled recovery loomex-follow-recovery:task-a:${runId}`, rrule: "FREQ=MINUTELY;INTERVAL=2",
    },
  };
  const transcript: TranscriptEntry[] = [
    { kind: "follow", runId, taskId: "task-a", trigger: "explicit_follow", knownAutomationId: "automation-1" },
    projection("runs.get", { execution: { id: runId, status: "running" } }), hostView,
  ];
  assert.deepEqual(checkMonitoringTranscript(transcript), []);

  const failed: TranscriptEntry[] = [
    projection("runs.wait", { execution: { id: runId, status: "waiting" }, humanRequest: { id: requestA, status: "pending", execution: { id: runId } } }),
    { kind: "tool", name: "loomex_interaction_view", arguments: { requestId: requestA } },
    { kind: "tool", name: "loomex_interaction_respond", arguments: { requestId: requestA }, result: { ok: false, error: { code: "INPUT_REJECTED" } } },
    { kind: "tool", name: "loomex_interaction_view", arguments: { requestId: requestA } },
  ];
  assert.deepEqual(checkMonitoringTranscript(failed).map((issue) => issue.code), ["duplicate_request_presentation"]);
});

test("redacted incident transcript flags premature final and missing recovery handling", async () => {
  const fixture = JSON.parse(await readFile(join(process.cwd(), "test/fixtures/monitoring-incident-2026-09-11.json"), "utf8")) as TranscriptEntry[];
  assert.deepEqual(checkMonitoringTranscript(fixture).map((issue) => issue.code), ["final_before_poll", "recovery_initialization_missing"]);
});

test("run projections stay compact as event history grows", () => {
  const marker = "private-event-payload";
  const result = summarize("runs.get", {
    execution: { id: runId, status: "running", nodeHistory: Array.from({ length: 400 }, () => ({ output: marker.repeat(40) })) },
    events: Array.from({ length: 400 }, (_, sequence) => ({ sequence, payload: marker.repeat(40) })),
    latestSequence: 399,
    hasMoreEvents: false,
    previousOutputs: marker.repeat(5000),
  } as never);
  const serialized = JSON.stringify(result);
  assert.ok(serialized.length < 3_000, `projection grew to ${serialized.length} bytes`);
  assert.equal(serialized.includes(marker), false);
  assert.equal((result as Record<string, unknown>).eventCount, 400);
});
