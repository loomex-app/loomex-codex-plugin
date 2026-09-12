/** Shared native DOM primitives for independently owned UI controllers. */

export type ElementAttributes = Readonly<Record<string, string | number | boolean | Readonly<Record<string, string>> | undefined>>;

let statusBadgeClasses: Readonly<Record<string, string>> = {};

/** Supplies the generated design-system status classes for UI element creation. */
export function configureUiElementStyles(statusClasses: Readonly<Record<string, string>>): void {
  statusBadgeClasses = statusClasses;
}

/** Applies the common primary, secondary, and danger surface classes to a button. */
export function applyButtonStyle(button: HTMLButtonElement): void {
  const secondaryStyle = button.classList.contains("secondary") || button.classList.contains("info-button") || button.classList.contains("btn-secondary");
  const dangerStyle = button.classList.contains("danger") || button.classList.contains("loomex-danger");
  button.classList.remove("secondary", "danger", "btn-primary", "btn-secondary");
  button.classList.add("ui-button", secondaryStyle || dangerStyle ? "btn-secondary" : "btn-primary");
  button.classList.toggle("loomex-danger", dangerStyle);
}

/** Applies the generated status class that corresponds to a badge's visible status. */
export function applyStatusBadgeStyle(badge: HTMLElement): void {
  const normalized = (badge.textContent ?? "").trim().toLowerCase().replaceAll(" ", "_");
  badge.classList.add("status-badge");
  for (const value of Object.values(statusBadgeClasses)) badge.classList.remove(...classTokens(value));
  badge.classList.add(...classTokens(Object.hasOwn(statusBadgeClasses, normalized) ? (statusBadgeClasses[normalized] ?? "") : (statusBadgeClasses.low ?? "")));
}

/**
 * Creates native elements without interpreting strings as markup. The narrow
 * property list covers form and accessibility semantics shared by UI cards.
 */
export function createElement<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: ElementAttributes = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    if (name === "dataset" && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) node.dataset[key] = entry;
    } else if (name === "className") node.className = String(value);
    else if (name === "hidden") node.hidden = Boolean(value);
    else if (name === "tabIndex") node.tabIndex = Number(value);
    else if (name === "htmlFor" && node instanceof HTMLLabelElement) node.htmlFor = String(value);
    else if (name === "value" && isValueElement(node)) node.value = String(value);
    else if (name === "checked" && node instanceof HTMLInputElement) node.checked = Boolean(value);
    else if (name === "disabled" && isDisableable(node)) node.disabled = Boolean(value);
    else if (name === "readOnly" && isReadonlyElement(node)) node.readOnly = Boolean(value);
    else node.setAttribute(name, String(value));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Creates a native element with the shared visual classes the original UI
 * applied to common controls and surfaces. Button actions remain owned by
 * their controller so callers must still use the shell's explicit action ID.
 */
export function createUiElement<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: ElementAttributes = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = createElement(tag, attributes, text);
  if (node instanceof HTMLButtonElement) {
    applyButtonStyle(node);
    if (!text) node.classList.add("ui-button-md");
  }
  if ((tag === "input" || tag === "select" || tag === "textarea") && attributes.type !== "checkbox" && attributes.type !== "radio") {
    node.classList.add("input-field");
  }
  if (tag === "fieldset" || sharedPanelClasses.some((className) => node.classList.contains(className))) {
    node.classList.add("glass-panel");
  }
  if (node.classList.contains("ui-badge")) applyStatusBadgeStyle(node);
  return node;
}

const sharedPanelClasses = ["ui-card", "workflow-row", "answer-review-item", "ui-callout", "notice"] as const;

function classTokens(value: string): string[] {
  return value.split(" ").filter(Boolean);
}

function isValueElement(node: Element): node is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLOutputElement {
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement || node instanceof HTMLOutputElement;
}

function isDisableable(node: Element): node is HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return node instanceof HTMLButtonElement || node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement;
}

function isReadonlyElement(node: Element): node is HTMLInputElement | HTMLTextAreaElement {
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
}

export interface PaginationControls {
  readonly ariaLabel: string;
  readonly summary: string;
  readonly summaryId?: string;
  readonly summaryLive?: "polite";
  readonly leading?: readonly Node[];
  readonly previous: HTMLButtonElement;
  readonly next: HTMLButtonElement;
}

/** Keeps a zero-based page cursor inside a non-empty logical page range. */
export function clampPageIndex(pageIndex: number, pageCount: number): number {
  const safeCount = Number.isSafeInteger(pageCount) && pageCount > 0 ? pageCount : 1;
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) return 0;
  return Math.min(pageIndex, safeCount - 1);
}

/**
 * Builds the common compact pagination structure while leaving action labels,
 * disabled state, and click ownership with the caller's controller.
 */
export function createPagination(controls: PaginationControls): HTMLElement {
  const navigation = document.createElement("nav");
  navigation.className = "ui-data-table-pagination ui-data-table-pagination-compact";
  navigation.setAttribute("aria-label", controls.ariaLabel);

  const summary = document.createElement("output");
  if (controls.summaryId) summary.id = controls.summaryId;
  summary.className = "ui-data-table-pagination-summary";
  if (controls.summaryLive) summary.setAttribute("aria-live", controls.summaryLive);
  summary.textContent = controls.summary;

  const actions = document.createElement("div");
  actions.className = "ui-data-table-pagination-actions";
  actions.append(...(controls.leading ?? []), controls.previous, controls.next);
  navigation.append(summary, actions);
  return navigation;
}
