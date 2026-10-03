import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { MONITORING_MODEL_INSTRUCTIONS, RECOVERY_MARKER_TEMPLATE } from "../src/monitoring-contract.js";
import { checkMonitoringTranscript, type TranscriptEntry } from "./monitoring-transcript.js";

const runId = "68482888-22fb-44f4-ac56-a4f3a1d1efc";
const marker = `loomex-follow-recovery:task-a:${runId}`;
const follow: TranscriptEntry = { kind: "follow", runId, taskId: "task-a", trigger: "explicit_follow" };
const projection: TranscriptEntry = { kind: "projection", method: "runs.get", projection: {
  execution: { id: runId }, monitoring: { state: "needs_input" },
} };
const begin: TranscriptEntry = { kind: "tool", name: "loomex_recovery_operation_begin", result: {
  attemptPermitted: true, recovery: { registrationState: "attempt_in_flight" }, operation: { kind: "create" },
} };
const create: TranscriptEntry = { kind: "tool", name: "automation_update", arguments: { mode: "create" }, result: { id: "created-id" } };
const view: TranscriptEntry = { kind: "tool", name: "automation_update", arguments: { mode: "view", id: "created-id" }, result: {
  id: "created-id", kind: "heartbeat", status: "ACTIVE", targetThreadId: "task-a", prompt: marker,
  rrule: "FREQ=MINUTELY;INTERVAL=2",
} };
const settle: TranscriptEntry = { kind: "tool", name: "loomex_recovery_operation_settle", result: {
  operation: { status: "succeeded" }, recovery: { registrationState: "registered", automationId: "created-id" },
} };
const claim: TranscriptEntry = { kind: "assistant_final", text: "Recovery is active.", recoveryEstablished: true };

test("runtime recovery instructions read back the actual create before their single settlement", () => {
  const instructions = MONITORING_MODEL_INSTRUCTIONS.find(instruction => instruction.includes("For supported host recovery"));
  assert.ok(instructions);
  const create = instructions.indexOf("perform that exact host create");
  const readBack = instructions.indexOf("read its host automation view");
  const settleOnce = instructions.indexOf("then settle the operation once with loomex_recovery_operation_settle");
  assert.ok(create >= 0 && readBack > create && settleOnce > readBack,
    "runtime guidance must require host create → ID-only read-back → single settlement");
  assert.match(instructions, /successful create with failed view[\s\S]*known ID and unchecked lifecycle/);
  assert.match(instructions, /without changing that durable unchecked lifecycle/);
  assert.match(instructions, /never settle an unperformed host create/);
  assert.match(instructions, /Quiet waits never write recovery checkpoints/);
  assert.doesNotMatch(instructions, /settle[^.]*, then verify/);
});

test("recovery requires actual host creation and matching ID-only read-back before a verified claim", () => {
  assert.deepEqual(checkMonitoringTranscript([follow, projection, begin, create, view, settle, claim]), []);
  const fabricated = checkMonitoringTranscript([follow, projection, begin, settle, view, claim]);
  assert.ok(fabricated.some(issue => issue.code === "recovery_settle_without_host_mutation"));
  assert.ok(fabricated.some(issue => issue.code === "recovery_claim_unverified"));
  assert.ok(checkMonitoringTranscript([follow, projection, begin, create, settle, claim])
    .some(issue => issue.code === "recovery_claim_unverified"), "create receipt alone is insufficient");
});

test("an observed create ID cannot be substituted by settlement or repeated with one permit", () => {
  const wrongSettle: TranscriptEntry = { ...settle, result: {
    operation: { status: "succeeded" }, recovery: { registrationState: "registered", automationId: "other-id" },
  } };
  const wrongView: TranscriptEntry = { ...view, arguments: { mode: "view", id: "other-id" }, result: { ...view.result, id: "other-id" } };
  const substituted = checkMonitoringTranscript([follow, projection, begin, create, wrongSettle, wrongView, claim]);
  assert.ok(substituted.some(issue => issue.code === "recovery_settle_identity_mismatch"));
  assert.ok(substituted.some(issue => issue.code === "recovery_claim_unverified"));
  assert.ok(checkMonitoringTranscript([follow, projection, begin, create, create])
    .some(issue => issue.code === "recovery_create_unpermitted"));
  const ambiguousSettle: TranscriptEntry = { ...settle, result: {
    operation: { status: "ambiguous" }, recovery: { registrationState: "ambiguous", automationId: "created-id" },
  } };
  assert.ok(checkMonitoringTranscript([follow, projection, begin, create, view, ambiguousSettle, claim])
    .some(issue => issue.code === "recovery_claim_unverified"));
});

test("one host create and read-back cannot authorize a second successful settlement", () => {
  const duplicate = checkMonitoringTranscript([follow, projection, begin, create, view, settle, settle, claim]);
  assert.ok(duplicate.some(issue => issue.code === "recovery_settle_repeated"));
  assert.ok(duplicate.some(issue => issue.code === "recovery_claim_unverified"));
});

