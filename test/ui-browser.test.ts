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
  mode: "interaction" | "authoring" | "prepare" | "monitor",
  data: Record<string, unknown>,
  failFirstMutation = false,
  resolveOnRead = false,
  presentation: Record<string, unknown> | null = null,
  failUiMessage = false,
) {
  const template = await readFile("assets/loomex-app.html", "utf8");
  const html = template.replace("__LOOMEX_MODE__", mode);
  const harnessUrl = `http://127.0.0.1/loomex-${mode}-${Date.now()}`;
  await page.route(harnessUrl, (route: any) => route.fulfill({
    contentType: "text/html",
    body: '<iframe id="app" title="Loomex test app" style="display:block;width:100%;height:1200px;border:0"></iframe>',
  }));
  await page.goto(harnessUrl);
  await page.evaluate(({ source, initialData, shouldFailFirst, shouldResolveOnRead, presentation, shouldFailUiMessage }: any) => {
    const frame = document.getElementById("app");
    window.__loomexCalls = [];
    window.__loomexMessages = [];
    window.__loomexSizes = [];
    window.addEventListener("message", (event: any) => {
      if (event.source !== frame.contentWindow) return;
      const message = event.data;
      if (message && message.method === "ui/notifications/size-changed") {
        frame.style.height = `${message.params.height}px`;
        window.__loomexSizes.push(message.params);
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
        const result = shouldFailFirst && callNumber === 1
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
        }, shouldFailFirst && callNumber === 1 ? 120 : 0);
      }
    });
    frame.addEventListener("load", () => {
      frame.contentWindow.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent: { ok: true, data: initialData }, _meta: { "loomex/preparationReview": presentation } },
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
      title: "Tell us about your idea",
      description: question,
      prompt: "A sentence or two is enough to begin.",
      context: { previousOutputs: { privateTransportData: "must-not-render" } },
      presentation: {
        version: 1,
        kind: "progress",
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
  await app.getByRole("heading", { name: "Requirements progress", exact: true }).waitFor();
  await app.locator('[aria-current="step"]').getByText("Clarify", { exact: true }).waitFor();
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
      },
      inputSpec: { inputType: "boolean", question: "Does this meet your requirements?" },
      responseSchema: { type: "object", properties: { value: { type: "boolean" } }, required: ["value"] },
    },
  });
  await app.getByRole("heading", { name: "Implementation review", exact: true }).waitFor();
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
  await app.getByRole("button", { name: "Start run", exact: true }).click();
  await waitForCallCount(page, 2);
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.equal(calls[1].name, "loomex_run_commit");
  assert.deepEqual(Object.keys(calls[1].arguments).sort(), ["preparationId", "bindingDigest", "confirmationKey", "idempotencyKey"].sort());
  assert.equal(calls[1].arguments.preparationId, prepared.preparationId);
  assert.equal(calls[1].arguments.bindingDigest, prepared.bindingDigest);
  assert.equal(calls[1].arguments.confirmationKey, prepared.confirmationKey);
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

test("all four views share design tokens, responsive components, focus states and host sizing", async (t) => {
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
  const modes = ["prepare", "authoring", "interaction", "monitor"] as const;
  const directory = process.env.LOOMEX_DESIGN_SCREENSHOT_DIR;
  if (directory) await mkdir(directory, { recursive: true });
  for (const [theme, width] of [["light", 760], ["dark", 760], ["light", 390]] as const) {
    await page.setViewportSize({ width, height: 1100 });
    await page.emulateMedia({ colorScheme: theme });
    let baseline: unknown;
    for (const mode of modes) {
      const data = mode === "prepare" ? prepared : mode === "monitor"
        ? { execution: { id: "run-shared", name: "Idea to Implementation", status: "waiting for your response" } }
        : { humanRequest, ...(mode === "authoring" ? { builderSession: { id: "builder-shared" } } : {}) };
      const app = await mountApp(page, mode, data, false, false, mode === "prepare" ? presentation : null);
      const expectedHeading = mode === "prepare" ? "Idea to Implementation" : mode === "monitor" ? "Idea to Implementation" : "Tell us about your idea";
      await app.getByRole("heading", { name: expectedHeading, exact: true }).waitFor();
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
      assert.equal(await app.locator("#primary").evaluate((button: any) => button.getBoundingClientRect().height >= 42), true);
      assert.equal(await app.locator("#diagnostics, #state, #json-answer").count(), 0);
      if (directory) await app.locator("main").screenshot({ path: resolve(directory, `${mode}-${width < 520 ? "mobile" : theme}.png`) });
      const focusTarget = (await app.locator("textarea").count()) ? app.locator("textarea").first() : app.locator("#primary");
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
