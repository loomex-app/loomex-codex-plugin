import { z } from "zod";

import { JsonValueSchema, type JsonValue } from "./protocol.js";

export const AUTHORING_UI_URI = "ui://loomex/authoring-0.2.0.html";
export const PREPARE_UI_URI = "ui://loomex/prepare-0.2.0.html";
export const MONITOR_UI_URI = "ui://loomex/monitor-0.2.0.html";
export const INTERACTION_UI_URI = "ui://loomex/interaction-0.2.0.html";

type InputSchema = z.ZodObject<z.ZodRawShape>;

export interface ToolDefinition {
  readonly name: string;
  readonly rpcMethod: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly mutating: boolean;
  readonly destructive: boolean;
  readonly uiUri?: string;
}

const Empty = z.object({}).strict();
const Uuid = z.uuid();
const IdempotencyKey = Uuid.describe(
  "A UUID retained for this intended mutation. Reuse it after NETWORK_AMBIGUOUS; do not create a new key for the same mutation.",
);
const Cursor = z.string().min(1).optional();
const PageLimit = z.number().int().min(0).optional();
const ByteLimit = z.number().int().min(0).optional();
const TimeoutSeconds = z.number().int().min(0).optional();
const AbsolutePath = z.string().min(1).refine((value) => value.startsWith("/"), {
  message: "Path must be absolute; the runner resolves and verifies its canonical path.",
});
const JsonObject = z.record(z.string(), JsonValueSchema);

function containsSecretInput(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsSecretInput);
  if (value === null || typeof value !== "object") return false;
  if (value.source === "secret") return true;
  return Object.values(value).some(containsSecretInput);
}

const WorkflowDefinition = JsonObject.superRefine((value, context) => {
  if (containsSecretInput(value)) {
    context.addIssue({
      code: "custom",
      message: "Secret input mappings are not supported by Loomex.",
    });
  }
});

const StreamQuery = {
  afterSequence: z.number().int().min(0).optional(),
  limit: PageLimit,
  timeoutSeconds: TimeoutSeconds,
  includeAiTrace: z.boolean().optional(),
};

