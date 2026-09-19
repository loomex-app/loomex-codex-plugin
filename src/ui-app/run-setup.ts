import { createUiElement as element } from "./components.js";
import type { JsonObject } from "./contracts.js";
import type { ActionId } from "./shell.js";
import type { UiData, SelectedWorkflow, JsonSchema, SetupAnalysis, SetupAnalysisEntry, RunFlow, SetupRunFlow, ReviewRunFlow, RpcResult, TaskWorkspace, WorkflowVersion, PreparedRun } from "./page-models.js";

export interface RunSetupServices {
  readonly elements: { context: HTMLElement; form: HTMLFormElement; summary: HTMLElement; errorDetails: HTMLElement; refresh: HTMLButtonElement; secondary: HTMLButtonElement; primary: HTMLButtonElement };
  connected(): boolean;
  hydrationReady(): boolean;
  taskWorkspace(): TaskWorkspace | null;
  setTaskWorkspace(value: TaskWorkspace | null): void;
  taskWorkspaceFrom(value: unknown): TaskWorkspace | null;
  suggestedWorkspacePath(): string;
  safeText(value: unknown, max?: number): string | undefined;
  authoredLabel(key: string, schema?: JsonSchema): string;
  workflowIdValid(value: unknown): value is string;
  workflowVersionNumber(version?: WorkflowVersion): number | undefined;
  rpcResult(value: unknown): RpcResult;
  setAction(button: HTMLButtonElement, label: string, actionId?: ActionId): void;
  setMutationAction(button: HTMLButtonElement, label: string, actionId?: ActionId): void;
  renderFailure(result: RpcResult): void;
  renderIntegratedRunFlow(): void;
  beginSetupReview(inputs: JsonObject): Promise<void>;
  preparationView(data: PreparedRun | UiData): void;
  preparationReviewable(data: PreparedRun | UiData): boolean;
}
type Attributes = Readonly<Record<string,string | number | boolean | Readonly<Record<string,string>> | undefined>>;

function record(value: unknown): Record<string,unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : null; }
function immutableCopy<T>(value: T): T { return structuredClone(value); }

