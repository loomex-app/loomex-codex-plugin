import type { JsonObject } from "./contracts.js";
import type { HumanRequest, InputSpec, JsonSchema } from "./page-models.js";
import type { ActionId } from "./shell.js";

export interface AuthoringResponseOperation {
  readonly name: "loomex_builder_respond";
  readonly slot: string;
  readonly arguments: JsonObject;
}

export interface AuthoringControllerServices {
  readonly elements: {
    readonly context: HTMLElement;
    readonly summary: HTMLElement;
    readonly form: HTMLFormElement;
    readonly primary: HTMLButtonElement;
    readonly refresh: HTMLButtonElement;
  };
  connected(): boolean;
  authoritativeStateStale(): boolean;
  builderSessionId(output: JsonObject): string | undefined;
  humanRequest(output: JsonObject): HumanRequest | undefined;
  inputSpecSupported(spec: InputSpec | null | undefined): boolean;
  requestSchemaDigest(request: HumanRequest): string | undefined;
  pagedResponse(output: JsonObject): unknown;
  renderAuthoringWorkflow(output: JsonObject): void;
  renderFailure(result: unknown): void;
  renderHumanPresentation(request: HumanRequest, spec: InputSpec | null | undefined): void;
  typedForm(schema: JsonSchema | null | undefined, initial: unknown, spec?: InputSpec | null, request?: HumanRequest): boolean;
  hidePersistentBatchReview(): void;
  answerActionLabel(action: string): string;
  setAction(button: HTMLButtonElement, label: string, actionId?: ActionId): void;
  setMutationAction(button: HTMLButtonElement, label: string, actionId?: ActionId): void;
  syncChrome(): void;
  loadInteractionDraft(request: HumanRequest): Promise<boolean>;
  setError(error: unknown): void;
  callTool(name: "loomex_builder_get", args: JsonObject, renderResult?: boolean): Promise<unknown>;
  callMutation(name: "loomex_builder_respond", slot: string, args: JsonObject): Promise<unknown>;
  currentResponseOperation(): AuthoringResponseOperation | undefined;
  reconcilePending(result: unknown, operation: AuthoringResponseOperation, authoritativeData: JsonObject): Promise<void>;
  openAnswerReview(): boolean;
  restoreReviewNavigationControls(button: HTMLButtonElement): void;
  collectAnswer(): JsonObject;
}

