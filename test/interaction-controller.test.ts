import { after, before, test } from "node:test";
import * as assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";

let browser: Browser | undefined;
let page: Page | undefined;

const requestId = "83772dd6-d066-4ab4-ad81-5d0a3366517f";
const otherRequestId = "b1fe9492-8b5b-4e6f-a304-1905fcd85de8";
const digest = "a".repeat(64);

const fixtureScript = String.raw`
window.makeInteraction = (options = {}) => {
  const elements = {
    form: document.getElementById("form"), summary: document.getElementById("summary"),
    primary: document.getElementById("primary"), secondary: document.getElementById("secondary"),
  };
  const state = {
    actions: [], mutations: [], handoffs: [], presentations: 0, submitted: 0, appended: 0,
    hiddenReviews: 0, reviews: 0, restored: 0, flushes: 0, errors: [], typedInitial: null, events: [],
  };
  const clearActionState = button => {
    delete button.dataset.interactionAction;
    delete button.dataset.answerIntent;
  };
  const formController = {
    appendRequestCopy: () => { state.appended += 1; },
    typedForm: (_schema, initial) => {
      state.typedInitial = initial;
      elements.form.dataset.formKind = options.formKind || "questions";
      return options.formReady !== false;
    },
    answerActionLabel: action => action + " answer",
    hidePersistentBatchReview: () => { state.hiddenReviews += 1; },
    openAnswerReview: () => { state.reviews += 1; return options.reviewResult !== false; },
    collectAnswer: () => { state.events.push("collect"); return options.answer || { value: "Ada" }; },
  };
  const controller = InteractionControllerModule.createInteractionController({
    elements, formController,
    connected: () => options.connected !== false,
    authoritativeStateStale: () => options.stale === true,
    humanRequest: output => output.humanRequest && typeof output.humanRequest === "object" ? output.humanRequest : undefined,
    interactionId: output => output.humanRequest && typeof output.humanRequest.id === "string" ? output.humanRequest.id : undefined,
    requestSchemaDigest: request => typeof request.schemaDigest === "string" && /^[a-f0-9]{64}$/.test(request.schemaDigest) ? request.schemaDigest : undefined,
    currentInteractionOperation: () => options.operation,
    callVerifiedInteractionMutation: async (name, slot, args) => {
      state.events.push("mutation"); state.mutations.push({ name, slot, args });
      return { accepted: options.accepted !== false, result: { resolved: true } };
    },
    handoffAcceptedInteraction: async (_output, result) => { state.handoffs.push(result); },
    flushCurrentPersistence: async () => { state.events.push("flush"); state.flushes += 1; return options.flushResult !== false; },
    immutableCopy: value => structuredClone(value),
    setError: error => { state.errors.push(String(error && error.message || error)); },
    renderSubmittedInteraction: () => { state.submitted += 1; },
    renderHumanPresentation: () => { state.presentations += 1; },
    setAction: (button, label, actionId) => { clearActionState(button); button.textContent = label; button.dataset.actionId = actionId || ""; state.actions.push({ label, actionId }); },
    setMutationAction: (button, label, actionId) => { clearActionState(button); button.textContent = label; button.dataset.actionId = actionId || ""; state.actions.push({ label, actionId, mutation: true }); },
    restoreReviewNavigationControls: () => { state.restored += 1; },
  });
  return { controller, state, elements };
};
window.requestOutput = (overrides = {}) => ({ humanRequest: {
  id: "${requestId}", inputSpec: { question: "Name?", inputType: "text" },
  responseSchema: { type: "object", properties: { value: { type: "string" } } },
  schemaDigest: "${digest}", ...overrides,
} });
`;

async function resetPage(): Promise<void> {
  if (!page) throw new Error("A browser page is required for this test.");
  await page.setContent('<main><div id="summary"></div><form id="form"></form><button id="primary"></button><button id="secondary"></button></main>');
  const compiled = await build({ entryPoints: [fileURLToPath(new URL("../src/ui-app/interaction-controller.ts", import.meta.url))], bundle: true, write: false, format: "iife", globalName: "InteractionControllerModule", target: "es2022" });
  await page.addScriptTag({ content: compiled.outputFiles[0]!.text });
  await page.addScriptTag({ content: fixtureScript });
}

