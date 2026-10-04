import * as assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { runSummary } from "../src/run-summary.js";
import type { JsonValue } from "../src/protocol.js";
import { FakeRunner } from "./fake-runner.js";

const runId = "dbc61e48-d413-4ffc-bf99-4a89b1d020ec";
const requestId = "cb0acf9a-3a5d-4dc3-bff0-bec0062b119d";
const organizationId = "dd6244ea-2f21-48bd-a9da-4d2ac161882a";
const digest = "258a1b6660c5b23089216b16df0cf80c6cd35eefb46a18ba6f6634d80f8dc8fe";
// Exact schema from the read-only installed NAP-SCHEMA-01 reproduction.
const installedSchema = {
  "additionalProperties": false,
  "properties": {
    "answers": {
      "items": {
        "additionalProperties": false,
        "oneOf": [
          {
            "properties": {
              "questionId": {
                "const": "qa_round_1"
              },
              "value": {
                "type": "string"
              }
            },
            "required": [
              "questionId",
              "value"
            ]
          }
        ],
        "properties": {
          "otherText": {
            "type": "string"
          },
          "questionId": {
            "type": "string"
          },
          "value": {},
          "values": {
            "items": {
              "type": "string"
            },
            "type": "array"
          }
        },
        "required": [
          "questionId"
        ],
        "type": "object"
      },
      "type": "array"
    }
  },
  "required": [
    "answers"
  ],
  "type": "object"
};
const witness = { answers: [{ questionId: "qa_round_1", value: "choice_1" }] };

function human(schema: JsonValue, channel = "ui") {
  return { execution: { id: runId, status: "waiting", organizationId }, details: {},
    humanRequest: { id: requestId, status: "pending", type: "manual_input", answerChannel: channel,
      organizationId, execution: { id: runId }, schemaDigest: digest,
      inputSpec: { inputType: "radio", question: "Choose", options: [{ id: "choice_1", label: "First" }] },
      responseSchema: schema, providerOutput: "unrelated-provider-context" } };
}
function validity(schema: unknown, answer: unknown): boolean {
  const provider = new AjvJsonSchemaValidator();
  return provider.getValidator((typeof schema === "boolean" ? { allOf: [schema] } : schema) as Parameters<typeof provider.getValidator>[0])(answer).valid;
}
function assertParity(raw: JsonValue, projected: unknown, valid: unknown[], invalid: unknown[]) {
  assert.deepEqual(projected, raw);
  for (const answer of valid) { assert.equal(validity(raw, answer), true); assert.equal(validity(projected, answer), true); }
  for (const answer of invalid) { assert.equal(validity(raw, answer), false); assert.equal(validity(projected, answer), false); }
}

test("installed radio answer contract retains required unconstrained value before additionalProperties validation", () => {
  const projected = runSummary("interactions.get", human(installedSchema));
  assertParity(installedSchema, projected?.responseSchema, [witness], [{ answers: [{ questionId: "qa_round_1" }] },
    { answers: [{ questionId: "qa_round_1", value: 1 }] }, { ...witness, unexpected: true }]);
  assert.equal(projected?.schemaDigest, undefined);
  assert.equal((projected?.humanRequest as any).schemaDigest, digest);
});

const mixedSchema = { type: "object", additionalProperties: false, required: ["answers"],
  $defs: { choice: { enum: ["one", "two"] }, date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    nested: { $defs: { anything: {}, never: false, always: true }, type: "object", properties: { free: { $ref: "#/$defs/nested/$defs/anything" }, forbidden: { $ref: "#/$defs/nested/$defs/never" } }, additionalProperties: false } },
  properties: { answers: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
    properties: { questionId: { type: "string" }, value: {}, values: { type: "array", items: { $ref: "#/$defs/choice" }, uniqueItems: true }, otherText: { type: "string" } },
    required: ["questionId"], oneOf: [
      { properties: { questionId: { const: "radio" }, value: { $ref: "#/$defs/choice" } }, required: ["value"] },
      { properties: { questionId: { const: "checkbox" } }, required: ["values"] },
      { properties: { questionId: { const: "rating" }, value: { type: "number", minimum: 0, maximum: 5 } }, required: ["value"] },
      { properties: { questionId: { const: "date" }, value: { $ref: "#/$defs/date" } }, required: ["value"] },
    ] } } } };
const mixedAnswer = { answers: [{ questionId: "radio", value: "one" }, { questionId: "checkbox", values: ["one", "two"] },
  { questionId: "rating", value: 4 }, { questionId: "date", value: "2026-10-04" }] };

