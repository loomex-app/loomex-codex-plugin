import * as assert from "node:assert/strict";
import { chmod, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";

import { FakeRunner, type FakeRequest } from "./fake-runner.js";
import {
  formatFollowContinuationMarkdown,
  formatFollowContinuationContext,
  formatManualFollowInstruction,
  parseFollowContinuation as parseContractContinuation,
} from "../src/monitoring-contract.js";

const running: FakeRunner[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
});

function hookInput(event: string, additions: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "sess-bridge-1",
    cwd: process.cwd(),
    hook_event_name: event,
    turn_id: "turn-bridge-1",
    transcript_path: "/must-not-be-read/transcript.jsonl",
    ...additions,
  };
}

async function invoke(input: Record<string, unknown>, stateDir?: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [join(process.cwd(), "hooks", "lifecycle-adapter.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(stateDir === undefined ? {} : { LOOMEX_STATE_DIR: stateDir }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify(input));
  const [stdout, stderr, code] = await Promise.all([
    new Promise<string>((resolve, reject) => {
      let value = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { value += chunk; });
      child.stdout.once("error", reject);
      child.stdout.once("end", () => resolve(value));
    }),
    new Promise<string>((resolve, reject) => {
      let value = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { value += chunk; });
      child.stderr.once("error", reject);
      child.stderr.once("end", () => resolve(value));
    }),
    new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }),
  ]);
  return { code, stdout, stderr };
}

function assertLifecycleParams(actual: unknown, expected: Record<string, unknown>): void {
  assert.ok(actual !== null && typeof actual === "object");
  const params = { ...(actual as Record<string, unknown>) };
  assert.match(String(params.eventId), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  delete params.eventId;
  assert.deepEqual(params, expected);
}

test("Stop blocks only an explicit runner continue decision", async () => {
  let runner: FakeRunner;
  runner = new FakeRunner((request, socket) => {
    assert.equal(request.method, "follow.session.lifecycle");
    assertLifecycleParams(request.params, {
      schemaVersion: "loomex.follow-session.lifecycle/v1",
      event: "Stop",
      session: { id: "sess-bridge-1", cwd: process.cwd(), turnId: "turn-bridge-1" },
    });
    runner.respond(socket, request, {
      schemaVersion: "loomex.follow-session.decision/v1",
      decision: "continue",
    });
  });
  await runner.start();
  running.push(runner);

  const result = await invoke(hookInput("Stop"), runner.stateDir);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    decision: "block",
    reason: "Loomex follow session requested continuation.",
  });
});

test("coalesced negotiation and action responses retain ordered frames", async () => {
  const adapter = await import(pathToFileURL(
    join(process.cwd(), "hooks", "lifecycle-adapter.mjs"),
  ).href) as {
    extractNextFrame(buffer: Buffer):
      | { text: string; remaining: Buffer; byteLength: number }
      | undefined;
  };
  const negotiation = JSON.stringify({
    protocol: "loomex.local-control/v2",
    id: "negotiation-id",
    result: { selectedProtocol: "loomex.local-control/v2", capabilities: ["follow.session.lifecycle/v1"], maxFrameBytes: 1024 * 1024 },
  });
  const action = JSON.stringify({
    protocol: "loomex.local-control/v2",
    id: "action-id",
    result: { schemaVersion: "loomex.follow-session.decision/v1", decision: "continue" },
  });
  const first = adapter.extractNextFrame(Buffer.from(`${negotiation}\n${action}\n`, "utf8"));
  assert.ok(first);
  assert.equal(first.text, negotiation);
  const second = adapter.extractNextFrame(first.remaining);
  assert.ok(second);
  assert.equal(second.text, action);
  assert.equal(second.remaining.byteLength, 0);
});

