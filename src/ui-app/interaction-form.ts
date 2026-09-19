import { createAnswerReviewItem, createUiElement, type ElementAttributes } from "./components.js";
import type { JsonObject, UiMode } from "./contracts.js";
import type { HumanRequest, InputQuestion, InputSpec, JsonSchema } from "./page-models.js";
import type { ActionId } from "./shell.js";

export type InteractionPresentation = Readonly<{
  kind: "review" | "clarification" | "progress";
  question?: string;
  summary?: string;
}>;

type AnswerPhase = "answer" | "review";
type SupportedInputType = "text" | "long_text" | "date" | "rating" | "boolean" | "radio" | "checkbox";
type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type QuestionAnswer = JsonObject & { value?: unknown; values?: readonly unknown[]; otherText?: unknown; questionId?: unknown };
type QuestionMetadata = Readonly<{ question: InputQuestion; inputType: SupportedInputType; acceptanceLabels: boolean }>;
type DomAttributeValue = string | number | boolean | Readonly<Record<string, string>> | null | undefined;
type DomAttributes = Readonly<Record<string, DomAttributeValue>>;

export interface InteractionFormServices {
  readonly elements: {
    readonly form: HTMLFormElement;
    readonly primary: HTMLButtonElement;
    readonly secondary: HTMLButtonElement;
    readonly summary: HTMLElement;
  };
  mode(): UiMode;
  connected(): boolean;
  authoritativeStateStale(): boolean;
  latestAnswerChannel(): string;
  persistenceReady(): boolean;
  humanPresentation(request: HumanRequest): InteractionPresentation | undefined;
  safeText(value: unknown, maximumLength?: number): string | undefined;
  reviewValue(value: unknown): Node;
  formatDateTime(value: unknown): string | undefined;
  setAction(button: HTMLButtonElement, label: string, actionId?: ActionId): void;
  setError(error: unknown): void;
  markViewDirty(): void;
  scheduleInteractionDraft(): void;
  saveReviewNavigation(): void;
  onRender(): void;
}

export interface InteractionFormController {
  normalizeInputType(value: unknown): string;
  inputSpecSupported(spec: InputSpec | null | undefined): boolean;
  questionCopyValues(spec: InputSpec | null | undefined): string[];
  appendRequestCopy(request: HumanRequest, spec: InputSpec | null | undefined): void;
  renderLongTextHandoff(request: HumanRequest, contract: LongTextQuestionContract): void;
  questionForm(spec: InputSpec, schema: JsonSchema, initial: unknown, request?: HumanRequest): void;
  typedForm(schema: JsonSchema | null | undefined, initial: unknown, spec?: InputSpec | null, request?: HumanRequest): boolean;
  showQuestionStep(index: number, focus: boolean): void;
  autoAdvanceChoice(control: HTMLInputElement): Promise<void>;
  hidePersistentBatchReview(): void;
  answerActionLabel(action: string): string;
  answerText(question: InputQuestion, answer: unknown): string;
  submittedAnswerReview(request: HumanRequest, answer?: unknown): HTMLElement;
  exitAnswerReview(index?: number): void;
  beginAnswerReview(): boolean;
  openAnswerReview(): boolean;
  collectAnswer(): JsonObject;
  questionAnswersById(): JsonObject;
  restoreQuestionAnswers(answers: unknown): void;
  visibleQuestionId(): string | null;
  attach(): void;
  dispose(): void;
}

export interface LongTextQuestionContract {
  readonly valid: boolean;
  readonly question: InputQuestion | undefined;
  readonly answerChannel: string;
  readonly channelError?: string;
}

type AnswerChannelResolution = Readonly<{
  answerChannel: string;
  requestSuppliesChannel: boolean;
  channelError?: string;
}>;

const SUPPORTED_INLINE_TYPES = new Set<string>(["text", "date", "rating", "boolean", "radio", "checkbox"]);
const EMPTY_REQUEST: HumanRequest = {};

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function answerValue(value: unknown): QuestionAnswer {
  return objectValue(value) ?? {};
}

function optionId(option: unknown): string {
  const value = objectValue(option)?.id;
  return typeof value === "string" ? value : "";
}

function optionLabel(option: unknown): string {
  const value = objectValue(option);
  const label = value?.label || value?.text;
  return typeof label === "string" ? label : "";
}

export function normalizeInputType(value: unknown): string {
  const normalized = String(value || "text").trim().toLowerCase().replaceAll("-", "_");
  return ["long_answer", "textarea"].includes(normalized) ? "long_text" : normalized;
}

export function inputSpecSupported(spec: InputSpec | null | undefined): boolean {
  if (!spec || typeof spec !== "object") return false;
  const batch = spec.collectionMode === "batch" || Array.isArray(spec.questions);
  const questions = batch ? spec.questions : [spec];
  if (!Array.isArray(questions) || !questions.length) return false;
  const ids = new Set<string>();
  return questions.every((question) => {
    if (!question || typeof question !== "object" || typeof question.question !== "string" || !question.question.trim()) return false;
    const inputType = normalizeInputType(question.inputType || spec.inputType);
    if (!SUPPORTED_INLINE_TYPES.has(inputType)) return false;
    if (batch) {
      if (typeof question.id !== "string" || !question.id.trim() || ids.has(question.id)) return false;
      ids.add(question.id);
    }
    if (inputType === "rating") {
      const minimumValid = question.minimum === undefined || Number.isSafeInteger(question.minimum);
      const maximumValid = question.maximum === undefined || Number.isSafeInteger(question.maximum);
      const minimum = question.minimum === undefined ? 1 : question.minimum;
      const maximum = question.maximum === undefined ? 5 : question.maximum;
      if (!minimumValid || !maximumValid || minimum > maximum) return false;
    }
    if (inputType === "radio" || inputType === "checkbox") {
      if (!Array.isArray(question.options) || typeof question.allowOther !== "boolean") return false;
      const optionIds = new Set<string>();
      for (const option of question.options) {
        const id = optionId(option);
        if (!id || id === "other" || optionIds.has(id) || !optionLabel(option).trim()) return false;
        optionIds.add(id);
      }
      if (!optionIds.size && !question.allowOther) return false;
    }
    return true;
  });
}

