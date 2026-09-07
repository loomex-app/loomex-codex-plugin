import * as assert from "node:assert/strict";
import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

declare const window: any;
declare const document: any;

type BrowserTools = {
  chromium: {
    executablePath(): string;
    launch(options: Record<string, unknown>): Promise<any>;
  };
};

async function firstExecutable(candidates: Array<string | undefined>): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next locally available browser.
    }
  }
  return undefined;
}

async function browserTools(): Promise<{ tools: BrowserTools; executablePath: string } | undefined> {
  const modulePath = process.env.LOOMEX_PLAYWRIGHT_MODULE ||
    resolve(process.cwd(), "node_modules/@playwright/test/index.mjs");
  try {
    await access(modulePath, constants.R_OK);
    const tools = await import(pathToFileURL(modulePath).href) as BrowserTools;
    const executablePath = await firstExecutable([
      process.env.LOOMEX_BROWSER_EXECUTABLE,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      tools.chromium.executablePath(),
    ]);
    return executablePath ? { tools, executablePath } : undefined;
  } catch {
    return undefined;
  }
}

async function mountApp(
  page: any,
  mode: "interaction" | "authoring" | "prepare" | "monitor" | "browser",
  data: Record<string, unknown>,
  failFirstMutation = false,
  resolveOnRead = false,
  presentation: Record<string, unknown> | null = null,
  failUiMessage = false,
  resultMeta: Record<string, unknown> = {},
) {
  const template = await readFile("assets/loomex-app.html", "utf8");
  const html = template.replace("__LOOMEX_MODE__", mode);
  const harnessUrl = `http://127.0.0.1/loomex-${mode}-${Date.now()}`;
  await page.route(harnessUrl, (route: any) => route.fulfill({
    contentType: "text/html",
    body: '<iframe id="app" title="Loomex test app" style="display:block;width:100%;height:1200px;border:0"></iframe>',
  }));
  await page.goto(harnessUrl);
  await page.evaluate(({ source, initialData, shouldFailFirst, shouldResolveOnRead, presentation, shouldFailUiMessage, resultMeta }: any) => {
    const frame = document.getElementById("app");
    window.__loomexCalls = [];
    window.__loomexMessages = [];
    window.__loomexModelContexts = [];
    window.__loomexSizes = [];
    window.addEventListener("message", (event: any) => {
      if (event.source !== frame.contentWindow) return;
      const message = event.data;
      if (message && message.method === "ui/notifications/size-changed") {
        frame.style.height = `${message.params.height}px`;
        window.__loomexSizes.push(message.params);
        return;
      }
      if (message && message.method === "ui/update-model-context") {
        window.__loomexModelContexts.push(message.params);
        return;
      }
      if (!message || message.jsonrpc !== "2.0" || message.id === undefined) return;
      if (message.method === "ui/initialize") {
        event.source.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
        return;
      }
      if (message.method === "ui/message") {
        const content = message.params?.content;
        const valid = message.params?.role === "user" && Array.isArray(content) && content.length === 1 &&
          content[0]?.type === "text" && typeof content[0]?.text === "string" && content[0].text.length > 0;
        if (!valid) {
          event.source.postMessage({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32602, message: "Invalid ui/message params" },
          }, "*");
          return;
        }
        window.__loomexMessages.push(message.params);
        event.source.postMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: shouldFailUiMessage ? { isError: true } : {},
        }, "*");
        return;
      }
      if (message.method === "tools/call") {
        window.__loomexCalls.push(message.params);
        if (window.__rejectNextToolCall) {
          window.__rejectNextToolCall = false;
          event.source.postMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Runner bridge rejected the call" } }, "*");
          return;
        }
        if (window.__dropNextToolResponse) {
          window.__dropNextToolResponse = false;
          return;
        }
        const callNumber = window.__loomexCalls.length;
        const resultData = shouldResolveOnRead && message.params.name === "loomex_interaction_get"
          ? {
              ...initialData,
              humanRequest: {
                ...initialData.humanRequest,
                status: "resolved",
                answer: { value: "Submitted once" },
              },
            }
          : initialData;
        const result = window.__workflowResponses?.length ? window.__workflowResponses.shift() : shouldFailFirst && callNumber === 1
          ? {
              isError: true,
              structuredContent: {
                ok: false,
                error: { code: "NETWORK_AMBIGUOUS", message: "Safe failure" },
              },
            }
          : { structuredContent: { ok: true, data: resultData } };
        window.setTimeout(() => {
          event.source.postMessage({ jsonrpc: "2.0", id: message.id, result }, "*");
          if (window.__failModelContextAfterNextToolResponse) {
            window.__failModelContextAfterNextToolResponse = false;
            const original = window.postMessage;
            window.postMessage = function(nextMessage: any, ...rest: any[]) {
              if (nextMessage?.method === "ui/update-model-context") {
                window.postMessage = original;
                throw new Error("Forced model-context post failure");
              }
              return original.call(this, nextMessage, ...rest);
            };
          }
        }, shouldFailFirst && callNumber === 1 ? 120 : Number(window.__workflowDelayMs || 0));
      }
    });
    frame.addEventListener("load", () => {
      frame.contentWindow.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent: { ok: true, data: initialData }, _meta: { "loomex/preparationReview": presentation, ...resultMeta } },
      }, "*");
    }, { once: true });
    frame.srcdoc = source;
  }, {
    source: html,
    initialData: data,
    shouldFailFirst: failFirstMutation,
    shouldResolveOnRead: resolveOnRead,
    presentation,
    shouldFailUiMessage: failUiMessage,
    resultMeta,
  });
  try {
    await page.waitForFunction(() =>
      document.getElementById("app")?.contentDocument?.getElementById("connection")?.textContent === "Connected",
      undefined,
      { timeout: 5_000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const frame = document.getElementById("app");
      return {
        connection: frame?.contentDocument?.getElementById("connection")?.textContent,
        body: frame?.contentDocument?.body?.innerText,
        calls: window.__loomexCalls,
      };
    });
    throw new Error(`Embedded app did not connect: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  const app = page.frameLocator("#app");
  return app;
}

async function waitForCallCount(page: any, count: number): Promise<void> {
  try {
    await page.waitForFunction((expected: number) => window.__loomexCalls.length === expected, count, { timeout: 5_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      calls: window.__loomexCalls,
      summary: document.getElementById("app")?.contentDocument?.getElementById("summary")?.textContent,
    }));
    throw new Error(`Expected ${count} tool calls: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
}

async function waitForSettledAppSize(page: any, afterNotificationCount?: number): Promise<void> {
  await page.waitForFunction((after: number | undefined) => {
    const frame = document.getElementById("app");
    const main = frame?.contentDocument?.querySelector("main");
    const sizes = window.__loomexSizes;
    if (!main || !sizes?.length || (after !== undefined && sizes.length <= after)) return false;
    const expected = Math.ceil(main.getBoundingClientRect().height);
    return sizes[sizes.length - 1].height === expected && Number.parseFloat(frame.style.height) === expected;
  }, afterNotificationCount);
  const sizes = await page.evaluate(async () => {
    const before = window.__loomexSizes.length;
    for (let frame = 0; frame < 3; frame += 1) await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    return { before, after: window.__loomexSizes.length };
  });
  assert.equal(sizes.after, sizes.before, "Content-size notifications must settle rather than loop");
  assert.ok(sizes.after <= 12, "A static view must not repeatedly report the same size");
}

async function captureRequestedScreenshots(page: any): Promise<void> {
  const directory = process.env.LOOMEX_UI_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const frame = page.locator("#app");
  await page.setViewportSize({ width: 820, height: 1300 });
  await page.emulateMedia({ colorScheme: "light" });
  await frame.evaluate((element: any) => { element.style.height = `${element.contentDocument.documentElement.scrollHeight}px`; });
  await frame.screenshot({ path: resolve(directory, "question-form-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await frame.screenshot({ path: resolve(directory, "question-form-dark.png") });
  await page.setViewportSize({ width: 390, height: 1300 });
  await page.emulateMedia({ colorScheme: "light" });
  await frame.evaluate((element: any) => { element.style.height = `${element.contentDocument.documentElement.scrollHeight}px`; });
  await frame.screenshot({ path: resolve(directory, "question-form-mobile.png") });
  await page.setViewportSize({ width: 820, height: 1300 });
}

const options = [
  { id: "alpha", label: "Alpha" },
  { id: "beta", label: "Beta" },
];

test("question UI collects seven mixed answer types, validates, preserves drafts, and retries one mutation key", async (t) => {
  const available = await browserTools();
  if (!available) {
    if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser");
    t.skip("Playwright or a local Chromium executable is unavailable");
    return;
  }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 820, height: 1300 }, colorScheme: "light" });
  const requestId = "aa7843c2-7694-426a-ae51-fbc3af88d415";
  const questions = [
    { id: "plain", inputType: "text", question: "Short answer?" },
    { id: "details", inputType: "long_text", question: "Detailed answer?" },
    { id: "due", inputType: "date", question: "Due date?" },
    { id: "score", inputType: "rating", question: "Score?", minimum: 2, maximum: 6 },
    { id: "enabled", inputType: "boolean", question: "Enable it?" },
    { id: "choice", inputType: "radio", question: "Choose one?", options, allowOther: true, otherLabel: "Something else" },
    { id: "features", inputType: "checkbox", question: "Choose several?", options, allowOther: true, otherLabel: "Another feature" },
  ];
  const initialData = {
    humanRequest: {
      id: requestId,
      type: "manual_input",
      title: "Complete the launch details",
      description: "Every answer is sent to this workflow.",
      prompt: "Use exact values.",
      inputSpec: {
        schemaVersion: "loomex.human-input/v2",
        collectionMode: "batch",
        inputType: "text",
        question: "Launch details",
        questions,
      },
      responseSchema: {
        type: "object",
        properties: { answers: { type: "array" } },
        required: ["answers"],
      },
    },
  };
  const app = await mountApp(page, "interaction", initialData, true);
  await captureRequestedScreenshots(page);

  assert.equal(await app.locator("#diagnostics").count(), 0);
  assert.equal(await app.locator("#state").count(), 0);
  await app.getByText("7 questions · * Required", { exact: true }).waitFor();
  await app.getByText("Your response is needed to continue.", { exact: true }).waitFor();
  assert.equal(await app.locator("fieldset").count(), 7);
  assert.equal(await app.locator("textarea").count(), 1);
  await app.getByRole("textbox", { name: "Short answer? Your answer" }).waitFor();
  await app.getByRole("textbox", { name: "Detailed answer? Your answer" }).waitFor();
  assert.match(await app.locator("#question-2-value").ariaSnapshot(), /Due date\? Date/);
  assert.equal(await app.getByRole("radiogroup", { name: "Score?" }).getByRole("radio").count(), 5);
  assert.equal(await app.locator("#question-0-value").getAttribute("aria-labelledby"), "question-0-legend question-0-control-label");
  assert.equal(await app.getByRole("group", { name: /Enable it/ }).getByRole("radio", { checked: true }).count(), 0);

  await app.locator("#question-0-value").fill("Ada");
  await app.locator("#question-1-value").fill("Keep this detailed draft after errors.");
  await app.locator("#question-2-value").evaluate((control: any) => {
    control.type = "text";
    control.value = "2025-02-30";
  });
  await app.locator('label[for="question-3-rating-4"]').click();
  await app.locator("#question-4-false").check();
  await app.locator("#question-5-other-choice").check();
  assert.equal(await app.locator("#question-5-other-entry").isVisible(), true);
  await app.locator("#question-5-other-text").fill("Custom choice");
  await app.locator("#question-6-option-0").check();
  await app.locator("#question-6-other-choice").check();
  await app.locator("#question-6-other-text").fill("Custom feature");

  await app.getByRole("button", { name: "Continue" }).click();
  await app.locator("#question-2-error").getByText("Enter a real date in YYYY-MM-DD format.").waitFor();
  assert.equal((await page.evaluate(() => window.__loomexCalls.length)), 0);
  assert.equal(await app.locator("#question-1-value").inputValue(), "Keep this detailed draft after errors.");

  await app.locator("#question-2-value").evaluate((control: any) => {
    control.type = "date";
    control.value = "2024-02-29";
  });
  await app.getByRole("button", { name: "Continue" }).evaluate((button: any) => {
    button.click();
    button.click();
  });
  await waitForCallCount(page, 1);
  await app.getByText("submission outcome is uncertain", { exact: false }).waitFor();
  assert.equal(await app.locator("#question-0-value").inputValue(), "Ada");
  assert.equal(await app.locator("#question-5-other-text").inputValue(), "Custom choice");
  assert.equal(await app.locator("#question-0-value").isDisabled(), true);
  await app.locator("#question-0-value").evaluate((control: any) => { control.value = "Edited after ambiguity"; });

  await app.getByRole("button", { name: "Refresh" }).click();
  await waitForCallCount(page, 2);
  await app.getByText("server still reports this request as pending", { exact: false }).waitFor();
  assert.equal(await app.locator("#question-0-value").isDisabled(), true);
  await app.getByRole("button", { name: "Retry exact response" }).click();
  await waitForCallCount(page, 3);
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.equal(calls[0].name, "loomex_interaction_respond");
  assert.equal(calls[1].name, "loomex_interaction_get");
  assert.deepEqual(calls[1].arguments, { requestId });
  assert.deepEqual(calls[0].arguments, calls[2].arguments);
  assert.deepEqual(calls[0].arguments.answer, {
    answers: [
      { questionId: "plain", value: "Ada" },
      { questionId: "details", value: "Keep this detailed draft after errors." },
      { questionId: "due", value: "2024-02-29" },
      { questionId: "score", value: 4 },
      { questionId: "enabled", value: false },
      { questionId: "choice", value: "other", otherText: "Custom choice" },
      { questionId: "features", values: ["alpha", "other"], otherText: "Custom feature" },
    ],
  });
  assert.deepEqual(Object.keys(calls[0].arguments.answer), ["answers"]);
});

test("refresh reconciles an ambiguous response that the server reports as resolved", async (t) => {
  const available = await browserTools();
  if (!available) {
    if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser");
    t.skip("Playwright or a local Chromium executable is unavailable");
    return;
  }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = "f0f3fa2d-d9af-4411-9ce3-7958bf5c413a";
  const app = await mountApp(page, "interaction", {
    humanRequest: {
      id: requestId,
      status: "pending",
      type: "manual_input",
      title: "One response only",
      inputSpec: { inputType: "text", question: "What should happen?" },
      responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    },
  }, true, true);

  await app.getByRole("textbox", { name: "What should happen? Your answer" }).fill("Submitted once");
  await app.getByRole("button", { name: "Continue" }).click();
  await waitForCallCount(page, 1);
  await app.getByText("submission outcome is uncertain", { exact: false }).waitFor();
  await app.getByRole("button", { name: "Refresh" }).click();
  await waitForCallCount(page, 2);
  await app.getByText("uncertain submission was reconciled", { exact: false }).waitFor();
  assert.equal(await app.locator("#form").isHidden(), true);
  assert.equal(await app.getByRole("button", { name: "Retry exact response" }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Continue" }).count(), 0);
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_interaction_respond", "loomex_interaction_get"]);
  assert.deepEqual(calls[1].arguments, { requestId });
});

test("ambiguous approval keeps rejection locked and retries the exact approval operation", async (t) => {
  const available = await browserTools();
  if (!available) {
    if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser");
    t.skip("Playwright or a local Chromium executable is unavailable");
    return;
  }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = "8e313122-4210-4d2a-a163-bd86a30016af";
  const app = await mountApp(page, "interaction", {
    humanRequest: {
      id: requestId,
      status: "pending",
      type: "approval",
      title: "Approve the release?",
    },
  }, true);

  await app.getByRole("button", { name: "Approve" }).click();
  await waitForCallCount(page, 1);
  await app.getByText("submission outcome is uncertain", { exact: false }).waitFor();
  const reject = app.getByRole("button", { name: "Reject" });
  assert.equal(await reject.isDisabled(), true);

  await reject.evaluate((button: any) => {
    button.disabled = false;
    button.click();
  });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.__loomexCalls.length), 1);
  assert.equal(await reject.isDisabled(), true);

  await app.getByRole("button", { name: "Retry exact response" }).click();
  await waitForCallCount(page, 2);
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_interaction_decide", "loomex_interaction_decide"]);
  assert.deepEqual(calls[0].arguments, calls[1].arguments);
  assert.equal(calls[0].arguments.requestId, requestId);
  assert.equal(calls[0].arguments.decision, "approve");
});

test("authoring supports aliases and simple schemas while rejecting invalid question specs", async (t) => {
  const available = await browserTools();
  if (!available) {
    if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser");
    t.skip("Playwright or a local Chromium executable is unavailable");
    return;
  }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const sessionId = "bb7843c2-7694-426a-ae51-fbc3af88d415";
  const app = await mountApp(page, "authoring", {
    builderSession: { id: sessionId },
    humanRequest: {
      id: "cc7843c2-7694-426a-ae51-fbc3af88d415",
      title: "Clarify the workflow",
      inputSpec: { inputType: "textarea", question: "Describe the desired behavior" },
      responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    },
  });
  const textarea = app.getByRole("textbox", { name: "Your answer" });
  await textarea.fill("Preserve the inputSpec prompt.");
  await app.getByRole("button", { name: "Continue" }).click();
  await waitForCallCount(page, 1);
  const [call] = await page.evaluate(() => window.__loomexCalls);
  assert.equal(call.name, "loomex_builder_respond");
  assert.deepEqual(call.arguments.response, { value: "Preserve the inputSpec prompt." });

  const fallbackPage = await browser.newPage();
  const fallback = await mountApp(fallbackPage, "interaction", {
    humanRequest: {
      id: "dd7843c2-7694-426a-ae51-fbc3af88d415",
      type: "manual_input",
      responseSchema: { type: "object", properties: { comment: { type: "string" } }, required: ["comment"] },
    },
  });
  assert.equal(await fallback.locator("fieldset").count(), 0);
  await fallback.getByRole("textbox", { name: "comment" }).fill("Schema fallback remains available");
  await fallback.getByRole("button", { name: "Continue" }).click();
  await waitForCallCount(fallbackPage, 1);
  const [fallbackCall] = await fallbackPage.evaluate(() => window.__loomexCalls);
  assert.deepEqual(fallbackCall.arguments.answer, { comment: "Schema fallback remains available" });

  const invalidPage = await browser.newPage();
  const invalid = await mountApp(invalidPage, "interaction", {
    humanRequest: {
      id: "ee7843c2-7694-426a-ae51-fbc3af88d415",
      type: "manual_input",
      inputSpec: { inputType: "file", question: "Upload a file" },
      responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    },
  });
  await invalid.getByRole("alert").getByText("This question cannot be displayed here", { exact: false }).first().waitFor();
  assert.equal(await invalid.getByRole("button", { name: "Continue" }).isDisabled(), true);
});

test("single questions remove repeated copy and safe presentations add progress and acceptance context", async (t) => {
  const available = await browserTools();
  if (!available) { assert.fail("Chromium is required for the presentation gate"); }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());

  const page = await browser.newPage();
  const question = "What would you like to build?";
  let app = await mountApp(page, "interaction", {
    humanRequest: {
      id: "27acbb74-e5ee-4896-b4b1-86ed6b048fe0",
      type: "manual_input",
      title: "Describe Your Idea",
      description: question,
      prompt: "A sentence or two is enough to begin.",
      context: { previousOutputs: { privateTransportData: "must-not-render" } },
      presentation: {
        version: 1,
        kind: "clarification",
        question,
        stageLabel: "Clarify",
        summary: "We have the goal and are narrowing the workflow behavior.",
        decisions: ["Use the existing Loomex workspace."],
        openQuestions: [question, "Which output should be easiest to review?"],
        previousOutputs: ["must-not-render-either"],
      },
      inputSpec: { inputType: "long_text", question, collectionMode: "single" },
      responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    },
  });
  assert.equal(await app.locator("legend").filter({ hasText: question }).count(), 1);
  assert.equal(await app.locator(".request-copy").getByText(question, { exact: true }).count(), 0);
  assert.equal(await app.getByText(/1 question/).count(), 0);
  await app.getByText("A sentence or two is enough to begin.", { exact: true }).waitFor();
  await app.getByRole("heading", { name: "Describe Your Idea", exact: true }).waitFor();
  assert.equal(await app.locator("h2").count(), 1);
  await app.locator('[aria-current="step"]').getByText("Clarify", { exact: true }).waitFor();
  const requirementsContext = app.locator("#context details.ui-disclosure");
  await app.getByText("Requirements context (2 items)", { exact: true }).waitFor();
  assert.equal(await requirementsContext.evaluate((details: any) => details.open), false);
  assert.equal(await app.getByText("Use the existing Loomex workspace.", { exact: true }).isVisible(), false);
  assert.equal(await app.getByText("Which output should be easiest to review?", { exact: true }).isVisible(), false);
  await app.getByText("Requirements context (2 items)", { exact: true }).click();
  await app.getByText("Use the existing Loomex workspace.", { exact: true }).waitFor();
  await app.getByText("Which output should be easiest to review?", { exact: true }).waitFor();
  assert.doesNotMatch(await app.locator("body").innerText(), /must-not-render/);
  await app.getByRole("button", { name: "Continue", exact: true }).waitFor();
  await app.getByRole("button", { name: "Refresh", exact: true }).waitFor();

  const reviewPage = await browser.newPage();
  await reviewPage.setViewportSize({ width: 390, height: 900 });
  const noncanonicalStage = `Post-build review ${"x".repeat(500)}`;
  app = await mountApp(reviewPage, "interaction", {
    humanRequest: {
      id: "39f69fd1-e9ca-4700-8c31-0fa7fc009517",
      type: "manual_input",
      title: "Review Implementation",
      description: "The requested dashboard is ready for review.",
      prompt: "Choose whether to accept this implementation.",
      context: { previousOutputs: { implementation: "raw-output-must-not-render" } },
      presentation: {
        version: 1,
        kind: "review",
        question: "Does this meet your requirements?",
        stageLabel: noncanonicalStage,
        summary: "The requested dashboard is ready for review.",
        changedFiles: ["src/dashboard.ts"],
        verification: ["Chrome interaction check passed."],
        limitations: ["No hosted preview is available."],
        artifacts: ["Local dashboard source"],
        decisions: ["Keep the existing API contract."],
      },
      inputSpec: { inputType: "boolean", question: "Does this meet your requirements?" },
      responseSchema: { type: "object", properties: { value: { type: "boolean" } }, required: ["value"] },
    },
  });
  await app.getByRole("heading", { name: "Review Implementation", exact: true }).waitFor();
  assert.equal(await app.locator("h2").count(), 1);
  assert.equal(await app.getByText(/Requirements context \(/).count(), 0);
  await app.getByRole("heading", { name: "Decisions", exact: true }).waitFor();
  await app.getByText("Keep the existing API contract.", { exact: true }).waitFor();
  assert.equal(await app.getByText("Keep the existing API contract.", { exact: true }).locator("xpath=ancestor::details").count(), 0);
  assert.equal(await app.getByText("The requested dashboard is ready for review.", { exact: true }).count(), 1);
  await app.getByText("Choose whether to accept this implementation.", { exact: true }).waitFor();
  await app.getByText(noncanonicalStage, { exact: true }).waitFor();
  assert.equal(await app.locator('[aria-current="step"]').count(), 0);
  assert.equal(await app.locator("body").evaluate((body: any) => body.scrollWidth <= body.clientWidth), true);
  for (const copy of ["src/dashboard.ts", "Chrome interaction check passed.", "No hosted preview is available.", "Local dashboard source"]) {
    await app.getByText(copy, { exact: true }).waitFor();
  }
  assert.doesNotMatch(await app.locator("body").innerText(), /raw-output-must-not-render/);
  await app.getByRole("radio", { name: "Request changes", exact: true }).check();
  await app.getByRole("button", { name: "Continue", exact: true }).click();
  await waitForCallCount(reviewPage, 1);
  const [call] = await reviewPage.evaluate(() => window.__loomexCalls);
  assert.equal(call.name, "loomex_interaction_respond");
  assert.deepEqual(call.arguments.answer, { value: false });
});

test("approval copy is deduplicated and failed authoritative state locks mutations until refresh", async (t) => {
  const available = await browserTools();
  if (!available) { assert.fail("Chromium is required for the stale-state interaction gate"); }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = "73549247-2468-4bab-9355-526a92fc4ee4";
  const app = await mountApp(page, "interaction", {
    humanRequest: {
      id: requestId,
      status: "pending",
      type: "approval",
      title: "Approve deployment?",
      prompt: "Approve deployment?",
    },
  });
  assert.equal(await app.getByText("Approve deployment?", { exact: true }).count(), 1);
  assert.equal(await app.getByRole("button", { name: "Approve", exact: true }).isEnabled(), true);
  assert.equal(await app.getByRole("button", { name: "Reject", exact: true }).isEnabled(), true);

  await page.evaluate(() => document.getElementById("app").contentWindow.postMessage({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: {
      isError: true,
      structuredContent: { ok: false, error: { code: "READ_FAILED", message: "Safe failure" } },
    },
  }, "*"));
  await app.locator('#summary[role="alert"]').waitFor();
  assert.equal(await app.getByRole("button", { name: "Approve", exact: true }).isDisabled(), true);
  assert.equal(await app.getByRole("button", { name: "Reject", exact: true }).isDisabled(), true);
  assert.equal(await app.getByRole("button", { name: "Refresh", exact: true }).isEnabled(), true);

  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await waitForCallCount(page, 1);
  await app.getByText("Your response is needed to continue.", { exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Approve", exact: true }).isEnabled(), true);
  assert.equal(await app.getByRole("button", { name: "Reject", exact: true }).isEnabled(), true);
});

test("run monitoring projects safe state and removes terminal actions", async (t) => {
  const available = await browserTools();
  if (!available) { assert.fail("Chromium is required for the monitoring gate"); }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const runId = "b53cf793-7173-4131-81c6-90797569dfa7";
  const app = await mountApp(page, "monitor", {
    execution: {
      id: runId,
      status: "completed",
      workflowName: "Idea to Implementation",
      currentNodeName: "Final result",
      currentNodeId: "internal-node-id",
      stageLabel: "Review",
      startedAt: "2026-09-06T08:00:00.000Z",
      completedAt: "2026-09-06T08:02:05.000Z",
      result: {
        version: 1,
        summary: "The app is ready.",
        changedFiles: ["src/app.ts"],
        verification: ["Chrome smoke check passed."],
        limitations: ["Deployment was not requested."],
        artifacts: ["Generated app source"],
        previousOutputs: ["ignored-internal-output"],
      },
    },
  });
  await app.getByRole("heading", { name: "Idea to Implementation", exact: true }).waitFor();
  await app.getByText("2m 5s", { exact: true }).waitFor();
  for (const copy of ["The app is ready.", "src/app.ts", "Chrome smoke check passed.", "Deployment was not requested.", "Generated app source"]) {
    await app.getByText(copy, { exact: true }).waitFor();
  }
  const visible = await app.locator("body").innerText();
  assert.doesNotMatch(visible, /2026-09-06T08:00:00|ignored-internal-output|b53cf793|internal-node-id/);
  assert.equal(await app.getByRole("button", { name: "Wait for update" }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Cancel run" }).count(), 0);
  assert.equal(await app.locator('#form input[data-field="reason"]').count(), 0);
  assert.equal(await app.locator("#primary").isHidden(), true);
  assert.equal(await app.locator("#primary").isDisabled(), true);
  assert.equal(await app.locator("#secondary").isHidden(), true);
  assert.equal(await app.locator("#secondary").isDisabled(), true);
  await app.locator("#primary").evaluate((button: any) => button.dispatchEvent(new Event("click")));
  await app.locator("#secondary").evaluate((button: any) => button.dispatchEvent(new Event("click")));
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__loomexCalls.length), 0);
  assert.match(await app.locator("details").last().textContent(), new RegExp(runId));

  const activePage = await browser.newPage();
  const active = await mountApp(activePage, "monitor", {
    execution: {
      id: "547cf27e-ad0b-49ba-943c-b5b2dffec8f6",
      status: "running",
      workflowName: "Idea to Implementation",
      currentNodeName: "Build application",
      stageLabel: "Build",
      startedAt: new Date().toISOString(),
    },
  });
  await active.getByRole("textbox", { name: "Cancellation reason", exact: true }).waitFor();
  await active.getByRole("button", { name: "Wait for update", exact: true }).click();
  await waitForCallCount(activePage, 1);
  assert.equal((await activePage.evaluate(() => window.__loomexCalls))[0].name, "loomex_run_wait");
  await active.locator('#form input[data-field="reason"]').fill("The requirements changed.");
  await active.getByRole("button", { name: "Cancel run", exact: true }).click();
  await waitForCallCount(activePage, 2);
  const activeCalls = await activePage.evaluate(() => window.__loomexCalls);
  assert.equal(activeCalls[1].name, "loomex_run_cancel");
  assert.equal(activeCalls[1].arguments.reason, "The requirements changed.");

  const pagedPage = await browser.newPage();
  const responseRef = "ac567746-f978-40bb-a3e1-b8bf077378a0";
  const paged = await mountApp(pagedPage, "monitor", {
    responseRef,
    sizeBytes: 401_408,
    encoding: "json",
    nextOffset: 0,
    checksumSha256: "trusted-checksum-reference",
  });
  await paged.getByRole("heading", { name: "Full results available", exact: true }).waitFor();
  assert.doesNotMatch(await paged.locator("body").innerText(), new RegExp(responseRef));
  await paged.getByRole("button", { name: "View results", exact: true }).click();
  await pagedPage.waitForFunction(() => window.__loomexMessages.length === 1);
  const [message] = await pagedPage.evaluate(() => window.__loomexMessages);
  assert.deepEqual(message, {
    role: "user",
    content: [{
      type: "text",
      text: `Read and present the complete Loomex result using loomex_response_read with responseRef ${responseRef}. Begin at offset 0, continue through every nextOffset, and verify checksumSha256 before presenting it.`,
    }],
  });
  await paged.getByText("The conversation has been asked to retrieve and present the complete result.", { exact: true }).waitFor();

  const rejectedPage = await browser.newPage();
  const rejected = await mountApp(rejectedPage, "monitor", {
    responseRef,
    sizeBytes: 401_408,
    encoding: "json",
    nextOffset: 0,
  }, false, false, null, true);
  await rejected.getByRole("button", { name: "View results", exact: true }).click();
  await rejected.getByText("The host could not send this result request. Continue in the conversation to retrieve it.", { exact: true }).waitFor();
  assert.equal(await rejected.getByText("The conversation has been asked to retrieve and present the complete result.", { exact: true }).count(), 0);
});

test("run monitor answers a typed batch and approval against one authoritative run", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for in-app run interaction");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 760, height: 1100 } });
  const runId = "10c7b0d2-a45e-4f07-b0a7-061e7bd24692";
  const organizationId = "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2";
  const firstRequestId = "20aa6a5d-34cd-4a53-a9ea-06a249ec41bf";
  const approvalId = "73fd9a53-b42c-46d9-b148-6665bfc66963";
  const execution = { id: runId, organizationId, status: "waiting", workflowName: "Idea to Implementation", requiredAction: "Answer the workflow question" };
  const firstRequest = {
    id: firstRequestId, status: "pending", type: "manual_input", execution: { id: runId, organizationId },
    title: "Shape the idea",
    inputSpec: { schemaVersion: "loomex.human-input/v2", collectionMode: "batch", inputType: "text", question: "Idea details", questions: [
      { id: "idea", inputType: "long_text", question: "What should we build?" },
      { id: "confirmed", inputType: "boolean", question: "Are these requirements complete?" },
    ] },
    responseSchema: { type: "object", properties: { answers: { type: "array" } }, required: ["answers"] },
  };
  const app = await mountApp(page, "monitor", { execution, humanRequest: firstRequest, waitState: "human_action_required" });
  await app.getByRole("textbox", { name: "What should we build? Your answer" }).fill("A local planning board");
  await app.locator("#question-1-false").check();
  assert.equal(await app.getByRole("button", { name: "Cancel run", exact: true }).count(), 1, "cancellation stays separate from the answer form");

  const approval = {
    id: approvalId, status: "pending", type: "approval", execution: { id: runId, organizationId },
    title: "Approve implementation?", prompt: "Approve the reviewed plan before implementation.",
  };
  await page.evaluate(({ execution, firstRequestId, approval }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: { requestId: firstRequestId, requestStatus: "resolved", executionId: execution.id, executionStatus: "queued", error: null } } },
    { structuredContent: { ok: true, data: { execution: { ...execution, requiredAction: "Approve implementation" }, humanRequest: approval, waitState: "human_action_required" } } },
  ]; }, { execution, firstRequestId, approval });
  await app.getByRole("button", { name: "Continue", exact: true }).click();
  await app.getByRole("button", { name: "Approve", exact: true }).waitFor();
  const firstCalls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(firstCalls.map((call: any) => call.name), ["loomex_interaction_respond", "loomex_run_get"]);
  assert.deepEqual(firstCalls[0].arguments.answer, { answers: [
    { questionId: "idea", value: "A local planning board" },
    { questionId: "confirmed", value: false },
  ] });
  assert.equal(firstCalls[0].arguments.requestId, firstRequestId);
  assert.deepEqual(firstCalls[1].arguments, { runId });

  const terminal = { execution: { ...execution, status: "completed", requiredAction: undefined, result: { version: 1, summary: "Implementation complete." } } };
  await page.evaluate(({ runId, approvalId, terminal }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: { requestId: approvalId, requestStatus: "approved", executionId: runId, executionStatus: "queued", error: null } } },
    { structuredContent: { ok: true, data: terminal } },
  ]; }, { runId, approvalId, terminal });
  await app.getByRole("button", { name: "Approve", exact: true }).click();
  await app.getByText("Implementation complete.", { exact: true }).waitFor();
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_interaction_respond", "loomex_run_get", "loomex_interaction_decide", "loomex_run_get"]);
  assert.equal(calls[2].arguments.requestId, approvalId);
  assert.equal(calls[2].arguments.decision, "approve");
  assert.equal(await app.getByRole("button", { name: "Continue" }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Approve" }).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.__loomexMessages), [], "supported human requests never require a chat handoff");
});

