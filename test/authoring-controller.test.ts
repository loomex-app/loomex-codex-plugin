import { after, before, test } from "node:test";
import * as assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { transform } from "esbuild";
import { chromium, type Browser, type Page } from "@playwright/test";

let browser: Browser | undefined;
let page: Page | undefined;

const sessionId = "b1fe9492-8b5b-4e6f-a304-1905fcd85de8";

const fixtureScript = String.raw`
window.makeAuthoring = (options = {}) => {
  const elements = {
    context: document.getElementById("context"), summary: document.getElementById("summary"),
    form: document.getElementById("form"), primary: document.getElementById("primary"), refresh: document.getElementById("refresh"),
  };
  const state = { actions: [], mutations: [], toolCalls: [], presentations: 0, workflowRenders: 0, failures: 0, drafts: 0, reconciles: 0, reviews: 0, restored: 0, errors: [], typedInitial: null, synced: 0 };
  const controller = AuthoringControllerModule.createAuthoringController({
    elements,
    connected: () => options.connected !== false,
    authoritativeStateStale: () => options.stale === true,
    builderSessionId: output => output.builderSession && typeof output.builderSession.id === "string" ? output.builderSession.id : undefined,
    humanRequest: output => output.humanRequest && typeof output.humanRequest === "object" ? output.humanRequest : undefined,
    inputSpecSupported: spec => Boolean(spec && typeof spec === "object" && typeof spec.question === "string"),
    requestSchemaDigest: request => typeof request.schemaDigest === "string" && /^[a-f0-9]{64}$/.test(request.schemaDigest) ? request.schemaDigest : undefined,
    pagedResponse: output => typeof output.responseRef === "string" ? { responseRef: output.responseRef } : undefined,
    renderAuthoringWorkflow: () => { state.workflowRenders += 1; },
    renderFailure: () => { state.failures += 1; },
    renderHumanPresentation: () => { state.presentations += 1; },
    typedForm: (_schema, initial) => { state.typedInitial = initial; elements.form.dataset.formKind = options.formKind || "questions"; return options.formReady !== false; },
    hidePersistentBatchReview: () => {},
    answerActionLabel: action => action + " answer",
    setAction: (button, label, actionId) => { button.textContent = label; button.dataset.actionId = actionId || ""; delete button.dataset.answerIntent; state.actions.push({ label, actionId }); },
    setMutationAction: (button, label, actionId) => { button.textContent = label; button.dataset.actionId = actionId || ""; state.actions.push({ label, actionId, mutation: true }); },
    syncChrome: () => { state.synced += 1; },
    loadInteractionDraft: async () => { state.drafts += 1; return options.draftResult !== false; },
    setError: error => { state.errors.push(String(error && error.message || error)); },
    callTool: async (name, args, renderResult) => { state.toolCalls.push({ name, args, renderResult }); return { refreshed: true }; },
    callMutation: async (name, slot, args) => { state.mutations.push({ name, slot, args }); return {}; },
    currentResponseOperation: () => options.operation,
    reconcilePending: async () => { state.reconciles += 1; },
    openAnswerReview: () => { state.reviews += 1; return options.reviewResult !== false; },
    restoreReviewNavigationControls: () => { state.restored += 1; },
    collectAnswer: () => options.answer || { value: "Ada" },
  });
  return { controller, state, elements };
};
`;