/** Owns setup/review drafts; it never converts stored presentation into execution authority. */
export function createRunSetupController(host: RunSetupServices) {
  const {context,form,summary,errorDetails,refresh,secondary,primary} = host.elements;
  const {safeText,authoredLabel,workflowIdValid,workflowVersionNumber,rpcResult,taskWorkspaceFrom,suggestedWorkspacePath,setAction,setMutationAction,renderFailure,renderIntegratedRunFlow,beginSetupReview,preparationView,preparationReviewable} = host;
  let runFlow: RunFlow | null = null;
  let disposed = false;
  const listeners = new AbortController();
  function activeSetupFlow(): SetupRunFlow {
    if (!runFlow || runFlow.stage !== "setup" || !runFlow.setup || !runFlow.analysis || !runFlow.inputDraft || typeof runFlow.workspaceDraft !== "string") throw new Error("Run setup is not available.");
    return runFlow as SetupRunFlow;
  }
  function activeReviewFlow(): ReviewRunFlow {
    if (!runFlow || runFlow.stage !== "review" || !runFlow.prepared) throw new Error("Run review is not available.");
    return runFlow as ReviewRunFlow;
  }
  function selectedWorkflowVersion(data: UiData): SelectedWorkflow | undefined {
    const version = data && data.selectedVersion;
    const definition = version && typeof version.definition === "object" && version.definition;
    const workflowId = safeText(data?.workflow?.id, 64);
    const organizationId = safeText(data?.workflow?.organizationId, 64);
    const versionId = safeText(version?.id, 64);
    const versionWorkflowId = safeText(version?.workflowId, 64);
    return workflowIdValid(workflowId) && workflowIdValid(organizationId) && workflowIdValid(versionId) && definition && (!versionWorkflowId || versionWorkflowId === workflowId)
      ? { workflowId, organizationId, versionId, version, definition }
      : undefined;
  }

  function setupSchema(data: UiData): JsonSchema | undefined {
    const selected = selectedWorkflowVersion(data);
    if (!selected) return undefined;
    if (data.inputSchema && typeof data.inputSchema === "object") return data.inputSchema;
    const settings = selected.definition.settings && typeof selected.definition.settings === "object" ? selected.definition.settings : {};
    if (settings.inputSchema && typeof settings.inputSchema === "object") return settings.inputSchema;
    const start = Array.isArray(selected.definition.nodes) && selected.definition.nodes.find((node) =>
      node && node.type === "start" && node.inputSchema && typeof node.inputSchema === "object");
    return start ? start.inputSchema : { type: "object", properties: {}, required: [] };
  }

  function setupSchemaAnalysis(data: UiData): SetupAnalysis {
    const schema = setupSchema(data);
    const selected = selectedWorkflowVersion(data);
    if (!schema || !selected || (schema.type !== undefined && schema.type !== "object") || schema.anyOf || schema.oneOf || schema.allOf || schema.$ref) {
      return { supported: false, reason: "This workflow uses an input schema that cannot be collected safely in this view." };
    }
    const properties = schema.properties === undefined ? {} : schema.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      return { supported: false, reason: "This workflow’s input fields are not available as a supported object schema." };
    }
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    if ([...required].some((key) => typeof key !== "string" || !Object.hasOwn(properties, key))) {
      return { supported: false, reason: "This workflow declares a required input that is not defined." };
    }
    const settings = selected.definition.settings && typeof selected.definition.settings === "object" ? selected.definition.settings : {};
    const workspaceInputField = settings.workspaceInputField === undefined ? undefined : safeText(settings.workspaceInputField, 120);
    if (settings.workspaceInputField !== undefined && (!workspaceInputField || !Object.hasOwn(properties, workspaceInputField))) {
      return { supported: false, reason: "This workflow’s workspace input mapping is invalid." };
    }
    const entries: SetupAnalysisEntry[] = [];
    for (const [key, field] of Object.entries(properties)) {
      if (!field || typeof field !== "object" || Array.isArray(field) || field.anyOf || field.oneOf || field.allOf || field.$ref || field.const !== undefined) {
        return { supported: false, reason: `The input “${authoredLabel(key, field)}” needs to be provided in the conversation.` };
      }
      const values = field.enum;
      const inferredType = field.type || (Array.isArray(values) ? typeof values[0] : undefined);
      const type = typeof inferredType === "string" ? inferredType : "";
      const supportedWorkspacePattern = key === workspaceInputField && field.pattern === "^/";
      const unsupportedConstraint = (["format", "contentEncoding", "contentMediaType", "multipleOf", "exclusiveMinimum", "exclusiveMaximum"] as const)
        .some((name) => field[name] !== undefined);
      if ((field.pattern !== undefined && !supportedWorkspacePattern) || unsupportedConstraint || (field.minLength !== undefined && !Number.isSafeInteger(field.minLength)) ||
        (field.maxLength !== undefined && !Number.isSafeInteger(field.maxLength)) ||
        (field.minimum !== undefined && typeof field.minimum !== "number") || (field.maximum !== undefined && typeof field.maximum !== "number")) {
        return { supported: false, reason: `The constraints for “${authoredLabel(key, field)}” need to be validated in the conversation.` };
      }
      const supportedEnum = Array.isArray(values) && values.length > 0 && values.length <= 100 && values.every((value) =>
        (typeof value === "string" || typeof value === "number") && Number.isFinite(typeof value === "number" ? value : 0));
      if (values !== undefined && !supportedEnum) {
        return { supported: false, reason: `The choices for “${authoredLabel(key, field)}” cannot be collected safely here.` };
      }
      if (!values && !["string", "number", "integer", "boolean"].includes(type)) {
        return { supported: false, reason: `The input “${authoredLabel(key, field)}” uses the unsupported type “${safeText(type, 40) || "unknown"}”.` };
      }
      const supportedValues = Array.isArray(values)
        ? values.filter((value): value is string | number => typeof value === "string" || typeof value === "number")
        : undefined;
      entries.push({ key, field, type, ...(supportedValues ? { values: supportedValues } : {}), required: required.has(key), workspace: key === workspaceInputField });
    }
    return { supported: true, schema, entries, ...(workspaceInputField ? { workspaceInputField } : {}) };
  }

  function setupRequestIdentity(result: unknown): string | undefined {
    const rpc = rpcResult(result);
    const envelope = record(rpc.structuredContent);
    return safeText(envelope?.requestId || rpc._meta?.requestId, 128);
  }

  function initializeRunSetup(data: UiData, returnToBrowser = false, sourceIdentity = ""): void {
    const selected = selectedWorkflowVersion(data);
    const analysis = setupSchemaAnalysis(data);
    const initialWorkspace = suggestedWorkspacePath();
    runFlow = {
      stage: "setup",
      setup: data,
      ...(selected ? {selected} : {}),
      analysis,
      returnToBrowser,
      inputDraft: {},
      workspaceDraft: initialWorkspace,
      workspaceEditing: !initialWorkspace,
      workspaceSource: host.taskWorkspace()?.workspacePath ? "override" : initialWorkspace ? "task" : "manual",
      setupWorkspacePath: initialWorkspace,
      setupRequestIdentity: sourceIdentity,
      canonicalWorkspace: "",
      operations: new Map(),
      busy: false,
      autoPreparation: "idle",
      // The review action issues a non-authorizing reference after the
      // preparation is verified. A Start click is the only path that can ask
      // the runner to record approval.
      startHandoffState: "unknown",
    };
  }

  // A repeated setup notification is descriptive state, not a request to discard
  // an in-progress review or replay its preparation.
  function matchesRunSetup(data: UiData, sourceIdentity = "", flow: RunFlow | null = runFlow, preserveWorkspaceWithoutMetadata = false): boolean {
    const selected = selectedWorkflowVersion(data);
    const sameRequest = Boolean(sourceIdentity && flow?.setupRequestIdentity && sourceIdentity === flow.setupRequestIdentity);
    return Boolean(flow?.setup && selected && flow.selected &&
      selected.workflowId === flow.selected.workflowId &&
      selected.versionId === flow.selected.versionId &&
      selected.organizationId === flow.selected.organizationId &&
      (preserveWorkspaceWithoutMetadata ? sameRequest : flow.setupWorkspacePath === suggestedWorkspacePath()) &&
      (!sourceIdentity || !flow.setupRequestIdentity || sourceIdentity === flow.setupRequestIdentity));
  }

  function autoPreparationEligible(flow: RunFlow | null = runFlow): boolean {
    return Boolean(flow?.stage === "setup" && flow.analysis?.supported && flow.selected &&
      flow.analysis.entries.every((entry) => entry.workspace) &&
      ["task", "override"].includes(flow.workspaceSource || "") &&
      typeof flow.workspaceDraft === "string" && flow.workspaceDraft.startsWith("/") &&
      flow.autoPreparation === "idle" && host.hydrationReady());
  }

  function scheduleAutomaticPreparation(flow: RunFlow | null = runFlow): boolean {
    if (disposed || !host.connected() || flow === null || !autoPreparationEligible(flow)) return false;
    flow.autoPreparation = "scheduled";
    Promise.resolve().then(async () => {
      if (disposed || runFlow !== flow || flow.autoPreparation !== "scheduled" || flow.stage !== "setup") return;
      flow.autoPreparation = "started";
      try {
        await beginSetupReview({});
      } catch (error: unknown) {
        if (disposed || runFlow !== flow) return;
        runFlowError(error instanceof Error ? error.message : "The review could not be prepared. Choose Review run to try again.", error);
        renderIntegratedRunFlow();
      }
    });
    return true;
  }

  function runFlowError(message: string, error: unknown = runFlow?.error): void {
    if (runFlow) {
      runFlow.errorMessage = message;
      if (error !== undefined) runFlow.error = error;
    }
    renderFailure({ error });
    summary.classList.add("error");
    summary.setAttribute("role", "alert");
    summary.textContent = message;
  }

  function setupFieldError(control: HTMLElement, message: string): void {
    control.setAttribute("aria-invalid", "true");
    const error = element("p", { className: "field-error", id: `${control.id}-error`, role: "alert" }, message);
    control.setAttribute("aria-describedby", error.id);
    control.parentElement?.append(error);
  }

  function clearSetupErrors() {
    for (const error of form.querySelectorAll(".field-error")) error.remove();
    for (const control of form.querySelectorAll("[aria-invalid]")) {
      control.removeAttribute("aria-invalid");
      control.removeAttribute("aria-describedby");
    }
  }

  function collectRunSetupInputs() {
    const runFlow = activeSetupFlow();
    if (!runFlow.analysis.supported) throw new Error("These inputs must be collected in the conversation.");
    clearSetupErrors();
    const inputs: Record<string, string | number | boolean> = {};
    let firstInvalid: HTMLElement | null = null;
    for (const entry of runFlow.analysis.entries) {
      if (entry.workspace) continue;
      const control = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-run-input="${CSS.escape(entry.key)}"]`);
      if (!control) continue;
      const empty = control.value === "";
      if (empty && entry.required) {
        setupFieldError(control, `Enter ${authoredLabel(entry.key, entry.field)}.`);
        firstInvalid ||= control;
        continue;
      }
      if (empty) continue;
      let value;
      if (entry.values) {
        const index = Number(control.value);
        value = Number.isInteger(index) ? entry.values[index] : undefined;
        if (value === undefined) { setupFieldError(control, "Choose an available option."); firstInvalid ||= control; continue; }
      } else if (entry.type === "boolean") {
        value = control.value === "true";
      } else if (entry.type === "integer") {
        if (!/^-?\d+$/.test(control.value)) {
          setupFieldError(control, "Enter a whole number."); firstInvalid ||= control; continue;
        }
        value = Number(control.value);
        if (!Number.isSafeInteger(value)) {
          setupFieldError(control, "Enter a whole number within the supported range."); firstInvalid ||= control; continue;
        }
      } else if (entry.type === "number") {
        if (!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(control.value)) {
          setupFieldError(control, "Enter a valid number."); firstInvalid ||= control; continue;
        }
        value = Number(control.value);
        if (!Number.isFinite(value)) {
          setupFieldError(control, "Enter a finite number."); firstInvalid ||= control; continue;
        }
      } else value = control.value;
      if (typeof value === "string" && typeof entry.field.minLength === "number" && Number.isInteger(entry.field.minLength) && value.length < entry.field.minLength) {
        setupFieldError(control, `Enter at least ${entry.field.minLength} characters.`); firstInvalid ||= control; continue;
      }
      if (typeof value === "string" && typeof entry.field.maxLength === "number" && Number.isInteger(entry.field.maxLength) && value.length > entry.field.maxLength) {
        setupFieldError(control, `Enter no more than ${entry.field.maxLength} characters.`); firstInvalid ||= control; continue;
      }
      if (typeof value === "number" && typeof entry.field.minimum === "number" && value < entry.field.minimum) {
        setupFieldError(control, `Enter a value of at least ${entry.field.minimum}.`); firstInvalid ||= control; continue;
      }
      if (typeof value === "number" && typeof entry.field.maximum === "number" && value > entry.field.maximum) {
        setupFieldError(control, `Enter a value no greater than ${entry.field.maximum}.`); firstInvalid ||= control; continue;
      }
      inputs[entry.key] = value;
    }
    const workspace = form.querySelector<HTMLInputElement>("#run-workspace");
    if (!workspace || !workspace.value.trim()) {
      if (workspace) setupFieldError(workspace, "Choose an absolute workspace directory.");
      firstInvalid ||= workspace;
    } else if (!workspace.value.trim().startsWith("/")) {
      setupFieldError(workspace, "Enter an absolute workspace path."); firstInvalid ||= workspace;
    }
    if (!workspace || firstInvalid) {
      firstInvalid?.focus();
      throw new Error("Complete the required inputs before continuing.");
    }
    runFlow.inputDraft = inputs;
    runFlow.workspaceDraft = workspace.value.trim();
    return inputs;
  }

  function createSetupControl(entry: SetupAnalysisEntry) {
    const runFlow = activeSetupFlow();
    const id = `run-input-${entry.key.replace(/[^a-z0-9_-]/gi, "-")}`;
    const labelText = authoredLabel(entry.key, entry.field);
    const wrapper = element("div", { className: "setup-field" });
    const label = element("label", { htmlFor: id }, labelText);
    if (entry.required) label.append(element("span", { className: "required-mark", "aria-hidden": "true" }, " *"));
    let control: HTMLInputElement | HTMLSelectElement;
    if (entry.values) {
      control = element("select", { id, dataset: { runInput: entry.key }, disabled: runFlow.busy || runFlow.operations.size > 0 });
      control.append(element("option", { value: "" }, `Choose ${labelText}`));
      entry.values.forEach((value, index) => control.append(element("option", { value: String(index) }, String(value))));
      const selected = entry.values.findIndex((value) => Object.is(value, runFlow.inputDraft[entry.key]));
      control.value = selected >= 0 ? String(selected) : "";
    } else if (entry.type === "boolean") {
      control = element("select", { id, dataset: { runInput: entry.key }, disabled: runFlow.busy || runFlow.operations.size > 0 });
      control.append(element("option", { value: "" }, `Choose ${labelText}`), element("option", { value: "true" }, "Yes"), element("option", { value: "false" }, "No"));
      control.value = typeof runFlow.inputDraft[entry.key] === "boolean" ? String(runFlow.inputDraft[entry.key]) : "";
    } else {
      control = element("input", { id, type: entry.type === "string" ? "text" : "text", inputMode: entry.type === "integer" ? "numeric" : entry.type === "number" ? "decimal" : undefined,
        value: runFlow.inputDraft[entry.key] ?? "", dataset: { runInput: entry.key }, autocomplete: "off", disabled: runFlow.busy || runFlow.operations.size > 0 });
    }
    control.addEventListener("input", () => { runFlow.inputDraft[entry.key] = control.value; }, { signal: listeners.signal });
    wrapper.append(label, control);
    const description = safeText(entry.field.description, 500);
    if (description) wrapper.append(element("p", { className: "hint" }, description));
    return wrapper;
  }

  function renderRunSetup() {
    const runFlow = activeSetupFlow();
    const data = runFlow.setup;
    const selected = runFlow.selected;
    context.hidden = false; context.className = "ui-stack"; context.replaceChildren();
    const autoPending = runFlow.autoPreparation === "scheduled" ||
      (runFlow.autoPreparation === "started" && (runFlow.busy ||
        (Object.hasOwn(runFlow, "pendingSetupInputs") && runFlow.operations.size === 0)));
    context.setAttribute("aria-label", "Run setup"); context.setAttribute("aria-busy", String(runFlow.busy || autoPending));
    form.hidden = false; form.className = "setup-fields"; form.replaceChildren();
    errorDetails.hidden = true; errorDetails.replaceChildren();
    refresh.hidden = true; secondary.hidden = !runFlow.returnToBrowser;
    if (runFlow.returnToBrowser) { setAction(secondary, "Return to workflow list", "back"); secondary.disabled = runFlow.busy; }
    const hero = element("div", { className: "ui-hero" });
    hero.append(element("h2", {}, safeText(data?.workflow?.name) || "Set up run"));
    const version = workflowVersionNumber(selected?.version);
    hero.append(element("p", { className: "ui-meta" }, Number.isInteger(version) ? `Version ${version}` : "Pinned version"));
    context.append(hero);
    if (!runFlow.analysis.supported) {
      context.append(element("div", { className: "ui-callout" }, runFlow.analysis.reason));
      form.hidden = true;
      primary.hidden = false; setAction(primary, "Continue in conversation", "chat"); primary.disabled = !host.connected() || runFlow.busy;
      summary.textContent = "This workflow’s inputs need to be collected in the conversation.";
      return;
    }
    if (autoPreparationEligible() || autoPending) {
      form.hidden = true;
      primary.hidden = true;
      context.append(element("p", { className: "activity", role: "status", "aria-live": "polite" }, "Preparing your review…"));
      summary.classList.remove("error"); summary.setAttribute("role", "status");
      if (!runFlow.errorMessage) summary.textContent = "";
      scheduleAutomaticPreparation();
      if (runFlow.errorMessage) runFlowError(runFlow.errorMessage);
      return;
    }
    for (const entry of runFlow.analysis.entries) if (!entry.workspace) form.append(createSetupControl(entry));
    const workspaceField = element("div", { className: "setup-field" });
    const workspaceInputField = runFlow.analysis.workspaceInputField;
    const mappedWorkspaceSchema = workspaceInputField ? runFlow.analysis.schema.properties?.[workspaceInputField] : undefined;
    const workspaceLabel = mappedWorkspaceSchema && workspaceInputField ? authoredLabel(workspaceInputField, mappedWorkspaceSchema) : "Workspace directory";
    workspaceField.append(element("label", { htmlFor: "run-workspace" }, `${workspaceLabel} *`));
    const workspaceControls = element("div", { className: "workspace-control" });
    const workspace = element("input", { id: "run-workspace", type: "text", value: runFlow.canonicalWorkspace || runFlow.workspaceDraft, autocomplete: "off",
      readOnly: !runFlow.workspaceEditing, disabled: runFlow.busy || runFlow.operations.size > 0 });
    workspace.addEventListener("input", () => {
      runFlow.workspaceDraft = workspace.value;
      runFlow.workspaceSource = "manual";
      host.setTaskWorkspace(taskWorkspaceFrom({
        ...(host.taskWorkspace()?.taskContext ? { taskContext: host.taskWorkspace()?.taskContext } : {}),
        workspacePath: workspace.value,
      }));
      if (runFlow.canonicalWorkspace && workspace.value !== runFlow.canonicalWorkspace) runFlow.canonicalWorkspace = "";
    }, { signal: listeners.signal });
    workspaceControls.append(workspace);
    if (!runFlow.workspaceEditing) {
      const change = element("button", { type: "button", className: "secondary", disabled: runFlow.busy || runFlow.operations.size > 0 }, "Change workspace");
      setAction(change, "Change workspace", "edit");
      change.addEventListener("click", () => {
        runFlow.workspaceEditing = true;
        renderIntegratedRunFlow();
        form.querySelector<HTMLInputElement>("#run-workspace")?.focus();
      }, { signal: listeners.signal });
      workspaceControls.append(change);
    }
    workspaceField.append(workspaceControls);
    if (runFlow.canonicalWorkspace) workspaceField.append(element("p", { className: "workspace-path" }, `Selected directory: ${runFlow.canonicalWorkspace}`));
    else if (runFlow.workspaceSource === "task") workspaceField.append(element("p", { className: "hint" }, "Suggested from this local Codex task. Change it if this run belongs elsewhere."));
    else if (runFlow.workspaceSource === "override") workspaceField.append(element("p", { className: "hint" }, "Selected for this run. Change it if needed."));
    else workspaceField.append(element("p", { className: "hint" }, safeText(mappedWorkspaceSchema?.description, 500) || "Choose the directory where this workflow may run."));
    form.append(workspaceField);
    primary.hidden = false;
    const operation = runFlow.operations.values().next().value;
    setMutationAction(primary, operation ? `Retry exact ${operation.label}` : "Review run", "review");
    primary.disabled = !host.connected() || runFlow.busy;
    summary.classList.remove("error"); summary.setAttribute("role", "status");
    if (!operation && !runFlow.errorMessage) summary.textContent = "";
    if (runFlow.errorMessage) runFlowError(runFlow.errorMessage);
  }

  function renderRunReview() {
    const runFlow = activeReviewFlow();
    form.hidden = true; form.replaceChildren(); refresh.hidden = false; setAction(refresh, "Check runner", "refresh");
    secondary.hidden = !runFlow.setup; setAction(secondary, "Edit setup", "edit"); secondary.disabled = runFlow.busy || runFlow.operations.size > 0;
    preparationView(runFlow.prepared);
    const review = context.firstElementChild;
    context.setAttribute("aria-busy", String(runFlow.busy));
    primary.hidden = false;
    const operation = runFlow.operations.values().next().value;
    setMutationAction(primary, runFlow.preparationStale
      ? operation ? "Retry exact preparation" : "Review again"
      : operation ? "Retry exact start" : "Start run", runFlow.preparationStale ? "review" : "start");
    const handoffState = runFlow.startHandoffState || "unknown";
    // A new handoff is sealed only by the explicit Start gesture. Restoring a
    // review without one is a ready state, not a blocked recovery state.
    const noHandoffYet = handoffState === "unknown";
    const handoffReady = noHandoffYet || (handoffState === "prepared" && workflowIdValid(runFlow.startHandoffRef) && runFlow.startHandoffReady === true);
    const handoffPending = !handoffReady;
    const approved = ["approved", "committing", "committed"].includes(handoffState);
    if (approved) { primary.hidden = true; secondary.hidden = true; }
    const handoffOperation=[...runFlow.operations.values()].find((operation) =>
      operation.name === "loomex_run_start_handoff_issue" || operation.name === "loomex_run_start_handoff_approve",
    );
    const recoveryNeeded=Boolean(handoffOperation);
    if (recoveryNeeded) setMutationAction(primary,"Restore Start","start");
    primary.disabled = !host.connected() || runFlow.busy || (runFlow.preparationStale
      ? !reprepareArguments()
      : recoveryNeeded
        ? !preparationReviewable(runFlow.prepared)
        : handoffPending || !preparationReviewable(runFlow.prepared));
    if (!operation && !runFlow.errorMessage) {
      summary.classList.remove("error"); summary.setAttribute("role", "status");
      summary.textContent = handoffPending
        ? recoveryNeeded
          ? "Start approval needs reconciliation. Restore Start checks the saved handoff without starting the run."
          : handoffState === "approved" || handoffState === "committing"
          ? ""
          : handoffState === "committed"
            ? ""
            : handoffState === "expired" || handoffState === "rejected"
              ? "This reviewed start is no longer current. Review the run again before starting."
              : noHandoffYet
                ? "Review the selected workflow, then start when ready."
                : "This reviewed start is being verified by the runner."
        : runFlow.preparationStale
        ? "This preparation is no longer current. Review a fresh preparation before starting."
        : "";
    }
    if (runFlow.errorMessage) runFlowError(runFlow.errorMessage);
  }

  function initializePreparedRunReview(data: PreparedRun | UiData): void {
    const binding = data?.binding && typeof data.binding === "object" ? data.binding : {};
    const workflowId = safeText(binding.workflowId, 64);
    const versionId = safeText(binding.versionId, 64);
    const organizationId = safeText(binding.organizationId, 64);
    const installationId = safeText(binding.installationId, 64);
    runFlow = {
      stage: "review",
      prepared: immutableCopy(data) as PreparedRun,
      selected: {
        ...(workflowId ? { workflowId } : {}),
        ...(versionId ? { versionId } : {}),
        ...(organizationId ? { organizationId } : {}),
      },
      canonicalWorkspace: safeText(binding.workspacePath, 4096) || "",
      ...(installationId ? { installationId } : {}),
      operations: new Map(),
      busy: false,
      startHandoffState: "unknown",
      returnToBrowser: false,
    };
  }

  function reprepareArguments() {
    if (!runFlow) return undefined;
    const binding = runFlow?.prepared?.binding;
    const selected = runFlow?.selected;
    if (!binding || !selected?.workflowId || !selected?.versionId || !selected?.organizationId ||
      binding.workflowId !== selected.workflowId || binding.versionId !== selected.versionId ||
      binding.organizationId !== selected.organizationId || binding.installationId !== runFlow.installationId ||
      binding.workspacePath !== runFlow.canonicalWorkspace || binding.executionPolicy !== "host_user/v1" ||
      !binding.inputs || typeof binding.inputs !== "object" || Array.isArray(binding.inputs) ||
      !runFlow.canonicalWorkspace?.startsWith("/")) return undefined;
    return {
      workflowId: selected.workflowId,
      versionId: selected.versionId,
      ...(Object.keys(binding.inputs).length ? { inputs: immutableCopy(binding.inputs) } : {}),
      workspacePath: runFlow.canonicalWorkspace,
    };
  }

  return {
    selectedWorkflowVersion, setupSchema, setupSchemaAnalysis, setupRequestIdentity, initializeRunSetup, matchesRunSetup, autoPreparationEligible, scheduleAutomaticPreparation, runFlowError, setupFieldError, clearSetupErrors, collectRunSetupInputs, createSetupControl, renderRunSetup, renderRunReview, initializePreparedRunReview, reprepareArguments, activeSetupFlow, activeReviewFlow,
    get flow() { return runFlow; },
    set flow(value: RunFlow | null) { runFlow = value; },
    dispose() { disposed = true; listeners.abort(); },
  };
}
