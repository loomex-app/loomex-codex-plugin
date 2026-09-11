import * as assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { LocalControlCallOptions } from "../src/local-control.js";
import {
  PREPARATION_REVIEW_SCHEMA_VERSION,
  buildPreparationReview,
  preparationReviewBinding,
  type PreparationReviewBinding,
  type PreparationReviewClient,
} from "../src/preparation-review.js";
import { LOCAL_PROTOCOL, type JsonValue, type ToolOutput } from "../src/protocol.js";
import { createServer } from "../src/server.js";

const REQUEST_ID = "7f3a808a-38d4-46ee-bc0b-f2bb18f26361";
const WORKFLOW_ID = "8df84dfa-df05-49f8-b296-9bfcf7be6306";
const VERSION_ID = "8254588f-fbc3-47b9-ab05-83a6d4bf8e91";
const CURRENT_VERSION_ID = "a53a026a-dd2f-455b-af4d-18187d15775f";
const ORGANIZATION_ID = "b138fcf2-58e9-47ae-a1ba-1bc5bf76f763";
const CHILD_WORKFLOW_ID = "4cd5cc77-c880-48b7-b201-bcc27c3b9038";
const CHILD_VERSION_ID = "9998863a-c9b5-4709-bce8-de81d95575c9";
const DIGEST = "d".repeat(64);

const binding: PreparationReviewBinding = {
  preparationId: "40f18d65-6016-43ef-9573-10d4afc22c3e",
  bindingDigest: "c".repeat(64),
  workflowId: WORKFLOW_ID,
  versionId: VERSION_ID,
  organizationId: ORGANIZATION_ID,
  providers: [],
  closureWorkflowVersion: 3,
};

const displayBinding = {
  preparationId: binding.preparationId,
  bindingDigest: binding.bindingDigest,
  workflowId: binding.workflowId,
  versionId: binding.versionId,
  organizationId: binding.organizationId,
};

function output(method: string, data: Record<string, JsonValue>): ToolOutput {
  return { ok: true, protocol: LOCAL_PROTOCOL, method, requestId: REQUEST_ID, data };
}

function dependency(
  key: string,
  type: string,
  config: Record<string, JsonValue> = {},
  resolution?: { provider: string; runtimeModel: string },
): Record<string, JsonValue> {
  return {
    node: { key, type, config },
    person: null,
    ...(resolution === undefined
      ? {}
      : {
          modelResolution: {
            status: "resolved",
            requestedModel: "requested-alias",
            requestedReasoningEffort: null,
            modelKey: "requested-alias",
            runtimeModel: resolution.runtimeModel,
            provider: resolution.provider,
            codexProfile: null,
            reasoningEffort: null,
          },
        }),
  };
}

function closureEntry(options: {
  workflowId?: string;
  versionId?: string;
  version?: number;
  dependencies?: Record<string, JsonValue>;
} = {}): Record<string, JsonValue> {
  return {
    workflowId: options.workflowId ?? WORKFLOW_ID,
    workflowVersionId: options.versionId ?? VERSION_ID,
    version: options.version ?? 3,
    definitionDigest: DIGEST,
    nodeDependencies: options.dependencies ?? {},
    nodeDependenciesDigest: DIGEST,
  };
}

function completeClosure(dependencies: Record<string, JsonValue> = {}): JsonValue[] {
  return [closureEntry({ dependencies })];
}

interface RecordedCall {
  readonly method: string;
  readonly params: Record<string, JsonValue>;
  readonly options: LocalControlCallOptions;
}

class StubClient implements PreparationReviewClient {
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly handler: (
      method: string,
      params: Record<string, JsonValue>,
    ) => ToolOutput | Promise<ToolOutput>,
  ) {}

  async call(
    method: string,
    params: Record<string, JsonValue>,
    options: LocalControlCallOptions,
  ): Promise<ToolOutput> {
    this.calls.push({ method, params, options });
    return await this.handler(method, params);
  }
}

function workflowData(options: {
  workflowId?: string;
  organizationId?: string;
  selectedVersionId?: string;
  selectedVersionNumber?: number;
  selectedDefinition?: Record<string, JsonValue>;
  versions?: JsonValue[];
} = {}): Record<string, JsonValue> {
  const selectedVersionId = options.selectedVersionId ?? CURRENT_VERSION_ID;
  const selectedVersionNumber = options.selectedVersionNumber ?? 7;
  return {
    workflow: {
      id: options.workflowId ?? WORKFLOW_ID,
      organizationId: options.organizationId ?? ORGANIZATION_ID,
      name: "Quarterly report",
    },
    activeVersion: {
      id: CURRENT_VERSION_ID,
      workflowId: WORKFLOW_ID,
      version: 7,
      versionNumber: 7,
      definition: { nodes: [{ type: "ai_agent", config: { provider: "gemini", model: "current" } }] },
    },
    selectedVersion: {
      id: selectedVersionId,
      workflowId: WORKFLOW_ID,
      version: selectedVersionNumber,
      versionNumber: selectedVersionNumber,
      ...(options.selectedDefinition === undefined
        ? {}
        : { definition: options.selectedDefinition }),
    },
    versions:
      options.versions ??
      [{ id: VERSION_ID, workflowId: WORKFLOW_ID, version: 3, versionNumber: 3 }],
  };
}

