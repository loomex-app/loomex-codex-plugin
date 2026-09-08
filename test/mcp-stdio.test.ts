import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

import { resultSchemaFor } from "../src/result-schemas.js";
import { LocalControlClient, LocalControlError } from "../src/local-control.js";
import {
  APP_CALLABLE_TOOLS,
  REQUIRED_RUNNER_CAPABILITIES,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
} from "../src/tool-catalog.js";
import {
  LOCAL_PROTOCOL,
  MAX_FRAME_BYTES,
  NegotiationParamsSchema,
  NegotiationResultSchema,
  VALIDATION_ERRORS_CAPABILITY,
} from "../src/protocol.js";
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

async function withDirectRunner<T>(runner: FakeRunner, operation: () => Promise<T>): Promise<T> {
  await runner.start();
  const previousStateDir = process.env.LOOMEX_STATE_DIR;
  process.env.LOOMEX_STATE_DIR = runner.stateDir;
  try {
    return await operation();
  } finally {
    if (previousStateDir === undefined) delete process.env.LOOMEX_STATE_DIR;
    else process.env.LOOMEX_STATE_DIR = previousStateDir;
    await runner.stop();
  }
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

  const localContract = JSON.parse(
    await readFile("contracts/local-control.schema.json", "utf8"),
  ) as {
    $defs: {
      validationIssue: {
        properties: Record<string, unknown>;
        allOf: Array<{
          oneOf: Array<{
            properties: Record<string, { const?: unknown }>;
          }>;
        }>;
      };
    };
  };
  const validationIssue = localContract.$defs.validationIssue;
  const validationAlternatives = validationIssue.allOf[0]?.oneOf ?? [];
  assert.equal(validationAlternatives.length, 10);
  assert.equal(new Set(validationAlternatives.map((item) => item.properties.code?.const)).size, 10);
  assert.equal(
    validationAlternatives.every(
      (item) =>
        typeof item.properties.code?.const === "string" &&
        typeof item.properties.message?.const === "string" &&
        typeof item.properties.nextAction?.const === "string",
    ),
    true,
  );
  assert.deepEqual(Object.keys(validationIssue.properties).sort(), [
    "code",
    "message",
    "nextAction",
    "nodeIndex",
  ]);

  const catalog = JSON.parse(await readFile("contracts/method-catalog.json", "utf8")) as {
    capabilities: string[];
    methods: Array<{
      name: string;
      inputSchema: { properties: Record<string, unknown>; required?: string[] };
      outputSchema: {
        oneOf: Array<{ properties: Record<string, unknown>; required?: string[] }>;
      };
    }>;
  };
  const internal = new Set(["daemon.drain", "protocol.negotiate"]);
  const exposed = catalog.methods.filter((method) => !internal.has(method.name));
  assert.deepEqual(
    catalog.methods.filter((method) => internal.has(method.name)).map((method) => method.name).sort(),
    [...internal].sort(),
  );
  assert.deepEqual(
    [...catalog.capabilities].sort(),
    [...REQUIRED_RUNNER_CAPABILITIES, "method:daemon.drain"].sort(),
  );
  assert.equal(catalog.capabilities.includes("method:protocol.negotiate"), false);

  const negotiation = catalog.methods.find((method) => method.name === "protocol.negotiate");
  assert.ok(negotiation);
  assert.equal(
    (negotiation.inputSchema as { additionalProperties?: boolean }).additionalProperties,
    false,
  );
  assert.deepEqual(Object.keys(negotiation.inputSchema.properties).sort(), [
    "requiredCapabilities",
    "supportedProtocols",
  ]);
  assert.deepEqual([...(negotiation.inputSchema.required ?? [])].sort(), [
    "requiredCapabilities",
    "supportedProtocols",
  ]);
  const protocolList = negotiation.inputSchema.properties.supportedProtocols as {
    minItems?: number;
    uniqueItems?: boolean;
    items?: { minLength?: number; maxLength?: number };
  };
  assert.equal(protocolList.minItems, 1);
  assert.equal(protocolList.uniqueItems, true);
  assert.deepEqual(protocolList.items, { type: "string", minLength: 1, maxLength: 160 });
  const capabilityList = negotiation.inputSchema.properties.requiredCapabilities as {
    uniqueItems?: boolean;
    items?: { minLength?: number; maxLength?: number };
  };
  assert.equal(capabilityList.uniqueItems, true);
  assert.deepEqual(capabilityList.items, { type: "string", minLength: 1, maxLength: 160 });
  assert.equal(
    NegotiationParamsSchema.safeParse({
      supportedProtocols: [LOCAL_PROTOCOL, LOCAL_PROTOCOL],
      requiredCapabilities: [],
    }).success,
    false,
  );
  assert.equal(
    NegotiationParamsSchema.safeParse({
      supportedProtocols: [LOCAL_PROTOCOL],
      requiredCapabilities: [],
      extra: true,
    }).success,
    false,
  );
  const negotiationOutput = negotiation.outputSchema.oneOf[0];
  assert.ok(negotiationOutput);
  assert.equal(
    (negotiationOutput as { additionalProperties?: boolean }).additionalProperties,
    false,
  );
  assert.deepEqual(Object.keys(negotiationOutput.properties).sort(), [
    "capabilities",
    "maxFrameBytes",
    "selectedProtocol",
    "serverVersion",
  ]);
  assert.deepEqual(negotiationOutput.properties.selectedProtocol, {
    type: "string",
    const: LOCAL_PROTOCOL,
  });
  assert.deepEqual(negotiationOutput.properties.maxFrameBytes, {
    type: "integer",
    const: MAX_FRAME_BYTES,
  });
  assert.deepEqual(negotiationOutput.properties.serverVersion, { type: "string" });
  assert.deepEqual([...(negotiationOutput.required ?? [])].sort(), [
    "capabilities",
    "maxFrameBytes",
    "selectedProtocol",
    "serverVersion",
  ]);
  const resultCapabilities = negotiationOutput.properties.capabilities as {
    uniqueItems?: boolean;
    items?: { minLength?: number; maxLength?: number };
  };
  assert.equal(resultCapabilities.uniqueItems, true);
  assert.deepEqual(resultCapabilities.items, {
    type: "string",
    minLength: 1,
    maxLength: 160,
  });
  assert.equal(
    NegotiationResultSchema.safeParse({
      selectedProtocol: LOCAL_PROTOCOL,
      capabilities: ["method:status.get", "method:status.get"],
      maxFrameBytes: MAX_FRAME_BYTES,
      serverVersion: "informational",
    }).success,
    false,
  );
  assert.equal(
    NegotiationResultSchema.safeParse({
      selectedProtocol: LOCAL_PROTOCOL,
      capabilities: [],
      maxFrameBytes: MAX_FRAME_BYTES,
      serverVersion: "informational and independently versioned",
    }).success,
    true,
  );
  assert.deepEqual(
    [...new Set(TOOL_DEFINITIONS.map((definition) => definition.rpcMethod))].sort(),
    exposed.map((method) => method.name).sort(),
  );

  for (const definition of TOOL_DEFINITIONS) {
    const method = exposed.find((candidate) => candidate.name === definition.rpcMethod);
    assert.ok(method);
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

test("SDK stdio discovery exposes only the focused 0.2.14 tool catalog", async () => {
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
  assert.equal(names.length, 48);
  assert.equal(names.includes("protocol.negotiate"), false);
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

test("run setup collects schema through a read-only entry point without opening workflow details", async () => {
  const workflowId = "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e";
  const versionId = "4a1e93ec-0b64-4423-89a4-8dbb8bcb189f";
  const inputSchema = { type: "object", properties: { directoryPath: { type: "string" } }, required: ["directoryPath"] };
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, {
    workflow: { id: workflowId, name: "Idea to Implementation" },
    selectedVersion: { id: versionId, versionNumber: 5, definition: { settings: { inputSchema, workspaceInputField: "directoryPath" } } },
    inputSchema,
  }));
  const client = await connect(runner);
  const { tools } = await client.listTools();
  const read = tools.find((tool) => tool.name === "loomex_workflow_get");
  const view = tools.find((tool) => tool.name === "loomex_workflow_view");
  const setup = tools.find((tool) => tool.name === "loomex_run_setup");
  assert.deepEqual(read?._meta?.ui, { visibility: ["model", "app"] });
  assert.equal(read?._meta?.["openai/outputTemplate"], undefined);
  assert.deepEqual(view?._meta?.ui, { visibility: ["model"], resourceUri: "ui://loomex/authoring.html" });
  assert.deepEqual(setup?._meta?.ui, { visibility: ["model", "app"], resourceUri: "ui://loomex/prepare.html" });
  assert.equal(setup?.annotations?.readOnlyHint, true);
  for (const tool of tools) {
    const allowed = APP_CALLABLE_TOOLS.has(tool.name);
    assert.equal(tool._meta?.["openai/widgetAccessible"], allowed);
    assert.deepEqual((tool._meta?.ui as { visibility: string[] }).visibility, allowed ? ["model", "app"] : ["model"]);
  }
  assert.equal(APP_CALLABLE_TOOLS.has("loomex_run_commit"), true);
  assert.equal(APP_CALLABLE_TOOLS.has("loomex_workspace_grant"), true);
  assert.equal(APP_CALLABLE_TOOLS.has("loomex_workflow_update"), false);
  const result = await client.callTool({ name: "loomex_run_setup", arguments: { workflowId, version: "5" } });
  const output = result.structuredContent as { ok: boolean; data: { inputSchema: unknown } };
  assert.equal(output.ok, true, JSON.stringify(result));
  assert.deepEqual(output.data.inputSchema, inputSchema);
  assert.equal(runner.requests.length, 1);
  assert.equal(runner.requests[0]?.method, "workflows.get");
  assert.deepEqual(runner.requests[0]?.params, { workflowId, version: "5" });
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
  assert.equal(runner.negotiations.length, 1);
  assert.equal(runner.negotiations[0]?.connectionId, runner.requests[0]?.connectionId);
  assert.deepEqual(runner.negotiations[0]?.params.supportedProtocols, [LOCAL_PROTOCOL]);
  assert.deepEqual(
    runner.negotiations[0]?.params.requiredCapabilities,
    [...REQUIRED_RUNNER_CAPABILITIES],
  );
});

test("missing negotiated capabilities deny a mutation before its action frame", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner(
    (request, socket) => runner.respond(socket, request, {}),
    { capabilities: [] },
  );
  const client = await connect(runner);
  const result = await client.callTool({
    name: "loomex_workflow_create",
    arguments: {
      name: "Must not be created",
      idempotencyKey: "33937720-ea1a-4c06-adcc-095bb3693f5f",
    },
  });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, true);
  assert.equal((structured.error as Record<string, unknown>).code, "COMPATIBILITY_ERROR");
  assert.equal(runner.negotiations.length, 1);
  assert.equal(runner.requests.length, 0);
});

