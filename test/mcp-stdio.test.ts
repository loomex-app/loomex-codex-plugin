import packageMetadata from "../package.json" with { type: "json" };
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
import { renderUiHtml } from "../src/ui-template.js";
import {
  AUTHORING_UI_URI,
  BROWSER_UI_URI,
  CONNECTION_UI_URI,
  INTERACTION_UI_URI,
  MONITOR_UI_URI,
  ORGANIZATIONS_UI_URI,
  PREPARE_UI_URI,
  RUNS_UI_URI,
  UI_RESOURCE_REVISION,
} from "../src/ui-resources.js";
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
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, packageMetadata.version);
  } catch (error) {
    await transport.close();
    await runner.stop();
    throw error;
  }
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
  // The lifecycle hook is a separately negotiated local control consumer, not
  // an MCP tool. Keep it in the runner contract without making every MCP
  // request depend on hook support.
  const internal = new Set(["daemon.drain", "protocol.negotiate", "follow.session.lifecycle"]);
  const exposed = catalog.methods.filter((method) => !internal.has(method.name));
  assert.deepEqual(
    catalog.methods.filter((method) => internal.has(method.name)).map((method) => method.name).sort(),
    [...internal].sort(),
  );
  assert.deepEqual(
    [...catalog.capabilities].sort(),
    [...REQUIRED_RUNNER_CAPABILITIES, "method:daemon.drain", "method:follow.session.lifecycle", "follow.session.lifecycle/v1", "error.recovery/v1"].sort(),
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
    const localOnly = new Set(definition.localOnlyInputKeys ?? []);
    for (const key of localOnly) {
      assert.equal(Object.hasOwn(input.properties, key), true, `${definition.name} declares an unknown local-only field ${key}`);
      assert.equal(input.required?.includes(key) ?? false, key === "taskContext",
        `${definition.name} local-only field ${key} has the wrong requiredness`);
    }
    const runnerName = (key: string) => definition.runnerInputAliases?.[key] ?? key;
    const omitted = new Set(definition.omittedRunnerInputKeys ?? []);
    assert.deepEqual(Object.keys(input.properties).filter((key) => !localOnly.has(key)).map(runnerName).sort(),
      Object.keys(method.inputSchema.properties).filter((key) => !omitted.has(key)).sort());
    assert.deepEqual([...(input.required ?? [])].filter((key) => !localOnly.has(key)).map(runnerName).sort(),
      [...(method.inputSchema.required ?? [])].filter((key) => !omitted.has(key)).sort());

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
    const variants = output.anyOf.flatMap(variant => (variant as typeof primary & {anyOf?: typeof output.anyOf}).anyOf ?? [variant]);
    assert.equal(variants.length, method.outputSchema.oneOf.length, `${method.name} result variants`);
    for (const [index, variant] of variants.entries()) {
      assert.equal(variant.additionalProperties, false);
      assert.deepEqual(Object.keys(variant.properties).sort(), Object.keys(method.outputSchema.oneOf[index]?.properties ?? {}).sort());
      assert.deepEqual([...(variant.required ?? [])].sort(), [...(method.outputSchema.oneOf[index]?.required ?? [])].sort());
    }
  }
});

