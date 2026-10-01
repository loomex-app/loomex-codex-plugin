import { after, before, test } from "node:test";
import * as assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "@playwright/test";
import { inputSpecSupported, normalizeInputType, validDate } from "../src/ui-app/interaction-form.js";
import type { InputSpec } from "../src/ui-app/page-models.js";

let browser: Browser | undefined;
let page: Page | undefined;

const fixtureScript = String.raw`
window.makeInteractionForm = (options = {}) => {
  const form = document.getElementById("form");
  const primary = document.getElementById("primary");
  const secondary = document.getElementById("secondary");
  const summary = document.getElementById("summary");
  const events = { dirty: 0, draft: 0, navigation: 0, renders: 0, errors: [] };
  const controller = InteractionFormModule.createInteractionFormController({
    elements: { form, primary, secondary, summary },
    mode: () => options.mode || "interaction",
    connected: () => options.connected !== false,
    authoritativeStateStale: () => options.stale === true,
    latestAnswerChannel: () => options.answerChannel || "",
    persistenceReady: () => true,
    humanPresentation: request => request.presentation,
    safeText: (value, maximumLength = 4096) => typeof value === "string" && value.trim() && value.trim().length <= maximumLength ? value.trim() : undefined,
    reviewValue: value => Object.assign(document.createElement("span"), { textContent: JSON.stringify(value) }),
    formatDateTime: value => typeof value === "string" ? value : undefined,
    setAction: (button, label, actionId) => {
      delete button.dataset.businessMutation;
      delete button.dataset.answerIntent;
      delete button.dataset.actionId;
      button.textContent = label;
      button.setAttribute("aria-label", label);
      if (actionId) button.dataset.actionId = actionId;
    },
    setError: error => { events.errors.push(String(error && error.message || error)); summary.textContent = events.errors.at(-1); },
    markViewDirty: () => { events.dirty += 1; },
    scheduleInteractionDraft: () => { events.draft += 1; },
    saveReviewNavigation: () => { events.navigation += 1; },
    onRender: () => { events.renders += 1; },
  });
  return { controller, events };
};
`;

async function resetPage(): Promise<void> {
  if (!page) throw new Error("A browser page is required for this test.");
  await page.setContent('<main><div id="summary"></div><form id="form"></form><button id="primary"></button><button id="secondary"></button></main>');
  const compiled = await build({ entryPoints: [new URL("../src/ui-app/interaction-form.ts", import.meta.url).pathname], bundle: true, write: false, format: "iife", globalName: "InteractionFormModule", target: "es2022" });
  await page.addScriptTag({ content: compiled.outputFiles[0]!.text });
  await page.addScriptTag({ content: fixtureScript });
}

before(async () => {
  const candidates = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", chromium.executablePath()];
  let executablePath: string | undefined;
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); executablePath = candidate; break; } catch { /* Try the next local browser. */ }
  }
  if (!executablePath) return;
  browser = await chromium.launch({ headless: true, executablePath });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
});

test("normalizes aliases and strictly bounds supported input specifications", () => {
  assert.equal(normalizeInputType("long-answer"), "long_text");
  assert.equal(normalizeInputType("textarea"), "long_text");
  assert.equal(inputSpecSupported({ inputType: "text", question: "Name?" }), true);
  assert.equal(inputSpecSupported({ inputType: "long_text", question: "Explain" }), false);
  assert.equal(inputSpecSupported({
    collectionMode: "batch",
    questions: [
      { id: "choice", question: "Choose", inputType: "radio", allowOther: false, options: [{ id: "a", label: "A" }] },
      { id: "choice", question: "Again", inputType: "boolean" },
    ],
  } as InputSpec), false);
  assert.equal(inputSpecSupported({
    question: "Choose",
    inputType: "checkbox",
    allowOther: false,
    options: [{ id: "other", label: "Reserved" }],
  } as InputSpec), false);
  assert.equal(inputSpecSupported({ question: "Rate", inputType: "rating", minimum: 5, maximum: 1 }), false);
});

