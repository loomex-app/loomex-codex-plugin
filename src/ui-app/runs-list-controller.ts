import type { ViewRestorationCoordinator } from "./persistence.js";
import type { ActionIcon, JsonObject } from "./contracts.js";
import { createPagination, createUiElement as element } from "./components.js";
import type { ActionId } from "./shell.js";
import type { ExecutionProjection, HumanRequest, UiData } from "./page-models.js";
import { formatFollowContinuationMarkdown, formatManualFollowInstruction } from "../monitoring-contract.js";

const RUN_PAGE_SIZE = 5;

export interface RunListArguments { limit: number; cursor?: string; status?: string; workflowId?: string; }
export interface RunListControllerState {
  page: UiData | null;
  args: RunListArguments;
  history: RunListArguments[];
  selected: UiData | null;
  busy: boolean;
  epoch: number;
}

export interface RunListControllerServices {
  readonly lifecycle: ViewRestorationCoordinator;
  readonly elements: { context: HTMLElement; summary: HTMLElement; form: HTMLFormElement; primary: HTMLButtonElement; secondary: HTMLButtonElement; refresh: HTMLButtonElement };
  connected(): boolean;
  authoritativeStateStale(): boolean;
  setAuthoritativeStateStale(value: boolean): void;
  viewPersistenceUnavailable(): boolean;
  flushCurrentPersistence(): Promise<boolean>;
  mutationHydrationReady(): boolean;
  markViewDirty(): void;
  flushViewState(): Promise<void>;
  callTool(name: "loomex_runs_list" | "loomex_run_get", args: JsonObject, renderResult: boolean, observeResult: boolean): Promise<unknown>;
  send(method: string, params: JsonObject): Promise<unknown>;
  failed(result: unknown): boolean;
  dataOf(result: unknown): UiData;
  executionId(data?: UiData): string;
  humanRequest(data?: UiData): HumanRequest | undefined;
  terminalRun(execution: ExecutionProjection): boolean;
  workflowIdValid(value: unknown): value is string;
  setAction(button: HTMLButtonElement, label: string, actionId?: ActionId): void;
  actionIcon(actionId: ActionId): ActionIcon;
  createIcon(name: ActionIcon): SVGSVGElement;
  setError(error: unknown): void;
  openRunMonitor(data: UiData, cancel: boolean): void;
  openInteraction(requestId: string): Promise<void>;
}

function object(value: unknown): JsonObject | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined; }
function safeText(value: unknown, limit = 240): string { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }
function formatStatus(value: unknown): string { return safeText(value, 100).replaceAll("_", " "); }
function formatTime(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "Time unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
}
function isRunArguments(value: unknown): value is RunListArguments {
  const source = object(value);
  if (!source || !Number.isInteger(source.limit) || (source.limit as number) < 1 || (source.limit as number) > 100) return false;
  return ["cursor", "status", "workflowId"].every((key) => source[key] === undefined || typeof source[key] === "string");
}
function validRuns(data: UiData, validId: (value: unknown) => boolean): boolean {
  return Array.isArray(data.runs) && (data.nextCursor === undefined || data.nextCursor === null || typeof data.nextCursor === "string") &&
    data.runs.every((run) => object(run) !== undefined && validId(run.id ?? run.runId));
}

/** The local-control contract calls its page entries `executions`; the UI
 * domain calls them runs. Normalize once so list, selection and persistence
 * never diverge on their accepted shape. */
function normalizeRunPage(data: UiData): UiData {
  return Array.isArray(data.runs) || !Array.isArray(data.executions) ? data : { ...data, runs: data.executions };
}
function pendingRequest(data: UiData, execution: ExecutionProjection): HumanRequest | undefined {
  const request = data.humanRequest;
  if (!request || typeof request !== "object" || request.execution?.id !== execution.id) return undefined;
  return String(request.status || "").toLowerCase() === "pending" ? request : undefined;
}
function continuationReceipt(data: UiData): string | undefined {
  const continuation = object(data.details?.followContinuation);
  const receipt = safeText(continuation?.receipt, 2048);
  return /^[A-Za-z0-9_-]{16,2048}$/.test(receipt) ? receipt : undefined;
}