test("literal UI tool invocations use the app-callable catalog", async () => {
  // The authored HTML is now a shell which receives the generated browser
  // application at render time. Inspect the actual browser document so this
  // contract continues to cover every literal app call after extraction.
  const source = renderUiHtml("browser");
  const invocations = [...source.matchAll(/(?:callTool|browserRead|runFlowMutation|callMutation|callVerifiedInteractionMutation)\("(loomex_[a-z_]+)"/g)];
  assert.ok(invocations.length > 0);
  for (const [, name] of invocations) {
    assert.ok(name);
    assert.ok(APP_CALLABLE_TOOLS.has(name), `${name} is not available to MCP Apps`);
  }
});

test("SDK stdio discovery exposes only the focused tool catalog", async () => {
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
  assert.equal(names.length, TOOL_NAMES.length);
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
    if ((tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri || [
      "loomex_workflows_list",
      "loomex_runs_list",
      "loomex_run_get",
      "loomex_run_wait",
      "loomex_run_events",
      "loomex_run_result",
      "loomex_interactions_list",
      "loomex_interaction_get",
    ].includes(tool.name)) {
      assert.equal(dataSchema?.type, "object", `${tool.name}: App projection is a JSON object`);
      continue;
    }
    assert.equal(resultAlternatives?.length, 2);
    const objectVariants = (schema: Record<string, unknown>): Array<Record<string, unknown>> => {
      const branches = (schema.anyOf ?? schema.oneOf) as Array<Record<string, unknown>> | undefined;
      return branches ? branches.flatMap(objectVariants) : [schema];
    };
    for (const schema of resultAlternatives!.flatMap(objectVariants)) {
      assert.equal(schema.type, "object", `${tool.name}: result variant must be an object`);
      assert.equal(schema.additionalProperties, false, `${tool.name}: result variant must remain strict`);
    }
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
  assert.deepEqual(view?._meta?.ui, { visibility: ["model"], resourceUri: AUTHORING_UI_URI });
  assert.deepEqual(setup?._meta?.ui, { visibility: ["model", "app"], resourceUri: PREPARE_UI_URI });
  assert.equal(setup?.annotations?.readOnlyHint, true);
  for (const tool of tools) {
    const allowed = APP_CALLABLE_TOOLS.has(tool.name);
    const appOnly = TOOL_DEFINITIONS.find((definition) => definition.name === tool.name)?.appOnly === true;
    assert.equal(tool._meta?.["openai/widgetAccessible"], allowed);
    assert.deepEqual((tool._meta?.ui as { visibility: string[] }).visibility, appOnly ? ["app"] : allowed ? ["model", "app"] : ["model"]);
  }
  assert.equal(APP_CALLABLE_TOOLS.has("loomex_run_commit"), true);
  assert.equal(APP_CALLABLE_TOOLS.has("loomex_workspace_grant"), true);
  assert.equal(APP_CALLABLE_TOOLS.has("loomex_workflow_update"), false);
  const issue = tools.find((tool) => tool.name === "loomex_run_start_handoff_issue");
  assert.deepEqual(issue?._meta?.ui, { visibility: ["app"] });
  assert.equal(issue?.annotations?.idempotentHint, false);
  const approve = tools.find((tool) => tool.name === "loomex_run_start_handoff_approve");
  assert.deepEqual(approve?._meta?.ui, { visibility: ["app"] });
  assert.equal(approve?.annotations?.idempotentHint, false);
  assert.equal(tools.some((tool) => tool.name === "loomex_run_start_handoff_resume"), false);
  const result = await client.callTool({ name: "loomex_run_setup", arguments: {
    workflowId,
    version: "5",
    taskContext: { cwd: "/Users/example/current-task" },
    workspacePath: "/Users/example/chosen-workspace",
  } });
  const output = result._meta?.["loomex/uiData"] as { ok: boolean; data: { inputSchema: unknown } };
  assert.equal(output.ok, true, JSON.stringify(result));
  assert.deepEqual(output.data.inputSchema, inputSchema);
  assert.equal(runner.requests.filter(request => !request.method.startsWith("presentation.")).length, 1);
  assert.equal(runner.requests[0]?.method, "workflows.get");
  assert.deepEqual(runner.requests[0]?.params, { workflowId, version: "5" });
  assert.deepEqual(result._meta?.["loomex/taskWorkspace"], {
    taskContext: { cwd: "/Users/example/current-task" },
    workspacePath: "/Users/example/chosen-workspace",
  });
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

test("preparation entry points reject inline provider credentials while allowing provider settings", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, {}));
  const client = await connect(runner);
  const workflowId = "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e";
  const versionId = "4a1e93ec-0b64-4423-89a4-8dbb8bcb189f";
  const baseArguments = {
    loomex_builder_prepare: { prompt: "Build a workflow", workspacePath: "/Users/example/project" },
    loomex_editor_prepare: { workflowId, prompt: "Edit a workflow", workspacePath: "/Users/example/project" },
    loomex_run_prepare: { workflowId, versionId, workspacePath: "/Users/example/project" },
  } as const;
  const credentialFields = ["apiKey", "api_key", "password", "privateKey", "accessKey"] as const;

  for (const [toolName, argumentsForTool] of Object.entries(baseArguments)) {
    const definition = TOOL_DEFINITIONS.find(({ name }) => name === toolName);
    assert.ok(definition);
    assert.equal(definition.inputSchema.safeParse({
      ...argumentsForTool,
      idempotencyKey: "09b02c0b-07cc-4d62-9909-fab10f575f0e",
      providerConfiguration: { codex: { model: "gpt-6", effort: "high" } },
    }).success, true, `${toolName} keeps non-secret provider settings`);

    for (const credentialField of credentialFields) {
      const credentialValue = `must-not-forward-${credentialField}`;
      const result = await client.callTool({
        name: toolName,
        arguments: {
          ...argumentsForTool,
          idempotencyKey: "09b02c0b-07cc-4d62-9909-fab10f575f0e",
          providerConfiguration: { codex: { [credentialField]: credentialValue } },
        },
      });
      assert.equal(result.isError, true, `${toolName} rejects ${credentialField}`);
      const text = String((result.content as Array<{ text?: string }>)[0]?.text ?? "");
      assert.match(text, /provider authentication/i);
      assert.doesNotMatch(text, new RegExp(credentialValue));
    }
  }
  assert.equal(runner.requests.length, 0, "invalid provider credentials never reach the runner");
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

test("definitive workflow authoring rejection remains definitive across local control", async () => {
  const runner = new FakeRunner((request, socket) => {
    runner.error(socket, request, "WORKFLOW_AUTHORING_INVALID", "Untrusted summary", false, {
      authoringIssueVersion: "v1",
      authoringIssues: [
        {
          code: "WORKFLOW_DEFINITION_INVALID",
          path: "$.nodes[1].inputs.answer",
          message: "The source field is not defined.",
        },
      ],
    });
  });
  const client = await connect(runner);
  const result = await client.callTool({ name: "loomex_workflow_create", arguments: {
    name: "Invalid",
    definition: { nodes: [], transitions: [] },
    idempotencyKey: "0b90bcfa-3508-45af-b269-c167d2613ab6",
  } });
  const error = (result.structuredContent as { error: Record<string, unknown> }).error;

  assert.equal(result.isError, true);
  assert.equal(error.code, "WORKFLOW_AUTHORING_INVALID");
  assert.equal(error.outcome, "rejected");
  assert.equal(error.recovery, "correct_input");
  assert.equal(error.authoringIssueVersion, "v1");
  assert.deepEqual(error.authoringIssues, [{
    code: "WORKFLOW_DEFINITION_INVALID",
    path: "$.nodes[1].inputs.answer",
    message: "The source field is not defined.",
  }]);
  assert.doesNotMatch(String(error.message), /network|unknown/i);
});

test("workflow operation reconciliation preserves the exact operation and key", async () => {
  const idempotencyKey = "99d68a8f-e10c-4e9c-ad63-d0f257cd2d17";
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => {
    assert.equal(request.method, "workflow.operations.get");
    assert.deepEqual(request.params, { operation: "workflows.create", idempotencyKey });
    runner.respond(socket, request, {
      operation: "workflows.create",
      idempotencyKey,
      status: "completed",
      response: { workflowId: "591f2e31-a247-4e70-90ef-43a44ff866d4" },
    });
  });
  const client = await connect(runner);
  const result = await client.callTool({
    name: "loomex_workflow_operation_get",
    arguments: { operation: "workflows.create", idempotencyKey },
  });
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as { data: Record<string, unknown> }).data.status, "completed");
  assert.equal(runner.requests.length, 1);
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
  const organizationId = "6a171e87-ce3c-47fd-ab45-715c4b14e646";
  const runner = new FakeRunner((request, socket) => {
    runner.respond(socket, request, {
      execution: { id: runId, organizationId, status: "waiting", name: "Exact run", input: { token: "never-print-summary-token" } },
      humanRequest: { id: "aa7843c2-7694-426a-ae51-fbc3af88d415", status: "pending", type: "long_text", execution: { id: runId },
        organizationId, inputSpec: { inputType: "long_text", question: "Describe your idea" } },
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
  assert.equal(summary.nextAction.tool, "loomex_interaction_view");
  assert.doesNotMatch(text, /runner-summary-id|online|Runner summary name|never-print-summary-token/);
});

test("run projections bound question previews while visual hydration preserves canonical input specs", async () => {
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
  const request = ((structured.data as Record<string, unknown>).humanRequest as Record<string, any>);
  assert.equal(result.isError, undefined);
  assert.equal(request.inputSpec.questionCount, 7);
  assert.deepEqual(request.inputSpec.questions.map((question: Record<string, unknown>) => question.inputType),
    ["text", "long_text", "date", "rating", "boolean", "radio", "checkbox"]);
  assert.equal(request.responseSchema, undefined);

  const view = await client.callTool({ name: "loomex_run_view", arguments: { runId } });
  const canonical = view._meta?.["loomex/uiData"] as Record<string, any>;
  assert.deepEqual(canonical.data.humanRequest.inputSpec, inputSpec);
  assert.equal((view.structuredContent as Record<string, any>).data.humanRequest.responseSchema, undefined);
});

test("run reads exclude node history, previous outputs, event payloads, and AI trace from both model channels", async () => {
  const runId = "5e06cb51-c39e-485b-83ca-c2f2d12b1eb8";
  const privateMarker = "previous-node-output-must-remain-component-only";
  const canonical = {
    execution: {
      id: runId,
      status: "running",
      workflowName: "Bounded polling",
      nodeHistory: Array.from({ length: 100 }, (_, index) => ({ index, output: privateMarker.repeat(100) })),
      previousOutputs: { completed: privateMarker.repeat(500) },
    },
    humanRequest: null,
    automation: { previousOutputs: privateMarker.repeat(500) },
    runner: { history: privateMarker.repeat(500) },
    events: Array.from({ length: 20 }, (_, sequence) => ({ sequence, payload: privateMarker.repeat(100) })),
    aiTrace: { messages: privateMarker.repeat(500) },
    builderSession: { priorOutput: privateMarker.repeat(500) },
    editResult: { priorOutput: privateMarker.repeat(500) },
    latestSequence: 19,
    hasMoreEvents: false,
    timedOut: false,
    details: { history: privateMarker.repeat(500) },
  };
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, canonical));
  const client = await connect(runner);

  for (const name of ["loomex_run_get", "loomex_run_wait", "loomex_run_events", "loomex_run_result"] as const) {
    const result = await client.callTool({ name, arguments: { runId } });
    const modelPayload = JSON.stringify({ content: result.content, structuredContent: result.structuredContent });
    assert.ok(modelPayload.length < 5_000, `${name}: run read should stay bounded`);
    assert.doesNotMatch(modelPayload, new RegExp(privateMarker));
    if (name === "loomex_run_get") {
      assert.match(JSON.stringify(result._meta?.["loomex/uiData"]), new RegExp(privateMarker),
        `${name}: app-callable reads retain canonical component hydration`);
    } else {
      assert.equal(result._meta?.["loomex/uiData"], undefined,
        `${name}: model-only polls do not attach canonical component hydration`);
    }
    assert.equal((result.structuredContent as Record<string, any>).data.eventCount, 20);
  }

  const view = await client.callTool({ name: "loomex_run_view", arguments: { runId } });
  const modelPayload = JSON.stringify({ content: view.content, structuredContent: view.structuredContent });
  assert.doesNotMatch(modelPayload, new RegExp(privateMarker));
  assert.match(JSON.stringify(view._meta?.["loomex/uiData"]), new RegExp(privateMarker));
});

test("compact run result projections preserve response spool continuation", async () => {
  const runId = "5e06cb51-c39e-485b-83ca-c2f2d12b1eb8";
  const responseRef = "8081f734-5175-492b-b412-b1d88d8e3a7d";
  const spool = {
    responseRef,
    sizeBytes: 2_000_000,
    encoding: "json",
    nextOffset: 0,
    checksumSha256: "a".repeat(64),
  };
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, spool));
  const client = await connect(runner);
  const result = await client.callTool({ name: "loomex_run_result", arguments: { runId } });
  const data = (result.structuredContent as Record<string, any>).data;
  assert.deepEqual(data, {
    ...spool,
    originatingOperationComplete: true,
    doNotReplayOriginatingOperation: true,
    nextAction: { tool: "loomex_response_read", arguments: { responseRef, offset: 0 } },
  });
  const text = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  assert.equal(text.responseRef, responseRef);
  assert.deepEqual(text.nextAction, { tool: "loomex_response_read", arguments: { responseRef, offset: 0 } });
  assert.equal(result._meta?.["loomex/uiData"], undefined);
});