test("run monitor preserves exact ambiguous responses and rejects stale authoritative reads", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for run interaction recovery");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 720, height: 900 } });
  const runId = "6ce1d68a-8bc8-4c6a-bfd1-00aa94f34bbf";
  const requestId = "42660045-2c5c-4761-929c-4580d524fbbb";
  const organizationId = "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2";
  const execution = { id: runId, organizationId, status: "waiting", workflowName: "Resilient workflow" };
  const request = { id: requestId, status: "pending", type: "manual_input", execution: { id: runId, organizationId },
    inputSpec: { inputType: "long_text", question: "Describe the exact goal" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  const app = await mountApp(page, "monitor", { execution, humanRequest: request, waitState: "human_action_required" });
  const answer = app.getByRole("textbox", { name: "Describe the exact goal Your answer" });
  await answer.fill("Keep this exact answer");
  await page.evaluate(() => { window.__workflowResponses = [{ isError: true, structuredContent: { ok: false, error: { code: "NETWORK_AMBIGUOUS", message: "The response outcome is unknown" } } }]; });
  await app.getByRole("button", { name: "Continue", exact: true }).click();
  await app.getByRole("button", { name: "Retry exact response", exact: true }).waitFor({ timeout: 5_000 });
  const sealed = (await page.evaluate(() => window.__loomexCalls))[0];
  assert.equal(await answer.isDisabled(), true);

  await page.evaluate(({ requestId, runId }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: { requestId, requestStatus: "resolved", executionId: runId, executionStatus: "queued", error: null } } },
    { isError: true, structuredContent: { ok: false, error: { code: "RUNNER_UNAVAILABLE", message: "Unavailable" } } },
  ]; }, { requestId, runId });
  await app.getByRole("button", { name: "Retry exact response", exact: true }).click();
  await app.getByText("The response was accepted, but the current run status could not be verified.", { exact: false }).waitFor({ timeout: 5_000 });
  const afterAccepted = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(afterAccepted[1].arguments, sealed.arguments, "an ambiguous response retries the exact request and idempotency key");
  assert.equal(afterAccepted[2].name, "loomex_run_get");
  assert.equal(afterAccepted.filter((call: any) => call.name === "loomex_interaction_respond").length, 2);
  assert.equal(await app.getByRole("button", { name: "Retry exact response" }).count(), 0, "a failed read cannot resurrect an accepted mutation");
  assert.equal(await app.getByRole("button", { name: "Continue" }).count(), 0);

  await page.evaluate(({ execution, request }: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution: { ...execution, id: "9bec6165-9935-4199-b680-8f5f0f0b16fa" }, humanRequest: request, waitState: "human_action_required",
  } } }]; }, { execution, request });
  await app.getByRole("button", { name: "Refresh run", exact: true }).click();
  await waitForCallCount(page, 4);
  await app.getByText("The response was accepted, but the current run status could not be verified.", { exact: false }).waitFor();
  assert.doesNotMatch(await app.locator("body").innerText(), /9bec6165-9935-4199-b680-8f5f0f0b16fa/);
  assert.equal(await app.getByRole("button", { name: "Continue" }).count(), 0, "a substituted run cannot restore an answered form");
  assert.deepEqual(await page.evaluate(() => window.__loomexMessages), []);
});

