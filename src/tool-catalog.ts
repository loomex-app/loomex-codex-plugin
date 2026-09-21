import { z } from "zod";

import {
  JsonValueSchema,
  RECOVERY_COORDINATION_CAPABILITY,
  VALIDATION_ERRORS_CAPABILITY,
  type JsonValue,
} from "./protocol.js";
import {
  RUN_GET_MONITORING_DESCRIPTION,
  RUN_WAIT_MONITORING_DESCRIPTION,
} from "./monitoring-contract.js";
export {
  AUTHORING_UI_URI,
  BROWSER_UI_URI,
  CONNECTION_UI_URI,
  INTERACTION_UI_URI,
  MONITOR_UI_URI,
  ORGANIZATIONS_UI_URI,
  PREPARE_UI_URI,
  RUNS_UI_URI,
} from "./ui-resources.js";
import {
  AUTHORING_UI_URI,
  BROWSER_UI_URI,
  CONNECTION_UI_URI,
  INTERACTION_UI_URI,
  MONITOR_UI_URI,
  ORGANIZATIONS_UI_URI,
  PREPARE_UI_URI,
  RUNS_UI_URI,
} from "./ui-resources.js";

type InputSchema = z.ZodObject<z.ZodRawShape>;

export interface ToolDefinition {
  readonly name: string;
  readonly rpcMethod: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly mutating: boolean;
  readonly destructive: boolean;
  /** Defaults to true; set false when a retry can rotate or consume authority. */
  readonly idempotent?: boolean;
  /** Tool is callable by the mounted app only; its result must not be model-visible. */
  readonly appOnly?: boolean;
  readonly uiUri?: string;
  /** Input fields handled by this MCP adapter and never sent over local-control. */
  readonly localOnlyInputKeys?: readonly string[];
  /** Public input names translated to established local-control parameter names. */
  readonly runnerInputAliases?: Readonly<Record<string, string>>;
  /** Established local-control inputs deliberately hidden from the public tool contract. */
  readonly omittedRunnerInputKeys?: readonly string[];
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
const TaskContext = z
  .object({
    cwd: AbsolutePath.describe("The actual current working directory of the active local Codex task."),
  })
  .strict();
const TaskWorkspaceInput = {
  taskContext: TaskContext.describe(
    "Required context supplied by the calling Codex skill for the active local task. The plugin cannot discover or infer this cwd. It is a workspace suggestion, not execution authority.",
  ),
  workspacePath: AbsolutePath.optional().describe(
    "An explicit workspace chosen by the user for this operation. When present, it overrides taskContext.cwd in setup.",
  ),
};
const TASK_WORKSPACE_INPUT_KEYS = ["taskContext", "workspacePath"] as const;
export const TASK_WORKSPACE_TOOL_NAMES = new Set([
  "loomex_workflows_view",
  "loomex_workflow_view",
  "loomex_run_setup",
]);
const JsonObject = z.record(z.string(), JsonValueSchema);

/**
 * Provider authentication belongs to the installed provider CLI or its
 * host-owned credential store. Preparations may select non-secret provider
 * settings, but must never transport credentials to the runner or review UI.
 */
function inlineProviderCredentialKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "password" ||
    normalized === "authorization" ||
    normalized === "credential" ||
    normalized === "credentials" ||
    normalized === "token" ||
    normalized === "key" ||
    normalized.endsWith("secret") ||
    /(?:api|access|refresh|bearer|auth)token$/.test(normalized) ||
    /(?:api|access|private|secret|signing|client)key$/.test(normalized);
}