test("preparation review resolves exact older-version providers from the bound root and child closure", async () => {
  const workflowClosure: JsonValue[] = [
    closureEntry({
      dependencies: {
        agent: dependency(
          "agent",
          "ai_agent",
          { provider: "openai", modelKey: "requested-agent" },
          { provider: "codex", runtimeModel: "approved-engine" },
        ),
        prompt: dependency(
          "prompt",
          "ai_prompt",
          { providerFamily: "anthropic", model_key: "requested-prompt" },
          { provider: "claude", runtimeModel: "claude-runtime" },
        ),
        child: dependency("child", "sub_workflow", {
          workflowId: CHILD_WORKFLOW_ID,
          workflowVersion: 2,
        }),
      },
    }),
    closureEntry({
      workflowId: CHILD_WORKFLOW_ID,
      versionId: CHILD_VERSION_ID,
      version: 2,
      dependencies: {
        reviewer: dependency(
          "reviewer",
          "person",
          { provider_family: "google", model: "requested-person" },
          { provider: "gemini", runtimeModel: "gemini-runtime" },
        ),
        duplicate: dependency(
          "duplicate",
          "ai_agent",
          { model: "other-request" },
          { provider: "codex", runtimeModel: "approved-engine" },
        ),
      },
    }),
  ];
  const originalPrepare = output("runs.prepare", {
    preparationId: binding.preparationId,
    bindingDigest: binding.bindingDigest,
    binding: {
      workflowId: binding.workflowId,
      versionId: binding.versionId,
      organizationId: binding.organizationId,
      workflowClosure,
      inputs: { privateValue: "binding-stays-authoritative" },
      providerConfiguration: { installed: { codex: { checksumSha256: "do-not-display" } } },
    },
  });
  const before = structuredClone(originalPrepare);
  const preparedReviewBinding = preparationReviewBinding("runs.prepare", originalPrepare);
  assert.deepEqual(preparedReviewBinding, {
    ...binding,
    providers: [
      { name: "codex", model: "approved-engine" },
      { name: "claude", model: "claude-runtime" },
      { name: "gemini", model: "gemini-runtime" },
    ],
  });
  assert.ok(preparedReviewBinding);

  const client = new StubClient((method, params) => {
    if (method === "organizations.list") {
      return output(method, {
        organizations: [
          { id: "c8e8a390-3b63-43cd-89e3-231046cb386c", name: "Other" },
          { id: ORGANIZATION_ID, name: "Acme" },
        ],
      });
    }
    if (params.version === "3") {
      return output(method, workflowData({
        selectedVersionId: VERSION_ID,
        selectedVersionNumber: 3,
        selectedDefinition: {
          nodes: [{ type: "ai_agent", config: { provider: "gemini", model: "unbound-value" } }],
        },
      }));
    }
    return output(method, workflowData());
  });

  const review = await buildPreparationReview(client, preparedReviewBinding);
  assert.deepEqual(review, {
    schemaVersion: PREPARATION_REVIEW_SCHEMA_VERSION,
    ...displayBinding,
    workflowName: "Quarterly report",
    workflowVersion: 3,
    organizationName: "Acme",
    providers: [
      { name: "codex", model: "approved-engine" },
      { name: "claude", model: "claude-runtime" },
      { name: "gemini", model: "gemini-runtime" },
    ],
  });
  assert.deepEqual(originalPrepare, before);
  assert.equal(
    client.calls.some(
      (call) =>
        call.method === "workflows.get" &&
        call.params.workflowId === WORKFLOW_ID &&
        call.params.version === "3",
    ),
    true,
  );
  assert.equal(client.calls.every((call) => call.options.mutating === false), true);
  assert.equal(client.calls.every((call) => (call.options.timeoutMs ?? 0) <= 5_000), true);
  assert.equal(client.calls.every((call) => call.options.signal instanceof AbortSignal), true);
});

