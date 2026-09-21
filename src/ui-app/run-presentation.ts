import { createUiElement as element } from "./components.js";
import type { HumanRequest, InputSpec, ExecutionProjection, PagedResponse, UiData, JsonSchema, PreparedRun, PreparationPresentation, RpcResult, RunPresentation } from "./page-models.js";
import type { JsonObject } from "./contracts.js";

export interface RunPresentationServices {
  readonly context: HTMLElement;
  questionCopyValues(spec?: InputSpec): string[];
  workflowIdValid(value: unknown): value is string;
}


function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

/** Owns reviewed preparation metadata and the selected domain projections shown in a card. */
export function createRunPresentation(host: RunPresentationServices) {
  const {context, questionCopyValues, workflowIdValid} = host;
  let preparationPresentation: PreparationPresentation | null = null;
  function credentialLikeReviewKey(key: string): boolean {
    const normalized = String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
    return normalized === "password" || normalized === "authorization" ||
      normalized === "credential" || normalized === "credentials" ||
      normalized === "token" || normalized === "key" || normalized.endsWith("secret") ||
      /(?:api|access|refresh|bearer|auth)token$/.test(normalized) ||
      /(?:api|access|private|secret|signing|client)key$/.test(normalized);
  }

  // Render only the deliberately selected review fields, never the transport envelope.
  function reviewValue(value: unknown, key = ""): HTMLElement {
    if (credentialLikeReviewKey(key) || /confirmationkey/i.test(key)) return element("span", {}, "Sensitive value hidden");
    if (value === null || value === undefined) return element("span", {}, "Not specified");
    if (typeof value !== "object") return element("span", {}, typeof value === "boolean" ? (value ? "Yes" : "No") : String(value));
    const entries = Object.entries(value);
    if (!entries.length) return element("span", {}, "None");
    const list = element("dl", { className: "answer-review-list" });
    for (const [key, item] of entries) {
      list.append(element("dt", {}, Array.isArray(value) ? `Item ${Number(key) + 1}` : key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ")));
      const detail = element("dd");
      detail.append(reviewValue(item, key));
      list.append(detail);
    }
    return list;
  }

  function reviewFields(fields: readonly (readonly [string, unknown])[], headingText = "Run status"): void {
    const heading = element("div", { className: "ui-hero" });
    heading.append(element("h2", {}, headingText));
    const list = element("dl", { className: "ui-grid" });
    for (const [label, value] of fields) {
      if (value === undefined) continue;
      const card = element("div", { className: "ui-card" });
      card.append(element("dt", { className: "ui-label" }, label));
      const detail = element("dd", { className: "ui-value" });
      detail.append(reviewValue(value));
      card.append(detail);
      list.append(card);
    }
    context.className = "ui-stack";
    context.replaceChildren(heading, list);
    context.hidden = !list.childElementCount;
  }

  function safeText(value: unknown, maximumLength = 4096): string | undefined {
    return typeof value === "string" && value.trim() && value.trim().length <= maximumLength ? value.trim() : undefined;
  }

  function normalizedCopy(value: unknown): string {
    return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function safeTextList(value: unknown, maximumItems = 50, maximumItemLength = 2048): string[] | undefined {
    return Array.isArray(value) && value.length <= maximumItems && value.every((item) => safeText(item, maximumItemLength))
      ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : undefined;
  }

  function humanPresentation(request?: HumanRequest | null) {
    const presentation = request && request.presentation;
    if (!presentation || presentation.version !== 1 || !presentation.kind || !["review", "clarification", "progress"].includes(presentation.kind)) return undefined;
    const textFields = ["stageLabel", "summary", "question"];
    const listFields = ["changedFiles", "verification", "limitations", "artifacts", "priorRequirements", "decisions", "openQuestions"];
    if (textFields.some((key) => presentation[key] !== undefined && !safeText(presentation[key]))) return undefined;
    if (listFields.some((key) => presentation[key] !== undefined && !safeTextList(presentation[key]))) return undefined;
    return presentation;
  }

  function appendTextList(parent: HTMLElement, label: string, values: unknown, excluded: ReadonlySet<string> = new Set()): number {
    const items = (safeTextList(values) || []).filter((item) => !excluded.has(normalizedCopy(item)));
    if (!items.length) return 0;
    const section = element("section", { className: "ui-section" });
    section.append(element("h3", { className: "ui-label" }, label));
    const list = element("ul", { className: "ui-list" });
    for (const item of items) list.append(element("li", {}, item));
    section.append(list);
    parent.append(section);
    return items.length;
  }

  function renderHumanPresentation(request: HumanRequest, spec?: InputSpec): boolean {
    const presentation = humanPresentation(request);
    if (!presentation) return false;
    const wrapper = element("div", { className: "ui-stack" });
    const questionTexts = new Set(questionCopyValues(spec).map(normalizedCopy));
    if (presentation.kind === "review") {
      const hero = element("div", { className: "ui-hero" });
      hero.append(element("h2", {}, safeText(request && request.title) || "Implementation review"));
      if (safeText(presentation.summary)) hero.append(element("p", { className: "ui-caption" }, safeText(presentation.summary)));
      wrapper.append(hero);
      appendTextList(wrapper, "Changed files", presentation.changedFiles, questionTexts);
      appendTextList(wrapper, "Checks", presentation.verification, questionTexts);
      appendTextList(wrapper, "Limitations", presentation.limitations, questionTexts);
      appendTextList(wrapper, "Artifacts", presentation.artifacts, questionTexts);
      appendTextList(wrapper, "Requirements gathered", presentation.priorRequirements, questionTexts);
      appendTextList(wrapper, "Decisions", presentation.decisions, questionTexts);
      appendTextList(wrapper, "Open questions", presentation.openQuestions, questionTexts);
    }
    context.className = "ui-stack";
    context.replaceChildren(wrapper);
    context.hidden = !wrapper.childElementCount;
    return true;
  }

  function formatStatus(value: unknown): string | undefined {
    const status = safeText(value);
    return status ? status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : undefined;
  }

  function formatDateTime(value: unknown): string | undefined {
    const text = safeText(value);
    if (!text) return undefined;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? undefined : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function formatDuration(startedAt: unknown, endedAt: unknown): string | undefined {
    const started = new Date(typeof startedAt === "string" || typeof startedAt === "number" ? startedAt : "").getTime();
    const ended = typeof endedAt === "string" || typeof endedAt === "number" ? new Date(endedAt).getTime() : Date.now();
    if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return undefined;
    const seconds = Math.floor((ended - started) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  function terminalRun(run: ExecutionProjection): boolean {
    return ["completed", "failed", "canceled", "cancelled", "succeeded", "expired"].includes(String(run && run.status || "").toLowerCase());
  }

  function pagedResponse(output?: UiData | null): PagedResponse | undefined {
    return output && typeof output.responseRef === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(output.responseRef) &&
      output.encoding === "json" && typeof output.sizeBytes === "number" && Number.isSafeInteger(output.sizeBytes) && output.sizeBytes >= 0
      ? { responseRef: output.responseRef, encoding: output.encoding, sizeBytes: output.sizeBytes }
      : undefined;
  }

  // A successful list is only renderable when every row has the identities
  // required by the browser actions. Missing data is not an empty result.
  function workflowPageData(data: UiData): UiData | undefined {
    if (!data || typeof data !== "object" || Array.isArray(data) ||
      !Array.isArray(data.workflows) || (data.nextCursor !== null && typeof data.nextCursor !== "string")) return undefined;
    return data.workflows.every((workflow) => workflow && typeof workflow === "object" && !Array.isArray(workflow) &&
      workflowIdValid(workflow.id) && typeof workflow.name === "string" && workflow.name.trim())
      ? data
      : undefined;
  }

  function workflowRowName(value: unknown): string {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : "Untitled workflow";
  }

  function authoredLabel(key: string, schema?: JsonSchema): string {
    const authored = safeText(schema?.title, 120);
    return authored || key.replaceAll("_", " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  }

  function formatBytes(value: unknown): string | undefined {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function runPresentation(run: ExecutionProjection) {
    const presentation = run && run.result;
    if (!presentation || presentation.version !== 1) return undefined;
    if (presentation.summary !== undefined && !safeText(presentation.summary)) return undefined;
    const listFields = ["changedFiles", "artifacts", "verification", "limitations"];
    if (listFields.some((key) => presentation[key] !== undefined && !safeTextList(presentation[key]))) return undefined;
    return presentation;
  }

  function renderRun(run: ExecutionProjection) {
    const heading = safeText(run.workflowName) || safeText(run.name) || "Workflow run";
    const hero = element("div", { className: "ui-hero" });
    hero.append(element("h2", {}, heading));
    const meta = element("div", { className: "run-meta" });
    const stage = safeText(run.stageLabel);
    const step = safeText(run.currentNodeName);
    if (stage) meta.append(element("span", {}, stage));
    if (step && step !== stage) meta.append(element("span", {}, step));
    const dates = [["Started", formatDateTime(run.startedAt)], ["Completed", formatDateTime(run.completedAt)]].filter(([, value]) => value);
    for (const [label, value] of dates) meta.append(element("span", { className: "ui-caption" }, `${label}: ${value}`));
    if (meta.childElementCount) hero.append(meta);
    context.className = "ui-stack";
    context.replaceChildren(hero);
    context.hidden = false;
    if (safeText(run.lastEvent)) context.append(element("p", { className: "ui-caption" }, safeText(run.lastEvent)));
    if (safeText(run.requiredAction)) context.append(element("p", { className: "ui-callout" }, safeText(run.requiredAction)));
    const wrapper = context.firstElementChild ? context : null;
    const presentation = runPresentation(run);
    if (wrapper && presentation) {
      if (safeText(presentation.summary)) {
        const section = element("section", { className: "ui-section" });
        section.append(element("h3", { className: "ui-label" }, "Result"), element("p", { className: "ui-caption" }, safeText(presentation.summary)));
        context.append(section);
      }
      appendTextList(context, "Changed files", presentation.changedFiles);
      appendTextList(context, "Verification", presentation.verification);
      appendTextList(context, "Limitations", presentation.limitations);
      appendTextList(context, "Artifacts", presentation.artifacts);
    }
  }

  function validPresentation(presentation: unknown): presentation is PreparationPresentation {
    const value = record(presentation);
    const readable = (candidate: unknown): candidate is string => typeof candidate === "string" && candidate.trim().length > 0;
    if (value === null) return false;
    const providers = value.providers;
    return readable(value.workflowName) && readable(value.organizationName) &&
      typeof value.workflowVersion === "number" && Number.isSafeInteger(value.workflowVersion) && value.workflowVersion > 0 &&
      (providers === null || (Array.isArray(providers) && providers.every((provider) => {
        const entry = record(provider);
        return entry !== null && readable(entry.name) && (entry.model === null || readable(entry.model));
      })));
  }

  function presentationMatches(presentation: unknown, output: PreparedRun | UiData): presentation is PreparationPresentation {
    const binding = output.binding || {};
    return validPresentation(presentation) && presentation.schemaVersion === "loomex/preparation-review/v1" && presentation.preparationId === output.preparationId &&
      presentation.bindingDigest === output.bindingDigest &&
      ["workflowId", "versionId", "organizationId"].every((key) => presentation[key] === binding[key]);
  }

  function preparationView(output: PreparedRun | UiData): void {
    const binding = output.binding || {};
    const info: PreparationPresentation = presentationMatches(preparationPresentation, output) ? preparationPresentation : {};
    const review = element("div", { className: "ui-stack" });
    const hero = element("div", { className: "ui-hero" });
    hero.append(element("h2", {}, info.workflowName || "Prepared workflow"));
    const meta = element("div", { className: "ui-meta" });
    meta.append(element("span", { className: "ui-badge" }, Number.isSafeInteger(info.workflowVersion) ? `Version ${info.workflowVersion}` : "Pinned version"));
    meta.append(element("span", {}, info.organizationName || "Organization name unavailable"));
    meta.append(element("span", {}, "This Mac"));
    hero.append(meta);
    review.append(hero);
    const grid = element("div", { className: "ui-grid" });
    const workspace = element("section", { className: "ui-card", "aria-label": "Workspace" });
    workspace.append(element("h3", { className: "ui-label" }, "Workspace"));
    const path = typeof binding.workspacePath === "string" ? binding.workspacePath : "";
    workspace.append(element("p", { className: "ui-value" }, path.split("/").filter(Boolean).at(-1) || "Workspace unavailable"));
    workspace.append(element("p", { className: "workspace-path" }, path));
    if (binding.executionPolicy === "host_user/v1") {
      workspace.append(element("p", { className: "ui-caption" }, "Runs as your macOS user in this workspace."));
      const authority = element("details", { className: "ui-disclosure" });
      authority.append(element("summary", {}, "Execution access"), element("p", { className: "ui-caption" }, "After your review, configured commands run with your user permissions. This is not a sandbox; commands can access other files and services your user can access."));
      workspace.append(authority);
    }
    grid.append(workspace);
    const providers = element("section", { className: "ui-card", "aria-label": "AI providers" });
    providers.append(element("h3", { className: "ui-label" }, "AI providers"));
    const configured = Array.isArray(info.providers) ? info.providers : [];
    const providerNames: Readonly<Record<string, string>> = { codex: "Codex", claude: "Claude", gemini: "Gemini" };
    if (configured.length) {
      for (const provider of configured) {
        const row = element("div", { className: "provider-row" });
        row.append(element("p", { className: "ui-value" }, providerNames[provider.name] || provider.name));
        row.append(element("p", { className: "ui-caption" }, provider.model || "Model selected by workflow"));
        providers.append(row);
      }
    } else if (Array.isArray(info.providers)) {
      providers.append(element("p", { className: "ui-value" }, "No AI steps"));
      providers.append(element("p", { className: "ui-caption" }, "This workflow does not select an AI provider."));
    } else {
      providers.append(element("p", { className: "ui-value" }, "Workflow configuration"));
      providers.append(element("p", { className: "ui-caption" }, "Provider details for this workflow or its referenced workflows are unavailable. Review the workflow configuration in the conversation."));
    }
    const overrides = binding.providerConfiguration && binding.providerConfiguration.requested;
    if (overrides && Object.keys(overrides).length) {
      const overrideSection = element("div", { className: "ui-section" });
      overrideSection.append(element("h4", { className: "ui-label" }, "Run overrides"), reviewValue(overrides));
      providers.append(overrideSection);
    }
    grid.append(providers);
    review.append(grid);
    if (binding.inputs && Object.keys(binding.inputs).length) {
      const inputs = element("section", { className: "ui-section", "aria-label": "Run inputs" });
      inputs.append(element("h3", { className: "ui-label" }, "Run inputs"), reviewValue(binding.inputs));
      review.append(inputs);
    }
    context.replaceChildren(review);
    context.hidden = false;
  }

  function observePreparationReview(result: RpcResult, prepared?: PreparedRun | UiData): void {
    const supplied = result?._meta?.["loomex/preparationReview"];
    if (supplied !== undefined) preparationPresentation = presentationMatches(supplied, prepared || {}) ? supplied : null;
    else if (!presentationMatches(preparationPresentation, prepared || {})) preparationPresentation = null;
  }

  function preparationReviewable(output: PreparedRun | UiData): boolean {
    const binding = output.binding;
    return Boolean(presentationMatches(preparationPresentation, output) && binding && ["organizationId", "installationId", "workflowId", "versionId", "workspacePath"]
      .every((key) => typeof binding[key] === "string" && binding[key].length) &&
      binding.executionPolicy === "host_user/v1" &&
      binding.inputs && typeof binding.inputs === "object" &&
      binding.providerConfiguration && typeof binding.providerConfiguration === "object");
  }

  return {
    credentialLikeReviewKey, reviewValue, reviewFields, safeText, normalizedCopy, safeTextList, humanPresentation, appendTextList, renderHumanPresentation, formatStatus, formatDateTime, formatDuration, terminalRun, pagedResponse, workflowPageData, workflowRowName, authoredLabel, formatBytes, runPresentation, renderRun, validPresentation, presentationMatches, preparationView, observePreparationReview, preparationReviewable,
    get preparationPresentation() { return preparationPresentation; },
    restorePreparationPresentation(value: unknown) { preparationPresentation = validPresentation(value) ? value : null; },
  };
}

/** A sealed preparation may link only its own committed run, never another authoring operation. */
export function committedPreparationRun(data: UiData, preparationId: string): string | undefined {
  return data.status === "stale" && data.reason === "commit_started" &&
    data.operation === "runs.prepare" && data.preparationId === preparationId &&
    typeof data.executionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.executionId)
    ? data.executionId : undefined;
}
