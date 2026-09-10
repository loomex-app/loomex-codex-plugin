import { renderUiHtml } from "../src/ui-template.js";
import { APP_CALLABLE_TOOLS } from "../src/tool-catalog.js";
import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

declare const window: any;
declare const document: any;

type BrowserTools = {
  expect(locator: any): { toHaveValue(value: string): Promise<void> };
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
  resultMeta: Record<string, unknown> | undefined = undefined,
  hostCapabilities: Record<string, unknown> | null = { message: { text: {} }, updateModelContext: { text: {} } },
  workflowResponses: Array<Record<string, unknown>> = [],
  reuseHost = false,
) {
  const html = renderUiHtml(mode);
  const source = data as any;
  const entity = mode === "browser"
    ? { entityType: "catalog" as const, entityId: "00000000-0000-0000-0000-000000000000" }
    : mode === "interaction"
      ? { entityType: "request" as const, entityId: source.humanRequest?.id }
      : mode === "monitor"
        ? { entityType: "execution" as const, entityId: source.execution?.id }
        : mode === "authoring" && source.builderSession?.id
          ? { entityType: "builderSession" as const, entityId: source.builderSession.id }
          : source.preparationId
            ? { entityType: "preparation" as const, entityId: source.preparationId }
            : { entityType: "workflow" as const, entityId: source.workflow?.id || source.selectedVersion?.workflowId };
  const validEntityId = (entity.entityType === "catalog" && entity.entityId === "00000000-0000-0000-0000-000000000000") ||
    (typeof entity.entityId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entity.entityId));
  const generatedPersistenceMeta = validEntityId
    ? { "loomex/viewSession": viewSession(randomUUID(), mode, entity.entityType, entity.entityId, {}) }
    : { "loomex/viewPersistence": { status: "unavailable" } };
  const hasExplicitPersistenceMeta = resultMeta !== undefined && (
    Object.keys(resultMeta).length === 0 ||
    Object.hasOwn(resultMeta, "loomex/viewSession") ||
    Object.hasOwn(resultMeta, "loomex/viewPersistence")
  );
  const nativeResultMeta = resultMeta === undefined
    ? generatedPersistenceMeta
    : hasExplicitPersistenceMeta
      ? resultMeta
      : { ...generatedPersistenceMeta, ...resultMeta };
  const appCallableToolNames = [...APP_CALLABLE_TOOLS];
  const harnessUrl = `http://127.0.0.1/loomex-${mode}-${Date.now()}`;
  if (!reuseHost) {
    await page.route(harnessUrl, (route: any) => route.fulfill({
      contentType: "text/html",
      body: '<iframe id="app" title="Loomex test app" style="display:block;width:100%;height:1200px;border:0"></iframe>',
    }));
    await page.goto(harnessUrl);
  } else {
    await page.evaluate(() => {
      const prior = document.getElementById("app");
      const frame = document.createElement("iframe");
      frame.id = "app";
      frame.title = "Loomex test app";
      frame.style.cssText = "display:block;width:100%;height:1200px;border:0";
      prior?.replaceWith(frame);
    });
  }
  await page.evaluate(({ source, initialData, shouldFailFirst, shouldResolveOnRead, presentation, shouldFailUiMessage, resultMeta, hostCapabilities, workflowResponses, preserveHostState, appCallableToolNames }: any) => {
    const frame = document.getElementById("app");
    if (!preserveHostState) {
      window.__loomexCalls = [];
      window.__loomexMessages = [];
      window.__loomexModelContexts = [];
      window.__loomexSizes = [];
      window.__loomexPersistenceCalls = [];
      window.__loomexPersistenceStore = { sessions: {}, operations: {}, drafts: {}, receipts: {} };
    } else {
      window.__loomexCalls ||= [];
      window.__loomexMessages ||= [];
      window.__loomexModelContexts ||= [];
      window.__loomexSizes ||= [];
      window.__loomexPersistenceCalls ||= [];
      window.__loomexPersistenceStore ||= { sessions: {}, operations: {}, drafts: {}, receipts: {} };
    }
    window.__workflowResponses = workflowResponses.slice();
    const persistenceStore = window.__loomexPersistenceStore;
    const initialProjection = resultMeta?.["loomex/viewSession"];
    if (initialProjection?.viewSessionId && !persistenceStore.sessions[initialProjection.viewSessionId]) {
      persistenceStore.sessions[initialProjection.viewSessionId] = structuredClone(initialProjection);
    }
    const persistenceNames = new Set([
      "loomex_view_session_create", "loomex_view_session_get", "loomex_view_session_update", "loomex_view_session_delete",
      "loomex_view_operation_get", "loomex_view_operation_settle",
      "loomex_interaction_draft_get", "loomex_interaction_draft_update", "loomex_interaction_draft_delete",
    ]);
    const appCallableNames = new Set(appCallableToolNames);
    const journalMethods = new Set([
      "interactions.respond", "interactions.decide", "builder.respond", "runs.cancel", "runs.commit",
      "builder.commit", "editor.commit", "workspaces.grant", "runs.prepare",
    ]);
    const reconciliationMethods = new Set(["interactions.get", "builder.get", "runs.get"]);
    const persistenceResult = (data: any) => ({ structuredContent: { ok: true, data } });
    const persistenceError = (code: string, message: string) => ({
      isError: true,
      structuredContent: { ok: false, error: { code, message } },
    });
    const exact = (left: any, right: any) => JSON.stringify(left) === JSON.stringify(right);
    const receivePersistenceCall = (message: any) => {
      const call = structuredClone(message.params);
      window.__loomexPersistenceCalls.push(call);
      const name = call.name;
      const args = call.arguments || {};
      const fail = window.__failNextPersistenceCall === true || window.__failNextPersistenceCall === name ||
        (name === "loomex_view_session_get" && window.__failNextViewSessionId === args.viewSessionId);
      if (fail) {
        window.__failNextPersistenceCall = false;
        if (window.__failNextViewSessionId === args.viewSessionId) window.__failNextViewSessionId = "";
        return persistenceError("PERSISTENCE_UNAVAILABLE", "The durable view store rejected the call");
      }
      const drop = window.__dropNextPersistenceResponse === true || window.__dropNextPersistenceResponse === name;
      if (drop) {
        window.__dropNextPersistenceResponse = false;
        return undefined;
      }
      const receiptKey = args.idempotencyKey ? `${name}:${args.idempotencyKey}` : "";
      if (receiptKey && persistenceStore.receipts[receiptKey]) {
        const receipt = persistenceStore.receipts[receiptKey];
        return exact(receipt.arguments, args)
          ? structuredClone(receipt.result)
          : persistenceError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different arguments");
      }
      let result;
      if (name === "loomex_view_session_create") {
        const viewSessionId = crypto.randomUUID();
        const now = Date.now();
        const session = {
          viewSessionId, kind: args.kind, entityType: args.entityType, entityId: args.entityId,
          revision: 0, state: structuredClone(args.state), status: "active",
          createdAt: now, updatedAt: now, expiresAt: null, operation: null,
        };
        persistenceStore.sessions[viewSessionId] = session;
        result = persistenceResult(structuredClone(session));
      } else if (name === "loomex_view_session_get") {
        const session = persistenceStore.sessions[args.viewSessionId];
        result = session ? persistenceResult(structuredClone(session)) : persistenceError("VIEW_SESSION_NOT_FOUND", "View session not found");
      } else if (name === "loomex_view_session_update") {
        const session = persistenceStore.sessions[args.viewSessionId];
        if (!session) result = persistenceError("VIEW_SESSION_NOT_FOUND", "View session not found");
        else if (session.revision !== args.expectedRevision) result = persistenceError("REVISION_CONFLICT", "View session revision conflict");
        else if (args.operation && (!journalMethods.has(args.operation.method) || !args.operation.params || typeof args.operation.params !== "object" || Array.isArray(args.operation.params))) {
          result = persistenceError("INVALID_REQUEST", "The operation journal requires an exact runner RPC method and object params");
        } else if (args.operation?.reconciliation && (!reconciliationMethods.has(args.operation.reconciliation.method) ||
          !args.operation.reconciliation.params || typeof args.operation.reconciliation.params !== "object" || Array.isArray(args.operation.reconciliation.params))) {
          result = persistenceError("INVALID_REQUEST", "The reconciliation journal requires an exact read-only runner RPC method and object params");
        }
        else if (args.operation && session.operation && ["pending", "ambiguous"].includes(session.operation.status)) {
          result = persistenceError("OPERATION_PENDING", "A view operation is already unresolved");
        } else {
          session.revision += 1;
          session.state = structuredClone(args.state);
          session.status = args.status || "active";
          session.updatedAt += 1;
          if (args.operation) {
            const operationId = crypto.randomUUID();
            const operation = {
              operationId, viewSessionId: session.viewSessionId, method: args.operation.method,
              params: structuredClone(args.operation.params), idempotencyKey: args.operation.idempotencyKey,
              reconciliation: structuredClone(args.operation.reconciliation || {}), status: "pending",
              createdAt: session.updatedAt, updatedAt: session.updatedAt, resultReference: null,
            };
            persistenceStore.operations[operationId] = operation;
            session.operation = { operationId, status: "pending" };
          }
          result = persistenceResult(structuredClone(session));
        }
      } else if (name === "loomex_view_session_delete") {
        const deleted = Boolean(persistenceStore.sessions[args.viewSessionId]);
        delete persistenceStore.sessions[args.viewSessionId];
        result = deleted
          ? persistenceResult({ viewSessionId: args.viewSessionId, deleted: true })
          : persistenceError("VIEW_SESSION_NOT_FOUND", "View session not found");
      } else if (name === "loomex_view_operation_get") {
        const operation = persistenceStore.operations[args.operationId];
        result = operation?.viewSessionId === args.viewSessionId
          ? persistenceResult(structuredClone(operation))
          : persistenceError("OPERATION_NOT_FOUND", "View operation not found");
      } else if (name === "loomex_view_operation_settle") {
        const operation = persistenceStore.operations[args.operationId];
        if (!operation || operation.viewSessionId !== args.viewSessionId) result = persistenceError("OPERATION_NOT_FOUND", "View operation not found");
        else if (!["pending", "ambiguous"].includes(operation.status)) result = persistenceError("OPERATION_SETTLED", "View operation is already settled");
        else {
          operation.status = args.status;
          operation.updatedAt += 1;
          operation.resultReference = structuredClone(args.resultReference ?? null);
          const session = persistenceStore.sessions[args.viewSessionId];
          if (session) session.operation = args.status === "completed" ? null : { operationId: args.operationId, status: args.status };
          result = persistenceResult({ operationId: args.operationId, viewSessionId: args.viewSessionId, status: args.status,
            updatedAt: operation.updatedAt, resultReference: structuredClone(operation.resultReference) });
        }
      } else if (name === "loomex_interaction_draft_get") {
        result = persistenceResult({ draft: structuredClone(persistenceStore.drafts[args.requestId] || null) });
      } else if (name === "loomex_interaction_draft_update") {
        const draft = persistenceStore.drafts[args.requestId];
        const currentRevision = draft?.revision || 0;
        if (currentRevision !== args.expectedRevision || (draft && args.expectedSchemaDigest && draft.schemaDigest !== args.expectedSchemaDigest)) {
          result = persistenceError("INTERACTION_DRAFT_CONFLICT", "Interaction draft revision conflict");
        } else {
          const now = new Date(1_700_000_000_000 + currentRevision * 1_000).toISOString();
          const saved = {
            requestId: args.requestId, schemaDigest: draft?.schemaDigest || args.expectedSchemaDigest || "a".repeat(64),
            answers: structuredClone(args.answers), currentQuestionId: args.currentQuestionId,
            phase: args.phase, revision: currentRevision + 1, createdAt: draft?.createdAt || now, updatedAt: now,
          };
          persistenceStore.drafts[args.requestId] = saved;
          result = persistenceResult({ draft: structuredClone(saved) });
        }
      } else if (name === "loomex_interaction_draft_delete") {
        const draft = persistenceStore.drafts[args.requestId];
        if (!draft || draft.revision !== args.expectedRevision || (args.expectedSchemaDigest && draft.schemaDigest !== args.expectedSchemaDigest)) {
          result = persistenceError("INTERACTION_DRAFT_CONFLICT", "Interaction draft revision conflict");
        } else {
          delete persistenceStore.drafts[args.requestId];
          result = persistenceResult({ requestId: args.requestId, deleted: true, revision: draft.revision + 1 });
        }
      }
      if (receiptKey && result) persistenceStore.receipts[receiptKey] = { arguments: structuredClone(args), result: structuredClone(result) };
      return result;
    };
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
        if (message.id !== undefined) event.source.postMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: window.__failNextModelContext
            ? (window.__failNextModelContext = false, { isError: true })
            : {},
        }, "*");
        return;
      }
      if (!message || message.jsonrpc !== "2.0" || message.id === undefined) return;
      if (message.method === "ui/initialize") {
        event.source.postMessage({ jsonrpc: "2.0", id: message.id, result: {
          ...(hostCapabilities ? { hostCapabilities } : {}),
        } }, "*");
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
        const failMessage = shouldFailUiMessage || Boolean(window.__failNextUiMessage);
        window.__failNextUiMessage = false;
        event.source.postMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: failMessage ? { isError: true } : {},
        }, "*");
        return;
      }
      if (message.method === "tools/call") {
        if (persistenceNames.has(message.params?.name)) {
          const result = receivePersistenceCall(message);
          if (result !== undefined) window.setTimeout(() => {
            event.source.postMessage({ jsonrpc: "2.0", id: message.id, result }, "*");
          }, Number(window.__persistenceDelayMs || 0));
          return;
        }
        window.__loomexCalls.push(message.params);
        if (!appCallableNames.has(message.params?.name)) {
          event.source.postMessage({ jsonrpc: "2.0", id: message.id,
            error: { code: -32601, message: `Tool ${message.params?.name || "unknown"} is not callable from the Loomex app` } }, "*");
          return;
        }
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
          : message.params.name === "loomex_run_get" && window.__lastRunData
            ? window.__lastRunData
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
        const returnedData = result?.structuredContent?.ok === true ? result.structuredContent.data : undefined;
        if (returnedData?.execution?.id) window.__lastRunData = returnedData;
        const returnedProjection = result?._meta?.["loomex/viewSession"];
        if (returnedProjection?.viewSessionId && !persistenceStore.sessions[returnedProjection.viewSessionId]) {
          persistenceStore.sessions[returnedProjection.viewSessionId] = structuredClone(returnedProjection);
        }
        window.setTimeout(() => {
          event.source.postMessage({ jsonrpc: "2.0", id: message.id, result }, "*");
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
    resultMeta: nativeResultMeta,
    hostCapabilities,
    workflowResponses,
    preserveHostState: reuseHost,
    appCallableToolNames,
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

async function waitForEnabledPrimary(page: any, label: string): Promise<void> {
  await page.waitForFunction((expected: string) => {
    const button = document.getElementById("app")?.contentDocument?.getElementById("primary") as HTMLButtonElement | null;
    return button?.getAttribute("aria-label") === expected && !button.disabled;
  }, label, { timeout: 5_000 });
}

async function waitForToolCount(page: any, name: string, count: number): Promise<void> {
  await page.waitForFunction(({ expectedName, expectedCount }: any) =>
    window.__loomexCalls.filter((call: any) => call.name === expectedName).length >= expectedCount,
  { expectedName: name, expectedCount: count }, { timeout: 5_000 });
}

async function waitForPersistenceToolCount(page: any, name: string, count: number): Promise<void> {
  await page.waitForFunction(({ expectedName, expectedCount }: any) =>
    window.__loomexPersistenceCalls.filter((call: any) => call.name === expectedName).length >= expectedCount,
  { expectedName: name, expectedCount: count }, { timeout: 5_000 });
}

function viewSession(
  viewSessionId: string,
  kind: "browser" | "authoring" | "prepare" | "monitor" | "interaction",
  entityType: "catalog" | "workflow" | "request" | "execution" | "builderSession" | "preparation",
  entityId: string,
  state: Record<string, unknown> = {},
) {
  return {
    viewSessionId, kind, entityType, entityId, revision: 0, state, status: "active",
    createdAt: 1_700_000_000, updatedAt: 1_700_000_000, expiresAt: null, operation: null,
  };
}

async function waitForHandoff(page: any, count = 1): Promise<void> {
  try {
    await page.waitForFunction((expected: number) =>
      window.__loomexMessages.length === expected && window.__loomexModelContexts.length === expected,
    count, { timeout: 5_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      messages: window.__loomexMessages,
      modelContexts: window.__loomexModelContexts,
    }));
    throw new Error(`Expected ${count} paired chat handoffs: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
}

async function handoffAt(page: any, index = -1): Promise<{ context: any; message: any }> {
  return page.evaluate((offset: number) => {
    const contexts = window.__loomexModelContexts;
    const messages = window.__loomexMessages;
    return { context: contexts.at(offset), message: messages.at(offset) };
  }, index);
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

async function appLayoutSnapshot(page: any): Promise<{
  mainHeight: number;
  hostHeight: number;
  reportedHeight: number;
  scrollY: number;
  focus: string;
  focusVisible: boolean;
}> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return page.evaluate(() => {
    const frame = document.getElementById("app");
    const appDocument = frame.contentDocument;
    const main = appDocument.querySelector("main");
    const active = appDocument.activeElement;
    const activeStyle = active ? appDocument.defaultView.getComputedStyle(active) : null;
    const activeRect = active?.getBoundingClientRect();
    return {
      mainHeight: Math.ceil(main.getBoundingClientRect().height),
      hostHeight: Math.ceil(frame.getBoundingClientRect().height),
      reportedHeight: Math.ceil(Number.parseFloat(frame.style.height)),
      scrollY: Math.round(window.scrollY),
      focus: active?.getAttribute("aria-label") || active?.id || active?.textContent?.trim() || "",
      focusVisible: Boolean(activeRect?.width && activeRect?.height && activeStyle?.visibility !== "hidden" && activeStyle?.display !== "none"),
    };
  });
}

function assertStableLoadingLayout(before: Awaited<ReturnType<typeof appLayoutSnapshot>>, during: Awaited<ReturnType<typeof appLayoutSnapshot>>, focus: string): void {
  assert.equal(during.mainHeight, before.mainHeight, "loading keeps the full app height stable");
  assert.equal(during.hostHeight, before.hostHeight, "loading keeps the embedding host height stable");
  assert.equal(during.reportedHeight, before.reportedHeight, "loading does not publish a transient host size");
  assert.equal(during.scrollY, before.scrollY, "loading preserves the viewport");
  assert.equal(during.focus, focus, "loading moves focus to its visible in-place status");
  assert.equal(during.focusVisible, true, "loading keeps focus on a visible element");
}

async function captureRequestedScreenshots(page: any, prefix: string): Promise<void> {
  const directory = process.env.LOOMEX_UI_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const frame = page.locator("#app");
  const original = page.viewportSize() || { width: 820, height: 1300 };
  for (const [name, width, theme] of [["wide", 820, "light"], ["mobile", 390, "light"], ["dark", 820, "dark"]] as const) {
    await page.setViewportSize({ width, height: 1300 });
    await page.emulateMedia({ colorScheme: theme });
    await frame.evaluate((element: any) => { element.style.height = `${element.contentDocument.documentElement.scrollHeight}px`; });
    await frame.screenshot({ path: resolve(directory, `${prefix}-${name}.png`) });
  }
  await page.setViewportSize(original);
}

async function reviewAndSubmit(app: any, count = 1): Promise<void> {
  await app.getByRole("button", { name: count === 1 ? "Review answer" : "Review answers", exact: true }).click();
  await app.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
  await app.getByRole("button", { name: count === 1 ? "Submit answer" : "Submit answers", exact: true }).click();
}

const options = [
  { id: "alpha", label: "Alpha" },
  { id: "beta", label: "Beta" },
];

test("question UI collects seven inline answer types, auto-advances deliberate choices, preserves drafts, and retries one mutation key", async (t) => {
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
    { id: "details", inputType: "text", question: "Detailed answer?" },
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
      schemaDigest: "a".repeat(64),
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
  await captureRequestedScreenshots(page, "batch-question");

  assert.equal(await app.locator("#diagnostics").count(), 0);
  assert.equal(await app.locator("#state").count(), 0);
  await app.getByText("Question 1 of 7", { exact: true }).waitFor();
  assert.equal(await app.locator("fieldset").count(), 7);
  assert.equal(await app.locator("fieldset:visible").count(), 1);
  assert.equal(await app.locator("textarea").count(), 0, "inline batches never render long-form textareas");
  await app.getByRole("textbox", { name: "Short answer? Your answer" }).waitFor();
  assert.equal(await app.locator("#question-0-value").getAttribute("aria-labelledby"), "question-0-legend question-0-control-label");
  assert.equal(await app.getByRole("group", { name: /Enable it/ }).getByRole("radio", { checked: true }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Review answers", exact: true }).count(), 0, "review is not persistent before the last question");

  await app.locator("#question-0-value").fill("Ada");
  await app.getByRole("button", { name: "Next question" }).click();
  await app.locator("#question-1-value").fill("Keep this detailed draft after errors.");
  await app.getByRole("button", { name: "Previous question" }).click();
  assert.equal(await app.locator("#question-0-value").inputValue(), "Ada");
  await app.getByRole("button", { name: "Next question" }).click();
  assert.equal(await app.locator("#question-1-value").inputValue(), "Keep this detailed draft after errors.");
  await app.getByRole("button", { name: "Next question" }).click();
  assert.equal(await app.locator("#question-2-value").getAttribute("type"), "date");
  assert.match(await app.locator("#question-2-legend").textContent(), /Due date\?/);
  await app.locator("#question-2-value").evaluate((control: any) => {
    control.type = "text";
    control.value = "2025-02-30";
  });
  await app.getByRole("button", { name: "Next question" }).click();
  await app.locator("#question-2-error").getByText("Enter a real date in YYYY-MM-DD format.").waitFor();
  assert.equal((await page.evaluate(() => window.__loomexCalls.length)), 0);
  assert.equal(await app.getByText("Question 3 of 7", { exact: true }).count(), 1);
  assert.equal(await app.locator("#question-1-value").inputValue(), "Keep this detailed draft after errors.");
  await app.locator("#question-2-value").evaluate((control: any) => {
    control.type = "date";
    control.value = "2024-02-29";
  });
  await app.getByRole("button", { name: "Next question" }).click();
  await app.getByText("Question 4 of 7", { exact: true }).waitFor();
  assert.equal(await app.getByRole("radiogroup", { name: "Score?" }).getByRole("radio").count(), 5);
  await app.locator('label[for="question-3-rating-4"]').click();
  await app.getByText("Question 5 of 7", { exact: true }).waitFor();
  await app.locator("#question-4-false").check();
  await app.getByText("Question 6 of 7", { exact: true }).waitFor();
  await app.locator("#question-5-other-choice").check();
  assert.equal(await app.locator("#question-5-other-entry").isVisible(), true);
  await app.locator("#question-5-other-text").fill("Custom choice");
  await app.getByRole("button", { name: "Next question" }).click();
  await app.locator("#question-6-option-0").check();
  await app.locator("#question-6-other-choice").check();
  await app.locator("#question-6-other-text").fill("Custom feature");
  await captureRequestedScreenshots(page, "batch-question-last");

  assert.equal(await app.getByRole("button", { name: "Next question", exact: true }).count(), 0);
  assert.equal(await app.locator(".question-stepper").getByRole("button", { name: "Review answers", exact: true }).count(), 1);
  assert.equal(await app.locator("#primary").isVisible(), false);
  const reviewButton = app.locator(".question-stepper").getByRole("button", { name: "Review answers", exact: true });
  assert.equal(await reviewButton.locator(".action-label").isVisible(), true);
  await reviewButton.focus();
  const reviewScrollBefore = await app.locator("body").evaluate((body: any) => body.ownerDocument.defaultView.scrollY);
  await reviewButton.click();
  assert.equal((await page.evaluate(() => window.__loomexCalls.length)), 0);
  await app.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
  assert.equal(await app.locator(":focus").textContent(), "Answer preview", "preview transition focuses its visible heading");
  assert.equal(await app.locator(":focus").getAttribute("tabindex"), "-1");
  assert.equal(await app.locator(":focus").isVisible(), true, "preview focus is never left in hidden question content");
  assert.equal(await app.locator("body").evaluate((body: any) => body.ownerDocument.defaultView.scrollY), reviewScrollBefore, "preview focus preserves the viewport");
  await app.getByText("Custom choice", { exact: false }).waitFor();
  assert.equal(await app.locator("fieldset:visible").count(), 0);
  await captureRequestedScreenshots(page, "answer-review");

  await app.getByRole("button", { name: "Edit answer 2" }).click();
  assert.equal(await app.getByText("Question 2 of 7", { exact: true }).count(), 1);
  assert.equal(await app.locator("#question-1-value").inputValue(), "Keep this detailed draft after errors.");
  await app.locator("#question-1-value").fill("Edited detailed answer.");
  assert.equal(await app.getByRole("button", { name: "Review answers", exact: true }).count(), 0);
  for (let index = 0; index < 5; index += 1) await app.getByRole("button", { name: "Next question", exact: true }).click();
  await app.getByRole("button", { name: "Review answers", exact: true }).click();
  await app.getByText("Edited detailed answer.", { exact: true }).waitFor();

  await app.getByRole("button", { name: "Submit answers" }).evaluate((button: any) => {
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
      { questionId: "details", value: "Edited detailed answer." },
      { questionId: "due", value: "2024-02-29" },
      { questionId: "score", value: 4 },
      { questionId: "enabled", value: false },
      { questionId: "choice", value: "other", otherText: "Custom choice" },
      { questionId: "features", values: ["alpha", "other"], otherText: "Custom feature" },
    ],
  });
  assert.deepEqual(Object.keys(calls[0].arguments.answer), ["answers"]);
});

test("batch choices auto-advance only after deliberate activation and the final choice opens review without submitting", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for auto-next behavior");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = "aabf4127-1c38-496a-99aa-fc3382cba17b";
  const session = viewSession("ee1366be-dee4-42f0-8d98-92423d07755f", "interaction", "request", requestId, {
    schemaVersion: 1, screen: "interaction", disclosures: {}, requestId, currentQuestionId: "enabled", phase: "answer",
  });
  const app = await mountApp(page, "interaction", { humanRequest: {
    id: requestId, type: "manual_input", schemaDigest: "a".repeat(64),
    inputSpec: { collectionMode: "batch", inputType: "text", question: "Configuration", questions: [
      { id: "enabled", inputType: "boolean", question: "Enable it?" },
      { id: "features", inputType: "checkbox", question: "Choose features", options, allowOther: false },
      { id: "choice", inputType: "radio", question: "Choose one", options, allowOther: false },
      { id: "score", inputType: "rating", question: "Final score", minimum: 1, maximum: 3 },
    ] },
    responseSchema: { type: "object", properties: { answers: { type: "array" } }, required: ["answers"] },
  } }, false, false, null, false, { "loomex/viewSession": session });
  await waitForPersistenceToolCount(page, "loomex_interaction_draft_get", 1);

  const yes = app.locator("#question-0-true");
  await captureRequestedScreenshots(page, "durable-structured-question");
  await yes.focus();
  await app.getByText("Question 1 of 4", { exact: true }).waitFor();
  await yes.press("ArrowRight");
  await app.getByText("Question 1 of 4", { exact: true }).waitFor();
  await yes.press("Enter");
  try {
    await app.getByText("Question 2 of 4", { exact: true }).waitFor({ timeout: 2_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      persistenceCalls: window.__loomexPersistenceCalls,
      store: window.__loomexPersistenceStore,
      body: document.getElementById("app")?.contentDocument?.body?.innerText,
    }));
    throw new Error(`Keyboard auto-next did not advance: ${JSON.stringify(diagnostics)}`, { cause: error });
  }

  await page.evaluate(() => { window.__persistenceDelayMs = 200; });
  await app.locator("#question-1-option-0").check();
  await app.getByText("Question 2 of 4", { exact: true }).waitFor();
  assert.equal(await app.locator("#activity").isVisible(), false, "background checkbox saves never insert a visible activity row");
  await app.getByRole("button", { name: "Next question", exact: true }).click();
  const activation = app.locator('label[for="question-2-option-1"]').click();
  await page.waitForFunction(() => window.__loomexPersistenceCalls.some((call: any) =>
    call.name === "loomex_interaction_draft_update" && call.arguments.answers?.choice?.value === "beta"));
  await app.getByText("Question 3 of 4", { exact: true }).waitFor();
  await activation;
  try {
    await app.getByText("Question 4 of 4", { exact: true }).waitFor({ timeout: 2_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      persistenceCalls: window.__loomexPersistenceCalls,
      store: window.__loomexPersistenceStore,
      body: document.getElementById("app")?.contentDocument?.body?.innerText,
    }));
    throw new Error(`Delayed auto-next did not advance: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  await page.evaluate(() => { window.__persistenceDelayMs = 0; });
  await app.locator("#save-status").waitFor({ state: "hidden" });
  await app.locator('label[for="question-3-rating-3"]').click();
  try {
    await app.getByRole("heading", { name: "Answer preview", exact: true }).waitFor({ timeout: 2_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      persistenceCalls: window.__loomexPersistenceCalls,
      store: window.__loomexPersistenceStore,
      body: document.getElementById("app")?.contentDocument?.body?.innerText,
    }));
    throw new Error(`Final auto-next did not open review: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  await captureRequestedScreenshots(page, "durable-final-preview");
  assert.equal(await app.getByRole("button", { name: "Submit answers", exact: true }).isEnabled(), true);
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), [], "auto-next and preview never submit the response");
  assert.ok((await page.evaluate(() => window.__loomexPersistenceCalls)).some((call: any) => call.name === "loomex_interaction_draft_update"));
});

test("failed and conflicting durable draft saves retain the current in-card answers", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for durable draft failure behavior");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const request = {
    id: "7acebd3d-c12d-4686-bd71-eaa708960a86", type: "manual_input", schemaDigest: "a".repeat(64),
    inputSpec: { collectionMode: "batch", inputType: "text", question: "Names", questions: [
      { id: "first", inputType: "text", question: "First name" },
      { id: "last", inputType: "text", question: "Last name" },
    ] },
    responseSchema: { type: "object", properties: { answers: { type: "array" } }, required: ["answers"] },
  };
  const session = viewSession("31025117-fd31-4f23-80d7-0acbf41470a7", "interaction", "request", request.id, {
    schemaVersion: 1, screen: "interaction", disclosures: {}, requestId: request.id, currentQuestionId: "first", phase: "answer",
  });
  const page = await browser.newPage();
  const app = await mountApp(page, "interaction", { humanRequest: request }, false, false, null, false, { "loomex/viewSession": session });
  await waitForPersistenceToolCount(page, "loomex_interaction_draft_get", 1);
  await page.evaluate(() => { window.__failNextPersistenceCall = "loomex_interaction_draft_update"; });
  await app.locator("#question-0-value").fill("Ada");
  await app.getByRole("button", { name: "Next question", exact: true }).click();
  await app.getByText("Question 1 of 2", { exact: true }).waitFor();
  assert.equal(await app.locator("#question-0-value").inputValue(), "Ada");
  await app.locator("#save-status").getByText("Your changes remain here", { exact: false }).waitFor();
  await captureRequestedScreenshots(page, "durable-save-conflict");
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), []);

  await page.evaluate(({ requestId }: any) => {
    window.__loomexPersistenceStore.drafts[requestId] = {
      requestId, schemaDigest: "b".repeat(64), answers: { first: { value: "Grace" } },
      currentQuestionId: "first", phase: "answer", revision: 1,
      createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:01.000Z",
    };
  }, { requestId: request.id });
  await app.getByRole("button", { name: "Next question", exact: true }).click();
  await app.getByText("Question 1 of 2", { exact: true }).waitFor();
  assert.equal(await app.locator("#question-0-value").inputValue(), "Ada", "a stale card never overwrites or loses its local answer");
  const updates = (await page.evaluate(() => window.__loomexPersistenceCalls)).filter((call: any) => call.name === "loomex_interaction_draft_update");
  assert.equal(updates.at(-1).arguments.expectedRevision, 0);
  assert.equal(await page.evaluate(() => window.__loomexPersistenceStore.drafts["7acebd3d-c12d-4686-bd71-eaa708960a86"].answers.first.value), "Grace");
});

test("closing and reopening interaction and authoring cards restores the exact question, answers, and review phase", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for durable question cards");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());

  const requestId = "b02ae034-17ed-41ce-ace3-e26d16503afa";
  const interactionData = { humanRequest: {
    id: requestId, type: "manual_input", schemaDigest: "a".repeat(64),
    inputSpec: { collectionMode: "batch", inputType: "text", question: "Contact", questions: [
      { id: "first", inputType: "text", question: "First name" },
      { id: "notify", inputType: "radio", question: "Notification", options, allowOther: false },
      { id: "last", inputType: "text", question: "Last name" },
    ] },
    responseSchema: { type: "object", properties: { answers: { type: "array" } }, required: ["answers"] },
  } };
  const interactionSession = viewSession("f5a3ea74-5789-4fab-8f49-0232263d0495", "interaction", "request", requestId, {
    schemaVersion: 1, screen: "interaction", disclosures: {}, requestId, currentQuestionId: "first", phase: "answer",
  });
  const interactionPage = await browser.newPage();
  interactionPage.setDefaultTimeout(5_000);
  let interaction = await mountApp(interactionPage, "interaction", interactionData, false, false, null, false,
    { "loomex/viewSession": interactionSession });
  await waitForPersistenceToolCount(interactionPage, "loomex_interaction_draft_get", 1);
  await interaction.locator("#question-0-value").fill("Ada");
  await interaction.getByRole("button", { name: "Next question", exact: true }).click();
  await interaction.getByText("Question 2 of 3", { exact: true }).waitFor();
  await interactionPage.waitForFunction((id: string) =>
    window.__loomexPersistenceStore.drafts[id]?.answers?.first?.value === "Ada", requestId, { timeout: 5_000 });
  const writesBeforeReopen = await interactionPage.evaluate(() => ({
    sessions: window.__loomexPersistenceCalls.filter((call: any) => call.name === "loomex_view_session_update").length,
    drafts: window.__loomexPersistenceCalls.filter((call: any) => call.name === "loomex_interaction_draft_update").length,
  }));
  await interactionPage.evaluate(() => { window.__persistenceDelayMs = 500; });
  interaction = await mountApp(interactionPage, "interaction", interactionData, false, false, null, false,
    { "loomex/viewSession": interactionSession }, undefined, [], true);
  const earlyInput = interaction.locator("#question-0-value");
  const earlyNext = interaction.getByRole("button", { name: "Next question", exact: true });
  assert.equal(await earlyInput.isDisabled(), true, "editable answers stay disabled until the exact saved session and draft are restored");
  assert.equal(await earlyNext.isDisabled(), true, "question navigation stays disabled during durable hydration");
  await assert.rejects(earlyInput.fill("Mallory", { timeout: 100 }), /Timeout/,
    "a user input attempt cannot pass the disabled hydration guard");
  await assert.rejects(earlyNext.click({ timeout: 100 }), /Timeout/,
    "a user navigation attempt cannot pass the disabled hydration guard");
  await waitForPersistenceToolCount(interactionPage, "loomex_interaction_draft_get", 2);
  await interaction.getByText("Question 2 of 3", { exact: true }).waitFor();
  await available.tools.expect(interaction.locator("#question-0-value")).toHaveValue("Ada");
  assert.deepEqual(await interactionPage.evaluate(() => ({
    sessions: window.__loomexPersistenceCalls.filter((call: any) => call.name === "loomex_view_session_update").length,
    drafts: window.__loomexPersistenceCalls.filter((call: any) => call.name === "loomex_interaction_draft_update").length,
  })), writesBeforeReopen, "pre-hydration input and navigation cannot write over the saved session or draft");
  assert.equal(await interaction.locator("#question-1-option-0").isEnabled(), true, "the restored current answer becomes editable after hydration");
  await interactionPage.evaluate(() => { window.__persistenceDelayMs = 0; });
  await interaction.locator("#question-1-option-0").check();
  await interaction.getByText("Question 3 of 3", { exact: true }).waitFor();
  await interaction.locator("#question-2-value").fill("Lovelace");
  await interaction.getByRole("button", { name: "Review answers", exact: true }).click();
  await interaction.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
  await interactionPage.waitForFunction((id: string) => window.__loomexPersistenceStore.drafts[id]?.phase === "review", requestId);
  interaction = await mountApp(interactionPage, "interaction", interactionData, false, false, null, false,
    { "loomex/viewSession": interactionSession }, undefined, [], true);
  await waitForPersistenceToolCount(interactionPage, "loomex_interaction_draft_get", 3);
  await interaction.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
  await interaction.getByText("Lovelace", { exact: true }).waitFor();
  await captureRequestedScreenshots(interactionPage, "durable-restored-review");
  assert.deepEqual(await interactionPage.evaluate(() => window.__loomexCalls), [], "restoring a reviewed draft never submits it");

  const builderSessionId = "acfd8507-1739-4985-9502-c911e91dc19d";
  const authoringData = { builderSession: { id: builderSessionId }, humanRequest: {
    id: "21b85126-40b4-449b-a276-3639cfc3a42c", schemaDigest: "b".repeat(64),
    inputSpec: { collectionMode: "batch", inputType: "text", question: "Workflow", questions: [
      { id: "goal", inputType: "text", question: "Goal" },
      { id: "output", inputType: "text", question: "Output" },
    ] },
    responseSchema: { type: "object", properties: { answers: { type: "array" } }, required: ["answers"] },
  } };
  const authoringSession = viewSession("3a98f056-fcca-4d6c-9e82-91c879868f61", "authoring", "builderSession", builderSessionId, {
    schemaVersion: 1, screen: "authoring", disclosures: {}, builderSessionId, controls: {}, currentQuestionId: "goal", phase: "answer",
  });
  const authoringPage = await browser.newPage();
  authoringPage.setDefaultTimeout(5_000);
  let authoring = await mountApp(authoringPage, "authoring", authoringData, false, false, null, false,
    { "loomex/viewSession": authoringSession });
  await waitForPersistenceToolCount(authoringPage, "loomex_view_session_get", 1);
  await authoring.locator("#question-0-value").fill("Build a durable UI");
  await authoring.getByRole("button", { name: "Next question", exact: true }).click();
  await authoring.locator("#question-1-value").fill("Browser tests");
  await authoring.getByRole("button", { name: "Review answers", exact: true }).click();
  await authoring.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
  authoring = await mountApp(authoringPage, "authoring", authoringData, false, false, null, false,
    { "loomex/viewSession": authoringSession }, undefined, [], true);
  await waitForPersistenceToolCount(authoringPage, "loomex_view_session_get", 2);
  await authoring.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
  await authoring.getByText("Build a durable UI", { exact: true }).waitFor();
  await authoring.getByText("Browser tests", { exact: true }).waitFor();
  assert.deepEqual(await authoringPage.evaluate(() => window.__loomexCalls), []);
});

test("refresh reconciles only the exact resolved response and hands its bound run to chat", async (t) => {
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
  const runId = "b1fb2e33-3e51-4f1d-9b36-00b09ab6b617";
  const conflictingRunId = "4a6a7682-ac22-47d3-969e-6b3e1c925f08";
  const app = await mountApp(page, "interaction", {
    humanRequest: {
      id: requestId,
      status: "pending",
      type: "manual_input",
      schemaDigest: "a".repeat(64),
      title: "One response only",
      execution: { id: runId },
      inputSpec: { inputType: "text", question: "What should happen?" },
      responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    },
  }, true);

  await app.getByRole("textbox", { name: "What should happen? Your answer" }).fill("Submitted once");
  await reviewAndSubmit(app);
  await waitForCallCount(page, 1);
  await app.getByText("submission outcome is uncertain", { exact: false }).waitFor();
  await page.evaluate(({ requestId, runId, conflictingRunId }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: { humanRequest: {
      id: requestId, status: "resolved", execution: { id: conflictingRunId }, answer: { value: "Submitted once" },
    } } } },
    { structuredContent: { ok: true, data: { humanRequest: {
      id: requestId, status: "resolved", execution: { id: runId }, answer: { value: "Submitted once" },
    } } } },
  ]; }, { requestId, runId, conflictingRunId });
  await app.getByRole("button", { name: "Refresh" }).click();
  await waitForCallCount(page, 2);
  await app.getByText("server still reports this request as pending", { exact: false }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Retry exact response", exact: true }).isEnabled(), true);
  assert.deepEqual(await page.evaluate(() => window.__loomexModelContexts), []);
  assert.deepEqual(await page.evaluate(() => window.__loomexMessages), []);
  await app.getByRole("button", { name: "Refresh" }).click();
  await waitForCallCount(page, 3);
  await app.getByText("Sent to chat", { exact: true }).first().waitFor();
  assert.equal(await app.locator("#form").isHidden(), true);
  assert.equal(await app.getByRole("button", { name: "Retry exact response" }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Continue" }).count(), 0);
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_interaction_respond", "loomex_interaction_get", "loomex_interaction_get"]);
  assert.deepEqual(calls[1].arguments, { requestId });
  assert.deepEqual(calls[2].arguments, { requestId });
  assert.equal(calls.filter((call: any) => call.name === "loomex_interaction_respond").length, 1, "read reconciliation cannot replay the response mutation");
  await waitForHandoff(page);
  const { context, message } = await handoffAt(page);
  assert.deepEqual(JSON.parse(context.content[0].text), {
    schema: "loomex/chat-continuation/v2",
    intent: "monitor_existing_run",
    runId,
    trigger: "interaction_accepted",
    acceptedInteraction: { requestId, status: "resolved" },
    state: "requires_fresh_read",
  });
  assert.match(message.content[0].text, new RegExp(`^\\$loomex-follow ${runId}\\n`));
  assert.match(message.content[0].text, new RegExp(`accepted my response to request ${requestId} \\([^)]+\\)`, "i"));
  assert.doesNotMatch(message.content[0].text, /Submitted once|What should happen\?/);
  assert.notEqual(context.content[0].text, message.content[0].text);
});

test("an ambiguous response journal rehydrates locked reviewed answers without replaying the mutation", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for durable response recovery");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = "3fb65e95-8037-4144-abf3-6c3c202181b0";
  const runId = "70c160b1-41b3-4050-b7ef-04b4a21b9916";
  const data = { humanRequest: {
    id: requestId, status: "pending", type: "manual_input", execution: { id: runId }, schemaDigest: "a".repeat(64),
    inputSpec: { inputType: "text", question: "Release name" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  } };
  const session = viewSession("48e1b608-5d1e-42e0-a1f9-550a2c581633", "interaction", "request", requestId, {
    schemaVersion: 1, screen: "interaction", disclosures: {}, requestId, currentQuestionId: null, phase: "answer",
  });
  let app = await mountApp(page, "interaction", data, true, false, null, false, { "loomex/viewSession": session });
  await waitForPersistenceToolCount(page, "loomex_interaction_draft_get", 1);
  await app.getByRole("textbox", { name: "Release name Your answer" }).fill("Loomex Durable");
  await reviewAndSubmit(app);
  await app.getByRole("button", { name: "Retry exact response", exact: true }).waitFor();
  const original = (await page.evaluate(() => window.__loomexCalls))[0];
  assert.equal(original.name, "loomex_interaction_respond");
  await page.waitForFunction(() => Object.values(window.__loomexPersistenceStore.operations).some((operation: any) => operation.status === "ambiguous"));
  const journaledResponse = await page.evaluate(() => Object.values(window.__loomexPersistenceStore.operations).find((operation: any) => operation.status === "ambiguous"));
  assert.equal(journaledResponse.method, "interactions.respond");
  assert.deepEqual(journaledResponse.reconciliation, { method: "interactions.get", params: { requestId } });

  app = await mountApp(page, "interaction", data, false, false, null, false, { "loomex/viewSession": session }, undefined, [
    { structuredContent: { ok: true, data: { requestId, requestStatus: "resolved", executionId: runId, executionStatus: "running", error: null } } },
  ], true);
  await waitForPersistenceToolCount(page, "loomex_view_operation_get", 1);
  await waitForPersistenceToolCount(page, "loomex_interaction_draft_get", 2);
  await app.getByRole("button", { name: "Retry exact response", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__loomexCalls.length), 1, "opening the replacement card performs no response mutation");
  assert.equal(await app.locator("#question-0-value").inputValue(), "Loomex Durable");
  assert.equal(await app.locator("#question-0-value").isDisabled(), true, "the exact restored response remains locked");
  await app.getByRole("button", { name: "Retry exact response", exact: true }).click();
  await waitForToolCount(page, "loomex_interaction_respond", 2);
  const responses = (await page.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_interaction_respond");
  assert.deepEqual(responses[1].arguments, original.arguments);
  await app.getByText("Sent to chat", { exact: true }).first().waitFor();
  const settlements = (await page.evaluate(() => window.__loomexPersistenceCalls))
    .filter((call: any) => call.name === "loomex_view_operation_settle");
  assert.deepEqual(settlements.map((call: any) => call.arguments.status), ["ambiguous", "completed"]);
  assert.notEqual(settlements[0].arguments.idempotencyKey, settlements[1].arguments.idempotencyKey,
    "changing an operation settlement from ambiguous to completed requires a distinct exact idempotency key");
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
  const runId = "f7a9f767-0a1a-45e2-93de-5ddfddf3098b";
  const app = await mountApp(page, "interaction", {
    humanRequest: {
      id: requestId,
      status: "pending",
      type: "approval",
      title: "Approve the release?",
      execution: { id: runId },
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
  await app.getByRole("button", { name: "Retry exact approval", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__loomexCalls.length), 1);

  await page.evaluate(({ requestId, runId }: any) => {
    window.__workflowResponses = [{ structuredContent: { ok: true, data: {
      requestId, requestStatus: "approved", executionId: runId, error: null,
    } } }];
  }, { requestId, runId });
  await app.getByRole("button", { name: "Retry exact approval" }).click();
  await waitForCallCount(page, 2);
  await app.getByText("Sent to chat", { exact: true }).first().waitFor();
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_interaction_decide", "loomex_interaction_decide"]);
  assert.deepEqual(calls[0].arguments, calls[1].arguments);
  assert.equal(calls[0].arguments.requestId, requestId);
  assert.equal(calls[0].arguments.decision, "approve");
  await waitForHandoff(page);
  const { context, message } = await handoffAt(page);
  assert.deepEqual(JSON.parse(context.content[0].text), {
    schema: "loomex/chat-continuation/v2",
    intent: "monitor_existing_run",
    runId,
    trigger: "interaction_accepted",
    acceptedInteraction: { requestId, status: "approved" },
    state: "requires_fresh_read",
  });
  assert.match(message.content[0].text, new RegExp(`^\\$loomex-follow ${runId}\\n`));
  assert.match(message.content[0].text, new RegExp(`accepted my response to request ${requestId} \\([^)]+\\)`, "i"));
  assert.doesNotMatch(message.content[0].text, /Approve the release\?/);
  assert.notEqual(context.content[0].text, message.content[0].text);
});

test("authoring supports inline text and simple schemas while rejecting long-text aliases and invalid question specs", async (t) => {
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
      schemaDigest: "a".repeat(64),
      title: "Clarify the workflow",
      inputSpec: { inputType: "text", question: "Describe the desired behavior" },
      responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    },
  });
  const answer = app.getByRole("textbox", { name: "Your answer" });
  await answer.fill("Preserve the inputSpec prompt.");
  await reviewAndSubmit(app);
  await waitForCallCount(page, 1);
  const [call] = await page.evaluate(() => window.__loomexCalls);
  assert.equal(call.name, "loomex_builder_respond");
  assert.deepEqual(call.arguments.response, { value: "Preserve the inputSpec prompt." });

  const aliasPage = await browser.newPage();
  const alias = await mountApp(aliasPage, "authoring", {
    builderSession: { id: "5d09b91c-452c-4825-b705-1e86e5041552" },
    humanRequest: {
      id: "7d530224-53b4-4a67-b48b-6c8d430d6f8b",
      inputSpec: { inputType: "textarea", question: "Write a long answer" },
      responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    },
  });
  await alias.getByRole("alert").getByText("must be collected in the conversation", { exact: false }).first().waitFor();
  assert.equal(await alias.locator("textarea").count(), 0);
  assert.equal(await alias.getByRole("button", { name: "Review answer", exact: true }).count(), 0);
  assert.deepEqual(await aliasPage.evaluate(() => window.__loomexCalls), []);

  const fallbackPage = await browser.newPage();
  const fallback = await mountApp(fallbackPage, "interaction", {
    humanRequest: {
      id: "dd7843c2-7694-426a-ae51-fbc3af88d415",
      type: "manual_input",
      schemaDigest: "a".repeat(64),
      responseSchema: { type: "object", properties: { comment: { type: "string" } }, required: ["comment"] },
    },
  });
  assert.equal(await fallback.locator("fieldset").count(), 0);
  await fallback.getByRole("textbox", { name: "comment" }).fill("Schema fallback remains available");
  await reviewAndSubmit(fallback);
  await waitForCallCount(fallbackPage, 1);
  const [fallbackCall] = await fallbackPage.evaluate(() => window.__loomexCalls);
  assert.deepEqual(fallbackCall.arguments.answer, { comment: "Schema fallback remains available" });

  const invalidPage = await browser.newPage();
  const invalid = await mountApp(invalidPage, "interaction", {
    humanRequest: {
      id: "ee7843c2-7694-426a-ae51-fbc3af88d415",
      type: "manual_input",
      schemaDigest: "a".repeat(64),
      inputSpec: { inputType: "file", question: "Upload a file" },
      responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    },
  });
  await invalid.getByRole("alert").getByText("This question cannot be displayed here", { exact: false }).first().waitFor();
  assert.equal(await invalid.getByRole("button", { name: "Review answer" }).isDisabled(), true);
});

test("a singular long-text request routes to chat without rendering or submitting an inline textarea", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for long-answer routing");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = "2e40c40e-6274-42ee-9e72-a7c2cd3bcc22";
  const app = await mountApp(page, "interaction", {
    humanRequest: {
      id: requestId,
      type: "manual_input",
      schemaDigest: "a".repeat(64),
      answerChannel: "chat",
      inputSpec: { inputType: "long_text", question: "Describe the proposed architecture", collectionMode: "single" },
      responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    },
  }, false, false, null, false, { "loomex/answerChannel": "chat" });
  await app.getByRole("heading", { name: "Describe the proposed architecture", exact: true }).waitFor();
  assert.equal(await app.locator("textarea").count(), 0);
  assert.equal(await app.getByRole("button", { name: "Review answer", exact: true }).count(), 0);
  await app.getByRole("button", { name: "Continue in conversation", exact: true }).click();
  await page.waitForFunction(() => window.__loomexMessages.length === 1);
  await captureRequestedScreenshots(page, "long-answer-chat-handoff");
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), [], "opening chat must never submit an answer");
  const [message] = await page.evaluate(() => window.__loomexMessages);
  assert.match(message.content[0].text, new RegExp(`^\\$loomex-answer ${requestId}\\n`));
  assert.match(message.content[0].text, /collect my long-form answer there/i);
  assert.doesNotMatch(message.content[0].text, /Describe the proposed architecture/);
});

test("single questions lead with the question and current stage while reviews retain decision context", async (t) => {
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
      schemaDigest: "a".repeat(64),
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
      inputSpec: { inputType: "text", question, collectionMode: "single" },
      responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    },
  });
  assert.equal(await app.locator("legend").filter({ hasText: question }).count(), 1);
  assert.equal(await app.locator(".request-copy").getByText(question, { exact: true }).count(), 0);
  assert.equal(await app.getByText(/1 question/).count(), 0);
  await app.getByText("A sentence or two is enough to begin.", { exact: true }).waitFor();
  assert.equal(await app.getByText("Describe Your Idea", { exact: true }).count(), 0);
  assert.equal(await app.locator(".progress-steps").count(), 0);
  await app.locator(".app-header").getByText("Clarify", { exact: true }).waitFor();
  assert.equal(await app.getByText(/Requirements context/).count(), 0);
  assert.equal(await app.getByText("Use the existing Loomex workspace.", { exact: true }).count(), 0);
  assert.equal(await app.getByText("Which output should be easiest to review?", { exact: true }).count(), 0);
  assert.doesNotMatch(await app.locator("body").innerText(), /must-not-render/);
  await app.getByRole("button", { name: "Review answer", exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Review answer", exact: true }).locator(".action-label").isVisible(), true);
  const helperDescriptions = await app.getByRole("textbox", { name: `${question} Your answer` }).evaluate((el: any) => String(el.getAttribute("aria-describedby") || "").split(/\s+/).map((id: string) => el.ownerDocument.getElementById(id)?.textContent || "").join(" "));
  assert.match(helperDescriptions, /We have the goal and are narrowing the workflow behavior/);
  await captureRequestedScreenshots(page, "single-idea");
  await app.getByRole("button", { name: "Refresh", exact: true }).waitFor();

  const reviewPage = await browser.newPage();
  await reviewPage.setViewportSize({ width: 390, height: 900 });
  const noncanonicalStage = `Post-build review ${"x".repeat(500)}`;
  app = await mountApp(reviewPage, "interaction", {
    humanRequest: {
      id: "39f69fd1-e9ca-4700-8c31-0fa7fc009517",
      type: "manual_input",
      schemaDigest: "a".repeat(64),
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
  await captureRequestedScreenshots(reviewPage, "implementation-review");
  assert.equal(await app.locator('[aria-current="step"]').count(), 0);
  assert.equal(await app.locator("body").evaluate((body: any) => body.scrollWidth <= body.clientWidth), true);
  for (const copy of ["src/dashboard.ts", "Chrome interaction check passed.", "No hosted preview is available.", "Local dashboard source"]) {
    await app.getByText(copy, { exact: true }).waitFor();
  }
  assert.doesNotMatch(await app.locator("body").innerText(), /raw-output-must-not-render/);
  await app.getByRole("radio", { name: "Request changes", exact: true }).check();
  await reviewAndSubmit(app);
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
  await app.getByRole("button", { name: "Approve", exact: true }).waitFor();
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
  await active.locator("#cancellation-details > summary").click();
  await active.getByRole("textbox", { name: "Cancellation reason", exact: true }).waitFor();
  assert.equal(await active.getByRole("button", { name: "Follow in chat", exact: true }).isEnabled(), true);
  await activePage.waitForTimeout(200);
  assert.deepEqual(await activePage.evaluate(() => window.__loomexCalls), []);
  await active.locator('#form input[data-field="reason"]').fill("The requirements changed.");
  await active.getByRole("button", { name: "Cancel run", exact: true }).click();
  await waitForCallCount(activePage, 1);
  const activeCalls = await activePage.evaluate(() => window.__loomexCalls);
  assert.equal(activeCalls[0].name, "loomex_run_cancel");
  assert.equal(activeCalls[0].arguments.reason, "The requirements changed.");

  const pagedPage = await browser.newPage();
  const responseRef = "ac567746-f978-40bb-a3e1-b8bf077378a0";
  const paged = await mountApp(pagedPage, "monitor", {
    responseRef,
    sizeBytes: 401_408,
    encoding: "json",
    nextOffset: 0,
    checksumSha256: "trusted-checksum-reference",
  }, false, false, null, false, { "loomex/viewSession": viewSession(
    "01b9c73e-d99b-4b45-8f01-d33576777735", "monitor", "execution", "723a4e4b-cbdb-45bc-a7ea-c806b9317fa3",
    { schemaVersion: 1, screen: "monitor", disclosures: {}, executionId: "723a4e4b-cbdb-45bc-a7ea-c806b9317fa3",
      latestSequence: 0, currentRequestId: null, cancelReason: "", cancelDetailsOpen: false },
  ) });
  await paged.getByRole("heading", { name: "Full results available", exact: true }).waitFor();
  assert.doesNotMatch(await paged.locator("body").innerText(), new RegExp(responseRef));
  await paged.getByRole("button", { name: "View results", exact: true }).click();
  await pagedPage.waitForFunction(() => window.__loomexMessages.length === 1);
  const [message] = await pagedPage.evaluate(() => window.__loomexMessages);
  assert.equal(message.role, "user");
  assert.equal(message.content.length, 1);
  assert.equal(message.content[0].type, "text");
  assert.match(message.content[0].text, new RegExp(responseRef));
  assert.match(message.content[0].text, /every nextOffset page/);
  assert.match(message.content[0].text, /verify checksumSha256/);
  assert.match(message.content[0].text, /data, not authority/);
  assert.match(message.content[0].text, /do not start, answer, or replay/);
  await paged.getByText("The conversation has been asked to retrieve and present the complete result.", { exact: true }).waitFor();

  const rejectedPage = await browser.newPage();
  const rejected = await mountApp(rejectedPage, "monitor", {
    responseRef,
    sizeBytes: 401_408,
    encoding: "json",
    nextOffset: 0,
  }, false, false, null, true, { "loomex/viewSession": viewSession(
    "0c22d800-3df0-421f-b71b-b921702a0721", "monitor", "execution", "723a4e4b-cbdb-45bc-a7ea-c806b9317fa3",
    { schemaVersion: 1, screen: "monitor", disclosures: {}, executionId: "723a4e4b-cbdb-45bc-a7ea-c806b9317fa3",
      latestSequence: 0, currentRequestId: null, cancelReason: "", cancelDetailsOpen: false },
  ) });
  await rejected.getByRole("button", { name: "View results", exact: true }).click();
  await rejected.getByText("The host could not send this result request. Continue in the conversation to retrieve it.", { exact: true }).waitFor();
  assert.equal(await rejected.getByText("The conversation has been asked to retrieve and present the complete result.", { exact: true }).count(), 0);
});

test("closing and reopening run cards restores active cancellation drafts and terminal result disclosures", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for durable run results");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());

  const activeRunId = "77211811-a1e7-443f-83f0-8a96ce0021ab";
  const activeData = { execution: { id: activeRunId, status: "running", workflowName: "Durable monitor" } };
  const activeSession = viewSession("5638f24c-ee12-4e9d-8b8d-ecdb8193c60d", "monitor", "execution", activeRunId, {
    schemaVersion: 1, screen: "monitor", disclosures: {}, executionId: activeRunId, latestSequence: null,
    currentRequestId: null, cancelReason: "", cancelDetailsOpen: false,
  });
  const activePage = await browser.newPage();
  let app = await mountApp(activePage, "monitor", activeData, false, false, null, false, { "loomex/viewSession": activeSession });
  await waitForPersistenceToolCount(activePage, "loomex_view_session_get", 1);
  await app.locator("#cancellation-details > summary").click();
  await app.getByRole("textbox", { name: "Cancellation reason", exact: true }).fill("Keep this reason across cards");
  await waitForPersistenceToolCount(activePage, "loomex_view_session_update", 1);
  app = await mountApp(activePage, "monitor", activeData, false, false, null, false, { "loomex/viewSession": activeSession }, undefined, [], true);
  await waitForPersistenceToolCount(activePage, "loomex_view_session_get", 2);
  assert.equal(await app.locator("#cancellation-details").getAttribute("open"), "");
  await available.tools.expect(app.getByRole("textbox", { name: "Cancellation reason", exact: true })).toHaveValue("Keep this reason across cards");
  assert.deepEqual(await activePage.evaluate(() => window.__loomexCalls), []);

  const completedRunId = "ead5098f-3f6b-498f-9b52-aa2230df348d";
  const completedData = { execution: { id: completedRunId, status: "completed", workflowName: "Durable results", result: {
    version: 1, summary: "The durable result is ready.", changedFiles: ["result.md"], verification: [], limitations: [], artifacts: [],
  } } };
  const completedSession = viewSession("5718f6dd-847d-43bf-ac64-d48dac9b643f", "monitor", "execution", completedRunId, {
    schemaVersion: 1, screen: "monitor", disclosures: {}, executionId: completedRunId,
  });
  const completedPage = await browser.newPage();
  app = await mountApp(completedPage, "monitor", completedData, false, false, null, false, { "loomex/viewSession": completedSession });
  await waitForPersistenceToolCount(completedPage, "loomex_view_session_get", 1);
  const references = app.locator("details").last();
  await references.locator("summary").click();
  await waitForPersistenceToolCount(completedPage, "loomex_view_session_update", 1);
  app = await mountApp(completedPage, "monitor", completedData, false, false, null, false, { "loomex/viewSession": completedSession }, undefined, [], true);
  await waitForPersistenceToolCount(completedPage, "loomex_view_session_get", 2);
  assert.equal(await app.locator("details").last().getAttribute("open"), "");
  await app.getByText("The durable result is ready.", { exact: true }).waitFor();
  assert.deepEqual(await completedPage.evaluate(() => window.__loomexCalls), []);
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
    schemaDigest: "a".repeat(64),
    title: "Shape the idea",
    inputSpec: { schemaVersion: "loomex.human-input/v2", collectionMode: "batch", inputType: "text", question: "Idea details", questions: [
      { id: "idea", inputType: "text", question: "What should we build?" },
      { id: "confirmed", inputType: "boolean", question: "Are these requirements complete?" },
    ] },
    responseSchema: { type: "object", properties: { answers: { type: "array" } }, required: ["answers"] },
  };
  const app = await mountApp(page, "monitor", { execution, humanRequest: firstRequest, waitState: "human_action_required" });
  await app.getByRole("textbox", { name: "What should we build? Your answer" }).fill("A local planning board");
  await app.getByRole("button", { name: "Next question", exact: true }).click();
  await app.locator("#question-1-false").check();
  await app.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Cancel run", exact: true }).count(), 1, "cancellation stays separate from the answer form");

  const approval = {
    id: approvalId, status: "pending", type: "approval", execution: { id: runId, organizationId },
    title: "Approve implementation?", prompt: "Approve the reviewed plan before implementation.",
  };
  await page.evaluate(({ execution, firstRequestId, approval }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: { requestId: firstRequestId, requestStatus: "resolved", executionId: execution.id, executionStatus: "queued", error: null } } },
    { structuredContent: { ok: true, data: { execution: { ...execution, requiredAction: "Approve implementation" }, humanRequest: approval, waitState: "human_action_required" } } },
  ]; }, { execution, firstRequestId, approval });
  await app.getByRole("button", { name: "Submit answers", exact: true }).click();
  await app.getByText("Sent to chat", { exact: true }).first().waitFor();
  const firstCalls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(firstCalls.map((call: any) => call.name), ["loomex_interaction_respond"]);
  assert.deepEqual(firstCalls[0].arguments.answer, { answers: [
    { questionId: "idea", value: "A local planning board" },
    { questionId: "confirmed", value: false },
  ] });
  assert.equal(firstCalls[0].arguments.requestId, firstRequestId);
  await waitForHandoff(page);
  const firstHandoff = await handoffAt(page);
  assert.deepEqual(JSON.parse(firstHandoff.context.content[0].text), {
    schema: "loomex/chat-continuation/v2",
    intent: "monitor_existing_run",
    runId,
    trigger: "interaction_accepted",
    acceptedInteraction: { requestId: firstRequestId, status: "resolved" },
    state: "requires_fresh_read",
  });
  assert.match(firstHandoff.message.content[0].text, new RegExp(`^\\$loomex-follow ${runId}\\n`));
  assert.match(firstHandoff.message.content[0].text, new RegExp(`accepted my response to request ${firstRequestId} \\([^)]+\\)`, "i"));
  assert.doesNotMatch(firstHandoff.message.content[0].text, /A local planning board|What should we build\?|Shape the idea/);
  assert.notEqual(firstHandoff.context.content[0].text, firstHandoff.message.content[0].text);
  await app.getByRole("button", { name: "Refresh run", exact: true }).click();
  await app.getByRole("button", { name: "Approve", exact: true }).waitFor();

  const terminal = { execution: { ...execution, status: "completed", requiredAction: undefined, result: { version: 1, summary: "Implementation complete." } } };
  await page.evaluate(({ runId, approvalId, terminal }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: { requestId: approvalId, requestStatus: "approved", executionId: runId, executionStatus: "queued", error: null } } },
    { structuredContent: { ok: true, data: terminal } },
  ]; }, { runId, approvalId, terminal });
  await app.getByRole("button", { name: "Approve", exact: true }).click();
  await app.getByText("Sent to chat", { exact: true }).first().waitFor();
  await app.getByRole("button", { name: "Refresh run", exact: true }).click();
  await app.getByText("Implementation complete.", { exact: true }).waitFor();
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_interaction_respond", "loomex_run_get", "loomex_interaction_decide", "loomex_run_get"]);
  assert.equal(calls[2].arguments.requestId, approvalId);
  assert.equal(calls[2].arguments.decision, "approve");
  assert.equal(await app.getByRole("button", { name: "Continue" }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Approve" }).count(), 0);
  await waitForHandoff(page, 2);
  const approvalHandoff = await handoffAt(page, 1);
  assert.deepEqual(JSON.parse(approvalHandoff.context.content[0].text), {
    schema: "loomex/chat-continuation/v2",
    intent: "monitor_existing_run",
    runId,
    trigger: "interaction_accepted",
    acceptedInteraction: { requestId: approvalId, status: "approved" },
    state: "requires_fresh_read",
  });
  assert.match(approvalHandoff.message.content[0].text, new RegExp(`^\\$loomex-follow ${runId}\\n`));
  assert.match(approvalHandoff.message.content[0].text, new RegExp(`accepted my response to request ${approvalId} \\([^)]+\\)`, "i"));
  assert.doesNotMatch(approvalHandoff.message.content[0].text, /Approve implementation\?|Approve the reviewed plan/);
  assert.notEqual(approvalHandoff.context.content[0].text, approvalHandoff.message.content[0].text);
});

test("run monitor preserves an exact ambiguous response and hands off without an implicit read", async (t) => {
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
    schemaDigest: "a".repeat(64),
    inputSpec: { inputType: "text", question: "Describe the exact goal" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  const app = await mountApp(page, "monitor", { execution, humanRequest: request, waitState: "human_action_required" });
  const answer = app.getByRole("textbox", { name: "Describe the exact goal Your answer" });
  await answer.fill("Keep this exact answer");
  await page.evaluate(() => { window.__workflowResponses = [{ isError: true, structuredContent: { ok: false, error: { code: "NETWORK_AMBIGUOUS", message: "The response outcome is unknown" } } }]; });
  await reviewAndSubmit(app);
  await app.getByRole("button", { name: "Retry exact response", exact: true }).waitFor({ timeout: 5_000 });
  await waitForCallCount(page, 1);
  await waitForEnabledPrimary(page, "Retry exact response");
  const sealed = (await page.evaluate(() => window.__loomexCalls))[0];
  assert.equal(await answer.isDisabled(), true);

  await page.evaluate(({ requestId, runId }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: { requestId, requestStatus: "resolved", executionId: runId, executionStatus: "queued", error: null } } },
  ]; }, { requestId, runId });
  await app.getByRole("button", { name: "Retry exact response", exact: true }).click();
  await app.getByText("Sent to chat", { exact: true }).first().waitFor({ timeout: 5_000 });
  const afterAccepted = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(afterAccepted[1].arguments, sealed.arguments, "an ambiguous response retries the exact request and idempotency key");
  assert.deepEqual(afterAccepted.map((call: any) => call.name), ["loomex_interaction_respond", "loomex_interaction_respond"]);
  assert.equal(afterAccepted.filter((call: any) => call.name === "loomex_interaction_respond").length, 2);
  assert.equal(await app.getByRole("button", { name: "Retry exact response" }).count(), 0, "a failed read cannot resurrect an accepted mutation");
  assert.equal(await app.getByRole("button", { name: "Continue" }).count(), 0);
  assert.equal((await page.evaluate(() => window.__loomexMessages)).length, 1);
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
    schemaDigest: "a".repeat(64),
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
  assert.equal(await app.getByRole("button", { name: "Review answer", exact: true }).isEnabled(), true);

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
    schemaDigest: "a".repeat(64),
    inputSpec: { inputType: "text", question }, responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } });
  const app = await mountApp(page, "monitor", { execution, humanRequest: request(firstId, "First question"), latestSequence: 20 }, true);
  await app.getByRole("textbox", { name: "First question Your answer" }).fill("Sealed first answer");
  await reviewAndSubmit(app);
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
    schemaDigest: "a".repeat(64),
    inputSpec: { inputType: "text", question: "Trusted question" }, responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  const app = await mountApp(page, "monitor", { execution, humanRequest: first, latestSequence: 40 }, true);
  await app.getByRole("textbox", { name: "Trusted question Your answer" }).fill("Sealed trusted answer");
  await reviewAndSubmit(app);
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
    schemaDigest: "a".repeat(64),
    inputSpec: { inputType: "text", question: "Verified baseline question" }, responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  await page.evaluate(({ runId, preparationId, invalidRequest, baselineRequest }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: {
      execution: { id: runId, status: "running", workflowName: "Accepted boundary" }, executionPolicy: "host_user/v1", preparationId, humanRequest: invalidRequest,
    } } },
    { structuredContent: { ok: true, data: {
      execution: { id: runId, status: "waiting", workflowName: "Accepted boundary" }, humanRequest: baselineRequest, latestSequence: 1,
    } } },
  ]; }, { runId, preparationId, invalidRequest, baselineRequest });
  await app.getByRole("button", { name: "Start run", exact: true }).click();
  try {
    await app.getByText("Sent to chat", { exact: true }).first().waitFor({ timeout: 2_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({ body: document.getElementById("app")?.contentDocument?.body?.innerText,
      calls: window.__loomexCalls, persistenceCalls: window.__loomexPersistenceCalls, store: window.__loomexPersistenceStore,
      phaseTrace: document.getElementById("app")?.contentWindow?.__loomexUiPhaseTrace }));
    throw new Error(`Accepted commit did not hand off: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls)).map((call: any) => call.name), ["loomex_run_commit", "loomex_run_get"]);
  await waitForHandoff(page);
  const { context: startedContext, message: startedMessage } = await handoffAt(page);
  assert.deepEqual(JSON.parse(startedContext.content[0].text), {
    schema: "loomex/chat-continuation/v2",
    intent: "monitor_existing_run",
    runId,
    trigger: "run_started",
    state: "requires_fresh_read",
  });
  assert.match(startedMessage.content[0].text, new RegExp(`^\\$loomex-follow ${runId}\\n`));
  assert.match(startedMessage.content[0].text, /Loomex accepted the start of this run/);
  assert.match(startedMessage.content[0].text, /Call loomex_run_get for this exact runId before replying about its state/);
  assert.doesNotMatch(startedMessage.content[0].text, /Wrong run question|Verified baseline question/);
  assert.notEqual(startedContext.content[0].text, startedMessage.content[0].text);
  await app.getByRole("button", { name: "Refresh run", exact: true }).click();
  await app.getByRole("textbox", { name: "Verified baseline question Your answer" }).waitFor();
  assert.equal(await app.getByText("Wrong run question", { exact: true }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Retry exact start" }).count(), 0);
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls)).map((call: any) => call.name), ["loomex_run_commit", "loomex_run_get", "loomex_run_get"]);

  const minimalPage = await browser.newPage();
  const minimal = await mountApp(minimalPage, "prepare", prepared, false, false, presentation);
  const asynchronousRequest = { id: "1e5bc673-0d04-43ab-a037-8ad40bc86d35", status: "pending", type: "manual_input", execution: { id: runId },
    schemaDigest: "a".repeat(64),
    inputSpec: { inputType: "text", question: "Question created after commit" }, responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  await minimalPage.evaluate(({ runId, preparationId, asynchronousRequest }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: { execution: { id: runId, status: "queued", workflowName: "Accepted boundary" }, executionPolicy: "host_user/v1", preparationId } } },
    { structuredContent: { ok: true, data: { execution: { id: runId, status: "running", workflowName: "Accepted boundary" } } } },
    { structuredContent: { ok: true, data: { execution: { id: runId, status: "waiting", workflowName: "Accepted boundary" }, humanRequest: asynchronousRequest } } },
    { structuredContent: { ok: true, data: { execution: { id: runId, status: "waiting", workflowName: "Accepted boundary" }, humanRequest: asynchronousRequest } } },
  ]; }, { runId, preparationId, asynchronousRequest });
  await minimal.getByRole("button", { name: "Start run", exact: true }).click();
  await minimal.getByText("Sent to chat", { exact: true }).first().waitFor();
  await minimal.getByRole("button", { name: "Refresh run", exact: true }).click();
  await waitForToolCount(minimalPage, "loomex_run_get", 2);
  await minimal.getByRole("button", { name: "Refresh run", exact: true }).locator("xpath=self::*[not(@disabled)]").waitFor();
  await minimal.getByRole("button", { name: "Refresh run", exact: true }).click();
  await waitForToolCount(minimalPage, "loomex_run_get", 3);
  await minimal.getByRole("textbox", { name: "Question created after commit Your answer" }).waitFor();
  const minimalCalls = await minimalPage.evaluate(() => window.__loomexCalls);
  assert.deepEqual(minimalCalls.map((call: any) => call.name), ["loomex_run_commit", "loomex_run_get", "loomex_run_get", "loomex_run_get"]);
  assert.deepEqual(minimalCalls.slice(1).map((call: any) => call.arguments), [
    { runId }, { runId }, { runId },
  ]);
  assert.equal(await minimal.getByRole("button", { name: "Retry exact start" }).count(), 0);

  const cancelPage = await browser.newPage();
  const requestId = "2cb31855-0787-4ebd-8d4d-00cd67551ba6";
  const monitor = await mountApp(cancelPage, "monitor", { execution: { id: runId, status: "waiting", workflowName: "Accepted cancellation" }, latestSequence: 30,
    humanRequest: { id: requestId, status: "pending", type: "manual_input", execution: { id: runId },
      schemaDigest: "a".repeat(64),
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

test("active monitor never polls automatically and Follow in chat uses acknowledged safe handoff", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for the chat handoff boundary");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const runId = "c2d06603-5da9-46e4-aa9c-a100971928e8";
  const execution = { id: runId, status: "running", workflowName: "Long-running workflow" };
  const app = await mountApp(page, "monitor", { execution });
  await page.clock.install();
  await page.clock.fastForward(120_000);
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), [], "elapsed time must not schedule a run read or wait");
  assert.deepEqual(await page.evaluate(() => window.__loomexMessages), []);
  await app.getByRole("button", { name: "Follow in chat", exact: true }).click();
  await app.getByText("Sent to chat", { exact: true }).first().waitFor();
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), []);
  await waitForHandoff(page);
  const { context: modelContext, message } = await handoffAt(page);
  assert.deepEqual(JSON.parse(modelContext.content[0].text), {
    schema: "loomex/chat-continuation/v2",
    intent: "monitor_existing_run",
    runId,
    trigger: "follow_requested",
    state: "requires_fresh_read",
  });
  assert.equal(typeof modelContext.content[0].text, "string");
  const messageText = message.content[0].text;
  assert.match(messageText, new RegExp(`^\\$loomex-follow ${runId}\\n`));
  assert.match(messageText, /Call loomex_run_get for this exact runId before replying about its state/);
  assert.match(messageText, /loomex_run_wait with timeoutSeconds 30/);
  assert.match(messageText, /loomex_interaction_view/);
  assert.doesNotMatch(messageText, /loomex_interaction_get/);
  assert.match(messageText, /Never start another run or replay a submitted answer/);
  assert.doesNotMatch(messageText, /confirmationKey|credential/i);
  assert.notEqual(modelContext.content[0].text, messageText, "factual context metadata and the chat command must be distinct payloads");
});