test("preparation review rejects mismatched workflow identity and organization ownership", async (t) => {
  for (const mismatch of [
    { workflowId: "da7f1b3a-35a2-40ce-97c8-97bdff1a32d5" },
    { organizationId: "6b430584-e7c4-4667-9b10-bbf411fb39ca" },
  ]) {
    await t.test(JSON.stringify(mismatch), async () => {
      const client = new StubClient((method) =>
        method === "organizations.list"
          ? output(method, { organizations: [{ id: ORGANIZATION_ID, name: "Acme" }] })
          : output(method, workflowData({
              ...mismatch,
              selectedVersionId: VERSION_ID,
              selectedVersionNumber: 3,
              selectedDefinition: { nodes: [] },
            })),
      );
      assert.equal(await buildPreparationReview(client, binding), undefined);
    });
  }
});

test("organization lookup mismatch or failure never supplies a different organization's name", async (t) => {
  for (const organizationResult of ["mismatch", "failure"] as const) {
    await t.test(organizationResult, async () => {
      const client = new StubClient((method) => {
        if (method === "organizations.list") {
          if (organizationResult === "failure") throw new Error("read unavailable");
          return output(method, {
            organizations: [{ id: "dcf032dc-1b2c-4a3b-bf24-cc8312018a58", name: "Wrong org" }],
          });
        }
        return output(method, workflowData({
          selectedVersionId: VERSION_ID,
          selectedVersionNumber: 3,
          selectedDefinition: { nodes: [] },
        }));
      });
      const review = await buildPreparationReview(client, binding);
      assert.equal(review?.organizationName, null);
      assert.deepEqual(review?.providers, []);
    });
  }
});

test("closure projection distinguishes verified no-agent graphs from unavailable provider details", async (t) => {
  const prepareWith = (workflowClosure?: JsonValue): ToolOutput =>
    output("runs.prepare", {
      preparationId: binding.preparationId,
      bindingDigest: binding.bindingDigest,
      binding: {
        workflowId: WORKFLOW_ID,
        versionId: VERSION_ID,
        organizationId: ORGANIZATION_ID,
        ...(workflowClosure === undefined ? {} : { workflowClosure }),
      },
    });

  const noAgents = preparationReviewBinding(
    "runs.prepare",
    prepareWith(completeClosure({ start: dependency("start", "start") })),
  );
  assert.deepEqual(noAgents?.providers, []);
  assert.equal(noAgents?.closureWorkflowVersion, 3);

  const invalidClosures: Array<{ name: string; value?: JsonValue }> = [
    { name: "missing closure" },
    {
      name: "duplicate identity",
      value: [closureEntry(), closureEntry()],
    },
    {
      name: "root identity mismatch",
      value: [
        closureEntry({
          workflowId: CHILD_WORKFLOW_ID,
          versionId: CHILD_VERSION_ID,
          version: 2,
        }),
      ],
    },
    {
      name: "agent resolution missing runtime model",
      value: completeClosure({
        agent: {
          node: { key: "agent", type: "ai_prompt", config: { modelKey: "requested" } },
          modelResolution: { provider: "codex" },
        },
      }),
    },
    {
      name: "root subworkflow target missing from closure",
      value: completeClosure({
        child: dependency("child", "sub_workflow", {
          workflow_id: CHILD_WORKFLOW_ID,
          workflow_version: "v2",
        }),
      }),
    },
    {
      name: "malformed digest",
      value: [{ ...closureEntry(), nodeDependenciesDigest: "not-a-digest" }],
    },
  ];
  for (const fixture of invalidClosures) {
    await t.test(fixture.name, () => {
      const projected = preparationReviewBinding("runs.prepare", prepareWith(fixture.value));
      assert.ok(projected);
      assert.equal(projected.providers, null);
      assert.equal(projected.closureWorkflowVersion, null);
    });
  }
});

test("workflow read failures leave the successful prepare binding unchanged", async () => {
  const prepare = output("builder.prepare", {
    preparationId: binding.preparationId,
    bindingDigest: binding.bindingDigest,
    binding: {
      workflowId: WORKFLOW_ID,
      versionId: VERSION_ID,
      organizationId: ORGANIZATION_ID,
      workflowClosure: completeClosure(),
      retained: { nested: true },
    },
  });
  const before = structuredClone(prepare);
  const client = new StubClient((method) => {
    if (method === "workflows.get") throw new Error("read unavailable");
    return output(method, { organizations: [{ id: ORGANIZATION_ID, name: "Acme" }] });
  });
  const eligible = preparationReviewBinding("builder.prepare", prepare);
  assert.ok(eligible);
  assert.equal(await buildPreparationReview(client, eligible), undefined);
  assert.deepEqual(prepare, before);
});