async function resetPage(): Promise<void> {
  if (!page) throw new Error("A browser page is required for this test.");
  await page.setContent('<main><div id="context"></div><div id="summary"></div><form id="form"></form><button id="primary"></button><button id="refresh"></button></main>');
  const source = await readFile(new URL("../src/ui-app/authoring-controller.ts", import.meta.url), "utf8");
  const compiled = await transform(source, { loader: "ts", format: "iife", globalName: "AuthoringControllerModule", target: "es2022" });
  await page.addScriptTag({ content: compiled.code });
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

test("renders a verified builder question with retained response state", async (context) => {
  if (!requireBrowser(context)) return;
  await resetPage();
  const result = await page!.evaluate(`(() => {
    const fixture = window.makeAuthoring({ operation: { name: "loomex_builder_respond", slot: "builder:respond:${sessionId}", arguments: { sessionId: "${sessionId}", response: { value: "Retained" } } } });
    fixture.controller.render(false, { builderSession: { id: "${sessionId}" }, humanRequest: {
      id: "83772dd6-d066-4ab4-ad81-5d0a3366517f", question: "Name?", inputSpec: { question: "Name?", inputType: "text" },
      responseSchema: { type: "object", properties: { value: { type: "string" } } }, schemaDigest: "${"a".repeat(64)}"
    } });
    return { state: fixture.state, button: { label: fixture.elements.primary.textContent, intent: fixture.elements.primary.dataset.answerIntent, actionId: fixture.elements.primary.dataset.actionId, disabled: fixture.elements.primary.disabled } };
  })()`) as { button: { label: string; intent: string; actionId: string; disabled: boolean }; state: { typedInitial: unknown; presentations: number } };
  assert.deepEqual(result.button, { label: "Review answer", intent: "review", actionId: "review", disabled: false });
  assert.deepEqual(result.state.typedInitial, { value: "Retained" });
  assert.equal(result.state.presentations, 1);
});

test("renders idle sessions and workflow completion projections", async (context) => {
  if (!requireBrowser(context)) return;
  await resetPage();
  const result = await page!.evaluate(`(() => {
    const fixture = window.makeAuthoring();
    fixture.controller.render(false, { builderSession: { id: "${sessionId}" }, status: "waiting" });
    const idle = { summary: fixture.elements.summary.textContent, heading: fixture.elements.context.querySelector("h2").textContent, refreshId: fixture.elements.refresh.dataset.actionId };
    fixture.controller.render(false, { workflow: { id: "done" } });
    return { idle, workflowRenders: fixture.state.workflowRenders };
  })()`);
  assert.deepEqual(result, {
    idle: { summary: "The authoring session is ready. Refresh to load its next question or completion state.", heading: "Authoring session", refreshId: "refresh" },
    workflowRenders: 1,
  });
});

test("fails closed on malformed authoring request fields", async (context) => {
  if (!requireBrowser(context)) return;
  await resetPage();
  const result = await page!.evaluate(`(() => {
    const fixture = window.makeAuthoring();
    fixture.controller.render(false, { builderSession: { id: "${sessionId}" }, humanRequest: { inputSpec: "not-an-object" } });
    return { summary: fixture.elements.summary.textContent, role: fixture.elements.summary.getAttribute("role"), disabled: fixture.elements.primary.disabled };
  })()`);
  assert.deepEqual(result, { summary: "The authoring question could not be verified. Refresh before continuing.", role: "alert", disabled: true });
});

test("refreshes the exact builder session and reconciles a retained response", async (context) => {
  if (!requireBrowser(context)) return;
  await resetPage();
  const result = await page!.evaluate(`(async () => {
    const fixture = window.makeAuthoring({ operation: { name: "loomex_builder_respond", slot: "builder:respond:${sessionId}", arguments: { sessionId: "${sessionId}" } } });
    const handled = await fixture.controller.refresh({ builderSession: { id: "${sessionId}" } });
    return { handled, calls: fixture.state.toolCalls, reconciles: fixture.state.reconciles };
  })()`) as { handled: boolean; calls: unknown[]; reconciles: number };
  assert.deepEqual(result, {
    handled: true,
    calls: [{ name: "loomex_builder_get", args: { sessionId }, renderResult: false }],
    reconciles: 1,
  });
});

test("routes review, submission, retry, and draft restoration within the builder session", async (context) => {
  if (!requireBrowser(context)) return;
  await resetPage();
  const result = await page!.evaluate(`(async () => {
    const fixture = window.makeAuthoring({ answer: { value: "Ada" } });
    const output = { builderSession: { id: "${sessionId}" }, humanRequest: { inputSpec: { question: "Name?" } } };
    fixture.elements.primary.dataset.answerIntent = "review";
    const reviewed = await fixture.controller.submit(output);
    fixture.elements.primary.dataset.answerIntent = "submit";
    const submitted = await fixture.controller.submit(output);
    const drafted = await fixture.controller.loadDraft(output);
    const retryFixture = window.makeAuthoring({ operation: { name: "loomex_builder_respond", slot: "builder:respond:${sessionId}", arguments: { sessionId: "${sessionId}" } } });
    const retried = await retryFixture.controller.submit(output);
    return { reviewed, submitted, drafted, retried, state: fixture.state, retryMutations: retryFixture.state.mutations };
  })()`) as {
    reviewed: boolean; submitted: boolean; drafted: boolean; retried: boolean;
    state: { reviews: number; restored: number; drafts: number; mutations: unknown[] };
    retryMutations: unknown[];
  };
  assert.equal(result.reviewed, true);
  assert.equal(result.submitted, true);
  assert.equal(result.drafted, true);
  assert.equal(result.retried, true);
  assert.equal(result.state.reviews, 1);
  assert.equal(result.state.restored, 1);
  assert.equal(result.state.drafts, 1);
  assert.deepEqual(result.state.mutations, [{
    name: "loomex_builder_respond", slot: `builder:respond:${sessionId}`, args: { sessionId, response: { value: "Ada" } },
  }]);
  assert.deepEqual(result.retryMutations, [{ name: "loomex_builder_respond", slot: `builder:respond:${sessionId}`, args: {} }]);
});