test("accepted run response retries only a failed chat handoff", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for the chat retry boundary");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const runId = "568d3d8f-c568-49d4-a8ce-3ba0afdb7084";
  const requestId = "bbd24b29-19e4-4d04-ab07-cfd43e6c86d2";
  const request = { id: requestId, status: "pending", type: "manual_input", execution: { id: runId },
    schemaDigest: "a".repeat(64),
    inputSpec: { inputType: "text", question: "Name the deliverable" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  const app = await mountApp(page, "interaction", { humanRequest: request });
  await page.evaluate(({ requestId, runId }: any) => {
    window.__failNextUiMessage = true;
    window.__workflowResponses = [{ structuredContent: { ok: true, data: {
      requestId, requestStatus: "resolved", executionId: runId, executionStatus: "running", error: null,
    } } }];
  }, { requestId, runId });
  await app.getByRole("textbox", { name: "Name the deliverable Your answer" }).fill("Release brief");
  await reviewAndSubmit(app);
  await app.getByRole("button", { name: "Retry chat handoff", exact: true }).waitFor();
  await app.getByRole("heading", { name: "Submitted answers", exact: true }).waitFor();
  await app.getByText("Release brief", { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.__loomexCalls)).length, 1);
  assert.equal((await page.evaluate(() => window.__loomexCalls))[0].name, "loomex_interaction_respond");
  assert.equal(await app.getByRole("button", { name: "Retry exact response" }).count(), 0);
  await app.getByLabel("Read-only resume command").getByText(new RegExp(runId)).waitFor();
  await app.getByRole("button", { name: "Retry chat handoff", exact: true }).click();
  await app.getByText("Sent to chat", { exact: true }).first().waitFor();
  assert.equal((await page.evaluate(() => window.__loomexCalls)).length, 1, "handoff retry cannot repeat the accepted response");
  await waitForHandoff(page, 2);
  const firstHandoff = await handoffAt(page, 0);
  const retryHandoff = await handoffAt(page, 1);
  const firstContext = JSON.parse(firstHandoff.context.content[0].text);
  const retryContext = JSON.parse(retryHandoff.context.content[0].text);
  assert.deepEqual(firstContext, {
    schema: "loomex/chat-continuation/v2",
    intent: "monitor_existing_run",
    runId,
    trigger: "interaction_accepted",
    acceptedInteraction: { requestId, status: "resolved" },
    state: "requires_fresh_read",
  });
  assert.deepEqual(retryContext, firstContext, "failed handoff retry must retain the original accepted receipt and context");
  assert.equal(retryHandoff.message.content[0].text, firstHandoff.message.content[0].text, "failed handoff retry must retain the original chat command");
  assert.match(retryHandoff.message.content[0].text, new RegExp(`^\\$loomex-follow ${runId}\\n`));
  assert.match(retryHandoff.message.content[0].text, new RegExp(`accepted my response to request ${requestId} \\([^)]+\\)`, "i"));
  assert.doesNotMatch(retryHandoff.message.content[0].text, /Release brief|Name the deliverable/);
});