test("run monitor preserves a current-request draft and rejects another pending request", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for authoritative request checks");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const runId = "593068dc-296b-447c-983a-3aaf5e5526d7";
  const requestId = "ad397ae3-9d5b-49e4-bbd3-40efb346d91e";
  const execution = { id: runId, status: "waiting", workflowName: "Current request workflow" };
  const request = { id: requestId, status: "pending", type: "manual_input", execution: { id: runId },
    inputSpec: { inputType: "text", question: "Current question" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  const app = await mountApp(page, "monitor", { execution, humanRequest: request, waitState: "human_action_required", latestSequence: 10 });
  const input = app.getByRole("textbox", { name: "Current question Your answer" });
  await input.fill("Unsaved local draft");
  const newer = { ...request, id: "d550b6c9-bf1e-419a-a9d4-72c3c2c5eeef", inputSpec: { inputType: "text", question: "Substituted question" } };
  await page.evaluate(({ execution, newer }: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: { execution, humanRequest: newer, waitState: "human_action_required", latestSequence: 10 } } }]; }, { execution, newer });
  await app.getByRole("button", { name: "Refresh run", exact: true }).click();
  await app.getByText("different request before the current response was resolved", { exact: false }).waitFor();
  assert.equal(await app.getByText("Substituted question", { exact: true }).count(), 0);
  assert.equal(await input.inputValue(), "Unsaved local draft");
  assert.equal(await app.getByRole("button", { name: "Continue", exact: true }).isEnabled(), true);

  await page.evaluate(({ execution, request }: any) => document.getElementById("app").contentWindow.postMessage({
    jsonrpc: "2.0", method: "ui/notifications/tool-result",
    params: { structuredContent: { ok: true, data: { execution, humanRequest: request, waitState: "human_action_required", latestSequence: 10 } } },
  }, "*"), { execution, request });
  await app.getByRole("textbox", { name: "Current question Your answer" }).waitFor();
  assert.equal(await input.inputValue(), "Unsaved local draft", "refreshing the same authoritative request preserves its draft");
  await page.evaluate(({ execution, newer }: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution, humanRequest: newer, waitState: "human_action_required", latestSequence: 11,
  } } }]; }, { execution, newer });
  await app.getByRole("button", { name: "Refresh run", exact: true }).click();
  await waitForCallCount(page, 2);
  await app.getByRole("textbox", { name: "Substituted question Your answer" }).waitFor();
  assert.equal(await app.getByRole("textbox", { name: "Substituted question Your answer" }).inputValue(), "", "a proven successor cannot inherit the prior draft");
  assert.equal(await app.getByText("Current question", { exact: true }).count(), 0);
  await page.evaluate(({ execution, request }: any) => document.getElementById("app").contentWindow.postMessage({
    jsonrpc: "2.0", method: "ui/notifications/tool-result",
    params: { structuredContent: { ok: true, data: { execution, humanRequest: request, waitState: "human_action_required", latestSequence: 9 } } },
  }, "*"), { execution, request });
  await app.getByText("older run snapshot", { exact: false }).waitFor();
  await app.getByRole("textbox", { name: "Substituted question Your answer" }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls)).map((call: any) => call.name), ["loomex_run_get", "loomex_run_get"]);
});

