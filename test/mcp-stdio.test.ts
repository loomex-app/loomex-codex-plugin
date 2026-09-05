import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

import { resultSchemaFor } from "../src/result-schemas.js";
import { TOOL_DEFINITIONS, TOOL_NAMES } from "../src/tool-catalog.js";
import { FakeRunner } from "./fake-runner.js";

const running: Array<{ client: Client; transport: StdioClientTransport; runner: FakeRunner }> = [];

function childEnvironment(stateDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.LOOMEX_STATE_DIR = stateDir;
  return env;
}

async function connect(runner: FakeRunner): Promise<Client> {
  await runner.start();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist", "server.js")],
    env: childEnvironment(runner.stateDir),
    stderr: "pipe",
  });
  const client = new Client({ name: "loomex-plugin-test", version: "0.1.0" });
  await client.connect(transport);
  running.push({ client, transport, runner });
  return client;
}

afterEach(async () => {
  while (running.length > 0) {
    const item = running.pop();
    if (item === undefined) continue;
    await item.client.close();
    await item.runner.stop();
  }
});

test("pinned runner contract hashes and strict method schemas cannot drift", async () => {
  const pin = JSON.parse(await readFile("contracts/contract-pin.json", "utf8")) as {
    files: Record<string, string>;
  };
  for (const [file, expected] of Object.entries(pin.files)) {
    const bytes = await readFile(join("contracts", file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
  }

  const catalog = JSON.parse(await readFile("contracts/method-catalog.json", "utf8")) as {
    methods: Array<{
      name: string;
      inputSchema: { properties: Record<string, unknown>; required?: string[] };
      outputSchema: {
        oneOf: Array<{ properties: Record<string, unknown>; required?: string[] }>;
      };
    }>;
  };
  const exposed = catalog.methods.filter((method) => method.name !== "daemon.drain");
  assert.deepEqual(
    TOOL_DEFINITIONS.map((definition) => definition.rpcMethod).sort(),
    exposed.map((method) => method.name).sort(),
  );

  for (const method of exposed) {
    const definition = TOOL_DEFINITIONS.find((candidate) => candidate.rpcMethod === method.name);
    assert.ok(definition);
    const input = z.toJSONSchema(definition.inputSchema) as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    assert.deepEqual(Object.keys(input.properties).sort(), Object.keys(method.inputSchema.properties).sort());
    assert.deepEqual([...(input.required ?? [])].sort(), [...(method.inputSchema.required ?? [])].sort());

    const resultSchema = resultSchemaFor(method.name);
    assert.ok(resultSchema);
    const output = z.toJSONSchema(resultSchema) as {
      anyOf: Array<{
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      }>;
    };
    const primary = output.anyOf[0];
    assert.ok(primary);
    assert.equal(primary.additionalProperties, false);
    assert.deepEqual(
      Object.keys(primary.properties).sort(),
      Object.keys(method.outputSchema.oneOf[0]?.properties ?? {}).sort(),
    );
    assert.deepEqual(
      [...(primary.required ?? [])].sort(),
      [...(method.outputSchema.oneOf[0]?.required ?? [])].sort(),
    );
  }
});

test("SDK stdio discovery exposes only the focused 0.1.0 tool catalog", async () => {
  const runner = new FakeRunner((request, socket) => {
    runner.respond(socket, request, {
      version: "0.1.0",
      protocol: "loomex.local-control/v2",
      activeJobs: 0,
      draining: false,
      updateDeferred: false,
    });
  });
  const client = await connect(runner);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...TOOL_NAMES].sort());
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.some((name) => /legacy|alias|v1/i.test(name)), false);
  for (const tool of tools.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema?.type, "object");
    assert.equal(tool.outputSchema?.additionalProperties, false);
    const outputProperties = tool.outputSchema?.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    const dataSchema = outputProperties?.data;
    const resultAlternatives = (dataSchema?.anyOf ?? dataSchema?.oneOf) as
      | Array<Record<string, unknown>>
      | undefined;
    assert.equal(resultAlternatives?.length, 2);
    assert.equal(resultAlternatives?.every((schema) => schema.additionalProperties === false), true);
  }
});