test("standalone response requires an exact accepted receipt before chat handoff", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for the standalone acceptance boundary");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const runId = "a5eb8ed0-c43b-4576-88a9-ecc6bb12c83b";
  const requestId = "ac650a03-2f20-4ad6-8bcc-2f51a5f158c1";
  const wrongRequestId = "e5c8b367-b2c2-4d54-9a74-514165b733cc";
  const request = { id: requestId, status: "pending", type: "manual_input", execution: { id: runId },
    schemaDigest: "a".repeat(64),
    inputSpec: { inputType: "text", question: "Name the release" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  const app = await mountApp(page, "interaction", { humanRequest: request });
  await page.evaluate(({ requestId, wrongRequestId, runId }: any) => {
    window.__workflowResponses = [
      { structuredContent: { ok: true, data: { requestId: wrongRequestId, requestStatus: "resolved", executionId: runId, error: null } } },
      { structuredContent: { ok: true, data: { requestId, requestStatus: "pending", executionId: runId, error: null } } },
      { structuredContent: { ok: true, data: { requestId, requestStatus: "resolved", executionId: runId, error: { code: "NOT_ACCEPTED" } } } },
      { structuredContent: { ok: true, data: { requestId, requestStatus: "resolved", executionId: runId, executionStatus: "running", error: null } } },
    ];
  }, { requestId, wrongRequestId, runId });

  await app.getByRole("textbox", { name: "Name the release Your answer" }).fill("Loomex 0.3");
  await reviewAndSubmit(app);
  await app.getByRole("button", { name: "Retry exact response", exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__loomexModelContexts), []);
  assert.deepEqual(await page.evaluate(() => window.__loomexMessages), []);

  for (const expectedCount of [2, 3]) {
    await app.getByRole("button", { name: "Retry exact response", exact: true }).click();
    await waitForCallCount(page, expectedCount);
    await app.getByRole("button", { name: "Retry exact response", exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__loomexModelContexts), []);
    assert.deepEqual(await page.evaluate(() => window.__loomexMessages), []);
  }

  await app.getByRole("button", { name: "Retry exact response", exact: true }).click();
  await waitForCallCount(page, 4);
  await app.getByText("Sent to chat", { exact: true }).first().waitFor();
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), Array(4).fill("loomex_interaction_respond"));
  assert.ok(calls.every((call: any) => JSON.stringify(call.arguments) === JSON.stringify(calls[0].arguments)), "every retry must keep the reviewed answer and operation ID");
  assert.deepEqual(calls[0].arguments.answer, { value: "Loomex 0.3" });
  await waitForHandoff(page);
  const { context, message } = await handoffAt(page);
  assert.deepEqual(JSON.parse(context.content[0].text), {
    schema: "loomex/chat-continuation/v2",
    intent: "monitor_existing_run",
    runId,
    trigger: "interaction_accepted",
    acceptedInteraction: { requestId, status: "resolved" },
    state: "requires_fresh_read",
  });
  assert.match(message.content[0].text, new RegExp(`^\\$loomex-follow ${runId}\\n`));
  assert.match(message.content[0].text, new RegExp(`accepted my response to request ${requestId} \\([^)]+\\)`, "i"));
  assert.match(message.content[0].text, /Call loomex_run_get for this exact runId before replying about its state/);
  assert.doesNotMatch(message.content[0].text, /Loomex 0\.3|Name the release/);
  assert.doesNotMatch(context.content[0].text, /Loomex 0\.3|Name the release/);
  assert.notEqual(context.content[0].text, message.content[0].text);

  const manualPage = await browser.newPage();
  const manual = await mountApp(manualPage, "interaction", { humanRequest: request }, false, false, null, false, undefined, null);
  await manualPage.evaluate(({ requestId, runId }: any) => {
    window.__workflowResponses = [{ structuredContent: { ok: true, data: {
      requestId, requestStatus: "resolved", executionId: runId, error: null,
    } } }];
  }, { requestId, runId });
  await manual.getByRole("textbox", { name: "Name the release Your answer" }).fill("Manual release");
  await reviewAndSubmit(manual);
  await manual.getByLabel("Read-only resume command").waitFor();
  const manualCommand = await manual.getByLabel("Read-only resume command").textContent();
  assert.match(manualCommand || "", new RegExp(`^\\$loomex-follow ${runId}`));
  assert.match(manualCommand || "", new RegExp(`accepted my response to request ${requestId} \\([^)]+\\)`, "i"));
  assert.doesNotMatch(manualCommand || "", /Manual release|Name the release/);
  assert.equal(await manualPage.evaluate(() => window.__loomexMessages.length), 0);
  assert.equal(await manualPage.evaluate(() => window.__loomexModelContexts.length), 0);
  await manualPage.close();
});