test("interaction routing categories are explicit and never accepted on answer submission", async () => {
  const runId = "adc7b3ba-1979-47d2-ac14-638ed91c5f82";
  const requestId = "8081f734-5175-492b-b412-b1d88d8e3a7d";
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, {
    humanRequests: [], nextCursor: null, executionId: runId, details: {},
  }));
  const client = await connect(runner);
  const { tools } = await client.listTools();
  const listProperties = tools.find(({ name }) => name === "loomex_interactions_list")?.inputSchema.properties as Record<string, unknown>;
  const respondProperties = tools.find(({ name }) => name === "loomex_interaction_respond")?.inputSchema.properties as Record<string, unknown>;
  assert.equal("requestType" in listProperties, false);
  assert.equal("requestType" in respondProperties, false);
  assert.equal("interactionCategory" in listProperties, true);

  await client.callTool({ name: "loomex_interactions_list", arguments: { runId, interactionCategory: "human" } });
  assert.deepEqual(runner.requests.at(-1)?.params, { runId, requestType: "human" });

  const requestCount = runner.requests.length;
  const invalidResponse = await client.callTool({ name: "loomex_interaction_respond", arguments: {
    requestId,
    answer: { value: "answer" },
    requestType: "long_text",
    idempotencyKey: "c159321d-a4f0-400e-8934-7599e58e9ff4",
  } });
  assert.equal(invalidResponse.isError, true);
  assert.equal(runner.requests.length, requestCount);
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
  assert.equal(resources.resources.length, 8);
  for (const resource of resources.resources) {
    const result = await client.readResource({ uri: resource.uri });
    const content = result.contents[0];
    const text = content !== undefined && "text" in content ? content.text : "";
    assert.match(text, /ui\/initialize/);
    assert.match(text, /tools\/call/);
    assert.match(text, /Content-Security-Policy/);
    assert.doesNotMatch(text, /__LOOMEX_DESIGN_SYSTEM__/);
    for (const style of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      assert.doesNotMatch(style[1]!, /@import\s|url\(/, "styles must remain offline");
    }
    assert.doesNotMatch(text, /<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)\s*=/i);
    assert.match(text, /--color-brand-teal/);
    assert.match(text, /\.btn-primary/);
    assert.doesNotMatch(text, /window\.openai/);
    // Bundled validators may contain documentation URLs. Offline behavior is
    // enforced by resource policy and inline-only assets, not arbitrary strings.
    assert.match(text, /default-src 'none'/);
    assert.match(text, /connect-src[^;]*127\.0\.0\.1/);
    assert.doesNotMatch(text, /connect-src[^;]*(?:https?:\/\/(?!127\.0\.0\.1)[^\s;]+)/);
    assert.match(text, /frame-src 'none'/);
    assert.match(text, /form-action 'none'/);
    assert.match(text, /startLoomexApp/);
    assert.doesNotMatch(text, /id="diagnostics"|id="state"|json-answer/);
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

test("workflow views route task workspace metadata without changing runner requests", async () => {
  const workflowId = "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e";
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, request.method === "workflows.list"
    ? { workflows: [], nextCursor: null }
    : { workflow: { id: workflowId }, selectedVersion: { id: "8b29c880-1c68-4d47-a1ff-477ab28d3c49" } }));
  const client = await connect(runner);
  const tools = await client.listTools();
  const listing = tools.tools.find((tool) => tool.name === "loomex_workflows_view");
  assert.equal((listing?._meta?.ui as { resourceUri: string }).resourceUri, BROWSER_UI_URI);
  const taskContext = { cwd: "/Users/example/current-task" };
  const result = await client.callTool({ name: "loomex_workflows_view", arguments: { query: "idea", limit: 20, taskContext } });
  assert.deepEqual(result._meta?.["loomex/workflowListQuery"], { query: "idea", limit: 20 });
  assert.deepEqual(result._meta?.["loomex/taskWorkspace"], { taskContext });
  assert.deepEqual(runner.requests.filter(request => !request.method.startsWith("presentation.")).at(-1)?.params, { query: "idea", limit: 20 });

  const detail = await client.callTool({ name: "loomex_workflow_view", arguments: { workflowId, taskContext } });
  assert.deepEqual(detail._meta?.["loomex/taskWorkspace"], { taskContext });
  assert.deepEqual(runner.requests.filter(request => !request.method.startsWith("presentation.")).at(-1)?.params, { workflowId });

  const setup = await client.callTool({ name: "loomex_run_setup", arguments: { workflowId, taskContext } });
  assert.deepEqual(setup._meta?.["loomex/taskWorkspace"], { taskContext });
  assert.deepEqual(runner.requests.filter(request => !request.method.startsWith("presentation.")).at(-1)?.params, { workflowId });

  const requestCount = runner.requests.length;
  const missingContext = await client.callTool({ name: "loomex_workflows_view", arguments: { limit: 5 } });
  assert.equal(missingContext.isError, true);
  assert.match(String((missingContext.content as Array<{ text?: string }>)[0]?.text), /taskContext/i);
  assert.equal(runner.requests.length, requestCount, "missing task context must fail before a runner or saved UI state can supply a workspace");
});