test("a runner without actionable validation errors is rejected before mutation send", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner(
    (request, socket) => runner.respond(socket, request, {}),
    {
      capabilities: REQUIRED_RUNNER_CAPABILITIES.filter(
        (capability) => capability !== VALIDATION_ERRORS_CAPABILITY,
      ),
    },
  );
  const client = await connect(runner);
  const result = await client.callTool({
    name: "loomex_workflow_create",
    arguments: {
      name: "Must not be created",
      idempotencyKey: "33937720-ea6d-439c-8335-93efb4e4ce42",
    },
  });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, true);
  assert.equal((structured.error as Record<string, unknown>).code, "COMPATIBILITY_ERROR");
  assert.equal(runner.negotiations.length, 1);
  assert.equal(runner.requests.length, 0);
});

test("a different runner release is accepted when its negotiated contract is compatible", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner(
    (request, socket) =>
      runner.respond(socket, request, {
        version: "9.0.0",
        protocol: LOCAL_PROTOCOL,
        activeJobs: 0,
        draining: false,
        updateDeferred: false,
      }),
    { serverVersion: "9.0.0" },
  );
  const client = await connect(runner);
  const result = await client.callTool({ name: "loomex_readiness", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(runner.requests.length, 1);
});

test("an incompatible negotiated frame bound denies the action frame", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner(
    (request, socket) => runner.respond(socket, request, {}),
    { maxFrameBytes: MAX_FRAME_BYTES / 2 },
  );
  const client = await connect(runner);
  const result = await client.callTool({ name: "loomex_readiness", arguments: {} });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, true);
  assert.equal((structured.error as Record<string, unknown>).code, "COMPATIBILITY_ERROR");
  assert.equal(runner.negotiations.length, 1);
  assert.equal(runner.requests.length, 0);
});

