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
) {
  const template = await readFile("assets/loomex-app.html", "utf8");
  const html = template.replace("__LOOMEX_MODE__", mode);
  const harnessUrl = `http://127.0.0.1/loomex-${mode}-${Date.now()}`;
  await page.route(harnessUrl, (route: any) => route.fulfill({
    contentType: "text/html",
    body: '<iframe id="app" title="Loomex test app" style="display:block;width:100%;height:1200px;border:0"></iframe>',
  }));
  await page.goto(harnessUrl);
  await page.evaluate(({ source, initialData, shouldFailFirst, shouldResolveOnRead, presentation }: any) => {
    const frame = document.getElementById("app");
    window.__loomexCalls = [];
    window.addEventListener("message", (event: any) => {
      if (event.source !== frame.contentWindow) return;
      const message = event.data;
      if (message && message.method === "ui/notifications/size-changed") {
        frame.style.height = `${message.params.height}px`;
        return;
      }
      if (!message || message.jsonrpc !== "2.0" || message.id === undefined) return;
      if (message.method === "ui/initialize") {
        event.source.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
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

  await app.getByRole("button", { name: "Submit response" }).click();
  await app.locator("#question-2-error").getByText("Enter a real date in YYYY-MM-DD format.").waitFor();
  assert.equal((await page.evaluate(() => window.__loomexCalls.length)), 0);
  assert.equal(await app.locator("#question-1-value").inputValue(), "Keep this detailed draft after errors.");

  await app.locator("#question-2-value").evaluate((control: any) => {
    control.type = "date";
    control.value = "2024-02-29";
  });
  await app.getByRole("button", { name: "Submit response" }).evaluate((button: any) => {
    button.click();
    button.click();
  });
  await waitForCallCount(page, 1);
  await app.getByText("submission outcome is uncertain", { exact: false }).waitFor();
  assert.equal(await app.locator("#question-0-value").inputValue(), "Ada");
  assert.equal(await app.locator("#question-5-other-text").inputValue(), "Custom choice");
  assert.equal(await app.locator("#question-0-value").isDisabled(), true);
  await app.locator("#question-0-value").evaluate((control: any) => { control.value = "Edited after ambiguity"; });

  await app.getByRole("button", { name: "Refresh server state" }).click();
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
  await app.getByRole("button", { name: "Submit response" }).click();
  await waitForCallCount(page, 1);
  await app.getByText("submission outcome is uncertain", { exact: false }).waitFor();
  await app.getByRole("button", { name: "Refresh server state" }).click();
  await waitForCallCount(page, 2);
  await app.getByText("uncertain submission was reconciled", { exact: false }).waitFor();
  assert.equal(await app.locator("#form").isHidden(), true);
  assert.equal(await app.getByRole("button", { name: "Retry exact response" }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Submit response" }).count(), 0);
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
  await app.getByRole("button", { name: "Respond to authoring session" }).click();
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
  await fallback.getByRole("button", { name: "Submit response" }).click();
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
  assert.equal(await invalid.getByRole("button", { name: "Submit response" }).isDisabled(), true);
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
  await app.getByText("running", { exact: true }).waitFor();
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
