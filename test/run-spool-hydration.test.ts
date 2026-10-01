import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LocalControlClient, LocalControlError } from "../src/local-control.js";
import { MAX_FRAME_BYTES, type JsonValue } from "../src/protocol.js";
import { runSummary } from "../src/run-summary.js";
import { FakeRunner, type FakeRequest } from "./fake-runner.js";

const runId = "5e06cb51-c39e-485b-83ca-c2f2d12b1eb8";
const organizationId = "dd6244ea-2f21-48bd-a9da-4d2ac161882a";
const responseRef = "8081f734-5175-492b-b412-b1d88d8e3a7d";
const requestId = "5da0df3e-3c8b-4385-a9df-7eec811c6bb7";
const privateMarker = "private-review-context-must-not-enter-model-channels";
type Data = Record<string, JsonValue>;

function canonical(kind = "active", large = true): Data {
  return {
    execution: { id: runId, organizationId, workflowVersionId: responseRef,
      status: kind === "terminal" ? "succeeded" : kind === "failed" ? "failed" : "running", workflowName: "Spool projection",
      inputs: { original: large ? privateMarker.repeat(23000) : privateMarker },
      ...(kind === "failed" ? { error: { code: "PROVIDER_UNAVAILABLE" } } : {}),
      ...(kind === "terminal" ? { result: { version: 1, summary: "Verification completed." } } : {}) },
    humanRequest: kind.startsWith("pending") ? { id: requestId, organizationId, execution: { id: runId },
      status: "pending", type: "manual_input", title: "Review", answerChannel: kind === "pending_chat" ? "chat" : "ui", schemaDigest: "f".repeat(64),
      inputSpec: { inputType: "text", question: "What should change?" }, responseSchema: { type: "object" },
      context: { previousOutputs: privateMarker.repeat(23000) } } : null,
    events: [{ sequence: 1, type: "workflow_runtime.node.started", payload: { internal: privateMarker } }],
    latestSequence: kind === "events" ? 3 : 1, hasMoreEvents: kind === "events", timedOut: kind === "quiet",
    waitState: kind.startsWith("pending") ? "human_action_required" : kind === "blocked" ? "observation_lost" : "automated_progress",
    ...(kind === "processing" ? { progress: { version: 1, activeNodes: [{ status: "running", waitState: "processing_result" }] } } : {}),
    ...(kind === "blocked" ? { automation: { phase: "observation_lost", retryable: false, code: "WORKFLOW_CONTINUATION_OBSERVATION_LOST",
      recovery: { schemaVersion: "loomex.continuation-recovery/v1", executionId: runId, deliveryId: requestId, continuationDigest: "c".repeat(64) } } } : {}),
  };
}

function spoolRunner(bytes: Buffer, modify?: (page: Data, request: FakeRequest) => Data | "disconnect"): FakeRunner {
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => {
    if (request.method === "responses.read") {
      const offset = Number(request.params.offset);
      const next = Math.min(offset + 262144, bytes.length);
      const page: Data = { responseRef, offset, sizeBytes: bytes.length, checksumSha256,
        dataBase64: bytes.subarray(offset, next).toString("base64"), nextOffset: next === bytes.length ? null : next };
      const changed = modify?.(page, request) ?? page;
      if (changed === "disconnect") socket.destroy();
      else runner.respond(socket, request, changed);
    } else {
      runner.respond(socket, request, { responseRef, sizeBytes: bytes.length, checksumSha256, encoding: "json", nextOffset: 0 });
    }
  });
  return runner;
}

async function direct<T>(runner: FakeRunner, operation: () => Promise<T>): Promise<T> {
  await runner.start();
  const previous = process.env.LOOMEX_STATE_DIR;
  process.env.LOOMEX_STATE_DIR = runner.stateDir;
  try { return await operation(); }
  finally {
    if (previous === undefined) delete process.env.LOOMEX_STATE_DIR;
    else process.env.LOOMEX_STATE_DIR = previous;
    await runner.stop();
  }
}

for (const [method, kind] of [["runs.get", "pending"], ["runs.get", "pending_chat"], ["runs.wait", "active"], ["runs.wait", "quiet"],
  ["runs.wait", "processing"], ["runs.get", "blocked"], ["runs.events", "events"], ["runs.result", "terminal"], ["runs.result", "failed"]] as const) {
  test(`oversized ${method} ${kind} hydrates before both MCP projections`, async () => {
    const data = canonical(kind);
    const bytes = Buffer.from(JSON.stringify(data));
    assert.ok(bytes.length > MAX_FRAME_BYTES);
    const runner = spoolRunner(bytes);
    await runner.start();
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [join(process.cwd(), "dist", "server.js")], env: { ...env, LOOMEX_STATE_DIR: runner.stateDir }, stderr: "pipe" });
    const client = new Client({ name: "spool-projection-regression", version: "1" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: method.replace("runs.", "loomex_run_"), arguments: { runId } });
      assert.equal(result.isError, undefined);
      const structured = result.structuredContent as { requestId: string; method: string; data: Data };
      const text = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Data;
      const expected = runSummary(method, data);
      assert.deepEqual(structured.data, expected);
      const { ok: _ok, method: _method, requestId: _id, ...textData } = text;
      assert.deepEqual(textData, expected);
      assert.equal(structured.method, method);
      const origins = runner.requests.filter(request => request.method === method);
      assert.equal(origins.length, 1);
      assert.equal(structured.requestId, origins[0]!.id);
      assert.equal(text.requestId, origins[0]!.id);
      const model = JSON.stringify({ content: result.content, structuredContent: result.structuredContent });
      assert.ok(Buffer.byteLength(model) < 15000);
      assert.equal(model.includes(privateMarker), false);
      assert.equal(model.includes("dataBase64"), false);
      assert.equal(structured.data.responseRef, undefined);
      if (method === "runs.get") assert.equal(JSON.stringify(result._meta?.["loomex/uiData"]).includes(privateMarker), true);
      else assert.equal(result._meta?.["loomex/uiData"], undefined);
      const reads = runner.requests.filter(request => request.method === "responses.read");
      assert.ok(reads.length > 4);
      assert.deepEqual(reads.map(request => request.params.offset), Array.from({ length: Math.ceil(bytes.length / 262144) }, (_, index) => index * 262144));
    } finally { await client.close(); await transport.close(); await runner.stop(); }
  });
}

