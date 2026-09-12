import { configureUiElementStyles, createElement, createUiElement } from "../src/ui-app/components.js";

const target = globalThis as unknown as { loomexComponentsFixture?: () => void; loomexUiComponentsFixture?: () => void };
target.loomexComponentsFixture = () => {
  const label = createElement("label", { htmlFor: "name-input", className: "fixture-label" }, "Name");
  const input = createElement("input", { id: "name-input", value: "Ada", checked: true, disabled: false, readOnly: false, hidden: false, tabIndex: 2, dataset: { fixtureKey: "safe" } });
  const textarea = createElement("textarea", { value: "notes", readOnly: true });
  const select = createElement("select", { value: "two" });
  select.append(createElement("option", { value: "one" }, "One"), createElement("option", { value: "two" }, "Two"));
  select.value = "two";
  const safe = createElement("p", {}, "<img src=x onerror=alert(1)>");
  document.body.replaceChildren(label, input, textarea, select, safe);
};

target.loomexUiComponentsFixture = () => {
  configureUiElementStyles({ running: "badge-running", low: "badge-low" });
  const text = createUiElement("input", { type: "text" });
  const checkbox = createUiElement("input", { type: "checkbox" });
  const select = createUiElement("select");
  const textarea = createUiElement("textarea");
  const fieldset = createUiElement("fieldset");
  const card = createUiElement("section", { className: "ui-card existing-class" });
  const row = createUiElement("li", { className: "workflow-row" });
  const review = createUiElement("div", { className: "answer-review-item" });
  const callout = createUiElement("p", { className: "ui-callout" });
  const notice = createUiElement("p", { className: "notice" });
  const knownBadge = createUiElement("span", { className: "ui-badge" }, "Running");
  const fallbackBadge = createUiElement("span", { className: "ui-badge" }, "Unknown state");
  const primary = createUiElement("button");
  const secondary = createUiElement("button", { className: "secondary" });
  const danger = createUiElement("button", { className: "danger" });
  document.body.replaceChildren(text, checkbox, select, textarea, fieldset, card, row, review, callout, notice, knownBadge, fallbackBadge, primary, secondary, danger);
};