/** Read-only run discovery and selection. It deliberately contains no polling or recovery behavior. */
export function createRunListController(host: RunListControllerServices) {
  const { context, summary, form, primary, secondary, refresh: refreshButton } = host.elements;
  const state: RunListControllerState = { page: null, args: { limit: RUN_PAGE_SIZE }, history: [], selected: null, busy: false, epoch: 0 };

  function button(label: string, action: () => Promise<void> | void, actionId: ActionId = "next", disabled = false, className = "secondary", visibleLabel = false): HTMLButtonElement {
    const control = element("button", { type: "button", className, disabled: disabled || !host.connected() || state.busy });
    control.dataset.persistenceOptional="true";
    host.setAction(control, label, actionId);
    if (visibleLabel) {
      control.classList.remove("icon-button", "ui-button-icon");
      control.classList.add("action-with-label");
      control.replaceChildren(host.createIcon(host.actionIcon(actionId)), element("span", { className: "action-label" }, label));
    }
    control.addEventListener("click", () => { void runAction(action); });
    return control;
  }

  async function runAction(action: () => Promise<void> | void): Promise<void> {
    if (state.busy || !host.connected()) return;
    if(!host.viewPersistenceUnavailable()) void host.flushViewState().catch(() => undefined);
    await action();
  }

  function showSkeleton(label: string, retainContent = false): void {
    context.dataset.retainContent = String(retainContent);
    context.classList.add("workflow-loading-host");
    context.setAttribute("aria-busy", "true");
    context.querySelector(".workflow-skeleton")?.remove();
    context.querySelector(".workflow-loading-status")?.remove();
    const status = element("p", { className: "activity workflow-loading-status", role: "status", "aria-live": "polite" }, `${label}…`);
    const skeleton = element("div", { className: "workflow-skeleton", "aria-hidden": "true" });
    for (let index = 0; index < RUN_PAGE_SIZE; index += 1) skeleton.append(element("div", { className: "skeleton-row" }));
    context.append(status, skeleton);
    refreshButton.disabled = true;
  }

  function clearSkeleton(): void {
    delete context.dataset.retainContent;
    context.querySelector(".workflow-skeleton")?.remove();
    context.querySelector(".workflow-loading-status")?.remove();
    context.classList.remove("workflow-loading-host");
  }

  async function read(name: "loomex_runs_list" | "loomex_run_get", args: JsonObject, commit: (data: UiData) => void, retainContent = false): Promise<void> {
    if (state.busy || !host.connected()) return;
    const epoch = ++state.epoch;
    const draftStatus = retainContent ? context.querySelector<HTMLSelectElement>("#run-status-filter")?.value : undefined;
    const focusedId = retainContent ? context.ownerDocument.activeElement?.id : undefined;
    const scrollTop = context.scrollTop;
    state.busy = true;
    showSkeleton(name === "loomex_runs_list" ? "Loading runs" : "Loading run details", retainContent);
    try {
      await host.lifecycle.refresh("runs", () => host.callTool(name,args,false,false), async result => {
      if (epoch !== state.epoch) return;
      if (host.failed(result)) throw new Error(name === "loomex_runs_list" ? "Runs could not be loaded. Try Refresh again." : "Run details could not be loaded. Try Refresh again.");
      const data = normalizeRunPage(host.dataOf(result));
      if (name === "loomex_runs_list" && !validRuns(data, host.workflowIdValid)) throw new Error("The run list could not be verified. Continue in the conversation.");
      if (name === "loomex_run_get" && host.executionId(data) !== args.runId) throw new Error("The selected run could not be verified. Refresh and try again.");
      commit(data);
      host.setAuthoritativeStateStale(false);
      summary.classList.remove("error");
      summary.textContent = "";
      });
    } catch (error) {
      if (epoch === state.epoch) { host.setAuthoritativeStateStale(true); host.setError(error); }
    } finally {
      if (epoch === state.epoch) {
        state.busy = false;
        clearSkeleton();
        render();
        if (retainContent) {
          const filter = context.querySelector<HTMLSelectElement>("#run-status-filter");
          if (filter && draftStatus !== undefined) filter.value = draftStatus;
          if (focusedId) context.ownerDocument.getElementById(focusedId)?.focus({ preventScroll: true });
          context.scrollTop = scrollTop;
        }
        if (host.mutationHydrationReady()) { host.markViewDirty(); await host.flushViewState(); }
      }
    }
  }

  function loadPage(args: RunListArguments, history: RunListArguments[]): Promise<void> {
    return read("loomex_runs_list", { ...args }, (data) => { state.page = data; state.args = args; state.history = history; state.selected = null; });
  }

  function select(runId: string): Promise<void> { return read("loomex_run_get", { runId }, (data) => { state.selected = data; }); }

  async function sendChat(text: string, confirmation: string): Promise<void> {
    const result = await host.send("ui/message", { role: "user", content: [{ type: "text", text }] });
    if (host.failed(result)) throw new Error("The host could not open this run in the conversation.");
    summary.classList.remove("error"); summary.setAttribute("role", "status"); summary.textContent = confirmation;
  }

  function renderDetail(): void {
    const data = state.selected || {};
    const execution = data.execution || {};
    const runId = host.executionId(data);
    const terminal = host.terminalRun(execution);
    const request = pendingRequest(data, execution);
    const root = element("section", { className: "workflow-detail", "aria-label": "Run detail" });
    const heading = element("div", { className: "workflow-detail-heading" });
    const hero = element("div", { className: "ui-hero" });
    hero.append(element("h2", {}, safeText(execution.workflowName ?? execution.name) || "Run"));
    hero.append(element("p", { className: "ui-meta" }, [formatStatus(execution.status) || "Status unavailable", formatTime(execution.completedAt ?? execution.startedAt)].join(" · ")));
    if (safeText(execution.currentNodeName)) hero.append(element("p", { className: "ui-caption" }, `Current step: ${safeText(execution.currentNodeName)}`));
    heading.append(hero, button("Back to runs", () => { state.selected = null; render(); }, "back", false, "secondary", true));
    root.append(heading);
    const actions = element("div", { className: "workflow-detail-heading-actions", "aria-label": "Run actions" });
    if (request?.id && !terminal) {
      actions.append(button("Answer", () => host.openInteraction(request.id!), "chat", false, "secondary", true));
    } else if (!terminal) {
      const receipt = continuationReceipt(data);
      const text = receipt ? formatFollowContinuationMarkdown(runId, receipt) : formatManualFollowInstruction(runId);
      actions.append(button("Continue in chat", () => sendChat(text, receipt ? "This run was opened in chat for continuation." : "Use the displayed instruction in chat to continue this exact run."), "chat", false, "secondary", true));
    }
    if (!terminal) actions.append(button("Cancel", () => host.openRunMonitor(data, true), "cancel", false, "danger", true));
    if (terminal) {
      actions.append(button("Results", () => sendChat(`Show the authoritative results for Loomex run ${runId}.`, "The results were opened in chat."), "results", false, "secondary", true));
      actions.append(button("Artifacts", () => sendChat(`List the retained artifacts for Loomex run ${runId}.`, "The run artifacts were opened in chat."), "results", false, "secondary", true));
      actions.append(button("Delete", () => sendChat(`Delete Loomex run ${runId} after showing me the exact deletion confirmation.`, "Deletion was opened in chat for confirmation."), "cancel", false, "danger", true));
    }
    root.append(actions);
    const detail = element("dl", { className: "workflow-detail-list" });
    for (const [label, value] of [["Run ID", runId], ["Status", formatStatus(execution.status) || "Unavailable"], ["Started", formatTime(execution.startedAt)], ["Completed", formatTime(execution.completedAt)]]) {
      const row = element("div", { className: "workflow-detail-item" }); row.append(element("dt", { className: "ui-value" }, label), element("dd", { className: "ui-meta" }, value)); detail.append(row);
    }
    root.append(detail);
    context.replaceChildren(root);
  }

  function render(): void {
    context.hidden = false; context.className = "ui-stack"; context.setAttribute("aria-label", "Workflow runs"); context.setAttribute("aria-busy", String(state.busy));
    form.hidden = true; primary.hidden = true; secondary.hidden = true;
    refreshButton.hidden = false; host.setAction(refreshButton, "Refresh runs", "refresh"); refreshButton.disabled = !host.connected() || state.busy;
    if (state.selected) { renderDetail(); return; }
    context.replaceChildren();
    const filters = element("form", { className: "workflow-search", "aria-label": "Filter runs" });
    const status = element("select", { id: "run-status-filter", value: state.args.status ?? "", disabled: state.busy, "aria-label": "Run status" });
    for (const [value, label] of [["", "All statuses"], ["running", "Running"], ["waiting", "Waiting"], ["completed", "Completed"], ["failed", "Failed"], ["cancelled", "Cancelled"]]) status.append(element("option", { value }, label));
    const submit = button("Apply filters", () => {
      const args: RunListArguments = { limit: RUN_PAGE_SIZE }; if (status.value) args.status = status.value; return loadPage(args, []);
    }, "search", false, "secondary", true);
    filters.append(status, submit);
    filters.addEventListener("submit", (event) => { event.preventDefault(); void runAction(() => { const args: RunListArguments = { limit: RUN_PAGE_SIZE }; if (status.value) args.status = status.value; return loadPage(args, []); }); });
    context.append(filters);
    const runs = Array.isArray(state.page?.runs) ? state.page.runs.slice(0, RUN_PAGE_SIZE) : [];
    if (Array.isArray(state.page?.runs) && !runs.length) context.append(element("p", { className: "ui-callout" }, "No runs match these filters."));
    const rows = element("ul", { className: "workflow-rows", "aria-label": "Runs" });
    for (const candidate of runs) {
      const execution = candidate as ExecutionProjection;
      const runId = safeText(execution.id ?? execution.runId, 64);
      const row = element("li", { className: "workflow-row" });
      const copy = element("div", { className: "workflow-row-copy" });
      copy.append(element("h3", { className: "ui-value" }, safeText(execution.workflowName ?? execution.name) || "Unnamed workflow"));
      const meta = element("p", { className: "ui-meta" });
      meta.append(element("span", { className: "ui-badge" }, formatStatus(execution.status) || "Unknown"), element("span", {}, formatTime(execution.completedAt ?? execution.startedAt)));
      if (execution.requiredAction || /waiting/i.test(String(execution.status || ""))) meta.append(element("span", { className: "ui-badge" }, "Needs attention"));
      copy.append(meta);
      row.append(copy, button("View", () => select(runId), "results", !host.workflowIdValid(runId)));
      rows.append(row);
    }
    context.append(rows);
    const previous = button("Previous", () => loadPage(state.history.at(-1) ?? { limit: RUN_PAGE_SIZE }, state.history.slice(0, -1)), "back", !state.history.length, "secondary", true);
    const nextCursor = state.page?.nextCursor;
    const next = button("Next", () => loadPage({ ...state.args, ...(typeof nextCursor === "string" ? { cursor: nextCursor } : {}) }, [...state.history, state.args]), "next", typeof nextCursor !== "string", "secondary", true);
    context.append(createPagination({ ariaLabel: "Run pages", summary: `Page ${state.history.length + 1} · ${runs.length} run${runs.length === 1 ? "" : "s"}`, summaryId: "run-page-info", summaryLive: "polite", previous, next }));
  }

  async function refreshRuns(): Promise<void> {
    if (state.selected && host.workflowIdValid(host.executionId(state.selected))) {
      await read("loomex_run_get", { runId: host.executionId(state.selected) }, data => { state.selected = data; }, true);
    } else {
      await read("loomex_runs_list", { ...state.args }, data => { state.page = data; }, true);
    }
  }
  function capture(): JsonObject { return { arguments: structuredClone(state.args), history: structuredClone(state.history), selectedRunId: host.executionId(state.selected ?? undefined) || null }; }
  async function restoreFromPersistence(value: unknown): Promise<void> {
    const saved = object(value); if (!saved) return;
    const args = isRunArguments(saved.arguments) ? saved.arguments : undefined;
    const history = Array.isArray(saved.history) ? saved.history.filter(isRunArguments) : [];
    if (args && (!state.page || JSON.stringify(args) !== JSON.stringify(state.args))) await loadPage(args, history); else if (args) state.history = history;
    if (host.workflowIdValid(saved.selectedRunId) && host.executionId(state.selected ?? undefined) !== saved.selectedRunId) await select(saved.selectedRunId);
  }
  function resetFromIncomingList(args: RunListArguments | undefined): void { state.epoch += 1; state.busy = false; if (args) { state.args = { ...args, limit: RUN_PAGE_SIZE }; state.history = []; } }
  function dispose(): void { state.epoch += 1; state.busy = false; clearSkeleton(); }
  return { state, loadPage, select, render, refresh: refreshRuns, capture, restoreFromPersistence, resetFromIncomingList, dispose };
}