test("validates real Gregorian calendar dates", () => {
  assert.equal(validDate("2024-02-29"), true);
  assert.equal(validDate("2100-02-29"), false);
  assert.equal(validDate("2026-04-31"), false);
  assert.equal(validDate("2026-04-30"), true);
});

test("renders batch navigation, auto-advances single choices, and keeps checkboxes explicit", async (context) => {
  if (!page) { if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser"); context.skip("No local Chromium browser is installed."); return; }
  await resetPage();
  const result = await page.evaluate(`(async () => {
    const fixture = window.makeInteractionForm();
    fixture.controller.questionForm({ collectionMode: "batch", questions: [
      { id: "priority", question: "Priority?", inputType: "radio", allowOther: false, options: [{ id: "high", label: "High" }] },
      { id: "tags", question: "Tags?", inputType: "checkbox", allowOther: false, options: [{ id: "bug", label: "Bug" }] }
    ] }, { required: ["answers"] }, {}, {});
    const form = document.getElementById("form");
    const fields = [...form.querySelectorAll("fieldset[data-question-id]")];
    const first = fields[0].querySelector('input[type="radio"]');
    first.checked = true;
    await fixture.controller.autoAdvanceChoice(first);
    const afterRadio = { index: form.dataset.questionIndex, firstHidden: fields[0].hidden, secondHidden: fields[1].hidden };
    const checkbox = fields[1].querySelector('input[type="checkbox"]');
    checkbox.checked = true;
    await fixture.controller.autoAdvanceChoice(checkbox);
    return {
      afterRadio,
      afterCheckbox: form.dataset.answerPhase,
      answer: fixture.controller.collectAnswer(),
      navigation: fixture.events.navigation,
      stepLabel: form.querySelector("output").textContent,
    };
  })()`);
  assert.deepEqual(result, {
    afterRadio: { index: "1", firstHidden: true, secondHidden: false },
    afterCheckbox: "answer",
    answer: { answers: [{ questionId: "priority", value: "high" }, { questionId: "tags", values: ["bug"] }] },
    navigation: 1,
    stepLabel: "Question 2 of 2",
  });
});

test("routes a lone long-text question to chat and rejects mixed inline batches", async (context) => {
  if (!page) { if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser"); context.skip("No local Chromium browser is installed."); return; }
  await resetPage();
  const result = await page.evaluate(`(() => {
    const fixture = window.makeInteractionForm({ answerChannel: "chat" });
    const handoff = fixture.controller.typedForm(
      { type: "object", required: ["value"] }, {},
      { question: "Explain the decision", inputType: "textarea", answerChannel: "chat" },
      { title: "Explain the decision" }
    );
    const form = document.getElementById("form");
    const single = { rendered: handoff, kind: form.dataset.formKind, heading: form.querySelector("h2").textContent };
    const mixed = fixture.controller.typedForm(
      { type: "object", required: ["answers"] }, {},
      { collectionMode: "batch", questions: [
        { id: "short", question: "Short", inputType: "text" },
        { id: "long", question: "Long", inputType: "long_text" }
      ] }, {}
    );
    const mixedResult = { rendered: mixed, kind: form.dataset.formKind, error: form.querySelector('[role="alert"]').textContent };
    const malformed = fixture.controller.typedForm(
      { type: "object" }, {}, { collectionMode: "batch", inputType: "long_text", questions: [null] }, {}
    );
    return { single, mixed: mixedResult, malformed: { rendered: malformed, kind: form.dataset.formKind } };
  })()`);
  assert.deepEqual(result, {
    single: { rendered: false, kind: "chat-answer", heading: "Explain the decision" },
    mixed: {
      rendered: false,
      kind: "invalid-questions",
      error: "Long-form questions cannot be mixed into an inline batch. Continue in the conversation to answer this request.",
    },
    malformed: { rendered: false, kind: "invalid-questions" },
  });
});

test("uses the request answer channel before legacy input metadata and rejects explicit unsupported routes", async (context) => {
  if (!page) { if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser"); context.skip("No local Chromium browser is installed."); return; }
  await resetPage();
  const result = await page.evaluate(`(() => {
    const fixture = window.makeInteractionForm({ answerChannel: "chat" });
    const requestUi = fixture.controller.typedForm(
      { type: "object", required: ["value"] }, {},
      { question: "Explain the decision", inputType: "long_text", answerChannel: "chat" },
      { title: "Explain the decision", answerChannel: "ui" },
    );
    const form = document.getElementById("form");
    const uiRoute = { rendered: requestUi, kind: form.dataset.formKind, text: form.textContent };
    const unsupported = fixture.controller.typedForm(
      { type: "object", required: ["value"] }, {},
      { question: "Name the deliverable", inputType: "text", answerChannel: "chat" },
      { title: "Name the deliverable", answerChannel: "unsupported" },
    );
    return { uiRoute, unsupported: { rendered: unsupported, kind: form.dataset.formKind, text: form.textContent } };
  })()`);
  assert.deepEqual(result, {
    uiRoute: {
      rendered: false,
      kind: "invalid-questions",
      text: "This long-form answer must be collected in the conversation. Continue in chat to answer it.",
    },
    unsupported: {
      rendered: false,
      kind: "invalid-questions",
      text: "This request uses an unsupported answer channel. Continue in the conversation for the compatible response flow.",
    },
  });
});

test("Space advances radio questions and opens review from the final question", async (context) => {
  if (!page) { if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser"); context.skip("No local Chromium browser is installed."); return; }
  await resetPage();
  await page.evaluate(`(() => {
    const fixture = window.makeInteractionForm();
    window.__spaceFixture = fixture;
    window.__spaceKeys = [];
    document.addEventListener("keydown", event => window.__spaceKeys.push({ key: event.key, target: event.target?.id, trusted: event.isTrusted }));
    fixture.controller.attach();
    fixture.controller.questionForm({ collectionMode: "batch", questions: [
      { id: "priority", question: "Priority?", inputType: "radio", allowOther: false, options: [{ id: "high", label: "High" }] },
      { id: "decision", question: "Proceed?", inputType: "radio", allowOther: false, options: [{ id: "yes", label: "Yes" }] },
    ] }, { required: ["answers"] }, {}, {});
  })()`);
  const first = page.locator('#question-0-option-0');
  await first.focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(50);
  assert.deepEqual(await page.evaluate(() => ({
    index: document.getElementById("form")?.dataset.questionIndex,
    checked: (document.getElementById("question-0-option-0") as HTMLInputElement | null)?.checked,
    events: (window as any).__spaceFixture?.events,
    keys: (window as any).__spaceKeys,
    active: document.activeElement?.id,
  })), { index: "1", checked: true, events: { dirty: 0, draft: 0, navigation: 1, renders: 0, errors: [] }, keys: [{ key: " ", target: "question-0-option-0", trusted: true }], active: "question-1-option-0" });
  const final = page.locator('#question-1-option-0');
  await final.focus();
  await page.keyboard.press("Space");
  await page.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => {
    const form = document.getElementById("form");
    return {
      phase: form?.dataset.answerPhase,
      finalChecked: (document.getElementById("question-1-option-0") as HTMLInputElement | null)?.checked,
      primaryIntent: document.getElementById("primary")?.dataset.answerIntent,
      preview: form?.querySelector(".answer-review")?.textContent,
    };
  }), {
    phase: "review",
    finalChecked: true,
    primaryIntent: "submit",
    preview: "Answer previewCheck each answer before sending it.Priority?HighEdit answer 1Proceed?YesEdit answer 2",
  });
});

test("marks invalid controls, renders an accessible review, and restores draft answers", async (context) => {
  if (!page) { if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser"); context.skip("No local Chromium browser is installed."); return; }
  await resetPage();
  const result = await page.evaluate(`(() => {
    const fixture = window.makeInteractionForm();
    fixture.controller.questionForm({ question: "Approval date", inputType: "date" }, { required: ["value"] }, {}, {});
    const form = document.getElementById("form");
    const input = form.querySelector("[data-value]");
    input.type = "text";
    input.value = "2026-02-30";
    let invalidMessage = "";
    try { fixture.controller.collectAnswer(); } catch (error) { invalidMessage = error.message; }
    const invalid = input.getAttribute("aria-invalid");
    input.value = "2026-02-28";
    const reviewed = fixture.controller.beginAnswerReview();
    const review = {
      reviewed,
      phase: form.dataset.answerPhase,
      label: form.querySelector(".answer-review").getAttribute("aria-label"),
      value: form.querySelector(".answer-review dd").textContent,
      submitIntent: document.getElementById("primary").dataset.answerIntent,
      actionId: document.getElementById("primary").dataset.actionId,
      mutation: document.getElementById("primary").dataset.businessMutation,
    };
    fixture.controller.exitAnswerReview();
    fixture.controller.restoreQuestionAnswers({ answer: { value: "2025-12-31" } });
    return { invalidMessage, invalid, review, restored: input.value, visible: fixture.controller.visibleQuestionId() };
  })()`);
  assert.deepEqual(result, {
    invalidMessage: "Enter a real date in YYYY-MM-DD format.",
    invalid: "true",
    review: {
      reviewed: true,
      phase: "review",
      label: "Answer preview",
      value: "2026-02-28",
      submitIntent: "submit",
      actionId: "submit",
      mutation: "true",
    },
    restored: "2025-12-31",
    visible: "answer",
  });
});

test("submitted choice review tolerates malformed option collections", async (context) => {
  if (!page) { if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser"); context.skip("No local Chromium browser is installed."); return; }
  await resetPage();
  const result = await page.evaluate(`(() => {
    const fixture = window.makeInteractionForm();
    const radio = fixture.controller.submittedAnswerReview({
      status: "resolved", inputSpec: { question: "Pick one", inputType: "radio", options: { malformed: true } }, answer: { value: "choice-a" }
    });
    const checkbox = fixture.controller.submittedAnswerReview({
      status: "resolved", inputSpec: { question: "Pick many", inputType: "checkbox", options: "malformed" }, answer: { values: ["choice-a"] }
    });
    return { radio: radio.querySelector("dd").textContent, checkbox: checkbox.querySelector("dd").textContent };
  })()`);
  assert.deepEqual(result, { radio: "choice-a", checkbox: "choice-a" });
});

test("collects generic schema values with their declared scalar types", async (context) => {
  if (!page) { if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser"); context.skip("No local Chromium browser is installed."); return; }
  await resetPage();
  const result = await page.evaluate(`(() => {
    const fixture = window.makeInteractionForm({ mode: "monitor" });
    fixture.controller.typedForm({ properties: {
      reason: { type: "string" }, retries: { type: "integer" }, confidence: { type: "number" }, approved: { type: "boolean" }
    }, required: ["reason", "retries", "confidence", "approved"] }, {}, null, {});
    document.getElementById("schema-reason").value = "Changed scope";
    document.getElementById("schema-retries").value = "3";
    document.getElementById("schema-confidence").value = "0.75";
    document.getElementById("schema-approved").value = "false";
    return { label: document.querySelector('label[for="schema-reason"]').firstChild.textContent, answer: fixture.controller.collectAnswer() };
  })()`);
  assert.deepEqual(result, {
    label: "Cancellation reason",
    answer: { reason: "Changed scope", retries: 3, confidence: 0.75, approved: false },
  });
});

test("full question copy survives body, preview and submitted review without changing typed identities", async (context) => {
  if (!page) { if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Chromium is required"); context.skip("No Chromium"); return; }
  await resetPage();
  const question = "A complete plain question whose full wording must survive. ".repeat(110);
  const result = await page.evaluate(({ question }) => {
    const fixture = (window as unknown as { makeInteractionForm(): { controller: ReturnType<typeof import("../src/ui-app/interaction-form.js")["createInteractionFormController"]> } }).makeInteractionForm();
    const request = { title: "Original title", inputSpec: { inputType: "boolean", question }, node: { id: "unchanged-node" } };
    const snapshot = JSON.stringify(request);
    fixture.controller.questionForm(request.inputSpec, { required: ["value"] }, { value: true }, request);
    const body = document.querySelector(".ui-rich-text")?.textContent;
    const label = document.querySelector("legend")?.textContent;
    const id = fixture.controller.visibleQuestionId();
    const answer = fixture.controller.collectAnswer();
    fixture.controller.beginAnswerReview();
    const preview = document.querySelector(".answer-review dt .ui-rich-text")?.textContent;
    const submitted = fixture.controller.submittedAnswerReview(request, { value: true }).querySelector("dt .ui-rich-text")?.textContent;
    return { body, label, id, answer, preview, submitted, unchanged: snapshot === JSON.stringify(request) };
  }, { question });
  assert.deepEqual(result, { body: question, label: "Question", id: "unchanged-node", answer: { value: true }, preview: question, submitted: question, unchanged: true });
});

test("safe report formatting keeps unsupported HTML and URLs visible and inert", async (context) => {
  if (!page) { if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Chromium is required"); context.skip("No Chromium"); return; }
  await resetPage();
  const question = '## Review\n\n**Readable** and `literal code`.\n\n- First\n- Second\n\n[Unsafe](javascript:alert(1)) ![remote](https://example.test/image) <img src=x onerror=alert(1)>\n\n```text\n<script>alert(1)</script>\n```';
  const result = await page.evaluate(({ question }) => {
    const fixture = (window as unknown as { makeInteractionForm(): { controller: ReturnType<typeof import("../src/ui-app/interaction-form.js")["createInteractionFormController"]> } }).makeInteractionForm();
    fixture.controller.questionForm({ inputType: "boolean", question }, { required: ["value"] }, {}, {});
    const body = document.querySelector(".ui-rich-text")!;
    return { markup: body.querySelectorAll("a, img, script, iframe").length, headings: body.querySelectorAll("h1, h2").length, sections: body.querySelectorAll("h3").length, items: body.querySelectorAll("li").length, source: document.querySelector(".ui-prompt-original")?.textContent, text: body.textContent };
  }, { question });
  assert.equal(result.markup, 0);
  assert.equal(result.headings, 0);
  assert.equal(result.sections, 1);
  assert.equal(result.items, 2);
  assert.equal(result.source, question);
  assert.match(result.text ?? "", /javascript:alert\(1\)/);
  assert.match(result.text ?? "", /https:\/\/example.test\/image/);
  assert.match(result.text ?? "", /<script>alert\(1\)<\/script>/);
});

test("compact questions retain their exact heading and noncompact prompts describe their fieldset once", async (context) => {
  if (!page) { if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Chromium is required"); context.skip("No Chromium"); return; }
  await resetPage();
  const result = await page.evaluate<{ heading: string; fields: { description: string; contentId: string; text: string; controlsRepeatContext: boolean }[] }>(`(() => {
    const fixture = window.makeInteractionForm();
    fixture.controller.questionForm({ inputType: "boolean", question: "Proceed with the agreed plan?" }, { required: ["value"] }, {}, {});
    const heading = document.querySelector(".question-heading").firstChild.textContent;
    const question = "Full context whose meaning belongs to this question. ".repeat(40);
    fixture.controller.questionForm({ collectionMode: "batch", questions: [
      { id: "decision", inputType: "boolean", question },
      { id: "reason", inputType: "text", question: question + " Explain the choice." }
    ] }, { required: ["answers"] }, {}, {});
    const fields = [...document.querySelectorAll("fieldset[data-question-id]")];
    return { heading, fields: fields.map(field => {
      const content = field.querySelector(".ui-rich-text");
      return { description: field.getAttribute("aria-describedby"), contentId: content.id, text: content.textContent, controlsRepeatContext: [...field.querySelectorAll("input")].some(control => (control.getAttribute("aria-describedby") || "").includes(content.id)) };
    }) };
  })()`);
  assert.equal(result.heading, "Proceed with the agreed plan?");
  for (const [index, field] of result.fields.entries()) {
    assert.equal(field.description, `${field.contentId} question-${index}-error`);
    assert.match(field.text, /Full context whose meaning belongs to this question/);
    assert.equal(field.controlsRepeatContext, false, "context belongs to the group rather than every choice");
  }
});
