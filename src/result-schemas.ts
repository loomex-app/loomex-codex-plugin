import { z } from "zod";

import { JsonValueSchema, type JsonValue } from "./protocol.js";

const JsonObject = z.record(z.string(), JsonValueSchema);
const Details = JsonObject.optional();
const ObjectOrNull = JsonObject.nullable();
const Objects = z.array(JsonObject);
const NonNegativeInteger = z.number().int().nonnegative();
const NullableString = z.string().nullable();
const NullableOffset = NonNegativeInteger.nullable();

const SpoolResult = z
  .object({
    responseRef: z.string(),
    sizeBytes: NonNegativeInteger,
    encoding: z.literal("json"),
    nextOffset: NonNegativeInteger,
    checksumSha256: z.string(),
    details: Details,
  })
  .strict();

const BuilderMutationResult = z
  .object({
    builderSession: JsonObject.optional(),
    execution: ObjectOrNull.optional(),
    workflow: ObjectOrNull.optional(),
    humanRequest: ObjectOrNull.optional(),
    editResult: JsonObject.optional(),
    status: z.string().optional(),
    details: Details,
  })
  .strict();

const BuilderCommitResult = z
  .object({
    builderSessionId: z.string(),
    editSessionId: z.string().optional(),
    executionId: z.string(),
    sessionId: z.string(),
    preparationId: z.string(),
    executionPolicy: z.string(),
    details: Details,
  })
  .strict();

const EditorCommitResult = BuilderCommitResult.extend({ editSessionId: z.string() }).strict();

const RunProjection = {
  execution: JsonObject,
  humanRequest: ObjectOrNull.optional(),
  waitState: NullableString.optional(),
  automation: ObjectOrNull.optional(),
  runner: JsonObject.optional(),
  events: Objects,
  latestSequence: NonNegativeInteger,
  hasMoreEvents: z.boolean(),
  timedOut: z.boolean(),
  progress: JsonObject.optional(),
  aiTrace: z.union([JsonObject, z.array(JsonValueSchema), z.null()]).optional(),
  builderSession: JsonObject.optional(),
  editResult: JsonObject.optional(),
  executionPolicy: z.string().optional(),
  preparationId: z.string().optional(),
  details: Details,
} as const;

const InteractionResolutionResult = z
  .object({
    requestId: z.string(),
    requestStatus: z.string(),
    executionId: NullableString,
    executionStatus: NullableString,
    error: z.union([JsonObject, z.string(), z.null()]),
    details: Details,
  })
  .strict();

const ViewSession = z.object({
  viewSessionId: z.uuid(), kind: z.enum(["browser", "authoring", "prepare", "monitor", "interaction"]),
  entityType: z.enum(["catalog", "workflow", "request", "execution", "builderSession", "preparation"]), entityId: z.uuid(),
  revision: NonNegativeInteger, state: JsonObject, status: z.string(), createdAt: NonNegativeInteger, updatedAt: NonNegativeInteger,
  details: Details, expiresAt: NonNegativeInteger.nullable(), operation: z.object({operationId:z.uuid(),status:z.string()}).strict().nullable(),
}).strict();