test("below-frame run reads and out-of-scope spool tools are unchanged", async () => {
  const data = canonical("active", false);
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, data));
  await direct(runner, async () => {
    const client = new LocalControlClient();
    for (const method of ["runs.get", "runs.wait", "runs.events", "runs.result"]) {
      const output = await client.call(method, { runId }, { mutating: false });
      assert.deepEqual(output.data, data);
      assert.equal(output.requestId, runner.requests.at(-1)!.id);
    }
    assert.equal(runner.requests.some(request => request.method === "responses.read"), false);
  });
  const spool = spoolRunner(Buffer.from(JSON.stringify(data)));
  await direct(spool, async () => {
    const output = await new LocalControlClient().call("workflows.get", { workflowId: runId }, { mutating: false });
    assert.equal(output.data?.responseRef, responseRef);
    assert.equal(spool.requests.length, 1);
    const page = await new LocalControlClient().call("responses.read", { responseRef, offset: 0 }, { mutating: false });
    assert.equal(page.data?.dataBase64, Buffer.from(JSON.stringify(data)).toString("base64"));
    assert.equal(page.data?.nextOffset, null);
    assert.equal(page.data?.checksumSha256, createHash("sha256").update(JSON.stringify(data)).digest("hex"));
    assert.equal(page.requestId, spool.requests[1]!.id);
    assert.equal(spool.requests.length, 2);
  });
});

for (const corruption of ["reference", "checksum", "size", "offset", "gap", "early_end", "extra", "empty", "base64", "digest", "interruption"] as const) {
  test(`spool ${corruption} fails without replaying the completed run read`, async () => {
    const bytes = Buffer.from(JSON.stringify(canonical("pending")));
    const runner = spoolRunner(bytes, (page, request) => {
      switch (corruption) {
        case "reference": return { ...page, responseRef: requestId };
        case "checksum": return { ...page, checksumSha256: "f".repeat(64) };
        case "size": return { ...page, sizeBytes: bytes.length + 1 };
        case "offset": return { ...page, offset: Number(page.offset) + 1 };
        case "gap": return { ...page, nextOffset: Number(page.nextOffset) + 1 };
        case "early_end": return { ...page, nextOffset: null };
        case "extra": return { ...page, dataBase64: Buffer.alloc(262145).toString("base64") };
        case "empty": return { ...page, dataBase64: "" };
        case "base64": return { ...page, dataBase64: String(page.dataBase64) + "!" };
        case "digest": {
          const changed = Buffer.from(String(page.dataBase64), "base64"); changed[0] = changed[0]! ^ 1;
          return { ...page, dataBase64: changed.toString("base64") };
        }
        case "interruption": return request.params.offset === 262144 ? "disconnect" : page;
      }
    });
    await direct(runner, async () => {
      const origin = new LocalControlClient().call("runs.wait", { runId }, { mutating: false });
      await assert.rejects(origin, error => error instanceof LocalControlError &&
        error.requestId === runner.requests[0]!.id && !error.transportFailure &&
        error.code === (corruption === "interruption" ? "RUNNER_RESPONSE_UNAVAILABLE" : "INVALID_RESPONSE"));
      assert.equal(runner.requests.filter(request => request.method === "runs.wait").length, 1);
      if (corruption === "interruption") assert.deepEqual(runner.requests.slice(1).map(request => request.params.offset), [0, 262144, 262144]);
    });
  });
}

for (const [name, bytes] of [["UTF-8", Buffer.from([0xff])], ["JSON", Buffer.from("{")],
  ["original schema", Buffer.from(JSON.stringify({ execution: {}, events: [], unexpected: true }))],
  ["nested reference", Buffer.from(JSON.stringify({ responseRef, sizeBytes: 1, checksumSha256: "a".repeat(64), encoding: "json", nextOffset: 0 }))]] as const) {
  test(`verified spool with invalid ${name} exposes no partial result`, async () => {
    const runner = spoolRunner(bytes);
    await direct(runner, async () => {
      await assert.rejects(new LocalControlClient().call("runs.get", { runId }, { mutating: false }),
        error => error instanceof LocalControlError && error.code === "INVALID_RESPONSE");
      assert.equal(runner.requests.filter(request => request.method === "runs.get").length, 1);
    });
  });
}