test("missing or non-text host chat capabilities show the exact manual monitor command", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for capability fallback");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const runId = "01532d74-93bd-425d-b830-c5b900730917";
  const unsupportedCapabilities = [
    null,
    {},
    { message: { image: {} }, updateModelContext: { image: {} } },
    { message: { text: {} }, updateModelContext: { image: {} } },
  ];
  for (const hostCapabilities of unsupportedCapabilities) {
    const page = await browser.newPage();
    const app = await mountApp(page, "monitor", { execution: { id: runId, status: "running", workflowName: "Manual continuation" } }, false, false, null, false, undefined, hostCapabilities);
    await app.getByRole("button", { name: "Follow in chat", exact: true }).click();
    await app.getByText("This host cannot send the run to chat automatically.", { exact: false }).first().waitFor();
    const command = await app.getByLabel("Read-only resume command").textContent();
    assert.match(command || "", new RegExp(`^\\$loomex-follow ${runId}`));
    assert.match(command || "", /Never start another run/);
    assert.match(command || "", /timeoutSeconds 30/);
    assert.deepEqual(await page.evaluate(() => window.__loomexModelContexts), []);
    assert.deepEqual(await page.evaluate(() => window.__loomexMessages), []);
    assert.deepEqual(await page.evaluate(() => window.__loomexCalls), []);
    await page.close();
  }
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
      builderSession: { id: "6f6a05ff-d3cc-4cd4-8e82-0187eb7ea3af" },
      humanRequest: { id: "a65a502c-13fc-48bf-8e8f-d5a201574e58", type: "input", responseSchema: {
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
    preparationId: "2c453a73-f6ea-4d80-b342-4698a76857d7", bindingDigest: "d".repeat(64), confirmationKey: "c13ae6fd-bdab-4a9c-9930-fc74c40aeb6e",
    binding: { organizationId: "37d767c3-3498-4e87-a624-e705401581f8", installationId: "4e5e924c-c701-4e39-bcee-20d287e38d39", workflowId: "f1777a89-4e48-4557-9508-5b7e86f8383b",
      versionId: "55250c28-c2a8-4af4-abee-9bca6a1583a0", workspacePath: "/Users/example/report", executionPolicy: "host_user/v1",
      inputs: { title: "Quarterly report", includeCharts: false, nested: { secret: "hidden-input" } }, providerConfiguration: { codex: { model: "chosen-model", credentials: { value: "hidden-provider" }, apiToken: "hidden-token" } } },
  };
  let app = await mountApp(page, "prepare", prepared, false, false, {
    schemaVersion: "loomex/preparation-review/v1",
    preparationId: prepared.preparationId, bindingDigest: prepared.bindingDigest,
    workflowId: prepared.binding.workflowId, versionId: prepared.binding.versionId,
    organizationId: prepared.binding.organizationId, workflowName: "Weekly report",
    workflowVersion: 3, organizationName: "Organization A", providers: [{ name: "codex", model: "chosen-model" }],
  });
  await waitForPersistenceToolCount(page, "loomex_view_session_get", 1);
  await app.getByRole("heading", { name: "Weekly report", exact: true }).waitFor();
  await app.getByText("Quarterly report", { exact: true }).waitFor();
  await app.locator(".provider-row").getByText("chosen-model", { exact: true }).waitFor();
  assert.match(await app.locator("#context").innerText(), /starting folder, not a sandbox/);
  assert.doesNotMatch(await app.locator("body").innerText(), /never-display-this|bindingDigest|Technical details|hidden-input|hidden-provider|hidden-token/);
  assert.equal(await app.locator("#primary").isDisabled(), false);
  app = await mountApp(page, "prepare", { ...prepared, binding: {} });
  assert.equal(await app.locator("#primary").isDisabled(), true);
  await app.locator("#primary").evaluate((button: any) => button.dispatchEvent(new Event("click")));
  await app.locator('#summary[role="alert"]').waitFor();
  assert.equal(await page.evaluate(() => window.__loomexCalls.length), 0);
  app = await mountApp(page, "interaction", { humanRequest: { id: "9e047622-f8b8-46b2-b39e-233ff6fb813a", type: "approval", title: "Publish report?", prompt: "This report will be available to your team." } });
  await app.getByRole("heading", { name: "Publish report?" }).waitFor();
  await app.getByText("This report will be available to your team.", { exact: true }).waitFor();
  app = await mountApp(page, "monitor", { execution: { id: "e75ac70b-d72d-4eb2-93ad-bacbe56ccdfc", status: "running" } });
  await app.getByText("Running", { exact: true }).waitFor();
});

test("prepared run shows one readable permission review and preserves exact commit after status check", async (t) => {
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
  await app.locator(".ui-hero").getByText("Loomex Studio", { exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Start run", exact: true }).isEnabled(), true);
  const visible = await app.locator("body").innerText();
  for (const id of [prepared.binding.workflowId, prepared.binding.versionId, prepared.binding.organizationId, prepared.binding.installationId]) assert.ok(!visible.includes(id));
  assert.equal((visible.match(/Idea to Implementation/g) || []).length, 1);
  assert.equal((visible.match(/Loomex Studio/g) || []).length, 1);
  assert.equal((visible.match(/Version 1/gi) || []).length, 1);
  assert.equal((visible.match(/This Mac/g) || []).length, 1);
  assert.match(visible, /Permissions/);
  assert.match(visible, /read and change files and run commands/);
  assert.match(visible, /starting folder, not a sandbox/);
  assert.doesNotMatch(visible, /private-confirmation|internal-checksum|sizeBytes|host_user\/v1|Exact authorization scope/);
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
  await page.evaluate(() => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: {
      execution: { id: "1c5f36e6-ac6f-41a3-b593-edf31e691e37", name: "Idea to Implementation", status: "running" },
      executionPolicy: "host_user/v1", preparationId: "5aae202b-f5d0-44fc-9dc2-3f50457932eb",
    } } },
    { structuredContent: { ok: true, data: {
    execution: { id: "1c5f36e6-ac6f-41a3-b593-edf31e691e37", name: "Idea to Implementation", status: "running" },
    executionPolicy: "host_user/v1", preparationId: "5aae202b-f5d0-44fc-9dc2-3f50457932eb",
  } } }]; });
  await app.getByRole("button", { name: "Start run", exact: true }).click();
  await app.getByText("Sent to chat", { exact: true }).first().waitFor();
  const calls = await page.evaluate(() => window.__loomexCalls);
  const commit = calls.find((call: any) => call.name === "loomex_run_commit");
  assert.deepEqual(Object.keys(commit.arguments).sort(), ["preparationId", "bindingDigest", "confirmationKey", "idempotencyKey"].sort());
  assert.equal(commit.arguments.preparationId, prepared.preparationId);
  assert.equal(commit.arguments.bindingDigest, prepared.bindingDigest);
  assert.equal(commit.arguments.confirmationKey, prepared.confirmationKey);
  const contexts = await page.evaluate(() => window.__loomexModelContexts);
  assert.equal(contexts.length, 1);
  assert.match(contexts[0].content[0].text, /1c5f36e6-ac6f-41a3-b593-edf31e691e37/);
  assert.doesNotMatch(contexts[0].content[0].text, /private-confirmation/);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_readiness", "loomex_readiness", "loomex_run_commit", "loomex_run_get"]);
  assert.deepEqual(calls.at(-1).arguments, { runId: "1c5f36e6-ac6f-41a3-b593-edf31e691e37" });
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