test("authoritative successor state reconciles an ambiguous response without reusing its answer", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for run reconciliation");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const runId = "86cc60a2-e8ec-40ca-a433-151a9ff241e1";
  const firstId = "90b7db10-bd7c-466b-a5f6-8c8ced59da0d";
  const secondId = "f3488c1a-5597-4d80-9e7b-d74e50871f25";
  const execution = { id: runId, status: "waiting", workflowName: "Reconciled workflow" };
  const request = (id: string, question: string) => ({ id, status: "pending", type: "manual_input", execution: { id: runId },
    inputSpec: { inputType: "text", question }, responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } });
  const app = await mountApp(page, "monitor", { execution, humanRequest: request(firstId, "First question"), latestSequence: 20 }, true);
  await app.getByRole("textbox", { name: "First question Your answer" }).fill("Sealed first answer");
  await app.getByRole("button", { name: "Continue", exact: true }).click();
  await app.getByRole("button", { name: "Retry exact response", exact: true }).waitFor();
  await page.evaluate(({ execution, successor }: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution, humanRequest: successor, latestSequence: 21,
  } } }]; }, { execution, successor: request(secondId, "Second question") });
  await app.getByRole("button", { name: "Refresh run", exact: true }).click();
  await app.getByRole("textbox", { name: "Second question Your answer" }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Retry exact response" }).count(), 0);
  assert.equal(await app.getByRole("textbox", { name: "Second question Your answer" }).inputValue(), "");
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_interaction_respond", "loomex_run_get"]);
  assert.equal(calls[0].arguments.requestId, firstId);
});

test("invalid terminal request projection cannot partially consume pending interaction state", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for atomic snapshot validation");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const runId = "8756ed7d-ab76-418d-89eb-05466a9a03cd";
  const firstId = "579eea00-11e2-431f-a844-478b87a95103";
  const execution = { id: runId, status: "waiting", workflowName: "Atomic workflow" };
  const first = { id: firstId, status: "pending", type: "manual_input", execution: { id: runId },
    inputSpec: { inputType: "text", question: "Trusted question" }, responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  const app = await mountApp(page, "monitor", { execution, humanRequest: first, latestSequence: 40 }, true);
  await app.getByRole("textbox", { name: "Trusted question Your answer" }).fill("Sealed trusted answer");
  await app.getByRole("button", { name: "Continue", exact: true }).click();
  await app.getByRole("button", { name: "Retry exact response", exact: true }).waitFor();
  const malformedSuccessor = { id: "76cb6623-fee3-4ef1-81ee-4d7cb3bfe6d6", status: "pending", type: "approval", execution: { id: runId }, title: "Impossible terminal question" };
  await page.evaluate(({ runId, malformedSuccessor }: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution: { id: runId, status: "completed", workflowName: "Atomic workflow" }, humanRequest: malformedSuccessor, latestSequence: 41,
  } } }]; }, { runId, malformedSuccessor });
  await app.getByRole("button", { name: "Refresh run", exact: true }).click();
  await app.getByText("pending request for a terminal run", { exact: false }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Retry exact response", exact: true }).isEnabled(), true);
  assert.equal(await app.getByRole("textbox", { name: "Trusted question Your answer" }).inputValue(), "Sealed trusted answer");
  assert.equal(await app.getByText("Impossible terminal question", { exact: true }).count(), 0);
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_interaction_respond", "loomex_run_get"]);
});

test("accepted commit and cancellation receipts survive malformed optional request projections", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for accepted mutation boundaries");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const runId = "b50c82d7-e497-4811-951e-c4c96fc9616a";
  const preparationId = "0d55a15b-64c3-4d06-bcc2-591e4d4c185b";
  const prepared = { preparationId, bindingDigest: "d".repeat(64), confirmationKey: "e67be35d-7803-4462-855c-11efcc463c78",
    binding: { workflowId: "c816dafc-ed1d-4d82-bb79-954f7659cb33", versionId: "5a87c6ce-6e34-4f39-817a-f5362701892a",
      organizationId: "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2", installationId: "62e9d3fa-097b-46fb-9f87-34b4d8c1b40b",
      workspacePath: "/Users/example/project", inputs: {}, executionPolicy: "host_user/v1", providerConfiguration: {} } };
  const presentation = { schemaVersion: "loomex/preparation-review/v1", preparationId, bindingDigest: prepared.bindingDigest,
    workflowId: prepared.binding.workflowId, versionId: prepared.binding.versionId, organizationId: prepared.binding.organizationId,
    workflowName: "Accepted boundary", workflowVersion: 1, organizationName: "Loomex Studio", providers: [] };
  const app = await mountApp(page, "prepare", prepared, false, false, presentation);
  const invalidRequest = { id: "8bdf9524-321e-40e5-ad6a-a1cb0706a9df", status: "pending", type: "manual_input",
    execution: { id: "19f4bf64-9ae9-46c5-8747-660532985034" }, inputSpec: { inputType: "text", question: "Wrong run question" } };
  const baselineRequest = { id: "f1fb91c6-9db2-4f16-aa38-cc43be13e2a5", status: "pending", type: "manual_input", execution: { id: runId },
    inputSpec: { inputType: "text", question: "Verified baseline question" }, responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  await page.evaluate(({ runId, preparationId, invalidRequest, baselineRequest }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: {
      execution: { id: runId, status: "running", workflowName: "Accepted boundary" }, executionPolicy: "host_user/v1", preparationId, humanRequest: invalidRequest,
    } } },
    { structuredContent: { ok: true, data: {
      execution: { id: runId, status: "waiting", workflowName: "Accepted boundary" }, humanRequest: baselineRequest,
    } } },
  ]; }, { runId, preparationId, invalidRequest, baselineRequest });
  await app.getByRole("button", { name: "Start run", exact: true }).click();
  await app.getByRole("textbox", { name: "Verified baseline question Your answer" }).waitFor();
  assert.equal(await app.getByText("Wrong run question", { exact: true }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Retry exact start" }).count(), 0);
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls)).map((call: any) => call.name), ["loomex_run_commit", "loomex_run_get"]);

  const cancelPage = await browser.newPage();
  const requestId = "2cb31855-0787-4ebd-8d4d-00cd67551ba6";
  const monitor = await mountApp(cancelPage, "monitor", { execution: { id: runId, status: "waiting", workflowName: "Accepted cancellation" }, latestSequence: 30,
    humanRequest: { id: requestId, status: "pending", type: "manual_input", execution: { id: runId },
      inputSpec: { inputType: "text", question: "Pending question" }, responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } });
  await monitor.getByRole("button", { name: "Cancel run", exact: true }).click();
  await monitor.getByRole("textbox", { name: "Cancellation reason", exact: true }).fill("Stop this exact run");
  await cancelPage.evaluate(() => { window.__workflowResponses = [{ isError: true, structuredContent: { ok: false, error: { code: "NETWORK_AMBIGUOUS", message: "Unknown cancellation outcome" } } }]; });
  await monitor.getByRole("button", { name: "Cancel run", exact: true }).click();
  await monitor.getByRole("button", { name: "Retry exact cancellation", exact: true }).waitFor();
  assert.equal(await monitor.getByRole("textbox", { name: "Cancellation reason", exact: true }).inputValue(), "Stop this exact run");
  assert.equal(await monitor.getByRole("textbox", { name: "Cancellation reason", exact: true }).isDisabled(), true);
  const firstCancel = (await cancelPage.evaluate(() => window.__loomexCalls))[0];
  await cancelPage.evaluate(({ runId, requestId }: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution: { id: runId, status: "canceled", workflowName: "Accepted cancellation" }, latestSequence: 31,
    humanRequest: { id: requestId, status: "pending", type: "manual_input", execution: { id: runId } },
  } } }]; }, { runId, requestId });
  await monitor.getByRole("button", { name: "Retry exact cancellation", exact: true }).click();
  await monitor.getByText("The cancellation was accepted, but its returned run state could not be verified.", { exact: false }).waitFor();
  assert.equal(await monitor.getByRole("button", { name: "Retry exact cancellation" }).count(), 0);
  assert.equal(await monitor.getByRole("button", { name: "Cancel run" }).count(), 0);
  const cancelCalls = await cancelPage.evaluate(() => window.__loomexCalls);
  assert.deepEqual(cancelCalls[1].arguments, firstCancel.arguments);
});

test("accepted non-terminal cancellation cannot reopen a fresh cancel mutation", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for cancellation state");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const runId = "25f6118e-35df-4bd9-bc60-b2158662e49c";
  const request = { id: "34aa95a1-782e-40b3-9188-cb15871e50b9", status: "pending", type: "approval", execution: { id: runId }, title: "Approve?" };
  const app = await mountApp(page, "monitor", { execution: { id: runId, status: "waiting", workflowName: "Cancellation queued" }, humanRequest: request, latestSequence: 4 });
  await app.getByRole("button", { name: "Cancel run", exact: true }).click();
  await app.getByRole("textbox", { name: "Cancellation reason", exact: true }).fill("No longer needed");
  await page.evaluate(({ runId }: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution: { id: runId, status: "running", workflowName: "Cancellation queued" }, jobs: [], details: {},
  } } }]; }, { runId });
  await app.getByRole("button", { name: "Cancel run", exact: true }).click();
  await app.getByText("The cancellation was accepted, but its returned run state could not be verified.", { exact: false }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Cancel run" }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Approve" }).count(), 0);
  assert.equal((await page.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_run_cancel").length, 1);
});

test("conflicting request organization identities never become actionable", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for organization binding");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const runId = "13d37ea0-233d-4a21-8bb3-a8988e46e3da";
  const app = await mountApp(page, "monitor", { execution: { id: runId, status: "waiting", workflowName: "Bound organization" },
    humanRequest: { id: "07f5d14b-22a1-44bc-8adb-c8664cf8914c", status: "pending", type: "approval",
      organizationId: "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2", execution: { id: runId, organizationId: "e7988aa5-6130-4275-b77d-d525e4acf31b" }, title: "Wrong organization" } });
  await app.getByText("conflicting organization identities", { exact: false }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Approve" }).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), []);
});

test("automatic monitor validation failures stop after the bounded retry budget", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for bounded monitor waits");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const runId = "07005ee5-242c-4d99-9ee3-a37351e479b4";
  const execution = { id: runId, status: "waiting", workflowName: "Bounded monitor" };
  const app = await mountApp(page, "monitor", { execution });
  await page.clock.install();
  await page.evaluate(({ execution }: any) => {
    const wrong = { structuredContent: { ok: true, data: { execution: { ...execution, id: "10884cb0-0328-420d-9e9f-10139a0f24f4" }, waitState: "waiting", latestSequence: 2 } } };
    window.__workflowResponses = [wrong, wrong, wrong, wrong];
    document.getElementById("app").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result",
      params: { structuredContent: { ok: true, data: { execution, waitState: "waiting", latestSequence: 1 } } } }, "*");
  }, { execution });
  await app.getByText("Run started. Its current status is shown below.", { exact: true }).waitFor();
  for (const milliseconds of [1_000, 2_500, 5_500]) {
    await page.clock.fastForward(milliseconds);
    await page.waitForFunction((minimum: number) => window.__loomexCalls.length >= minimum, milliseconds === 1_000 ? 1 : milliseconds === 2_500 ? 2 : 3);
  }
  await page.clock.fastForward(30_000);
  assert.equal(await page.evaluate(() => window.__loomexCalls.length), 3);
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls)).map((call: any) => call.name), ["loomex_run_wait", "loomex_run_wait", "loomex_run_wait"]);
});

