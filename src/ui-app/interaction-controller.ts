import type { JsonObject, JsonValue } from "./contracts.js";
import type { InteractionFormController } from "./interaction-form.js";
import type { HumanRequest, InputSpec } from "./page-models.js";
import type { ActionId } from "./shell.js";
import { PresentationPersistenceError, persistenceSaveError } from "./action-errors.js";

export type InteractionMutationName = "loomex_interaction_respond" | "loomex_interaction_decide";

export interface RetainedInteractionOperation {
  readonly name: InteractionMutationName;
  readonly slot: string;
  readonly arguments: JsonObject;
}

export interface VerifiedInteractionMutationResult {
  readonly accepted: boolean;
  readonly result: unknown;
}

export interface InteractionControllerServices {
  readonly elements: {
    readonly form: HTMLFormElement;
    readonly summary: HTMLElement;
    readonly primary: HTMLButtonElement;
    readonly secondary: HTMLButtonElement;
  };
  readonly formController: Pick<InteractionFormController,
    "appendRequestCopy" | "typedForm" | "answerActionLabel" | "hidePersistentBatchReview" |
    "openAnswerReview" | "collectAnswer">;
  connected(): boolean;
  authoritativeStateStale(): boolean;
  humanRequest(output: JsonObject): HumanRequest | undefined;
  interactionId(output: JsonObject): string | undefined;
  requestSchemaDigest(request: HumanRequest): string | undefined;
  currentInteractionOperation(): RetainedInteractionOperation | undefined;
  callVerifiedInteractionMutation(
    name: InteractionMutationName,
    slot: string,
    args: JsonObject,
    authoritativeData: JsonObject,
  ): Promise<VerifiedInteractionMutationResult>;
  handoffAcceptedInteraction(authoritativeData: JsonObject, result: unknown): Promise<void>;
  flushCurrentPersistence(): Promise<boolean>;
  immutableCopy<Value extends JsonValue>(value: Value): Value;
  setError(error: unknown): void;
  renderSubmittedInteraction(request: HumanRequest): void;
  renderHumanPresentation(request: HumanRequest, spec: InputSpec | null | undefined): void;
  setAction(button: HTMLButtonElement, label: string, actionId?: ActionId): void;
  setMutationAction(button: HTMLButtonElement, label: string, actionId?: ActionId): void;
  restoreReviewNavigationControls(button: HTMLButtonElement): void;
}