test("stale preparations require a fresh review without reusing confirmation or changing sealed inputs", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for stale preparation recovery");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  const workflowId = "c816dafc-ed1d-4d82-bb79-954f7659cb33";
  const versionId = "5a87c6ce-6e34-4f39-817a-f5362701892a";
  const organizationId = "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2";
  const installationId = "62e9d3fa-097b-46fb-9f87-34b4d8c1b40b";
  const binding = { workflowId, versionId, organizationId, installationId, workspacePath: "/Users/example/exact-project",
    inputs: { idea: "Preserve this exact idea", directoryPath: "/Users/example/exact-project" }, executionPolicy: "host_user/v1", providerConfiguration: {} };
  const prepared = { preparationId: "0d55a15b-64c3-4d06-bcc2-591e4d4c185b", bindingDigest: "b".repeat(64),
    confirmationKey: "e67be35d-7803-4462-855c-11efcc463c78", binding };
  const presentation = { schemaVersion: "loomex/preparation-review/v1", preparationId: prepared.preparationId, bindingDigest: prepared.bindingDigest,
    workflowId, versionId, organizationId, workflowName: "Stale recovery", workflowVersion: 7, organizationName: "Loomex Studio", providers: [] };
  const app = await mountApp(page, "prepare", prepared, false, false, presentation);

  await page.evaluate(() => { window.__workflowResponses = [{ isError: true, structuredContent: { ok: false, error: {
    code: "NETWORK_AMBIGUOUS", message: "The start outcome is unknown",
  } } }]; });
  await app.getByRole("button", { name: "Start run", exact: true }).click().catch(async (error: unknown) => {
    const diagnostics = await page.evaluate(() => ({ body: document.getElementById("app")?.contentDocument?.body?.innerText,
      calls: window.__loomexCalls, persistenceCalls: window.__loomexPersistenceCalls,
      primary: document.getElementById("app")?.contentDocument?.getElementById("primary")?.outerHTML }));
    throw new Error(`Initial stale preparation never became actionable: ${JSON.stringify(diagnostics)}`, { cause: error });
  });
  await app.getByRole("button", { name: "Retry exact start", exact: true }).waitFor();
  await waitForEnabledPrimary(page, "Retry exact start");
  const ambiguousCommit = (await page.evaluate(() => window.__loomexCalls))[0];
  await page.evaluate(() => { window.__workflowResponses = [{ isError: true, structuredContent: { ok: false, error: {
    code: "EXECUTION_BINDING_CONFLICT", message: "The workflow or its execution settings changed after preparation.",
  } } }]; });
  await app.getByRole("button", { name: "Retry exact start", exact: true }).click();
  await app.getByRole("button", { name: "Review again", exact: true }).waitFor({ timeout: 5_000 }).catch(async (error: unknown) => {
    const state = await page.evaluate(() => ({ calls: window.__loomexCalls, body: document.getElementById("app").contentDocument.body.innerText, action: document.getElementById("app").contentDocument.getElementById("primary").outerHTML }));
    throw new Error(`Stale-preparation recovery did not render: ${JSON.stringify(state)}`, { cause: error });
  });
  const staleCommit = (await page.evaluate(() => window.__loomexCalls))[1];
  assert.deepEqual(staleCommit.arguments, ambiguousCommit.arguments, "an ambiguous start retains its exact confirmation and idempotency key");
  assert.equal(await app.getByRole("button", { name: "Start run" }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Edit setup" }).count(), 0, "a direct preparation must not expose a broken setup route");

  await page.evaluate(() => { window.__workflowResponses = [{ isError: true, structuredContent: { ok: false, error: {
    code: "BACKEND_UNAVAILABLE", message: "Loomex is temporarily unavailable.",
  } } }]; });
  await app.getByRole("button", { name: "Review again", exact: true }).click();
  await app.getByRole("button", { name: "Review again", exact: true }).waitFor();
  const failedPrepare = (await page.evaluate(() => window.__loomexCalls))[2];
  assert.equal(failedPrepare.name, "loomex_run_prepare");
  assert.deepEqual(failedPrepare.arguments.inputs, binding.inputs);
  assert.equal(failedPrepare.arguments.workflowId, workflowId);
  assert.equal(failedPrepare.arguments.versionId, versionId);
  assert.equal(failedPrepare.arguments.workspacePath, binding.workspacePath);
  assert.equal("confirmationKey" in failedPrepare.arguments, false);

  const malformed = { ...prepared, preparationId: "", bindingDigest: "", confirmationKey: "" };
  const malformedPresentation = { ...presentation, preparationId: "", bindingDigest: "" };
  await page.evaluate(({ malformed, malformedPresentation }: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: malformed },
    _meta: { "loomex/preparationReview": malformedPresentation } }]; }, { malformed, malformedPresentation });
  await app.getByRole("button", { name: "Review again", exact: true }).click();
  await app.getByRole("button", { name: "Retry exact preparation", exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Start run" }).count(), 0);

  await page.evaluate(({ prepared, presentation }: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: prepared },
    _meta: { "loomex/preparationReview": presentation } }]; }, { prepared, presentation });
  await app.getByRole("button", { name: "Retry exact preparation", exact: true }).click();
  await app.getByRole("button", { name: "Retry exact preparation", exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Start run" }).count(), 0, "the retired preparation cannot be replayed as fresh");

  const fresh = { ...prepared, preparationId: "96cb9398-50b8-474b-8ab4-f8053007e52d", bindingDigest: "f".repeat(64),
    confirmationKey: "4af9c17f-8b87-4a36-ae72-039cdd9643aa" };
  const freshPresentation = { ...presentation, preparationId: fresh.preparationId, bindingDigest: fresh.bindingDigest };
  const reusedConfirmation = { ...fresh, confirmationKey: prepared.confirmationKey };
  await page.evaluate(({ reusedConfirmation, freshPresentation }: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: reusedConfirmation },
    _meta: { "loomex/preparationReview": freshPresentation } }]; }, { reusedConfirmation, freshPresentation });
  await app.getByRole("button", { name: "Retry exact preparation", exact: true }).click();
  await app.getByRole("button", { name: "Retry exact preparation", exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Start run" }).count(), 0, "a fresh preparation ID cannot reuse the retired confirmation");

  await page.evaluate(({ fresh, freshPresentation }: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: fresh },
    _meta: { "loomex/preparationReview": freshPresentation } }]; }, { fresh, freshPresentation });
  await app.getByRole("button", { name: "Retry exact preparation", exact: true }).click();
  await app.getByRole("button", { name: "Start run", exact: true }).waitFor().catch(async (error: unknown) => {
    const diagnostics = await page.evaluate(() => ({ body: document.getElementById("app")?.contentDocument?.body?.innerText,
      calls: window.__loomexCalls, persistenceCalls: window.__loomexPersistenceCalls,
      phaseTrace: document.getElementById("app")?.contentWindow?.__loomexUiPhaseTrace }));
    throw new Error(`Fresh stale-preparation review did not render: ${JSON.stringify(diagnostics)}`, { cause: error });
  });
  const prepareCalls = (await page.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_run_prepare");
  const freshPrepare = prepareCalls.at(-1);
  assert.deepEqual({ ...freshPrepare.arguments, idempotencyKey: undefined }, { ...failedPrepare.arguments, idempotencyKey: undefined });
  assert.notEqual(freshPrepare.arguments.idempotencyKey, failedPrepare.arguments.idempotencyKey, "a definitive reprepare failure gets a fresh operation ID");
  assert.deepEqual(prepareCalls.slice(1).map((call: any) => call.arguments), [freshPrepare.arguments, freshPrepare.arguments, freshPrepare.arguments, freshPrepare.arguments],
    "invalid or replayed preparation responses retain the exact reprepare operation");
  assert.doesNotMatch(await app.locator("body").innerText(), new RegExp(`${prepared.confirmationKey}|${fresh.confirmationKey}`));

  await page.evaluate(() => { window.__workflowResponses = [{ isError: true, structuredContent: { ok: false, error: {
    code: "MODEL_CATALOG_UNAVAILABLE", message: "The AI model catalog is temporarily unavailable.",
  } } }]; });
  await app.getByRole("button", { name: "Start run", exact: true }).click();
  await app.getByText("This reviewed preparation remains ready to start.", { exact: false }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Start run", exact: true }).isEnabled(), true);
  assert.equal(await app.getByRole("button", { name: "Review again" }).count(), 0);

  const integratedPage = await browser.newPage();
  const setup = { workflow: { id: workflowId, organizationId, name: "Integrated stale recovery" }, inputSchema: { type: "object", properties: {}, required: [] },
    selectedVersion: { id: versionId, workflowId, versionNumber: 7, definition: { settings: { inputSchema: { type: "object", properties: {}, required: [] } }, nodes: [] } } };
  const integrated = await mountApp(integratedPage, "prepare", setup);
  await integrated.getByLabel("Workspace directory *", { exact: true }).fill(binding.workspacePath);
  const integratedPrepared = { ...prepared, binding: { ...binding, inputs: {} } };
  const integratedPresentation = { ...presentation, preparationId: integratedPrepared.preparationId, bindingDigest: integratedPrepared.bindingDigest,
    workflowName: "Integrated stale recovery" };
  await integratedPage.evaluate(({ binding, integratedPrepared, integratedPresentation }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: {
      workspace: { path: binding.workspacePath, organizationId: binding.organizationId, installationId: binding.installationId }, executionPolicy: "host_user/v1",
    } } },
    { structuredContent: { ok: true, data: integratedPrepared }, _meta: { "loomex/preparationReview": integratedPresentation } },
  ]; }, { binding, integratedPrepared, integratedPresentation });
  await integrated.getByRole("button", { name: "Review run", exact: true }).click();
  await integrated.getByRole("button", { name: "Start run", exact: true }).waitFor();
  await integratedPage.evaluate(() => { window.__workflowResponses = [{ isError: true, structuredContent: { ok: false, error: {
    code: "PRECONDITION_FAILED", message: "Loomex state changed and the operation must be prepared again.",
  } } }]; });
  await integrated.getByRole("button", { name: "Start run", exact: true }).click();
  await integrated.getByRole("button", { name: "Review again", exact: true }).waitFor();
  assert.equal(await integrated.getByRole("button", { name: "Start run" }).count(), 0);
  assert.equal(await integrated.getByRole("button", { name: "Edit setup", exact: true }).isEnabled(), true);
  const integratedFresh = { ...integratedPrepared, preparationId: "5fc4d9fd-155a-420b-93c3-3cfc3348e427", bindingDigest: "8".repeat(64),
    confirmationKey: "fab94eaf-e5c4-4fc3-836d-655436605907" };
  const integratedFreshPresentation = { ...integratedPresentation, preparationId: integratedFresh.preparationId, bindingDigest: integratedFresh.bindingDigest };
  await integratedPage.evaluate(({ integratedFresh, integratedFreshPresentation }: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: integratedFresh },
    _meta: { "loomex/preparationReview": integratedFreshPresentation } }]; }, { integratedFresh, integratedFreshPresentation });
  await integrated.getByRole("button", { name: "Review again", exact: true }).click();
  await integrated.getByRole("button", { name: "Start run", exact: true }).waitFor();
  await waitForToolCount(integratedPage, "loomex_run_prepare", 2);
  const integratedReprepare = (await integratedPage.evaluate(() => window.__loomexCalls).then((calls: any[]) => calls.filter((call) => call.name === "loomex_run_prepare"))).at(-1);
  assert.equal("inputs" in integratedReprepare.arguments, false);
  assert.equal(integratedReprepare.arguments.versionId, versionId);
  assert.equal(integratedReprepare.arguments.workspacePath, binding.workspacePath);
});

test("task workspace defaults can be changed before review without becoming workflow inputs", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium required for task workspace setup");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const workflowId = "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e";
  const organizationId = "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2";
  const versionId = "8b29c880-1c68-4d47-a1ff-477ab28d3c49";
  const setup = {
    workflow: { id: workflowId, organizationId, name: "Task-aware workflow" },
    inputSchema: { type: "object", additionalProperties: false, properties: { title: { type: "string", title: "Title" } }, required: ["title"] },
    selectedVersion: { id: versionId, workflowId, versionNumber: 1, definition: { settings: {
      inputSchema: { type: "object", properties: { title: { type: "string", title: "Title" } }, required: ["title"] },
    }, nodes: [] } },
  };
  const taskContext = { cwd: "/Users/example/current-task" };
  const app = await mountApp(page, "prepare", setup, false, false, null, false, {
    "loomex/taskWorkspace": { taskContext, workspacePath: "/Users/example/explicit-choice" },
  });
  const workspace = app.getByLabel("Workspace directory *", { exact: true });
  await workspace.waitFor();
  assert.equal(await workspace.inputValue(), "/Users/example/explicit-choice", "an explicit user workspace wins over task cwd");
  assert.equal(await workspace.getAttribute("readonly"), "");
  assert.equal(await app.getByText("Selected for this run. Change it if needed.", { exact: true }).isVisible(), true);
  await app.getByLabel("Title *", { exact: true }).fill("Release notes");
  await app.getByRole("button", { name: "Change workspace", exact: true }).click();
  await workspace.fill("/Users/example/changed-workspace");
  const prepared = {
    preparationId: "f3d92f21-2b8f-4b88-9be4-9d34c31dd9bd",
    bindingDigest: "c".repeat(64),
    confirmationKey: "2f0ae8f2-8e47-490b-b2b4-0f6f35a3d0c7",
    binding: { workflowId, versionId, organizationId, installationId: "62e9d3fa-097b-46fb-9f87-34b4d8c1b40b",
      workspacePath: "/Users/example/changed-workspace", executionPolicy: "host_user/v1",
      inputs: { title: "Release notes" }, providerConfiguration: {} },
  };
  const presentation = {
    schemaVersion: "loomex/preparation-review/v1", preparationId: prepared.preparationId,
    bindingDigest: prepared.bindingDigest, workflowId, versionId, organizationId,
    workflowName: "Task-aware workflow", workflowVersion: 1, organizationName: "Loomex Studio", providers: [],
  };
  await page.evaluate(({ organizationId, prepared, presentation }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: {
      workspace: { path: "/Users/example/changed-workspace", organizationId, installationId: "62e9d3fa-097b-46fb-9f87-34b4d8c1b40b" },
      executionPolicy: "host_user/v1",
    } } },
    { structuredContent: { ok: true, data: prepared }, _meta: { "loomex/preparationReview": presentation } },
  ]; }, { organizationId, prepared, presentation });
  await app.getByRole("button", { name: "Review run", exact: true }).click();
  await app.getByRole("button", { name: "Start run", exact: true }).waitFor();
  const calls = await page.evaluate(() => window.__loomexCalls);
  const grant = calls[0];
  assert.equal(grant.name, "loomex_workspace_grant");
  assert.equal(grant.arguments.workspacePath, "/Users/example/changed-workspace");
  assert.equal("directoryPath" in grant.arguments, false);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_workspace_grant", "loomex_run_prepare"]);
  assert.deepEqual(calls[1].arguments.inputs, { title: "Release notes" });
  await app.getByText("changed-workspace", { exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Grant workspace access", exact: true }).count(), 0);

  const reusedPage = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const reusedApp = await mountApp(reusedPage, "prepare", setup, false, false, null, false, {
    "loomex/taskWorkspace": { taskContext },
  });
  const reusedWorkspace = reusedApp.getByLabel("Workspace directory *", { exact: true });
  await reusedWorkspace.waitFor();
  assert.equal(await reusedWorkspace.inputValue(), taskContext.cwd);
  await reusedPage.evaluate((setupData: any) => {
    const frame = document.getElementById("app");
    frame.contentWindow.postMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { ok: true, data: setupData } },
    }, "*");
  }, setup);
  await reusedPage.waitForFunction(() =>
    document.getElementById("app")?.contentDocument?.getElementById("run-workspace")?.value === "",
  );
  assert.equal(await reusedWorkspace.inputValue(), "", "a context-free top-level result must not reuse the prior task path");
  assert.equal(await reusedApp.getByRole("button", { name: "Change workspace", exact: true }).count(), 0);
});

test("known task workspace automatically prepares zero-input runs and reseals after a workspace change", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium required for automatic task workspace preparation");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const workflowId = "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e";
  const organizationId = "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2";
  const versionId = "8b29c880-1c68-4d47-a1ff-477ab28d3c49";
  const installationId = "62e9d3fa-097b-46fb-9f87-34b4d8c1b40b";
  const workspacePath = "/Users/example/current-task";
  const changedWorkspacePath = "/Users/example/changed-task";
  const taskContext = { cwd: workspacePath };
  const requestId = "e8d5ee8f-7b94-4fb7-95a4-59cfce1c8498";
  const setup = {
    workflow: { id: workflowId, organizationId, name: "Automatic task workflow" },
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    selectedVersion: { id: versionId, workflowId, versionNumber: 1, definition: {
      executionPolicy: "host_user/v1", settings: { inputSchema: { type: "object", properties: {}, required: [] } }, nodes: [],
    } },
  };
  const prepared = {
    preparationId: "f8e554df-6eb5-4eb5-a794-d3ad3ea788e8", bindingDigest: "1".repeat(64),
    confirmationKey: "9cbd59c3-27a6-45f1-a2d8-5552b1ed7f9e",
    binding: { workflowId, versionId, organizationId, installationId, workspacePath, executionPolicy: "host_user/v1", inputs: {}, providerConfiguration: {} },
  };
  const presentation = {
    schemaVersion: "loomex/preparation-review/v1", preparationId: prepared.preparationId,
    bindingDigest: prepared.bindingDigest, workflowId, versionId, organizationId,
    workflowName: "Automatic task workflow", workflowVersion: 1, organizationName: "Loomex Studio", providers: [],
  };
  const grant = { structuredContent: { ok: true, data: {
    workspace: { path: workspacePath, organizationId, installationId }, executionPolicy: "host_user/v1",
  } } };
  const preparation = { structuredContent: { ok: true, data: prepared }, _meta: { "loomex/preparationReview": presentation } };
  const app = await mountApp(page, "prepare", setup, false, false, null, false,
    { requestId, "loomex/taskWorkspace": { taskContext } }, undefined, [grant, preparation]);
  await app.getByRole("button", { name: "Start run", exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Grant workspace access", exact: true }).count(), 0);
  let calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_workspace_grant", "loomex_run_prepare"]);
  assert.equal(calls.filter((call: any) => call.name === "loomex_run_commit").length, 0, "automatic preparation must never start the run");
  assert.deepEqual(calls[0].arguments, {
    workspacePath, organizationId, idempotencyKey: calls[0].arguments.idempotencyKey,
  });
  assert.equal(calls[1].arguments.workflowId, workflowId);
  assert.equal(calls[1].arguments.versionId, versionId);
  assert.equal(calls[1].arguments.workspacePath, workspacePath);
  assert.equal("inputs" in calls[1].arguments, false, "zero workflow inputs stay omitted from preparation");

  await page.evaluate((setupData: any) => {
    const frame = document.getElementById("app");
    frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
      structuredContent: { ok: true, data: setupData },
      _meta: { requestId: "e8d5ee8f-7b94-4fb7-95a4-59cfce1c8498" },
    } }, "*");
  }, setup);
  await page.waitForTimeout(100);
  calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_workspace_grant", "loomex_run_prepare"],
    "duplicate setup notifications must not schedule another preparation");

  const setupSession = await page.evaluate(() => (Object.values(window.__loomexPersistenceStore.sessions) as any[])
    .find((session: any) => session.kind === "prepare" && session.entityType === "workflow"));
  assert.match(setupSession.viewSessionId, /^[0-9a-f-]{36}$/i);
  await page.evaluate(({ setupData, setupSession }: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: setupData },
    _meta: { "loomex/viewSession": setupSession } }]; }, { setupData: setup, setupSession });
  await app.getByRole("button", { name: "Edit setup", exact: true }).click();
  await waitForToolCount(page, "loomex_run_setup", 1);
  const setupRead = (await page.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_run_setup").at(-1);
  assert.equal(setupRead.arguments.workflowId, workflowId);
  assert.equal(setupRead.arguments.version, "1");
  assert.match(setupRead.arguments.viewSessionId, /^[0-9a-f-]{36}$/i);
  const workspace = app.getByLabel("Workspace directory *", { exact: true });
  await workspace.waitFor();
  assert.equal(await workspace.inputValue(), "", "the authoritative setup refresh does not invent task context absent from its request");
  await workspace.fill(changedWorkspacePath);
  const changedPrepared = {
    preparationId: "c4a9297c-8127-496f-b1e2-a88b5aeb2fcf", bindingDigest: "2".repeat(64),
    confirmationKey: "f934e4f5-1ad0-4f8d-9e89-58a4df3c6d8e",
    binding: { ...prepared.binding, workspacePath: changedWorkspacePath },
  };
  const changedPresentation = { ...presentation, preparationId: changedPrepared.preparationId, bindingDigest: changedPrepared.bindingDigest };
  const changedGrant = { structuredContent: { ok: true, data: {
    workspace: { path: changedWorkspacePath, organizationId, installationId }, executionPolicy: "host_user/v1",
  } } };
  await page.evaluate(({ changedGrant, changedPrepared, changedPresentation }: any) => { window.__workflowResponses = [
    changedGrant,
    { structuredContent: { ok: true, data: changedPrepared }, _meta: { "loomex/preparationReview": changedPresentation } },
  ]; }, { changedGrant, changedPrepared, changedPresentation });
  await app.getByRole("button", { name: "Review run", exact: true }).click();
  await app.getByRole("button", { name: "Start run", exact: true }).waitFor({ timeout: 2_000 }).catch(async (error: unknown) => {
    const diagnostics = await page.evaluate(() => ({ body: document.getElementById("app")?.contentDocument?.body?.innerText,
      calls: window.__loomexCalls, persistenceCalls: window.__loomexPersistenceCalls }));
    throw new Error(`Known-workspace reseal did not render: ${JSON.stringify(diagnostics)}`, { cause: error });
  });
  calls = await page.evaluate(() => window.__loomexCalls);
  const grantCalls = calls.filter((call: any) => call.name === "loomex_workspace_grant");
  const prepareCalls = calls.filter((call: any) => call.name === "loomex_run_prepare");
  assert.equal(grantCalls.length, 2);
  assert.equal(prepareCalls.length, 2);
  assert.equal(grantCalls[1].arguments.workspacePath, changedWorkspacePath);
  assert.equal(prepareCalls[1].arguments.workspacePath, changedWorkspacePath);
  assert.notEqual(grantCalls[1].arguments.idempotencyKey, grantCalls[0].arguments.idempotencyKey);
  assert.notEqual(prepareCalls[1].arguments.idempotencyKey, prepareCalls[0].arguments.idempotencyKey);
  await app.getByText("changed-task", { exact: true }).waitFor();
  assert.doesNotMatch(await app.locator("body").innerText(), /current-task/);
  assert.equal(calls.filter((call: any) => call.name === "loomex_run_commit").length, 0);

  await page.evaluate((setupData: any) => {
    const frame = document.getElementById("app");
    frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
      structuredContent: { ok: true, data: setupData },
      _meta: { requestId: "f6a70bc4-3c9e-40e5-a9a8-2b1bbf9d8f4c" },
    } }, "*");
  }, setup);
  await app.getByLabel("Workspace directory *", { exact: true }).waitFor();
  assert.equal(await app.getByLabel("Workspace directory *", { exact: true }).inputValue(), "");
  assert.equal(await app.getByRole("button", { name: "Change workspace", exact: true }).count(), 0,
    "a new setup request without task metadata must clear the prior task workspace");

  const manualPath = "/Users/example/manual-task";
  await app.getByLabel("Workspace directory *", { exact: true }).fill(manualPath);
  const manualPrepared = {
    preparationId: "e4f1b67f-0cf3-4ac5-9a72-4dba5c71d6a1", bindingDigest: "4".repeat(64),
    confirmationKey: "c6d7d5f2-1a80-4c82-bd41-28f5c8f5930a",
    binding: { ...prepared.binding, workspacePath: manualPath },
  };
  const manualPresentation = { ...presentation, preparationId: manualPrepared.preparationId, bindingDigest: manualPrepared.bindingDigest };
  const manualGrant = { structuredContent: { ok: true, data: {
    workspace: { path: manualPath, organizationId, installationId }, executionPolicy: "host_user/v1",
  } } };
  await page.evaluate(({ manualGrant, manualPrepared, manualPresentation }: any) => { window.__workflowResponses = [
    manualGrant,
    { structuredContent: { ok: true, data: manualPrepared }, _meta: { "loomex/preparationReview": manualPresentation } },
  ]; }, { manualGrant, manualPrepared, manualPresentation });
  await app.getByRole("button", { name: "Review run", exact: true }).click();
  await app.getByRole("button", { name: "Start run", exact: true }).waitFor();
  const settledManualCalls = await page.evaluate(() => window.__loomexCalls);
  assert.equal(settledManualCalls.filter((call: any) => call.name === "loomex_workspace_grant").length, 3);
  assert.equal(settledManualCalls.filter((call: any) => call.name === "loomex_run_prepare").length, 3);
  const callsBeforeUnidentified = settledManualCalls.length;
  await page.evaluate((setupData: any) => {
    const frame = document.getElementById("app");
    frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
      structuredContent: { ok: true, data: setupData },
    } }, "*");
  }, setup);
  await app.getByLabel("Workspace directory *", { exact: true }).waitFor();
  assert.equal(await app.getByLabel("Workspace directory *", { exact: true }).inputValue(), "",
    "an unidentified context-free setup must reset a settled manual review");
  assert.equal((await page.evaluate(() => window.__loomexCalls)).length, callsBeforeUnidentified,
    "resetting a settled review must not replay grant or preparation");
});