test("workflow list text summaries are compact, safe projections and retain canonical results", async () => {
  const workflowId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const longName = `  ${"A".repeat(245)}  `;
  const responseRef = "92d719c6-8fcd-46aa-8d97-85bdeea754ec";
  const spooledPage = {
    responseRef,
    encoding: "json",
    sizeBytes: 90_000,
    nextOffset: 0,
    checksumSha256: "a".repeat(64),
  };
  const fullPage = {
    workflows: Array.from({ length: 9 }, (_, index) => ({
      id: workflowId(index + 1),
      name: index === 0 ? longName : ` Workflow ${index + 1} `,
      nodeCount: index,
    })),
    nextCursor: "page-2",
  };
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => {
    const query = request.params.query;
    const result = query === "empty"
      ? { workflows: [], nextCursor: null }
      : query === "malformed"
        ? { workflows: [{ id: "x".repeat(161), name: "Cannot trust this row" }], nextCursor: null }
        : query === "friendly"
          ? { workflows: [{ id: "friendly-name", name: "Looks ordinary" }], nextCursor: null }
        : query === "missing"
          ? { nextCursor: null }
          : query === "spooled"
            ? spooledPage
          : fullPage;
    runner.respond(socket, request, result);
  });
  const client = await connect(runner);

  const full = await client.callTool({
    name: "loomex_workflows_view",
    arguments: { query: "full", limit: 9, taskContext: { cwd: "/Users/example/task" } },
  });
  const fullText = JSON.parse((full.content as Array<{ text: string }>)[0]!.text) as Record<string, any>;
  assert.deepEqual(fullText.workflowPage, { count: 9, workflows: Array.from({ length: 8 }, (_, index) => ({ id: workflowId(index + 1), name: index === 0 ? "A".repeat(240) : `Workflow ${index + 1}` })), truncated: true, hasNextPage: true });
  assert.deepEqual((full._meta?.["loomex/uiData"] as Record<string, any>).data, fullPage);
  assert.equal((((full._meta?.["loomex/uiData"] as Record<string, any>).data.workflows[0].name as string).length), 249);
  assert.deepEqual((full.structuredContent as Record<string, any>).data.workflowPage, { count: 9, workflows: Array.from({ length: 8 }, (_, index) => ({ id: workflowId(index + 1), name: index === 0 ? "A".repeat(240) : `Workflow ${index + 1}` })), truncated: true, hasNextPage: true });
  assert.deepEqual(full._meta?.["loomex/workflowListQuery"], { query: "full", limit: 9 });
  assert.deepEqual(full._meta?.["loomex/taskWorkspace"], { taskContext: { cwd: "/Users/example/task" } });

  const refresh = await client.callTool({ name: "loomex_workflows_list", arguments: { query: "full", limit: 9 } });
  const refreshModelPayload = JSON.stringify({ content: refresh.content, structuredContent: refresh.structuredContent });
  assert.ok(refreshModelPayload.length < 5_000);
  assert.equal(refreshModelPayload.includes(longName), false);
  assert.deepEqual((refresh._meta?.["loomex/uiData"] as Record<string, any>).data, fullPage,
    "app-callable list refreshes retain the canonical page in component-only metadata");

  const empty = await client.callTool({ name: "loomex_workflows_list", arguments: { query: "empty" } });
  const emptyText = JSON.parse((empty.content as Array<{ text: string }>)[0]!.text) as Record<string, any>;
  assert.deepEqual(emptyText.workflowPage, { count: 0, workflows: [], truncated: false, hasNextPage: false });
  assert.deepEqual((empty.structuredContent as Record<string, any>).data, { workflowPage: { count: 0, workflows: [], truncated: false, hasNextPage: false } });

  const malformed = await client.callTool({ name: "loomex_workflows_list", arguments: { query: "malformed" } });
  const malformedText = JSON.parse((malformed.content as Array<{ text: string }>)[0]!.text) as Record<string, any>;
  assert.deepEqual(malformedText.workflowPage, { state: "unavailable" });
  assert.equal(malformedText.stateNeedsVerification, true);
  assert.equal((malformed.structuredContent as Record<string, any>).data.workflows, undefined);

  const friendly = await client.callTool({ name: "loomex_workflows_list", arguments: { query: "friendly" } });
  const friendlyText = JSON.parse((friendly.content as Array<{ text: string }>)[0]!.text) as Record<string, any>;
  assert.deepEqual(friendlyText.workflowPage, { state: "unavailable" });
  assert.equal(friendlyText.stateNeedsVerification, true);
  assert.deepEqual((friendly.structuredContent as Record<string, any>).data, {
    workflowPage: { state: "unavailable" }, stateNeedsVerification: true,
  });

  const spooled = await client.callTool({ name: "loomex_workflows_list", arguments: { query: "spooled" } });
  const spooledText = JSON.parse((spooled.content as Array<{ text: string }>)[0]!.text) as Record<string, any>;
  assert.equal(spooledText.responseRef, responseRef);
  assert.equal(spooledText.workflowPage?.count, undefined, "a spooled page must not be represented as an empty list");
  assert.deepEqual((spooled.structuredContent as Record<string, any>).data, {
    workflowPage: { state: "pending" }, ...spooledPage,
  });

  const missing = await client.callTool({ name: "loomex_workflows_list", arguments: { query: "missing" } });
  assert.equal(missing.isError, true);
  const missingText = JSON.parse((missing.content as Array<{ text: string }>)[0]!.text) as Record<string, any>;
  assert.equal(missingText.error.code, "INVALID_RESPONSE");
  assert.equal("workflowPage" in missingText, false);
  assert.deepEqual(missing._meta?.["loomex/uiData"], missing.structuredContent,
    "app-callable failures retain their canonical error envelope for the component");
});