test("actionable validation errors render only safe issue fields", async (t) => {
  const available = await browserTools();
  if (!available) { assert.fail("Chromium is required for the error presentation gate"); }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const app = await mountApp(page, "monitor", { execution: { id: "run-safe", status: "running", workflowName: "Safe workflow" } });
  await page.evaluate(() => document.getElementById("app").contentWindow.postMessage({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: {
      isError: true,
      structuredContent: {
        ok: false,
        requestId: "7af3e8b5-683d-4ac9-a8bd-55c3da054b30",
        error: {
          code: "RUN_VALIDATION_FAILED",
          message: "Two workflow steps need a supported execution provider.",
          validationIssueVersion: "v1",
          validationIssues: [{
            code: "RUN_VALIDATION_PROVIDER_UNSUPPORTED",
            nodeId: "private-node-id",
            nodeIndex: 2,
            nodeName: "AKIAIOSFODNN7EXAMPLE",
            message: "The selected provider does not support a required workflow capability.",
            nextAction: "choose_supported_provider",
            debug: "must-not-render-debug",
          }],
          privateTrace: "must-not-render-trace",
        },
      },
    },
  }, "*"));
  await app.getByText("Two workflow steps need a supported execution provider.", { exact: true }).waitFor();
  await app.getByRole("heading", { name: "Step 2", exact: true }).waitFor();
  await app.getByText("Choose a provider that supports this workflow, then prepare the run again.", { exact: true }).waitFor();
  const visible = await app.locator("body").innerText();
  assert.doesNotMatch(visible, /must-not-render|private-node-id|AKIAIOSFODNN7EXAMPLE|RUN_VALIDATION_FAILED|UNSUPPORTED_PROVIDER/);
  await app.getByText("Support reference: 7af3e8b5-683d-4ac9-a8bd-55c3da054b30", { exact: true }).waitFor();
  assert.equal(await app.getByText("Validation references", { exact: true }).count(), 0);
});

test("no-JSON views retain readable reviews and reject unsupported forms", async (t) => {
  const available = await browserTools();
  if (!available) { assert.fail("Chromium is required for this UI gate"); }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  for (const mode of ["interaction", "authoring"] as const) {
    const app = await mountApp(page, mode, {
      builderSession: { id: "session-1" },
      humanRequest: { id: "request-1", type: "input", responseSchema: {
        type: "object", properties: { nested: { type: "object" } },
      } },
    });
    await app.getByText("This form cannot be displayed here. Continue in the conversation to provide your answer.", { exact: true }).waitFor();
    assert.equal(await app.locator("textarea, pre, #diagnostics, #state").count(), 0);
    assert.equal(await app.locator("#primary").isDisabled(), true);
    await app.locator("#primary").evaluate((button: any) => button.dispatchEvent(new Event("click")));
    await app.locator('#summary[role="alert"]').waitFor();
    assert.equal(await page.evaluate(() => window.__loomexCalls.length), 0);
  }
  const prepared = {
    preparationId: "prepared-1", bindingDigest: "digest", confirmationKey: "never-display-this",
    binding: { organizationId: "Organization A", installationId: "My Mac", workflowId: "Weekly report",
      versionId: "Version 3", workspacePath: "/Users/example/report", executionPolicy: "host_user/v1",
      inputs: { title: "Quarterly report", includeCharts: false, nested: { secret: "hidden-input" } }, providerConfiguration: { codex: { model: "chosen-model", credentials: { value: "hidden-provider" }, apiToken: "hidden-token" } } },
  };
  let app = await mountApp(page, "prepare", prepared, false, false, {
    schemaVersion: "loomex/preparation-review/v1",
    preparationId: prepared.preparationId, bindingDigest: prepared.bindingDigest,
    workflowId: prepared.binding.workflowId, versionId: prepared.binding.versionId,
    organizationId: prepared.binding.organizationId, workflowName: "Weekly report",
    workflowVersion: 3, organizationName: "Organization A", providers: [{ name: "codex", model: "chosen-model" }],
  });
  await app.getByRole("heading", { name: "Weekly report", exact: true }).waitFor();
  await app.getByText("Quarterly report", { exact: true }).waitFor();
  await app.locator(".provider-row").getByText("chosen-model", { exact: true }).waitFor();
  assert.match(await app.locator("#context").innerText(), /no sandbox guarantee/);
  assert.doesNotMatch(await app.locator("body").innerText(), /never-display-this|bindingDigest|Technical details|hidden-input|hidden-provider|hidden-token/);
  assert.equal(await app.locator("#primary").isDisabled(), false);
  app = await mountApp(page, "prepare", { ...prepared, binding: {} });
  assert.equal(await app.locator("#primary").isDisabled(), true);
  await app.locator("#primary").evaluate((button: any) => button.dispatchEvent(new Event("click")));
  await app.locator('#summary[role="alert"]').waitFor();
  assert.equal(await page.evaluate(() => window.__loomexCalls.length), 0);
  app = await mountApp(page, "interaction", { humanRequest: { id: "approval-1", type: "approval", title: "Publish report?", prompt: "This report will be available to your team." } });
  await app.getByRole("heading", { name: "Publish report?" }).waitFor();
  await app.getByText("This report will be available to your team.", { exact: true }).waitFor();
  app = await mountApp(page, "monitor", { execution: { id: "run-1", status: "running" } });
  await app.getByText("Running", { exact: true }).waitFor();
});

test("prepared run uses bound names, hides UUIDs by default, and preserves exact commit after status check", async (t) => {
  const available = await browserTools();
  if (!available) { assert.fail("Chromium required for preparation UI gate"); }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 760, height: 1150 } });
  const prepared = {
    preparationId: "5aae202b-f5d0-44fc-9dc2-3f50457932eb", bindingDigest: "exact-prepared-digest", confirmationKey: "private-confirmation",
    binding: {
      workflowId: "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e", versionId: "8b29c880-1c68-4d47-a1ff-477ab28d3c49",
      organizationId: "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2", installationId: "62e9d3fa-097b-46fb-9f87-34b4d8c1b40b",
      workspacePath: "/Users/alireza/Projects/new-idea", inputs: {}, executionPolicy: "host_user/v1",
      providerConfiguration: { requested: {}, installed: { codex: { path: "/opt/codex", checksumSha256: "internal-checksum", sizeBytes: 100 } } },
    },
  };
  const presentation = {
    schemaVersion: "loomex/preparation-review/v1", preparationId: prepared.preparationId, bindingDigest: prepared.bindingDigest,
    workflowId: prepared.binding.workflowId, versionId: prepared.binding.versionId, organizationId: prepared.binding.organizationId,
    workflowName: "Idea to Implementation", workflowVersion: 1, organizationName: "Loomex Studio",
    providers: [{ name: "codex", model: "gpt-5.6-sol" }],
  };
  let app = await mountApp(page, "prepare", prepared, false, false, presentation);
  await app.getByRole("heading", { name: "Idea to Implementation" }).waitFor();
  await app.getByText("Version 1", { exact: true }).waitFor();
  await app.getByText("Loomex Studio", { exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Start run", exact: true }).isEnabled(), true);
  const visible = await app.locator("body").innerText();
  for (const id of [prepared.binding.workflowId, prepared.binding.versionId, prepared.binding.organizationId, prepared.binding.installationId]) assert.ok(!visible.includes(id));
  assert.doesNotMatch(visible, /private-confirmation|internal-checksum|sizeBytes|host_user/);
  const screenshotDir = process.env.LOOMEX_PREPARE_SCREENSHOT_DIR;
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
    for (const [name, width, theme] of [["light", 760, "light"], ["dark", 760, "dark"], ["mobile", 390, "light"]] as const) {
      await page.setViewportSize({ width, height: 1150 });
      await page.emulateMedia({ colorScheme: theme });
      await page.locator("#app").evaluate((frame: any) => { frame.style.height = `${frame.contentDocument.documentElement.scrollHeight}px`; });
      await page.locator("#app").screenshot({ path: resolve(screenshotDir, `prepare-${name}.png`) });
      assert.equal(await app.locator("body").evaluate((body: any) => body.scrollWidth <= body.clientWidth), true);
    }
  }
  await app.getByRole("button", { name: "Check runner", exact: true }).click();
  await waitForCallCount(page, 1);
  await app.getByText("Runner status checked. Your prepared operation is unchanged.", { exact: true }).waitFor();
  await app.getByRole("heading", { name: "Idea to Implementation" }).waitFor();
  await page.evaluate(() => { window.__rejectNextToolCall = true; });
  await app.getByRole("button", { name: "Check runner", exact: true }).click();
  await waitForCallCount(page, 2);
  await app.locator('#summary.error[role="alert"]').waitFor();
  assert.equal(await app.getByRole("button", { name: "Start run", exact: true }).isEnabled(), true, "a runner check rejection must not discard the sealed preparation");
  await page.evaluate(() => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution: { id: "1c5f36e6-ac6f-41a3-b593-edf31e691e37", name: "Idea to Implementation", status: "running" },
    executionPolicy: "host_user/v1", preparationId: "5aae202b-f5d0-44fc-9dc2-3f50457932eb",
  } } }]; });
  await app.getByRole("button", { name: "Start run", exact: true }).click();
  await waitForCallCount(page, 3);
  await app.getByText("Run started. Its current status is shown below.", { exact: true }).waitFor();
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.equal(calls[2].name, "loomex_run_commit");
  assert.deepEqual(Object.keys(calls[2].arguments).sort(), ["preparationId", "bindingDigest", "confirmationKey", "idempotencyKey"].sort());
  assert.equal(calls[2].arguments.preparationId, prepared.preparationId);
  assert.equal(calls[2].arguments.bindingDigest, prepared.bindingDigest);
  assert.equal(calls[2].arguments.confirmationKey, prepared.confirmationKey);
  const contexts = await page.evaluate(() => window.__loomexModelContexts);
  assert.equal(contexts.length, 1);
  assert.match(contexts[0].content[0].text, /1c5f36e6-ac6f-41a3-b593-edf31e691e37/);
  assert.doesNotMatch(contexts[0].content[0].text, /private-confirmation|confirmation/i);
  for (const invalid of [null,
    { ...presentation, organizationId: "other-org", workflowName: "Wrong workflow" },
    { ...presentation, workflowName: "" }, { ...presentation, workflowVersion: 0 },
    { ...presentation, organizationName: null }, { ...presentation, providers: [{ name: "codex", model: 12 }] },
  ]) {
    app = await mountApp(page, "prepare", prepared, false, false, invalid);
    await app.getByRole("heading", { name: "Prepared workflow", exact: true }).waitFor();
    assert.doesNotMatch(await app.locator("body").innerText(), /Wrong workflow|Loomex Studio|Version 1/);
    assert.equal(await app.locator("#primary").isDisabled(), true);
    await app.locator("#primary").evaluate((button: any) => button.dispatchEvent(new Event("click")));
    await app.locator('#summary[role="alert"]').waitFor();
    assert.equal(await page.evaluate(() => window.__loomexCalls.length), 0);
  }
});

