import recoveryContract from "../contracts/error-recovery.json" with { type: "json" };
import { z } from "zod";

export const LOCAL_PROTOCOL = "loomex.local-control/v2" as const;
export const MAX_FRAME_BYTES = 1024 * 1024;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const RpcErrorCodeSchema = z.string().min(1).max(120);

export type RpcErrorCode = z.infer<typeof RpcErrorCodeSchema>;
export const VALIDATION_ISSUE_VERSION = "v1" as const;
export const VALIDATION_ERRORS_CAPABILITY = "error.validation-issues/v1" as const;
export const RECOVERY_COORDINATION_CAPABILITY = "recovery.coordination/v1" as const;

function validationIssueSchema(
  code: string,
  message: string,
  nextAction: string,
) {
  return z
    .object({
      code: z.literal(code),
      message: z.literal(message),
      nextAction: z.literal(nextAction),
      nodeIndex: z.number().int().min(1).max(1_000_000).optional(),
    })
    .strict();
}

export const ValidationIssueSchema = z.union([
  validationIssueSchema(
    "RUN_INPUT_SCHEMA_INVALID",
    "Workflow inputs do not match the required schema.",
    "correct_workflow_inputs",
  ),
  validationIssueSchema(
    "RUN_VALIDATION_EXECUTION_POLICY_INVALID",
    "The workflow execution policy does not support a required capability.",
    "update_workflow_definition",
  ),
  validationIssueSchema(
    "UNSUPPORTED_CAPABILITY",
    "The workflow execution policy does not support a required capability.",
    "update_workflow_definition",
  ),
  validationIssueSchema(
    "RUN_VALIDATION_EXECUTION_ROOT_REQUIRED",
    "This workflow requires a prepared local runner execution root.",
    "prepare_runner_execution",
  ),
  validationIssueSchema(
    "RUN_VALIDATION_RUNNER_UNAVAILABLE",
    "The required local runner is not connected.",
    "connect_runner",
  ),
  validationIssueSchema(
    "RUN_VALIDATION_PROVIDER_UNSUPPORTED",
    "The selected provider does not support a required workflow capability.",
    "choose_supported_provider",
  ),
  validationIssueSchema(
    "RUN_VALIDATION_PROVIDER_INVALID",
    "The workflow selects a provider that cannot run this work.",
    "choose_supported_provider",
  ),
  validationIssueSchema(
    "RUN_VALIDATION_POLICY_DENIED",
    "The execution policy does not allow a required workflow capability.",
    "allow_capability",
  ),
  validationIssueSchema(
    "RUN_VALIDATION_POLICY_REQUIRED",
    "A required workflow capability policy has not been configured.",
    "configure_capability_policy",
  ),
  validationIssueSchema(
    "RUN_VALIDATION_FAILED",
    "The workflow has a validation issue that must be reviewed.",
    "review_workflow_validation",
  ),
]);

export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const RpcErrorDataSchema = z
  .object({
    validationIssueVersion: z.literal(VALIDATION_ISSUE_VERSION),
    validationIssues: z.array(ValidationIssueSchema).min(1).max(32),
  })
  .strict();

export const AuthoringIssueSchema = z
  .object({
    code: z.string().min(1).max(120),
    path: z.string().min(1).max(512),
    message: z.string().min(1).max(4096),
  })
  .strict();
export type AuthoringIssue = z.infer<typeof AuthoringIssueSchema>;

export const AuthoringErrorDataSchema = z.union([
  z.object({ message: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      authoringIssueVersion: z.literal("v1"),
      authoringIssues: z.array(AuthoringIssueSchema).min(1).max(32),
    })
    .strict(),
]);

export const RpcRequestSchema = z
  .object({
    protocol: z.literal(LOCAL_PROTOCOL),
    id: z.uuid(),
    method: z.string().min(1).max(128),
    params: z.record(z.string(), JsonValueSchema),
  })
  .strict();

export const RecoverySchema = z.enum(["correct_input", "retry_exact_operation", "reconcile_outcome", "refresh_authority", "unavailable"]);
export const OutcomeSchema = z.enum(["not_dispatched", "rejected", "unknown", "completed"]);
export function errorRecovery(code: string): {recovery: z.infer<typeof RecoverySchema>; outcome: z.infer<typeof OutcomeSchema>} {
 const rules: Record<string, unknown> = recoveryContract.codes;
 return z.object({recovery: RecoverySchema, outcome: OutcomeSchema}).parse(rules[code] ?? recoveryContract.default);
}