test("readiness makes one owner-checked RPC call and returns structured IDs", async () => {
  const runner = new FakeRunner((request, socket) => {
    runner.respond(socket, request, {
      version: "0.1.0",
      protocol: "loomex.local-control/v2",
      activeJobs: 0,
      draining: false,
      updateDeferred: false,
      details: { runnerId: "e0cb909f-df9d-45c4-9baa-fd17759b5470" },
    });
  });
  const client = await connect(runner);
  const result = await client.callTool({ name: "loomex_readiness", arguments: {} });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, undefined);
  assert.equal(structured.ok, true);
  assert.equal(structured.method, "status.get");
  assert.equal(
    ((structured.data as Record<string, unknown>).details as Record<string, unknown>).runnerId,
    "e0cb909f-df9d-45c4-9baa-fd17759b5470",
  );
  assert.equal(runner.requests.length, 1);
  assert.equal(runner.requests[0]?.method, "status.get");
});

test("strict input validation rejects unknown fields and unsupported secret inputs", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, {}));
  const client = await connect(runner);

  const unknown = await client.callTool({
    name: "loomex_readiness",
    arguments: { unexpected: true },
  });
  assert.equal(unknown.isError, true);

  const secret = await client.callTool({
    name: "loomex_workflow_validate",
    arguments: { definition: { input: { source: "secret", name: "API_KEY" } } },
  });
  assert.equal(secret.isError, true);
  const secretContent = secret.content as Array<{ type: string; text?: string }>;
  assert.match(String(secretContent[0]?.text ?? ""), /secret input/i);
  assert.equal(runner.requests.length, 0);
});

test("editor finalize requires and forwards the explicit preview/apply choice unchanged", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, {}));
  const client = await connect(runner);
  const sessionId = "20bc5aa0-ac19-4b39-92f0-621191c988a6";

  const missing = await client.callTool({
    name: "loomex_editor_finalize",
    arguments: {
      sessionId,
      idempotencyKey: "a049e026-b50c-4c4f-b522-3fe17650fbf8",
    },
  });
  assert.equal(missing.isError, true);
  assert.equal(runner.requests.length, 0);

  for (const [confirm, idempotencyKey] of [
    [false, "c71e7d28-da66-489a-bc45-084839dd22d5"],
    [true, "b32e57a1-4423-4448-978b-9ca4a54a2a27"],
  ] as const) {
    const result = await client.callTool({
      name: "loomex_editor_finalize",
      arguments: { sessionId, confirm, idempotencyKey },
    });
    assert.equal(result.isError, undefined);
  }
  assert.deepEqual(
    runner.requests.map((request) => request.params.confirm),
    [false, true],
  );
});

test("disconnect after sending a mutation is ambiguous and is never retried", async () => {
  const runner = new FakeRunner((_request, socket) => {
    socket.destroy();
  });
  const client = await connect(runner);
  const idempotencyKey = "c04992aa-ed7c-4ac2-b546-d0e26f680f72";
  const result = await client.callTool({
    name: "loomex_workflow_create",
    arguments: { name: "Ambiguous", idempotencyKey },
  });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, true);
  assert.equal(structured.idempotencyKey, idempotencyKey);
  assert.equal(
    (structured.error as Record<string, unknown>).code,
    "NETWORK_AMBIGUOUS",
  );
  assert.equal(runner.requests.length, 1);
});