test("integrated run setup validates inputs, grants one canonical workspace, prepares the selected version, and starts once", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium required for integrated run setup");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 760, height: 1200 } });
  const workflowId = "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e";
  const organizationId = "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2";
  const versionId = "8b29c880-1c68-4d47-a1ff-477ab28d3c49";
  const setup = {
    workflow: { id: workflowId, organizationId, name: "Integrated report" },
    activeVersion: { id: "3fb4a20e-ad41-4275-8296-58a07bbebf3e", versionNumber: 9, definition: { settings: { inputSchema: { type: "object", properties: {} } } } },
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        title: { type: "string", title: "Report title", minLength: 2 },
        retries: { type: "integer", title: "Retry count", minimum: 0 },
        publish: { type: "boolean", title: "Publish result" },
        directoryPath: { type: "string", title: "Project directory", minLength: 1, pattern: "^/",
          description: "Absolute canonical directory path. It must match the workspace selected and confirmed when preparing this run." },
      },
      required: ["title", "retries", "directoryPath"],
    },
    selectedVersion: { id: versionId, workflowId, versionNumber: 4, definition: { settings: {
      workspaceInputField: "directoryPath",
      inputSchema: { type: "object", properties: { staleProjection: { type: "string" } }, required: ["staleProjection"] },
    }, nodes: [] } },
  };
  const app = await mountApp(page, "prepare", setup);
  await app.getByRole("heading", { name: "Integrated report", exact: true }).waitFor();
  await app.getByText("Setup", { exact: true }).waitFor();
  assert.equal(await app.getByLabel("Project directory", { exact: true }).count(), 0, "workspaceInputField must use the single workspace control");

  await app.getByRole("button", { name: "Grant workspace access", exact: true }).click();
  await app.getByText("Complete the required inputs before continuing.", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), []);
  await app.getByLabel("Report title *", { exact: true }).fill("Q4 report");
  await app.getByLabel("Retry count *", { exact: true }).fill("1.5");
  await app.getByLabel("Project directory *", { exact: true }).fill("relative/project");
  await app.getByRole("button", { name: "Grant workspace access", exact: true }).click();
  await app.getByText("Enter a whole number.", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), []);

  await app.getByLabel("Retry count *", { exact: true }).fill("2");
  await app.getByLabel("Project directory *", { exact: true }).fill("/Users/example/../example/project");
  await page.evaluate(() => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    workspace: { path: "/Users/example/project", organizationId: "5c20340c-1123-41c7-ac58-37f5877dc9e6", installationId: "62e9d3fa-097b-46fb-9f87-34b4d8c1b40b" },
    executionPolicy: "host_user/v1",
  } } }]; });
  await app.getByRole("button", { name: "Grant workspace access", exact: true }).click();
  await waitForCallCount(page, 1);
  await app.getByText("The runner did not return a verified canonical workspace grant", { exact: false }).waitFor();
  await app.locator("#primary:not(:disabled)").waitFor();
  assert.equal(await app.getByLabel("Project directory *", { exact: true }).isDisabled(), true);
  const rejectedGrant = (await page.evaluate(() => window.__loomexCalls))[0];
  await page.evaluate(() => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    workspace: { path: "/Users/example/project", organizationId: "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2", installationId: "62e9d3fa-097b-46fb-9f87-34b4d8c1b40b" },
    executionPolicy: "host_user/v1",
  } } }]; });
  await app.getByRole("button", { name: "Retry exact workspace grant", exact: true }).click();
  await app.getByRole("button", { name: "Review run", exact: true }).waitFor();
  assert.equal(await app.getByLabel("Project directory *", { exact: true }).inputValue(), "/Users/example/project");
  const grant = (await page.evaluate(() => window.__loomexCalls))[1];
  assert.equal(grant.name, "loomex_workspace_grant");
  assert.equal(grant.arguments.workspacePath, "/Users/example/../example/project");
  assert.equal(grant.arguments.organizationId, organizationId);
  assert.match(grant.arguments.idempotencyKey, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(grant.arguments, rejectedGrant.arguments, "an unverifiable grant retry must remain exact");

  const prepared = {
    preparationId: "5aae202b-f5d0-44fc-9dc2-3f50457932eb",
    bindingDigest: "a".repeat(64),
    confirmationKey: "d09cb0b2-91fd-4289-ae8c-380c2fcb5541",
    binding: { workflowId, versionId, organizationId, installationId: "62e9d3fa-097b-46fb-9f87-34b4d8c1b40b",
      workspacePath: "/Users/example/project", executionPolicy: "host_user/v1",
      inputs: { directoryPath: "/Users/example/project", retries: 2, title: "Q4 report" }, providerConfiguration: {} },
  };
  const presentation = {
    schemaVersion: "loomex/preparation-review/v1", preparationId: prepared.preparationId,
    bindingDigest: prepared.bindingDigest, workflowId, versionId, organizationId,
    workflowName: "Integrated report", workflowVersion: 4, organizationName: "Loomex Studio", providers: [],
  };
  const substitutedPreparation = { ...prepared, binding: { ...prepared.binding, workspacePath: "/Users/example/other-project" } };
  await page.evaluate(({ prepared, presentation }: any) => { window.__workflowResponses = [{
    structuredContent: { ok: true, data: prepared }, _meta: { "loomex/preparationReview": presentation },
  }]; }, { prepared: substitutedPreparation, presentation });
  await app.getByRole("button", { name: "Review run", exact: true }).click();
  await waitForCallCount(page, 3);
  await app.getByText("The exact preparation review did not match the sealed setup.", { exact: false }).waitFor();
  await app.locator("#primary:not(:disabled)").waitFor();
  const rejectedPrepare = (await page.evaluate(() => window.__loomexCalls)).at(-1);
  await page.evaluate(({ prepared, presentation }: any) => { window.__workflowResponses = [{
    structuredContent: { ok: true, data: prepared }, _meta: { "loomex/preparationReview": presentation },
  }]; }, { prepared, presentation });
  await app.locator("#primary:not(:disabled)").waitFor();
  await app.getByRole("button", { name: "Retry exact preparation", exact: true }).click();
  await app.getByRole("button", { name: "Start run", exact: true }).waitFor();
  const prepare = (await page.evaluate(() => window.__loomexCalls))[3];
  assert.equal(prepare.name, "loomex_run_prepare");
  assert.equal(prepare.arguments.workflowId, workflowId);
  assert.equal(prepare.arguments.versionId, versionId, "selected immutable version must win over the active version");
  assert.equal(prepare.arguments.workspacePath, "/Users/example/project");
  assert.deepEqual(prepare.arguments.inputs, { title: "Q4 report", retries: 2, directoryPath: "/Users/example/project" });
  assert.deepEqual(prepare.arguments, rejectedPrepare.arguments, "a substituted preparation must fail closed and retry the sealed setup exactly");
  assert.equal("providerConfiguration" in prepare.arguments, false, "the UI must not invent provider choices");

  await page.evaluate(() => { window.__workflowResponses = [{ isError: true, structuredContent: { ok: false, error: {
    code: "RUN_VALIDATION_FAILED", message: "The workflow cannot start until its validation issues are fixed.",
    validationIssueVersion: "v1", validationIssues: [{ code: "RUN_INPUT_SCHEMA_INVALID",
      message: "Workflow inputs do not match the required schema.", nextAction: "correct_workflow_inputs",
      nodeId: "private-node-id", debug: "must-not-render-debug" }], privateTrace: "must-not-render-trace",
  } } }]; });
  await app.getByRole("button", { name: "Start run", exact: true }).click();
  await app.getByRole("heading", { name: "What needs attention", exact: true }).waitFor();
  await app.getByText("Workflow inputs do not match the required schema.", { exact: true }).waitFor();
  await app.getByText("Correct the workflow inputs, then prepare the run again.", { exact: true }).waitFor();
  assert.match(await app.locator('#summary[role="alert"]').innerText(), /validation issues/);
  assert.doesNotMatch(await app.locator("body").innerText(), /private-node-id|must-not-render/);
  assert.equal(await app.getByRole("button", { name: "Edit setup", exact: true }).isEnabled(), true);
  assert.equal(await app.getByRole("button", { name: "Start run", exact: true }).isEnabled(), true);

  await page.evaluate(() => { window.__workflowResponses = [{ isError: true, structuredContent: { ok: false, error: { code: "NETWORK_AMBIGUOUS", message: "Start outcome is uncertain" } } }]; });
  await app.getByRole("button", { name: "Start run", exact: true }).click();
  await waitForCallCount(page, 6);
  assert.equal(await app.locator("#error-details").isVisible(), false, "old validation issues must clear on the next attempt");
  assert.equal(await app.locator("#primary").textContent(), "Retry exact start");
  await app.getByRole("button", { name: "Retry exact start", exact: true }).waitFor();
  const ambiguous = (await page.evaluate(() => window.__loomexCalls)).at(-1);
  await page.evaluate(() => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution: { id: "1c5f36e6-ac6f-41a3-b593-edf31e691e37", name: "Integrated report", status: "running", currentNodeName: "Draft report" },
    executionPolicy: "host_user/v1", preparationId: "5aae202b-f5d0-44fc-9dc2-3f50457932eb",
  } } }]; });
  await page.evaluate(() => { window.__failModelContextAfterNextToolResponse = true; });
  await app.getByRole("button", { name: "Retry exact start", exact: true }).evaluate((button: any) => { button.click(); button.click(); });
  await app.getByText("Run started. Its current status is shown below.", { exact: true }).waitFor();
  await app.getByText("Draft report", { exact: true }).waitFor();
  const calls = await page.evaluate(() => window.__loomexCalls);
  const retried = calls.at(-1);
  assert.equal(calls.filter((call: any) => call.name === "loomex_run_commit").length, 3, "double click must add one commit call");
  assert.deepEqual(retried.arguments, ambiguous.arguments, "ambiguous retry must preserve every sealed field and the same idempotency key");
  const contexts = await page.evaluate(() => window.__loomexModelContexts);
  assert.equal(contexts.length, 0, "a best-effort model-context failure must not turn a successful commit into a retry");
  assert.equal(await app.getByRole("button", { name: "Continue in conversation", exact: true }).count(), 0);
  assert.equal((await page.evaluate(() => window.__loomexMessages)).length, 0, "run monitoring must stay in the app");
});

test("substituted commit and cancellation results stay on the sealed run and retry exact requests", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium required for exact run-result verification");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 760, height: 1000 } });
  const workflowId = "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e";
  const versionId = "8b29c880-1c68-4d47-a1ff-477ab28d3c49";
  const organizationId = "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2";
  const preparationId = "5aae202b-f5d0-44fc-9dc2-3f50457932eb";
  const runId = "1c5f36e6-ac6f-41a3-b593-edf31e691e37";
  const prepared = {
    preparationId, bindingDigest: "c".repeat(64), confirmationKey: "d09cb0b2-91fd-4289-ae8c-380c2fcb5541",
    binding: { workflowId, versionId, organizationId, installationId: "62e9d3fa-097b-46fb-9f87-34b4d8c1b40b",
      workspacePath: "/Users/example/project", inputs: {}, executionPolicy: "host_user/v1", providerConfiguration: {} },
  };
  const presentation = { schemaVersion: "loomex/preparation-review/v1", preparationId, bindingDigest: prepared.bindingDigest,
    workflowId, versionId, organizationId, workflowName: "Exact result run", workflowVersion: 3, organizationName: "Loomex Studio", providers: [] };
  const app = await mountApp(page, "prepare", prepared, false, false, presentation);

  await page.evaluate((runId: string) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution: { id: runId, name: "Substituted run", status: "running", currentNodeName: "Wrong run" },
    executionPolicy: "host_user/v1", preparationId: "daeb60a7-b9a0-44a2-b778-a5949567c7d2",
  } } }]; }, runId);
  await app.getByRole("button", { name: "Start run", exact: true }).click();
  await waitForCallCount(page, 1);
  await app.getByText("The runner did not return a run bound to the exact preparation", { exact: false }).waitFor();
  await app.locator("#primary:not(:disabled)").waitFor();
  assert.equal(await app.getByText("Wrong run", { exact: true }).count(), 0);
  assert.equal(await app.getByRole("heading", { name: "Exact result run", exact: true }).isVisible(), true);
  const rejectedCommit = (await page.evaluate(() => window.__loomexCalls))[0];

  await page.evaluate(({ runId, preparationId }: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution: { id: runId, name: "Exact result run", status: "running", currentNodeName: "Original run" },
    executionPolicy: "host_user/v1", preparationId,
  } } }]; }, { runId, preparationId });
  await app.getByRole("button", { name: "Retry exact start", exact: true }).click();
  await waitForCallCount(page, 2);
  await app.getByText("Original run", { exact: true }).waitFor();
  const acceptedCommit = (await page.evaluate(() => window.__loomexCalls))[1];
  assert.deepEqual(acceptedCommit.arguments, rejectedCommit.arguments);

  await app.getByLabel("reason", { exact: true }).fill("Stop this exact run");
  await page.evaluate(() => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution: { id: "24cb0c0a-0fc8-4a18-a0d9-1105d64e1824", name: "Other run", status: "canceled", currentNodeName: "Substituted cancellation" },
    executionPolicy: "host_user/v1",
  } } }]; });
  await app.getByRole("button", { name: "Cancel run", exact: true }).click();
  await waitForCallCount(page, 3);
  await app.getByText("The runner did not return status for the requested run.", { exact: false }).waitFor();
  await app.locator("#primary:not(:disabled)").waitFor();
  assert.equal(await app.getByText("Substituted cancellation", { exact: true }).count(), 0);
  await app.getByText("Original run", { exact: true }).waitFor();
  const rejectedCancel = (await page.evaluate(() => window.__loomexCalls))[2];
  assert.equal(await app.getByLabel("reason", { exact: true }).inputValue(), "Stop this exact run");
  assert.equal(await app.getByLabel("reason", { exact: true }).isDisabled(), true);

  await page.evaluate((runId: string) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution: { id: runId, name: "Exact result run", status: "canceled", currentNodeName: "Original run" },
    executionPolicy: "host_user/v1",
  } } }]; }, runId);
  await app.getByRole("button", { name: "Retry exact cancellation", exact: true }).click();
  await waitForCallCount(page, 4);
  await app.getByText("Canceled. Review the result below.", { exact: true }).waitFor();
  const acceptedCancel = (await page.evaluate(() => window.__loomexCalls))[3];
  assert.deepEqual(acceptedCancel.arguments, rejectedCancel.arguments);
  assert.equal(await app.getByRole("button", { name: "Cancel run", exact: true }).count(), 0);
});