test("ambiguous automatic workspace grant waits for the exact retry before preparing", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium required for ambiguous workspace grant recovery");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const workflowId = "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e";
  const organizationId = "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2";
  const versionId = "8b29c880-1c68-4d47-a1ff-477ab28d3c49";
  const installationId = "62e9d3fa-097b-46fb-9f87-34b4d8c1b40b";
  const workspacePath = "/Users/example/ambiguous-task";
  const taskContext = { cwd: workspacePath };
  const setup = {
    workflow: { id: workflowId, organizationId, name: "Ambiguous grant workflow" },
    inputSchema: { type: "object", properties: {}, required: [] },
    selectedVersion: { id: versionId, workflowId, versionNumber: 1, definition: {
      executionPolicy: "host_user/v1", settings: { inputSchema: { type: "object", properties: {}, required: [] } }, nodes: [],
    } },
  };
  const ambiguous = { isError: true, structuredContent: { ok: false, error: { code: "NETWORK_AMBIGUOUS", message: "Workspace grant outcome is uncertain" } } };
  const prepared = {
    preparationId: "04e386f9-d91e-4cf0-88b3-99da4ac1e37d", bindingDigest: "3".repeat(64),
    confirmationKey: "101b9f38-56be-4fbe-8e56-d75f61ab3d08",
    binding: { workflowId, versionId, organizationId, installationId, workspacePath, executionPolicy: "host_user/v1", inputs: {}, providerConfiguration: {} },
  };
  const presentation = {
    schemaVersion: "loomex/preparation-review/v1", preparationId: prepared.preparationId,
    bindingDigest: prepared.bindingDigest, workflowId, versionId, organizationId,
    workflowName: "Ambiguous grant workflow", workflowVersion: 1, organizationName: "Loomex Studio", providers: [],
  };
  const grant = { structuredContent: { ok: true, data: {
    workspace: { path: workspacePath, organizationId, installationId }, executionPolicy: "host_user/v1",
  } } };
  const preparation = { structuredContent: { ok: true, data: prepared }, _meta: { "loomex/preparationReview": presentation } };
  const app = await mountApp(page, "prepare", setup, false, false, null, false,
    { "loomex/taskWorkspace": { taskContext } }, undefined, [ambiguous]);
  await app.getByRole("button", { name: "Retry exact workspace check", exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.__loomexCalls)).length, 1);
  assert.equal((await page.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_run_prepare").length, 0,
    "an uncertain grant must not auto-prepare or auto-retry");
  const firstGrant = (await page.evaluate(() => window.__loomexCalls))[0];
  const changedSetup = {
    ...setup,
    workflow: { ...setup.workflow, id: "b4c1f799-9af1-4fa0-83bf-8dce0bb89c1e", name: "Changed workflow" },
    selectedVersion: { ...setup.selectedVersion, id: "d3f59e24-f22d-4b0d-8a91-a4d78d08a51d", workflowId: "b4c1f799-9af1-4fa0-83bf-8dce0bb89c1e" },
  };
  await page.evaluate((changedSetup: any) => {
    const frame = document.getElementById("app");
    frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
      structuredContent: { ok: true, data: changedSetup },
      _meta: { requestId: "a73758d2-54e8-4c83-93f5-0efbf4f2f31f", "loomex/taskWorkspace": { taskContext: { cwd: "/Users/example/other-task" } } },
    } }, "*");
  }, changedSetup);
  await page.waitForTimeout(100);
  const retainedCalls = await page.evaluate(() => window.__loomexCalls);
  assert.equal(retainedCalls.length, 1, "a changed setup notification must not add grant or preparation calls during an exact retry");
  assert.deepEqual(retainedCalls[0].arguments, firstGrant.arguments, "the retained grant keeps the original workflow workspace scope");
  await page.evaluate(({ grant, preparation }: any) => { window.__workflowResponses = [grant, preparation]; }, { grant, preparation });
  await app.getByRole("button", { name: "Retry exact workspace check", exact: true }).click();
  await app.getByRole("button", { name: "Start run", exact: true }).waitFor();
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_workspace_grant", "loomex_workspace_grant", "loomex_run_prepare"]);
  assert.deepEqual(calls[1].arguments, firstGrant.arguments, "grant retry must preserve every argument and its idempotency key");
  assert.equal(calls.filter((call: any) => call.name === "loomex_run_commit").length, 0);
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
  await app.getByRole("heading", { name: "Run setup", exact: true }).waitFor();
  await captureRequestedScreenshots(page, "run-setup");
  assert.equal(await app.getByLabel("Project directory", { exact: true }).count(), 0, "workspaceInputField must use the single workspace control");
  assert.equal(await app.getByRole("button", { name: "Change workspace", exact: true }).count(), 0, "missing task context keeps manual workspace entry available");

  await app.getByRole("button", { name: "Review run", exact: true }).click();
  await app.getByText("Complete the required inputs before continuing.", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), []);
  await app.getByLabel("Report title *", { exact: true }).fill("Q4 report");
  await app.getByLabel("Retry count *", { exact: true }).fill("1.5");
  await app.getByLabel("Project directory *", { exact: true }).fill("relative/project");
  await app.getByRole("button", { name: "Review run", exact: true }).click();
  await app.getByText("Enter a whole number.", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), []);

  await app.getByLabel("Retry count *", { exact: true }).fill("2");
  await app.getByLabel("Project directory *", { exact: true }).fill("/Users/example/../example/project");
  await page.evaluate(() => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    workspace: { path: "/Users/example/project", organizationId: "5c20340c-1123-41c7-ac58-37f5877dc9e6", installationId: "62e9d3fa-097b-46fb-9f87-34b4d8c1b40b" },
    executionPolicy: "host_user/v1",
  } } }]; });
  await app.getByRole("button", { name: "Review run", exact: true }).click();
  await waitForCallCount(page, 1);
  await app.getByText("The selected project folder could not be verified. Check the folder or try again.", { exact: false }).waitFor();
  await app.locator("#primary:not(:disabled)").waitFor();
  assert.equal(await app.getByLabel("Project directory *", { exact: true }).isDisabled(), true);
  const rejectedGrant = (await page.evaluate(() => window.__loomexCalls))[0];
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
  await page.evaluate(({ prepared, presentation, substitutedPreparation }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: {
      workspace: { path: "/Users/example/project", organizationId: "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2", installationId: "62e9d3fa-097b-46fb-9f87-34b4d8c1b40b" },
      executionPolicy: "host_user/v1",
    } } },
    { structuredContent: { ok: true, data: substitutedPreparation }, _meta: { "loomex/preparationReview": presentation } },
  ]; }, { prepared, presentation, substitutedPreparation });
  // Deliver the retry asynchronously so the assertion observes the rendered response,
  // rather than relying on a fast host returning before click() settles.
  await page.evaluate(() => { window.__workflowDelayMs = 175; });
  await app.getByRole("button", { name: "Retry exact workspace check", exact: true }).click();
  await available.tools.expect(app.getByLabel("Project directory *", { exact: true })).toHaveValue("/Users/example/project");
  await page.evaluate(() => { window.__workflowDelayMs = 0; });
  const grant = (await page.evaluate(() => window.__loomexCalls))[1];
  assert.equal(grant.name, "loomex_workspace_grant");
  assert.equal(grant.arguments.workspacePath, "/Users/example/../example/project");
  assert.equal(grant.arguments.organizationId, organizationId);
  assert.match(grant.arguments.idempotencyKey, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(grant.arguments, rejectedGrant.arguments, "an unverifiable grant retry must remain exact");

  await waitForCallCount(page, 3);
  await app.getByText("The exact preparation review did not match the sealed setup.", { exact: false }).waitFor();
  await app.locator("#primary:not(:disabled)").waitFor();
  const rejectedPrepare = (await page.evaluate(() => window.__loomexCalls)).at(-1);
  await page.evaluate(({ prepared, presentation }: any) => { window.__workflowResponses = [{
    structuredContent: { ok: true, data: prepared }, _meta: { "loomex/preparationReview": presentation },
  }]; }, { prepared, presentation });
  await app.locator("#primary:not(:disabled)").waitFor();
  await app.getByRole("button", { name: "Retry exact review", exact: true }).click();
  await app.getByRole("button", { name: "Start run", exact: true }).waitFor();
  await captureRequestedScreenshots(page, "run-review");
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
  } } }, { structuredContent: { ok: true, data: {
    execution: { id: "1c5f36e6-ac6f-41a3-b593-edf31e691e37", name: "Integrated report", status: "running", currentNodeName: "Draft report" }, latestSequence: 1,
  } } }]; });
  await page.evaluate(() => { window.__failNextModelContext = true; });
  await app.getByRole("button", { name: "Retry exact start", exact: true }).evaluate((button: any) => { button.click(); button.click(); });
  await app.getByRole("button", { name: "Retry chat handoff", exact: true }).waitFor({ timeout: 2_000 }).catch(async (error: unknown) => {
    const diagnostics = await page.evaluate(() => ({ body: document.getElementById("app")?.contentDocument?.body?.innerText,
      calls: window.__loomexCalls, messages: window.__loomexMessages, contexts: window.__loomexModelContexts,
      persistenceCalls: window.__loomexPersistenceCalls }));
    throw new Error(`Integrated post-commit handoff did not become retryable: ${JSON.stringify(diagnostics)}`, { cause: error });
  });
  await app.getByText("Draft report", { exact: true }).waitFor();
  const calls = await page.evaluate(() => window.__loomexCalls);
  const retried = calls.filter((call: any) => call.name === "loomex_run_commit").at(-1);
  assert.equal(calls.filter((call: any) => call.name === "loomex_run_commit").length, 3, "double click must add one commit call");
  assert.deepEqual(retried.arguments, ambiguous.arguments, "ambiguous retry must preserve every sealed field and the same idempotency key");
  const contexts = await page.evaluate(() => window.__loomexModelContexts);
  assert.equal(contexts.length, 1, "a failed context request is attempted once and must not turn a successful commit into a retry");
  assert.equal(await app.getByRole("button", { name: "Continue in conversation", exact: true }).count(), 0);
  assert.equal((await page.evaluate(() => window.__loomexMessages)).length, 0, "message waits for an acknowledged context update");
});

test("a malformed commit run identity is never cached or read and the exact retry can recover", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for malformed commit identity recovery");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const runId = "983cc5ac-f980-4213-9c8a-96c4938a56e1";
  const preparationId = "b7ffcc69-88ec-4291-a8f0-b3de716601ac";
  const prepared = {
    preparationId, bindingDigest: "9".repeat(64), confirmationKey: "1801672c-0d71-427b-96cc-a8eb11eae5c6",
    binding: { workflowId: "043122a0-1781-4f53-8181-6e3fa09b67f7", versionId: "7f63cc89-1366-47bc-8514-073e9fe08d33",
      organizationId: "6942723d-109f-493e-8361-6b907d7961a7", installationId: "70a63731-8003-470e-b5f2-1de0d1cb691a",
      workspacePath: "/Users/example/exact", inputs: {}, executionPolicy: "host_user/v1", providerConfiguration: {} },
  };
  const presentation = { schemaVersion: "loomex/preparation-review/v1", preparationId, bindingDigest: prepared.bindingDigest,
    workflowId: prepared.binding.workflowId, versionId: prepared.binding.versionId, organizationId: prepared.binding.organizationId,
    workflowName: "Identity recovery", workflowVersion: 1, organizationName: "Loomex Studio", providers: [] };
  const app = await mountApp(page, "prepare", prepared, false, false, presentation);
  await page.evaluate(({ preparationId }: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution: { id: "malformed-run-id", status: "running", workflowName: "Identity recovery" },
    executionPolicy: "host_user/v1", preparationId,
  } } }]; }, { preparationId });
  await waitForEnabledPrimary(page, "Start run");
  await app.getByRole("button", { name: "Start run", exact: true }).click();
  await app.getByRole("button", { name: "Retry exact start", exact: true }).waitFor();
  await waitForToolCount(page, "loomex_run_commit", 1);
  const malformedCalls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(malformedCalls.map((call: any) => call.name), ["loomex_run_commit"],
    "a malformed run identity never reaches an authoritative run read");
  const original = (await page.evaluate(() => window.__loomexCalls))[0];

  await page.evaluate(({ runId, preparationId }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: {
      execution: { id: runId, status: "running", workflowName: "Identity recovery" }, executionPolicy: "host_user/v1", preparationId,
    } } },
    { structuredContent: { ok: true, data: {
      execution: { id: runId, status: "running", workflowName: "Identity recovery" }, latestSequence: 1,
    } } },
  ]; }, { runId, preparationId });
  await app.getByRole("button", { name: "Retry exact start", exact: true }).click();
  await app.getByText("Sent to chat", { exact: true }).first().waitFor();
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_run_commit", "loomex_run_commit", "loomex_run_get"]);
  assert.deepEqual(calls[1].arguments, original.arguments, "the valid retry preserves the complete sealed commit request");
  assert.deepEqual(calls[2].arguments, { runId });
});

test("an uppercase preparation digest is rejected before caching and the exact retry accepts lowercase", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for digest validation recovery");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const workflowId = "d8bfd043-b0c1-4057-a6a2-198705588546";
  const versionId = "c2f03e07-295d-4328-a779-926e00f29f73";
  const organizationId = "8aa1b3e3-4c5c-4d9a-babb-86473a12ca27";
  const installationId = "be694c8e-e13c-4243-a174-c1cf5be4bfcd";
  const preparationId = "b3c905a9-bd50-4305-a353-02e14f5f7a8e";
  const workspacePath = "/Users/example/digest";
  const setup = {
    workflow: { id: workflowId, organizationId, name: "Digest recovery" },
    inputSchema: { type: "object", properties: {}, required: [] },
    selectedVersion: { id: versionId, workflowId, versionNumber: 1,
      definition: { executionPolicy: "host_user/v1", settings: { inputSchema: { type: "object", properties: {}, required: [] } }, nodes: [] } },
  };
  const validPrepared = {
    preparationId, bindingDigest: "a".repeat(64), confirmationKey: "01dbdf10-2f14-4fbd-8c64-2d5c50505878",
    binding: { workflowId, versionId, organizationId, installationId, workspacePath,
      executionPolicy: "host_user/v1", inputs: {}, providerConfiguration: {} },
  };
  const uppercasePrepared = { ...validPrepared, bindingDigest: "A".repeat(64) };
  const presentation = { schemaVersion: "loomex/preparation-review/v1", preparationId,
    bindingDigest: uppercasePrepared.bindingDigest, workflowId, versionId, organizationId,
    workflowName: "Digest recovery", workflowVersion: 1, organizationName: "Loomex Studio", providers: [] };
  const grant = { structuredContent: { ok: true, data: {
    workspace: { path: workspacePath, organizationId, installationId }, executionPolicy: "host_user/v1",
  } } };
  const app = await mountApp(page, "prepare", setup);
  await app.getByLabel("Workspace directory *", { exact: true }).fill(workspacePath);
  await page.evaluate(({ grant, uppercasePrepared, presentation }: any) => { window.__workflowResponses = [grant, {
    structuredContent: { ok: true, data: uppercasePrepared }, _meta: { "loomex/preparationReview": presentation },
  }]; }, { grant, uppercasePrepared, presentation });
  await app.getByRole("button", { name: "Review run", exact: true }).click();
  await app.getByRole("button", { name: "Retry exact review", exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Start run" }).count(), 0);
  const firstPrepare = (await page.evaluate(() => window.__loomexCalls)).find((call: any) => call.name === "loomex_run_prepare");
  assert.ok(firstPrepare);

  const validPresentation = { ...presentation, bindingDigest: validPrepared.bindingDigest };
  await page.evaluate(({ validPrepared, validPresentation }: any) => { window.__workflowResponses = [{
    structuredContent: { ok: true, data: validPrepared }, _meta: { "loomex/preparationReview": validPresentation },
  }]; }, { validPrepared, validPresentation });
  await app.getByRole("button", { name: "Retry exact review", exact: true }).click();
  await app.getByRole("button", { name: "Start run", exact: true }).waitFor();
  const prepares = (await page.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_run_prepare");
  assert.equal(prepares.length, 2);
  assert.deepEqual(prepares[1].arguments, firstPrepare.arguments, "the lowercase retry keeps the exact preparation request and idempotency key");
});

test("an immediate terminal post-commit snapshot hands off once and explicit refresh reveals the terminal result", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for terminal post-commit routing");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const runId = "f5ec84d7-694f-4d9f-a789-08c62e49b17e";
  const preparationId = "a582028f-5886-484b-93d3-ed0a1c017d0c";
  const prepared = {
    preparationId, bindingDigest: "7".repeat(64), confirmationKey: "3f2fd292-78ec-4f3f-ad75-9f42d183dcab",
    binding: { workflowId: "63ed7a23-9ec9-4548-8570-45ff9ca9d834", versionId: "1b18b6e5-cb77-426a-bdc9-aaf0dc7ef63c",
      organizationId: "c60ff47b-1f2d-4268-8f12-ae0b8c6f9369", installationId: "441580d8-c9e8-43de-8a1d-ed40bc718fd2",
      workspacePath: "/Users/example/terminal", inputs: {}, executionPolicy: "host_user/v1", providerConfiguration: {} },
  };
  const presentation = { schemaVersion: "loomex/preparation-review/v1", preparationId, bindingDigest: prepared.bindingDigest,
    workflowId: prepared.binding.workflowId, versionId: prepared.binding.versionId, organizationId: prepared.binding.organizationId,
    workflowName: "Immediate result", workflowVersion: 1, organizationName: "Loomex Studio", providers: [] };
  const terminal = { execution: { id: runId, status: "completed", workflowName: "Immediate result", result: {
    version: 1, summary: "The immediate result is ready.", verification: ["Terminal snapshot verified."],
  } }, latestSequence: 2 };
  const app = await mountApp(page, "prepare", prepared, false, false, presentation);
  await page.evaluate(({ runId, preparationId, terminal }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: {
      execution: { id: runId, status: "running", workflowName: "Immediate result" }, executionPolicy: "host_user/v1", preparationId,
    } } },
    { structuredContent: { ok: true, data: terminal } },
  ]; }, { runId, preparationId, terminal });
  await app.getByRole("button", { name: "Start run", exact: true }).click();
  await app.getByText("Sent to chat", { exact: true }).first().waitFor();
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls)).map((call: any) => call.name), ["loomex_run_commit", "loomex_run_get"]);
  await app.getByRole("button", { name: "Refresh run", exact: true }).click();
  await app.getByText("The immediate result is ready.", { exact: true }).waitFor();
  await app.getByText("Terminal snapshot verified.", { exact: true }).waitFor();
  assert.equal(await app.getByText("Sent to chat", { exact: true }).count(), 0, "refresh clears the completed handoff callout");
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls)).map((call: any) => call.name), ["loomex_run_commit", "loomex_run_get"],
    "the verified terminal snapshot does not require another run read");
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
  } } }, { structuredContent: { ok: true, data: {
    execution: { id: runId, name: "Exact result run", status: "running", currentNodeName: "Original run" }, latestSequence: 1,
  } } }]; }, { runId, preparationId });
  await app.getByRole("button", { name: "Retry exact start", exact: true }).click();
  await app.getByText("Sent to chat", { exact: true }).first().waitFor();
  await page.evaluate((runId: string) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution: { id: runId, name: "Exact result run", status: "running", currentNodeName: "Original run" },
    executionPolicy: "host_user/v1",
  } } }]; }, runId);
  await app.getByRole("button", { name: "Refresh run", exact: true }).click();
  await waitForToolCount(page, "loomex_run_get", 1);
  await app.getByText("Original run", { exact: true }).waitFor();
  const acceptedCommit = (await page.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_run_commit")[1];
  assert.deepEqual(acceptedCommit.arguments, rejectedCommit.arguments);

  await app.locator("#cancellation-details > summary").click();
  await app.getByLabel("reason", { exact: true }).fill("Stop this exact run");
  await page.evaluate(() => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution: { id: "24cb0c0a-0fc8-4a18-a0d9-1105d64e1824", name: "Other run", status: "canceled", currentNodeName: "Substituted cancellation" },
    executionPolicy: "host_user/v1",
  } } }]; });
  await app.getByRole("button", { name: "Cancel run", exact: true }).click();
  await waitForToolCount(page, "loomex_run_cancel", 1);
  await app.getByText("The runner did not return status for the requested run.", { exact: false }).waitFor();
  await app.locator("#primary:not(:disabled)").waitFor();
  assert.equal(await app.getByText("Substituted cancellation", { exact: true }).count(), 0);
  await app.getByText("Original run", { exact: true }).waitFor();
  const rejectedCancel = (await page.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_run_cancel")[0];
  assert.equal(await app.getByLabel("reason", { exact: true }).inputValue(), "Stop this exact run");
  assert.equal(await app.getByLabel("reason", { exact: true }).isDisabled(), true);

  await page.evaluate((runId: string) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    execution: { id: runId, name: "Exact result run", status: "canceled", currentNodeName: "Original run" },
    executionPolicy: "host_user/v1",
  } } }]; }, runId);
  await app.getByRole("button", { name: "Retry exact cancellation", exact: true }).click();
  await waitForToolCount(page, "loomex_run_cancel", 2);
  await app.getByText("Canceled. Review the result below.", { exact: true }).waitFor();
  const acceptedCancel = (await page.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_run_cancel")[1];
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
  assert.match(messages[0].content[0].text, /do not commit, execute, or infer authority/);

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
  } } }, { structuredContent: { ok: true, data: {
    execution: { id: "1c5f36e6-ac6f-41a3-b593-edf31e691e37", name: "Timeout run", status: "running" }, latestSequence: 1,
  } } }]; });
  await app.getByRole("button", { name: "Retry exact start", exact: true }).click();
  await waitForToolCount(page, "loomex_run_commit", 2);
  await page.clock.fastForward(1);
  await app.getByText("Sent to chat", { exact: true }).first().waitFor();
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls[1].arguments, first.arguments);
  const verification = calls.find((call: any) => call.name === "loomex_run_get");
  assert.deepEqual(verification?.arguments, { runId: "1c5f36e6-ac6f-41a3-b593-edf31e691e37" });
});

test("all five views share design tokens, responsive components, focus states and host sizing", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium required for the shared design system gate");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const humanRequest = {
    id: "59cc5195-f817-474c-867d-d3da713013a2", type: "input", title: "Tell us about your idea",
    schemaDigest: "a".repeat(64),
    prompt: "A little context will help us ask the right questions.",
    inputSpec: { inputType: "text", question: "What would you like to build?", collectionMode: "single" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  };
  const prepared = {
    preparationId: "fbf35837-c360-4574-b9d4-8e17201f2dd1", bindingDigest: "b".repeat(64), confirmationKey: "41570b57-ac7b-40bc-869d-d17de5b09d76",
    binding: { workflowId: "06fb0e95-e404-449d-8674-b01fce64524f", versionId: "e32d00aa-bd52-4cfa-83cf-3b1b1c6a9d30", organizationId: "450722b9-c8a7-4548-bada-308b576b081a", installationId: "4e47b3cd-50b1-469b-96cb-71c7f7f70c38",
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
        ? { execution: { id: "e4189386-d5b6-4faf-9afa-23736b5fe35c", name: "Idea to Implementation", status: "waiting for your response" } }
        : { humanRequest, ...(mode === "authoring" ? { builderSession: { id: "e7926803-3860-41fe-8948-245b6be4fa9b" } } : {}) };
      const app = await mountApp(page, mode, data, false, false, mode === "prepare" ? presentation : null);
      await waitForPersistenceToolCount(page, "loomex_view_session_get", 1);
      const expectedHeading = mode === "browser" ? "Browse workflows" : mode === "prepare" ? "Idea to Implementation" : mode === "monitor" ? "Idea to Implementation" : "What would you like to build?";
      await app.getByRole("heading", { name: expectedHeading, exact: true }).waitFor();
      assert.equal(await app.locator(".app-header, .app-body, .app-footer").count(), 3);
      assert.equal(await app.locator(".app-header h1").textContent(), mode === "browser" ? "Browse workflows" : mode === "prepare" ? "Review run" : mode === "monitor" ? "Run monitor" : mode === "authoring" ? "Authoring review" : "Your response");
      assert.equal(await app.locator(".app-header #connection").textContent(), "Connected");
      assert.equal(await app.locator(".app-mark, #view-label").count(), 0);
      if (mode === "authoring" || mode === "interaction") await app.locator('fieldset input[type="text"]').waitFor();
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
      assert.equal(await app.locator("body").evaluate((body: any) => body.ownerDocument.defaultView.getComputedStyle(body).backgroundColor), "rgb(10, 10, 10)", "the embedded view uses the actual frontend dark canvas in either host theme");
      assert.match(styles.font, /Inter/);
      assert.equal(styles.buttonRadius, "8px", "controls retain the frontend component radius");
      const card = app.locator(".glass-panel").first();
      if (await card.count()) assert.equal(await card.evaluate((node: any) => node.ownerDocument.defaultView.getComputedStyle(node).borderRadius), "12px");
      const primaryButton = app.locator("button.btn-primary:visible").first();
      if (await primaryButton.count()) {
        const primaryStyle = await primaryButton.evaluate((node: any) => {
          const style = node.ownerDocument.defaultView.getComputedStyle(node);
          return { background: style.backgroundColor, color: style.color };
        });
        assert.deepEqual(primaryStyle, { background: "rgb(255, 255, 255)", color: "rgb(0, 0, 0)" }, "primary actions use the frontend white/black treatment");
      }
      if (baseline === undefined) baseline = styles;
      else assert.deepEqual(styles, baseline, `${mode} must use the same shared shell and controls`);
      assert.equal(await app.locator("body").evaluate((body: any) => body.scrollWidth <= body.clientWidth), true);
      const visibleAction = (await app.locator("#primary").isVisible()) ? app.locator("#primary") : app.locator("#refresh");
      assert.equal(await visibleAction.evaluate((button: any) => button.getBoundingClientRect().height >= 36), true);
      assert.equal(await app.locator("#diagnostics, #state, #json-answer").count(), 0);
      if (directory) await app.locator("main").screenshot({ path: resolve(directory, `${mode}-${width < 520 ? "mobile" : theme}.png`) });
      const focusTarget = (await app.locator("fieldset input, fieldset textarea, fieldset select").count())
        ? app.locator("fieldset input, fieldset textarea, fieldset select").first() : visibleAction;
      await focusTarget.focus();
      const focus = await focusTarget.evaluate((target: any) => target.ownerDocument.defaultView.getComputedStyle(target).outlineStyle);
      assert.equal(focus, "solid");
      await page.evaluate(() => document.getElementById("app").contentWindow.postMessage({
        jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { isError: true, structuredContent: { ok: false, error: { code: "TEST_ERROR" } } },
      }, "*"));
      await app.locator('#summary.error[role="alert"]').waitFor();
      await app.getByRole("heading", { name: expectedHeading, exact: true }).waitFor();
      await waitForSettledAppSize(page); // Identical geometry does not require another resize notification.
      if (directory && width === 760 && theme === "light") await app.locator("main").screenshot({ path: resolve(directory, `${mode}-error.png`) });
    }
  }
  const template = await readFile("assets/loomex-app.html", "utf8");
  const css = [...template.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]).join("\n");
  assert.doesNotMatch(css, /data-mode|prepare-/);
  assert.doesNotMatch(css, /--green-|--red-|CanvasText|prefers-color-scheme/);
  assert.match(css, /--loomex-control-height/);
});