test("a read retries exactly once after a classified transport disconnect", async () => {
  let attempts = 0;
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => {
    attempts += 1;
    if (attempts === 1) {
      socket.destroy();
      return;
    }
    runner.respond(socket, request, {
      version: "0.1.0",
      protocol: "loomex.local-control/v2",
      activeJobs: 0,
      draining: false,
      updateDeferred: false,
    });
  });
  const client = await connect(runner);
  const result = await client.callTool({ name: "loomex_readiness", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(runner.requests.length, 2);
  assert.notEqual(runner.requests[0]?.id, runner.requests[1]?.id);
});

test("runner error messages are replaced with safe credential-free text", async () => {
  const runner = new FakeRunner((request, socket) => {
    runner.error(socket, request, "BACKEND_UNAVAILABLE", "Bearer never-print-this-token", true);
  });
  const client = await connect(runner);
  const result = await client.callTool({ name: "loomex_readiness", arguments: {} });
  const serialized = JSON.stringify(result);
  assert.equal(result.isError, true);
  assert.doesNotMatch(serialized, /never-print-this-token/);
  assert.match(serialized, /temporarily unavailable/);
});

test("stable runner error codes outside the plugin message map remain typed and safely redacted", async () => {
  const runner = new FakeRunner((request, socket) => {
    runner.error(socket, request, "VALIDATION_ERROR", "Bearer never-print-this-token", false);
  });
  const client = await connect(runner);
  const result = await client.callTool({ name: "loomex_readiness", arguments: {} });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, true);
  assert.equal((structured.error as Record<string, unknown>).code, "VALIDATION_ERROR");
  assert.equal(
    (structured.error as Record<string, unknown>).message,
    "The local Loomex runner could not complete the operation.",
  );
  assert.doesNotMatch(JSON.stringify(result), /never-print-this-token/);
});

test("run projections accept canonical string wait states and nested execution IDs", async () => {
  const runId = "733ccce0-6fc0-4fe2-93fb-5c2114878103";
  const runner = new FakeRunner((request, socket) => {
    runner.respond(socket, request, {
      execution: { id: runId },
      humanRequest: { id: "aa7843c2-7694-426a-ae51-fbc3af88d415" },
      waitState: "human_action_required",
      automation: null,
      runner: {},
      events: [],
      latestSequence: 0,
      hasMoreEvents: false,
      timedOut: false,
    });
  });
  const client = await connect(runner);
  const result = await client.callTool({ name: "loomex_run_get", arguments: { runId } });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, undefined);
  assert.equal((structured.data as Record<string, unknown>).waitState, "human_action_required");
});

test("canonical nonnegative paging and wait values are forwarded without hidden client caps", async () => {
  const runId = "088c7ed5-2a2f-42c4-af9c-92f2d3243db9";
  const artifactId = "95ea94d7-a402-4da2-8d3b-088a43a1905e";
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => {
    if (request.method === "artifacts.read") {
      runner.respond(socket, request, {
        artifactId,
        offset: 0,
        dataBase64: "",
        nextOffset: null,
        sizeBytes: 0,
        checksumSha256: "0".repeat(64),
      });
      return;
    }
    runner.respond(socket, request, {
      execution: { id: runId },
      events: [],
      latestSequence: 0,
      hasMoreEvents: false,
      timedOut: false,
    });
  });
  const client = await connect(runner);

  const run = await client.callTool({
    name: "loomex_run_wait",
    arguments: { runId, limit: 0, timeoutSeconds: 100 },
  });
  const artifact = await client.callTool({
    name: "loomex_artifact_read",
    arguments: { artifactId, offset: 0, limit: 500_000 },
  });
  assert.equal(run.isError, undefined);
  assert.equal(artifact.isError, undefined);
  assert.equal(runner.requests[0]?.params.limit, 0);
  assert.equal(runner.requests[0]?.params.timeoutSeconds, 100);
  assert.equal(runner.requests[1]?.params.limit, 500_000);
});

test("malformed runner envelopes become safe INVALID_RESPONSE results", async () => {
  const runner = new FakeRunner((request, socket) => {
    socket.end(
      `${JSON.stringify({
        protocol: "loomex.local-control/v2",
        id: request.id,
        result: {},
        leaked: "unexpected",
      })}\n`,
    );
  });
  const client = await connect(runner);
  const result = await client.callTool({ name: "loomex_readiness", arguments: {} });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, true);
  assert.equal(
    (structured.error as Record<string, unknown>).code,
    "INVALID_RESPONSE",
  );
  assert.equal(runner.requests.length, 1);
});