test("connection tools use dedicated resources and owner-local view sessions", async () => {
  const organizationId = "f4139cef-684b-4578-b908-293a0efb7f1a";
  const projection = {
    schemaVersion: "loomex.runner.connection/v2",
    state: "authenticated",
    organization: { status: "organization_required", selected: null },
    organizations: [{ id: organizationId, name: "Example organization", enrolled: true }],
    activeWork: 0,
    actions: ["organizations.select"],
    login: null,
  };
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, projection));
  const client = await connect(runner);
  const tools = await client.listTools();
  const get = tools.tools.find((tool) => tool.name === "loomex_connection_get");
  const view = tools.tools.find((tool) => tool.name === "loomex_connection_view");
  const organizationsView = tools.tools.find((tool) => tool.name === "loomex_organizations_view");
  assert.deepEqual(get?._meta?.ui, { visibility: ["model", "app"] });
  assert.deepEqual(view?._meta?.ui, { visibility: ["model"], resourceUri: CONNECTION_UI_URI });
  assert.deepEqual(organizationsView?._meta?.ui, { visibility: ["model"], resourceUri: ORGANIZATIONS_UI_URI });
  const result = await client.callTool({ name: "loomex_connection_view", arguments: {} });
  assert.deepEqual((result.structuredContent as Record<string, any>)?.data, projection,
    "connection cards must receive a complete projection without relying on _meta");
  assert.deepEqual((result._meta?.["loomex/uiData"] as Record<string, any>).data, projection);
  assert.equal(result._meta?.["loomex/viewSession"], undefined);
  assert.equal(runner.requests.length, 2);
  assert.equal(runner.requests[1]?.method, "connection.views.create");
  assert.equal(runner.requests[0]?.method, "connection.get");
  assert.deepEqual(runner.requests[0]?.params, {});

  const organizationsResult = await client.callTool({ name: "loomex_organizations_view", arguments: {} });
  assert.deepEqual((organizationsResult.structuredContent as Record<string, any>)?.data, projection,
    "organization cards share the complete connection projection contract");
  assert.deepEqual((organizationsResult._meta?.["loomex/uiData"] as Record<string, any>).data, projection);
  assert.equal(runner.requests.length, 4);
  assert.equal(runner.requests[2]?.method, "connection.get");
  assert.equal(runner.requests[3]?.method, "connection.views.create");
});