test("normal, failed, and incomplete calls are not eligible for preparation enrichment", () => {
  const complete = output("runs.prepare", {
    preparationId: binding.preparationId,
    bindingDigest: binding.bindingDigest,
    binding: {
      workflowId: WORKFLOW_ID,
      versionId: VERSION_ID,
      organizationId: ORGANIZATION_ID,
    },
  });
  assert.equal(preparationReviewBinding("workflows.get", complete), undefined);
  assert.equal(
    preparationReviewBinding("runs.prepare", { ...complete, ok: false }),
    undefined,
  );
  assert.equal(
    preparationReviewBinding("runs.prepare", {
      ...complete,
      data: { ...complete.data, binding: { workflowId: WORKFLOW_ID } },
    }),
    undefined,
  );
});

test("MCP attaches review metadata only to a successful preparation result", async (t) => {
  const preparedBinding: Record<string, JsonValue> = {
    workflowId: WORKFLOW_ID,
    versionId: VERSION_ID,
    organizationId: ORGANIZATION_ID,
    installationId: "installation-1",
    workspacePath: "/tmp/workspace",
    executionPolicy: "host_user/v1",
    inputs: {},
    providerConfiguration: {},
    workflowClosure: completeClosure({
      agent: dependency(
        "agent",
        "ai_agent",
        { provider: "openai", model: "requested-model" },
        { provider: "codex", runtimeModel: "gpt-5.6-sol" },
      ),
    }),
  };
  const client = new StubClient((method) => {
    if (method === "runs.prepare") {
      return output(method, {
        preparationId: binding.preparationId,
        bindingDigest: binding.bindingDigest,
        binding: preparedBinding,
        limits: {},
        expiresAt: null,
        confirmationKey: "d09cb0b2-91fd-4289-ae8c-380c2fcb5541",
      });
    }
    if (method === "workflows.get") {
      return output(method, workflowData({
        selectedVersionId: VERSION_ID,
        selectedVersionNumber: 3,
        selectedDefinition: {
          nodes: [{ type: "ai_agent", config: { provider: "codex", model: "gpt-5.6-sol" } }],
        },
      }));
    }
    if (method === "organizations.list") {
      return output(method, { organizations: [{ id: ORGANIZATION_ID, name: "Acme" }] });
    }
    if (method === "status.get") {
      return output(method, {
        version: "0.2.1",
        protocol: LOCAL_PROTOCOL,
        activeJobs: 0,
        draining: false,
        updateDeferred: false,
      });
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const server = createServer(client);
  const mcpClient = new Client({ name: "preparation-review-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  t.after(async () => {
    await mcpClient.close();
    await server.close();
  });

  const result = await mcpClient.callTool({
    name: "loomex_run_prepare",
    arguments: {
      workflowId: WORKFLOW_ID,
      versionId: VERSION_ID,
      workspacePath: "/tmp/workspace",
      idempotencyKey: "63909d1e-c99d-4fb0-af11-a28b0f5be5fb",
    },
  });
  assert.deepEqual(result._meta?.["loomex/uiData"], output("runs.prepare", {
    preparationId: binding.preparationId,
    bindingDigest: binding.bindingDigest,
    binding: preparedBinding,
    limits: {},
    expiresAt: null,
    confirmationKey: "d09cb0b2-91fd-4289-ae8c-380c2fcb5541",
  }));
  assert.deepEqual(result._meta?.["loomex/preparationReview"], {
    schemaVersion: PREPARATION_REVIEW_SCHEMA_VERSION,
    ...displayBinding,
    workflowName: "Quarterly report",
    workflowVersion: 3,
    organizationName: "Acme",
    providers: [{ name: "codex", model: "gpt-5.6-sol" }],
  });

  client.calls.length = 0;
  const readiness = await mcpClient.callTool({ name: "loomex_readiness", arguments: {} });
  assert.equal(readiness._meta?.["loomex/preparationReview"], undefined);
  assert.deepEqual(client.calls.map((call) => call.method), ["status.get"]);
});


test("valid restored preparations rebuild review metadata without preparing again", () => {
  const preparation = {preparationId:binding.preparationId,bindingDigest:binding.bindingDigest,binding:{workflowId:WORKFLOW_ID,versionId:VERSION_ID,organizationId:ORGANIZATION_ID}};
  assert.equal(preparationReviewBinding("preparations.get",output("preparations.get",{status:"valid",operation:"runs.prepare",preparation}))?.preparationId,binding.preparationId);
  assert.equal(preparationReviewBinding("preparations.get",output("preparations.get",{status:"stale",operation:"runs.prepare",preparation})),undefined);
});