test("workflow browser searches, pages, reviews and hands off preparation without execution", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for workflow browsing");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  page.setDefaultTimeout(5_000);
  const id = "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e";
  const taskContext = { cwd: "/Users/example/current-task" };
  const first = { workflows: [{ id, name: "Idea <script>bad()</script>", description: "Develop an idea", definitionStatus: "published", latestVersion: 4, nodeCount: 11 }], nextCursor: "cursor-2" };
  const app = await mountApp(page, "browser", first, false, false, null, false, { "loomex/taskWorkspace": { taskContext } });
  await app.getByRole("heading", { name: "Browse workflows", exact: true }).waitFor();
  await captureRequestedScreenshots(page, "workflow-list");
  assert.match(await app.locator("body").innerText(), /Published/i);
  assert.match(await app.locator("body").innerText(), /v4/);
  assert.match(await app.locator("body").innerText(), /11 steps/);
  assert.equal(await app.locator("body").evaluate((body: any) => body.scrollWidth <= body.clientWidth), true);
  assert.equal(await app.locator("script").count(), 2, "the UI and durable persistence controller are the only scripts");
  assert.equal(await app.getByRole("button", { name: "Connection information", exact: true }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Clear search", exact: true }).count(), 0);
  await waitForSettledAppSize(page);
  await page.evaluate(() => { window.__workflowDelayMs = 1_000; });
  const initialBrowserHeight = (await app.locator("#context").boundingBox()).height;
  const scrollBefore = await page.evaluate(() => {
    document.body.style.minHeight = "1400px";
    window.scrollTo(0, 120);
    return window.scrollY;
  });
  await app.getByRole("button", { name: "Next", exact: true }).focus();
  const pageLayoutBefore = await appLayoutSnapshot(page);
  await app.getByRole("button", { name: "Next", exact: true }).click();
  await app.locator(".workflow-skeleton").waitFor();
  const pageLayoutDuring = await appLayoutSnapshot(page);
  assert.equal(await app.locator("#context").getAttribute("aria-busy"), "true");
  assert.ok((await app.locator("#context").boundingBox()).height >= initialBrowserHeight, "the skeleton reserves the current page height");
  assert.equal(await app.locator(".workflow-skeleton").getAttribute("aria-hidden"), "true");
  assert.equal(await app.locator("#activity").isVisible(), false, "the global activity row does not grow the app above an in-place skeleton");
  assert.equal(await app.locator(".workflow-loading-status").textContent(), "Loading workflows…");
  assertStableLoadingLayout(pageLayoutBefore, pageLayoutDuring, "Loading workflows…");
  assert.equal(await page.evaluate(() => window.scrollY), scrollBefore);
  await waitForCallCount(page, 1);
  await app.getByText("Page 2 · 1 workflow", { exact: true }).waitFor();
  assert.equal(await app.locator("#context").getAttribute("aria-busy"), "false");
  assert.equal(await app.locator(":focus").getAttribute("aria-label"), "Next", "focus returns to the same page control after replacement");
  assert.equal((await appLayoutSnapshot(page)).focusVisible, true, "restored page focus is visible");
  assert.equal(await page.evaluate(() => window.scrollY), scrollBefore, "page replacement preserves the viewport");
  await captureRequestedScreenshots(page, "workflow-list-page-2");
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls))[0], { name: "loomex_workflows_list", arguments: { limit: 20, cursor: "cursor-2" } });
  await page.evaluate(() => { window.__workflowDelayMs = 0; });
  await app.getByRole("button", { name: "Previous", exact: true }).click();
  await waitForCallCount(page, 2);
  await app.getByText("Page 1 · 1 workflow", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.__workflowDelayMs = 250;
    window.__workflowResponses = [{ structuredContent: { ok: true, data: { workflows: [], nextCursor: null } } }];
  });
  await app.getByLabel("Search workflows", { exact: true }).fill("missing");
  await app.getByRole("button", { name: "Search", exact: true }).focus();
  const searchLayoutBefore = await appLayoutSnapshot(page);
  await app.getByRole("button", { name: "Search", exact: true }).click();
  await app.locator(".workflow-skeleton").waitFor();
  const searchLayoutDuring = await appLayoutSnapshot(page);
  assertStableLoadingLayout(searchLayoutBefore, searchLayoutDuring, "Loading workflows…");
  assert.equal(await app.locator("#activity").isVisible(), false);
  await app.getByText("No workflows match this search.").waitFor();
  await app.getByText("Page 1 · 0 workflows", { exact: true }).waitFor();
  assert.equal((await appLayoutSnapshot(page)).focus, "Search", "search focus returns after replacement");
  assert.equal((await appLayoutSnapshot(page)).focusVisible, true, "restored search focus is visible");
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls)).at(-1).arguments, { limit: 20, query: "missing" });
  await page.evaluate(() => {
    window.__workflowResponses = [{ structuredContent: { ok: true, data: { workflows: [], nextCursor: null } } }];
  });
  await app.getByRole("button", { name: "Refresh", exact: true }).focus();
  const refreshLayoutBefore = await appLayoutSnapshot(page);
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await app.locator(".workflow-skeleton").waitFor();
  const refreshLayoutDuring = await appLayoutSnapshot(page);
  assertStableLoadingLayout(refreshLayoutBefore, refreshLayoutDuring, "Loading workflows…");
  await waitForCallCount(page, 4);
  await app.getByText("No workflows match this search.").waitFor();
  assert.equal((await appLayoutSnapshot(page)).focus, "Refresh", "refresh focus returns after replacement");
  assert.equal((await appLayoutSnapshot(page)).focusVisible, true, "restored refresh focus is visible");
  assert.equal((await appLayoutSnapshot(page)).scrollY, refreshLayoutBefore.scrollY, "same-content refresh preserves the viewport after replacement");
  await page.evaluate(() => { window.__workflowDelayMs = 0; });
  await app.getByRole("button", { name: "Reset search", exact: true }).click();
  await app.getByRole("button", { name: /^View:/ }).waitFor();
  const runSetup = {
    workflow: { id, organizationId: "67a6e174-b7ae-4f9a-9a68-f0eed80f95f2", name: "Idea", status: "active" },
    activeVersion: { versionNumber: 4, definition: { executionPolicy: "obsolete-policy", settings: { inputSchema: { properties: { obsolete: { type: "number" } } } }, nodes: [{ name: "Obsolete active step", type: "tool" }] } },
    selectedVersion: { id: "8b29c880-1c68-4d47-a1ff-477ab28d3c49", workflowId: id, versionNumber: 5, definition: {
      executionPolicy: "host_user/v1",
      settings: { inputSchema: { type: "object", properties: { directoryPath: { type: "string", title: "Project directory" } }, required: ["directoryPath"] }, workspaceInputField: "directoryPath" },
      nodes: [
        { key: "start", name: "Collect brief", type: "start", inputSchema: { properties: { ignoredFallback: { type: "boolean" } } } },
        { key: "implement", name: "Implement", type: "ai_agent", config: { provider: "codex", model: "gpt-5.6-luna", reasoningEffort: "medium" } },
        { key: "review", name: "Review", type: "ai_agent", config: { provider: "codex", model: "gpt-5.6-luna", reasoningEffort: "medium" } },
      ],
    } },
    inputSchema: { properties: { directoryPath: { type: "string", title: "Project directory" } }, required: ["directoryPath"] },
    nodes: [{ key: "7f57e77b-a37e-4eef-9788-e6bc37447bb2", name: "Stale descriptor", type: "tool" }],
  };
  const browserDetailSession = viewSession("9fb7b24a-c3dd-43dd-a639-c9424d6769f6", "browser", "catalog",
    "00000000-0000-0000-0000-000000000000", {});
  const runSetupSession = viewSession("2142cebd-12b5-46b9-b292-22db90584ef6", "prepare", "workflow", id, {
    schemaVersion: 1, screen: "setup", disclosures: {}, workflowId: id,
    versionId: runSetup.selectedVersion.id, controls: {}, workspaceEditing: false,
  });
  const runPrepared = {
    preparationId: "2b0af5ba-1096-42e2-9045-97e18bbf3a9b", bindingDigest: "d".repeat(64),
    confirmationKey: "f4fe0605-2ac3-4960-a264-ec3a56589a27",
    binding: { workflowId: id, versionId: runSetup.selectedVersion.id, organizationId: runSetup.workflow.organizationId,
      installationId: "62e9d3fa-097b-46fb-9f87-34b4d8c1b40b", workspacePath: taskContext.cwd, executionPolicy: "host_user/v1",
      inputs: { directoryPath: taskContext.cwd }, providerConfiguration: {} },
  };
  const runPresentation = {
    schemaVersion: "loomex/preparation-review/v1", preparationId: runPrepared.preparationId,
    bindingDigest: runPrepared.bindingDigest, workflowId: id, versionId: runSetup.selectedVersion.id,
    organizationId: runSetup.workflow.organizationId, workflowName: "Idea", workflowVersion: 5,
    organizationName: "Loomex Studio", providers: [],
  };
  const workspaceGrant = { structuredContent: { ok: true, data: {
    workspace: { path: taskContext.cwd, organizationId: runSetup.workflow.organizationId, installationId: runPrepared.binding.installationId },
    executionPolicy: "host_user/v1",
  } } };
  await page.evaluate(({ runSetup, browserDetailSession, workspaceGrant, runPrepared, runPresentation }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: runSetup }, _meta: { "loomex/taskWorkspace": { taskContext: { cwd: "/Users/example/current-task" } }, "loomex/viewSession": browserDetailSession } }, workspaceGrant,
    { structuredContent: { ok: true, data: runPrepared }, _meta: { "loomex/preparationReview": runPresentation } },
  ]; }, { runSetup, browserDetailSession, workspaceGrant, runPrepared, runPresentation });
  await app.getByRole("button", { name: /^View:/ }).click();
  await app.getByRole("heading", { name: "Idea", exact: true }).waitFor();
  await app.getByText("Version 5", { exact: false }).waitFor();
  await app.getByText("Project directory", { exact: true }).waitFor();
  await app.getByText("Required", { exact: true }).waitFor();
  await app.getByText("gpt-5.6-luna · medium effort", { exact: true }).waitFor();
  await app.getByText("Runs on this Mac with your user permissions after review.", { exact: true }).waitFor();
  const detailText = await app.locator("body").innerText();
  assert.doesNotMatch(detailText, /obsolete|staleProjection|ignoredFallback|7f57e77b|Obsolete active step|Stale descriptor/);
  const steps = app.locator('section[aria-label="Steps"]');
  assert.equal(await steps.locator("li").count(), 3);
  await app.getByText("Implement", { exact: true }).waitFor();
  await captureRequestedScreenshots(page, "workflow-detail-browser");
  await page.evaluate(({ runSetup, runSetupSession, workspaceGrant, runPrepared, runPresentation }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: runSetup }, _meta: { "loomex/taskWorkspace": { taskContext: { cwd: "/Users/example/current-task" } }, "loomex/viewSession": runSetupSession } },
    workspaceGrant,
    { structuredContent: { ok: true, data: runPrepared }, _meta: { "loomex/preparationReview": runPresentation } },
  ]; }, { runSetup, runSetupSession, workspaceGrant, runPrepared, runPresentation });
  await app.getByRole("button", { name: /^Prepare run/ }).click();
  await app.getByRole("heading", { name: "Idea", exact: true }).waitFor();
  await app.getByRole("button", { name: "Start run", exact: true }).waitFor().catch(async (error: unknown) => {
    const diagnostics = await page.evaluate(() => ({ body: document.getElementById("app")?.contentDocument?.body?.innerText,
      calls: window.__loomexCalls, persistenceCalls: window.__loomexPersistenceCalls,
      sessions: window.__loomexPersistenceStore.sessions }));
    throw new Error(`Browser preparation did not reach review: ${JSON.stringify(diagnostics)}`, { cause: error });
  });
  assert.equal(await app.getByRole("button", { name: "Grant workspace access", exact: true }).count(), 0);
  const messages = await page.evaluate(() => window.__loomexMessages);
  assert.equal(messages.length, 0);
  const setupCalls = await page.evaluate(() => window.__loomexCalls);
  assert.equal(setupCalls.at(-3).name, "loomex_run_setup");
  assert.deepEqual(setupCalls.at(-3).arguments, { workflowId: id, version: "5", taskContext });
  assert.deepEqual(setupCalls.slice(-3).map((call: any) => call.name), ["loomex_run_setup", "loomex_workspace_grant", "loomex_run_prepare"]);
  assert.equal(setupCalls.filter((call: any) => call.name === "loomex_run_commit").length, 0);
  const setupReadsBeforeEdit = (await page.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_run_setup").length;
  await page.evaluate(({ runSetupData, runSetupSession, taskContext }: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: runSetupData },
    _meta: { "loomex/taskWorkspace": { taskContext }, "loomex/viewSession": runSetupSession } }]; },
  { runSetupData: runSetup, runSetupSession, taskContext });
  await app.getByRole("button", { name: "Edit setup", exact: true }).click();
  await waitForToolCount(page, "loomex_run_setup", setupReadsBeforeEdit + 1);
  const editSetupRead = (await page.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_run_setup").at(-1);
  assert.equal(editSetupRead.arguments.workflowId, id);
  assert.equal(editSetupRead.arguments.version, "5");
  assert.deepEqual(editSetupRead.arguments.taskContext, taskContext);
  assert.match(editSetupRead.arguments.viewSessionId, /^[0-9a-f-]{36}$/i);
  const browserSessionId = browserDetailSession.viewSessionId;
  assert.match(browserSessionId, /^[0-9a-f-]{36}$/i);
  const browserListReadsBeforeBack = (await page.evaluate(() => window.__loomexCalls))
    .filter((call: any) => call.name === "loomex_workflows_list").length;
  const browserSessionReadsBeforeBack = (await page.evaluate(({ browserSessionId }: any) => window.__loomexPersistenceCalls
    .filter((call: any) => call.name === "loomex_view_session_get" && call.arguments.viewSessionId === browserSessionId).length,
  { browserSessionId }));
  const otherCardArguments = { limit: 10, query: "shared query", cursor: "shared-cursor" };
  await page.evaluate(({ browserSessionId, otherCardArguments }: any) => {
    const session = window.__loomexPersistenceStore.sessions[browserSessionId];
    session.revision += 1;
    session.state = {
      schemaVersion: 1,
      screen: "browser",
      disclosures: {},
      browser: { arguments: otherCardArguments, history: [], searchDraft: "shared query", selectedWorkflowId: null, selectedVersion: null },
    };
    session.updatedAt += 1;
  }, { browserSessionId, otherCardArguments });
  await app.getByRole("button", { name: "Back to workflows", exact: true }).click();
  await waitForToolCount(page, "loomex_workflows_list", browserListReadsBeforeBack + 1);
  await page.waitForFunction(({ browserSessionId, expected }: any) => window.__loomexPersistenceCalls
    .filter((call: any) => call.name === "loomex_view_session_get" && call.arguments.viewSessionId === browserSessionId).length >= expected,
  { browserSessionId, expected: browserSessionReadsBeforeBack + 1 });
  const backToBrowserCall = (await page.evaluate(() => window.__loomexCalls))
    .filter((call: any) => call.name === "loomex_workflows_list").at(-1);
  assert.deepEqual(backToBrowserCall.arguments, otherCardArguments,
    "a stale detail card returns with the newer catalog navigation written by another card");
  assert.deepEqual(await page.evaluate(({ browserSessionId }: any) =>
    window.__loomexPersistenceStore.sessions[browserSessionId].state.browser.arguments, { browserSessionId }), otherCardArguments,
  "returning from the stale card does not overwrite the newer query and page");
  assert.equal((await page.evaluate(() => window.__loomexCalls))
    .some((call: any) => call.name === "loomex_workflows_view"), false,
  "browser return stays on the callable headless list surface");
  await page.evaluate(() => { window.__workflowResponses = [{ isError: true, structuredContent: { ok: false } }]; });
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await app.locator("#summary.error").waitFor();
  assert.equal(await app.getByRole("button", { name: /^Prepare run/ }).isDisabled(), true);
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await app.locator("#summary.error").waitFor({ state: "hidden" });
  assert.equal(await app.getByRole("button", { name: /^Prepare run/ }).isEnabled(), true);
  const directory = process.env.LOOMEX_UI_SCREENSHOT_DIR;
  if (directory) {
    const loadingPage = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const loadingApp = await mountApp(loadingPage, "browser", first);
    await loadingPage.evaluate(() => { window.__workflowDelayMs = 5000; });
    await loadingApp.getByRole("button", { name: "Next", exact: true }).click();
    await loadingApp.locator(".workflow-skeleton").waitFor();
    await captureRequestedScreenshots(loadingPage, "workflow-list-loading");
    await loadingPage.close();
  }
});

test("closing and reopening the workflow browser restores both the exact page and selected detail", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for durable workflow browsing");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const workflowId = "63b5e9c3-7245-4b7e-a849-1692cc7d025f";
  const versionId = "f2020666-4f2f-4b14-a5b6-94faf3e68429";
  const first = { workflows: [{ id: workflowId, name: "Durable workflow", latestVersion: 2, nodeCount: 1 }], nextCursor: "page-2" };
  const second = { workflows: [{ id: workflowId, name: "Durable workflow", latestVersion: 3, nodeCount: 2 }], nextCursor: null };
  const detail = {
    workflow: { id: workflowId, name: "Durable workflow", status: "active" },
    selectedVersion: { id: versionId, workflowId, versionNumber: 3, definition: { executionPolicy: "host_user/v1", settings: { inputSchema: { type: "object", properties: {} } }, nodes: [] } },
    inputSchema: { type: "object", properties: {} },
  };
  const session = viewSession("47bc67a8-1f49-4914-aec6-758e81482437", "browser", "catalog", "00000000-0000-0000-0000-000000000000", {
    schemaVersion: 1, screen: "browser", disclosures: {},
    browser: { arguments: { limit: 20 }, history: [], selectedWorkflowId: null, selectedVersion: null },
  });
  let app = await mountApp(page, "browser", first, false, false, null, false, { "loomex/viewSession": session }, undefined, [
    { structuredContent: { ok: true, data: second } },
    { structuredContent: { ok: true, data: detail } },
  ]);
  await captureRequestedScreenshots(page, "durable-browser-list");
  await waitForPersistenceToolCount(page, "loomex_view_session_get", 1);
  await app.getByRole("button", { name: "Next", exact: true }).click();
  await app.getByText("Page 2 · 1 workflow", { exact: true }).waitFor();
  await app.getByRole("button", { name: /^View:/ }).click();
  await app.getByRole("heading", { name: "Durable workflow", exact: true }).waitFor();
  await page.waitForFunction((id: string) => window.__loomexPersistenceStore.sessions[id]?.state?.browser?.selectedWorkflowId === "63b5e9c3-7245-4b7e-a849-1692cc7d025f", session.viewSessionId);

  app = await mountApp(page, "browser", first, false, false, null, false, { "loomex/viewSession": session }, undefined, [
    { structuredContent: { ok: true, data: second } },
    { structuredContent: { ok: true, data: detail } },
  ], true);
  await waitForPersistenceToolCount(page, "loomex_view_session_get", 2);
  await app.getByRole("heading", { name: "Durable workflow", exact: true }).waitFor();
  await app.getByText("Version 3", { exact: false }).waitFor();
  await captureRequestedScreenshots(page, "durable-browser-restored-detail");
  const restoreCalls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(restoreCalls.slice(-2).map((call: any) => call.name), ["loomex_workflows_list", "loomex_workflow_get"]);
  assert.deepEqual(restoreCalls.at(-2).arguments, { limit: 20, cursor: "page-2" });
  assert.deepEqual(restoreCalls.at(-1).arguments, { workflowId, version: "3" });
  assert.ok((await page.evaluate(() => window.__loomexPersistenceCalls)).every((call: any) => call.name.startsWith("loomex_view_")));
});