test("content-addressed UI resources resolve explicit previously shipped aliases", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, {}));
  const client = await connect(runner);
  const resources = await client.listResources();
  assert.equal(resources.resources.length, 8);
  for (const resource of resources.resources) {
    assert.match(resource.uri, new RegExp(`^ui://loomex/[a-z]+-${UI_RESOURCE_REVISION}\\.html$`));
  }
  for (const mode of ["authoring", "prepare", "monitor", "interaction", "browser"]) {
    const uri = `ui://loomex/${mode}-${mode === "browser" ? "0.2.7" : "0.2.3"}.html`;
    const result = await client.readResource({ uri });
    assert.equal(result.contents[0]?.uri, uri);
    const content = result.contents[0];
    assert.match(content && "text" in content ? content.text : "", new RegExp(`data-mode="${mode}"`));
    assert.equal(runner.requests.length, 0);
  }
  for (const mode of ["browser", "runs", "authoring", "prepare", "monitor", "interaction", "organizations", "connection"]) {
    const uri = `ui://loomex/${mode}.html`;
    const result = await client.readResource({ uri });
    assert.equal(result.contents[0]?.uri, uri);
    const content = result.contents[0];
    assert.match(content && "text" in content ? content.text : "", new RegExp(`data-mode="${mode}"`));
    assert.equal(runner.requests.length, 0);
  }
  const organizations = await client.readResource({ uri: ORGANIZATIONS_UI_URI });
  assert.match(organizations.contents[0] && "text" in organizations.contents[0] ? organizations.contents[0].text : "", /data-mode="organizations"/);
  const connection = await client.readResource({ uri: CONNECTION_UI_URI });
  assert.match(connection.contents[0] && "text" in connection.contents[0] ? connection.contents[0].text : "", /data-mode="connection"/);
  const runs = await client.readResource({ uri: RUNS_UI_URI });
  assert.match(runs.contents[0] && "text" in runs.contents[0] ? runs.contents[0].text : "", /data-mode="runs"/);
  await assert.rejects(client.readResource({ uri: "ui://loomex/authoring-99.0.0.html" }));
  await assert.rejects(client.readResource({ uri: "ui://loomex/unknown-0.2.3.html" }));
  await assert.rejects(client.readResource({ uri: "ui://loomex/browser-0.2.3.html" }));
});

test("chat monitoring data tools never remount views and display tools fetch authoritative snapshots", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, request.method === "workflows.list"
    ? { workflows: [], nextCursor: null, details: {} }
    : request.method === "interactions.get" ? { humanRequest: { id: "8081f734-5175-492b-b412-b1d88d8e3a7d", status: "pending", execution: { id: "adc7b3ba-1979-47d2-ac14-638ed91c5f82" } }, details: {} }
    : { execution: { id: "adc7b3ba-1979-47d2-ac14-638ed91c5f82", status: "running" }, events: [], latestSequence: 9, hasMoreEvents: false, timedOut: false, details: {} }));
  const client = await connect(runner);
  const { tools } = await client.listTools();
  for (const name of ["loomex_workflows_list", "loomex_run_get", "loomex_run_wait", "loomex_interaction_get"]) {
    const tool = tools.find(tool => tool.name === name);
    assert.equal((tool?._meta?.ui as { resourceUri?: string })?.resourceUri, undefined, name);
    assert.equal(tool?._meta?.["openai/outputTemplate"], undefined, name);
  }
  assert.deepEqual(tools.find(tool => tool.name === "loomex_run_wait")?._meta?.ui, { visibility: ["model"] });
  for (const [name, uri, args, method] of [
    ["loomex_workflows_view", "browser", { query: "idea", limit: 10, taskContext: { cwd: "/Users/example/current-task" } }, "workflows.list"],
    ["loomex_run_view", "monitor", { runId: "adc7b3ba-1979-47d2-ac14-638ed91c5f82" }, "runs.get"],
    ["loomex_interaction_view", "interaction", { requestId: "8081f734-5175-492b-b412-b1d88d8e3a7d" }, "interactions.get"],
  ] as const) {
    const tool = tools.find(tool => tool.name === name);
    const expectedUri = { browser: BROWSER_UI_URI, monitor: MONITOR_UI_URI, interaction: INTERACTION_UI_URI }[uri];
    assert.equal((tool?._meta?.ui as { resourceUri?: string })?.resourceUri, expectedUri);
    assert.equal(tool?.annotations?.readOnlyHint, true);
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true);
    assert.equal(runner.requests.filter(request => !request.method.startsWith("presentation.")).at(-1)?.method, method);
    const canonical = result._meta?.["loomex/uiData"] as { data: Record<string, unknown> };
    assert.equal(typeof canonical?.data, "object", `${name}: canonical data must be component-only`);
    assert.notDeepEqual((result.structuredContent as { data: unknown }).data, canonical.data);
  }
});