const primarySchemas = {
  "preparations.get": z.union([
    z.object({status:z.literal("valid"),operation:z.enum(["runs.prepare","builder.prepare","editor.prepare"]),preparation:z.object({preparationId:z.string(),bindingDigest:z.string(),binding:JsonObject,limits:JsonObject,expiresAt:z.null(),confirmationKey:z.string(),details:Details}).strict(),details:Details}).strict(),
    z.object({status:z.literal("stale"),operation:z.enum(["runs.prepare","builder.prepare","editor.prepare"]),preparationId:z.string(),reason:z.enum(["workspace_changed","provider_changed","expired","commit_started","record_invalid"]),nextAction:z.enum(["prepare_again","reconcile_operation"]),details:Details}).strict(),
  ]),
  "presentation.sessions.create": ViewSession,
  "presentation.sessions.get": ViewSession,
  "presentation.sessions.update": ViewSession,
  "presentation.sessions.delete": z.object({viewSessionId:z.uuid(),deleted:z.boolean(),details:Details}).strict(),
  "presentation.operations.get": z.object({operationId:z.uuid(),viewSessionId:z.uuid(),method:z.string(),params:JsonObject,idempotencyKey:z.uuid(),reconciliation:z.union([z.object({method:z.string(),params:JsonObject}).strict(),z.object({}).strict()]),status:z.string(),createdAt:NonNegativeInteger,updatedAt:NonNegativeInteger,resultReference:JsonObject.nullable(),details:Details}).strict(),
  "presentation.operations.settle": z.object({operationId:z.uuid(),viewSessionId:z.uuid(),status:z.enum(["completed","ambiguous"]),updatedAt:NonNegativeInteger,resultReference:JsonObject.nullable(),details:Details}).strict(),
  "status.get": z
    .object({
      version: z.string(),
      protocol: z.string(),
      activeJobs: NonNegativeInteger,
      draining: z.boolean(),
      updateDeferred: z.boolean(),
      details: Details,
    })
    .strict(),
  "auth.status": z
    .object({
      authenticated: z.boolean(),
      code: z.string(),
      installationId: z.string().optional(),
      activeOrganization: NullableString.optional(),
      organizations: z.array(z.string()).optional(),
      loginPending: z.boolean().optional(),
      details: Details,
    })
    .strict(),
  "auth.login": z
    .object({
      status: z.string(),
      pending: z.boolean().optional(),
      authenticated: z.boolean().optional(),
      userCode: NullableString.optional(),
      verificationUri: NullableString.optional(),
      expiresAt: NonNegativeInteger.optional(),
      intervalSeconds: NonNegativeInteger.optional(),
      details: Details,
    })
    .strict(),
  "auth.poll": z
    .object({
      status: z.string(),
      pending: z.boolean().optional(),
      authenticated: z.boolean().optional(),
      retryAfterSeconds: NonNegativeInteger.optional(),
      details: Details,
    })
    .strict(),
  "auth.logout": z
    .object({ revoked: z.boolean(), alreadyLoggedOut: z.boolean().optional(), details: Details })
    .strict(),
  "organizations.list": z.object({ organizations: Objects, details: Details }).strict(),
  "organizations.select": z
    .object({
      organizationId: z.string(),
      selected: z.boolean(),
      enrolled: z.boolean(),
      details: Details,
    })
    .strict(),
  "workspaces.list": z.object({ workspaces: Objects, details: Details }).strict(),
  "workspaces.grant": z
    .object({ workspace: JsonObject, executionPolicy: z.string(), details: Details })
    .strict(),
  "workspaces.revoke": z.object({ revoked: z.boolean(), details: Details }).strict(),
  "workflows.list": z
    .object({ workflows: Objects, nextCursor: NullableString, details: Details })
    .strict(),
  "workflows.get": z
    .object({
      workflow: JsonObject,
      activeVersion: JsonObject.optional(),
      selectedVersion: JsonObject,
      versions: Objects.optional(),
      inputSchema: JsonObject.optional(),
      firstHumanInput: ObjectOrNull.optional(),
      nodes: Objects.optional(),
      capabilities: JsonObject.optional(),
      details: Details,
    })
    .strict(),
  "workflows.create": z
    .object({
      workflowId: z.string(),
      name: z.string(),
      slug: z.string(),
      activeVersionId: NullableString.optional(),
      details: Details,
    })
    .strict(),
  "workflows.update": z
    .object({ workflow: JsonObject, draft: ObjectOrNull.optional(), details: Details })
    .strict(),
  "workflows.validate": z
    .object({
      valid: z.boolean(),
      errors: z.array(JsonValueSchema),
      workflow: JsonObject,
      details: Details,
    })
    .strict(),
  "workflows.publish": z
    .object({ workflow: JsonObject, version: JsonObject, details: Details })
    .strict(),
  "workflows.activate": z
    .object({ workflow: JsonObject, version: JsonObject, details: Details })
    .strict(),
  "builder.catalog": z
    .object({
      nodeTypes: Objects,
      executionPolicies: z.array(z.string()),
      limits: JsonObject,
      details: Details,
    })
    .strict(),
  "builder.validate": z
    .object({
      valid: z.boolean(),
      errors: z.array(JsonValueSchema),
      workflow: JsonObject,
      details: Details,
    })
    .strict(),
  "builder.prepare": z
    .object({
      preparationId: z.string(),
      bindingDigest: z.string(),
      binding: JsonObject,
      limits: JsonObject,
      expiresAt: z.null(),
      confirmationKey: z.string(),
      details: Details,
    })
    .strict(),
  "builder.commit": BuilderCommitResult,
  "builder.get": z
    .object({
      builderSession: JsonObject,
      progress: JsonObject.optional(),
      execution: ObjectOrNull.optional(),
      events: Objects,
      latestSequence: NonNegativeInteger,
      hasMoreEvents: z.boolean(),
      timedOut: z.boolean(),
      details: Details,
    })
    .strict(),
  "builder.respond": BuilderMutationResult,
  "builder.finalize": BuilderMutationResult,
  "editor.prepare": z
    .object({
      preparationId: z.string(),
      bindingDigest: z.string(),
      binding: JsonObject,
      limits: JsonObject,
      expiresAt: z.null(),
      confirmationKey: z.string(),
      details: Details,
    })
    .strict(),
  "editor.commit": EditorCommitResult,
  "editor.respond": BuilderMutationResult,
  "editor.finalize": BuilderMutationResult,
  "runs.prepare": z
    .object({
      preparationId: z.string(),
      bindingDigest: z.string(),
      binding: JsonObject,
      limits: JsonObject,
      expiresAt: z.null(),
      confirmationKey: z.string(),
      details: Details,
    })
    .strict(),
  "runs.commit": z
    .object({
      ...RunProjection,
      events: Objects.optional(),
      latestSequence: NonNegativeInteger.optional(),
      hasMoreEvents: z.boolean().optional(),
      timedOut: z.boolean().optional(),
      executionPolicy: z.string(),
      preparationId: z.string(),
    })
    .strict(),
  "runs.list": z
    .object({ executions: Objects, nextCursor: NullableString, details: Details })
    .strict(),
  "runs.get": z.object(RunProjection).strict(),
  "runs.wait": z.object(RunProjection).strict(),
  "runs.events": z.object(RunProjection).strict(),
  "runs.result": z.object(RunProjection).strict(),
  "runs.cancel": z.object({ execution: JsonObject, jobs: Objects, details: Details }).strict(),
  "runs.delete": z
    .object({
      executionId: z.string(),
      deleted: z.boolean().optional(),
      deletedAt: NullableString,
      artifactsDeleted: NonNegativeInteger.optional(),
      retainedForAudit: z.boolean(),
      details: Details,
    })
    .strict(),
  "interactions.list": z
    .object({
      requests: Objects.optional(),
      humanRequests: Objects,
      nextCursor: NullableString,
      executionId: z.string().optional(),
      details: Details,
    })
    .strict(),
  "interactions.draft.get": z.object({ draft: JsonObject.nullable(), details: Details }).strict(),
  "interactions.draft.update": z.object({ draft: JsonObject, details: Details }).strict(),
  "interactions.draft.delete": z.object({ requestId: z.string(), deleted: z.boolean(), revision: NonNegativeInteger, details: Details }).strict(),
  "interactions.get": z
    .object({
      request: JsonObject.optional(),
      humanRequest: JsonObject,
      execution: ObjectOrNull.optional(),
      details: Details,
    })
    .strict(),
  "interactions.respond": InteractionResolutionResult,
  "interactions.decide": InteractionResolutionResult,
  "artifacts.list": z
    .object({ artifacts: Objects, nextCursor: NullableString, details: Details })
    .strict(),
  "artifacts.read": z
    .object({
      artifactId: z.string(),
      offset: NonNegativeInteger,
      dataBase64: z.string(),
      nextOffset: NullableOffset,
      sizeBytes: NonNegativeInteger,
      checksumSha256: z.string(),
      details: Details,
    })
    .strict(),
  "artifacts.download": z
    .object({
      artifactId: z.string(),
      path: z.string(),
      sizeBytes: NonNegativeInteger,
      checksumSha256: z.string(),
      details: Details,
    })
    .strict(),
  "responses.read": z
    .object({
      responseRef: z.string(),
      offset: NonNegativeInteger,
      dataBase64: z.string(),
      nextOffset: NullableOffset,
      sizeBytes: NonNegativeInteger,
      checksumSha256: z.string(),
      details: Details,
    })
    .strict(),
  "responses.delete": z.object({ deleted: z.boolean(), details: Details }).strict(),
  "daemon.drain": z
    .object({
      draining: z.boolean(),
      activeJobs: NonNegativeInteger,
      updateDeferred: z.boolean(),
      details: Details,
    })
    .strict(),
} as const;

export type LocalControlMethod = keyof typeof primarySchemas;

export function resultSchemaFor(method: string): z.ZodType | undefined {
  if (!(method in primarySchemas)) return undefined;
  return z.union([primarySchemas[method as LocalControlMethod], SpoolResult]);
}

export function parseMethodResult(
  method: string,
  value: Record<string, JsonValue>,
): Record<string, JsonValue> | undefined {
  const schema = resultSchemaFor(method);
  if (schema === undefined) return undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? (parsed.data as Record<string, JsonValue>) : undefined;
}

export const LOCAL_CONTROL_METHODS = Object.freeze(
  Object.keys(primarySchemas) as LocalControlMethod[],
);