test("human UI and chat schemas preserve nested refs, boolean schemas and mixed typed answer semantics", () => {
  for (const channel of ["ui", "chat"]) {
    assertParity(mixedSchema, runSummary("interactions.get", human(mixedSchema, channel))?.responseSchema, [mixedAnswer], [
      { answers: [{ questionId: "radio", value: "wrong" }] }, { answers: [{ questionId: "checkbox", values: ["one", "one"] }] },
      { answers: [{ questionId: "rating", value: 6 }] }, { answers: [{ questionId: "date", value: "yesterday" }] },
      { answers: [{ questionId: "radio", value: "one", extra: true }] },
    ]);
  }
  for (const schema of [{}, true, false]) {
    assertParity(schema, runSummary("interactions.get", human(schema))?.responseSchema,
      schema === false ? [] : [null, {}, "anything"], schema === false ? [null, {}, "anything"] : []);
  }
});

test("schema syntax includes object const/enum, schema additionalProperties, empty arrays and false properties", () => {
  const schema = { type: "object", required: ["value"], properties: { value: {}, forbidden: false, allowed: true,
    object: { const: { fixed: [] } }, alternatives: { enum: [{ nested: {} }, []] }, never: { not: {} } },
    additionalProperties: { type: "string" } };
  const result = runSummary("interactions.get", human(schema));
  assertParity(schema, result?.responseSchema, [{ value: null }, { value: {}, allowed: 1, object: { fixed: [] }, alternatives: [] }],
    [{}, { value: 1, forbidden: null }, { value: 1, extra: false }, { value: 1, never: 1 }]);
});

function nativeTask(output: JsonValue) {
  const binding = { schemaVersion: "loomex.native-authoring/v1", mode: "create", systemKey: "workflow_builder",
    sessionId: "18f23362-287a-4b92-927f-51d5808dce97", runnerId: "07c2f53b-1687-469c-b2aa-d6a3fc1a608a",
    workflowVersionId: "c69ca6a1-709a-4e92-a8b0-d1f784a8cb2a", definitionChecksum: "a".repeat(64),
    executionId: runId, organizationId, requestId, nodeExecutionId: "2905b270-ae08-47f7-91c5-f70319ed72d4", nodeKey: "compose", attempt: 1, generation: 1 };
  const responseSchema = { type: "object", additionalProperties: false, properties: { status: { const: "completed" }, output: {},
    nativeAuthoringBinding: { const: binding } }, required: ["status", "output", "nativeAuthoringBinding"] };
  return { ...human(responseSchema), humanRequest: { ...human(responseSchema).humanRequest, type: "plugin_agent",
    interactionCategory: "plugin_agent", answerChannel: "current_chat", agentTask: { schemaVersion: "loomex.plugin-agent-task/v2",
      executionStrategy: "current_chat", strategy: "current_chat", prompt: "Bound authoring task",
      input: { inputSchema: mixedSchema, outputSchema: output },
      schemas: { input: { $defs: { free: {}, never: false }, properties: { anything: true } }, output },
      outputValidation: { strategy: "schema" }, nativeAuthoringBinding: binding } } };
}
test("current-chat input/output contracts preserve syntax and treat valid empty or boolean schemas as present", () => {
  for (const schema of [mixedSchema, {}, true, false]) {
    const raw = nativeTask(schema);
    const projected = runSummary("interactions.get", raw);
    assert.equal(projected?.requiresAgentResponse, true);
    assert.deepEqual(projected?.responseSchema, raw.humanRequest.responseSchema);
    assert.deepEqual((projected?.agentTask as any).schemas, raw.humanRequest.agentTask.schemas);
    assert.deepEqual((projected?.agentTask as any).input, raw.humanRequest.agentTask.input);
    assert.deepEqual((projected?.agentTask as any).nativeAuthoringBinding, raw.humanRequest.agentTask.nativeAuthoringBinding);
    assert.equal(projected?.schemaDigest, digest);
    assertParity(schema, (projected?.agentTask as any).schemas.output,
      schema === false ? [] : schema === mixedSchema ? [mixedAnswer] : [{}], schema === false ? [{}] : schema === mixedSchema ? [{}] : []);
  }
});

test("falsy and structured const/enum values preserve exact validation", () => {
  const schema = { type: "object", properties: { value: { enum: [null, false, 0, "", {}, []] },
    fixed: { const: false }, open: { required: [], properties: {}, additionalProperties: true } }, required: ["value"], additionalProperties: false };
  assertParity(schema, runSummary("interactions.get", human(schema))?.responseSchema,
    [null, false, 0, "", {}, []].map(value => ({ value, fixed: false, open: {} })), [{ value: true }, { value: 1 }, { value: null, fixed: true }]);
});

test("deep opaque schema arrays fail closed without a partial contract", () => {
  let nested: JsonValue = {};
  for (let depth = 0; depth < 14; depth++) nested = [nested];
  const projected = runSummary("interactions.get", human({ const: nested }));
  assert.equal(projected?.responseSchema, undefined);
  assert.equal(projected?.headlessSchemaComplete, false);
  assert.equal((projected?.answerIssue as any).code, "INTERACTION_SCHEMA_UNSUPPORTED");
});