test("method-specific strict result schemas reject missing and unknown top-level fields", async () => {
  const runner = new FakeRunner((request, socket) => {
    runner.respond(socket, request, {
      version: "0.1.0",
      protocol: "loomex.local-control/v2",
      activeJobs: 0,
      draining: false,
      updateDeferred: false,
      unexpected: true,
    });
  });
  const client = await connect(runner);
  const result = await client.callTool({ name: "loomex_readiness", arguments: {} });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, true);
  assert.match(String(structured.requestId), /^[0-9a-f-]{36}$/);
  assert.equal(
    (structured.error as Record<string, unknown>).code,
    "INVALID_RESPONSE",
  );
});

test("oversized result references pass the common strict spool schema", async () => {
  const runner = new FakeRunner((request, socket) => {
    runner.respond(socket, request, {
      responseRef: "f04f2ea4-6d08-4ef9-aea1-f308237a81d0",
      sizeBytes: 2_000_000,
      encoding: "json",
      nextOffset: 0,
      checksumSha256: "a".repeat(64),
    });
  });
  const client = await connect(runner);
  const result = await client.callTool({ name: "loomex_readiness", arguments: {} });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, undefined);
  assert.equal(structured.ok, true);
  assert.equal(
    (structured.data as Record<string, unknown>).responseRef,
    "f04f2ea4-6d08-4ef9-aea1-f308237a81d0",
  );
});

test("plugin refuses a group/world-accessible runner socket", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, {}));
  const client = await connect(runner);
  await chmod(runner.socketPath, 0o666);
  const result = await client.callTool({ name: "loomex_readiness", arguments: {} });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, true);
  assert.equal(
    (structured.error as Record<string, unknown>).code,
    "RUNNER_UNAVAILABLE",
  );
  assert.match(String(structured.requestId), /^[0-9a-f-]{36}$/);
  assert.equal(runner.requests.length, 0);
});

test("MCP Apps resources use the portable bridge and no external network", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, {}));
  const client = await connect(runner);
  const resources = await client.listResources();
  assert.equal(resources.resources.length, 4);
  for (const resource of resources.resources) {
    const result = await client.readResource({ uri: resource.uri });
    const content = result.contents[0];
    const text = content !== undefined && "text" in content ? content.text : "";
    assert.match(text, /ui\/initialize/);
    assert.match(text, /tools\/call/);
    assert.match(text, /Content-Security-Policy/);
    assert.doesNotMatch(text, /window\.openai/);
    assert.doesNotMatch(text, /https?:\/\//);
    assert.match(text, /data\.execution/);
    assert.match(text, /data\.humanRequest/);
    assert.match(text, /data\.builderSession/);
    assert.match(text, /request\.responseSchema/);
    assert.match(text, /!properties \|\| !supported/);
    assert.match(text, /mutationKeys/);
    assert.match(text, /NETWORK_AMBIGUOUS/);
    assert.match(text, /IDEMPOTENCY_REQUEST_IN_PROGRESS/);
    const meta = content?._meta as Record<string, unknown>;
    assert.ok(meta.ui);
  }
});

test("artifact download advertises its possible overwrite as destructive", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, {}));
  const client = await connect(runner);
  const tools = await client.listTools();
  const download = tools.tools.find((tool) => tool.name === "loomex_artifact_download");
  assert.equal(download?.annotations?.destructiveHint, true);
});

test("state replacement and execution-resuming tools advertise destructive effects", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, {}));
  const client = await connect(runner);
  const tools = await client.listTools();
  const destructive = new Set(
    tools.tools
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name),
  );
  for (const name of [
    "loomex_organization_select",
    "loomex_workflow_update",
    "loomex_workflow_activate",
    "loomex_builder_commit",
    "loomex_builder_respond",
    "loomex_editor_commit",
    "loomex_editor_respond",
    "loomex_editor_finalize",
    "loomex_run_commit",
    "loomex_interaction_respond",
    "loomex_interaction_decide",
    "loomex_artifact_download",
  ]) {
    assert.equal(destructive.has(name), true, `${name} must advertise destructive effects`);
  }
});