export interface AuthoringController {
  render(failed: boolean, output: unknown): void;
  refresh(output: unknown): Promise<boolean>;
  submit(output: unknown): Promise<boolean>;
  loadDraft(output: unknown): Promise<boolean>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function validSessionId(value: string | undefined): value is string {
  return typeof value === "string" && UUID.test(value);
}

function validRequest(request: HumanRequest | undefined): request is HumanRequest {
  if (!request || typeof request !== "object") return false;
  if (request.id !== undefined && (typeof request.id !== "string" || !validSessionId(request.id))) return false;
  if (request.inputSpec !== undefined && !record(request.inputSpec)) return false;
  if (request.responseSchema !== undefined && !record(request.responseSchema)) return false;
  if (request.outputSchema !== undefined && !record(request.outputSchema)) return false;
  return true;
}

export function createAuthoringController(host: AuthoringControllerServices): AuthoringController {
  const { context, summary, form, primary, refresh: refreshButton } = host.elements;

  function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: string, text: string): HTMLElementTagNameMap[Tag] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }

  function setAnswerAction(intent: "review" | "submit", label: string): void {
    host.setAction(primary, label, intent);
    primary.dataset.answerIntent = intent;
  }

  function failClosed(message: string): void {
    primary.hidden = false;
    primary.disabled = true;
    summary.classList.add("error");
    summary.setAttribute("role", "alert");
    summary.textContent = message;
    context.hidden = false;
    context.className = "ui-stack";
    context.replaceChildren(element("p", "notice error", message));
    host.syncChrome();
  }

  function outputAndSession(outputValue: unknown): { output: JsonObject; sessionId: string } | undefined {
    const output = record(outputValue);
    if (!output) return undefined;
    const sessionId = host.builderSessionId(output);
    return validSessionId(sessionId) ? { output, sessionId } : undefined;
  }

  function render(failed: boolean, outputValue: unknown): void {
    if (failed) {
      host.renderFailure(outputValue);
      host.syncChrome();
      return;
    }
    const output = record(outputValue);
    if (!output) {
      failClosed("The authoring response is unavailable in this view. Refresh to load it again.");
      return;
    }
    const candidateSessionId = host.builderSessionId(output);
    if (candidateSessionId !== undefined && !validSessionId(candidateSessionId)) {
      failClosed("The authoring session identity could not be verified. Refresh before continuing.");
      return;
    }
    const sessionId = validSessionId(candidateSessionId) ? candidateSessionId : undefined;
    const requestCandidate = host.humanRequest(output);
    if (requestCandidate !== undefined && !validRequest(requestCandidate)) {
      failClosed("The authoring question could not be verified. Refresh before continuing.");
      return;
    }
    const request = requestCandidate;
    const schema = request?.responseSchema || request?.outputSchema;
    if (sessionId && request && (schema || request.inputSpec)) {
      host.renderHumanPresentation(request, request.inputSpec);
      const retained = host.currentResponseOperation();
      const initial = retained?.arguments.sessionId === sessionId && retained.arguments.response !== undefined
        ? retained.arguments.response
        : request.answer || {};
      const formReady = host.typedForm(schema, initial, request.inputSpec, request);
      if (form.dataset.formKind === "chat-answer") host.setAction(primary, "Continue in conversation", "chat");
      else setAnswerAction("review", host.answerActionLabel("Review"));
      primary.hidden = false;
      primary.disabled = !host.connected() || host.authoritativeStateStale() || (!formReady && form.dataset.formKind !== "chat-answer");
      if (request.id && form.dataset.formKind !== "chat-answer" && !host.requestSchemaDigest(request)) {
        primary.disabled = true;
        summary.classList.add("error");
        summary.setAttribute("role", "alert");
        summary.textContent = "The current question schema could not be verified. Refresh this authoring request before answering.";
      }
      host.hidePersistentBatchReview();
    } else if (sessionId) {
      context.hidden = false;
      context.className = "ui-stack";
      const hero = element("div", "ui-hero", "");
      hero.append(
        element("h2", "", "Authoring session"),
        element("p", "ui-meta", typeof output.status === "string" && output.status.trim().length <= 120 ? output.status.trim() : "Ready"),
      );
      context.replaceChildren(hero);
      summary.classList.remove("error");
      summary.setAttribute("role", "status");
      summary.textContent = "The authoring session is ready. Refresh to load its next question or completion state.";
      refreshButton.hidden = false;
      host.setAction(refreshButton, "Refresh authoring", "refresh");
      refreshButton.disabled = !host.connected();
    } else if (host.pagedResponse(output) || record(output.workflow)) {
      summary.textContent = host.pagedResponse(output)
        ? "The complete workflow response is available in the conversation."
        : "";
      host.renderAuthoringWorkflow(output);
    } else {
      failClosed("The authoring response does not contain a session or workflow. Refresh to load its current state.");
      return;
    }
    host.syncChrome();
  }

  async function refresh(outputValue: unknown): Promise<boolean> {
    const current = outputAndSession(outputValue);
    if (!current) return false;
    const operation = host.currentResponseOperation();
    try {
      const result = await host.callTool("loomex_builder_get", { sessionId: current.sessionId }, !operation);
      if (operation) await host.reconcilePending(result, operation, current.output);
      return true;
    } catch (error) {
      host.setError(error);
      return true;
    }
  }

  async function submit(outputValue: unknown): Promise<boolean> {
    const current = outputAndSession(outputValue);
    if (!current) {
      host.setError(new Error("The authoring session identity could not be verified. Refresh before continuing."));
      return false;
    }
    try {
      const retained = host.currentResponseOperation();
      if (retained) {
        await host.callMutation(retained.name, retained.slot, {});
        return true;
      }
      const answerIntent = primary.dataset.answerIntent;
      if (answerIntent === "review") {
        if (!host.openAnswerReview()) return false;
        host.restoreReviewNavigationControls(primary);
        return true;
      }
      if (answerIntent !== "submit") throw new Error("Choose Review before submitting an answer.");
      await host.callMutation("loomex_builder_respond", `builder:respond:${current.sessionId}`, {
        sessionId: current.sessionId,
        response: host.collectAnswer(),
      });
      return true;
    } catch (error) {
      host.setError(error);
      return false;
    }
  }

  async function loadDraft(outputValue: unknown): Promise<boolean> {
    const output = record(outputValue);
    if (!output) return false;
    const request = host.humanRequest(output);
    if (request === undefined) return true;
    if (!validRequest(request)) {
      host.setError(new Error("The authoring question could not be verified. Refresh before restoring its draft."));
      return false;
    }
    if (!host.inputSpecSupported(request.inputSpec)) return true;
    try {
      return await host.loadInteractionDraft(request);
    } catch (error) {
      host.setError(error);
      return false;
    }
  }

  return { render, refresh, submit, loadDraft };
}