test("headless monitoring fetches the typed interaction and pauses without suggesting a UI", async () => {
  const runId = "adc7b3ba-1979-47d2-ac14-638ed91c5f82";
  const requestId = "8081f734-5175-492b-b412-b1d88d8e3a7d";
  const organizationId = "dd6244ea-2f21-48bd-a9da-4d2ac161882a";
  const humanRequest = { id: requestId, status: "pending", execution: { id: runId },
    organizationId, answerChannel: "chat", schemaDigest: "a".repeat(64),
    inputSpec: { inputType: "long_text", question: "Describe the idea" }, responseSchema: { type: "object" },
    history: "must-not-enter-model-projection".repeat(100) };
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, request.method === "runs.get"
    ? { execution: { id: runId, organizationId, status: "waiting" }, humanRequest, events: [], latestSequence: 7, hasMoreEvents: false, timedOut: false, details: {} }
    : { humanRequest, details: {} }));
  const client = await connect(runner);
  const snapshot = await client.callTool({ name: "loomex_run_get", arguments: { runId } });
  const summary = JSON.parse((snapshot.content as Array<{ text: string }>)[0]!.text);
  assert.equal(summary.headlessAction.tool, "loomex_interaction_get");
  const question = await client.callTool({ name: summary.headlessAction.tool, arguments: summary.headlessAction.arguments });
  assert.notEqual(question.isError, true);
  const questionSummary = JSON.parse((question.content as Array<{ text: string }>)[0]!.text);
  assert.equal(questionSummary.awaitingUserAnswer, true);
  assert.equal(questionSummary.presentationAction, undefined);
  assert.equal(questionSummary.nextAction, undefined);
  const questionData = (question.structuredContent as { data: Record<string, any> }).data;
  assert.equal(questionData.question, "Describe the idea");
  assert.deepEqual(questionData.responseSchema, { type: "object" });
  assert.equal(questionData.answerChannel, "chat");
  assert.equal(questionData.schemaDigest, "a".repeat(64));
  assert.doesNotMatch(JSON.stringify({ content: question.content, structuredContent: question.structuredContent }),
    /must-not-enter-model-projection/);
  assert.match(JSON.stringify(question._meta?.["loomex/uiData"]), /must-not-enter-model-projection/);
  assert.deepEqual(runner.requests.map(request => request.method), ["runs.get", "interactions.get"]);
});


test("commit journal survives the MCP bridge without a reconciliation read or execution replay", async () => {
  const viewSessionId = "59e37bb3-6c47-4ae2-b41f-0d80b2ad0c95";
  const operationId = "404cc12a-c3fb-48bb-aa37-20bb5a1c2fbd";
  const idempotencyKey = "013446a2-194b-432b-8caf-a1b59cceec63";
  const params = { preparationId: "558efdf2-88fa-4f18-b9e6-f01c4c8330fc", confirmationKey: "exact-owner-confirmation", bindingDigest: "a".repeat(64), idempotencyKey };
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, {
    viewSessionId, operationId, method: "runs.commit", params, idempotencyKey,
    reconciliation: {}, status: "pending", createdAt: 1, updatedAt: 1, resultReference: null,
  }));
  const client = await connect(runner);
  const result = await client.callTool({name: "loomex_view_operation_get", arguments: {viewSessionId, operationId}});
  assert.notEqual(result.isError, true);
  assert.deepEqual((result.structuredContent as any).data.params, params);
  assert.deepEqual((result.structuredContent as any).data.reconciliation, {});
  assert.deepEqual(runner.requests.map(request => request.method), ["presentation.operations.get"]);
});

