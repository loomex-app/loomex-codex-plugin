import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

type BrowserPage = { setContent(value: string): Promise<void>; addScriptTag(options: { path: string }): Promise<void>; evaluate<Result>(callback: () => Result): Promise<Result>; locator(selector: string): { click(): Promise<void> } };
type Browser = { newPage(): Promise<BrowserPage>; close(): Promise<void> };
type Chromium = { launch(options: { executablePath: string }): Promise<Browser> };
const run = promisify(execFile);

test("native element helper preserves form properties and label focus in Chrome", async (context) => {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  try { await access(chrome); } catch { context.skip("Chrome is unavailable on this host"); return; }
  const output = await mkdtemp(resolve(tmpdir(), "loomex-components-browser-"));
  await run(resolve(process.cwd(), "node_modules/.bin/esbuild"), ["test/components-browser-fixture.ts", "--bundle", "--platform=browser", "--format=iife", "--target=es2022", `--outfile=${resolve(output, "fixture.js")}`]);
  const playwright = await import(pathToFileURL(resolve(process.cwd(), "node_modules/@playwright/test/index.mjs")).href) as unknown as { chromium: Chromium };
  const browser = await playwright.chromium.launch({ executablePath: chrome });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><body></body>");
    await page.addScriptTag({ path: resolve(output, "fixture.js") });
    const result = await page.evaluate(() => {
      const fixture = (globalThis as unknown as { loomexComponentsFixture?: () => void }).loomexComponentsFixture;
      fixture?.();
      const input = document.querySelector<HTMLInputElement>("#name-input");
      const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
      const select = document.querySelector<HTMLSelectElement>("select");
      const safe = document.querySelector("p");
      return { value: input?.value, checked: input?.checked, disabled: input?.disabled, readOnly: input?.readOnly, tabIndex: input?.tabIndex, dataset: input?.dataset.fixtureKey, textareaReadOnly: textarea?.readOnly, selectValue: select?.value, imageCount: safe?.querySelectorAll("img").length };
    });
    assert.deepEqual(result, { value: "Ada", checked: true, disabled: false, readOnly: false, tabIndex: 2, dataset: "safe", textareaReadOnly: true, selectValue: "two", imageCount: 0 });
    await page.locator("label").click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), "name-input");
  } finally { await browser.close(); }
});

test("shared UI element helper preserves legacy common surface and input classes", async (context) => {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  try { await access(chrome); } catch { context.skip("Chrome is unavailable on this host"); return; }
  const output = await mkdtemp(resolve(tmpdir(), "loomex-ui-components-browser-"));
  await run(resolve(process.cwd(), "node_modules/.bin/esbuild"), ["test/components-browser-fixture.ts", "--bundle", "--platform=browser", "--format=iife", "--target=es2022", `--outfile=${resolve(output, "fixture.js")}`]);
  const playwright = await import(pathToFileURL(resolve(process.cwd(), "node_modules/@playwright/test/index.mjs")).href) as unknown as { chromium: Chromium };
  const browser = await playwright.chromium.launch({ executablePath: chrome });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><body></body>");
    await page.addScriptTag({ path: resolve(output, "fixture.js") });
    const classes = await page.evaluate(() => {
      const fixture = (globalThis as unknown as { loomexUiComponentsFixture?: () => void }).loomexUiComponentsFixture;
      fixture?.();
      return [...document.body.children].map((node) => node.className);
    });
    assert.deepEqual(classes, [
      "input-field", "", "input-field", "input-field", "glass-panel", "ui-card existing-class glass-panel",
      "workflow-row glass-panel", "answer-review-item glass-panel", "ui-callout glass-panel", "notice glass-panel",
      "ui-badge status-badge badge-running", "ui-badge status-badge badge-low", "ui-button btn-primary ui-button-md", "ui-button btn-secondary ui-button-md", "ui-button btn-secondary loomex-danger ui-button-md",
    ]);
  } finally { await browser.close(); }
});