export const RpcErrorSchema = z
  .object({
    code: RpcErrorCodeSchema,
    message: z.string().min(1).max(1024),
    correlationId: z.string().min(1).max(128),
    retryable: z.boolean(),
    recovery: RecoverySchema.optional(),
    outcome: OutcomeSchema.optional(),
    data: z.union([RpcErrorDataSchema, AuthoringErrorDataSchema]).optional(),
  })
  .strict()
  .refine(
    (error) =>
      error.data === undefined ||
      error.code === "RUN_VALIDATION_FAILED" ||
      error.code.startsWith("WORKFLOW_"),
  );

export const RpcResponseSchema = z.union([
  z
    .object({
      protocol: z.literal(LOCAL_PROTOCOL),
      id: z.uuid(),
      result: z.record(z.string(), JsonValueSchema),
    })
    .strict(),
  z
    .object({
      protocol: z.literal(LOCAL_PROTOCOL),
      id: z.uuid(),
      error: RpcErrorSchema,
    })
    .strict(),
]);

const NegotiationStringSchema = z.string().min(1).max(160);
const UniqueNegotiationStringsSchema = z
  .array(NegotiationStringSchema)
  .refine((values) => new Set(values).size === values.length);

export const NegotiationParamsSchema = z
  .object({
    supportedProtocols: UniqueNegotiationStringsSchema.min(1),
    requiredCapabilities: UniqueNegotiationStringsSchema,
  })
  .strict();

export const NegotiationResultSchema = z
  .object({
    selectedProtocol: z.literal(LOCAL_PROTOCOL),
    capabilities: UniqueNegotiationStringsSchema,
    maxFrameBytes: z.literal(MAX_FRAME_BYTES),
    serverVersion: z.string(),
  })
  .strict();