test("known host record verification checks cadence, target, status and returned ID", () => {
  const resumed: TranscriptEntry = { ...follow, knownAutomationId: "created-id" };
  for (const patch of [{ id: "wrong" }, { targetThreadId: "other-task" }, { status: "PAUSED" },
    { rrule: "FREQ=MINUTELY;INTERVAL=1" }, { prompt: `loomex-follow-recovery:task-a:other-run` }]) {
    const mismatched: TranscriptEntry = { ...view, result: { ...view.result, ...patch } };
    assert.ok(checkMonitoringTranscript([resumed, projection, mismatched, claim])
      .some(issue => issue.code === "recovery_claim_unverified"), JSON.stringify(patch));
  }
  const contradictory: TranscriptEntry = { ...view, result: { ...view.result, marker, prompt: "loomex-follow-recovery:task-a:other-run" } };
  assert.ok(checkMonitoringTranscript([resumed, projection, contradictory, claim])
    .some(issue => issue.code === "recovery_claim_unverified"));
  const inventedViewArguments: TranscriptEntry = { ...view, arguments: { mode: "view", id: "created-id", marker } };
  assert.ok(checkMonitoringTranscript([resumed, projection, inventedViewArguments, claim])
    .some(issue => issue.code === "recovery_claim_unverified"));
});

test("quiet waits and status-only observations cannot write recovery checkpoints", () => {
  const checkpoint: TranscriptEntry = { kind: "tool", name: "loomex_recovery_update", result: { recovery: { registrationState: "registered" } } };
  const quiet: TranscriptEntry = { kind: "projection", method: "runs.wait", projection: { execution: { id: runId }, timedOut: true } };
  assert.ok(checkMonitoringTranscript([follow, quiet, checkpoint])
    .some(issue => issue.code === "recovery_checkpoint_on_quiet_wait"));
  assert.ok(checkMonitoringTranscript([projection, checkpoint])
    .some(issue => issue.code === "recovery_mutation_without_follow"));
  assert.ok(checkMonitoringTranscript([follow, quiet, begin, create])
    .some(issue => issue.code === "recovery_checkpoint_on_quiet_wait"));
});

test("a host pause uses its actual update schema and invalidates prior active evidence", () => {
  const resumed: TranscriptEntry = { ...follow, knownAutomationId: "created-id" };
  const pausePermit: TranscriptEntry = { kind: "tool", name: "loomex_recovery_operation_begin", result: {
    attemptPermitted: true, operation: { kind: "pause" }, recovery: { registrationState: "attempt_in_flight" },
  } };
  const pause: TranscriptEntry = { kind: "tool", name: "automation_update", arguments: {
    mode: "update", id: "created-id", status: "PAUSED",
  }, result: { id: "created-id", status: "PAUSED" } };
  const pausedSettle: TranscriptEntry = { ...settle, result: {
    operation: { status: "succeeded" }, recovery: { registrationState: "registered", automationId: "created-id", lifecycle: "paused" },
  } };
  const issues = checkMonitoringTranscript([resumed, projection, view, pausePermit, pause, pausedSettle, claim]);
  assert.deepEqual(issues.map(issue => issue.code), ["recovery_claim_unverified"]);
});

test("compact guidance preserves journal authority, ambiguity, cleanup and one-shot recovery", async () => {
  const root = resolve(import.meta.dirname, "../skills/loomex-runs/references");
  const recovery = await readFile(resolve(root, "recovery.md"), "utf8");
  const monitoring = await readFile(resolve(root, "monitoring.md"), "utf8");
  assert.ok(recovery.includes(RECOVERY_MARKER_TEMPLATE.replace("<host-task-id>", "<current-task-id>").replace("<run-id>", "<runId>")));
  for (const pattern of [/journal, not a scheduler/, /cannot inspect or attest a host task/, /one-off status reads and listings never initialize/i,
    /initialize once at revision `0`/, /even if the first snapshot awaits human input/, /Only exact `not_attempted` permits a create/,
    /attemptPermitted: true/, /Never settle an unperformed create as successful/, /Settle the exact operation once/,
    /successful create with failed read-back[\s\S]*`unchecked`/, /durable lifecycle stays\s+`unchecked`/, /Without an ID, preserve\s+ambiguity/,
    /Quiet waits do not write recovery checkpoints/, /pause known exact recovery/, /After complete terminal result\s+retrieval/,
    /If removal fails[\s\S]*pause it/, /never cancels execution/, /one-shot\s+recovery read/, /no documented atomic uniqueness/]) {
    assert.match(recovery, pattern);
  }
  assert.match(monitoring, /timeoutSeconds: 30/);
  assert.match(monitoring, /Drain every required event page before advancing the cursor/);
  assert.match(monitoring, /Quiet waits never write recovery checkpoints/);
  for (const skill of ["loomex-browse", "loomex-connect", "loomex-create"]) {
    assert.equal(await readFile(resolve(root, `../../${skill}/references/recovery.md`), "utf8"), recovery,
      `${skill}: shared recovery sequence drifted`);
    const mirror = await readFile(resolve(root, `../../${skill}/references/monitoring.md`), "utf8");
    assert.match(mirror, /Quiet waits never write recovery checkpoints/);
  }
});