test("lifecycle event IDs are stable per delivery identity", async () => {
  const adapter = await import(pathToFileURL(
    join(process.cwd(), "hooks", "lifecycle-adapter.mjs"),
  ).href) as {
    lifecycleEventId(input: { event: string; sessionId: string; turnId?: string; toolUseId?: string }): string;
  };
  const base = { event: "PostToolUse", sessionId: "session", turnId: "turn", toolUseId: "tool-use" };
  const first = adapter.lifecycleEventId(base);
  assert.equal(adapter.lifecycleEventId(base), first);
  assert.notEqual(adapter.lifecycleEventId({ ...base, toolUseId: "another-tool-use" }), first);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("Stop fails open for unavailable, malformed, and allow runner responses", async () => {
  const unavailable = await invoke(hookInput("Stop"), "/definitely/not/a/loomex-state-dir");
  assert.equal(unavailable.code, 0);
  assert.equal(unavailable.stdout, "");
  assert.equal(unavailable.stderr, "");

  let runner: FakeRunner;
  runner = new FakeRunner((request, socket) => {
    assert.equal(request.method, "follow.session.lifecycle");
    socket.end(`${JSON.stringify({
      protocol: "loomex.local-control/v2",
      id: request.id,
      result: { decision: "continue" },
    })}\n`);
  });
  await runner.start();
  running.push(runner);
  const malformed = await invoke(hookInput("Stop"), runner.stateDir);
  assert.equal(malformed.code, 0);
  assert.equal(malformed.stdout, "");
  assert.equal(malformed.stderr, "");

  await runner.stop();
  running.splice(running.indexOf(runner), 1);
  runner = new FakeRunner((request, socket) => {
    runner.respond(socket, request, {
      schemaVersion: "loomex.follow-session.decision/v1",
      decision: "allow",
    });
  });
  await runner.start();
  running.push(runner);
  const allowed = await invoke(hookInput("Stop"), runner.stateDir);
  assert.equal(allowed.code, 0);
  assert.equal(allowed.stdout, "");
  assert.equal(allowed.stderr, "");
});

test("bare and generated Markdown continuations use the versioned lifecycle contract", async () => {
  const requests: FakeRequest[] = [];
  let runner: FakeRunner;
  runner = new FakeRunner((request, socket) => {
    requests.push(request);
    runner.respond(socket, request, {
      schemaVersion: "loomex.follow-session.decision/v1",
      decision: "allow",
    });
  });
  await runner.start();
  running.push(runner);

  const runId = "86cc409f-2337-4c1e-93a0-92a2609f1f37";
  const prompt = `$loomex-follow ${runId}`;
  const generated = formatFollowContinuationMarkdown(runId, "A".repeat(16));
  assert.deepEqual(parseContractContinuation(prompt), {
    schemaVersion: "loomex.follow-session.continuation/v1", source: "bare_command", runId,
  });
  assert.deepEqual(parseContractContinuation(generated), {
    schemaVersion: "loomex.follow-session.continuation/v1", source: "generated_markdown", runId, receipt: "A".repeat(16),
  });
  const promptResult = await invoke(hookInput("UserPromptSubmit", { prompt }), runner.stateDir);
  const generatedResult = await invoke(hookInput("UserPromptSubmit", { prompt: generated }), runner.stateDir);
  const toolResult = await invoke(hookInput("PostToolUse", {
    tool_name: "mcp__loomex__loomex_run_wait",
    tool_use_id: "tool-use-1",
    tool_input: { runId, ignored: "must-not-forward" },
    tool_response: { structuredContent: { data: { execution: { id: runId }, ignored: "must-not-forward" } } },
  }), runner.stateDir);
  assert.equal(promptResult.stdout, "");
  assert.equal(generatedResult.stdout, "");
  assert.equal(toolResult.stdout, "");
  assert.equal(requests.length, 3);
  assertLifecycleParams(requests[0]?.params, {
    schemaVersion: "loomex.follow-session.lifecycle/v1",
    event: "UserPromptSubmit",
    session: { id: "sess-bridge-1", cwd: process.cwd(), turnId: "turn-bridge-1" },
    continuation: {
      schemaVersion: "loomex.follow-session.continuation/v1",
      source: "bare_command",
      runId,
    },
  });
  assertLifecycleParams(requests[1]?.params, {
    schemaVersion: "loomex.follow-session.lifecycle/v1",
    event: "UserPromptSubmit",
    session: { id: "sess-bridge-1", cwd: process.cwd(), turnId: "turn-bridge-1" },
    continuation: {
      schemaVersion: "loomex.follow-session.continuation/v1",
      source: "generated_markdown",
      runId,
      receipt: "A".repeat(16),
    },
  });
  assertLifecycleParams(requests[2]?.params, {
    schemaVersion: "loomex.follow-session.lifecycle/v1",
    event: "PostToolUse",
    session: { id: "sess-bridge-1", cwd: process.cwd(), turnId: "turn-bridge-1" },
    tool: {
      name: "mcp__loomex__loomex_run_wait",
      useId: "tool-use-1",
      association: {
        schemaVersion: "loomex.follow-session.tool-association/v1",
        runId,
        request: { runId },
        response: { runId },
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(requests), /must-not-forward/);
});

test("model continuation context is labelled fenced JSON", () => {
  const context = { schema: "loomex/chat-continuation/v2", runId: "86cc409f-2337-4c1e-93a0-92a2609f1f37" };
  assert.equal(
    formatFollowContinuationContext(context),
    `Loomex continuation context:\n\n\`\`\`json\n${JSON.stringify(context)}\n\`\`\``,
  );
});

test("interaction lifecycle associations use strict request input and response run identity", async () => {
  const requests: FakeRequest[] = [];
  let runner: FakeRunner;
  runner = new FakeRunner((request, socket) => {
    requests.push(request);
    runner.respond(socket, request, {
      schemaVersion: "loomex.follow-session.decision/v1",
      decision: "allow",
    });
  });
  await runner.start();
  running.push(runner);

  const runId = "86cc409f-2337-4c1e-93a0-92a2609f1f37";
  const requestId = "c3f42d2f-78a7-4f74-8d89-5f6a59adcbef";
  const otherRequestId = "a9e7f403-190e-49a8-9518-d7f27cb56a84";
  const response = (responseRunId: string, responseRequestId: string) => ({
    structuredContent: { data: { humanRequest: { id: responseRequestId, execution: { id: responseRunId } }, ignored: "must-not-forward" } },
  });
  const input = { requestId, ignored: "must-not-forward" };
  for (const [toolName, toolUseId, toolResponse] of [
    ["mcp__loomex__loomex_interaction_get", "interaction-get", response(runId, requestId)],
    ["mcp__loomex__loomex_interaction_view", "interaction-view-request-mismatch", response(runId, otherRequestId)],
    ["mcp__loomex__loomex_interaction_get", "interaction-get-missing-run", { structuredContent: { data: { humanRequest: { id: requestId } } } }],
  ] as const) {
    const result = await invoke(hookInput("PostToolUse", {
      tool_name: toolName,
      tool_use_id: toolUseId,
      tool_input: input,
      tool_response: toolResponse,
    }), runner.stateDir);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(requests[0]?.params.tool, {
    name: "mcp__loomex__loomex_interaction_get",
    useId: "interaction-get",
    association: {
      schemaVersion: "loomex.follow-session.tool-association/v1",
      runId,
      requestId,
      request: { requestId },
      response: { runId, requestId },
    },
  });
  assert.deepEqual(requests[1]?.params.tool, {
    name: "mcp__loomex__loomex_interaction_view",
    useId: "interaction-view-request-mismatch",
  });
  assert.deepEqual(requests[2]?.params.tool, {
    name: "mcp__loomex__loomex_interaction_get",
    useId: "interaction-get-missing-run",
  });
  assert.doesNotMatch(JSON.stringify(requests), /must-not-forward/);
});

test("quoted, edited, and mismatched continuations are inert", async () => {
  const runId = "86cc409f-2337-4c1e-93a0-92a2609f1f37";
  const generated = formatFollowContinuationMarkdown(runId, "A".repeat(16));
  const adapter = await import(pathToFileURL(join(process.cwd(), "hooks", "lifecycle-adapter.mjs")).href) as {
    parseFollowContinuation(value: unknown): unknown;
  };
  for (const value of [
    `> $loomex-follow ${runId}`,
    `\`$loomex-follow ${runId}\``,
    `\`\`\`\n$loomex-follow ${runId}\n\`\`\``,
    `$loomex-follow ${runId}\nPlease continue`,
    generated.replace("Follow this exact", "Please follow this exact"),
    `${generated}\n`,
    formatManualFollowInstruction(runId),
  ]) {
    assert.equal(adapter.parseFollowContinuation(value), undefined, value);
    assert.equal(parseContractContinuation(value), undefined, value);
  }
});

test("adapter refuses a group-accessible socket and does not read hook transcripts", async () => {
  let runner: FakeRunner;
  runner = new FakeRunner((request, socket) => {
    assert.fail(`insecure socket reached runner: ${request.method}`);
    socket.destroy();
  });
  await runner.start();
  running.push(runner);
  await chmod(runner.socketPath, 0o660);
  const result = await invoke(hookInput("Stop"), runner.stateDir);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(runner.requests.length, 0);
  assert.equal(runner.negotiations.length, 0);
  const adapter = await readFile(join(process.cwd(), "hooks", "lifecycle-adapter.mjs"), "utf8");
  assert.equal(adapter.includes("transcript_path"), false);
  assert.equal(adapter.includes("tool_result_digest"), false);
  assert.equal(adapter.includes("stopHookActive"), false);
});

test("diagnostics are opt-in and never include prompt or tool payloads", async () => {
  const prompt = "$loomex-follow 86cc409f-2337-4c1e-93a0-92a2609f1f37";
  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), "hooks", "lifecycle-adapter.mjs")], {
      cwd: process.cwd(),
      env: { ...process.env, LOOMEX_HOOK_DIAGNOSTICS: "1", LOOMEX_STATE_DIR: "/definitely/not/a/loomex-state-dir" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", () => resolve({ stdout, stderr }));
    child.stdin.end(JSON.stringify(hookInput("UserPromptSubmit", { prompt, tool_response: { secret: "must-not-log" } })));
  });
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^\[loomex-hook\] event=UserPromptSubmit status=runner_unavailable\n$/);
  assert.doesNotMatch(result.stderr, /loomex-follow|must-not-log/);
});