test("unsupported setup fails closed and a timed-out start retains the exact sealed commit", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium required for setup fallback and timeout retry");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const workflowId = "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e";
  const versionId = "8b29c880-1c68-4d47-a1ff-477ab28d3c49";
  let app = await mountApp(page, "prepare", {
    workflow: { id: workflowId, organizationId: "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2", name: "Unsupported setup" },
    selectedVersion: { id: versionId, versionNumber: 2, definition: { nodes: [{ type: "start", inputSchema: {
      type: "object", properties: { nested: { type: "object", title: "Nested configuration" } }, required: ["nested"],
    } }] } },
  });
  await app.getByText(/Nested configuration.*unsupported type/i).waitFor();
  assert.equal(await app.getByRole("button", { name: "Continue in conversation", exact: true }).isEnabled(), true);
  await app.getByRole("button", { name: "Continue in conversation", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), []);
  await page.waitForFunction(() => window.__loomexMessages.length === 1);
  const messages = await page.evaluate(() => window.__loomexMessages);
  assert.equal(messages.length, 1);
  assert.match(messages[0].content[0].text, new RegExp(workflowId));
  assert.match(messages[0].content[0].text, /Do not commit or execute/);

  const prepared = {
    preparationId: "5aae202b-f5d0-44fc-9dc2-3f50457932eb", bindingDigest: "b".repeat(64), confirmationKey: "d09cb0b2-91fd-4289-ae8c-380c2fcb5541",
    binding: { workflowId, versionId, organizationId: "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2", installationId: "62e9d3fa-097b-46fb-9f87-34b4d8c1b40b",
      workspacePath: "/Users/example/project", inputs: {}, executionPolicy: "host_user/v1", providerConfiguration: {} },
  };
  const presentation = { schemaVersion: "loomex/preparation-review/v1", preparationId: prepared.preparationId, bindingDigest: prepared.bindingDigest,
    workflowId, versionId, organizationId: prepared.binding.organizationId, workflowName: "Timeout run", workflowVersion: 2, organizationName: "Loomex Studio", providers: [] };
  app = await mountApp(page, "prepare", prepared, false, false, presentation);
  await page.clock.install();
  await page.evaluate(() => { window.__dropNextToolResponse = true; });
  await app.getByRole("button", { name: "Start run", exact: true }).click();
  await page.waitForFunction(() => window.__loomexCalls.length === 1);
  assert.equal(await page.evaluate(() => window.__loomexCalls.length), 1);
  const first = (await page.evaluate(() => window.__loomexCalls))[0];
  await page.clock.fastForward(60_001);
  await app.getByRole("button", { name: "Retry exact start", exact: true }).waitFor();
  await page.evaluate(() => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution: { id: "1c5f36e6-ac6f-41a3-b593-edf31e691e37", name: "Timeout run", status: "running" },
    executionPolicy: "host_user/v1", preparationId: "5aae202b-f5d0-44fc-9dc2-3f50457932eb",
  } } }]; });
  await app.getByRole("button", { name: "Retry exact start", exact: true }).click();
  await page.waitForFunction(() => window.__loomexCalls.length === 2);
  await page.clock.fastForward(1);
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].arguments, first.arguments);
  await app.getByText("Run started. Its current status is shown below.", { exact: true }).waitFor();
});

test("all five views share design tokens, responsive components, focus states and host sizing", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium required for the shared design system gate");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const humanRequest = {
    id: "request-shared", type: "input", title: "Tell us about your idea",
    prompt: "A little context will help us ask the right questions.",
    inputSpec: { inputType: "long_text", question: "What would you like to build?", collectionMode: "single" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  };
  const prepared = {
    preparationId: "prepare-shared", bindingDigest: "shared-digest", confirmationKey: "private-confirmation",
    binding: { workflowId: "workflow-shared", versionId: "version-shared", organizationId: "org-shared", installationId: "installation-shared",
      workspacePath: "/Users/alireza/Projects/new-idea", executionPolicy: "host_user/v1", inputs: {}, providerConfiguration: {} },
  };
  const presentation = {
    schemaVersion: "loomex/preparation-review/v1", preparationId: prepared.preparationId, bindingDigest: prepared.bindingDigest,
    workflowId: prepared.binding.workflowId, versionId: prepared.binding.versionId, organizationId: prepared.binding.organizationId,
    workflowName: "Idea to Implementation", workflowVersion: 1, organizationName: "Loomex Studio", providers: [{ name: "codex", model: "gpt-5.6-sol" }],
  };
  const modes = ["browser", "prepare", "authoring", "interaction", "monitor"] as const;
  const directory = process.env.LOOMEX_DESIGN_SCREENSHOT_DIR;
  if (directory) await mkdir(directory, { recursive: true });
  for (const [theme, width] of [["light", 760], ["dark", 760], ["light", 390]] as const) {
    await page.setViewportSize({ width, height: 1100 });
    await page.emulateMedia({ colorScheme: theme });
    let baseline: unknown;
    for (const mode of modes) {
      const data = mode === "browser" ? { workflows: [{ id: "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e", name: "Idea to Implementation", latestVersion: 1, nodeCount: 2 }], nextCursor: null }
        : mode === "prepare" ? prepared : mode === "monitor"
        ? { execution: { id: "run-shared", name: "Idea to Implementation", status: "waiting for your response" } }
        : { humanRequest, ...(mode === "authoring" ? { builderSession: { id: "builder-shared" } } : {}) };
      const app = await mountApp(page, mode, data, false, false, mode === "prepare" ? presentation : null);
      const expectedHeading = mode === "browser" ? "Workflows" : mode === "prepare" ? "Idea to Implementation" : mode === "monitor" ? "Idea to Implementation" : "Tell us about your idea";
      await app.getByRole("heading", { name: expectedHeading, exact: true }).waitFor();
      assert.equal(await app.locator(".app-header, .app-body, .app-footer").count(), 3);
      assert.equal(await app.locator(".app-header h1").textContent(), "Loomex");
      assert.equal(await app.locator(".app-footer #connection").textContent(), "Connected");
      assert.equal(await app.locator("#view-label").textContent(), mode === "browser" ? "Workflow browser" : mode === "prepare" ? "Run workflow" : mode === "monitor" ? "Run monitor" : mode === "authoring" ? "Workflow authoring review" : "Human interaction");
      if (mode === "authoring" || mode === "interaction") await app.locator("fieldset textarea").waitFor();
      await waitForSettledAppSize(page);
      const styles = await app.locator("main").evaluate((main: any) => {
        const win = main.ownerDocument.defaultView;
        const css = win.getComputedStyle(main);
        const title = win.getComputedStyle(main.querySelector("h1"));
        const refresh = win.getComputedStyle(main.querySelector("#refresh"));
        return { accent: css.getPropertyValue("--accent"), padding: css.padding, gap: css.gap, width: css.maxWidth,
          font: css.fontFamily, titleSize: title.fontSize, titleColor: title.color,
          buttonHeight: refresh.minHeight, buttonRadius: refresh.borderRadius, buttonColor: refresh.color };
      });
      if (baseline === undefined) baseline = styles;
      else assert.deepEqual(styles, baseline, `${mode} must use the same shared shell and controls`);
      assert.equal(await app.locator("body").evaluate((body: any) => body.scrollWidth <= body.clientWidth), true);
      const visibleAction = (await app.locator("#primary").isVisible()) ? app.locator("#primary") : app.locator("#refresh");
      assert.equal(await visibleAction.evaluate((button: any) => button.getBoundingClientRect().height >= 42), true);
      assert.equal(await app.locator("#diagnostics, #state, #json-answer").count(), 0);
      if (directory) await app.locator("main").screenshot({ path: resolve(directory, `${mode}-${width < 520 ? "mobile" : theme}.png`) });
      const focusTarget = (await app.locator("textarea").count()) ? app.locator("textarea").first() : visibleAction;
      await focusTarget.focus();
      const focus = await focusTarget.evaluate((target: any) => target.ownerDocument.defaultView.getComputedStyle(target).outlineStyle);
      assert.equal(focus, "solid");
      const previousSizeCount = await page.evaluate(() => window.__loomexSizes.length);
      await page.evaluate(() => document.getElementById("app").contentWindow.postMessage({
        jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { isError: true, structuredContent: { ok: false, error: { code: "TEST_ERROR" } } },
      }, "*"));
      await app.locator('#summary.error[role="alert"]').waitFor();
      await app.getByRole("heading", { name: expectedHeading, exact: true }).waitFor();
      await waitForSettledAppSize(page, previousSizeCount);
      if (directory && width === 760 && theme === "light") await app.locator("main").screenshot({ path: resolve(directory, `${mode}-error.png`) });
    }
  }
  const template = await readFile("assets/loomex-app.html", "utf8");
  const css = template.split("<style>")[1]?.split("</style>")[0] || "";
  assert.doesNotMatch(css, /data-mode|prepare-/);
  assert.match(css, /--card-background/);
  assert.match(css, /--control-height/);
});

test("workflow browser searches, pages, reviews and hands off preparation without execution", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for workflow browsing");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const id = "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e";
  const first = { workflows: [{ id, name: "Idea <script>bad()</script>", description: "Develop an idea", definitionStatus: "published", latestVersion: 4, nodeCount: 11 }], nextCursor: "cursor-2" };
  const app = await mountApp(page, "browser", first);
  await app.getByRole("heading", { name: "Workflows", exact: true }).waitFor();
  assert.match(await app.locator("body").innerText(), /Version 4 · 11 steps/);
  assert.equal(await app.locator("body").evaluate((body: any) => body.scrollWidth <= body.clientWidth), true);
  assert.equal(await app.locator("script").count(), 1);
  await app.getByRole("button", { name: "Next", exact: true }).click();
  await app.getByText("Page 2 · 1 workflow", { exact: true }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls))[0], { name: "loomex_workflows_list", arguments: { limit: 20, cursor: "cursor-2" } });
  await app.getByRole("button", { name: "Previous", exact: true }).click();
  await app.getByText("Page 1 · 1 workflow", { exact: true }).waitFor();
  await page.evaluate(() => { window.__workflowResponses = [{ structuredContent: { ok: true, data: { workflows: [], nextCursor: null } } }]; });
  await app.getByLabel("Search workflows", { exact: true }).fill("missing");
  await app.getByRole("button", { name: "Search", exact: true }).click();
  await app.getByText("No workflows match your search. Try a different name or clear the search.").waitFor();
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls)).at(-1).arguments, { limit: 20, query: "missing" });
  await app.getByRole("button", { name: "Clear search", exact: true }).click();
  await app.getByRole("button", { name: /^View:/ }).waitFor();
  await page.evaluate((id: string) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    workflow: { id, name: "Idea", status: "active", metadata: { description: "Turn a short brief into an implementation." } },
    activeVersion: { versionNumber: 4, definition: { executionPolicy: "obsolete-policy", settings: { inputSchema: { properties: { obsolete: { type: "number" } } } }, nodes: [{ name: "Obsolete active step", type: "tool" }] } },
    selectedVersion: { versionNumber: 5, definition: {
      executionPolicy: "host_user/v1",
      settings: { inputSchema: { type: "object", properties: { directoryPath: { type: "string", title: "Project directory" } }, required: ["directoryPath"] } },
      nodes: [
        { key: "start", name: "Collect brief", type: "start", inputSchema: { properties: { ignoredFallback: { type: "boolean" } } } },
        { key: "implement", name: "Implement", type: "ai_agent", config: { provider: "codex", model: "gpt-5.6-luna", reasoningEffort: "medium" } },
        { key: "review", name: "Review", type: "ai_agent", config: { provider: "codex", model: "gpt-5.6-luna", reasoningEffort: "medium" } },
      ],
    } },
    inputSchema: { properties: { staleProjection: { type: "integer" } } },
    nodes: [{ key: "7f57e77b-a37e-4eef-9788-e6bc37447bb2", name: "Stale descriptor", type: "tool" }],
  } } }]; }, id);
  await app.getByRole("button", { name: /^View:/ }).click();
  await app.getByRole("heading", { name: "Idea", exact: true }).waitFor();
  await app.getByText("Version 5", { exact: false }).waitFor();
  await app.getByText("Project directory", { exact: true }).waitFor();
  await app.getByText("Required", { exact: true }).waitFor();
  await app.getByText("gpt-5.6-luna · medium effort", { exact: true }).waitFor();
  await app.getByText("Runs with the signed-in macOS user's permissions.", { exact: true }).waitFor();
  const detailText = await app.locator("body").innerText();
  assert.doesNotMatch(detailText, /obsolete|staleProjection|ignoredFallback|7f57e77b|Obsolete active step|Stale descriptor/);
  const steps = app.locator("details").filter({ hasText: "Workflow steps (3)" });
  assert.equal(await steps.getAttribute("open"), null);
  await steps.locator("summary").click();
  await app.getByText("Implement · Ai Agent", { exact: true }).waitFor();
  await page.evaluate((id: string) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    workflow: { id, organizationId: "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2", name: "Idea", status: "active" },
    inputSchema: { type: "object", additionalProperties: false, properties: { directoryPath: {
      description: "Absolute canonical directory path. It must match the workspace selected and confirmed when preparing this run.",
      minLength: 1, pattern: "^/", title: "Project directory", type: "string",
    } }, required: ["directoryPath"] },
    selectedVersion: { id: "8b29c880-1c68-4d47-a1ff-477ab28d3c49", workflowId: id, versionNumber: 5, definition: {
      executionPolicy: "host_user/v1",
      settings: { inputSchema: { type: "object", properties: { directoryPath: { type: "string", title: "Project directory" } }, required: ["directoryPath"] }, workspaceInputField: "directoryPath" },
      nodes: [],
    } },
  } } }]; }, id);
  await app.getByRole("button", { name: /^Prepare run/ }).click();
  await app.getByRole("heading", { name: "Idea", exact: true }).waitFor();
  await app.getByLabel("Project directory *", { exact: true }).waitFor();
  const messages = await page.evaluate(() => window.__loomexMessages);
  assert.equal(messages.length, 0);
  assert.equal((await page.evaluate(() => window.__loomexCalls)).at(-1).name, "loomex_run_setup");
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls)).at(-1).arguments, { workflowId: id, version: "5" });
  await app.getByRole("button", { name: "Back to workflows", exact: true }).click();
  await page.evaluate(() => { window.__workflowResponses = [{ isError: true, structuredContent: { ok: false } }]; });
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await app.locator("#summary.error").waitFor();
  assert.equal(await app.getByRole("button", { name: /^Prepare run/ }).isDisabled(), true);
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await app.getByText("Choose a workflow to review or prepare.").waitFor();
  assert.equal(await app.getByRole("button", { name: /^Prepare run/ }).isEnabled(), true);
  const directory = process.env.LOOMEX_UI_SCREENSHOT_DIR;
  if (directory) { await mkdir(directory, { recursive: true }); await app.locator("main").screenshot({ path: resolve(directory, "browser-mobile.png") }); }
});