test("recovery coordination is a typed local journal and never invokes host scheduling", async () => {
  const runId = "a51e5d78-cf59-4c7a-b47e-0df52c5fbd44";
  const hostTaskId = "7a65928a-1518-40b5-94a6-9bd0a78f6757";
  const recoveryId = "e76666c5-0770-4e54-92f6-bb6c9f8b4ed5";
  const operationId = "607a019f-2c1d-4b43-bb87-76b422d34ea2";
  const binding = { hostId: "local", hostTaskId, runId };
  const recordBinding = {
    organizationId: "organization-1",
    installationId: "installation-1",
    ...binding,
    marker: `loomex-follow-recovery:${hostTaskId}:${runId}`,
  };
  const record = {
    recoveryId,
    schemaVersion: 1,
    binding: recordBinding,
    revision: 3,
    monitoringIntent: "enabled",
    registrationState: "registered",
    initialization: "interaction_accepted",
    automationId: "automation-1",
    lifecycle: "verified",
    hostEvidence: { source: "host-reported", automationStatus: "ACTIVE" },
    observedAt: 123,
    lastEventSequence: 71,
    pendingRequestId: null,
    presentationReference: null,
    cleanupStatus: null,
    diagnosticReason: null,
    currentOperationId: null,
    operation: null,
    createdAt: 100,
    updatedAt: 123,
    expiresAt: null,
  };
  const descriptor = { kind: "create", arguments: { mode: "create", marker: `loomex-follow-recovery:${hostTaskId}:${runId}` }, idempotencyKey: "dcef64cc-a92f-4a07-89f3-710a0bd805d0" };
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => {
    if (request.method === "recovery.get") {
      runner.respond(socket, request, { found: true, recovery: record });
      return;
    }
    if (request.method === "recovery.update") {
      runner.respond(socket, request, { recovery: record });
      return;
    }
    const operation = {
      operationId,
      kind: descriptor.kind,
      arguments: descriptor.arguments,
      operationKey: descriptor.idempotencyKey,
      status: request.method === "recovery.operations.settle" ? "succeeded" : "in_flight",
      createdAt: 123,
      updatedAt: 124,
      result: null,
    };
    runner.respond(socket, request, request.method === "recovery.operations.begin"
      ? { recovery: record, operation, attemptPermitted: true }
      : { recovery: record, operation });
  });
  const client = await connect(runner);
  const get = await client.callTool({ name: "loomex_recovery_get", arguments: { binding } });
  assert.notEqual(get.isError, true, JSON.stringify(get));
  const updateKey = "c7bde680-cac7-4d3e-a77c-ed6a301024e2";
  const update = await client.callTool({ name: "loomex_recovery_update", arguments: {
    binding, expectedRevision: 3, monitoringIntent: "enabled", lastEventSequence: 71, idempotencyKey: updateKey,
  } });
  assert.notEqual(update.isError, true);
  const beginKey = "47ebc03d-1eb5-4953-a8e3-7e745f5e5a4c";
  const begin = await client.callTool({ name: "loomex_recovery_operation_begin", arguments: {
    binding, expectedRevision: 3, operation: descriptor, idempotencyKey: beginKey,
  } });
  assert.notEqual(begin.isError, true);
  assert.equal((begin.structuredContent as any).data.attemptPermitted, true);
  const settleKey = "c9986c76-8cf8-469f-85e8-1832f35aac8e";
  const settle = await client.callTool({ name: "loomex_recovery_operation_settle", arguments: {
    binding, expectedRevision: 3, operationId, status: "succeeded", automationId: "automation-1",
    hostEvidence: { source: "host-reported", automationStatus: "ACTIVE" }, lifecycle: "verified",
    idempotencyKey: settleKey,
  } });
  assert.notEqual(settle.isError, true);
  assert.deepEqual(runner.requests.map((request) => request.method), [
    "recovery.get", "recovery.update", "recovery.operations.begin", "recovery.operations.settle",
  ]);
  assert.deepEqual(runner.requests[1]?.params, {
    binding, expectedRevision: 3, monitoringIntent: "enabled", lastEventSequence: 71, idempotencyKey: updateKey,
  });
  assert.deepEqual(runner.requests[2]?.params, {
    binding, expectedRevision: 3, operation: descriptor, idempotencyKey: beginKey,
  });
  assert.deepEqual(runner.requests[3]?.params, {
    binding, expectedRevision: 3, operationId, status: "succeeded", automationId: "automation-1",
    hostEvidence: { source: "host-reported", automationStatus: "ACTIVE" }, lifecycle: "verified",
    idempotencyKey: settleKey,
  });
});

test("older runners reject recovery coordination during capability negotiation", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner(
    (request, socket) => runner.respond(socket, request, {}),
    { capabilities: REQUIRED_RUNNER_CAPABILITIES.filter((capability) => capability !== "recovery.coordination/v1") },
  );
  const client = await connect(runner);
  const result = await client.callTool({
    name: "loomex_recovery_get",
    arguments: { binding: { hostId: "local", hostTaskId: "7a65928a-1518-40b5-94a6-9bd0a78f6757", runId: "a51e5d78-cf59-4c7a-b47e-0df52c5fbd44" } },
  });
  assert.equal(result.isError, true);
  assert.equal(((result.structuredContent as any).error).code, "COMPATIBILITY_ERROR");
  assert.equal(runner.negotiations.length, 1);
  assert.equal(runner.requests.length, 0);
});

test("active-chat atomic creation retains definition and verified draft receipt without a card", async () => {
  let runner!: FakeRunner;
  const workflowId = "b121d6a8-9d89-4991-a49c-f972829b3d21";
  const draft = { id: "8cebe362-f96e-4274-8941-929e9bf478dc", revision: 1, status: "draft" };
  runner = new FakeRunner((request, socket) => runner.respond(socket, request, {
    workflowId, name: "Chat draft", slug: "chat-draft", activeVersionId: null, draft,
  }));
  const client = await connect(runner);
  const args = { name: "Chat draft", definition: { nodes: [], transitions: [] }, notes: "Original request", idempotencyKey: "5b3c3e7e-8a41-45b4-ad2c-9a3fc8297f8a" };
  const result = await client.callTool({ name: "loomex_workflow_create", arguments: args });
  assert.notEqual(result.isError, true);
  assert.deepEqual(runner.requests[0]?.params, args);
  assert.deepEqual((result.structuredContent as any).data.draft, draft);
  assert.equal(TOOL_DEFINITIONS.find(tool => tool.name === "loomex_workflow_create")?.uiUri, undefined);
});

test("authoring observations and compatibility preparations do not automatically open cards", () => {
  for (const name of ["loomex_builder_get", "loomex_builder_prepare", "loomex_editor_prepare"]) {
    assert.equal(TOOL_DEFINITIONS.find(tool => tool.name === name)?.uiUri, undefined, name);
  }
  assert.ok(TOOL_DEFINITIONS.find(tool => tool.name === "loomex_workflow_view")?.uiUri);
  assert.ok(REQUIRED_RUNNER_CAPABILITIES.includes("workflows.atomic-draft-create/v1"));
});