const BuilderStreamQuery = {
  afterSequence: z.number().int().min(0).optional(),
  limit: PageLimit,
  timeoutSeconds: TimeoutSeconds,
};

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "loomex_readiness",
    rpcMethod: "status.get",
    title: "Check Loomex readiness",
    description:
      "Check local runner liveness, protocol version, drain state, and active-job count without returning credentials. Use the focused auth, organization, workspace, and builder catalog tools for their separate readiness checks.",
    inputSchema: Empty,
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_auth_status",
    rpcMethod: "auth.status",
    title: "Check Loomex authentication",
    description: "Return Loomex authentication state without returning credentials or tokens.",
    inputSchema: Empty,
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_auth_start",
    rpcMethod: "auth.login",
    title: "Start Loomex authentication",
    description:
      "Start device authentication and return a verification URI, user code, expiry, and polling interval. This tool never accepts a credential.",
    inputSchema: z
      .object({
        runnerName: z.string().min(1).optional(),
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: false,
  },
  {
    name: "loomex_auth_poll",
    rpcMethod: "auth.poll",
    title: "Poll Loomex authentication",
    description:
      "Poll the active device flow. On success, the runner stores Loomex credentials in the user's Keychain and returns only non-secret IDs.",
    inputSchema: z.object({ idempotencyKey: IdempotencyKey }).strict(),
    mutating: true,
    destructive: false,
  },
  {
    name: "loomex_auth_logout",
    rpcMethod: "auth.logout",
    title: "Log out of Loomex",
    description:
      "Revoke Loomex authentication and remove runner-owned Loomex credentials. Provider CLI account stores are separate.",
    inputSchema: z.object({ idempotencyKey: IdempotencyKey }).strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_organizations_list",
    rpcMethod: "organizations.list",
    title: "List Loomex organizations",
    description: "List organizations available to the authenticated runner identity.",
    inputSchema: Empty,
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_organization_select",
    rpcMethod: "organizations.select",
    title: "Select Loomex organization",
    description: "Select the organization used for subsequent workflow and run operations.",
    inputSchema: z
      .object({ organizationId: Uuid, idempotencyKey: IdempotencyKey })
      .strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_workspaces_list",
    rpcMethod: "workspaces.list",
    title: "List granted workspaces",
    description:
      "List canonical workspace roots granted for the selected organization and runner installation.",
    inputSchema: Empty,
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_workspace_grant",
    rpcMethod: "workspaces.grant",
    title: "Grant Loomex workspace",
    description:
      "Remember the user's approval to execute in a canonical workspace root. This records scope but does not sandbox host-user processes.",
    inputSchema: z
      .object({
        workspacePath: AbsolutePath,
        organizationId: Uuid.optional(),
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: false,
  },
  {
    name: "loomex_workspace_revoke",
    rpcMethod: "workspaces.revoke",
    title: "Revoke Loomex workspace",
    description: "Remove a remembered workspace execution grant for this organization and installation.",
    inputSchema: z
      .object({
        workspacePath: AbsolutePath,
        organizationId: Uuid.optional(),
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_workflows_list",
    rpcMethod: "workflows.list",
    title: "List Loomex workflows",
    description: "Discover workflows in the selected organization with cursor pagination.",
    inputSchema: z
      .object({
        query: z.string().optional(),
        cursor: Cursor,
        limit: PageLimit,
        systemKey: z.string().optional(),
      })
      .strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_workflow_get",
    rpcMethod: "workflows.get",
    title: "Get Loomex workflow",
    description: "Get a workflow and its requested immutable version or current draft metadata.",
    inputSchema: z.object({ workflowId: Uuid, version: z.string().optional() }).strict(),
    mutating: false,
    destructive: false,
    uiUri: AUTHORING_UI_URI,
  },
  {
    name: "loomex_workflow_create",
    rpcMethod: "workflows.create",
    title: "Create Loomex workflow",
    description: "Create a new empty workflow record for subsequent editor or direct definition updates.",
    inputSchema: z
      .object({
        name: z.string().min(1),
        slug: z.string().min(1).optional(),
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: false,
  },
  {
    name: "loomex_workflow_update",
    rpcMethod: "workflows.update",
    title: "Update Loomex workflow",
    description:
      "Update workflow metadata or its draft definition with optional optimistic version checking. Validate the resulting definition before publishing.",
    inputSchema: z
      .object({
        workflowId: Uuid,
        name: z.string().min(1).optional(),
        definition: WorkflowDefinition.optional(),
        notes: z.string().optional(),
        expectedVersion: z.number().int().min(0).optional(),
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_workflow_validate",
    rpcMethod: "workflows.validate",
    title: "Validate Loomex workflow",
    description:
      "Validate a complete workflow definition, including node configuration, graph structure, provider support, and the absence of unsupported secret inputs.",
    inputSchema: z.object({ definition: WorkflowDefinition }).strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_workflow_publish",
    rpcMethod: "workflows.publish",
    title: "Publish Loomex workflow version",
    description: "Publish the validated draft as an immutable version. Publishing does not activate it.",
    inputSchema: z
      .object({
        workflowId: Uuid,
        notes: z.string().optional(),
        expectedVersion: z.number().int().min(0).optional(),
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: false,
  },
  {
    name: "loomex_workflow_activate",
    rpcMethod: "workflows.activate",
    title: "Activate Loomex workflow version",
    description: "Make a published immutable workflow version the active version used by default.",
    inputSchema: z.object({ versionId: Uuid, idempotencyKey: IdempotencyKey }).strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_builder_catalog",
    rpcMethod: "builder.catalog",
    title: "Get Loomex builder catalog",
    description:
      "Get canonical node types, provider capabilities, field schemas, and graph rules before authoring a workflow.",
    inputSchema: Empty,
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_builder_validate",
    rpcMethod: "builder.validate",
    title: "Validate builder definition",
    description: "Validate an in-progress definition against the current builder catalog without storing it.",
    inputSchema: z.object({ definition: WorkflowDefinition }).strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_builder_prepare",
    rpcMethod: "builder.prepare",
    title: "Prepare Loomex workflow builder",
    description:
      "Prepare, but do not start, a conversational workflow-building session. Returns the exact canonical workspace, provider, host_user/v1 authority, binding digest, and confirmation key for review.",
    inputSchema: z
      .object({
        prompt: z.string().min(1),
        model: z.string().min(1).optional(),
        workspacePath: AbsolutePath,
        providerConfiguration: JsonObject.optional(),
        context: JsonObject.optional(),
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: false,
    uiUri: PREPARE_UI_URI,
  },
  {
    name: "loomex_builder_commit",
    rpcMethod: "builder.commit",
    title: "Commit prepared Loomex workflow builder",
    description:
      "Start exactly one prepared builder session after the user accepts its exact binding. Pass the preparation ID, digest, and confirmation key back unchanged.",
    inputSchema: z
      .object({
        preparationId: Uuid,
        bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
        confirmationKey: Uuid,
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_builder_get",
    rpcMethod: "builder.get",
    title: "Get Loomex builder session",
    description: "Get new builder events, draft state, and any typed question requiring a response.",
    inputSchema: z
      .object({ sessionId: Uuid, ...BuilderStreamQuery })
      .strict(),
    mutating: false,
    destructive: false,
    uiUri: AUTHORING_UI_URI,
  },
  {
    name: "loomex_builder_respond",
    rpcMethod: "builder.respond",
    title: "Respond to Loomex builder",
    description: "Submit a structured answer to the active builder session and return its authoritative state.",
    inputSchema: z
      .object({ sessionId: Uuid, response: JsonObject, idempotencyKey: IdempotencyKey })
      .strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_builder_finalize",
    rpcMethod: "builder.finalize",
    title: "Finalize Loomex builder",
    description: "Finalize a completed builder session and return the resulting workflow definition or workflow IDs.",
    inputSchema: z.object({ sessionId: Uuid, idempotencyKey: IdempotencyKey }).strict(),
    mutating: true,
    destructive: false,
  },
  {
    name: "loomex_editor_prepare",
    rpcMethod: "editor.prepare",
    title: "Prepare Loomex workflow editor",
    description:
      "Prepare, but do not start, a conversational edit session for an existing workflow. Returns its exact workspace, provider, host_user/v1 authority, binding digest, and confirmation key for review.",
    inputSchema: z
      .object({
        workflowId: Uuid,
        prompt: z.string().min(1),
        model: z.string().min(1).optional(),
        workspacePath: AbsolutePath,
        providerConfiguration: JsonObject.optional(),
        context: JsonObject.optional(),
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: false,
    uiUri: PREPARE_UI_URI,
  },
  {
    name: "loomex_editor_commit",
    rpcMethod: "editor.commit",
    title: "Commit prepared Loomex workflow editor",
    description:
      "Start exactly one prepared editor session after the user accepts its exact binding. Pass the preparation ID, digest, and confirmation key back unchanged.",
    inputSchema: z
      .object({
        preparationId: Uuid,
        bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
        confirmationKey: Uuid,
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_editor_respond",
    rpcMethod: "editor.respond",
    title: "Respond to Loomex editor",
    description: "Submit a structured answer to the active editor session and return its authoritative state.",
    inputSchema: z
      .object({ sessionId: Uuid, response: JsonObject, idempotencyKey: IdempotencyKey })
      .strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_editor_finalize",
    rpcMethod: "editor.finalize",
    title: "Finalize Loomex editor",
    description:
      "Finalize a completed editor session. Pass confirm false to preview the proposed workflow update without applying it, or true only after the user approves applying that exact update.",
    inputSchema: z
      .object({ sessionId: Uuid, confirm: z.boolean(), idempotencyKey: IdempotencyKey })
      .strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_run_prepare",
    rpcMethod: "runs.prepare",
    title: "Prepare Loomex run",
    description:
      "Prepare, but do not start, a workflow run. Returns the exact immutable version, canonical workspace, organization, provider configuration, host_user/v1 policy, unlimited product limits, binding digest, and local confirmation key for review.",
    inputSchema: z
      .object({
        workflowId: Uuid,
        versionId: Uuid,
        inputs: JsonObject.optional(),
        workspacePath: AbsolutePath,
        providerConfiguration: JsonObject.optional(),
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: false,
    uiUri: PREPARE_UI_URI,
  },
  {
    name: "loomex_run_commit",
    rpcMethod: "runs.commit",
    title: "Commit prepared Loomex run",
    description:
      "Start exactly one prepared run after the user has reviewed and accepted its exact binding. Pass the preparation ID, digest, and confirmation key back unchanged.",
    inputSchema: z
      .object({
        preparationId: Uuid,
        bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
        confirmationKey: Uuid,
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_runs_list",
    rpcMethod: "runs.list",
    title: "List Loomex runs",
    description: "List workflow runs in the selected organization with cursor pagination.",
    inputSchema: z
      .object({ cursor: Cursor, limit: PageLimit, workflowId: Uuid.optional(), status: z.string().optional() })
      .strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_run_get",
    rpcMethod: "runs.get",
    title: "Get Loomex run",
    description: "Get current authoritative run state and a bounded page of recent execution information.",
    inputSchema: z.object({ runId: Uuid, ...StreamQuery }).strict(),
    mutating: false,
    destructive: false,
    uiUri: MONITOR_UI_URI,
  },
  {
    name: "loomex_run_wait",
    rpcMethod: "runs.wait",
    title: "Wait for Loomex run change",
    description:
      "Wait for a runner-normalized long poll (currently at most 45 seconds) for a run revision, terminal state, or required interaction, then return a finite page. This does not limit run duration.",
    inputSchema: z.object({ runId: Uuid, ...StreamQuery }).strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_run_events",
    rpcMethod: "runs.events",
    title: "Get Loomex run events",
    description:
      "Read a bounded page of complete run events after a sequence. Continue with returned sequence/page references; aggregate output is unlimited.",
    inputSchema: z.object({ runId: Uuid, ...StreamQuery }).strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_run_result",
    rpcMethod: "runs.result",
    title: "Get Loomex run result",
    description:
      "Read terminal result metadata or a bounded result page. Follow response references until complete when output exceeds one local-control frame.",
    inputSchema: z.object({ runId: Uuid, ...StreamQuery }).strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_run_cancel",
    rpcMethod: "runs.cancel",
    title: "Cancel Loomex run",
    description:
      "Request cancellation of a run. The result distinguishes request acceptance, managed execution stop, and indeterminate external effects.",
    inputSchema: z
      .object({ runId: Uuid, reason: z.string().min(1), idempotencyKey: IdempotencyKey })
      .strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_run_delete",
    rpcMethod: "runs.delete",
    title: "Delete Loomex run",
    description:
      "Delete a run record and unlink exclusively owned generated artifacts according to reference-aware retention rules.",
    inputSchema: z
      .object({
        runId: Uuid,
        confirm: z.literal(true),
        reason: z.string().optional(),
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_interactions_list",
    rpcMethod: "interactions.list",
    title: "List Loomex interactions",
    description: "List typed human interaction requests, optionally filtered by run, status, or request type.",
    inputSchema: z
      .object({
        runId: Uuid.optional(),
        cursor: Cursor,
        limit: PageLimit,
        status: z.string().optional(),
        requestType: z.string().optional(),
      })
      .strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_interaction_get",
    rpcMethod: "interactions.get",
    title: "Get Loomex interaction",
    description: "Get one pending interaction with its typed answer schema and authoritative state.",
    inputSchema: z.object({ requestId: Uuid }).strict(),
    mutating: false,
    destructive: false,
    uiUri: INTERACTION_UI_URI,
  },
  {
    name: "loomex_interaction_respond",
    rpcMethod: "interactions.respond",
    title: "Respond to Loomex interaction",
    description:
      "Submit a structured answer matching the pending interaction's typed schema. Do not use this tool for approval decisions.",
    inputSchema: z
      .object({
        requestId: Uuid,
        answer: JsonObject,
        requestType: z.string().optional(),
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_interaction_decide",
    rpcMethod: "interactions.decide",
    title: "Decide Loomex approval",
    description: "Approve or reject a typed Loomex approval request with an optional reason.",
    inputSchema: z
      .object({
        requestId: Uuid,
        decision: z.enum(["approve", "reject"]),
        reason: z.string().optional(),
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_artifacts_list",
    rpcMethod: "artifacts.list",
    title: "List Loomex run artifacts",
    description: "List a run's scoped artifacts with cursor pagination and stable artifact IDs.",
    inputSchema: z.object({ runId: Uuid, cursor: Cursor, limit: PageLimit }).strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_artifact_read",
    rpcMethod: "artifacts.read",
    title: "Read Loomex artifact page",
    description:
      "Read up to 262144 bytes of a scoped artifact as base64. Continue from nextOffset; aggregate artifact size is unlimited.",
    inputSchema: z
      .object({ artifactId: Uuid, offset: z.number().int().min(0).optional(), limit: ByteLimit })
      .strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_artifact_download",
    rpcMethod: "artifacts.download",
    title: "Download Loomex artifact",
    description:
      "Ask the owner-checked runner to download a scoped artifact to an absolute local path, verify its SHA-256, and return the final path and artifact ID.",
    inputSchema: z
      .object({
        artifactId: Uuid,
        destinationPath: AbsolutePath,
        overwrite: z.boolean().optional(),
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_response_read",
    rpcMethod: "responses.read",
    title: "Read Loomex response page",
    description:
      "Read a page from an owner-only immutable response spool when a workflow, run, or catalog result exceeds one local-control frame. Continue from nextOffset and verify checksumSha256.",
    inputSchema: z
      .object({ responseRef: Uuid, offset: z.number().int().min(0).optional(), limit: ByteLimit })
      .strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_response_delete",
    rpcMethod: "responses.delete",
    title: "Delete Loomex response spool",
    description:
      "Delete an owner-only local response spool after every page has been consumed and its full SHA-256 verified.",
    inputSchema: z.object({ responseRef: Uuid, idempotencyKey: IdempotencyKey }).strict(),
    mutating: true,
    destructive: true,
  },
] as const;

export const TOOL_NAMES = TOOL_DEFINITIONS.map((definition) => definition.name);

const SEMANTIC_CAPABILITIES = [
  "execution.host_user/v1",
  "authorization.prepare-commit/v1",
  "auth.device-v2/v1",
  "transfer.chunked/v1",
] as const;

export const REQUIRED_RUNNER_CAPABILITIES = Object.freeze([
  ...TOOL_DEFINITIONS.map((definition) => `method:${definition.rpcMethod}`),
  ...SEMANTIC_CAPABILITIES,
]);