test("run setup fields and a prepared run operation survive card closure without replay", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for durable run preparation");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const workflowId = "8100d86a-79ed-46b8-ab85-f374a368560b";
  const versionId = "1cf3f7d8-716c-446b-9ed0-f3dd73e188a4";
  const organizationId = "dadf8fe5-ae7e-4394-8fe9-b611093019d6";
  const setup = {
    workflow: { id: workflowId, organizationId, name: "Durable report" },
    selectedVersion: { id: versionId, workflowId, versionNumber: 1, definition: { settings: { inputSchema: { type: "object", properties: {} } }, nodes: [] } },
    inputSchema: { type: "object", properties: { title: { type: "string", title: "Report title" } }, required: ["title"] },
  };
  const setupSession = viewSession("20d82083-d502-45d1-85f7-eac73d5b9444", "prepare", "workflow", workflowId, {
    schemaVersion: 1, screen: "setup", disclosures: {}, workflowId, versionId, controls: {}, workspaceEditing: false,
  });
  const setupPage = await browser.newPage();
  let setupApp = await mountApp(setupPage, "prepare", setup, false, false, null, false, { "loomex/viewSession": setupSession });
  await waitForPersistenceToolCount(setupPage, "loomex_view_session_get", 1);
  await setupApp.getByLabel("Report title *", { exact: true }).fill("September report");
  await setupApp.getByLabel("Workspace directory *", { exact: true }).fill("/Users/example/report");
  await waitForPersistenceToolCount(setupPage, "loomex_view_session_update", 1);
  setupApp = await mountApp(setupPage, "prepare", setup, false, false, null, false, { "loomex/viewSession": setupSession }, undefined, [], true);
  await waitForPersistenceToolCount(setupPage, "loomex_view_session_get", 2);
  await available.tools.expect(setupApp.getByLabel("Report title *", { exact: true })).toHaveValue("September report");
  await available.tools.expect(setupApp.getByLabel("Workspace directory *", { exact: true })).toHaveValue("/Users/example/report");
  await captureRequestedScreenshots(setupPage, "durable-restored-setup");
  assert.deepEqual(await setupPage.evaluate(() => window.__loomexCalls), []);

  const preparationId = "3e5d666a-4653-48f3-abff-508f64358103";
  const runId = "d26183c4-a57f-4f9f-93bc-b9bc9c0e4116";
  const prepared = {
    preparationId, bindingDigest: "d".repeat(64), confirmationKey: "8d8351c8-c5fc-459a-a541-aa8db7dadba2",
    binding: { workflowId, versionId, organizationId, installationId: "47987b21-fd32-4df2-8a54-0a0be16219c6",
      workspacePath: "/Users/example/report", executionPolicy: "host_user/v1", inputs: { title: "September report" }, providerConfiguration: {} },
  };
  const presentation = {
    schemaVersion: "loomex/preparation-review/v1", preparationId, bindingDigest: prepared.bindingDigest,
    workflowId, versionId, organizationId, workflowName: "Durable report", workflowVersion: 1,
    organizationName: "Loomex", providers: [],
  };
  const preparedSession = viewSession("516ae75e-50af-4325-8dfa-4e0f82ad8c43", "prepare", "preparation", preparationId, {
    schemaVersion: 1, screen: "prepare", disclosures: {}, preparationId,
  });
  const preparedPage = await browser.newPage();
  let preparedApp = await mountApp(preparedPage, "prepare", prepared, true, false, presentation, false,
    { "loomex/viewSession": preparedSession });
  await waitForPersistenceToolCount(preparedPage, "loomex_view_session_get", 1);
  await preparedApp.getByRole("button", { name: "Start run", exact: true }).click();
  await preparedApp.getByRole("button", { name: "Retry exact start", exact: true }).waitFor();
  await preparedPage.waitForFunction(() => window.__loomexCalls.some((call: any) => call.name === "loomex_run_commit"));
  const firstCommit = (await preparedPage.evaluate(() => window.__loomexCalls)).find((call: any) => call.name === "loomex_run_commit");
  assert.ok(firstCommit, "the initial start reaches the exact domain tool after journaling");
  await preparedPage.waitForFunction(() => Object.values(window.__loomexPersistenceStore.operations).some((operation: any) => operation.method === "runs.commit"));
  const operationId = await preparedPage.evaluate(() => {
    const operations = Object.values(window.__loomexPersistenceStore.operations) as any[];
    return operations.find((operation) => operation.method === "runs.commit")?.operationId;
  });
  assert.match(operationId, /^[0-9a-f-]{36}$/i);
  const journaledStart = await preparedPage.evaluate((id: string) => window.__loomexPersistenceStore.operations[id], operationId);
  assert.equal(journaledStart.method, "runs.commit");
  assert.deepEqual(journaledStart.reconciliation, {}, "a commit has no speculative reconciliation read");
  await preparedPage.evaluate(() => { window.__persistenceDelayMs = 200; });
  preparedApp = await mountApp(preparedPage, "prepare", prepared, false, false, presentation, false,
    { "loomex/viewSession": preparedSession }, undefined, [{ structuredContent: { ok: true, data: {
      execution: { id: runId, status: "running", workflowName: "Durable report" }, executionPolicy: "host_user/v1", preparationId,
    } } }], true);
  await preparedApp.locator("#primary").evaluate((button: any) => button.click());
  await waitForPersistenceToolCount(preparedPage, "loomex_view_operation_get", 1);
  try {
    await preparedApp.getByRole("button", { name: "Retry exact start", exact: true }).waitFor({ timeout: 2_000 });
  } catch (error) {
    const diagnostics = await preparedPage.evaluate(() => ({
      body: document.getElementById("app")?.contentDocument?.body?.innerText,
      persistenceCalls: window.__loomexPersistenceCalls,
      operations: window.__loomexPersistenceStore.operations,
    }));
    throw new Error(`Prepared operation did not restore: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  assert.equal(await preparedPage.evaluate(() => window.__loomexCalls.length), 1, "rehydration only reads the journal and never replays the start");
  await preparedPage.evaluate(() => { window.__persistenceDelayMs = 0; });
  await preparedApp.getByRole("button", { name: "Retry exact start", exact: true }).click();
  await waitForToolCount(preparedPage, "loomex_run_commit", 2);
  const commits = (await preparedPage.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_run_commit");
  assert.deepEqual(commits[1].arguments, firstCommit.arguments, "the restored operation keeps every sealed field and idempotency key");
});

test("a failed forward-target read retries the exact saved navigation without reviving setup preparation", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for durable forward navigation recovery");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const workflowId = "dc772126-2588-4f5c-8261-61b7eeed6bb3";
  const versionId = "a85cf283-a500-4107-b6fc-6b49536bed86";
  const preparationId = "a8495a7a-61ac-4434-9d28-d3899b75e6e5";
  const sourceSession = viewSession("c9184191-a356-4820-a4fb-68a3c04c3485", "prepare", "workflow", workflowId, {
    schemaVersion: 1, screen: "setup", disclosures: {}, workflowId, versionId, controls: {}, workspaceEditing: false,
  });
  const targetSession = viewSession("d1a03a43-dc22-4a88-8f43-426ce8e5e8d9", "prepare", "preparation", preparationId, {
    schemaVersion: 1, screen: "review", disclosures: {}, preparationId,
  });
  const setup = {
    workflow: { id: workflowId, organizationId: "9a4b9007-01f8-40d6-a703-83aa9a9da1c5", name: "Forward recovery" },
    selectedVersion: { id: versionId, workflowId, versionNumber: 1,
      definition: { settings: { inputSchema: { type: "object", properties: {} } }, nodes: [] } },
    inputSchema: { type: "object", properties: {} },
  };
  const prepared = {
    preparationId, bindingDigest: "d".repeat(64), confirmationKey: "83ac4fb0-2682-468b-9498-a2d6361a73b1",
    binding: { workflowId, versionId, organizationId: setup.workflow.organizationId,
      installationId: "db967a0f-6bb2-4c86-8557-f7b961f2ad8b", workspacePath: "/Users/example/forward",
      executionPolicy: "host_user/v1", inputs: {}, providerConfiguration: {} },
  };
  await mountApp(page, "prepare", setup, false, false, null, false, { "loomex/viewSession": sourceSession });
  await waitForPersistenceToolCount(page, "loomex_view_session_get", 1);
  await page.evaluate(({ sourceId, target }: any) => {
    const source = window.__loomexPersistenceStore.sessions[sourceId];
    source.revision += 1;
    source.status = "inactive";
    source.state = { ...source.state, forwardSession: {
      viewSessionId: target.viewSessionId, kind: target.kind, entityType: target.entityType, entityId: target.entityId,
    } };
    window.__loomexPersistenceStore.sessions[target.viewSessionId] = structuredClone(target);
    window.__failNextViewSessionId = target.viewSessionId;
  }, { sourceId: sourceSession.viewSessionId, target: targetSession });

  const app = await mountApp(page, "prepare", setup, false, false, null, false, { "loomex/viewSession": sourceSession }, undefined, [
    { structuredContent: { ok: true, data: { status: "valid", operation: "runs.prepare", preparation: prepared } } },
  ], true);
  await app.getByRole("button", { name: "Retry restore", exact: true }).waitFor({ timeout: 5_000 });
  assert.equal((await page.evaluate(() => window.__loomexCalls)).some((call: any) => call.name === "loomex_run_prepare"), false);
  const targetReadsBeforeRetry = await page.evaluate((targetId: string) => window.__loomexPersistenceCalls.filter((call: any) =>
    call.name === "loomex_view_session_get" && call.arguments.viewSessionId === targetId).length, targetSession.viewSessionId);
  await app.getByRole("button", { name: "Retry restore", exact: true }).click();
  await app.locator(".app-header h1").getByText("Review run", { exact: true }).waitFor({ timeout: 5_000 });
  const evidence = await page.evaluate((targetId: string) => ({
    targetReads: window.__loomexPersistenceCalls.filter((call: any) =>
      call.name === "loomex_view_session_get" && call.arguments.viewSessionId === targetId).length,
    domainNames: window.__loomexCalls.map((call: any) => call.name),
  }), targetSession.viewSessionId);
  assert.ok(evidence.targetReads > targetReadsBeforeRetry, "Retry restore re-reads the exact failed forward target");
  assert.deepEqual(evidence.domainNames, ["loomex_preparation_get"]);
});

test("reopening setup follows a committed preparation through its durable monitor target", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for durable chained navigation recovery");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const workflowId = "dd25f9b7-c98e-4c15-a31a-7d4f49ca1e68";
  const versionId = "48a69d1e-05af-4225-b1b5-69f93f6637fb";
  const preparationId = "a48d8335-780c-4cb3-a469-62edf392a20a";
  const runId = "1708af25-8f7d-439c-a864-0405402d9c76";
  const source = viewSession("87e001a2-4ce5-40a9-a1b9-dfa3bb2744ca", "prepare", "workflow", workflowId, {
    schemaVersion: 1, screen: "setup", disclosures: {}, workflowId, versionId,
  });
  const preparation = viewSession("b9c53d9f-b468-4e9f-a874-e357914d9f22", "prepare", "preparation", preparationId, {
    schemaVersion: 1, screen: "review", disclosures: {}, preparationId,
  });
  const monitor = viewSession("6e141f1a-879c-4640-8e10-d26611649832", "monitor", "execution", runId, {
    schemaVersion: 1, screen: "monitor", disclosures: {}, executionId: runId,
  });
  source.state.forwardSession = { viewSessionId: preparation.viewSessionId, kind: preparation.kind, entityType: preparation.entityType, entityId: preparation.entityId };
  source.status = "inactive";
  preparation.state.forwardSession = { viewSessionId: monitor.viewSessionId, kind: monitor.kind, entityType: monitor.entityType, entityId: monitor.entityId };
  preparation.status = "inactive";
  const setup = {
    workflow: { id: workflowId, organizationId: "44a4d854-30a4-4d7d-8950-09b3ba459765", name: "Chained recovery" },
    selectedVersion: { id: versionId, workflowId, versionNumber: 1, definition: { settings: { inputSchema: { type: "object", properties: {} } }, nodes: [] } },
    inputSchema: { type: "object", properties: {} },
  };
  await mountApp(page, "prepare", setup, false, false, null, false, { "loomex/viewSession": source });
  await waitForPersistenceToolCount(page, "loomex_view_session_get", 1);
  await page.evaluate((sessions: any[]) => {
    for (const session of sessions) window.__loomexPersistenceStore.sessions[session.viewSessionId] = structuredClone(session);
  }, [source, preparation, monitor]);
  const app = await mountApp(page, "prepare", setup, false, false, null, false, { "loomex/viewSession": source }, undefined, [
    { structuredContent: { ok: true, data: { execution: { id: runId, status: "running", workflowName: "Chained recovery" }, latestSequence: 4 } } },
  ], true);
  await app.getByText("Chained recovery", { exact: true }).waitFor();
  const calls = await page.evaluate(() => window.__loomexCalls.map((call: any) => call.name));
  assert.deepEqual(calls, ["loomex_run_get"], "a committed preparation must be skipped in favor of its monitor target");
  assert.equal(await app.getByText("The saved preparation is no longer available.", { exact: false }).count(), 0);
});

test("authoring workflow detail matches the browser read view and only hands preparation to the conversation", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for workflow authoring detail");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const id = "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e";
  const versionId = "8b29c880-1c68-4d47-a1ff-477ab28d3c49";
  const taskContext = { cwd: "/Users/example/authoring-task" };
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
  const app = await mountApp(page, "authoring", detail, false, false, null, false, { "loomex/taskWorkspace": { taskContext } });
  await app.getByRole("heading", { name: "Future v5", exact: true }).waitFor();
  assert.equal(await app.locator(".app-header h1").textContent(), "Workflow details");
  await app.getByText("Project directory", { exact: true }).waitFor();
  await app.getByText("gpt-5.6-luna · medium effort", { exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Prepare run", exact: true }).evaluate((button: any) => button.getBoundingClientRect().height >= 36), true);
  assert.equal(await app.locator("body").evaluate((body: any) => body.scrollWidth <= body.clientWidth), true);
  await captureRequestedScreenshots(page, "workflow-detail");

  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await waitForCallCount(page, 1);
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls))[0], { name: "loomex_workflow_get", arguments: { workflowId: id, version: "5" } });
  await app.getByRole("heading", { name: "Future v5", exact: true }).waitFor();

  await page.evaluate(() => {
    window.__workflowDelayMs = 120;
    window.__workflowResponses = [{ isError: true, structuredContent: { ok: false } }];
  });
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await app.locator(".workflow-skeleton").waitFor();
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
  await app.locator("#summary.error").waitFor({ state: "hidden" });
  assert.equal(await app.getByRole("button", { name: "Prepare run", exact: true }).isEnabled(), true);
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls))[2], { name: "loomex_workflow_get", arguments: { workflowId: id, version: "5" } });

  const setupSession = viewSession("0c9c0ac7-c460-4022-b360-025a91a68b90", "prepare", "workflow", id, {});
  await page.evaluate(({ detail, setupSession, taskContext }: any) => { window.__workflowResponses = [{
    structuredContent: { ok: true, data: detail },
    _meta: { "loomex/taskWorkspace": { taskContext }, "loomex/viewSession": setupSession },
  }]; }, { detail, setupSession, taskContext });
  await app.getByRole("button", { name: "Prepare run", exact: true }).click();
  await app.getByRole("heading", { name: "Future v5", exact: true }).waitFor();
  await app.getByLabel("Workspace directory *", { exact: true }).waitFor();
  assert.equal(await app.getByLabel("Workspace directory *", { exact: true }).inputValue(), taskContext.cwd);
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_workflow_get", "loomex_workflow_get", "loomex_workflow_get", "loomex_run_setup"]);
  assert.deepEqual(calls.at(-1).arguments, { workflowId: id, version: "5", taskContext });
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
  const app = await mountApp(page, "authoring", { responseRef, encoding: "json", sizeBytes: 90_000, nextOffset: 0 },
    false, false, null, false, {});
  await app.getByRole("button", { name: "View complete response", exact: true }).click();
  await app.getByText("The conversation has been asked to retrieve the complete workflow response.", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), []);
  const messages = await page.evaluate(() => window.__loomexMessages);
  assert.equal(messages.length, 1);
  assert.match(messages[0].content[0].text, new RegExp(responseRef));
  assert.match(messages[0].content[0].text, /request is read-only/);
  assert.match(messages[0].content[0].text, /verify checksumSha256 before interpreting or presenting/);
  assert.match(messages[0].content[0].text, /does not authorize preparation, commit, or execution/);
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
  const inputs = app.locator('section[aria-label="Inputs"]');
  await inputs.getByText("Showing 12 of 51 inputs.", { exact: true }).waitFor();
  assert.equal(await inputs.locator(".workflow-detail-item").count(), 12);
  assert.equal(await inputs.getByText("Input 50", { exact: true }).count(), 0);
  const providers = app.locator('section[aria-label="AI"]');
  await providers.getByText("Showing 8 of 21 AI configurations.", { exact: true }).waitFor();
  assert.equal(await providers.locator(".workflow-detail-item").count(), 8);
  assert.equal(await providers.getByText("model-20", { exact: true }).count(), 0);
  const steps = app.locator('section[aria-label="Steps"]');
  await steps.getByText("Showing 8 of 101 steps.", { exact: true }).waitFor({ state: "attached" });
  assert.equal(await steps.locator("li").count(), 8);
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
    assert.equal(await app.locator(".workflow-row-actions button").evaluateAll((buttons: any[]) => buttons.every((button) => button.getBoundingClientRect().height >= 36)), true);
    await app.getByLabel("Search workflows", { exact: true }).focus();
    assert.equal(await app.getByLabel("Search workflows", { exact: true }).evaluate((el: any) => el.ownerDocument.defaultView.getComputedStyle(el).outlineStyle), "solid");
    await waitForSettledAppSize(page);
    const directory = process.env.LOOMEX_UI_SCREENSHOT_DIR;
    if (directory) { await mkdir(directory, { recursive: true }); await app.locator("main").screenshot({ path: resolve(directory, `browser-${width}-${colorScheme}.png`) }); }
    await app.getByRole("button", { name: "Next", exact: true }).click();
    await app.getByText("Page 2 · 2 workflows", { exact: true }).waitFor();
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
  await recovery.getByText("Page 2 · 2 workflows", { exact: true }).waitFor();
  assert.equal(await recovery.getByRole("button", { name: "Previous", exact: true }).isEnabled(), true);
  await page.evaluate((data: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data } }]; }, paged);
  await recovery.getByRole("button", { name: "View: One", exact: true }).click();
  await recovery.getByRole("button", { name: "View complete response", exact: true }).waitFor();
  await recovery.getByRole("button", { name: "Back to workflows", exact: true }).click();
  await recovery.getByText("Page 2 · 2 workflows", { exact: true }).waitFor();
  const app = await mountApp(page, "browser", paged, false, false, null, true);
  await app.getByRole("button", { name: "View complete response", exact: true }).click();
  await app.locator("#summary.error").waitFor();
  assert.equal(await page.evaluate(() => window.__loomexCalls.length), 0);
  assert.match((await page.evaluate(() => window.__loomexMessages))[0].content[0].text, /loomex_response_read/);
});

test("workflow browser fails closed for unverifiable pages while a verified empty page stays empty", async (t) => {
  const available = await browserTools();
  if (!available) {
    if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser");
    t.skip("Playwright or a local Chromium executable is unavailable");
    return;
  }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const invalidPages = [
    { nextCursor: null },
    { workflows: [], nextCursor: 3 },
    { workflows: [{ id: "", name: "Untrusted workflow" }], nextCursor: null },
  ];

  for (const data of invalidPages) {
    const app = await mountApp(page, "browser", data);
    await app.getByText("The workflow list could not be verified. Continue in the conversation.", { exact: true }).waitFor();
    await app.getByText("The workflow list is unavailable in this view. Continue in the conversation.", { exact: true }).waitFor();
    assert.equal(await app.getByText(/No workflows (match|are)/).count(), 0);
    assert.equal(await app.getByRole("button", { name: /^View:/ }).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__loomexCalls), []);
  }

  const app = await mountApp(page, "browser", { workflows: [], nextCursor: null });
  await app.getByText("No workflows are available in the selected organization.", { exact: true }).waitFor();
  assert.equal(await app.locator("#summary.error").count(), 0);
  assert.equal(await app.getByText("The workflow list is unavailable in this view.").count(), 0);
});

test("interaction with a typed question but no response schema cannot submit", async (t) => {
  const available = await browserTools();
  if (!available) {
    if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser");
    t.skip("Playwright or a local Chromium executable is unavailable");
    return;
  }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const app = await mountApp(page, "interaction", {
    humanRequest: {
      id: "a3e04768-688e-42a5-a857-2f62f3855328",
      type: "manual_input",
      status: "pending",
      title: "Missing schema",
      inputSpec: { inputType: "text", question: "What should we do?", collectionMode: "single" },
    },
  });
  await app.locator("#form").getByText("This form is missing its response schema. Continue in the conversation to provide your answer.", { exact: true }).waitFor();
  const review = app.locator("#primary");
  await review.waitFor({ state: "visible", timeout: 5_000 });
  assert.equal(await review.isDisabled(), true);
  assert.equal(await app.locator("input[data-value]").count(), 0);
  assert.equal(await page.evaluate(() => window.__loomexCalls.some((call: any) => call.name === "loomex_interaction_respond")), false);
});

test("compact controls avoid redundant tooltips while in-place loading and stable timing remain", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium required for compact UI interaction checks");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: "reduce" });
  const app = await mountApp(page, "browser", { workflows: [], nextCursor: null });
  await waitForPersistenceToolCount(page, "loomex_view_session_get", 1);
  assert.equal(await app.getByRole("button", { name: "Connection information", exact: true }).count(), 0);
  await app.getByRole("button", { name: "Refresh", exact: true }).focus();
  assert.equal(await app.getByRole("tooltip").count(), 0, "an obvious refresh icon does not repeat its accessible name as a tooltip");
  assert.equal(await app.locator("button.icon-button:visible").evaluateAll((buttons: any[]) => buttons.every(button =>
    button.querySelector('svg[aria-hidden="true"]') && button.getAttribute("aria-label") && button.querySelector(".sr-only"))), true);
  assert.equal(await app.getByRole("button", { name: "Previous", exact: true }).innerText(), "Previous");
  assert.equal(await app.getByRole("button", { name: "Next", exact: true }).innerText(), "Next");
  const searchBounds = await app.locator(".workflow-search").boundingBox();
  assert.ok(searchBounds.height <= 44, "Search controls occupy one compact row");
  assert.equal(await app.locator(".app-footer").isVisible(), false, "Empty action bars reserve no space");
  await waitForSettledAppSize(page);
  await page.evaluate(() => { window.__workflowDelayMs = 500; });
  await app.getByRole("button", { name: "Refresh", exact: true }).focus();
  const compactLayoutBefore = await appLayoutSnapshot(page);
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await app.locator(".workflow-skeleton").waitFor();
  const compactLayoutDuring = await appLayoutSnapshot(page);
  assertStableLoadingLayout(compactLayoutBefore, compactLayoutDuring, "Loading workflows…");
  assert.equal(await app.locator("#activity").isVisible(), false);
  assert.equal(await app.locator(".workflow-loading-status").textContent(), "Loading workflows…");
  assert.equal(await app.locator(".workflow-loading-status").evaluate((node: any) => node.ownerDocument.defaultView.getComputedStyle(node, "::before").animationName), "none");
  assert.equal(await app.locator(".skeleton-row").first().evaluate((node: any) => node.ownerDocument.defaultView.getComputedStyle(node).animationName), "none");
  await app.locator(".workflow-loading-status").waitFor({ state: "detached" });
  await page.waitForFunction(() => document.getElementById("app")?.contentDocument?.activeElement?.getAttribute("aria-label") === "Refresh");
  assert.equal((await appLayoutSnapshot(page)).focus, "Refresh");
  assert.equal((await appLayoutSnapshot(page)).focusVisible, true);
  const terminal = await mountApp(page, "monitor", { execution: { id: "30bbc16b-af38-45c4-852b-2ac35dc3329e", workflowName: "A finished workflow", status: "completed",
    startedAt: "2026-09-06T08:00:00.000Z", completedAt: "2026-09-06T08:02:05.000Z" } });
  assert.equal(await terminal.locator(".app-header #run-clock").textContent(), "2m 5s");
  assert.equal(await terminal.locator("#run-clock").getAttribute("aria-label"), "Elapsed time: 2m 5s");
  assert.equal(await terminal.locator("#context .ui-card").count(), 0, "Run status uses an inline hierarchy, not statistic cards");
  await terminal.getByRole("button", { name: "Run timing", exact: true }).focus();
  assert.equal(await terminal.getByRole("button", { name: "Run timing", exact: true }).getAttribute("aria-describedby"), "ui-tooltip");
  assert.match(await terminal.getByRole("tooltip").textContent(), /Started:.*Completed:/);
  await page.waitForTimeout(1100);
  assert.equal(await terminal.locator("#run-clock").textContent(), "2m 5s", "Terminal duration does not keep ticking");
});

test("workflow pagination stays visible for single and empty pages and resets cursors on page size changes", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium required for cursor pagination");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const workflow = { id: "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e", name: "Idea", latestVersion: 7, nodeCount: 11 };
  const app = await mountApp(page, "browser", { workflows: [workflow], nextCursor: null });
  const nav = app.getByRole("navigation", { name: "Workflow pages", exact: true });
  await nav.waitFor();
  assert.equal(await nav.getByRole("button", { name: "Previous", exact: true }).isDisabled(), true);
  assert.equal(await nav.getByRole("button", { name: "Next", exact: true }).isDisabled(), true);
  await nav.getByText("Page 1 · 1 workflow", { exact: true }).waitFor();
  assert.match(await nav.getAttribute("class"), /ui-data-table-pagination/);
  const size = app.getByLabel("Workflows per page", { exact: true });
  assert.equal(await size.inputValue(), "20");
  await page.evaluate((workflow: any) => {
    window.__workflowResponses = [{ structuredContent: { ok: true, data: { workflows: [workflow], nextCursor: "second-page" } } }];
  }, workflow);
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await nav.getByRole("button", { name: "Next", exact: true }).locator("xpath=self::*[not(@disabled)]").waitFor();
  await page.evaluate((workflow: any) => {
    window.__workflowResponses = [{ structuredContent: { ok: true, data: { workflows: [workflow], nextCursor: null } } }];
  }, workflow);
  await nav.getByRole("button", { name: "Next", exact: true }).click();
  await nav.getByText("Page 2 · 1 workflow", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.__workflowDelayMs = 200;
    window.__workflowResponses = [{ structuredContent: { ok: true, data: { workflows: [], nextCursor: null } } }];
  });
  await size.focus();
  await size.selectOption("10");
  await app.getByText("Page 1 · 0 workflows", { exact: true }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls)).at(-1), { name: "loomex_workflows_list", arguments: { limit: 10 } });
  assert.equal(await size.inputValue(), "10");
  assert.equal(await size.evaluate((el: any) => el === el.ownerDocument.activeElement), true);
  assert.equal(await nav.getByRole("button", { name: "Previous", exact: true }).isDisabled(), true);
  assert.equal(await nav.getByRole("button", { name: "Next", exact: true }).isDisabled(), true);
  assert.equal(await app.locator("body").evaluate((el: any) => el.scrollWidth <= el.clientWidth), true);
  await captureRequestedScreenshots(page, "workflow-pagination-mobile-empty");
});