export function validDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

export function questionCopyValues(spec: InputSpec | null | undefined): string[] {
  if (!spec || typeof spec !== "object") return [];
  const questions = Array.isArray(spec.questions) ? spec.questions : [spec];
  return questions
    .map((question) => typeof question?.question === "string" && question.question.trim().length <= 4096 ? question.question.trim() : "")
    .filter(Boolean);
}

export function createInteractionFormController(host: InteractionFormServices): InteractionFormController {
  const { form, primary, secondary, summary } = host.elements;
  let questionMetadata: readonly QuestionMetadata[] = [];
  let attached = false;
  let lastRadioNavigationKey: string | null = null;
  let radioNavigationTimer: ReturnType<typeof setTimeout> | null = null;

  function element<Tag extends keyof HTMLElementTagNameMap>(
    tag: Tag,
    attributes: DomAttributes = {},
    text = "",
  ): HTMLElementTagNameMap[Tag] {
    // Keep the existing optional-attribute convention at this call boundary.
    const normalized = Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined && value !== null && value !== false)) as ElementAttributes;
    const node = createUiElement(tag, normalized, text);
    if (node instanceof HTMLButtonElement && text) host.setAction(node, text);
    return node;
  }

  function setAnswerAction(button: HTMLButtonElement, intent: "back" | "next" | "review" | "submit", label: string, mutation = false): void {
    host.setAction(button, label, intent);
    if (mutation) button.dataset.businessMutation = "true";
    button.dataset.answerIntent = intent;
  }

  function answerChannelResolution(spec: InputSpec | null | undefined, request: HumanRequest): AnswerChannelResolution {
    const requestSuppliesChannel = Object.hasOwn(request, "answerChannel");
    const requestedChannel = requestSuppliesChannel
      ? host.safeText(request.answerChannel, 40)
      : host.safeText(spec?.answerChannel, 40) || host.latestAnswerChannel();
    const answerChannel = requestedChannel || "";
    return {
      answerChannel,
      requestSuppliesChannel,
      ...(requestSuppliesChannel && !["chat", "ui"].includes(answerChannel)
        ? { channelError: "This request uses an unsupported answer channel. Continue in the conversation for the compatible response flow." }
        : {}),
    };
  }

  function longTextQuestionContract(spec: InputSpec | null | undefined, request: HumanRequest = EMPTY_REQUEST): LongTextQuestionContract | null {
    if (!spec || typeof spec !== "object") return null;
    const batch = spec.collectionMode === "batch" || Array.isArray(spec.questions);
    const questions = batch ? spec.questions : [spec];
    if (!Array.isArray(questions)) return null;
    const longQuestions = questions.filter((question) => normalizeInputType(question?.inputType || spec.inputType) === "long_text");
    if (!longQuestions.length) return null;
    const candidate = longQuestions[0];
    const question = objectValue(candidate) ? candidate as InputQuestion : undefined;
    // The request selects the response route. `inputSpec.answerChannel` is
    // legacy display metadata only when the authoritative request omitted a
    // route altogether.
    const route = answerChannelResolution(spec, request);
    return {
      valid: !batch && questions.length === 1 && longQuestions.length === 1,
      question,
      answerChannel: route.answerChannel,
      ...(route.channelError ? { channelError: route.channelError } : {}),
    };
  }

  function renderLongTextHandoff(request: HumanRequest, contract: LongTextQuestionContract): void {
    form.replaceChildren();
    appendRequestCopy(request, request.inputSpec);
    const callout = element("section", { className: "ui-callout", role: "status" });
    callout.append(element("h2", {}, host.safeText(contract.question?.question) || "Continue in chat"));
    callout.append(element("p", {}, "Answer this long-form question in the conversation. Your response will stay in chat until you choose to send it."));
    form.append(callout);
    form.dataset.formKind = "chat-answer";
    form.dataset.answerPhase = "answer";
    form.hidden = false;
  }

  function normalizedCopy(value: unknown): string {
    return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function appendRequestCopy(request: HumanRequest, spec: InputSpec | null | undefined): void {
    const presentation = host.humanPresentation(request);
    const questionCopies = new Set(questionCopyValues(spec).map(normalizedCopy));
    const candidateHeading = typeof request.title === "string" ? request.title.trim() : "";
    const askingQuestion = inputSpecSupported(spec);
    const heading = presentation || askingQuestion || questionCopies.has(normalizedCopy(candidateHeading))
      ? ""
      : candidateHeading;
    const descriptions: string[] = [];
    const seen = new Set([normalizedCopy(heading), ...questionCopies]);
    if (presentation) {
      seen.add(normalizedCopy(host.safeText(request.title)));
      seen.add(normalizedCopy(presentation.question));
      seen.add(normalizedCopy(presentation.summary));
    }
    for (const value of [request.description, request.prompt]) {
      if (typeof value !== "string" || !value.trim()) continue;
      const copy = value.trim();
      const normalized = normalizedCopy(copy);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      descriptions.push(copy);
    }
    if (!heading && !descriptions.length) return;
    const copy = element("div", { className: "request-copy" });
    if (heading) copy.append(element("h2", {}, heading));
    for (const description of descriptions) copy.append(element("p", {}, description));
    form.append(copy);
  }

  function initialQuestionAnswer(initial: unknown, questionId: string, batch: boolean): QuestionAnswer {
    const initialValue = objectValue(initial);
    if (!initialValue) return {};
    if (!batch) return initialValue;
    const answers = Array.isArray(initialValue.answers) ? initialValue.answers : [];
    return answerValue(answers.find((answer) => String(objectValue(answer)?.questionId) === questionId));
  }

  function requiredAnswer(schema: JsonSchema, inputType: string, batch: boolean): boolean {
    if (batch) return true;
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    return required.has(inputType === "checkbox" ? "values" : "value");
  }

  function setChoiceName(control: HTMLInputElement, questionIndex: number): HTMLInputElement {
    control.name = `question-${questionIndex}`;
    return control;
  }

  function appendOtherControl(stack: HTMLElement, fieldset: HTMLFieldSetElement, inputType: "radio" | "checkbox", questionIndex: number, spec: InputQuestion, answer: QuestionAnswer): void {
    if (spec.allowOther === false) return;
    const choiceId = `question-${questionIndex}-other-choice`;
    const entryId = `question-${questionIndex}-other-entry`;
    const selected = inputType === "checkbox"
      ? Array.isArray(answer.values) && answer.values.includes("other")
      : answer.value === "other";
    const label = element("label", { className: "choice", htmlFor: choiceId });
    const choice = setChoiceName(element("input", {
      id: choiceId,
      type: inputType,
      value: "other",
      checked: selected,
      dataset: { option: "other" },
    }), questionIndex);
    label.append(choice, element("span", {}, spec.otherLabel || "Other"));
    const entry = element("div", { className: "other-entry", id: entryId, hidden: !selected });
    const otherLabel = element("label", { htmlFor: `question-${questionIndex}-other-text` }, "Describe your answer");
    const otherInput = element("input", {
      id: `question-${questionIndex}-other-text`, type: "text",
      value: typeof answer.otherText === "string" ? answer.otherText : "", autocomplete: "off",
      dataset: { otherText: "true" },
    });
    entry.append(otherLabel, otherInput);
    choice.addEventListener("change", () => {
      const active = inputType === "checkbox" ? choice.checked : true;
      entry.hidden = !active;
      if (active) otherInput.focus();
    });
    fieldset.addEventListener("change", () => {
      const otherSelected = Boolean(fieldset.querySelector('[data-option="other"]:checked'));
      entry.hidden = !otherSelected;
      if (!otherSelected) otherInput.removeAttribute("aria-invalid");
    });
    stack.append(label, entry);
  }

  function renderQuestion(
    spec: InputQuestion,
    schema: JsonSchema,
    initial: unknown,
    questionIndex: number,
    batch: boolean,
    helperText: string | undefined,
    acceptanceLabels: boolean,
  ): QuestionMetadata {
    const questionId = String(spec.id || `question_${questionIndex + 1}`);
    const normalized = normalizeInputType(spec.inputType);
    if (![...SUPPORTED_INLINE_TYPES, "long_text"].includes(normalized)) throw new Error(`Unsupported question type: ${normalized}`);
    const inputType = normalized as SupportedInputType;
    const answer = initialQuestionAnswer(initial, questionId, batch);
    const required = requiredAnswer(schema, inputType, batch);
    const errorId = `question-${questionIndex}-error`;
    const legendId = `question-${questionIndex}-legend`;
    const fieldset = element("fieldset", {
      className: batch ? "" : "single-question",
      dataset: { questionId, inputType, required: String(required), errorId },
      "aria-describedby": errorId,
    });
    const question = typeof spec.question === "string" ? spec.question : "";
    const legend = element("legend", { id: legendId, className: "sr-only" }, question);
    const heading = element("div", { className: "question-heading", role: "heading", "aria-level": "2" }, question);
    if (required) heading.append(" ", element("span", { className: "required-mark", "aria-hidden": "true" }, "*"));
    fieldset.append(legend, heading);
    const stack = element("div", { className: "control-stack" });

    if (inputType === "text" || inputType === "long_text" || inputType === "date") {
      const labelId = `question-${questionIndex}-control-label`;
      const hintId = inputType === "date" ? `question-${questionIndex}-hint` : undefined;
      const label = element("label", { id: labelId, className: "field-label", htmlFor: `question-${questionIndex}-value` });
      label.append(element("span", { className: "sr-only" }, inputType === "date" ? "Date" : "Your answer"));
      const control = element(inputType === "long_text" ? "textarea" : "input", {
        id: `question-${questionIndex}-value`, "aria-labelledby": `${legendId} ${labelId}`,
        "aria-describedby": [hintId, errorId].filter(Boolean).join(" "),
        type: inputType === "long_text" ? undefined : inputType === "date" ? "date" : "text",
        value: typeof answer.value === "string" ? answer.value : "", placeholder: inputType === "date" ? "YYYY-MM-DD" : "",
        inputMode: inputType === "date" ? "numeric" : undefined, pattern: inputType === "date" ? "[0-9]{4}-[0-9]{2}-[0-9]{2}" : undefined,
        autocomplete: "off", dataset: { value: "true" },
      });
      label.append(control);
      stack.append(label);
      if (inputType === "date") stack.append(element("p", { id: hintId, className: "hint" }, "Choose a calendar date."));
    } else if (inputType === "boolean") {
      const booleanLabels = acceptanceLabels
        ? [{ value: "true", label: "Accept" }, { value: "false", label: "Request changes" }]
        : [{ value: "true", label: "Yes" }, { value: "false", label: "No" }];
      for (const option of booleanLabels) {
        const id = `question-${questionIndex}-${option.value}`;
        const label = element("label", { className: "choice", htmlFor: id });
        const selected = typeof answer.value === "boolean" && String(answer.value) === option.value;
        label.append(setChoiceName(element("input", { id, type: "radio", value: option.value, checked: selected }), questionIndex), element("span", {}, option.label));
        stack.append(label);
      }
    } else if (inputType === "rating") {
      const minimum = Number.isSafeInteger(spec.minimum) ? spec.minimum as number : 1;
      const maximum = Number.isSafeInteger(spec.maximum) && (spec.maximum as number) >= minimum ? spec.maximum as number : 5;
      fieldset.dataset.minimum = String(minimum);
      fieldset.dataset.maximum = String(maximum);
      const span = maximum - minimum + 1;
      if (span <= 20) {
        const choices = element("div", { className: "rating-options", role: "radiogroup", "aria-labelledby": legendId, "aria-describedby": errorId });
        for (let value = minimum; value <= maximum; value += 1) {
          const id = `question-${questionIndex}-rating-${value}`;
          const label = element("label", { className: "rating-choice", htmlFor: id });
          label.append(setChoiceName(element("input", { id, type: "radio", value: String(value), checked: answer.value === value }), questionIndex), element("span", {}, String(value)));
          choices.append(label);
        }
        stack.append(choices);
      } else {
        const labelId = `question-${questionIndex}-control-label`;
        const label = element("label", { id: labelId, className: "field-label", htmlFor: `question-${questionIndex}-value` }, `Rating (${minimum} to ${maximum})`);
        label.append(element("input", {
          id: `question-${questionIndex}-value`, type: "number", min: String(minimum), max: String(maximum), step: "1",
          value: Number.isSafeInteger(answer.value) ? String(answer.value) : "", dataset: { value: "true" },
          "aria-labelledby": `${legendId} ${labelId}`, "aria-describedby": errorId,
        }));
        stack.append(label);
      }
    } else {
      for (const [optionIndex, option] of (Array.isArray(spec.options) ? spec.options : []).entries()) {
        const idValue = optionId(option);
        const renderedOptionId = idValue || `option_${optionIndex + 1}`;
        const renderedOptionLabel = optionLabel(option) || renderedOptionId;
        const id = `question-${questionIndex}-option-${optionIndex}`;
        const selected = inputType === "checkbox"
          ? Array.isArray(answer.values) && answer.values.includes(renderedOptionId)
          : answer.value === renderedOptionId;
        const label = element("label", { className: "choice", htmlFor: id });
        label.append(setChoiceName(element("input", {
          id, type: inputType, value: renderedOptionId, checked: selected, dataset: { option: renderedOptionId },
        }), questionIndex), element("span", {}, renderedOptionLabel));
        stack.append(label);
      }
      appendOtherControl(stack, fieldset, inputType, questionIndex, spec, answer);
    }
    const helper = host.safeText(helperText)
      ? element("p", { id: `question-${questionIndex}-helper`, className: "hint" }, host.safeText(helperText))
      : null;
    if (helper) {
      for (const control of stack.querySelectorAll<FormControl>("input, textarea, select")) {
        const descriptions = new Set(String(control.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
        descriptions.add(helper.id);
        control.setAttribute("aria-describedby", [...descriptions].join(" "));
      }
    }
    const error = element("p", { id: errorId, className: "field-error", role: "alert", hidden: true, dataset: { fieldError: "true" } });
    fieldset.append(stack, ...(helper ? [helper] : []), error);
    form.append(fieldset);
    return { question: spec, inputType, acceptanceLabels };
  }

  function requestNodeId(request: HumanRequest | undefined): string | undefined {
    return host.safeText(objectValue(request?.node)?.id, 128);
  }

  function questionForm(spec: InputSpec, schema: JsonSchema, initial: unknown, request: HumanRequest = EMPTY_REQUEST): void {
    form.replaceChildren();
    const batch = spec.collectionMode === "batch" || Array.isArray(spec.questions);
    const questions = batch ? spec.questions : [spec];
    if (!Array.isArray(questions) || !questions.length) throw new Error("This question form has no questions.");
    appendRequestCopy(request, spec);
    const presentation = host.humanPresentation(request);
    const acceptance = presentation?.kind === "review" && questions.length === 1 &&
      normalizeInputType(questions[0]?.inputType || spec.inputType) === "boolean";
    const clarificationHelper = questions.length === 1 && presentation?.kind === "clarification"
      ? host.safeText(presentation.summary)
      : undefined;
    const normalizedQuestions = questions.map((question) => {
      const id = batch ? question.id : (requestNodeId(request) || "answer");
      const inputType = question.inputType || spec.inputType;
      return {
        ...question,
        ...(id === undefined ? {} : { id }),
        ...(inputType === undefined ? {} : { inputType }),
      };
    });
    questionMetadata = normalizedQuestions.map((question, index) => renderQuestion(question, schema, initial ?? {}, index, batch, clarificationHelper, acceptance));
    if (questions.length > 1) {
      const stepper = element("nav", { className: "question-stepper", "aria-label": "Question navigation" });
      const previous = element("button", { type: "button", className: "secondary" }, "Previous question");
      const position = element("output", { "aria-live": "polite" });
      const next = element("button", { type: "button", className: "secondary" }, "Next question");
      host.setAction(previous, "Previous question", "back");
      host.setAction(next, "Next question", "next");
      previous.addEventListener("click", () => {
        showQuestionStep(Number(form.dataset.questionIndex || 0) - 1, true);
        host.saveReviewNavigation();
      });
      next.addEventListener("click", () => {
        const index = Number(form.dataset.questionIndex || 0);
        if (next.dataset.answerIntent === "review") {
          try { openAnswerReview(); } catch (error) { host.setError(error); }
          return;
        }
        const fieldset = form.querySelectorAll<HTMLFieldSetElement>("fieldset[data-question-id]")[index];
        if (!fieldset) return;
        try {
          clearQuestionErrors(fieldset);
          collectQuestion(fieldset);
          summary.classList.remove("error");
          summary.setAttribute("role", "status");
          summary.textContent = "";
          showQuestionStep(index + 1, true);
          host.saveReviewNavigation();
        } catch (error) { host.setError(error); }
      });
      stepper.append(previous, position, next);
      form.append(stepper);
    }
    form.dataset.formKind = "questions";
    form.dataset.collectionMode = batch ? "batch" : "single";
    form.dataset.answerPhase = "answer";
    form.hidden = false;
    showQuestionStep(0, false);
  }

  function typedForm(schema: JsonSchema | null | undefined, initial: unknown, spec?: InputSpec | null, request: HumanRequest = EMPTY_REQUEST): boolean {
    form.replaceChildren();
    questionMetadata = [];
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      form.append(element("p", { className: "notice error", role: "alert" }, "This form is missing its response schema. Continue in the conversation to provide your answer."));
      form.dataset.formKind = "unsupported";
      form.hidden = false;
      host.setError(new Error("This form is missing its response schema. Continue in the conversation to provide your answer."));
      return false;
    }
    const answerRoute = answerChannelResolution(spec, request);
    if (answerRoute.channelError) {
      form.append(element("p", { className: "notice error", role: "alert" }, answerRoute.channelError));
      form.dataset.formKind = "invalid-questions";
      form.hidden = false;
      host.setError(new Error(answerRoute.channelError));
      return false;
    }
    const longText = longTextQuestionContract(spec, request);
    if (longText) {
      if (longText.channelError) {
        form.replaceChildren();
        appendRequestCopy(request, spec);
        form.append(element("p", { className: "notice error", role: "alert" }, longText.channelError));
        form.dataset.formKind = "invalid-questions";
        form.hidden = false;
        host.setError(new Error(longText.channelError));
        return false;
      }
      if (longText.valid && longText.answerChannel === "chat") {
        renderLongTextHandoff(request, longText);
        return false;
      }
      form.replaceChildren();
      appendRequestCopy(request, spec);
      const message = longText.valid
        ? "This long-form answer must be collected in the conversation. Continue in chat to answer it."
        : "Long-form questions cannot be mixed into an inline batch. Continue in the conversation to answer this request.";
      form.append(element("p", { className: "notice error", role: "alert" }, message));
      form.dataset.formKind = "invalid-questions";
      form.hidden = false;
      host.setError(new Error(message));
      return false;
    }
    if (inputSpecSupported(spec)) {
      questionForm(spec as InputSpec, schema, initial, request);
      return true;
    }
    if (spec && typeof spec === "object" && Object.keys(spec).length) {
      form.replaceChildren();
      appendRequestCopy(request, spec);
      form.append(element("p", { className: "notice error", role: "alert" }, "This question cannot be displayed here. Continue in the conversation for help with this request."));
      form.dataset.formKind = "invalid-questions";
      form.hidden = false;
      host.setError(new Error("This question cannot be displayed here. Continue in the conversation for help with this request."));
      return false;
    }
    form.replaceChildren();
    appendRequestCopy(request, spec);
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : null;
    const supported = properties && Object.values(properties).every((field) =>
      field && typeof field === "object" && (Array.isArray(field.enum) || ["string", "boolean", "integer", "number"].includes(String(field.type)))
    );
    if (!properties || !supported) {
      form.append(element("p", { className: "notice", role: "status" }, "This form cannot be displayed here. Continue in the conversation to provide your answer."));
      form.dataset.formKind = "unsupported";
      form.hidden = false;
      return false;
    }
    form.dataset.formKind = "generic";
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [name, field] of Object.entries(properties)) {
      const label = document.createElement("label");
      label.className = "field-label";
      label.htmlFor = `schema-${name}`;
      label.textContent = host.mode() === "monitor" && name === "reason" ? "Cancellation reason" : name.replaceAll("_", " ");
      let control: HTMLInputElement | HTMLSelectElement;
      if (Array.isArray(field.enum)) {
        control = document.createElement("select");
        control.append(element("option", { value: "", disabled: true }, "Choose an option"));
        for (const optionValue of field.enum) {
          const option = document.createElement("option");
          option.value = String(optionValue);
          option.textContent = String(optionValue);
          control.append(option);
        }
      } else if (field.type === "boolean") {
        control = document.createElement("select");
        control.append(element("option", { value: "", disabled: true }, "Choose yes or no"));
        for (const [value, bool] of [["true", "Yes"], ["false", "No"]] as const) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = bool;
          control.append(option);
        }
      } else {
        control = document.createElement("input");
        control.type = field.type === "integer" || field.type === "number" ? "number" : "text";
      }
      control.id = `schema-${name}`;
      control.classList.add("input-field");
      control.dataset.field = name;
      control.dataset.type = typeof field.type === "string" ? field.type : "string";
      control.dataset.required = required.has(name) ? "true" : "false";
      const initialValue = objectValue(initial)?.[name];
      if (initialValue !== undefined) control.value = String(initialValue);
      label.append(control);
      form.append(label);
    }
    form.dataset.formKind = "schema";
    form.dataset.answerPhase = "answer";
    form.hidden = false;
    return true;
  }

  function clearQuestionErrors(target?: HTMLFieldSetElement): void {
    const fieldsets = target ? [target] : [...form.querySelectorAll<HTMLFieldSetElement>("fieldset[data-question-id]")];
    for (const fieldset of fieldsets) {
      for (const control of fieldset.querySelectorAll<FormControl>("input, textarea, select")) control.removeAttribute("aria-invalid");
      const error = fieldset.querySelector<HTMLElement>("[data-field-error]");
      if (error) { error.hidden = true; error.textContent = ""; }
    }
  }

  function showQuestionStep(index: number, focus: boolean): void {
    const fields = [...form.querySelectorAll<HTMLFieldSetElement>("fieldset[data-question-id]")];
    if (!fields.length) return;
    const current = Math.max(0, Math.min(index, fields.length - 1));
    form.dataset.questionIndex = String(current);
    fields.forEach((fieldset, fieldIndex) => { fieldset.hidden = fieldIndex !== current; });
    const stepper = form.querySelector<HTMLElement>(".question-stepper");
    if (stepper) {
      stepper.hidden = false;
      const previous = stepper.children[0];
      const position = stepper.children[1];
      const next = stepper.children[2];
      if (!(previous instanceof HTMLButtonElement) || !(position instanceof HTMLOutputElement) || !(next instanceof HTMLButtonElement)) return;
      previous.disabled = current === 0;
      const reviewing = current === fields.length - 1;
      setAnswerAction(next, reviewing ? "review" : "next", reviewing ? answerActionLabel("Review") : "Next question");
      next.disabled = reviewing && (!host.connected() || host.authoritativeStateStale());
      position.textContent = `Question ${current + 1} of ${fields.length}`;
      primary.hidden = true;
      primary.disabled = true;
    }
    if (focus) fields[current]?.querySelector<FormControl>("input, textarea, select")?.focus();
  }

  async function autoAdvanceChoice(control: HTMLInputElement): Promise<void> {
    if (form.dataset.formKind !== "questions" || form.dataset.collectionMode !== "batch" || form.dataset.answerPhase !== "answer") return;
    const fieldset = control.closest<HTMLFieldSetElement>("fieldset[data-question-id]");
    if (!fieldset || control.type !== "radio" || control.dataset.option === "other") return;
    const inputType = fieldset.dataset.inputType;
    if (!inputType || !["boolean", "radio", "rating"].includes(inputType) || form.dataset.autoAdvancing === "true") return;
    form.dataset.autoAdvancing = "true";
    try {
      const fields = [...form.querySelectorAll<HTMLFieldSetElement>("fieldset[data-question-id]")];
      const index = fields.indexOf(fieldset);
      if (index < 0) return;
      if (index === fields.length - 1) openAnswerReview();
      else {
        showQuestionStep(index + 1, true);
        host.saveReviewNavigation();
      }
    } catch (error) { host.setError(error); }
    finally { delete form.dataset.autoAdvancing; }
  }

  function answerActionLabel(action: string): string {
    const count = form.querySelectorAll("fieldset[data-question-id]").length || form.querySelectorAll("[data-field]").length;
    return `${action} ${count === 1 ? "answer" : "answers"}`;
  }

  function hidePersistentBatchReview(): void {
    if (form.dataset.formKind !== "questions" || form.dataset.collectionMode !== "batch" || form.dataset.answerPhase === "review" || !form.querySelector(".question-stepper")) return;
    primary.hidden = true;
    primary.disabled = true;
  }

  function formatAnswerText(question: InputQuestion, answerInput: unknown, acceptanceLabels: boolean): string {
    const answer = answerValue(answerInput);
    const inputType = normalizeInputType(question.inputType);
    if (inputType === "boolean" && typeof answer.value === "boolean") {
      if (acceptanceLabels) return answer.value ? "Accept" : "Request changes";
      return answer.value ? "Yes" : "No";
    }
    if (inputType === "radio") {
      if (answer.value === "other") return typeof answer.otherText === "string" && answer.otherText ? `${question.otherLabel || "Other"}: ${answer.otherText}` : question.otherLabel || "Other";
      const options = Array.isArray(question.options) ? question.options : [];
      const option = options.find((candidate) => optionId(candidate) === answer.value);
      return host.safeText(optionLabel(option)) || host.safeText(answer.value) || "No answer";
    }
    if (inputType === "checkbox") {
      const labels = (Array.isArray(answer.values) ? answer.values : []).map((value) => {
        if (value === "other") return typeof answer.otherText === "string" && answer.otherText ? `${question.otherLabel || "Other"}: ${answer.otherText}` : question.otherLabel || "Other";
        const options = Array.isArray(question.options) ? question.options : [];
        const option = options.find((candidate) => optionId(candidate) === value);
        return host.safeText(optionLabel(option)) || host.safeText(value);
      }).filter((value): value is string => Boolean(value));
      return labels.length ? labels.join(", ") : "No answer";
    }
    return answer.value === undefined || answer.value === "" ? "No answer" : String(answer.value);
  }

  function answerText(question: InputQuestion, answerInput: unknown): string {
    return formatAnswerText(question, answerInput, Boolean(objectValue(question)?.acceptanceLabels));
  }

  function submittedAnswerReview(request: HumanRequest, answerInput: unknown = request.answer): HTMLElement {
    const spec = request.inputSpec && typeof request.inputSpec === "object" ? request.inputSpec : EMPTY_REQUEST;
    const questions = Array.isArray(spec.questions) ? spec.questions : [spec];
    const acceptanceReview = host.humanPresentation(request)?.kind === "review" && questions.length === 1 &&
      normalizeInputType(questions[0]?.inputType || spec.inputType) === "boolean";
    const answerRecord = objectValue(answerInput);
    const answers = Array.isArray(answerRecord?.answers) ? answerRecord.answers : null;
    const review = element("section", { className: "answer-review accepted-answer-review", "aria-label": "Submitted answers" });
    const heading = element("div", { className: "answer-review-heading" });
    heading.append(element("h2", { "aria-live": "polite" }, "Submitted answers"));
    const submittedAt = host.formatDateTime(request.answeredAt);
    if (submittedAt) heading.append(element("p", { className: "ui-caption" }, `Submitted ${submittedAt}`));
    review.append(heading);
    const list = element("dl", { className: "answer-review-list" });
    for (const [index, question] of questions.entries()) {
      if (!question || typeof question !== "object") continue;
      const questionId = String(question.id || `question_${index + 1}`);
      const value = answers ? answers.find((item) => String(objectValue(item)?.questionId) === questionId) : answerInput;
      const item = createAnswerReviewItem(host.safeText(question.question) || "Answer", formatAnswerText(question, value ?? {}, acceptanceReview));
      list.append(item);
    }
    if (!list.childElementCount && answerInput !== undefined) {
      const item = createAnswerReviewItem("Response", host.reviewValue(answerInput));
      list.append(item);
    }
    review.append(list);
    return review;
  }

  function exitAnswerReview(index = Number(form.dataset.questionIndex || 0)): void {
    host.onRender();
    form.querySelector(".answer-review")?.remove();
    form.dataset.answerPhase = "answer";
    if (form.dataset.formKind === "questions") showQuestionStep(index, true);
    else for (const control of form.querySelectorAll<FormControl>("[data-field]")) control.closest("label")?.removeAttribute("hidden");
    secondary.hidden = true;
    secondary.disabled = true;
    if (form.dataset.formKind === "questions" && form.dataset.collectionMode === "batch") {
      primary.hidden = true;
      primary.disabled = true;
    } else {
      setAnswerAction(primary, "review", answerActionLabel("Review"));
      primary.hidden = false;
      primary.disabled = !host.connected() || host.authoritativeStateStale();
    }
    summary.classList.remove("error");
    summary.setAttribute("role", "status");
    summary.textContent = "";
  }

  function beginAnswerReview(): boolean {
    if (!["questions", "schema"].includes(form.dataset.formKind || "") || form.dataset.answerPhase === "review") return false;
    const answer = collectAnswer();
    host.onRender();
    const review = element("section", { className: "answer-review", "aria-label": "Answer preview" });
    const heading = element("div", { className: "answer-review-heading" });
    const previewHeading = element("h2", { tabIndex: -1 }, "Answer preview");
    heading.append(previewHeading, element("p", { className: "ui-caption" }, "Check each answer before sending it."));
    const list = element("dl", { className: "answer-review-list" });
    if (form.dataset.formKind === "questions") {
      const fields = [...form.querySelectorAll<HTMLFieldSetElement>("fieldset[data-question-id]")];
      const rawAnswers = form.dataset.collectionMode === "batch" ? answer.answers : [answer];
      const answers = Array.isArray(rawAnswers) ? rawAnswers : [];
      fields.forEach((fieldset) => { fieldset.hidden = true; });
      form.querySelector<HTMLElement>(".question-stepper")?.setAttribute("hidden", "");
      questionMetadata.forEach((metadata, index) => {
        const item = createAnswerReviewItem(host.safeText(metadata.question.question) || "Answer", formatAnswerText(metadata.question, answers[index] ?? {}, metadata.acceptanceLabels));
        item.dataset.questionId = fieldsetQuestionId(fields[index]);
        const edit = element("button", { type: "button", className: "secondary" }, `Edit answer ${index + 1}`);
        host.setAction(edit, `Edit answer ${index + 1}`, "edit");
        edit.addEventListener("click", () => exitAnswerReview(index));
        item.append(edit);
        list.append(item);
      });
    } else {
      const controls = [...form.querySelectorAll<FormControl>("[data-field]")];
      controls.forEach((control) => control.closest("label")?.setAttribute("hidden", ""));
      for (const control of controls) {
        const field = control.dataset.field || "";
        const item = createAnswerReviewItem(field.replaceAll("_", " "), answer[field] === undefined ? "No answer" : String(answer[field]));
        list.append(item);
      }
    }
    review.append(heading, list);
    form.append(review);
    form.dataset.answerPhase = "review";
    setAnswerAction(secondary, "back", "Back to answers");
    secondary.hidden = false;
    secondary.disabled = false;
    setAnswerAction(primary, "submit", answerActionLabel("Submit"), true);
    primary.hidden = false;
    primary.disabled = !host.connected() || host.authoritativeStateStale();
    summary.classList.remove("error");
    summary.setAttribute("role", "status");
    summary.textContent = "";
    previewHeading.focus({ preventScroll: true });
    return true;
  }

  function openAnswerReview(): boolean {
    if (!beginAnswerReview()) throw new Error("The answer preview could not be opened.");
    host.saveReviewNavigation();
    return true;
  }

  function fieldsetQuestionId(fieldset: HTMLFieldSetElement | null | undefined): string {
    return fieldset?.dataset.questionId || "";
  }

  function questionError(fieldset: HTMLFieldSetElement, message: string, target?: FormControl | null): never {
    const error = fieldset.querySelector<HTMLElement>("[data-field-error]");
    if (error) { error.textContent = message; error.hidden = false; }
    const focusTarget = target || fieldset.querySelector<FormControl>("input, textarea, select");
    if (focusTarget) {
      focusTarget.setAttribute("aria-invalid", "true");
      focusTarget.focus();
    }
    throw new Error(message);
  }

  function collectQuestion(fieldset: HTMLFieldSetElement): JsonObject {
    const type = fieldset.dataset.inputType || "";
    const required = fieldset.dataset.required === "true";
    if (["text", "long_text", "date"].includes(type)) {
      const control = fieldset.querySelector<FormControl>("[data-value]");
      const value = control?.value || "";
      if (required && !value.trim()) questionError(fieldset, "Answer this question.", control);
      if (type === "date" && value && !validDate(value)) questionError(fieldset, "Enter a real date in YYYY-MM-DD format.", control);
      return value === "" && !required ? {} : { value };
    }
    if (type === "boolean") {
      const selected = fieldset.querySelector<HTMLInputElement>('input[type="radio"]:checked');
      if (!selected && required) questionError(fieldset, "Choose Yes or No.");
      return selected ? { value: selected.value === "true" } : {};
    }
    if (type === "rating") {
      const control = fieldset.querySelector<HTMLInputElement>('input[type="radio"]:checked, [data-value]');
      const raw = control?.value || "";
      if (!raw && required) questionError(fieldset, "Choose a rating.");
      if (!raw) return {};
      const value = Number(raw);
      const minimum = Number(fieldset.dataset.minimum);
      const maximum = Number(fieldset.dataset.maximum);
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) questionError(fieldset, `Enter a whole number from ${minimum} to ${maximum}.`, control);
      return { value };
    }
    if (type === "radio") {
      const selected = fieldset.querySelector<HTMLInputElement>('input[type="radio"]:checked');
      if (!selected && required) questionError(fieldset, "Choose one option.");
      if (!selected) return {};
      const answer: JsonObject = { value: selected.value };
      if (selected.value === "other") {
        const other = fieldset.querySelector<HTMLInputElement>("[data-other-text]");
        if (!other || !other.value.trim()) questionError(fieldset, "Describe the Other option.", other);
        answer.otherText = other.value;
      }
      return answer;
    }
    const selected = [...fieldset.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')];
    if (!selected.length && required) questionError(fieldset, "Choose at least one option.");
    if (!selected.length) return {};
    const answer: JsonObject = { values: selected.map((control) => control.value) };
    if ((answer.values as string[]).includes("other")) {
      const other = fieldset.querySelector<HTMLInputElement>("[data-other-text]");
      if (!other || !other.value.trim()) questionError(fieldset, "Describe the Other option.", other);
      answer.otherText = other.value;
    }
    return answer;
  }

  function collectAnswer(): JsonObject {
    if (["unsupported", "invalid-questions"].includes(form.dataset.formKind || "")) {
      throw new Error("This form cannot be displayed here. Continue in the conversation to provide your answer.");
    }
    const questionFields = [...form.querySelectorAll<HTMLFieldSetElement>("fieldset[data-question-id]")];
    if (questionFields.length) {
      clearQuestionErrors();
      const batch = form.dataset.collectionMode === "batch";
      const answers: JsonObject[] = [];
      for (const [index, fieldset] of questionFields.entries()) {
        try { answers.push({ questionId: fieldset.dataset.questionId, ...collectQuestion(fieldset) }); }
        catch (error) { showQuestionStep(index, false); throw error; }
      }
      if (batch) return { answers };
      const first = answers[0] ?? {};
      const { questionId: _questionId, ...answer } = first;
      return answer;
    }
    const answer: JsonObject = {};
    for (const control of form.querySelectorAll<FormControl>("[data-field]")) {
      const field = control.dataset.field || "";
      const type = control.dataset.type;
      const required = control.dataset.required === "true";
      if (control.value === "" && !required) continue;
      if (control.value === "" && required) throw new Error(`Enter ${field}.`);
      if (type === "boolean") answer[field] = control.value === "true";
      else if (type === "integer") answer[field] = Number.parseInt(control.value, 10);
      else if (type === "number") answer[field] = Number(control.value);
      else answer[field] = control.value;
    }
    return answer;
  }

  function questionAnswersById(): JsonObject {
    const answers: JsonObject = {};
    for (const fieldset of form.querySelectorAll<HTMLFieldSetElement>("fieldset[data-question-id]")) {
      const questionId = fieldsetQuestionId(fieldset);
      if (!questionId) continue;
      const type = fieldset.dataset.inputType;
      let answer: JsonObject = {};
      if (["text", "long_text", "date"].includes(type || "")) {
        const control = fieldset.querySelector<FormControl>("[data-value]");
        if (control && control.value !== "") answer = { value: control.value };
      } else if (type === "boolean") {
        const selected = fieldset.querySelector<HTMLInputElement>('input[type="radio"]:checked');
        if (selected) answer = { value: selected.value === "true" };
      } else if (type === "rating") {
        const selected = fieldset.querySelector<HTMLInputElement>('input[type="radio"]:checked, [data-value]');
        if (selected && selected.value !== "") {
          const value = Number(selected.value);
          answer = Number.isSafeInteger(value) ? { value } : { value: selected.value };
        }
      } else if (type === "radio") {
        const selected = fieldset.querySelector<HTMLInputElement>('input[type="radio"]:checked');
        if (selected) {
          answer = { value: selected.value };
          if (selected.value === "other") answer.otherText = fieldset.querySelector<HTMLInputElement>("[data-other-text]")?.value || "";
        }
      } else if (type === "checkbox") {
        const selected = [...fieldset.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')];
        if (selected.length) {
          const values = selected.map((control) => control.value);
          answer = { values };
          if (values.includes("other")) answer.otherText = fieldset.querySelector<HTMLInputElement>("[data-other-text]")?.value || "";
        }
      }
      answers[questionId] = answer;
    }
    return answers;
  }

  function restoreQuestionAnswers(answersInput: unknown): void {
    const answers = objectValue(answersInput);
    if (!answers) return;
    for (const fieldset of form.querySelectorAll<HTMLFieldSetElement>("fieldset[data-question-id]")) {
      const answer = answerValue(answers[fieldsetQuestionId(fieldset)]);
      if (!Object.keys(answer).length) continue;
      const type = fieldset.dataset.inputType;
      if (["text", "long_text", "date"].includes(type || "")) {
        const control = fieldset.querySelector<FormControl>("[data-value]");
        if (control && typeof answer.value === "string") control.value = answer.value;
      } else if (type === "boolean") {
        const value = typeof answer.value === "boolean" ? String(answer.value) : "";
        const control = [...fieldset.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((candidate) => candidate.value === value);
        if (control) control.checked = true;
      } else if (type === "rating") {
        const control = [...fieldset.querySelectorAll<HTMLInputElement>('input[type="radio"], [data-value]')].find((candidate) => candidate.value === String(answer.value));
        if (control) { if (control.type === "radio") control.checked = true; else control.value = String(answer.value); }
      } else if (type === "radio") {
        const control = [...fieldset.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((candidate) => candidate.value === answer.value);
        if (control) control.checked = true;
      } else if (type === "checkbox" && Array.isArray(answer.values)) {
        for (const control of fieldset.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) control.checked = answer.values.includes(control.value);
      }
      if (typeof answer.otherText === "string") {
        const other = fieldset.querySelector<HTMLInputElement>("[data-other-text]");
        if (other) other.value = answer.otherText;
      }
      fieldset.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function visibleQuestionId(): string | null {
    return fieldsetQuestionId(form.querySelector<HTMLFieldSetElement>('fieldset[data-question-id]:not([hidden])')) || null;
  }

  function scheduleFormPersistence(): void {
    if (!host.persistenceReady()) return;
    host.markViewDirty();
    host.scheduleInteractionDraft();
  }

  function eventControl(target: EventTarget | null): FormControl | null {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ? target : null;
  }

  function onInput(event: Event): void {
    if (event.isTrusted && eventControl(event.target)) scheduleFormPersistence();
  }

  function onChange(event: Event): void {
    if (event.isTrusted && eventControl(event.target)) scheduleFormPersistence();
  }

  function onClick(event: MouseEvent): void {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLInputElement>('fieldset[data-question-id] input[type="radio"]');
    if (!control) return;
    if (lastRadioNavigationKey && document.activeElement === control) {
      lastRadioNavigationKey = null;
      return;
    }
    lastRadioNavigationKey = null;
    void autoAdvanceChoice(control);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLInputElement>('fieldset[data-question-id] input[type="radio"]');
    if (!control) return;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      lastRadioNavigationKey = event.key;
      if (radioNavigationTimer !== null) clearTimeout(radioNavigationTimer);
      radioNavigationTimer = setTimeout(() => { lastRadioNavigationKey = null; radioNavigationTimer = null; }, 0);
      return;
    }
    if (!["Enter", " "].includes(event.key) || control.dataset.option === "other") return;
    event.preventDefault();
    control.checked = true;
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    void autoAdvanceChoice(control);
  }

  function attach(): void {
    if (attached) return;
    attached = true;
    document.addEventListener("input", onInput);
    document.addEventListener("change", onChange);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeydown);
  }

  function dispose(): void {
    if (!attached) return;
    attached = false;
    document.removeEventListener("input", onInput);
    document.removeEventListener("change", onChange);
    document.removeEventListener("click", onClick);
    document.removeEventListener("keydown", onKeydown);
    if (radioNavigationTimer !== null) clearTimeout(radioNavigationTimer);
    radioNavigationTimer = null;
    lastRadioNavigationKey = null;
    questionMetadata = [];
  }

  return {
    normalizeInputType,
    inputSpecSupported,
    questionCopyValues,
    appendRequestCopy,
    renderLongTextHandoff,
    questionForm,
    typedForm,
    showQuestionStep,
    autoAdvanceChoice,
    hidePersistentBatchReview,
    answerActionLabel,
    answerText,
    submittedAnswerReview,
    exitAnswerReview,
    beginAnswerReview,
    openAnswerReview,
    collectAnswer,
    questionAnswersById,
    restoreQuestionAnswers,
    visibleQuestionId,
    attach,
    dispose,
  };
}