test("authoring workflow detail matches the browser read view and only hands preparation to the conversation", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for workflow authoring detail");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const id = "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e";
  const versionId = "8b29c880-1c68-4d47-a1ff-477ab28d3c49";
  const detail = {
    workflow: { id, organizationId: "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2", name: "Future v5", status: "active", metadata: { description: "Build and review a project." } },
    activeVersion: { id: versionId, workflowId: id, versionNumber: 5, definition: { nodes: [] } },
    selectedVersion: { id: versionId, workflowId: id, versionNumber: 5, definition: {
      executionPolicy: "host_user/v1",
      settings: { inputSchema: { type: "object", properties: { directoryPath: { title: "Project directory", type: "string" } }, required: ["directoryPath"] } },
      nodes: [
        { key: "implement", name: "Implement", type: "ai_agent", config: { provider: "codex", model: "gpt-5.6-luna", reasoningEffort: "medium" } },
        { key: "review", name: "Review", type: "ai_agent", config: { provider: "codex", model: "gpt-5.6-luna", reasoningEffort: "medium" } },
      ],
    } },
    inputSchema: { type: "object", properties: { directoryPath: { title: "Project directory", type: "string" } }, required: ["directoryPath"] },
  };
  const app = await mountApp(page, "authoring", detail);
  await app.getByRole("heading", { name: "Future v5", exact: true }).waitFor();
  await app.getByText("Project directory", { exact: true }).waitFor();
  await app.getByText("gpt-5.6-luna · medium effort", { exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Prepare run", exact: true }).evaluate((button: any) => button.getBoundingClientRect().height >= 42), true);
  assert.equal(await app.locator("body").evaluate((body: any) => body.scrollWidth <= body.clientWidth), true);
  const directory = process.env.LOOMEX_UI_SCREENSHOT_DIR;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await app.locator("main").screenshot({ path: resolve(directory, "workflow-detail-mobile.png") });
  }

  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await waitForCallCount(page, 1);
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls))[0], { name: "loomex_workflow_get", arguments: { workflowId: id, version: "5" } });
  await app.getByRole("heading", { name: "Future v5", exact: true }).waitFor();

  await page.evaluate(() => {
    window.__workflowDelayMs = 120;
    window.__workflowResponses = [{ isError: true, structuredContent: { ok: false } }];
  });
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  assert.equal(await app.getByRole("button", { name: "Prepare run", exact: true }).isDisabled(), true);
  assert.equal(await app.locator("#context").getAttribute("aria-busy"), "true");
  await waitForCallCount(page, 2);
  await app.locator("#summary.error").waitFor();
  assert.equal(await app.locator("#context").getAttribute("aria-busy"), "false");
  assert.equal(await app.getByRole("button", { name: "Prepare run", exact: true }).isDisabled(), true);

  await page.evaluate((data: any) => {
    window.__workflowDelayMs = 0;
    window.__workflowResponses = [{ structuredContent: { ok: true, data } }];
  }, detail);
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await waitForCallCount(page, 3);
  await app.getByText("Review this workflow before preparing a run.", { exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Prepare run", exact: true }).isEnabled(), true);
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls))[2], { name: "loomex_workflow_get", arguments: { workflowId: id, version: "5" } });

  await app.getByRole("button", { name: "Prepare run", exact: true }).click();
  await app.getByRole("heading", { name: "Future v5", exact: true }).waitFor();
  await app.getByLabel("Project directory *", { exact: true }).waitFor();
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_workflow_get", "loomex_workflow_get", "loomex_workflow_get", "loomex_run_setup"]);
  assert.deepEqual(calls.at(-1).arguments, { workflowId: id, version: "5" });
  const messages = await page.evaluate(() => window.__loomexMessages);
  assert.equal(messages.length, 0);
  assert.equal(await app.getByRole("heading", { name: "Future v5", exact: true }).isVisible(), true);
});

test("authoring workflow detail hands paged responses to the conversation without a tool call", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for paged authoring detail");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const responseRef = "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e";
  const app = await mountApp(page, "authoring", { responseRef, encoding: "json", sizeBytes: 90_000, nextOffset: 0 });
  await app.getByRole("button", { name: "View complete response", exact: true }).click();
  await app.getByText("The conversation has been asked to retrieve the complete workflow response.", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), []);
  const messages = await page.evaluate(() => window.__loomexMessages);
  assert.equal(messages.length, 1);
  assert.match(messages[0].content[0].text, new RegExp(responseRef));
  assert.match(messages[0].content[0].text, /read-only request/);
  assert.doesNotMatch(messages[0].content[0].text, /commit|execute/);
});

test("workflow detail bounds inputs, AI configurations and steps with transparent omission counts", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for bounded workflow detail");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 760, height: 1200 } });
  const id = "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e";
  const aiNodes = Array.from({ length: 21 }, (_, index) => ({
    key: `agent-${index}`, name: `Agent ${index}`, type: "ai_agent",
    config: { provider: "codex", model: `model-${index}`, effort: "medium" },
  }));
  const toolNodes = Array.from({ length: 80 }, (_, index) => ({ key: `tool-${index}`, name: `Tool ${index}`, type: "tool" }));
  const inputProperties = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`input${index}`, { title: `Input ${index}`, type: "string" }]));
  const data = {
    workflow: { id, name: "Bounded workflow", status: "active" },
    selectedVersion: { workflowId: id, versionNumber: 7, definition: {
      executionPolicy: "host_user/v1",
      settings: { inputSchema: { type: "object", properties: inputProperties, required: ["input50"] } },
      nodes: [...aiNodes, ...toolNodes],
    } },
  };
  const app = await mountApp(page, "authoring", data);
  const inputs = app.locator('section[aria-label="Input requirements"]');
  await inputs.getByText("Showing the first 50 of 51 input requirements.", { exact: true }).waitFor();
  assert.equal(await inputs.locator(".workflow-detail-item").count(), 50);
  assert.equal(await inputs.getByText("Input 50", { exact: true }).count(), 0);
  const providers = app.locator('section[aria-label="AI configuration"]');
  await providers.getByText("Showing 20 of 21 AI configurations.", { exact: true }).waitFor();
  assert.equal(await providers.locator(".workflow-detail-item").count(), 20);
  assert.equal(await providers.getByText("model-20", { exact: true }).count(), 0);
  const steps = app.locator("details").filter({ hasText: "Workflow steps (101)" });
  await steps.getByText("Showing the first 100 of 101 steps.", { exact: true }).waitFor({ state: "attached" });
  assert.equal(await steps.locator("li").count(), 100);
});

test("workflow browser restores scope, handles large responses and shares responsive themes", async (t) => {
  const available = await browserTools(); if (!available) assert.fail("Chromium required");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const rows = { workflows: [
    { id: "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e", name: "Empty", nodeCount: 0, activeVersion: 1 },
    { id: "ef5a183a-128e-419f-a5fc-3d1f29de007c", name: "One", nodeCount: 1, activeVersion: 1 },
  ], nextCursor: "next" };
  const paged = { responseRef: "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e", encoding: "json", sizeBytes: 90000, nextOffset: 0 };
  for (const [width, colorScheme] of [[760, "light"], [760, "dark"], [390, "light"]] as const) {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme });
    const app = await mountApp(page, "browser", rows, false, false, null, false, { "loomex/workflowListQuery": { query: "idea", systemKey: "scope", limit: 2 } });
    await app.getByRole("button", { name: "View: One", exact: true }).waitFor();
    assert.equal(await app.getByLabel("Search workflows", { exact: true }).inputValue(), "idea");
    assert.match(await app.locator("body").innerText(), /0 steps/); assert.match(await app.locator("body").innerText(), /1 step\b/);
    assert.equal(await app.locator("body").evaluate((body: any) => body.scrollWidth <= body.clientWidth), true);
    const rowHeights = await app.locator(".workflow-row").evaluateAll((items: any[]) => items.map((item) => item.getBoundingClientRect().height));
    if (width === 760) assert.ok(rowHeights.every((height: number) => height <= 90), `Desktop workflow rows should remain compact: ${rowHeights.join(", ")}`);
    assert.equal(await app.locator(".workflow-row.ui-card").count(), 0);
    assert.equal(await app.locator(".workflow-row-actions button").evaluateAll((buttons: any[]) => buttons.every((button) => button.getBoundingClientRect().height >= 42)), true);
    await app.getByLabel("Search workflows", { exact: true }).focus();
    assert.equal(await app.getByLabel("Search workflows", { exact: true }).evaluate((el: any) => el.ownerDocument.defaultView.getComputedStyle(el).outlineStyle), "solid");
    await waitForSettledAppSize(page);
    const directory = process.env.LOOMEX_UI_SCREENSHOT_DIR;
    if (directory) { await mkdir(directory, { recursive: true }); await app.locator("main").screenshot({ path: resolve(directory, `browser-${width}-${colorScheme}.png`) }); }
    await app.getByRole("button", { name: "Next", exact: true }).click();
    await app.getByText("Page 2 · 2 workflows").waitFor();
    assert.deepEqual((await page.evaluate(() => window.__loomexCalls)).at(-1).arguments, { query: "idea", systemKey: "scope", limit: 2, cursor: "next" });
    await page.evaluate((data: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data } }]; }, paged);
    await app.getByRole("button", { name: "Refresh", exact: true }).click();
    await app.getByRole("button", { name: "View complete response", exact: true }).waitFor();
    assert.doesNotMatch(await app.locator("body").innerText(), /No workflows/);
  }
  const recovery = await mountApp(page, "browser", rows);
  await page.evaluate((data: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data } }]; }, paged);
  await recovery.getByRole("button", { name: "Next", exact: true }).click();
  await recovery.getByRole("button", { name: "View complete response", exact: true }).waitFor();
  await recovery.getByRole("button", { name: "Refresh", exact: true }).click();
  await recovery.getByText("Page 2 · 2 workflows").waitFor();
  assert.equal(await recovery.getByRole("button", { name: "Previous", exact: true }).isEnabled(), true);
  await page.evaluate((data: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data } }]; }, paged);
  await recovery.getByRole("button", { name: "View: One", exact: true }).click();
  await recovery.getByRole("button", { name: "View complete response", exact: true }).waitFor();
  await recovery.getByRole("button", { name: "Back to workflows", exact: true }).click();
  await recovery.getByText("Page 2 · 2 workflows").waitFor();
  const app = await mountApp(page, "browser", paged, false, false, null, true);
  await app.getByRole("button", { name: "View complete response", exact: true }).click();
  await app.locator("#summary.error").waitFor();
  assert.equal(await page.evaluate(() => window.__loomexCalls.length), 0);
  assert.match((await page.evaluate(() => window.__loomexMessages))[0].content[0].text, /loomex_response_read/);
});
