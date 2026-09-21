import type { JsonObject, JsonValue, ViewSessionProjection } from "./contracts.js";
import type { MutationOperation } from "./mutation-controller.js";

export type MutableJson = { [key: string]: JsonValue | undefined };

export interface JsonSchema extends MutableJson {
  type?: string | readonly string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  enum?: readonly (string | number | boolean | null)[];
  anyOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  allOf?: readonly JsonSchema[];
  $ref?: string;
  const?: JsonValue;
  pattern?: string;
  format?: string;
  contentEncoding?: string;
  contentMediaType?: string;
  multipleOf?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export interface WorkflowNode extends MutableJson {
  id?: string;
  type?: string;
  name?: string;
  inputSchema?: JsonSchema;
  config?: WorkflowNodeConfig;
  key?: string;
  position?: { x?: number; y?: number } & MutableJson;
}

export interface WorkflowNodeConfig extends MutableJson {
  modelResolution?: ModelResolution;
  provider?: string;
  providerFamily?: string;
  model?: string;
  modelKey?: string;
  reasoningEffort?: string;
  reasoning_effort?: string;
  effort?: string;
}

export interface ModelResolution extends MutableJson {
  provider?: string;
  runtimeModel?: string;
  model?: string;
}

export interface WorkflowDefinition extends MutableJson {
  nodes?: readonly WorkflowNode[];
  settings?: WorkflowSettings;
  executionPolicy?: string;
  transitions?: readonly JsonObject[];
}

export interface WorkflowSettings extends MutableJson {
  inputSchema?: JsonSchema;
  workspaceInputField?: string;
}

export interface WorkflowVersion extends MutableJson {
  status?: string;
  isActive?: boolean;
  id?: string;
  workflowId?: string;
  version?: number;
  versionNumber?: number;
  definition?: WorkflowDefinition;
}

export interface WorkflowSummary extends MutableJson {
  id?: string;
  organizationId?: string;
  name?: string;
  description?: string;
  status?: string;
  definitionStatus?: string;
  activeVersion?: number;
  latestVersion?: number;
  nodeCount?: number;
  metadata?: { description?: string } & MutableJson;
}

export interface WorkflowData extends MutableJson {
  workflow?: WorkflowSummary;
  workflows?: readonly WorkflowSummary[];
  selectedVersion?: WorkflowVersion;
  activeVersion?: WorkflowVersion;
  version?: WorkflowVersion;
  inputSchema?: JsonSchema;
  nodes?: readonly WorkflowNode[];
  nextCursor?: string | null;
  responseRef?: string;
  encoding?: string;
  sizeBytes?: number;
  checksumSha256?: string;
}

export interface InputQuestion extends MutableJson {
  id?: string;
  questionId?: string;
  question?: string;
  title?: string;
  description?: string;
  inputType?: string;
  options?: readonly QuestionOption[];
  allowOther?: boolean;
  otherLabel?: string;
  minimum?: number;
  maximum?: number;
  required?: boolean;
  acceptanceLabels?: { approve?: string; reject?: string } & MutableJson;
}

export interface QuestionOption extends MutableJson {
  value?: JsonValue;
  label?: string;
  description?: string;
}

export interface InputSpec extends InputQuestion {
  answerChannel?: string;
  collectionMode?: string;
  questions?: readonly InputQuestion[];
}

export interface RunPresentation extends MutableJson {
  version?: number;
  kind?: "review" | "clarification" | "progress";
  summary?: string;
  question?: string;
  changedFiles?: readonly string[];
  artifacts?: readonly string[];
  verification?: readonly string[];
  limitations?: readonly string[];
  stageLabel?: string;
  priorRequirements?: readonly string[];
  decisions?: readonly string[];
  openQuestions?: readonly string[];
}

export interface ExecutionProjection extends MutableJson {
  id?: string;
  runId?: string;
  workflowName?: string;
  name?: string;
  status?: string;
  stageLabel?: string;
  currentNodeName?: string;
  startedAt?: string | number;
  completedAt?: string | number;
  lastEvent?: string;
  requiredAction?: string;
  latestSequence?: number;
  organizationId?: string;
  result?: RunPresentation;
}

export interface HumanRequest extends MutableJson {
  id?: string;
  requestId?: string;
  type?: string;
  title?: string;
  description?: string;
  prompt?: string;
  status?: string;
  answerChannel?: string;
  schemaDigest?: string;
  inputSpec?: InputSpec;
  outputSchema?: JsonSchema;
  responseSchema?: JsonSchema;
  execution?: ExecutionProjection;
  answer?: JsonValue;
  answeredAt?: string;
  preparationId?: string;
  organizationId?: string;
  presentation?: RunPresentation;
}

export interface PreparationBinding extends MutableJson {
  workflowId?: string;
  versionId?: string;
  organizationId?: string;
  installationId?: string;
  workspacePath?: string;
  executionPolicy?: string;
  inputs?: JsonObject;
  providerConfiguration?: { requested?: JsonObject } & MutableJson;
  authoring?: JsonObject;
}

export interface PreparedRun extends MutableJson {
  preparationId?: string;
  confirmationKey?: string;
  bindingDigest?: string;
  executionPolicy?: string;
  binding?: PreparationBinding;
}

export interface BuilderSession extends MutableJson {
  id?: string;
  sessionId?: string;
  status?: string;
}

export interface UiData extends WorkflowData {
  runs?: readonly ExecutionProjection[];
  /** Canonical `runs.list` entries, normalized to `runs` at the UI boundary. */
  executions?: readonly ExecutionProjection[];
  execution?: ExecutionProjection;
  executionId?: string;
  humanRequest?: HumanRequest | null;
  preparation?: PreparedRun;
  preparationId?: string;
  confirmationKey?: string;
  bindingDigest?: string;
  binding?: PreparationBinding;
  executionPolicy?: string;
  builderSession?: BuilderSession;
  requestId?: string;
  schemaVersion?: string;
  state?: string;
  status?: string;
  latestSequence?: number;
  actions?: readonly string[];
  activeWork?: number;
  details?: JsonObject;
  draft?: InteractionDraft;
  nextViewSessionId?: string;
}

export interface RpcErrorProjection extends MutableJson {
  code?: string;
  message?: string;
  correlationId?: string;
  retryable?: boolean;
}

export interface RpcResult {
  readonly isError?: boolean;
  readonly structuredContent?: { ok?: boolean; data?: UiData; error?: RpcErrorProjection } & MutableJson;
  readonly _meta?: JsonObject;
  readonly error?: unknown;
}

export interface PreparationPresentation extends MutableJson {
  schemaVersion?: string;
  preparationId?: string;
  bindingDigest?: string;
  workflowId?: string;
  versionId?: string;
  organizationId?: string;
  workflowName?: string;
  organizationName?: string;
  workflowVersion?: number;
  providers?: readonly { name: string; model: string | null }[] | null;
}

export interface TaskWorkspace extends MutableJson {
  taskContext?: { cwd?: string } & MutableJson;
  workspacePath?: string;
}

export interface ViewFault {
  readonly status: "unavailable" | "reentry";
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlationId?: string;
}

export interface ViewOperationReference {
  operationId?: string;
  status?: string;
}

export interface RuntimeViewSessionProjection extends ViewSessionProjection<JsonObject> {
  readonly kind?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly operation?: ViewOperationReference;
}

export interface SessionUpdateAttempt extends MutableJson {
  viewSessionId: string;
  expectedRevision: number;
  state: JsonObject;
  status?: string;
  idempotencyKey: string;
}

export interface InteractionDraft extends MutableJson {
  requestId?: string;
  revision?: number;
  answers?: JsonObject;
  currentQuestionId?: string | null;
  phase?: "answer" | "review";
  schemaDigest?: string;
}

export interface DraftIdentity {
  readonly viewSessionId: string;
  readonly requestId: string;
  readonly schemaDigest: string;
}

export interface DraftAttempt {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly expectedSchemaDigest: string;
  readonly answers: JsonObject;
  readonly currentQuestionId: string | null;
  readonly phase: "answer" | "review";
  readonly idempotencyKey: string;
  readonly scope: DraftIdentity;
  readonly version: number;
}

export interface ReopenedInteraction {
  readonly requestId: string;
  readonly viewSessionId: string;
}

export interface ChatHandoff extends MutableJson {
  state?: string;
  error?: string;
}

export interface HostCapabilities {
  readonly openLink?: { readonly url?: JsonObject };
  readonly [name: string]: JsonValue | undefined;
}

export interface SetupAnalysisEntry {
  readonly key: string;
  readonly field: JsonSchema;
  readonly type: string;
  readonly values?: readonly (string | number)[];
  readonly required: boolean;
  readonly workspace: boolean;
}

export type SetupAnalysis =
  | { readonly supported: false; readonly reason: string }
  | { readonly supported: true; readonly schema: JsonSchema; readonly entries: readonly SetupAnalysisEntry[]; readonly workspaceInputField?: string };

export interface SelectedWorkflow {
  readonly workflowId: string;
  readonly organizationId: string;
  readonly versionId: string;
  readonly version: WorkflowVersion;
  readonly definition: WorkflowDefinition;
}

export interface RunSelection {
  workflowId?: string;
  organizationId?: string;
  versionId?: string;
  version?: WorkflowVersion;
  definition?: WorkflowDefinition;
}

export interface RunFlow {
  stage: "setup" | "review" | "monitor";
  setup?: UiData;
  selected?: RunSelection;
  analysis?: SetupAnalysis;
  returnToBrowser?: boolean;
  inputDraft?: Record<string, string | number | boolean>;
  workspaceDraft?: string;
  workspaceEditing?: boolean;
  workspaceSource?: string;
  setupWorkspacePath?: string;
  setupRequestIdentity?: string;
  canonicalWorkspace?: string;
  organizationId?: string;
  installationId?: string;
  operations: Map<string, MutationOperationState>;
  busy: boolean;
  autoPreparation?: "idle" | "scheduled" | "started" | "done" | "failed";
  error?: unknown;
  errorMessage?: string;
  prepared?: PreparedRun;
  /** A non-secret runner reference. It is identity data, never authorization. */
  startHandoffRef?: string;
  /**
   * Display-only lifecycle mirrored from the runner.  The runner remains the
   * authority for approval and commit; this value only controls safe UI state.
   */
  startHandoffState?: StartHandoffLifecycle;
  /** A redacted, durable reconciliation projection for a saved review card. */
  startHandoffOperation?: JsonObject;
  /** Volatile browser-only approval material is available for this card. Never persist it. */
  startHandoffReady?: boolean;
  result?: UiData;
  baselineRequired?: boolean;
  cancellationRequested?: boolean;
  preparationStale?: boolean;
  /** The immutable presentation entity that owns a restored monitor summary. */
  summaryOwner?: "preparation";
  editWorkflowVersion?: number;
  pendingSetupInputs?: JsonObject;
  setupViewSessionId?: string;
  returnViewSessionId?: string;
  currentRequestId?: string;
  acceptedRequest?: HumanRequest;
  resolvedRequestIds?: Set<string>;
  humanDrafts?: Map<string, JsonObject>;
  humanMode?: string;
  readEpoch?: number;
}

export type StartHandoffLifecycle =
  | "prepared"
  | "approving"
  | "approved"
  | "committing"
  | "ambiguous"
  | "committed"
  | "expired"
  | "rejected"
  | "unknown";

export type SetupRunFlow = RunFlow & {
  stage: "setup";
  setup: UiData;
  analysis: SetupAnalysis;
  inputDraft: Record<string, string | number | boolean>;
  workspaceDraft: string;
  workspaceEditing: boolean;
  workspaceSource: string;
  canonicalWorkspace: string;
};

export type ReviewRunFlow = RunFlow & { stage: "review"; prepared: PreparedRun };
export type MonitorRunFlow = RunFlow & {
  stage: "monitor";
  result: UiData;
  resolvedRequestIds: Set<string>;
  humanDrafts: Map<string, JsonObject>;
};

export type MutationOperationState = MutationOperation & { readonly label?: string };

export interface BrowserArguments extends MutableJson {
  limit: number;
  query?: string;
  cursor?: string;
  systemKey?: string;
}

export interface BrowserDetailResponse {
  readonly data: UiData;
  readonly workflowId: string;
}

export interface FocusReturn {
  readonly id: string;
  readonly label: string | null;
}

export interface PagedResponse {
  readonly responseRef: string;
  readonly encoding?: string;
  readonly sizeBytes?: number;
  readonly nextOffset?: number | null;
}