test("an incompatible selected protocol denies the action frame", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner(
    (request, socket) => runner.respond(socket, request, {}),
    { selectedProtocol: "loomex.local-control/v3" },
  );
  const client = await connect(runner);
  const result = await client.callTool({ name: "loomex_readiness", arguments: {} });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, true);
  assert.equal((structured.error as Record<string, unknown>).code, "COMPATIBILITY_ERROR");
  assert.equal(runner.negotiations.length, 1);
  assert.equal(runner.requests.length, 0);
});

test("unsolicited bytes after negotiation deny a mutation before its action frame", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner(
    (request, socket) => runner.respond(socket, request, {}),
    { negotiationTrailingFrame: "\n" },
  );
  const client = await connect(runner);
  const result = await client.callTool({
    name: "loomex_workflow_create",
    arguments: {
      name: "Must not be created",
      idempotencyKey: "e70644f1-e65a-46f8-ad44-31e6fa17d175",
    },
  });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, true);
  assert.equal((structured.error as Record<string, unknown>).code, "INVALID_RESPONSE");
  assert.equal(runner.negotiations.length, 1);
  assert.equal(runner.requests.length, 0);
});

test("a mutation deadline while negotiation is pending sends no action and is not retried", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner(
    (request, socket) => runner.respond(socket, request, {}),
    { holdNegotiation: true },
  );
  await withDirectRunner(runner, async () => {
    const client = new LocalControlClient();
    await assert.rejects(
      client.call(
        "workflows.create",
        {
          name: "Must not be created",
          idempotencyKey: "07586a1b-18e0-471e-83c9-06ac38611a9a",
        },
        { mutating: true, timeoutMs: 25 },
      ),
      (error: unknown) =>
        error instanceof LocalControlError && error.code === "RUNNER_UNAVAILABLE",
    );
  });
  assert.equal(runner.negotiations.length, 1);
  assert.equal(runner.requests.length, 0);
});