function providerCredentialPath(value: JsonValue, path = "providerConfiguration"): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nested = providerCredentialPath(item, `${path}[${index}]`);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  for (const [key, item] of Object.entries(value)) {
    const fieldPath = `${path}.${key}`;
    if (inlineProviderCredentialKey(key)) return fieldPath;
    const nested = providerCredentialPath(item, fieldPath);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

const ProviderConfiguration = JsonObject.superRefine((value, context) => {
  const credentialPath = providerCredentialPath(value);
  if (credentialPath !== undefined) {
    context.addIssue({
      code: "custom",
      message: `${credentialPath} is not allowed. Configure provider authentication through the installed provider CLI or its host-owned credential store.`,
    });
  }
});
const HostId = z.string().min(1).max(512);
const HostTaskId = z.string().min(1).max(512);
const RecoveryBinding = z.object({ hostId: HostId, hostTaskId: HostTaskId, runId: Uuid }).strict();
const RecoveryIntent = z.enum(["enabled", "stopped"]);
const RecoveryOperation = z.object({
  kind: z.enum(["create", "update", "pause", "remove"]),
  arguments: JsonObject,
  idempotencyKey: IdempotencyKey,
}).strict();
const RecoveryLifecycle = z.enum(["unchecked", "verified", "unavailable", "ambiguous", "paused", "removed"]);

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

const BASE_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  { name:"loomex_connection_view_create", rpcMethod:"connection.views.create", title:"Create connection view state", description:"Create local connection navigation and pending operation state; never changes authentication or organization selection.", inputSchema:z.object({kind:z.enum(["connection", "organizations"]), entityType:z.literal("catalog"), entityId:Uuid, state:JsonObject, idempotencyKey:IdempotencyKey}).strict(), mutating:true, destructive:false },
  { name:"loomex_connection_view_get", rpcMethod:"connection.views.get", title:"Get connection view state", description:"Get local connection navigation and pending operation state; never changes authentication or organization selection.", inputSchema:z.object({viewSessionId:Uuid}).strict(), mutating:false, destructive:false },
  { name:"loomex_connection_view_update", rpcMethod:"connection.views.update", title:"Update connection view state", description:"Update local connection navigation and pending operation state; never changes authentication or organization selection.", inputSchema:z.object({viewSessionId:Uuid, expectedRevision:z.number().int().nonnegative(), state:JsonObject, idempotencyKey:IdempotencyKey}).strict(), mutating:true, destructive:false },
  {
    name: "loomex_preparation_get", rpcMethod: "preparations.get", title: "Restore Loomex preparation",
    description: "Read an existing owner-bound preparation without preparing or starting again. Restore only a valid exact review; stale preparations require the returned recovery action. Reading never confirms execution.",
    inputSchema: z.object({ preparationId: Uuid }).strict(), mutating: false, destructive: false,
  },
  {
    name: "loomex_view_session_create", rpcMethod: "presentation.sessions.create", title: "Remember Loomex view",
    description: "Create an owner-scoped durable presentation session. Stored state never authorizes workflow execution.",
    inputSchema: z.object({ kind: z.enum(["browser", "runs", "authoring", "prepare", "monitor", "interaction"]), entityType: z.enum(["catalog", "workflow", "request", "execution", "builderSession", "preparation"]), entityId: Uuid, state: JsonObject, idempotencyKey: IdempotencyKey }).strict(),
    mutating: true, destructive: false,
  },
  {
    name: "loomex_view_session_get", rpcMethod: "presentation.sessions.get", title: "Restore Loomex view",
    description: "Read the exact presentation session for the current owner. Reconcile current domain state before restoring drafts or navigation.",
    inputSchema: z.object({ viewSessionId: Uuid }).strict(), mutating: false, destructive: false,
  },
  {
    name: "loomex_view_session_restore", rpcMethod: "presentation.sessions.restore", title: "Load Loomex view snapshot",
    description: "Read an owner-scoped, display-only presentation snapshot for fast view restoration. It never authorizes an action; reconcile authoritative state before enabling changes.",
    inputSchema: z.object({ viewSessionId: Uuid }).strict(), mutating: false, destructive: false,
  },
  {
    name: "loomex_view_session_update", rpcMethod: "presentation.sessions.update", title: "Save Loomex view",
    description: "Persist presentation state at its exact revision and optionally journal a pending operation. A conflict requires reconciliation. Journaling never executes the operation.",
    inputSchema: z.object({ viewSessionId: Uuid, expectedRevision: z.number().int().nonnegative(), state: JsonObject, status: z.enum(["active", "inactive", "resolved"]).optional(),
      operation: z.object({ method: z.string(), params: JsonObject, idempotencyKey: IdempotencyKey, reconciliation: z.object({method:z.string(),params:JsonObject}).strict().optional() }).strict().optional(), idempotencyKey: IdempotencyKey }).strict(),
    mutating: true, destructive: false,
  },
  {
    name: "loomex_view_session_delete", rpcMethod: "presentation.sessions.delete", title: "Forget Loomex view",
    description: "Delete the exact local presentation session. Does not cancel or delete the workflow run.",
    inputSchema: z.object({ viewSessionId: Uuid, idempotencyKey: IdempotencyKey }).strict(), mutating: true, destructive: true,
  },
  {
    name: "loomex_view_operation_get", rpcMethod: "presentation.operations.get", title: "Reconcile Loomex operation",
    description: "Read the exact owner-scoped operation journal for this view. Reconcile its outcome before any retry; never change its arguments or key.",
    inputSchema: z.object({ viewSessionId: Uuid, operationId: Uuid }).strict(), mutating: false, destructive: false,
  },
  {
    name: "loomex_view_operation_settle", rpcMethod: "presentation.operations.settle", title: "Record Loomex operation outcome",
    description: "Record a verified completion or ambiguous outcome of an existing operation. Does not execute it.",
    inputSchema: z.object({ viewSessionId: Uuid, operationId: Uuid, status: z.enum(["completed", "ambiguous"]), resultReference: JsonObject.optional(), idempotencyKey: IdempotencyKey }).strict(),
    mutating: true, destructive: false,
  },
  {
    name: "loomex_delivery_get", rpcMethod: "presentation.delivery.get", title: "Read chat continuation",
    description: "Read the owner-bound continuation and delivery outcome without sending or executing work.",
    inputSchema: z.object({identity:z.string().min(1).max(384)}).strict(), mutating:false, destructive:false, appOnly:true,
  },
  {
    name: "loomex_delivery_begin", rpcMethod: "presentation.delivery.begin", title: "Reserve chat continuation",
    description: "Reserve one exact continuation delivery attempt. Never approves or executes a workflow.",
    inputSchema: z.object({identity:z.string().min(1).max(384),expectedRevision:z.number().int().nonnegative(),attemptId:Uuid,idempotencyKey:IdempotencyKey}).strict(), mutating:true, destructive:false, appOnly:true,
  },
  {
    name: "loomex_delivery_settle", rpcMethod: "presentation.delivery.settle", title: "Record chat delivery outcome",
    description: "Settle the exact reserved delivery attempt. Host acknowledgement does not prove chat execution.",
    inputSchema: z.object({identity:z.string().min(1).max(384),expectedRevision:z.number().int().nonnegative(),attemptId:Uuid,status:z.enum(["not_sent","acknowledged","rejected","unknown"]),idempotencyKey:IdempotencyKey,errorCode:z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional()}).strict(), mutating:true, destructive:false, appOnly:true,
  },
  {
    name: "loomex_recovery_get", rpcMethod: "recovery.get", title: "Read Loomex recovery coordination",
    description: "Read the exact owner-bound recovery coordination record for a host task and run. This does not schedule, pause, or remove host recovery.",
    inputSchema: z.object({ binding: RecoveryBinding }).strict(), mutating: false, destructive: false,
  },
  {
    name: "loomex_recovery_update", rpcMethod: "recovery.update", title: "Update Loomex recovery coordination",
    description: "Create or update local recovery intent and checkpoints at the exact binding and revision. This stores coordination only; it does not schedule or mutate a workflow.",
    inputSchema: z.object({ binding: RecoveryBinding, expectedRevision: z.number().int().nonnegative(), initialization: z.string().min(1).max(512).optional(), monitoringIntent: RecoveryIntent.optional(), lastEventSequence: z.number().int().nonnegative().optional(), pendingRequestId: Uuid.nullable().optional(), presentationReference: z.string().min(1).max(512).optional(), cleanupStatus: z.string().min(1).max(512).optional(), diagnosticReason: z.string().min(1).max(1_024).optional(), idempotencyKey: IdempotencyKey }).strict(),
    mutating: true, destructive: false,
  },
  {
    name: "loomex_recovery_operation_begin", rpcMethod: "recovery.operations.begin", title: "Journal Loomex recovery operation",
    description: "Atomically journal an exact host-recovery operation and return whether this caller may attempt it. This tool does not invoke host scheduling.",
    inputSchema: z.object({ binding: RecoveryBinding, expectedRevision: z.number().int().nonnegative(), operation: RecoveryOperation, idempotencyKey: IdempotencyKey }).strict(),
    mutating: true, destructive: false,
  },
  {
    name: "loomex_recovery_operation_settle", rpcMethod: "recovery.operations.settle", title: "Settle Loomex recovery operation",
    description: "Record an exact recovery operation outcome, any known host automation ID, and host-reported observation. This tool does not invoke or verify host scheduling itself.",
    inputSchema: z.object({ binding: RecoveryBinding, expectedRevision: z.number().int().nonnegative(), operationId: Uuid, status: z.enum(["succeeded", "ambiguous"]), automationId: z.string().min(1).max(512).optional(), hostEvidence: JsonObject.optional(), lifecycle: RecoveryLifecycle.optional(), idempotencyKey: IdempotencyKey }).strict(),
    mutating: true, destructive: false,
  },
  {
    name: "loomex_connection_get",
    rpcMethod: "connection.get",
    title: "Get Loomex connection",
    description: "Read the current Loomex sign-in and organization connection state without starting, polling, or changing a login flow.",
    inputSchema: Empty,
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_connection_view",
    rpcMethod: "connection.get",
    uiUri: CONNECTION_UI_URI,
    title: "View Loomex connection",
    description: "Show the current Loomex connection, sign-in, and organization state. Opening or refreshing this view never starts or changes authentication.",
    inputSchema: Empty,
    mutating: false,
    destructive: false,
  },
  {
    // Keep organization management as its own UI entry point.  A command
    // should not have to rely on an agent inferring that the more general
    // connection card is the visual organization surface.
    name: "loomex_organizations_view",
    rpcMethod: "connection.get",
    uiUri: ORGANIZATIONS_UI_URI,
    title: "View Loomex organizations",
    description: "Show the selected Loomex organization and available organizations in the focused organization picker. Opening this view never changes organization scope.",
    inputSchema: Empty,
    mutating: false,
    destructive: false,
  },
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
      "Poll one exact active device flow. On success, the runner stores Loomex credentials in the user's Keychain and returns only non-secret IDs.",
    inputSchema: z.object({ flowId: z.string().min(1).max(160), idempotencyKey: IdempotencyKey }).strict(),
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
      "Register the user's selected canonical workspace for preparation, scoped to organization and installation. Execution still requires confirmation of the exact prepared run. This is not a sandbox.",
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
    description: "Discover workflows headlessly in the selected organization with cursor pagination. Use loomex_workflows_view for a browsable visual list. This is not a monitoring tool for an existing run.",
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
    name: "loomex_workflows_view",
    uiUri: BROWSER_UI_URI,
    rpcMethod: "workflows.list",
    title: "Browse Loomex workflows",
    description: "Show a compact workflow list for the user to browse, inspect, or prepare. Always pass the calling Codex task's actual cwd as taskContext.cwd so later Prepare actions stay bound to this task; pass workspacePath only for an explicit user override. Missing task context is an input error because the plugin never infers a cwd. Reads the current authorized list for the supplied search and cursor. Use loomex_workflows_list for headless discovery; do not open this view when following an existing run.",
    inputSchema: z
      .object({
        query: z.string().optional(),
        cursor: Cursor,
        limit: PageLimit,
        systemKey: z.string().optional(),
        ...TaskWorkspaceInput,
      })
      .strict(),
    mutating: false,
    destructive: false,
    localOnlyInputKeys: TASK_WORKSPACE_INPUT_KEYS,
  },
  {
    name: "loomex_workflow_get",
    rpcMethod: "workflows.get",
    title: "Get Loomex workflow",
    description: "Read workflow metadata and its requested immutable version without opening a UI. For an explicit visual review use loomex_workflow_view. To run a workflow, begin with loomex_run_setup to collect required inputs before preparing.",
    inputSchema: z.object({ workflowId: Uuid, version: z.string().optional() }).strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_workflow_view",
    rpcMethod: "workflows.get",
    title: "View Loomex workflow",
    description: "Open a visual workflow detail view only when the user asks to inspect a workflow. Always pass the calling Codex task's actual cwd as taskContext.cwd so the optional Prepare action stays bound to this task; pass workspacePath only for an explicit user override. Missing task context is an input error because the plugin never infers a cwd. Do not call this as a prerequisite to running; use loomex_run_setup instead.",
    inputSchema: z.object({ workflowId: Uuid, version: z.string().optional(), ...TaskWorkspaceInput }).strict(),
    mutating: false,
    destructive: false,
    uiUri: AUTHORING_UI_URI,
    localOnlyInputKeys: TASK_WORKSPACE_INPUT_KEYS,
  },
  {
    name: "loomex_run_setup",
    rpcMethod: "workflows.get",
    title: "Set up Loomex run",
    description: "Start here when the user asks to run a workflow, including typed commands. Always pass the calling Codex task's actual cwd as taskContext.cwd; setup uses it as the initial workspace. Pass workspacePath only when the user explicitly chose another workspace. Missing task context is an input error because the plugin never infers a cwd or lets UI state substitute one. Reads the exact workflow schema and opens one preparation flow. The UI automatically verifies/registers the selected workspace and prepares a review when no authored workflow inputs are needed; otherwise it collects those missing inputs. Only an explicit Start commits execution. Do not duplicate UI preparation calls in chat, silently omit inputs, or invent values.",
    inputSchema: z.object({ workflowId: Uuid, version: z.string().optional(), ...TaskWorkspaceInput }).strict(),
    mutating: false,
    destructive: false,
    uiUri: PREPARE_UI_URI,
    localOnlyInputKeys: TASK_WORKSPACE_INPUT_KEYS,
  },
  {
    name: "loomex_workflow_create",
    rpcMethod: "workflows.create",
    title: "Create Loomex workflow",
    description: "Create a workflow and, when definition is supplied, save its validated draft atomically. Publishing, activation, and execution remain separate actions.",
    inputSchema: z
      .object({
        name: z.string().min(1),
        slug: z.string().min(1).optional(),
        definition: WorkflowDefinition.optional(),
        notes: z.string().optional(),
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
    description: "Publish the validated draft as an immutable version and make it the version used for future runs.",
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
      "Compatibility path for an existing execution-backed builder integration; active-chat conversational authoring instead uses the builder catalog, validation, and workflow create/update. This prepares, but does not start, that compatibility session and returns its exact canonical workspace, provider, host_user/v1 authority, binding digest, and confirmation key for explicit review before commit.",
    inputSchema: z
      .object({
        prompt: z.string().min(1),
        model: z.string().min(1).optional(),
        workspacePath: AbsolutePath,
        providerConfiguration: ProviderConfiguration.optional(),
        context: JsonObject.optional(),
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: false,
  },
  {
    name: "loomex_builder_commit",
    rpcMethod: "builder.commit",
    title: "Commit prepared Loomex workflow builder",
    description:
      "Start exactly one prepared execution-backed compatibility builder session after explicit acceptance of its exact binding. Pass the preparation ID, digest, and confirmation key back unchanged.",
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
    description: "Headlessly read an existing compatibility builder or editor session for observation and recovery. It does not start a new active-chat authoring route.",
    inputSchema: z
      .object({ sessionId: Uuid, ...BuilderStreamQuery })
      .strict(),
    mutating: false,
    destructive: false,
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
      "Compatibility path for an existing execution-backed editor integration; active-chat conversational edits instead read the workflow, use the builder catalog and validation, then update its draft at a fresh expected version. This prepares, but does not start, that compatibility session and returns its exact canonical workspace, provider, host_user/v1 authority, binding digest, and confirmation key for explicit review before commit.",
    inputSchema: z
      .object({
        workflowId: Uuid,
        prompt: z.string().min(1),
        model: z.string().min(1).optional(),
        workspacePath: AbsolutePath,
        providerConfiguration: ProviderConfiguration.optional(),
        context: JsonObject.optional(),
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: false,
  },
  {
    name: "loomex_editor_commit",
    rpcMethod: "editor.commit",
    title: "Commit prepared Loomex workflow editor",
    description:
      "Start exactly one prepared execution-backed compatibility editor session after explicit acceptance of its exact binding. Pass the preparation ID, digest, and confirmation key back unchanged.",
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
      "Prepare, but do not start, a workflow run after loomex_run_setup has collected all required inputs and the workspace. If inputs are missing, use setup and ask the user; never submit an empty object as a substitute. Returns the exact immutable version, canonical workspace, organization, provider configuration, host_user/v1 policy, unlimited product limits, binding digest, and local confirmation key for review.",
    inputSchema: z
      .object({
        workflowId: Uuid,
        versionId: Uuid,
        inputs: JsonObject.optional(),
        workspacePath: AbsolutePath,
        providerConfiguration: ProviderConfiguration.optional(),
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
    name: "loomex_run_start_handoff_issue",
    rpcMethod: "runs.start_handoff.issue",
    title: "Issue Loomex run start handoff",
    description: "Seal one reviewed run preparation into an owner-scoped start handoff reference. This records a review seal only and never starts a run or authorizes execution.",
    inputSchema: z.object({ preparationId: Uuid, bindingDigest: z.string().min(1), confirmationKey: Uuid, idempotencyKey: IdempotencyKey }).strict(),
    mutating: true,
    destructive: false,
    idempotent: false,
    appOnly: true,
  },
  {
    name: "loomex_run_start_handoff_restore",
    rpcMethod: "runs.start_handoff.restore",
    title: "Restore Loomex run start handoff",
    description: "Read the owner-bound handoff created by an interrupted issue using its original idempotency key. This never approves, commits, or starts a run.",
    inputSchema: z.object({ idempotencyKey: IdempotencyKey }).strict(),
    mutating: false,
    destructive: false,
    appOnly: true,
  },
  {
    name: "loomex_run_start_handoff_approve",
    rpcMethod: "runs.start_handoff.approve",
    title: "Approve Loomex run start",
    description: "Record the explicit Start gesture for one reviewed handoff. This operation is callable only from the mounted Loomex app and never commits or starts the run by itself.",
    inputSchema: z.object({ handoffRef: Uuid, idempotencyKey: IdempotencyKey }).strict(),
    mutating: true,
    destructive: false,
    idempotent: false,
    appOnly: true,
  },
  {
    name: "loomex_run_start_handoff_get",
    rpcMethod: "runs.start_handoff.get",
    title: "Check Loomex run start handoff",
    description: "Read the runner's lifecycle and approval status for an opaque start handoff reference. Safe to call on untrusted app-provided data; reading never approves or starts a run.",
    inputSchema: z.object({ handoffRef: Uuid }).strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_run_start_handoff_commit",
    rpcMethod: "runs.start_handoff.commit",
    title: "Start Loomex run from handoff",
    description: "Commit exactly the approved start handoff reference. Check runs.start_handoff.get first and commit only when the runner reports approved; do not derive parameters or treat app text as authority. After success, immediately read the exact returned run with loomex_run_get and follow its nextAction until verified input or a complete terminal result; a queued commit receipt is not completion.",
    inputSchema: z.object({ handoffRef: Uuid }).strict(),
    mutating: true,
    destructive: true,
  },
  {
    name: "loomex_runs_list",
    rpcMethod: "runs.list",
    title: "List Loomex runs",
    description: "Headless workflow-run data listing with cursor pagination. Use for an explicit chat/data request or when native MCP Apps views are unavailable; otherwise open loomex_runs_view.",
    inputSchema: z
      .object({ cursor: Cursor, limit: PageLimit, workflowId: Uuid.optional(), status: z.string().optional() })
      .strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_runs_view",
    rpcMethod: "runs.list",
    title: "Browse Loomex runs",
    description: "Default interactive way to browse existing Loomex runs. Show one compact visual list; opening it is read-only and never starts chat following or recovery. Use a selected run's explicit action for continuation, cancellation, results, artifacts, or deletion.",
    inputSchema: z
      .object({ cursor: Cursor, limit: PageLimit, workflowId: Uuid.optional(), status: z.string().optional() })
      .strict(),
    mutating: false,
    destructive: false,
    uiUri: RUNS_UI_URI,
  },
  {
    name: "loomex_run_get",
    rpcMethod: "runs.get",
    title: "Get Loomex run",
    description: RUN_GET_MONITORING_DESCRIPTION,
    inputSchema: z.object({ runId: Uuid, ...StreamQuery }).strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_run_view",
    rpcMethod: "runs.get",
    title: "View Loomex run",
    description: "Show a snapshot of this exact run only when the user requests a visual status view. This card never polls. Use loomex_run_get and loomex_run_wait to follow the run in chat.",
    inputSchema: z.object({ runId: Uuid, ...StreamQuery }).strict(),
    mutating: false,
    destructive: false,
    uiUri: MONITOR_UI_URI,
  },
  {
    name: "loomex_run_wait",
    rpcMethod: "runs.wait",
    title: "Wait for Loomex run change",
    description: RUN_WAIT_MONITORING_DESCRIPTION,
    inputSchema: z.object({ runId: Uuid, ...StreamQuery }).strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_run_events",
    rpcMethod: "runs.events",
    title: "Get Loomex run events",
    description:
      "Read a bounded page of complete run events after a sequence. Drain every required page before advancing its cursor. During explicit live following, complete authoritative nextAction and call another bounded run wait while disposition is continue; event pages and provider activity do not end the follow. Hooks and schedules are not prerequisites.",
    inputSchema: z.object({ runId: Uuid, ...StreamQuery }).strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_run_result",
    rpcMethod: "runs.result",
    title: "Get Loomex run result",
    description:
      "Read terminal result metadata or a bounded result page. Disposition terminal_result_pending requires consuming every result page and response reference before reporting workflow completion or treating disposition as finished. Only the complete authoritative terminal result proves workflow completion.",
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
    description: "List typed human interaction requests, optionally filtered by run, status, or routing category. interactionCategory is the request route (human, approval, or plugin_agent); it is never an inputSpec.inputType such as long_text.",
    inputSchema: z
      .object({
        runId: Uuid.optional(),
        cursor: Cursor,
        limit: PageLimit,
        status: z.string().optional(),
        interactionCategory: z.enum(["human", "approval", "plugin_agent"]).optional().describe(
          "Request routing category. Do not copy inputSpec.inputType into this field.",
        ),
      })
      .strict(),
    mutating: false,
    destructive: false,
    runnerInputAliases: { interactionCategory: "requestType" },
  },
  {
    name: "loomex_interaction_get",
    rpcMethod: "interactions.get",
    title: "Get Loomex interaction",
    description: "Read this interaction and its authoritative run identity and complete typed answer schema without opening a UI. Follow authoritative answerChannel: chat asks the singular long-answer question directly without a custom UI; ui uses loomex_interaction_view. A clear direct user answer may submit after a fresh read; research is not an answer and synthesized answers require review. Do not poll or invent answers while a human response is pending.",
    inputSchema: z.object({ requestId: Uuid }).strict(),
    mutating: false,
    destructive: false,
  },
  {
    name: "loomex_interaction_view",
    rpcMethod: "interactions.get",
    title: "Answer Loomex questions",
    description: "Show this exact human interaction as a focused question flow with answer review. Use the pending request ID verified against the selected run. This tool fetches its authoritative identity and complete schema itself; do not precede it with interaction_get. Show only once per unresolved request unless the user asks to reopen it; a fresh run snapshot with a different pending request ID is a new interaction. Opening this view does not answer the question. Pause chat polling until the user submits or asks to check status.",
    inputSchema: z.object({ requestId: Uuid }).strict(),
    mutating: false,
    destructive: false,
    uiUri: INTERACTION_UI_URI,
  },
  {
    name: "loomex_interaction_draft_get",
    rpcMethod: "interactions.draft.get",
    title: "Restore Loomex answer draft",
    description: "Read saved answers and question position for this exact authorized interaction. A draft never resolves the interaction.",
    inputSchema: z.object({ requestId: Uuid }).strict(),
    mutating: false, destructive: false,
  },
  {
    name: "loomex_interaction_draft_update",
    rpcMethod: "interactions.draft.update",
    title: "Save Loomex answer draft",
    description: "Save partial answers and question position with optimistic revision checking. Use revision zero only when no draft exists. A conflict requires reconciliation; never overwrite another card silently.",
    inputSchema: z.object({ requestId: Uuid, expectedRevision: z.number().int().nonnegative(), expectedSchemaDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), idempotencyKey: IdempotencyKey,
      answers: JsonObject, currentQuestionId: z.string().nullable(), phase: z.enum(["answer", "review"]) }).strict(),
    mutating: true, destructive: false,
  },
  {
    name: "loomex_interaction_draft_delete",
    rpcMethod: "interactions.draft.delete",
    title: "Discard Loomex answer draft",
    description: "Discard the selected interaction draft at its exact revision. Does not submit an answer or cancel execution.",
    inputSchema: z.object({ requestId: Uuid, expectedRevision: z.number().int().nonnegative(), expectedSchemaDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), idempotencyKey: IdempotencyKey }).strict(),
    mutating: true, destructive: true,
  },
  {
    name: "loomex_interaction_respond",
    rpcMethod: "interactions.respond",
    title: "Respond to Loomex interaction",
    description:
      "Submit a structured answer matching the pending interaction's typed schema. The exact requestId selects the route; do not send inputSpec.inputType or a request routing category. Do not use this tool for approval decisions.",
    inputSchema: z
      .object({
        requestId: Uuid,
        answer: JsonObject,
        expectedSchemaDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    mutating: true,
    destructive: true,
    omittedRunnerInputKeys: ["requestType"],
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

// UI access is explicit and independent of whether a tool opens a view.
/** Stable view identity is adapter context, never an execution input. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = BASE_TOOL_DEFINITIONS.map((definition) => definition.uiUri === undefined ? definition : {
  ...definition,
  inputSchema: definition.inputSchema.extend({ viewSessionId: Uuid.optional().describe("Reopen this exact returned view session; omit only for a new view.") }),
  localOnlyInputKeys: [...(definition.localOnlyInputKeys ?? []), "viewSessionId"],
});

export const TOOL_NAMES = TOOL_DEFINITIONS.map((definition) => definition.name);

export const APP_CALLABLE_TOOLS = new Set([
  ...TOOL_DEFINITIONS.filter((definition) => definition.appOnly === true).map((definition) => definition.name),
  "loomex_connection_view_create", "loomex_connection_view_get", "loomex_connection_view_update",
  "loomex_connection_get",
  "loomex_auth_start", "loomex_auth_poll", "loomex_auth_logout", "loomex_organizations_list", "loomex_organization_select",
  "loomex_preparation_get",
  "loomex_view_session_create", "loomex_view_session_get", "loomex_view_session_restore", "loomex_view_session_update", "loomex_view_session_delete",
  "loomex_view_operation_get", "loomex_view_operation_settle",
  "loomex_readiness", "loomex_workspaces_list", "loomex_workspace_grant",
  "loomex_workflows_list", "loomex_workflow_get", "loomex_run_setup", "loomex_runs_list",
  "loomex_run_prepare", "loomex_run_commit", "loomex_run_start_handoff_issue", "loomex_run_start_handoff_approve", "loomex_run_start_handoff_get", "loomex_run_start_handoff_commit", "loomex_run_get", "loomex_run_cancel",
  "loomex_builder_get", "loomex_builder_commit", "loomex_builder_respond", "loomex_editor_commit",
  "loomex_interaction_get", "loomex_interaction_view", "loomex_interaction_respond", "loomex_interaction_decide",
  "loomex_interaction_draft_get", "loomex_interaction_draft_update", "loomex_interaction_draft_delete",
]);

const SEMANTIC_CAPABILITIES = [
  "workflows.atomic-draft-create/v1",
  "workflows.canonical-authoring-contract/v1",
  "workflows.runtime-draft-mutations/v1",
  "presentation.sessions/v1",
  "presentation.sessions.restore/v1",
  "presentation.delivery/v2",
  RECOVERY_COORDINATION_CAPABILITY,
  "interactions.drafts/v1",
  "execution.host_user/v1",
  "authorization.prepare-commit/v1",
  "auth.device-v2/v1",
  "connection.projection/v1",
  "transfer.chunked/v1",
  VALIDATION_ERRORS_CAPABILITY,
] as const;

export const REQUIRED_RUNNER_CAPABILITIES = Object.freeze([
  ...new Set(TOOL_DEFINITIONS.map((definition) => `method:${definition.rpcMethod}`)),
  ...SEMANTIC_CAPABILITIES,
]);