function requireBrowser(context: { skip(message?: string): void }): boolean {
  if (page) return true;
  if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser");
  context.skip("No local Chromium browser is installed.");
  return false;
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

after(async () => { await browser?.close(); });

test("renders verified approval actions and disables stale authority", async (context) => {
  if (!requireBrowser(context)) return;
  await resetPage();
  const result = await page!.evaluate(`(() => {
    const fixture = window.makeInteraction({ stale: true });
    fixture.controller.render(false, window.requestOutput({ type: "approval" }));
    return {
      primary: { label: fixture.elements.primary.textContent, action: fixture.elements.primary.dataset.interactionAction, id: fixture.elements.primary.dataset.actionId, disabled: fixture.elements.primary.disabled },
      secondary: { label: fixture.elements.secondary.textContent, action: fixture.elements.secondary.dataset.interactionAction, id: fixture.elements.secondary.dataset.actionId, disabled: fixture.elements.secondary.disabled },
      state: fixture.state,
    };
  })()`) as { primary: unknown; secondary: unknown; state: { appended: number; presentations: number } };
  assert.deepEqual(result.primary, { label: "Approve", action: "approve", id: "approve", disabled: true });
  assert.deepEqual(result.secondary, { label: "Reject", action: "reject", id: "reject", disabled: true });
  assert.equal(result.state.appended, 1);
  assert.equal(result.state.presentations, 1);
});

test("renders retained response state and requires a verified schema digest", async (context) => {
  if (!requireBrowser(context)) return;
  await resetPage();
  const result = await page!.evaluate(`(() => {
    const fixture = window.makeInteraction({ operation: { name: "loomex_interaction_respond", slot: "interaction:respond:${requestId}", arguments: { requestId: "${requestId}", answer: { value: "Retained" } } } });
    fixture.controller.render(false, window.requestOutput({ schemaDigest: undefined }));
    return { initial: fixture.state.typedInitial, label: fixture.elements.primary.textContent, intent: fixture.elements.primary.dataset.answerIntent, id: fixture.elements.primary.dataset.actionId, disabled: fixture.elements.primary.disabled, summary: fixture.elements.summary.textContent };
  })()`);
  assert.deepEqual(result, {
    initial: { value: "Retained" }, label: "Review answer", intent: "review", id: "review", disabled: true,
    summary: "The current question schema could not be verified. Refresh this request before answering.",
  });
});

test("renders resolved requests and fails closed on mismatched identity", async (context) => {
  if (!requireBrowser(context)) return;
  await resetPage();
  const result = await page!.evaluate(`(() => {
    const resolved = window.makeInteraction();
    resolved.controller.render(false, window.requestOutput({ status: "answered" }));
    const malformed = window.makeInteraction();
    const output = window.requestOutput({ requestId: "${otherRequestId}" });
    malformed.controller.render(false, output);
    return { submitted: resolved.state.submitted, summary: malformed.elements.summary.textContent, role: malformed.elements.summary.getAttribute("role"), disabled: malformed.elements.primary.disabled };
  })()`);
  assert.deepEqual(result, {
    submitted: 1,
    summary: "The interaction request identity could not be verified. Refresh before continuing.",
    role: "alert",
    disabled: true,
  });
});

test("routes review and durably flushed answer submission with exact mutation arguments", async (context) => {
  if (!requireBrowser(context)) return;
  await resetPage();
  const result = await page!.evaluate(`(async () => {
    const fixture = window.makeInteraction({ answer: { value: "Ada" } });
    const output = window.requestOutput();
    fixture.elements.primary.dataset.answerIntent = "review";
    const reviewed = await fixture.controller.submit(output);
    fixture.elements.primary.dataset.answerIntent = "submit";
    const submitted = await fixture.controller.submit(output);
    return { reviewed, submitted, state: fixture.state };
  })()`) as { reviewed: boolean; submitted: boolean; state: { reviews: number; restored: number; flushes: number; events: string[]; mutations: unknown[]; handoffs: unknown[] } };
  assert.equal(result.reviewed, true);
  assert.equal(result.submitted, true);
  assert.equal(result.state.reviews, 1);
  assert.equal(result.state.restored, 1);
  assert.equal(result.state.flushes, 1);
  assert.deepEqual(result.state.events, ["flush", "collect", "mutation"]);
  assert.deepEqual(result.state.mutations, [{
    name: "loomex_interaction_respond",
    slot: `interaction:respond:${requestId}`,
    args: { requestId, answer: { value: "Ada" }, expectedSchemaDigest: digest },
  }]);
  assert.deepEqual(result.state.handoffs, [{ resolved: true }]);
});

test("routes approve, reject, and retained retry only for the current request", async (context) => {
  if (!requireBrowser(context)) return;
  await resetPage();
  const result = await page!.evaluate(`(async () => {
    const approval = window.makeInteraction();
    approval.elements.primary.dataset.interactionAction = "approve";
    await approval.controller.submit(window.requestOutput({ type: "approval" }));
    await approval.controller.reject(window.requestOutput({ type: "approval" }));
    const retry = window.makeInteraction({ operation: { name: "loomex_interaction_decide", slot: "interaction:approve:${requestId}", arguments: { requestId: "${requestId}", decision: "approve" } } });
    const retried = await retry.controller.submit(window.requestOutput({ type: "approval" }));
    const mismatch = window.makeInteraction({ operation: { name: "loomex_interaction_respond", slot: "interaction:respond:${otherRequestId}", arguments: { requestId: "${otherRequestId}" } } });
    const mismatchHandled = await mismatch.controller.submit(window.requestOutput());
    return { direct: approval.state.mutations, retried, retryCalls: retry.state.mutations, mismatchHandled, mismatchErrors: mismatch.state.errors, mismatchCalls: mismatch.state.mutations };
  })()`) as { direct: unknown[]; retried: boolean; retryCalls: unknown[]; mismatchHandled: boolean; mismatchErrors: string[]; mismatchCalls: unknown[] };
  assert.deepEqual(result.direct, [
    { name: "loomex_interaction_decide", slot: `interaction:approve:${requestId}`, args: { requestId, decision: "approve" } },
    { name: "loomex_interaction_decide", slot: `interaction:reject:${requestId}`, args: { requestId, decision: "reject" } },
  ]);
  assert.equal(result.retried, true);
  assert.deepEqual(result.retryCalls, [{ name: "loomex_interaction_decide", slot: `interaction:approve:${requestId}`, args: {} }]);
  assert.equal(result.mismatchHandled, false);
  assert.match(result.mismatchErrors[0] || "", /does not belong to this request/);
  assert.deepEqual(result.mismatchCalls, []);
});