function nestedItems(leaf: JsonValue, depth: number): JsonValue {
  let schema = leaf;
  for (let level = 0; level < depth; level++) schema = { items: schema };
  return schema;
}

test("schema depth twelve accepts object and boolean leaves while thirteen fails closed", () => {
  for (const leaf of [{}, true, false, { type: "string" }, { type: "array", uniqueItems: true }]) {
    const supported = nestedItems(leaf, 12);
    assert.deepEqual(runSummary("interactions.get", human(supported))?.responseSchema, supported);
    const unsupported = runSummary("interactions.get", human(nestedItems(leaf, 13)));
    assert.equal(unsupported?.responseSchema, undefined);
    assert.equal(unsupported?.headlessSchemaComplete, false);
    assert.equal((unsupported?.answerIssue as any).code, "INTERACTION_SCHEMA_UNSUPPORTED");
  }
});

test("native schema presence accepts syntax without accepting missing or malformed contracts", () => {
  for (const output of [null, [], 1, "schema"]) {
    const projected = runSummary("interactions.get", nativeTask(output));
    assert.equal(projected?.requiresAgentResponse, undefined);
    assert.equal(projected?.stateNeedsVerification, true);
  }
});

test("compiled MCP interaction read preserves the installed contract in both model channels with strict bound inputs", async () => {
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => {
    assert.equal(request.method, "interactions.get");
    assert.deepEqual(request.params, { requestId });
    runner.respond(socket, request, human(installedSchema));
  });
  await runner.start();
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), "dist/server.js")],
    env: { ...env, LOOMEX_STATE_DIR: runner.stateDir }, stderr: "pipe" });
  const client = new Client({ name: "schema-contract-regression", version: "1" });
  try {
    await client.connect(transport);
    const tool = (await client.listTools()).tools.find(tool => tool.name === "loomex_interaction_get")!;
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.required, ["requestId"]);
    assert.equal(validity(tool.inputSchema, { requestId }), true);
    assert.equal(validity(tool.inputSchema, { requestId, runId }), false);
    const result = await client.callTool({ name: tool.name, arguments: { requestId } });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as any;
    const text = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    for (const projection of [structured.data, text]) {
      assertParity(installedSchema, projection.responseSchema, [witness], [{ answers: [{ questionId: "qa_round_1" }] }]);
      assert.equal(projection.humanRequest.id, requestId);
      assert.equal(projection.humanRequest.schemaDigest, digest);
      assert.equal(projection.execution.id, runId);
      assert.doesNotMatch(JSON.stringify(projection), /unrelated-provider-context/);
    }
    assert.equal(runner.requests.length, 1);
    const invalid = await client.callTool({ name: tool.name, arguments: { requestId, runId } });
    assert.equal(invalid.isError, true);
    assert.equal(runner.requests.length, 1, "strict invalid inputs never cross the fenced transport");
  } finally { await client.close(); await transport.close(); await runner.stop(); }
});


test("compiled MCP preserves the twelve-level boundary for object and boolean schema leaves", async () => {
  const schemas = [ {}, true, false, { type: "string" }, { type: "array", uniqueItems: true } ].flatMap(leaf => [nestedItems(leaf, 12), nestedItems(leaf, 13)]);
  let runner!: FakeRunner;
  runner = new FakeRunner((request, socket) => {
    assert.equal(request.method, "interactions.get");
    assert.deepEqual(request.params, { requestId });
    runner.respond(socket, request, human(schemas[runner.requests.length - 1]!));
  });
  await runner.start();
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), "dist/server.js")],
    env: { ...env, LOOMEX_STATE_DIR: runner.stateDir }, stderr: "pipe" });
  const client = new Client({ name: "schema-depth-regression", version: "1" });
  try {
    await client.connect(transport);
    for (let index = 0; index < schemas.length; index++) {
      const result = await client.callTool({ name: "loomex_interaction_get", arguments: { requestId } });
      assert.equal(result.isError, undefined);
      const structured = result.structuredContent as any;
      const text = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      for (const projection of [structured.data, text]) {
        assert.equal(projection.execution.id, runId);
        if (index % 2 === 0) {
          assert.deepEqual(projection.responseSchema, schemas[index]);
          assert.equal(projection.humanRequest.id, requestId);
          assert.equal(projection.humanRequest.schemaDigest, digest);
        } else {
          assert.equal(projection.headlessSchemaComplete, false);
          assert.equal(projection.responseSchema, undefined);
          assert.equal(projection.answerIssue.code, "INTERACTION_SCHEMA_UNSUPPORTED");
        }
      }
    }
    assert.equal(runner.requests.length, schemas.length);
  } finally { await client.close(); await transport.close(); await runner.stop(); }
});