export interface InteractionController {
  render(failed: boolean, output: unknown): void;
  submit(output: unknown): Promise<boolean>;
  reject(output: unknown): Promise<boolean>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Resolve the request owned by an explicit interaction call or its exact retained retry. */
export function acceptedDraftRequestId(
  name: InteractionMutationName,
  slot: string,
  args: JsonObject,
  currentOperation: RetainedInteractionOperation | undefined,
): string | undefined {
  if (typeof args.requestId === "string" && UUID.test(args.requestId)) return args.requestId;
  if (currentOperation?.name !== name || currentOperation.slot !== slot) return undefined;
  const requestId = currentOperation.arguments.requestId;
  return typeof requestId === "string" && UUID.test(requestId) ? requestId : undefined;
}

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function validRequest(request: HumanRequest | undefined): request is HumanRequest {
  if (!request || !UUID.test(typeof request.id === "string" ? request.id : "")) return false;
  if (request.requestId !== undefined && request.requestId !== request.id) return false;
  if (request.type !== undefined && typeof request.type !== "string") return false;
  if (request.status !== undefined && typeof request.status !== "string") return false;
  if (request.inputSpec !== undefined && !record(request.inputSpec)) return false;
  if (request.responseSchema !== undefined && !record(request.responseSchema)) return false;
  if (request.outputSchema !== undefined && !record(request.outputSchema)) return false;
  return true;
}

function requestResolved(request: HumanRequest): boolean {
  const status = String(request.status || "").toLowerCase();
  return ["resolved", "completed", "answered", "approved", "rejected", "cancelled", "canceled", "expired"].includes(status) ||
    (request.answer !== undefined && request.answer !== null);
}

export function createInteractionController(host: InteractionControllerServices): InteractionController {
  const { form, summary, primary, secondary } = host.elements;
  const interactionForm = host.formController;

  function setInteractionAction(button: HTMLButtonElement, action: "approve" | "reject", label: string): void {
    host.setMutationAction(button, label, action);
    button.dataset.interactionAction = action;
  }

  function setAnswerAction(intent: "review" | "submit", label: string): void {
    host.setAction(primary, label, intent);
    primary.dataset.answerIntent = intent;
  }

  function failClosed(message: string): void {
    form.hidden = false;
    form.replaceChildren();
    primary.hidden = false;
    primary.disabled = true;
    secondary.hidden = true;
    secondary.disabled = true;
    summary.classList.add("error");
    summary.setAttribute("role", "alert");
    summary.textContent = message;
  }

  function verifiedPage(outputValue: unknown): { output: JsonObject; request: HumanRequest; requestId: string } | undefined {
    const output = record(outputValue);
    if (!output) return undefined;
    const request = host.humanRequest(output);
    const requestId = host.interactionId(output);
    if (!validRequest(request) || !requestId || !UUID.test(requestId) || request.id !== requestId) return undefined;
    if (output.decisionRequired !== undefined && typeof output.decisionRequired !== "boolean") return undefined;
    return { output, request, requestId };
  }

  function operationForRequest(operation: RetainedInteractionOperation, requestId: string): boolean {
    return (operation.name === "loomex_interaction_respond" || operation.name === "loomex_interaction_decide") &&
      operation.slot.length > 0 && operation.arguments.requestId === requestId;
  }

  async function finishMutation(
    name: InteractionMutationName,
    slot: string,
    args: JsonObject,
    output: JsonObject,
  ): Promise<void> {
    const outcome = await host.callVerifiedInteractionMutation(name, slot, args, output);
    if (outcome.accepted === true) {
      await host.handoffAcceptedInteraction(output, outcome.result);
      return;
    }
    if (name === "loomex_interaction_respond") {
      throw new Error("The answer was not submitted. Refresh to verify the current question before trying again.");
    }
    throw new Error("The decision was not submitted. Refresh to verify the current request before trying again.");
  }

  function render(failed: boolean, outputValue: unknown): void {
    if (failed) return;
    const page = verifiedPage(outputValue);
    if (!page) {
      failClosed("The interaction request identity could not be verified. Refresh before continuing.");
      return;
    }
    const { output, request, requestId } = page;
    const schema = request.responseSchema || request.outputSchema;
    host.renderHumanPresentation(request, request.inputSpec);
    if (requestResolved(request)) {
      host.renderSubmittedInteraction(request);
      return;
    }
    const disabled = !host.connected() || host.authoritativeStateStale();
    if (request.type === "approval" || output.decisionRequired === true) {
      interactionForm.appendRequestCopy(request, request.inputSpec);
      form.hidden = false;
      setInteractionAction(secondary, "reject", "Reject");
      secondary.hidden = false;
      secondary.disabled = disabled;
      setInteractionAction(primary, "approve", "Approve");
      primary.hidden = false;
      primary.disabled = disabled;
      return;
    }
    const retained = host.currentInteractionOperation();
    const initial = retained?.name === "loomex_interaction_respond" &&
      retained.arguments.requestId === requestId && retained.arguments.answer !== undefined
      ? retained.arguments.answer
      : request.answer;
    const formReady = interactionForm.typedForm(schema, initial, request.inputSpec, request);
    if (form.dataset.formKind === "chat-answer") host.setAction(primary, "Continue in conversation", "chat");
    else setAnswerAction("review", interactionForm.answerActionLabel("Review"));
    primary.hidden = false;
    primary.disabled = disabled || (!formReady && form.dataset.formKind !== "chat-answer");
    if (form.dataset.formKind !== "chat-answer" && !host.requestSchemaDigest(request)) {
      primary.disabled = true;
      summary.classList.add("error");
      summary.setAttribute("role", "alert");
      summary.textContent = "The current question schema could not be verified. Refresh this request before answering.";
    }
    interactionForm.hidePersistentBatchReview();
  }

  async function submit(outputValue: unknown): Promise<boolean> {
    const page = verifiedPage(outputValue);
    if (!page) {
      host.setError(new Error("The interaction request identity could not be verified. Refresh before continuing."));
      return false;
    }
    try {
      const retained = host.currentInteractionOperation();
      if (retained) {
        if (!operationForRequest(retained, page.requestId)) {
          throw new Error("The retained interaction operation does not belong to this request. Refresh before retrying.");
        }
        await finishMutation(retained.name, retained.slot, {}, page.output);
        return true;
      }
      if (primary.dataset.interactionAction === "approve") {
        await finishMutation("loomex_interaction_decide", `interaction:approve:${page.requestId}`, {
          requestId: page.requestId,
          decision: "approve",
        }, page.output);
        return true;
      }
      const answerIntent = primary.dataset.answerIntent;
      if (answerIntent === "review") {
        if (!await interactionForm.openAnswerReview()) return false;
        host.restoreReviewNavigationControls(primary);
        return true;
      }
      if (answerIntent !== "submit") throw new Error("Choose Review before submitting an answer.");
      if (!await host.flushCurrentPersistence()) return false;
      const schemaDigest = host.requestSchemaDigest(page.request);
      if (!schemaDigest) throw new Error("The current question schema could not be verified. Refresh this request before submitting.");
      const answer = host.immutableCopy(interactionForm.collectAnswer());
      await finishMutation("loomex_interaction_respond", `interaction:respond:${page.requestId}`, {
        requestId: page.requestId,
        answer,
        expectedSchemaDigest: schemaDigest,
      }, page.output);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // A response cannot be delivered until its exact draft receipt is
      // durable. Keep store internals out of the person-facing status while
      // retaining the answer locally for a safe retry.
      if (error instanceof PresentationPersistenceError) {
        host.setError(error);
      } else if (/durable view store|saved answer draft|view state/i.test(message)) {
        host.setError(persistenceSaveError("answers", error instanceof Error ? error : new Error("The answer state could not be saved.")));
      } else host.setError(error);
      return false;
    }
  }

  async function reject(outputValue: unknown): Promise<boolean> {
    const page = verifiedPage(outputValue);
    if (!page) {
      host.setError(new Error("The interaction request identity could not be verified. Refresh before continuing."));
      return false;
    }
    try {
      await finishMutation("loomex_interaction_decide", `interaction:reject:${page.requestId}`, {
        requestId: page.requestId,
        decision: "reject",
      }, page.output);
      return true;
    } catch (error) {
      host.setError(error);
      return false;
    }
  }

  return { render, submit, reject };
}