export const ToolErrorSchema = z
  .object({
    code: RpcErrorCodeSchema,
    message: z.string(),
    correlationId: z.string().optional(),
    retryable: z.boolean(),
    recovery: RecoverySchema.optional(),
    outcome: OutcomeSchema.optional(),
    validationIssueVersion: z.literal(VALIDATION_ISSUE_VERSION).optional(),
    validationIssues: z.array(ValidationIssueSchema).min(1).max(32).optional(),
    authoringIssueVersion: z.literal("v1").optional(),
    authoringIssues: z.array(AuthoringIssueSchema).min(1).max(32).optional(),
    authoringMessage: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .refine(
    (error) =>
      (error.validationIssueVersion === undefined) === (error.validationIssues === undefined) &&
      (error.authoringIssueVersion === undefined) === (error.authoringIssues === undefined) &&
      (error.validationIssues === undefined || error.code === "RUN_VALIDATION_FAILED") &&
      (error.authoringIssues === undefined || error.code.startsWith("WORKFLOW_")),
  );

export const ToolOutputSchema = z
  .object({
    ok: z.boolean(),
    protocol: z.literal(LOCAL_PROTOCOL),
    method: z.string(),
    requestId: z.uuid(),
    data: z.record(z.string(), JsonValueSchema).optional(),
    error: ToolErrorSchema.optional(),
    idempotencyKey: z.uuid().optional(),
  })
  .strict();

export type ToolOutput = z.infer<typeof ToolOutputSchema>;

const SAFE_MESSAGES: Readonly<Record<string, string>> = {
  VIEW_SESSION_NOT_FOUND: "This saved view is no longer available. Open a new view to continue.",
  REVISION_CONFLICT: "This view changed in another window. Reload its saved state before editing.",
  INTERACTION_DRAFT_CONFLICT: "This answer draft changed in another view. Reload it before saving.",
  HUMAN_REQUEST_SCHEMA_CHANGED: "The question changed. Read it again before answering.",
  HUMAN_REQUEST_SCHEMA_CONFLICT: "The question changed. Review the saved answer before continuing.",
  HUMAN_REQUEST_ALREADY_RESOLVED: "This question has already been answered. Refresh to continue.",
  OPERATION_PENDING: "A previous operation still needs reconciliation. Check its outcome before continuing.",
  OPERATION_NOT_FOUND: "The saved operation could not be found. Refresh the authoritative state.",
  OPERATION_SETTLED: "This operation has already finished. Refresh to see its outcome.",
  RECOVERY_NOT_FOUND: "No recovery coordination record exists for this task and run.",
  RECOVERY_BINDING_CONFLICT: "This recovery record belongs to a different task or run.",
  RECOVERY_OPERATION_PENDING: "A recovery operation still needs reconciliation before another one can begin.",
  RECOVERY_OPERATION_NOT_FOUND: "The recovery operation could not be found. Refresh the recovery record.",
  RECOVERY_OPERATION_SETTLED: "This recovery operation has already finished. Refresh the recovery record.",
  RECOVERY_AMBIGUOUS: "Recovery has an unresolved host operation. Reconcile it before trying another schedule change.",
  RECOVERY_STOPPED: "Recovery monitoring has been stopped for this task and run.",
  RECOVERY_REGISTRATION_EXISTS: "Recovery registration already exists for this task and run.",
  RECOVERY_REGISTRATION_REQUIRED: "Recovery needs a known host automation before this operation can proceed.",
  AUTOMATION_ID_REQUIRED: "A successful recovery registration must include the returned host automation ID.",
  OPERATION_NOT_PENDING: "This recovery operation is no longer awaiting settlement. Refresh the recovery record.",
  INVALID_REQUEST: "The local runner rejected the request shape.",
  INVALID_RESPONSE: "The local runner returned an invalid response.",
  PROTOCOL_MISMATCH: "The plugin and local runner protocol versions are incompatible.",
  COMPATIBILITY_ERROR: "The installed local runner does not provide the capabilities required by this plugin.",
  FRAME_TOO_LARGE: "The local control message exceeded the transport page size.",
  METHOD_NOT_FOUND: "The installed local runner does not support this operation.",
  RUNNER_UNAVAILABLE: "The owner-checked local Loomex runner is unavailable.",
  RUNNER_NOT_READY: "The local Loomex runner is not ready.",
  ACTIVE_WORK_REQUIRES_DRAIN: "Loomex is still working. Wait for current work to finish, then refresh Connection and sign out.",
  NETWORK_UNAVAILABLE: "Loomex cannot reach its backend. Your connection information has been retained; retry when the service is available.",
  AUTH_RECOVERY_PENDING: "A credential operation needs to be reconciled before Loomex can connect.",
  AUTH_RECOVERY_NOT_REQUIRED: "There is no pending credential operation to recover.",
  AUTH_RECOVERY_EXHAUSTED: "The saved credential operation cannot be reconciled. Reconnect Loomex to continue.",
  AUTH_REQUIRED: "Loomex authentication is required.",
  AUTH_PENDING: "Loomex authentication is still pending.",
  AUTH_EXPIRED: "The Loomex authentication flow expired.",
  AUTH_ALREADY_COMPLETED: "This sign-in has already completed. Refresh Connection.",
  AUTH_PENDING_COMPLETION: "Loomex is completing this sign-in. Wait for its result.",
  BROWSER_LINK_UNAVAILABLE: "The sign-in link is unavailable. Refresh Connection.",
  BROWSER_LAUNCH_FAILED: "The system browser could not be opened. Use the sign-in link in this card.",
  BROWSER_LAUNCH_TIMEOUT: "The system browser did not respond. Check it before trying again, or use the sign-in link.",
  BROWSER_LAUNCH_UNAVAILABLE: "This machine cannot open a browser automatically. Use the sign-in link in this card.",
  INVALID_AUTHORIZATION_URI: "The saved sign-in link failed verification. Start sign-in again.",
  ORGANIZATION_REQUIRED: "Select a Loomex organization before continuing.",
  WORKSPACE_DENIED: "The workspace has not been granted for this organization and installation.",
  NOT_FOUND: "The requested Loomex object was not found in the selected organization.",
  CONFLICT: "The requested change conflicts with current Loomex state.",
  IDEMPOTENCY_CONFLICT: "This idempotency key is already bound to different request data.",
  EXECUTION_BINDING_CONFLICT: "The workflow or its execution settings changed after preparation. Review a new preparation before starting.",
  PREPARATION_NOT_FOUND: "This run preparation is no longer available. Review a new preparation before starting.",
  MODEL_CATALOG_UNAVAILABLE: "The AI model catalog is temporarily unavailable. Wait a moment, then try again.",
  PRECONDITION_FAILED: "Loomex state changed and the operation must be prepared again.",
  VALIDATION_FAILED: "The Loomex request did not pass validation.",
  RUN_VALIDATION_FAILED: "The workflow cannot start until its validation issues are fixed.",
  UNSUPPORTED_FEATURE: "The requested feature is not supported by this Loomex version.",
  PROVIDER_UNAVAILABLE: "A required local provider CLI is unavailable or incompatible.",
  BACKEND_UNAVAILABLE: "The Loomex service is temporarily unavailable.",
  NETWORK_AMBIGUOUS: "The connection closed after the mutation was sent. Its outcome is unknown; retry only with the same idempotency key.",
  CANCELLED: "The operation was cancelled.",
  INTERNAL: "The local Loomex runner could not complete the operation.",
};

export function safeErrorMessage(code: RpcErrorCode): string {
  return SAFE_MESSAGES[code] ?? "The local Loomex runner could not complete the operation.";
}