test("aborting after a mutation action is sent preserves its ambiguous key", async () => {
  const controller = new AbortController();
  const runner = new FakeRunner(() => {
    controller.abort();
  });
  const idempotencyKey = "5ea2ac29-f4aa-45bf-ae92-bef8f721b68b";
  await withDirectRunner(runner, async () => {
    const client = new LocalControlClient();
    await assert.rejects(
      client.call(
        "workflows.create",
        { name: "Unknown outcome", idempotencyKey },
        { mutating: true, signal: controller.signal, timeoutMs: 1_000 },
      ),
      (error: unknown) =>
        error instanceof LocalControlError &&
        error.code === "NETWORK_AMBIGUOUS" &&
        error.idempotencyKey === idempotencyKey,
    );
  });
  assert.equal(runner.negotiations.length, 1);
  assert.equal(runner.requests.length, 1);
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
  assert.doesNotMatch(String(secretContent[0]?.text ?? ""), /Loomex 0\.1\.0/);
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
  assert.equal(runner.negotiations.length, 1);
});

test("a malformed post-mutation response stays ambiguous and retains its key", async () => {
  const runner = new FakeRunner((_request, socket) => {
    socket.end("{}\n");
  });
  const client = await connect(runner);
  const idempotencyKey = "c2969b0b-24cc-40c6-bea8-e333b534c257";
  const result = await client.callTool({
    name: "loomex_workflow_create",
    arguments: { name: "Ambiguous response", idempotencyKey },
  });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, true);
  assert.equal(structured.idempotencyKey, idempotencyKey);
  assert.equal((structured.error as Record<string, unknown>).code, "NETWORK_AMBIGUOUS");
  assert.equal(runner.negotiations.length, 1);
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
  assert.equal(runner.negotiations.length, 2);
  assert.notEqual(runner.requests[0]?.id, runner.requests[1]?.id);
  assert.notEqual(runner.requests[0]?.connectionId, runner.requests[1]?.connectionId);
  assert.equal(runner.negotiations[0]?.connectionId, runner.requests[0]?.connectionId);
  assert.equal(runner.negotiations[1]?.connectionId, runner.requests[1]?.connectionId);
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

for (const [code, retryable, expected] of [
  ["EXECUTION_BINDING_CONFLICT", false, /Review a new preparation/],
  ["PREPARATION_NOT_FOUND", false, /no longer available/],
  ["MODEL_CATALOG_UNAVAILABLE", true, /AI model catalog is temporarily unavailable/],
] as const) {
  test(`run start ${code} has safe actionable text and retains its machine contract`, async () => {
    const runner = new FakeRunner((request, socket) => {
      runner.error(socket, request, code, "private-backend-diagnostic", retryable);
    });
    const client = await connect(runner);
    const result = await client.callTool({ name: "loomex_run_commit", arguments: {
      preparationId: "733ccce0-6fc0-4fe2-93fb-5c2114878103",
      bindingDigest: "a".repeat(64),
      confirmationKey: "d45fcb14-0d41-4f1f-98c1-54c6eeae268c",
      idempotencyKey: "5b5f356a-208f-4af8-83ec-6e3f3637541a",
    } });
    const error = (result.structuredContent as { error: Record<string, unknown> }).error;
    assert.equal(result.isError, true);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    assert.match(String(error.message), expected);
    assert.doesNotMatch(JSON.stringify(result), /private-backend-diagnostic/);
    assert.equal(runner.requests.length, 1);
  });
}

test("safe run validation issues remain actionable across local control", async () => {
  const runner = new FakeRunner((request, socket) => {
    runner.error(
      socket,
      request,
      "RUN_VALIDATION_FAILED",
      "Bearer backend-message-must-not-cross",
      false,
      {
        validationIssueVersion: "v1",
        validationIssues: [
          {
            code: "RUN_VALIDATION_PROVIDER_UNSUPPORTED",
            message:
              "The selected provider does not support a required workflow capability.",
            nextAction: "choose_supported_provider",
            nodeIndex: 2,
          },
        ],
      },
    );
  });
  const client = await connect(runner);
  const result = await client.callTool({ name: "loomex_readiness", arguments: {} });
  const structured = result.structuredContent as Record<string, unknown>;
  const error = structured.error as Record<string, unknown>;

  assert.equal(result.isError, true);
  assert.equal(error.code, "RUN_VALIDATION_FAILED");
  assert.equal(
    error.message,
    "The workflow cannot start until its validation issues are fixed.",
  );
  assert.equal(error.validationIssueVersion, "v1");
  assert.deepEqual(error.validationIssues, [
    {
      code: "RUN_VALIDATION_PROVIDER_UNSUPPORTED",
      message: "The selected provider does not support a required workflow capability.",
      nextAction: "choose_supported_provider",
      nodeIndex: 2,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /backend-message-must-not-cross/);
});

test("untrusted validation details fail closed without leaking runner values", async () => {
  const runner = new FakeRunner((request, socket) => {
    runner.error(
      socket,
      request,
      "RUN_VALIDATION_FAILED",
      "Bearer outer-secret",
      false,
      {
        validationIssueVersion: "v1",
        validationIssues: [
          {
            code: "RUN_VALIDATION_PROVIDER_UNSUPPORTED",
            message: "Bearer nested-secret",
            nextAction: "send_token_elsewhere",
            nodeIndex: 2,
            nodeId: "11111111-1111-4111-8111-111111111111",
            nodeName: "Token secret-node-name",
          },
        ],
      },
    );
  });
  const client = await connect(runner);
  const result = await client.callTool({ name: "loomex_readiness", arguments: {} });
  const serialized = JSON.stringify(result);
  const structured = result.structuredContent as Record<string, unknown>;

  assert.equal(result.isError, true);
  assert.equal((structured.error as Record<string, unknown>).code, "INVALID_RESPONSE");
  assert.doesNotMatch(serialized, /outer-secret|nested-secret|secret-node-name|send_token/);
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
      execution: { id: runId, status: "waiting", name: "Exact run", input: { token: "never-print-summary-token" } },
      humanRequest: { id: "aa7843c2-7694-426a-ae51-fbc3af88d415", status: "pending", type: "long_text", execution: { id: runId },
        inputSpec: { inputType: "long_text", question: "Describe your idea" } },
      waitState: "human_action_required",
      automation: null,
      runner: { id: "runner-summary-id", status: "online", name: "Runner summary name" },
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
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  const summary = JSON.parse(text);
  assert.deepEqual(summary.execution, { id: runId, status: "waiting", name: "Exact run" });
  assert.equal(summary.humanRequest.id, "aa7843c2-7694-426a-ae51-fbc3af88d415");
  assert.equal(summary.humanRequest.inputSpec.question, "Describe your idea");
  assert.equal(summary.nextAction.tool, "loomex_interaction_get");
  assert.doesNotMatch(text, /runner-summary-id|online|Runner summary name|never-print-summary-token/);
});

test("run projections preserve authoritative seven-type input specs for UI and headless clients", async () => {
  const runId = "5e06cb51-c39e-485b-83ca-c2f2d12b1eb8";
  const inputSpec = {
    schemaVersion: "loomex.human-input/v2",
    collectionMode: "batch",
    inputType: "text",
    question: "Complete every question",
    questions: [
      { id: "plain", inputType: "text", question: "Short answer?", options: [], allowOther: false, otherLabel: "Other" },
      { id: "details", inputType: "long_text", question: "Detailed answer?", options: [], allowOther: false, otherLabel: "Other" },
      { id: "due", inputType: "date", question: "Due date?", options: [], allowOther: false, otherLabel: "Other" },
      { id: "score", inputType: "rating", question: "Score?", options: [], allowOther: false, otherLabel: "Other", minimum: 0, maximum: 5 },
      { id: "enabled", inputType: "boolean", question: "Enable it?", options: [], allowOther: false, otherLabel: "Other" },
      { id: "choice", inputType: "radio", question: "Choose one?", options: [{ id: "a", label: "A" }], allowOther: true, otherLabel: "Another" },
      { id: "features", inputType: "checkbox", question: "Choose several?", options: [{ id: "a", label: "A" }], allowOther: true, otherLabel: "Another" },
    ],
  };
  const runner = new FakeRunner((request, socket) => {
    runner.respond(socket, request, {
      execution: { id: runId },
      humanRequest: {
        id: "63f4d335-0280-4e80-9fb8-7036072cc5e5",
        title: "Mixed input",
        description: "Seven supported question types",
        prompt: "Complete every question",
        inputSpec,
        responseSchema: {
          type: "object",
          properties: { answers: { type: "array" } },
          required: ["answers"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { answers: { type: "array" } },
          required: ["answers"],
          additionalProperties: false,
        },
        workflowOutputSchema: { type: "object" },
      },
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
  const request = ((structured.data as Record<string, unknown>).humanRequest as Record<string, unknown>);
  assert.equal(result.isError, undefined);
  assert.deepEqual(request.inputSpec, inputSpec);
  assert.deepEqual(Object.keys(request).sort(), [
    "description",
    "id",
    "inputSpec",
    "outputSchema",
    "prompt",
    "responseSchema",
    "title",
    "workflowOutputSchema",
  ]);
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
  assert.equal(resources.resources.length, 5);
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
    assert.match(text, /request\.inputSpec/);
    assert.match(text, /long_text/);
    assert.match(text, /validDate/);
    assert.match(text, /questionId/);
    assert.doesNotMatch(text, /id="diagnostics"|id="state"|json-answer/);
    assert.match(text, /!properties \|\| !supported/);
    assert.match(text, /mutationKeys/);
    assert.match(text, /mutationOperations/);
    assert.match(text, /immutableCopy/);
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

test("workflow listing attaches browser metadata and preserves the initial search on remount", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, { workflows: [], nextCursor: null }));
  const client = await connect(runner);
  const tools = await client.listTools();
  const listing = tools.tools.find((tool) => tool.name === "loomex_workflows_list");
  assert.match(String((listing?._meta?.ui as { resourceUri: string }).resourceUri), /browser\.html/);
  const result = await client.callTool({ name: "loomex_workflows_list", arguments: { query: "idea", limit: 20 } });
  assert.deepEqual(result._meta?.["loomex/workflowListQuery"], { query: "idea", limit: 20 });
});


test("stable UI resources resolve previously shipped cached references only", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, {}));
  const client = await connect(runner);
  const resources = await client.listResources();
  assert.equal(resources.resources.length, 5);
  for (const resource of resources.resources) assert.match(resource.uri, /^ui:\/\/loomex\/[a-z]+\.html$/);
  for (const mode of ["authoring", "prepare", "monitor", "interaction", "browser"]) {
    const uri = `ui://loomex/${mode}-${mode === "browser" ? "0.2.7" : "0.2.3"}.html`;
    const result = await client.readResource({ uri });
    assert.equal(result.contents[0]?.uri, uri);
    const content = result.contents[0];
    assert.match(content && "text" in content ? content.text : "", new RegExp(`data-mode="${mode}"`));
    assert.equal(runner.requests.length, 0);
  }
  await assert.rejects(client.readResource({ uri: "ui://loomex/authoring-99.0.0.html" }));
  await assert.rejects(client.readResource({ uri: "ui://loomex/unknown-0.2.3.html" }));
  await assert.rejects(client.readResource({ uri: "ui://loomex/browser-0.2.3.html" }));
});
