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

function followContinuationDetails(runId: string, receipt = "A".repeat(16)): Record<string, unknown> {
  return { details: { followContinuation: {
    schemaVersion: "loomex-runs-follow-existing-run-continuation/v2",
    source: "generated_markdown",
    runId,
    receipt,
  } } };
}

function expectedFollowContinuation(runId: string, receipt = "A".repeat(16)): Record<string, unknown> {
  return {
    schemaVersion: "loomex-runs-follow-existing-run-continuation/v2",
    source: "generated_markdown",
    runId,
    receipt,
  };
}

function expectedFollowMarkdown(runId: string, receipt = "A".repeat(16)): string {
  return `$loomex-runs follow-existing-run ${runId}\n\n<!-- loomex-runs-follow-existing-run-continuation/v2 receipt=${receipt} -->\n\nFollow the exact existing Loomex run identified above: first call \`loomex_run_get\` with this run ID, then follow its authoritative \`nextAction\`.\n\nWhile the fresh authoritative \`nextAction\` is \`loomex_run_wait\` or \`loomex_run_events\`, do not final-answer: drain required event pages, then call the next action. Active progress, provider activity, and quiet timeouts require another bounded wait. Hooks and schedules are not prerequisites.\n\nFinal-answer only after presenting verified user input, retrieving the complete authoritative terminal result, an actionable observation failure, or an explicit user stop. Each wait is bounded; do not add hidden indefinite waits or UI polling.\n\nDo not start another run or resubmit an accepted response.`;
}

function connectionProjection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "loomex.runner.connection/v1",
    state: "signed_out",
    organization: { status: "organization_required", selected: null },
    organizations: [],
    activeWork: 0,
    actions: ["auth.login"],
    login: null,
    ...overrides,
  };
}

function parseFollowContextMarkdown(text: string): Record<string, unknown> {
  const match = /^Loomex continuation context:\n\n```json\n([\s\S]+)\n```$/.exec(text);
  assert.ok(match, "follow context must be a labelled fenced JSON block");
  return JSON.parse(match[1]!);
}

async function mountApp(
  page: any,
  mode: "interaction" | "authoring" | "prepare" | "monitor" | "browser" | "runs" | "connection" | "organizations",
  data: Record<string, unknown>,
  failFirstMutation = false,
  resolveOnRead = false,
  presentation: Record<string, unknown> | null = null,
  failUiMessage = false,
  resultMeta: Record<string, unknown> | undefined = undefined,
  hostCapabilities: Record<string, unknown> | null = { message: { text: {} }, updateModelContext: { text: {} } },
  workflowResponses: Array<Record<string, unknown>> = [],
  reuseHost = false,
  workflowDelayMs = 0,
) {
  page.setDefaultTimeout(10_000);
  const html = renderUiHtml(mode);
  const source = data as any;
  const entity = ["connection", "organizations"].includes(mode)
    ? null
    : mode === "browser" || mode === "runs"
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
  const validEntityId = entity !== null && ((entity.entityType === "catalog" && entity.entityId === "00000000-0000-0000-0000-000000000000") ||
    (typeof entity.entityId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entity.entityId)));
  const generatedPersistenceMeta = validEntityId
    ? { "loomex/viewSession": viewSession(randomUUID(), mode as "browser" | "authoring" | "prepare" | "monitor" | "interaction", entity!.entityType, entity!.entityId, {}) }
    : ["connection", "organizations"].includes(mode) ? {} : { "loomex/viewPersistence": { status: "unavailable" } };
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
  await page.evaluate(({ source, initialData, shouldFailFirst, shouldResolveOnRead, presentation, shouldFailUiMessage, resultMeta, hostCapabilities, workflowResponses, workflowDelayMs, preserveHostState, appCallableToolNames }: any) => {
    const frame = document.getElementById("app");
    if (!preserveHostState) {
      window.__loomexCalls = [];
      window.__loomexMessages = [];
      window.__loomexOpenedLinks = [];
      window.__loomexModelContexts = [];
      window.__loomexSizes = [];
      window.__loomexPersistenceCalls = [];
      window.__loomexPersistenceStore = { sessions: {}, operations: {}, drafts: {}, deliveries: {}, receipts: {} };
    } else {
      window.__loomexCalls ||= [];
      window.__loomexMessages ||= [];
      window.__loomexOpenedLinks ||= [];
      window.__loomexModelContexts ||= [];
      window.__loomexSizes ||= [];
      window.__loomexPersistenceCalls ||= [];
      window.__loomexPersistenceStore ||= { sessions: {}, operations: {}, drafts: {}, deliveries: {}, receipts: {} };
    }
    window.__workflowResponses = workflowResponses.slice();
    window.__workflowDelayMs = workflowDelayMs;
    const persistenceStore = window.__loomexPersistenceStore;
    persistenceStore.deliveries ||= {};
    const initialProjection = resultMeta?.["loomex/viewSession"];
    if (initialProjection?.viewSessionId && !persistenceStore.sessions[initialProjection.viewSessionId]) {
      persistenceStore.sessions[initialProjection.viewSessionId] = structuredClone(initialProjection);
    }
    const persistenceNames = new Set([
      "loomex_connection_view_create", "loomex_connection_view_get", "loomex_connection_view_update",
      "loomex_view_session_create", "loomex_view_session_get", "loomex_view_session_restore", "loomex_view_session_update", "loomex_view_session_delete",
      "loomex_view_operation_get", "loomex_view_operation_settle",
      "loomex_interaction_draft_get", "loomex_interaction_draft_update", "loomex_interaction_draft_delete",
      "loomex_delivery_get", "loomex_delivery_begin", "loomex_delivery_settle",
    ]);
    const appCallableNames = new Set(appCallableToolNames);
    const journalMethods = new Set([
      "interactions.respond", "interactions.decide", "builder.respond", "runs.cancel", "runs.commit",
      "builder.commit", "editor.commit", "workspaces.grant", "runs.prepare",
      "runs.start_handoff.issue", "runs.start_handoff.approve",
    ]);
    const reconciliationMethods = new Set(["interactions.get", "builder.get", "runs.get"]);
    // Match the installed MCP result: authoritative data is present in both
    // channels, while model-facing text is deliberately only a summary.
    const persistenceResult = (data: any) => ({
      structuredContent: { ok: true, data },
      _meta: { "loomex/uiData": { ok: true, data: structuredClone(data) } },
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    });
    const persistenceError = (code: string, message: string) => ({
      isError: true,
      structuredContent: { ok: false, error: { code, message } },
    });
    const exact = (left: any, right: any) => JSON.stringify(left) === JSON.stringify(right);
    const delivery = (identity: any) => {
      if (typeof identity !== "string" || !identity) return undefined;
      const continuation = identity.startsWith("start:")
        ? { handoffRef: identity.slice("start:".length) }
        : identity.startsWith("question:")
          ? { requestId: identity.slice("question:".length) }
          : (() => {
              const match = /^follow:([^:]+):(.+)$/.exec(identity);
              if (!match) return { identity };
              const runId = match[1]!;
              const suffix = match[2]!;
              return {
                runId,
                receipt: "A".repeat(16),
                ...(/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(suffix) ? { requestId: suffix } : {}),
              };
            })();
      const legacy = Object.values(persistenceStore.sessions).map((s:any)=>s.state?.continuationDelivery).find((d:any)=>d?.identity===identity) as any;
      return persistenceStore.deliveries[identity] ||= {
        schemaVersion: 2,
        identity,
        continuation,
        revision: 0,
        status: legacy ? (["sending", "unknown"].includes(legacy.status) ? "unknown" : legacy.status === "acknowledged" ? "acknowledged" : "not_sent") : "ready",
        attemptId: null,
      };
    };
    const receivePersistenceCall = (message: any) => {
      const call = structuredClone(message.params);
      window.__loomexPersistenceCalls.push(call);
      const name = call.name.replace("loomex_connection_view_", "loomex_view_session_");
      const args = call.arguments || {};
      const fail = window.__blockedPersistenceTools?.includes(name) || window.__failNextPersistenceCall === true || window.__failNextPersistenceCall === name ||
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
      } else if (name === "loomex_view_session_get" || name === "loomex_view_session_restore") {
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
      } else if (name === "loomex_delivery_get") {
        const record = delivery(args.identity);
        // Reproduce the live host boundary: null attemptId is absent from
        // both canonical channels, although the durable runner row has null.
        const wire = record ? structuredClone(record) : undefined;
        if (wire?.attemptId === null && wire.status === "ready" && wire.revision === 0) delete wire.attemptId;
        result = wire
          ? persistenceResult(wire)
          : persistenceError("DELIVERY_IDENTITY_INVALID", "Delivery identity is required");
      } else if (name === "loomex_delivery_begin") {
        const record = delivery(args.identity);
        if (!record || !Number.isSafeInteger(args.expectedRevision) || typeof args.attemptId !== "string" || !args.attemptId) {
          result = persistenceError("DELIVERY_BEGIN_INVALID", "Delivery begin requires an identity, revision, and attempt");
        } else if (record.revision !== args.expectedRevision) {
          result = persistenceError("DELIVERY_REVISION_CONFLICT", "Delivery revision conflict");
        } else if (record.status === "sending" && record.attemptId !== args.attemptId) {
          result = persistenceError("DELIVERY_ATTEMPT_ACTIVE", "A different delivery attempt is active");
        } else if (!["ready", "not_sent", "rejected"].includes(record.status)) {
          result = persistenceError("DELIVERY_NOT_SENDABLE", "Delivery cannot begin from its current state");
        } else {
          record.revision += 1;
          record.status = "sending";
          record.attemptId = args.attemptId;
          result = persistenceResult(structuredClone(record));
        }
      } else if (name === "loomex_delivery_settle") {
        const record = delivery(args.identity);
        if (!record || !Number.isSafeInteger(args.expectedRevision) || typeof args.attemptId !== "string" || !args.attemptId ||
          !["not_sent", "acknowledged", "rejected", "unknown"].includes(args.status)) {
          result = persistenceError("DELIVERY_SETTLE_INVALID", "Delivery settlement is invalid");
        } else if (record.revision !== args.expectedRevision || record.status !== "sending" || record.attemptId !== args.attemptId) {
          result = persistenceError("DELIVERY_ATTEMPT_MISMATCH", "Delivery settlement does not own the active attempt");
        } else {
          record.revision += 1;
          record.status = args.status;
          result = persistenceResult(structuredClone(record));
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
        if (window.__dropNextUiMessageResponse) {
          window.__dropNextUiMessageResponse = false;
          return;
        }
        const failMessage = shouldFailUiMessage || Boolean(window.__failNextUiMessage);
        window.__failNextUiMessage = false;
        event.source.postMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: failMessage ? { isError: true } : {},
        }, "*");
        return;
      }
      if (message.method === "ui/open-link") {
        const url = message.params?.url;
        if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
          event.source.postMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Invalid external URL" } }, "*");
          return;
        }
        window.__loomexOpenedLinks.push(url);
        event.source.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
        return;
      }
      if (message.method === "tools/call") {
        if (persistenceNames.has(message.params?.name)) {
          const result = receivePersistenceCall(message);
          if (result !== undefined) {
            const deliver=()=>event.source.postMessage({jsonrpc:"2.0",id:message.id,result},"*");
            if(window.__holdPersistence)(window.__heldPersistence ||= []).push(deliver);
            else window.setTimeout(deliver,Number(window.__persistenceDelayMs || 0));
          }
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
        const handoffProjection = {
          schemaVersion: "loomex.run-start-handoff/v2",
          handoffRef: "11111111-1111-4111-8111-111111111111",
          preparationId: message.params.arguments?.preparationId || window.__lastPreparationData?.preparationId || initialData?.preparationId,
          lifecycle: "prepared", approvalObserved: false, nextAction: "approve",
        };
        const handoffResult = message.params.name === "loomex_run_start_handoff_issue"
          ? { structuredContent: { ok: true, data: handoffProjection } }
          : message.params.name === "loomex_run_start_handoff_approve"
            ? { structuredContent: { ok: true, data: { ...handoffProjection, lifecycle: "approved", approvalObserved: true, nextAction: "commit" } } }
            : message.params.name === "loomex_run_start_handoff_get"
              ? { structuredContent: { ok: true, data: handoffProjection } }
              : undefined;
        const result = window.__handoffResponses?.length && message.params.name.startsWith("loomex_run_start_handoff_") ? window.__handoffResponses.shift() : handoffResult || window.__workflowResponses?.length ? (handoffResult || window.__workflowResponses.shift()) : shouldFailFirst && callNumber === 1
          ? {
              isError: true,
              structuredContent: {
                ok: false,
                error: { code: "NETWORK_AMBIGUOUS", message: "Safe failure" },
              },
            }
          : { structuredContent: { ok: true, data: resultData } };
        const returnedData = result?.structuredContent?.ok === true ? result.structuredContent.data : undefined;
        if (returnedData?.requestId && returnedData?.executionId && returnedData?.requestStatus) {
          const pending = delivery(`follow:${returnedData.executionId}:${returnedData.requestId}`);
          pending.continuation.requestStatus = returnedData.requestStatus;
        }
        if (returnedData?.execution?.id) window.__lastRunData = returnedData;
        const returnedPreparation = returnedData?.preparation ?? returnedData;
        if (returnedPreparation?.preparationId && returnedPreparation?.binding) window.__lastPreparationData=returnedPreparation;
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
    workflowDelayMs,
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
  }, label, { timeout: 5_000 }).catch(async (error:unknown)=>{throw new Error(JSON.stringify(await page.evaluate(()=>({body:document.getElementById("app")?.contentDocument?.body?.innerText,calls:window.__loomexCalls,operations:window.__loomexPersistenceStore.operations}))),{cause:error});});
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
      window.__loomexMessages.length === expected && window.__loomexModelContexts.length === 0,
    count, { timeout: 5_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      messages: window.__loomexMessages,
      modelContexts: window.__loomexModelContexts,
    }));
    throw new Error(`Expected ${count} self-contained chat handoffs: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
}

async function handoffAt(page: any, index = -1): Promise<{ context: any; message: any }> {
  return page.evaluate((offset: number) => {
    const contexts = window.__loomexModelContexts;
    const messages = window.__loomexMessages;
    const message = messages.at(offset);
    return { context: { content: [{type:"text",text:message.content[0].text.slice(message.content[0].text.indexOf("Loomex continuation context:"))}] }, message };
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
  assert.equal(during.focus, focus, "loading retains a visible focus target");
  assert.equal(during.focusVisible, true, "loading keeps focus on a visible element");
}

async function captureRequestedScreenshots(page: any, prefix: string): Promise<void> {
  const directory = process.env.LOOMEX_UI_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const frame = page.locator("#app");
  const original = page.viewportSize() || { width: 820, height: 1300 };
  for (const [name, width, theme] of [["wide", 820, "light"], ["mobile", 390, "light"], ["dark", 820, "dark"], ["mobile-dark", 390, "dark"]] as const) {
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

test("connection view renders fresh state without auto-starting authentication and exposes its explicit actions", async (t) => {
  const available = await browserTools();
  if (!available) {
    if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser");
    t.skip("Playwright browser unavailable");
    return;
  }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const app = await mountApp(page, "connection", connectionProjection());
  await app.getByRole("heading", { name: "Connection", exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), [], "mount only renders its supplied connection projection");
  await app.getByRole("button", { name: "Sign in", exact: true }).click();
  await waitForToolCount(page, "loomex_auth_start", 1);
  await waitForToolCount(page, "loomex_connection_get", 1);
  assert.equal(await app.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
});

test("connection verification displays one progress state and does not poll before its returned interval", async (t) => {
  const available = await browserTools();
  if (!available) {
    if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser");
    t.skip("Playwright browser unavailable");
    return;
  }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pending = connectionProjection({
    state: "verification_pending",
    actions: ["auth.poll"],
    login: { flowId: "flow-a", verificationUri: "https://example.test/verify", userCode: "ABCD-1234", expiresAt: Math.floor(Date.now() / 1000) + 60, intervalSeconds: 60, retryAfterSeconds: 60 },
  });
  const app = await mountApp(page, "connection", pending);
  await app.getByText("Waiting for verification…", { exact: true }).waitFor();
  assert.equal(await app.getByText("Waiting for verification…", { exact: true }).count(), 1);
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), [], "polling waits for the returned interval");
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await waitForToolCount(page, "loomex_connection_get", 1);
  assert.equal(await page.evaluate(() => window.__loomexCalls.some((call: any) => call.name === "loomex_auth_poll")), false);
});

test("a fresh authenticated connection loads organizations separately before selection", async (t) => {
  const available = await browserTools();
  if (!available) {
    if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser");
    t.skip("Playwright browser unavailable");
    return;
  }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const organizationId = "7a6b8c10-9a11-4a12-8a13-141516171819";
  const initial = connectionProjection({
    state: "authenticated",
    actions: ["organizations.list", "organizations.select", "auth.logout"],
  });
  const refreshed = connectionProjection({
    state: "authenticated",
    actions: ["organizations.list", "organizations.select", "auth.logout"],
    organizations: [{ id: organizationId, name: "Loomex Studio", enrolled: true }],
  });
  const app = await mountApp(page, "organizations", initial, false, false, null, false, undefined, undefined, [
    { structuredContent: { ok: true, data: { organizations: [{ id: organizationId, name: "Loomex Studio", enrolled: false }] } } },
    { structuredContent: { ok: true, data: { selected: true } } },
    { structuredContent: { ok: true, data: { ...refreshed, organization: { status: "connected", selected: { id: organizationId, name: "Loomex Studio" } } } } },
    { structuredContent: { ok: true, data: { organizations: [{ id: organizationId, name: "Loomex Studio", enrolled: true }] } } },
  ]);
  await app.getByRole("radio", { name: "Loomex Studio" }).check();
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls)).map((call: any) => call.name), ["loomex_organizations_list"]);
  await app.getByRole("button", { name: "Use organization", exact: true }).click();
  await waitForToolCount(page, "loomex_organization_select", 1);
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.equal(calls[1].arguments.organizationId, organizationId);
  await app.getByText("Current", { exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Sign out", exact: true }).count(), 0);

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
  await app.locator("#question-3-rating-3").focus();
  await app.locator("#question-3-rating-3").press("Space");
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
  await app.getByText("Question 2 of 2", { exact: true }).waitFor();
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
  await app.getByRole("button", { name: "Previous question", exact: true }).click();
  await app.getByText("Question 1 of 2", { exact: true }).waitFor();
  assert.equal(await app.locator("#question-0-value").inputValue(), "Ada", "a stale card never overwrites or loses its local answer");
  const updates = (await page.evaluate(() => window.__loomexPersistenceCalls)).filter((call: any) => call.name === "loomex_interaction_draft_update");
  assert.equal(updates.at(-1).arguments.expectedRevision, 0);
  assert.equal(await page.evaluate(() => window.__loomexPersistenceStore.drafts["7acebd3d-c12d-4686-bd71-eaa708960a86"].answers.first.value), "Grace");
});

test("a late successful draft save cannot be reused by the next interaction request", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for isolated interaction draft saves");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestA = "2ab744ce-ee75-4612-b53b-7a1ab9038011";
  const requestB = "0af1048e-aa83-4266-bd9b-b4777af87b8b";
  const sessionA = viewSession("b5017d4f-badf-458c-ac80-a27f0c38685c", "interaction", "request", requestA, {
    schemaVersion: 1, screen: "interaction", requestId: requestA, currentQuestionId: null, phase: "answer",
  });
  const sessionB = viewSession("df5bc4be-815c-425e-a8ee-15d0001ee926", "interaction", "request", requestB, {
    schemaVersion: 1, screen: "interaction", requestId: requestB, currentQuestionId: null, phase: "answer",
  });
  const interaction = (id: string, digest: string, question: string) => ({ humanRequest: {
    id, type: "manual_input", schemaDigest: digest, inputSpec: { inputType: "text", question },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  } });
  const app = await mountApp(page, "interaction", interaction(requestA, "a".repeat(64), "Request A"), false, false, null, false,
    { "loomex/viewSession": sessionA });
  await waitForPersistenceToolCount(page, "loomex_interaction_draft_get", 1);
  await page.evaluate(() => { window.__persistenceDelayMs = 400; });
  await app.locator("#question-0-value").fill("Alpha");
  await app.getByRole("button", { name: "Review answer", exact: true }).click();
  await waitForPersistenceToolCount(page, "loomex_interaction_draft_update", 1);
  await page.evaluate(({ data, session }: any) => {
    window.__persistenceDelayMs = 0;
    window.__loomexPersistenceStore.sessions[session.viewSessionId] = structuredClone(session);
    document.getElementById("app").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result",
      params: { structuredContent: { ok: true, data }, _meta: { "loomex/viewSession": session } } }, "*");
  }, { data: interaction(requestB, "b".repeat(64), "Request B"), session: sessionB });
  await app.getByText("Request B", { exact: true }).waitFor();
  await waitForPersistenceToolCount(page, "loomex_interaction_draft_get", 2);
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(await app.locator("#question-0-value").inputValue(), "", "the late success cannot restore request A into request B");
  await app.locator("#question-0-value").fill("Beta");
  await app.getByRole("button", { name: "Review answer", exact: true }).click();
  await page.waitForFunction((id: string) => window.__loomexPersistenceStore.drafts[id]?.answers?.answer?.value === "Beta", requestB);
  const updates = (await page.evaluate(() => window.__loomexPersistenceCalls))
    .filter((call: any) => call.name === "loomex_interaction_draft_update");
  assert.deepEqual(updates.map((call: any) => call.arguments.requestId), [requestA, requestB]);
  assert.equal(await page.evaluate((id: string) => window.__loomexPersistenceStore.drafts[id]?.answers?.answer?.value, requestA), "Alpha");
});

test("a late failed draft save cannot mark or retry against the next interaction request", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for isolated interaction draft failures");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestA = "24a0744a-8c06-4ca3-a646-ec78d26df2de";
  const requestB = "b4e8c717-0941-473f-b494-0ed97e3b1dcd";
  const sessionA = viewSession("e4676d1c-f904-48cc-8f2e-2f5a8f71205f", "interaction", "request", requestA, {
    schemaVersion: 1, screen: "interaction", requestId: requestA, currentQuestionId: null, phase: "answer",
  });
  const sessionB = viewSession("27308766-9a14-415d-9353-17ffcc46de5c", "interaction", "request", requestB, {
    schemaVersion: 1, screen: "interaction", requestId: requestB, currentQuestionId: null, phase: "answer",
  });
  const interaction = (id: string, digest: string, question: string) => ({ humanRequest: {
    id, type: "manual_input", schemaDigest: digest, inputSpec: { inputType: "text", question },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  } });
  const app = await mountApp(page, "interaction", interaction(requestA, "a".repeat(64), "Request A"), false, false, null, false,
    { "loomex/viewSession": sessionA });
  await waitForPersistenceToolCount(page, "loomex_interaction_draft_get", 1);
  await page.evaluate(() => {
    window.__persistenceDelayMs = 400;
    window.__failNextPersistenceCall = "loomex_interaction_draft_update";
  });
  await app.locator("#question-0-value").fill("Alpha");
  await app.getByRole("button", { name: "Review answer", exact: true }).click();
  await waitForPersistenceToolCount(page, "loomex_interaction_draft_update", 1);
  await page.evaluate(({ data, session }: any) => {
    window.__persistenceDelayMs = 0;
    window.__loomexPersistenceStore.sessions[session.viewSessionId] = structuredClone(session);
    document.getElementById("app").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result",
      params: { structuredContent: { ok: true, data }, _meta: { "loomex/viewSession": session } } }, "*");
  }, { data: interaction(requestB, "b".repeat(64), "Request B"), session: sessionB });
  await app.getByText("Request B", { exact: true }).waitFor();
  await waitForPersistenceToolCount(page, "loomex_interaction_draft_get", 2);
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.doesNotMatch(await app.locator("#save-status").textContent(), /not saved yet|changes remain here/i,
    "a failure from request A cannot become request B's save error");
  await app.locator("#question-0-value").fill("Beta");
  await app.getByRole("button", { name: "Review answer", exact: true }).click();
  await page.waitForFunction((id: string) => window.__loomexPersistenceStore.drafts[id]?.answers?.answer?.value === "Beta", requestB);
  const updates = (await page.evaluate(() => window.__loomexPersistenceCalls))
    .filter((call: any) => call.name === "loomex_interaction_draft_update");
  assert.deepEqual(updates.map((call: any) => call.arguments.requestId), [requestA, requestB]);
  assert.equal(await page.evaluate((id: string) => window.__loomexPersistenceStore.drafts[id], requestA), undefined);
});

test("closing and reopening interaction and authoring cards restores the exact question, answers, and review phase", { concurrency: false, timeout: 30_000 }, async (t) => {
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
  // Durable hydration performs an exact session read followed by a draft read.
  // Under the full browser suite those two serialized RPC fixtures can exceed
  // the generic five-second UI timeout without indicating a product failure.
  interactionPage.setDefaultTimeout(10_000);
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
  const earlyNext = interaction.getByRole("button", { name: "Next question", exact: true, includeHidden: true });
  // The verified session identity is supplied with this remount, so the shell
  // keeps its skeleton through the delayed authoritative draft read.
  // Its underlying controls also remain disabled.
  assert.equal(await interaction.locator("main").getAttribute("data-restoring"), "true");
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
  assert.deepEqual(await interactionPage.evaluate(() => window.__loomexCalls.map((call: any) => call.name)), ["loomex_interaction_get", "loomex_interaction_get"], "each remount reads its exact request without submitting it");

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
  authoringPage.setDefaultTimeout(10_000);
  let authoring = await mountApp(authoringPage, "authoring", authoringData, false, false, null, false,
    { "loomex/viewSession": authoringSession });
  await waitForPersistenceToolCount(authoringPage, "loomex_view_session_get", 1);
  await authoring.locator("#question-0-value").fill("Build a durable UI");
  await authoring.getByRole("button", { name: "Next question", exact: true }).click();
  await authoring.locator("#question-1-value").fill("Browser tests");
  await authoring.getByRole("button", { name: "Review answers", exact: true }).click();
  await authoring.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
  // Review is local navigation; remount saved state only after autosave lands.
  await authoringPage.waitForFunction((id: string) =>
    window.__loomexPersistenceStore.sessions[id]?.state?.phase === "review", authoringSession.viewSessionId);
  authoring = await mountApp(authoringPage, "authoring", authoringData, false, false, null, false,
    { "loomex/viewSession": authoringSession }, undefined, [], true);
  await waitForPersistenceToolCount(authoringPage, "loomex_view_session_get", 2);
  await authoring.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
  await authoring.getByText("Build a durable UI", { exact: true }).waitFor();
  await authoring.getByText("Browser tests", { exact: true }).waitFor();
  assert.deepEqual(await authoringPage.evaluate(() => window.__loomexCalls), []);
});

test("sequential clarification and acceptance cards keep same question IDs scoped to their request and session", { concurrency: false, timeout: 30_000 }, async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for sequential interaction restoration");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const questionId = "decision";
  const requests = [
    {
      requestId: "9a48f8e8-f6ae-41d4-a6fa-77550a8dce1e",
      sessionId: "26a75e95-6522-4e59-8e2a-c3bc2a410482",
      digest: "a".repeat(64),
      question: "What should the dashboard prioritize?",
      answer: "A concise operational overview",
      presentation: { version: 1, kind: "clarification", stageLabel: "Clarify", question: "What should the dashboard prioritize?" },
    },
    {
      requestId: "18d7c3d0-9b5c-4b94-aabd-b1e1e358f750",
      sessionId: "7dd6ef99-2e1e-4757-a632-d0f8c545d8e3",
      digest: "b".repeat(64),
      question: "Which audience should receive it first?",
      answer: "The operations team",
      presentation: { version: 1, kind: "clarification", stageLabel: "Clarify", question: "Which audience should receive it first?" },
    },
  ];
  const booleanRequest = {
    requestId: "e5a89c59-4a8c-4ca4-b91f-7a5fd63c44c5",
    sessionId: "8f6c6e03-6b51-42ea-bda5-2f77f15189fe",
    digest: "c".repeat(64),
    question: "Does this plan meet your requirements?",
  };
  const requestData = (entry: typeof requests[number]) => ({ humanRequest: {
    id: entry.requestId, status: "pending", type: "manual_input", schemaDigest: entry.digest,
    presentation: entry.presentation,
    inputSpec: { collectionMode: "batch", inputType: "text", question: entry.question, questions: [
      { id: questionId, inputType: "text", question: entry.question },
    ] },
    responseSchema: { type: "object", properties: { answers: { type: "array" } }, required: ["answers"] },
  } });
  const booleanData = { humanRequest: {
    id: booleanRequest.requestId, status: "pending", type: "manual_input", schemaDigest: booleanRequest.digest,
    presentation: { version: 1, kind: "review", stageLabel: "Review", question: booleanRequest.question },
    inputSpec: { collectionMode: "batch", inputType: "boolean", question: booleanRequest.question, questions: [
      { id: questionId, inputType: "boolean", question: booleanRequest.question },
    ] },
    responseSchema: { type: "object", properties: { answers: { type: "array" } }, required: ["answers"] },
  } };
  const sessionFor = (entry: { requestId: string; sessionId: string; digest: string }) => viewSession(
    entry.sessionId, "interaction", "request", entry.requestId,
    { schemaVersion: 1, screen: "interaction", requestId: entry.requestId, schemaDigest: entry.digest, currentQuestionId: questionId, phase: "answer" },
  );
  let app: any;
  let draftReads = 0;
  const saveAndReopenText = async (entry: typeof requests[number]) => {
    const session = sessionFor(entry);
    app = await mountApp(page, "interaction", requestData(entry), false, false, null, false, { "loomex/viewSession": session }, undefined, [], draftReads > 0);
    draftReads += 1;
    await waitForPersistenceToolCount(page, "loomex_interaction_draft_get", draftReads);
    await app.locator("#question-0-value").fill(entry.answer);
    await app.getByRole("button", { name: /^Review answers?$/ }).click();
    await app.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
    await page.waitForFunction(({ requestId, answer }: any) => {
      const draft = window.__loomexPersistenceStore.drafts[requestId];
      return draft?.phase === "review" && draft.answers?.["decision"]?.value === answer;
    }, { requestId: entry.requestId, answer: entry.answer });

    app = await mountApp(page, "interaction", requestData(entry), false, false, null, false, { "loomex/viewSession": session }, undefined, [], true);
    draftReads += 1;
    await waitForPersistenceToolCount(page, "loomex_interaction_draft_get", draftReads);
    await app.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
    await app.getByText(entry.answer, { exact: true }).waitFor();
  };

  for (const clarification of requests) await saveAndReopenText(clarification);

  const booleanSession = sessionFor(booleanRequest);
  app = await mountApp(page, "interaction", booleanData, false, false, null, false, { "loomex/viewSession": booleanSession }, undefined, [], true);
  draftReads += 1;
  await waitForPersistenceToolCount(page, "loomex_interaction_draft_get", draftReads);
  await app.getByRole("radio", { name: "Accept", exact: true }).check();
  await app.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
  await page.waitForFunction((requestId: string) => {
    const draft = window.__loomexPersistenceStore.drafts[requestId];
    return draft?.phase === "review" && draft.answers?.decision?.value === true;
  }, booleanRequest.requestId);
  app = await mountApp(page, "interaction", booleanData, false, false, null, false,
    { "loomex/viewSession": booleanSession }, undefined, [], true);
  draftReads += 1;
  await waitForPersistenceToolCount(page, "loomex_interaction_draft_get", draftReads);
  await app.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
  await app.getByLabel("Answer preview", { exact: true }).getByText("Accept", { exact: true }).waitFor();

  const savedDrafts = await page.evaluate((requestIds: string[]) => Object.fromEntries(requestIds.map((requestId) => [requestId, window.__loomexPersistenceStore.drafts[requestId]])), [
    ...requests.map((entry) => entry.requestId), booleanRequest.requestId,
  ]);
  assert.deepEqual(Object.fromEntries(requests.map((entry) => [entry.requestId, savedDrafts[entry.requestId].answers.decision.value])), {
    [requests[0]!.requestId]: requests[0]!.answer,
    [requests[1]!.requestId]: requests[1]!.answer,
  });
  assert.equal(savedDrafts[booleanRequest.requestId].answers.decision.value, true);
  assert.ok(Object.values(savedDrafts).every((draft: any) => draft.phase === "review"));
  assert.equal(await page.evaluate(() => window.__loomexCalls.some((call: any) =>
    ["loomex_interaction_respond", "loomex_interaction_decide"].includes(call.name))), false,
    "saving and reopening sequential cards must never answer or approve them");
});

test("reopening a resolved interaction renders its submitted answer as read-only", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for resolved interaction reopening");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = "a61b5f1b-2d2e-46c4-9cc8-748c2c6f907c";
  const runId = "a0c0c5f8-1f46-47f0-9b6a-f6e7a7faac28";
  const app = await mountApp(page, "interaction", { humanRequest: {
    id: requestId, status: "resolved", type: "manual_input", execution: { id: runId },
    schemaDigest: "a".repeat(64), title: "Resolved request", answer: { value: "Already submitted" },
    inputSpec: { inputType: "text", question: "Release name" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  } });
  await app.getByRole("heading", { name: "Submitted answers", exact: true }).waitFor();
  await app.getByText("Already submitted", { exact: true }).waitFor();
  assert.equal(await app.getByRole("heading", { name: "Answer preview", exact: true }).count(), 0);
  assert.equal(await app.getByRole("textbox", { name: "Release name Your answer" }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Submit answer", exact: true }).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), [], "reopening a resolved request is read-only");
});

test("an expired presentation session exposes one safe re-entry without writes or editable controls", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for presentation re-entry");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = "f69e6207-55b3-4a3e-b486-00be1cec5267";
  const app = await mountApp(page, "interaction", { humanRequest: {
    id: requestId, status: "pending", type: "manual_input", schemaDigest: "a".repeat(64),
    inputSpec: { inputType: "text", question: "Release name" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  } }, false, false, null, false, { "loomex/viewPersistence": {
    status: "reentry", code: "VIEW_SESSION_NOT_FOUND", message: "View session not found", retryable: false,
  } });
  await app.getByText(/View session not found.*Refresh this card/i).waitFor();
  assert.equal(await app.getByRole("button", { name: "Refresh", exact: true }).isEnabled(), true);
  assert.equal(await app.getByRole("button", { name: "Review answer", exact: true }).isDisabled(), true);
  assert.equal(await app.locator("#question-0-value").isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.__loomexPersistenceCalls), []);
});

test("a resolved interaction remount re-reads authoritative status before showing its read-only card", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for resolved remount reconciliation");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = "36a9df53-e29c-4c7e-ae9b-6dfd8d0ad35a";
  const runId = "e725b98e-8b4d-4dc9-b70f-cd89a8d7bd09";
  const resolved = {
    id: requestId, status: "resolved", type: "manual_input", execution: { id: runId },
    schemaDigest: "a".repeat(64), answer: { value: "Authoritative answer" },
    inputSpec: { inputType: "text", question: "Release name" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  };
  const session = { ...viewSession("d75e0b9d-8f40-4e6c-b4f9-70a5ae336d98", "interaction", "request", requestId, {}), status: "resolved" };
  const app = await mountApp(page, "interaction", {
    humanRequest: { ...resolved, status: "pending", answer: undefined },
  }, false, false, null, false, { "loomex/viewSession": session }, { message: { text: {} }, updateModelContext: { text: {} } }, [
    { structuredContent: { ok: true, data: { humanRequest: resolved } } },
  ]);
  await app.getByRole("heading", { name: "Submitted answers", exact: true }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls)).map((call: any) => call.name), ["loomex_interaction_get"]);
  assert.equal(await app.getByRole("textbox", { name: "Release name Your answer" }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Submit answer", exact: true }).count(), 0);
  await page.waitForFunction((id: string) => window.__loomexPersistenceStore.sessions[id]?.status === "resolved", session.viewSessionId);
});

test("refreshing a stale pending interaction reads its exact request once and becomes read-only", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for stale interaction reconciliation");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = "47f5f9a3-88d9-46cb-ae42-f8d0a83b0dc8";
  const runId = "5d2a13e0-4518-46c3-bd95-0fe455f0960a";
  const app = await mountApp(page, "interaction", { humanRequest: {
    id: requestId, status: "pending", type: "manual_input", execution: { id: runId },
    schemaDigest: "a".repeat(64), title: "Stale request A",
    inputSpec: { inputType: "text", question: "Answer request A" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  } }, false, true);
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await app.getByRole("heading", { name: "Submitted answers", exact: true }).waitFor();
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_interaction_get"]);
  assert.deepEqual(calls[0].arguments, { requestId });
  assert.equal(await app.getByRole("button", { name: "Submit answer", exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.__loomexMessages.length), 0);
  assert.equal(await page.evaluate(() => window.__loomexModelContexts.length), 0);
});

test("interaction_view tool input rehydrates only its bound stale request", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for interaction_view rehydration");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = "f26e6f4a-0998-42d3-a7e8-12b39d9f0c0a";
  const viewSessionId = "2cd145a5-0f9d-4b40-bc3a-4b4d17f8afc5";
  const stale = { humanRequest: { id: requestId, status: "pending", type: "manual_input", schemaDigest: "a".repeat(64),
    inputSpec: { inputType: "text", question: "Stale request A" }, responseSchema: { type: "object", properties: { value: { type: "string" } } } } };
  const session = viewSession(viewSessionId, "interaction", "request", requestId, { schemaVersion: 1, screen: "interaction", requestId, phase: "answer" });
  const app = await mountApp(page, "interaction", stale, false, true, null, false, { "loomex/viewSession": session });
  await page.evaluate(({ requestId, viewSessionId, stale, session }: any) => {
    const frame = document.getElementById("app");
    frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input",
      params: { name: "loomex_interaction_view", arguments: { requestId, viewSessionId } } }, "*");
    frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result",
      params: { structuredContent: { ok: true, data: stale }, _meta: { "loomex/viewSession": session } } }, "*");
  }, { requestId, viewSessionId, stale, session });
  await waitForToolCount(page, "loomex_interaction_get", 1);
  await app.getByRole("heading", { name: "Submitted answers", exact: true }).waitFor();
  const calls = await page.evaluate(() => window.__loomexCalls.filter((call: any) => call.name === "loomex_interaction_get"));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].arguments, { requestId });
  assert.equal(await app.getByRole("button", { name: "Submit answer", exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.__loomexMessages.length), 0);

  const mismatchPage = await browser.newPage();
  const requestB = "4cd5f7bf-f31e-4e5c-9a7f-61f16742c4d6";
  const sessionB = viewSession("8dcb4f49-0200-4c58-a12e-0a80bfc5f9d1", "interaction", "request", requestB, {});
  const mismatch = await mountApp(mismatchPage, "interaction", { humanRequest: { id: requestB, status: "pending", type: "manual_input",
    inputSpec: { inputType: "text", question: "Request B" } } }, false, false, null, false, { "loomex/viewSession": sessionB });
  await mismatchPage.evaluate(({ requestId, viewSessionId, requestB, sessionB }: any) => {
    const frame = document.getElementById("app");
    frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input",
      params: { name: "loomex_interaction_view", arguments: { requestId, viewSessionId } } }, "*");
    frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result",
      params: { structuredContent: { ok: true, data: { humanRequest: { id: requestB, status: "pending", type: "manual_input",
        inputSpec: { inputType: "text", question: "Request B" } } } }, _meta: { "loomex/viewSession": sessionB } } }, "*");
  }, { requestId, viewSessionId: sessionB.viewSessionId, requestB, sessionB });
  await mismatch.locator('#summary[role="alert"]').waitFor();
  assert.match(await mismatch.locator("#summary").textContent(), /does not match this saved interaction view/i);
  assert.equal((await mismatchPage.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_interaction_get").length, 0);
  assert.equal(await mismatch.getByText("Stale request A", { exact: true }).count(), 0);
});

test("delayed and failed review persistence retains answers and exposes an actionable save error", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for review persistence behavior");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = "31fb88b6-3065-49b0-9f65-a794b9bb7b0f";
  const request = {
    id: requestId, type: "manual_input", schemaDigest: "a".repeat(64),
    inputSpec: { collectionMode: "batch", inputType: "text", question: "Contact", questions: [
      { id: "first", inputType: "text", question: "First name" },
      { id: "last", inputType: "text", question: "Last name" },
    ] },
    responseSchema: { type: "object", properties: { answers: { type: "array" } }, required: ["answers"] },
  };
  const session = viewSession("d4fd3f56-e4d8-4d20-86a6-ea1826e2ba0a", "interaction", "request", requestId, {
    schemaVersion: 1, screen: "interaction", disclosures: {}, requestId, currentQuestionId: "first", phase: "answer",
  });
  const app = await mountApp(page, "interaction", { humanRequest: request }, false, false, null, false, { "loomex/viewSession": session });
  await waitForPersistenceToolCount(page, "loomex_interaction_draft_get", 1);
  await app.locator("#question-0-value").fill("Ada");
  await app.getByRole("button", { name: "Next question", exact: true }).click();
  await app.getByText("Question 2 of 2", { exact: true }).waitFor();
  await app.locator("#question-1-value").fill("Lovelace");
  await page.waitForFunction((id: string) => window.__loomexPersistenceStore.drafts[id]?.answers?.last?.value === "Lovelace", requestId);
  await app.locator("#question-1-value").fill("Byron");
  await page.waitForFunction((id: string) => window.__loomexPersistenceStore.drafts[id]?.answers?.last?.value === "Byron", requestId);
  await page.evaluate(() => { window.__persistenceDelayMs = 0; window.__blockedPersistenceTools = ["loomex_interaction_draft_update", "loomex_view_session_update"]; });
  await app.getByRole("button", { name: "Review answers", exact: true }).click();
  await page.waitForFunction(() => /not saved yet|changes remain here/i.test(
    document.getElementById("app")?.contentDocument?.getElementById("save-status")?.textContent || "",
  ));
  assert.match(await app.locator("#save-status").textContent(), /not saved yet|changes remain here/i);
  await app.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
  assert.equal(await app.locator("#question-1-value").inputValue(), "Byron", "a failed review save keeps the edited answer in place");
  assert.equal(await app.getByRole("heading", { name: "Answer preview", exact: true }).count(), 1,
    "local review remains usable while storage is unavailable");
  await app.getByRole("button", { name: "Submit answers", exact: true }).click();
  await app.getByText("Your answers could not be saved. Save them before submitting.", { exact: true }).waitFor();
  assert.equal(await app.getByRole("heading", { name: "Sent to chat", exact: true }).count(), 0, "a failed save must not claim that the answer was sent");
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), []);
});

test("persistence failure during Back keeps the local answer navigable and never responds", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for Back persistence behavior");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = "a42d94fc-d70d-4e49-ae51-91cd0b3bd5fb";
  const request = { id: requestId, type: "manual_input", schemaDigest: "a".repeat(64),
    inputSpec: { collectionMode: "batch", inputType: "text", question: "Names", questions: [
      { id: "first", inputType: "text", question: "First name" },
      { id: "last", inputType: "text", question: "Last name" },
    ] }, responseSchema: { type: "object", properties: { answers: { type: "array" } }, required: ["answers"] } };
  const app = await mountApp(page, "interaction", { humanRequest: request });
  await app.locator("#question-0-value").fill("Ada");
  await app.getByRole("button", { name: "Next question", exact: true }).click();
  await app.getByText("Question 2 of 2", { exact: true }).waitFor();
  await app.locator("#question-1-value").fill("Lovelace");
  await page.evaluate(() => { window.__failNextPersistenceCall = "loomex_interaction_draft_update"; });
  await app.getByRole("button", { name: "Previous question", exact: true }).click();
  await app.getByText("Question 1 of 2", { exact: true }).waitFor();
  assert.equal(await app.locator("#question-0-value").inputValue(), "Ada");
  await app.getByRole("button", { name: "Next question", exact: true }).click();
  await app.getByText("Question 2 of 2", { exact: true }).waitFor();
  assert.equal(await app.locator("#question-1-value").inputValue(), "Lovelace");
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), []);
});

test("approval presentation labels do not change the explicit approve decision", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for approval action mapping");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = "b5df9c00-66d2-45a8-a0b3-9457ea5c2f31";
  const app = await mountApp(page, "interaction", { humanRequest: {
    id: requestId, status: "pending", type: "approval", title: "Authorize this release?",
    prompt: "The release is ready for production.",
  } });
  await app.getByText("Authorize this release?", { exact: true }).waitFor();
  await app.getByRole("button", { name: "Approve", exact: true }).click();
  await waitForCallCount(page, 1);
  const [call] = await page.evaluate(() => window.__loomexCalls);
  assert.equal(call.name, "loomex_interaction_decide");
  assert.equal(call.arguments.requestId, requestId);
  assert.equal(call.arguments.decision, "approve");
  assert.equal(typeof call.arguments.idempotencyKey, "string");
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
  const continuation = followContinuationDetails(runId);
  await page.evaluate(({ requestId, runId, conflictingRunId, continuation }: any) => { window.__workflowResponses = [
    { structuredContent: { ok: true, data: { humanRequest: {
      id: requestId, status: "resolved", execution: { id: conflictingRunId }, answer: { value: "Submitted once" },
    } } } },
    { structuredContent: { ok: true, data: { humanRequest: {
      id: requestId, status: "resolved", execution: { id: runId }, answer: { value: "Submitted once" },
    }, ...continuation } } },
  ]; }, { requestId, runId, conflictingRunId, continuation });
  await app.getByRole("button", { name: "Refresh" }).click();
  await waitForCallCount(page, 2);
  await app.getByText("server still reports this request as pending", { exact: false }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Retry exact response", exact: true }).isEnabled(), true);
  assert.deepEqual(await page.evaluate(() => window.__loomexModelContexts), []);
  assert.deepEqual(await page.evaluate(() => window.__loomexMessages), []);
  await app.getByRole("button", { name: "Refresh" }).click();
  await waitForCallCount(page, 3);
  await waitForHandoff(page);
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
  assert.deepEqual(parseFollowContextMarkdown(context.content[0].text), {
    schema: "loomex/chat-continuation/v2",
    intent: "monitor_existing_run",
    runId,
    trigger: "interaction_accepted",
    acceptedInteraction: { requestId, status: "resolved" },
    followContinuation: expectedFollowContinuation(runId),
    state: "requires_fresh_read",
  });
  assert.ok(message.content[0].text.startsWith(expectedFollowMarkdown(runId)));
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
    // Reopening first reads the authoritative request, before any retry.
    { structuredContent: { ok: true, data } },
    { structuredContent: { ok: true, data: { requestId, requestStatus: "resolved", executionId: runId, executionStatus: "running", error: null, ...followContinuationDetails(runId) } } },
  ], true);
  await waitForPersistenceToolCount(page, "loomex_view_operation_get", 1);
  await waitForPersistenceToolCount(page, "loomex_interaction_draft_get", 2);
  await app.getByRole("button", { name: "Retry exact response", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__loomexCalls.filter((call: any) => call.name === "loomex_interaction_respond").length), 1, "opening the replacement card performs no response mutation");
  assert.equal(await app.locator("#question-0-value").inputValue(), "Loomex Durable");
  assert.equal(await app.locator("#question-0-value").isDisabled(), true, "the exact restored response remains locked");
  await app.getByRole("button", { name: "Retry exact response", exact: true }).click();
  await waitForToolCount(page, "loomex_interaction_respond", 2);
  const responses = (await page.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_interaction_respond");
  assert.deepEqual(responses[1].arguments, original.arguments);
  await waitForHandoff(page);
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

  const continuation = followContinuationDetails(runId);
  await page.evaluate(({ requestId, runId, continuation }: any) => {
    window.__workflowResponses = [{ structuredContent: { ok: true, data: {
      requestId, requestStatus: "approved", executionId: runId, error: null, ...continuation,
    } } }];
  }, { requestId, runId, continuation });
  await app.getByRole("button", { name: "Retry exact approval" }).click();
  await waitForCallCount(page, 2);
  await waitForHandoff(page);
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), ["loomex_interaction_decide", "loomex_interaction_decide"]);
  assert.deepEqual(calls[0].arguments, calls[1].arguments);
  assert.equal(calls[0].arguments.requestId, requestId);
  assert.equal(calls[0].arguments.decision, "approve");
  await waitForHandoff(page);
  const { context, message } = await handoffAt(page);
  assert.deepEqual(parseFollowContextMarkdown(context.content[0].text), {
    schema: "loomex/chat-continuation/v2",
    intent: "monitor_existing_run",
    runId,
    trigger: "interaction_accepted",
    acceptedInteraction: { requestId, status: "approved" },
    followContinuation: expectedFollowContinuation(runId),
    state: "requires_fresh_read",
  });
  assert.ok(message.content[0].text.startsWith(expectedFollowMarkdown(runId)));
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
  assert.match(message.content[0].text, new RegExp(`Loomex interaction ${requestId} using loomex_interaction_get`, "i"));
  assert.match(message.content[0].text, /Ask its verified long-answer question directly in chat/i);
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
  await reviewPage.evaluate((requestId: string) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: {
    requestId, requestStatus: "resolved", error: null,
  } } }]; }, "39f69fd1-e9ca-4700-8c31-0fa7fc009517");
  await reviewAndSubmit(app);
  await waitForCallCount(reviewPage, 1);
  const [call] = await reviewPage.evaluate(() => window.__loomexCalls);
  assert.equal(call.name, "loomex_interaction_respond");
  assert.deepEqual(call.arguments.answer, { value: false });
  assert.equal(await reviewPage.evaluate(() => window.__loomexCalls.some((entry: any) => entry.name === "loomex_interaction_decide")), false,
    "a boolean implementation review is a response, never an approval decision");
  await app.getByRole("heading", { name: "Submitted answers", exact: true }).waitFor();
  await app.getByRole("heading", { name: "Submitted answers", exact: true }).waitFor();
  await app.getByText("Request changes", { exact: true }).waitFor();
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

test("run cards are read-only summaries without execution references or controls", async (t) => {
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
  assert.equal(await app.getByText("Execution references", { exact: true }).count(), 0);

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
  await active.getByText("This run is active. Its current summary is shown here.", { exact: true }).waitFor();
  await activePage.waitForTimeout(200);
  assert.deepEqual(await activePage.evaluate(() => window.__loomexCalls), []);
  for (const action of ["Cancel run", "Retry exact cancellation", "Follow in chat", "Retry chat handoff"]) {
    assert.equal(await active.getByRole("button", { name: action, exact: true }).count(), 0, `${action} is not available on a run card`);
  }
  assert.equal(await active.locator("#cancellation-details").count(), 0);
  assert.equal(await active.getByRole("textbox", { name: "Cancellation reason", exact: true }).count(), 0);
  assert.equal(await active.getByText("Execution references", { exact: true }).count(), 0);

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

test("reopened run cards keep the workflow summary read-only", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for durable run results");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());

  const activeRunId = "77211811-a1e7-443f-83f0-8a96ce0021ab";
  const activeData = { execution: { id: activeRunId, status: "running", workflowName: "Durable monitor" } };
  const activeSession = viewSession("5638f24c-ee12-4e9d-8b8d-ecdb8193c60d", "monitor", "execution", activeRunId, {
    schemaVersion: 1, screen: "monitor", disclosures: {}, executionId: activeRunId, latestSequence: null,
    currentRequestId: null,
  });
  const activePage = await browser.newPage();
  let app = await mountApp(activePage, "monitor", activeData, false, false, null, false, { "loomex/viewSession": activeSession });
  await waitForPersistenceToolCount(activePage, "loomex_view_session_get", 1);
  app = await mountApp(activePage, "monitor", activeData, false, false, null, false, { "loomex/viewSession": activeSession }, undefined, [], true);
  await waitForPersistenceToolCount(activePage, "loomex_view_session_get", 2);
  assert.equal(await app.locator("#cancellation-details").count(), 0);
  assert.equal(await app.getByRole("button", { name: "Follow in chat", exact: true }).count(), 0);
  assert.equal(await app.getByText("Execution references", { exact: true }).count(), 0);
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
  app = await mountApp(completedPage, "monitor", completedData, false, false, null, false, { "loomex/viewSession": completedSession }, undefined, [], true);
  await waitForPersistenceToolCount(completedPage, "loomex_view_session_get", 2);
  assert.equal(await app.getByText("Execution references", { exact: true }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Cancel run", exact: true }).count(), 0);
  await app.getByText("The durable result is ready.", { exact: true }).waitFor();
  assert.deepEqual(await completedPage.evaluate(() => window.__loomexCalls), [
    { name: "loomex_run_get", arguments: { runId: completedRunId } },
  ], "a resolved monitor remount verifies the authoritative run state once");
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

test("active monitor never polls or sends a second chat handoff", async (t) => {
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
  assert.equal(await app.getByRole("button", { name: "Follow in chat", exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.__loomexModelContexts.length), 0);
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
  const continuation = followContinuationDetails(runId);
  await page.evaluate(({ requestId, runId, continuation }: any) => {
    window.__failNextUiMessage = true;
    window.__workflowResponses = [{ structuredContent: { ok: true, data: {
      requestId, requestStatus: "resolved", executionId: runId, executionStatus: "running", error: null, ...continuation,
    } } }];
  }, { requestId, runId, continuation });
  await app.getByRole("textbox", { name: "Name the deliverable Your answer" }).fill("Release brief");
  await reviewAndSubmit(app);
  await app.getByRole("button", { name: "Continue in chat", exact: true }).waitFor();
  await app.getByRole("heading", { name: "Submitted answers", exact: true }).waitFor();
  await app.getByText("Release brief", { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.__loomexCalls)).length, 1);
  assert.equal((await page.evaluate(() => window.__loomexCalls))[0].name, "loomex_interaction_respond");
  assert.equal(await app.getByRole("button", { name: "Retry exact response" }).count(), 0);
  await app.getByText("Chat instructions", {exact:true}).click();
  await app.locator("[data-delivery-recovery] pre").waitFor();
  await page.evaluate((runId:string)=>{window.__workflowResponses=[{structuredContent:{ok:true,data:{execution:{id:runId,status:"running"}}}}];},runId);
  await app.getByRole("button", { name: "Continue in chat", exact: true }).click();
  assert.equal((await page.evaluate(() => window.__loomexCalls)).filter((call:any)=>call.name==="loomex_interaction_respond").length, 1, "handoff retry cannot repeat the accepted response");
  await waitForHandoff(page, 2);
  assert.equal(await app.getByText("Sent to chat", { exact: true }).count(), 0, "accepted responses do not render a duplicate success card");
  assert.equal(await app.getByRole("heading", { name: "Submitted answers", exact: true }).count(), 1, "the accepted answer remains a single card");
  const firstHandoff = await handoffAt(page, 0);
  const retryHandoff = await handoffAt(page, 1);
  const firstContext = parseFollowContextMarkdown(firstHandoff.context.content[0].text);
  const retryContext = parseFollowContextMarkdown(retryHandoff.context.content[0].text);
  assert.deepEqual(firstContext, {
    schema: "loomex/chat-continuation/v2",
    intent: "monitor_existing_run",
    runId,
    trigger: "interaction_accepted",
    acceptedInteraction: { requestId, status: "resolved" },
    followContinuation: expectedFollowContinuation(runId),
    state: "requires_fresh_read",
  });
  assert.deepEqual(retryContext, firstContext, "failed handoff retry must retain the original accepted receipt and context");
  assert.equal(retryHandoff.message.content[0].text, firstHandoff.message.content[0].text, "failed handoff retry must retain the original chat command");
  assert.ok(retryHandoff.message.content[0].text.startsWith(expectedFollowMarkdown(runId)));
  assert.doesNotMatch(retryHandoff.message.content[0].text, /Release brief|Name the deliverable/);
});

test("accepted answers advance presentation state without saving during the delivery journal path", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for accepted-answer delivery");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = randomUUID(), runId = randomUUID(), sessionId = randomUUID();
  const session = viewSession(sessionId, "interaction", "request", requestId);
  const request = {
    id: requestId, status: "pending", type: "manual_input", execution: { id: runId }, schemaDigest: "a".repeat(64),
    inputSpec: { inputType: "text", question: "Release name" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  };
  const app = await mountApp(page, "interaction", { humanRequest: request }, false, false, null, false, { "loomex/viewSession": session });
  await app.getByRole("textbox", { name: "Release name Your answer" }).fill("September release");
  await app.getByRole("button", { name: "Review answer", exact: true }).click();
  await app.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
  const revisionBeforeAcceptance = await page.evaluate((id: string) => window.__loomexPersistenceStore.sessions[id].revision, sessionId);
  const continuation = followContinuationDetails(runId);
  await page.evaluate(({ requestId, runId, continuation }: any) => {
    window.__workflowResponses = [{ structuredContent: { ok: true, data: {
      requestId, requestStatus: "resolved", executionId: runId, error: null, ...continuation,
    } } }];
  }, { requestId, runId, continuation });
  await app.getByRole("button", { name: "Submit answer", exact: true }).click();
  await waitForPersistenceToolCount(page, "loomex_delivery_settle", 1);
  await page.waitForFunction(({ id, previous }: any) => window.__loomexPersistenceStore.sessions[id].revision > previous,
    { id: sessionId, previous: revisionBeforeAcceptance });
  await waitForHandoff(page);

  const persistenceCalls = await page.evaluate(() => window.__loomexPersistenceCalls.map((call: any) => call.name));
  const deliveryStart = persistenceCalls.indexOf("loomex_delivery_get");
  const deliveryEnd = persistenceCalls.indexOf("loomex_delivery_settle", deliveryStart);
  assert.ok(deliveryStart >= 0 && deliveryEnd >= deliveryStart);
  assert.equal(persistenceCalls.slice(deliveryStart, deliveryEnd + 1).some((name: string) => name === "loomex_view_session_update"), false,
    "delivery durability must not take a presentation save on its critical path");
  assert.equal((await page.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_interaction_respond").length, 1);
});

test("known-unsent delivery recovery continues chat without replaying an accepted answer", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for delivery recovery");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = randomUUID(), runId = randomUUID();
  const request = {
    id: requestId, status: "pending", type: "manual_input", execution: { id: runId }, schemaDigest: "a".repeat(64),
    inputSpec: { inputType: "text", question: "Deployment note" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  };
  const app = await mountApp(page, "interaction", { humanRequest: request });
  const continuation = followContinuationDetails(runId);
  await page.evaluate(({ requestId, runId, continuation }: any) => {
    window.__failNextPersistenceCall = "loomex_delivery_get";
    window.__workflowResponses = [{ structuredContent: { ok: true, data: {
      requestId, requestStatus: "resolved", executionId: runId, error: null, ...continuation,
    } } }];
  }, { requestId, runId, continuation });
  await app.getByRole("textbox", { name: "Deployment note Your answer" }).fill("Approved for deploy");
  await reviewAndSubmit(app);
  await app.getByText("Your action was accepted, but chat continuation has not been sent.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__loomexMessages.length), 0);
  assert.equal((await page.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_interaction_respond").length, 1);
  await app.getByRole("button", { name: "Continue in chat", exact: true }).click();
  await waitForHandoff(page);
  assert.equal((await page.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_interaction_respond").length, 1);
});

test("a host timeout leaves delivery unknown without replaying the accepted answer", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for host-timeout delivery");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.clock.install();
  const requestId = randomUUID(), runId = randomUUID();
  const request = {
    id: requestId, status: "pending", type: "manual_input", execution: { id: runId }, schemaDigest: "a".repeat(64),
    inputSpec: { inputType: "text", question: "Timeout note" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  };
  const app = await mountApp(page, "interaction", { humanRequest: request });
  const continuation = followContinuationDetails(runId);
  await page.evaluate(({ requestId, runId, continuation }: any) => {
    window.__dropNextUiMessageResponse = true;
    window.__workflowResponses = [{ structuredContent: { ok: true, data: {
      requestId, requestStatus: "resolved", executionId: runId, error: null, ...continuation,
    } } }];
  }, { requestId, runId, continuation });
  await app.getByRole("textbox", { name: "Timeout note Your answer" }).fill("Wait for host");
  await reviewAndSubmit(app);
  await waitForPersistenceToolCount(page, "loomex_delivery_begin", 1);
  await page.clock.fastForward(120_000);
  await waitForPersistenceToolCount(page, "loomex_delivery_settle", 1);
  await app.getByText("Chat delivery could not be confirmed.", { exact: false }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Continue in chat", exact: true }).count(), 0);
  assert.equal((await page.evaluate(() => window.__loomexCalls)).filter((call: any) => call.name === "loomex_interaction_respond").length, 1);
  assert.equal(await page.evaluate(() => window.__loomexMessages.length), 1);
});

test("runner-issued continuation receipts produce canonical Markdown for automatic and manual handoff", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for continuation formatting");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const runId = "f53b8cc1-0f2f-4d64-a7b8-a6d46ec88f78";
  const requestId = "a9b55ad8-5fbd-4f1a-a080-2026549b8a98";
  const receipt = "A".repeat(16);
  const request = { id: requestId, status: "pending", type: "manual_input", execution: { id: runId },
    schemaDigest: "a".repeat(64), inputSpec: { inputType: "text", question: "Name the deliverable" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  const accepted = { requestId, requestStatus: "resolved", executionId: runId, error: null,
    details: { followContinuation: { schemaVersion: "loomex-runs-follow-existing-run-continuation/v2", source: "generated_markdown", runId, receipt } } };
  const app = await mountApp(page, "interaction", { humanRequest: request }, false, false, null, false, undefined,
    { message: { text: {} }, updateModelContext: { text: {} } }, [{ structuredContent: { ok: true, data: accepted } }]);
  await app.getByRole("textbox", { name: "Name the deliverable Your answer" }).fill("Release brief");
  await reviewAndSubmit(app);
  await waitForHandoff(page);
  const handoff = await handoffAt(page);
  const expected = expectedFollowMarkdown(runId, receipt);
  assert.ok(handoff.message.content[0].text.startsWith(expected));
  assert.deepEqual(parseFollowContextMarkdown(handoff.context.content[0].text).followContinuation, {
    schemaVersion: "loomex-runs-follow-existing-run-continuation/v2", source: "generated_markdown", runId, receipt,
  });
  assert.equal(await app.getByLabel("Read-only resume command").count(), 0);

  const manualPage = await browser.newPage();
  const manual = await mountApp(manualPage, "interaction", { humanRequest: request }, false, false, null, false,
    undefined, null, [], false);
  await manualPage.evaluate((value: any) => { window.__workflowResponses = [{ structuredContent: { ok: true, data: value } }]; }, accepted);
  await manual.getByRole("textbox", { name: "Name the deliverable Your answer" }).fill("Release brief");
  await reviewAndSubmit(manual);
  await manual.getByText("Chat instructions", {exact:true}).click();
  await manual.getByLabel("Read-only resume command").waitFor();
  assert.equal(await manual.getByLabel("Read-only resume command").textContent(), handoff.message.content[0].text);
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
  const continuation = followContinuationDetails(runId);
  await page.evaluate(({ requestId, wrongRequestId, runId, continuation }: any) => {
    window.__workflowResponses = [
      { structuredContent: { ok: true, data: { requestId: wrongRequestId, requestStatus: "resolved", executionId: runId, error: null } } },
      { structuredContent: { ok: true, data: { requestId, requestStatus: "pending", executionId: runId, error: null } } },
      { structuredContent: { ok: true, data: { requestId, requestStatus: "resolved", executionId: runId, error: { code: "NOT_ACCEPTED" } } } },
      { structuredContent: { ok: true, data: { requestId, requestStatus: "resolved", executionId: runId, executionStatus: "running", error: null, ...continuation } } },
    ];
  }, { requestId, wrongRequestId, runId, continuation });

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
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.deepEqual(calls.map((call: any) => call.name), Array(4).fill("loomex_interaction_respond"));
  assert.ok(calls.every((call: any) => JSON.stringify(call.arguments) === JSON.stringify(calls[0].arguments)), "every retry must keep the reviewed answer and operation ID");
  assert.deepEqual(calls[0].arguments.answer, { value: "Loomex 0.3" });
  await waitForHandoff(page);
  const { context, message } = await handoffAt(page);
  assert.deepEqual(parseFollowContextMarkdown(context.content[0].text), {
    schema: "loomex/chat-continuation/v2",
    intent: "monitor_existing_run",
    runId,
    trigger: "interaction_accepted",
    acceptedInteraction: { requestId, status: "resolved" },
    followContinuation: expectedFollowContinuation(runId),
    state: "requires_fresh_read",
  });
  assert.ok(message.content[0].text.startsWith(expectedFollowMarkdown(runId)));
  assert.doesNotMatch(message.content[0].text, /Loomex 0\.3|Name the release/);
  assert.doesNotMatch(context.content[0].text, /Loomex 0\.3|Name the release/);
  assert.notEqual(context.content[0].text, message.content[0].text);

  const manualPage = await browser.newPage();
  const manual = await mountApp(manualPage, "interaction", { humanRequest: request }, false, false, null, false, undefined, null);
  await manualPage.evaluate(({ requestId, runId, continuation }: any) => {
    window.__workflowResponses = [{ structuredContent: { ok: true, data: {
      requestId, requestStatus: "resolved", executionId: runId, error: null, ...continuation,
    } } }];
  }, { requestId, runId, continuation });
  await manual.getByRole("textbox", { name: "Name the release Your answer" }).fill("Manual release");
  await reviewAndSubmit(manual);
  await manual.getByText("Chat instructions", {exact:true}).click();
  await manual.getByLabel("Read-only resume command").waitFor();
  const manualCommand = await manual.getByLabel("Read-only resume command").textContent();
  assert.ok(manualCommand?.startsWith(expectedFollowMarkdown(runId)));
  assert.doesNotMatch(manualCommand || "", /Manual release|Name the release/);
  assert.equal(manualCommand, message.content[0].text, "manual copy and automatic handoff share one Markdown formatter");
  assert.doesNotMatch(manualCommand || "", /Drain required event pages|same-task recovery|serial 30-second waits/);
  assert.equal(await manualPage.evaluate(() => window.__loomexMessages.length), 0);
  assert.equal(await manualPage.evaluate(() => window.__loomexModelContexts.length), 0);
  await manualPage.close();
});

test("run summaries do not expose chat controls when host chat is unavailable", async (t) => {
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
    await app.getByText("This run is active. Its current summary is shown here.", { exact: true }).waitFor();
    assert.equal(await app.getByRole("button", { name: "Follow in chat", exact: true }).count(), 0);
    assert.equal(await app.getByLabel("Read-only resume command").count(), 0);
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
      inputs: { title: "Quarterly report", includeCharts: false, nested: { secret: "hidden-input" } }, providerConfiguration: { requested: { codex: {
        model: "chosen-model", credentials: { value: "hidden-provider" }, apiToken: "hidden-token",
        apiKey: "hidden-api-key", api_key: "hidden-api-key-underscore", password: "hidden-password",
        privateKey: "hidden-private-key", accessKey: "hidden-access-key",
      } } } },
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
  assert.doesNotMatch(await app.locator("body").innerText(), /never-display-this|bindingDigest|Technical details|hidden-input|hidden-provider|hidden-token|hidden-api-key|hidden-password|hidden-private-key|hidden-access-key/);
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
    { requestId, "loomex/taskWorkspace": { taskContext } }, undefined, [grant, preparation], false, 350);
  await app.getByText("Preparing your review…", { exact: true }).waitFor();
  assert.equal(await app.locator('[role="status"]:visible').count(), 1, "automatic preparation exposes one visible status");
  assert.equal(await app.locator("#activity").isHidden(), true, "the global activity row defers to the setup status");
  await waitForToolCount(page, "loomex_workspace_grant", 1);
  assert.equal(await app.locator('[role="status"]:visible').count(), 1, "workspace grant keeps one visible status");
  await waitForToolCount(page, "loomex_run_prepare", 1);
  assert.equal(await app.locator('[role="status"]:visible').count(), 1, "run preparation keeps one visible status");
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

  await app.getByRole("button", { name: "Start run", exact: true }).evaluate((button: any) => { button.click(); button.click(); });
  await waitForToolCount(page, "loomex_run_start_handoff_approve", 1);
  await page.waitForFunction(() => window.__loomexMessages.length === 1).catch(async(error:unknown)=>{throw new Error(JSON.stringify(await page.evaluate(()=>({body:document.getElementById("app")?.contentDocument?.body?.innerText,calls:window.__loomexCalls,operations:window.__loomexPersistenceStore.operations}))),{cause:error});});
  const calls = await page.evaluate(() => window.__loomexCalls);
  const issues=calls.filter((call:any)=>call.name==="loomex_run_start_handoff_issue");
  assert.equal(issues.length,1,"double click issues one reviewed handoff");
  assert.equal(issues[0].arguments.preparationId,prepared.preparationId);
  assert.equal(issues[0].arguments.bindingDigest,prepared.bindingDigest);
  assert.equal(issues[0].arguments.confirmationKey,prepared.confirmationKey);
  assert.equal(calls.some((call:any)=>["loomex_run_commit","loomex_run_get"].includes(call.name)),false);
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



test("unsupported setup fails closed without starting a run", async (t) => {
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
  await page.waitForFunction(() => window.__loomexMessages.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), []);
  const messages = await page.evaluate(() => window.__loomexMessages);
  assert.equal(messages.length, 1);
  assert.match(messages[0].content[0].text, new RegExp(workflowId));
  assert.match(messages[0].content[0].text, /do not commit, execute, or infer authority/);

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
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls))[0], { name: "loomex_workflows_list", arguments: { limit: 5, cursor: "cursor-2" } });
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
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls)).at(-1).arguments, { limit: 5, query: "missing" });
  await page.evaluate(() => {
    window.__workflowResponses = [{ structuredContent: { ok: true, data: { workflows: [], nextCursor: null } } }];
  });
  await app.getByRole("button", { name: "Refresh", exact: true }).focus();
  const refreshLayoutBefore = await appLayoutSnapshot(page);
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await app.locator('#context[data-retain-content="true"]').waitFor();
  const refreshLayoutDuring = await appLayoutSnapshot(page);
  assertStableLoadingLayout(refreshLayoutBefore, refreshLayoutDuring, "Refresh");
  await waitForCallCount(page, 4);
  await app.locator('#context[aria-busy="false"]').waitFor();
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
  await app.getByText("1 input", { exact: true }).waitFor();
  await app.getByText("Local execution", { exact: true }).waitFor();
  await app.locator('section[aria-label="Workflow graph"]').getByRole("button", { name: "Expand workflow graph", exact: true }).waitFor();
  const detailText = await app.locator("body").innerText();
  assert.doesNotMatch(detailText, /obsolete|staleProjection|ignoredFallback|7f57e77b|Obsolete active step|Stale descriptor/);
  assert.doesNotMatch(detailText, /Runs on this Mac with your user permissions after review/);
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
  await app.getByRole("button", { name: "Return to workflow list", exact: true }).click();
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
  assert.equal(await app.getByRole("button", { name: /^Prepare run/ }).count(), 0, "the list must not retain a workflow-detail action");
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await app.locator("#summary.error").waitFor({ state: "hidden" });
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
    browser: { arguments: { limit: 5 }, history: [], selectedWorkflowId: null, selectedVersion: null },
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
  assert.deepEqual(restoreCalls.at(-2).arguments, { limit: 5, cursor: "page-2" });
  assert.deepEqual(restoreCalls.at(-1).arguments, { workflowId, version: "3" });
  assert.ok((await page.evaluate(() => window.__loomexPersistenceCalls)).every((call: any) => call.name.startsWith("loomex_view_")));
});

test("workflow browser reloads a saved default page when its page data is absent", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for durable workflow browsing");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const session = viewSession("fcaee4dc-a5f3-4c53-96a0-6a2157bf3b45", "browser", "catalog", "00000000-0000-0000-0000-000000000000", {
    schemaVersion: 1, screen: "browser", disclosures: {},
    browser: { arguments: { limit: 5 }, history: [], selectedWorkflowId: null, selectedVersion: null },
  });
  const pendingPage = { responseRef: "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e", encoding: "json", sizeBytes: 90000, nextOffset: 0 };
  const restoredPage = { workflows: [{ id: "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e", name: "Restored default page" }], nextCursor: null };
  const app = await mountApp(page, "browser", pendingPage, false, false, null, false,
    { "loomex/viewSession": session }, undefined, [{ structuredContent: { ok: true, data: restoredPage } }]);
  await waitForPersistenceToolCount(page, "loomex_view_session_get", 1);
  await app.getByRole("button", { name: "View: Restored default page", exact: true }).waitFor();
  const listCalls = (await page.evaluate(() => window.__loomexCalls))
    .filter((call: any) => call.name === "loomex_workflows_list");
  assert.deepEqual(listCalls.map((call: any) => call.arguments), [{ limit: 5 }]);
});

test("run setup fields survive card closure without replay", async (t) => {
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
  assert.equal(await app.locator(".app-header h1").textContent(), "Future v5");
  assert.equal(await app.getByRole("button", { name: "Edit workflow", exact: true }).count(), 1);
  assert.equal(await app.getByRole("button", { name: "Prepare run", exact: true }).count(), 1);
  assert.equal(await app.getByRole("button", { name: "Activate", exact: true }).count(), 0);
  await app.getByText("Local execution", { exact: true }).waitFor();
  await app.getByText("1 input", { exact: true }).waitFor();
  await app.locator('section[aria-label="AI"]').getByText("AI", { exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Prepare run", exact: true }).evaluate((button: any) => button.getBoundingClientRect().height >= 36), true);
  assert.equal(await app.locator("body").evaluate((body: any) => body.scrollWidth <= body.clientWidth), true);
  await captureRequestedScreenshots(page, "workflow-detail");

  await app.getByRole("button", { name: "Refresh workflow", exact: true }).click();
  await waitForCallCount(page, 1);
  assert.deepEqual((await page.evaluate(() => window.__loomexCalls))[0], { name: "loomex_workflow_get", arguments: { workflowId: id, version: "5" } });
  await app.getByRole("heading", { name: "Future v5", exact: true }).waitFor();

  await page.evaluate(() => {
    window.__workflowDelayMs = 120;
    window.__workflowResponses = [{ isError: true, structuredContent: { ok: false } }];
  });
  await app.getByRole("button", { name: "Refresh workflow", exact: true }).click();
  await app.locator('#context[data-retain-content="true"]').waitFor();
  assert.equal(await app.locator("#context").getAttribute("aria-busy"), "true");
  await waitForCallCount(page, 2);
  await app.locator("#summary.error").waitFor();
  assert.equal(await app.locator("#context").getAttribute("aria-busy"), "false");
  assert.equal(await app.getByRole("button", { name: "Prepare run", exact: true }).isDisabled(), true);

  await page.evaluate((data: any) => {
    window.__workflowDelayMs = 0;
    window.__workflowResponses = [{ structuredContent: { ok: true, data } }];
  }, detail);
  await app.getByRole("button", { name: "Refresh workflow", exact: true }).click();
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
  await inputs.getByText("51 inputs", { exact: true }).waitFor();
  await inputs.getByText("1 required", { exact: true }).waitFor();
  assert.equal(await inputs.locator(".workflow-detail-item").count(), 51);
  assert.equal(await inputs.locator("details").count(), 1);
  const providers = app.locator('section[aria-label="AI"]');
  await providers.getByText("21 configurations", { exact: true }).waitFor();
  assert.equal(await providers.locator(".workflow-chip").count(), 3);
  const graph = app.locator('section[aria-label="Workflow graph"]');
  await graph.getByRole("button", { name: "Expand workflow graph", exact: true }).click();
  await app.getByRole("dialog").getByRole("heading", { name: "Workflow graph", exact: true }).waitFor();
  await app.getByRole("dialog").getByRole("button", { name: "Close graph", exact: true }).click();
  assert.equal(await app.getByRole("dialog").count(), 0);
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
    const run = app.getByRole("button", { name: "Run: One", exact: true });
    await run.waitFor();
    assert.equal(await run.locator(".action-label").count(), 0, "workflow-row Run is icon-only");
    assert.equal(await run.locator(".sr-only").textContent(), "Run");
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
    assert.deepEqual((await page.evaluate(() => window.__loomexCalls)).at(-1).arguments, { query: "idea", systemKey: "scope", limit: 5, cursor: "next" });
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

test("run monitor does not present an unscoped pending request as actionable", async (t) => {
  const available = await browserTools();
  if (!available) {
    if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser");
    t.skip("Playwright or a local Chromium executable is unavailable");
    return;
  }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const runId = "f2e7a4a8-245c-4aee-a6af-36bfefb30d38";
  const requestId = "339f07e7-b6d6-4a7b-8f3d-8581a1571c03";
  const app = await mountApp(page, "monitor", {
    execution: { id: runId, status: "waiting", workflowName: "Unscoped request" },
    humanRequest: {
      id: requestId, status: "pending", type: "input", title: "This request lacks organization identity",
      execution: { id: runId }, responseSchema: { type: "object", properties: { answer: { type: "string" } } },
    },
  });
  await app.locator("#summary.error").waitFor();
  assert.equal(await app.getByRole("heading", { name: "This request lacks organization identity", exact: true }).count(), 0);
  for (const action of ["Review answer", "Submit answer", "Approve", "Reject"]) {
    assert.equal(await app.getByRole("button", { name: action, exact: true }).count(), 0);
  }
  assert.equal(await page.evaluate(() => window.__loomexCalls.some((call: any) =>
    ["loomex_interaction_get", "loomex_interaction_view", "loomex_interaction_respond"].includes(call.name))), false);
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
  await app.locator('#context[data-retain-content="true"]').waitFor();
  const compactLayoutDuring = await appLayoutSnapshot(page);
  assertStableLoadingLayout(compactLayoutBefore, compactLayoutDuring, "Refresh");
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
  assert.equal(await terminal.getByRole("button", { name: "Run timing", exact: true }).count(), 0);
  await terminal.getByText(/^Started:/).waitFor();
  await terminal.getByText(/^Completed:/).waitFor();
  assert.equal(await terminal.getByRole("tooltip").count(), 0);
  await page.waitForTimeout(1100);
  assert.equal(await terminal.locator("#run-clock").textContent(), "2m 5s", "Terminal duration does not keep ticking");
});

test("started run cards keep pending interactions in chat", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium required for started-run presentation");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const runId = "54b926eb-2e0d-48e8-9d93-ca9d2a1a0d21";
  const organizationId = "a7f6e145-0a78-4f64-a8a4-5c2361370ae3";
  const pendingRequests = [
    {
      id: "4d8130ee-c0e7-4e62-994b-5d4f7d9ca8f6", type: "input", status: "pending", title: "A long response belongs in chat",
      organizationId, execution: { id: runId, organizationId, workflowName: "Chat-only question" },
      responseSchema: { type: "object", properties: { response: { type: "string" } } },
    },
    {
      id: "4d8130ee-c0e7-4e62-994b-5d4f7d9ca8f7", type: "manual_input", status: "pending", title: "Answer the batch in chat",
      organizationId, execution: { id: runId, organizationId, workflowName: "Chat-only question" },
      schemaDigest: "a".repeat(64),
      inputSpec: { schemaVersion: "loomex.human-input/v2", collectionMode: "batch", inputType: "text", question: "Batch details", questions: [
        { id: "goal", inputType: "text", question: "What should this run do?" },
      ] },
      responseSchema: { type: "object", properties: { answers: { type: "array" } } },
    },
    {
      id: "4d8130ee-c0e7-4e62-994b-5d4f7d9ca8f8", type: "approval", status: "pending", title: "Approve only in chat",
      organizationId, execution: { id: runId, organizationId, workflowName: "Chat-only question" }, prompt: "Approve the plan in chat.",
    },
  ];
  for (const humanRequest of pendingRequests) {
    const page = await browser.newPage();
    const app = await mountApp(page, "monitor", {
      execution: { id: runId, organizationId, workflowName: "Chat-only question", status: "waiting" }, humanRequest,
    });
    await app.getByText("This run needs a response in chat.", { exact: true }).waitFor();
    assert.equal(await app.getByRole("heading", { name: humanRequest.title, exact: true }).count(), 0);
    for (const action of ["Review answer", "Review answers", "Submit answer", "Submit answers", "Approve", "Reject"]) {
      assert.equal(await app.getByRole("button", { name: action, exact: true }).count(), 0, `${humanRequest.type} requests stay out of the monitor`);
    }
    assert.equal(await app.getByRole("button", { name: "Follow in chat", exact: true }).count(), 0);
    await page.close();
  }
});

test("workflow pagination stays visible for single and empty pages with compact controls", async (t) => {
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
  await page.setViewportSize({ width: 240, height: 900 });
  const previousBox = await nav.getByRole("button", { name: "Previous", exact: true }).boundingBox();
  const nextBox = await nav.getByRole("button", { name: "Next", exact: true }).boundingBox();
  assert.equal(previousBox?.y, nextBox?.y, "pagination controls stay on one row at narrow embedded widths");
  await page.setViewportSize({ width: 390, height: 900 });
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
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await app.getByText("Page 2 · 0 workflows", { exact: true }).waitFor();
  assert.equal(await nav.getByRole("button", { name: "Previous", exact: true }).isEnabled(), true);
  assert.equal(await nav.getByRole("button", { name: "Next", exact: true }).isDisabled(), true);
  assert.equal(await app.locator("body").evaluate((el: any) => el.scrollWidth <= el.clientWidth), true);
  await captureRequestedScreenshots(page, "workflow-pagination-mobile-empty");
});

test("single acceptance saves the backend node identity and remount reconciles stale pending data", async (t) => {
  const available = await browserTools();
  assert.ok(available, "Chromium is required");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requestId = randomUUID();
  const runId = randomUUID();
  const session = viewSession(randomUUID(), "interaction", "request", requestId, {});
  const request = { id: requestId, status: "pending", type: "boolean", node: { id: "acceptance_review" },
    execution: { id: runId }, schemaDigest: "a".repeat(64),
    inputSpec: { inputType: "boolean", question: "Accept the result?" },
    responseSchema: { type: "object", properties: { value: { type: "boolean" } }, required: ["value"] } };
  let app = await mountApp(page, "interaction", { humanRequest: request }, false, false, null, false, { "loomex/viewSession": session });
  await app.getByRole("radio", { name: "Yes", exact: true }).check();
  await app.getByRole("button", { name: "Review answer", exact: true }).click();
  await app.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
  await page.waitForFunction(() => window.__loomexPersistenceCalls.some((call: any) => call.name === "loomex_interaction_draft_update" && call.arguments.phase === "review"));
  const saves = await page.evaluate(() => window.__loomexPersistenceCalls.filter((call: any) => call.name === "loomex_interaction_draft_update"));
  assert.ok(saves.length > 0);
  for (const save of saves) {
    assert.deepEqual(Object.keys(save.arguments.answers), ["acceptance_review"]);
    assert.equal(save.arguments.answers.acceptance_review.value, true);
  }
  const continuation = followContinuationDetails(runId);
  await page.evaluate(({ requestId, runId, continuation }: any) => {
    window.__workflowResponses = [{ structuredContent: { ok: true, data: { requestId, requestStatus: "resolved", executionId: runId, error: null, ...continuation } } }];
  }, { requestId, runId, continuation });
  await app.getByRole("button", { name: "Submit answer", exact: true }).click();
  await page.waitForFunction(() => window.__loomexMessages.length === 1);
  assert.equal(await app.locator('[aria-label="Chat handoff"]').count(), 0);
  const resolved = { ...request, status: "resolved", answer: { value: true } };
  app = await mountApp(page, "interaction", { humanRequest: request }, false, false, null, false,
    { "loomex/viewSession": session }, undefined, [{ structuredContent: { ok: true, data: { humanRequest: resolved } } }], true);
  await app.getByRole("heading", { name: "Submitted answers", exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Submit answer", exact: true }).isVisible(), false);
  assert.equal(await page.evaluate(() => window.__loomexMessages.length), 1);
  await captureRequestedScreenshots(page, "accepted-answer-read-only");
});

test("reading position restores after setup hydration without persisting transient button state", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for reading-position persistence");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__restoredPositions = [];
    window.scrollTo = (position: any) => { window.__restoredPositions.push(position); };
  });
  const workflowId = "8100d86a-79ed-46b8-ab85-f374a368560b";
  const versionId = "1cf3f7d8-716c-446b-9ed0-f3dd73e188a4";
  const setup = {
    workflow: { id: workflowId, organizationId: "dadf8fe5-ae7e-4394-8fe9-b611093019d6", name: "Saved reading position" },
    selectedVersion: { id: versionId, workflowId, versionNumber: 1, definition: { settings: { inputSchema: { type: "object", properties: {} } }, nodes: [] } },
    inputSchema: { type: "object", properties: { title: { type: "string", title: "Report title" } } },
  };
  const session = viewSession("20d82083-d502-45d1-85f7-eac73d5b9444", "prepare", "workflow", workflowId, {
    schemaVersion: 1, screen: "setup", workflowId, versionId, disclosures: {},
    controls: {}, readingPosition: { top: 123, left: 0 },
  });
  const app = await mountApp(page, "prepare", setup, false, false, null, false, { "loomex/viewSession": session });
  await app.locator("body").evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const check = () => window.__restoredPositions.some((position: any) => position.top === 123)
        ? resolve() : requestAnimationFrame(check);
      check();
      setTimeout(() => reject(new Error("Reading position was not restored after hydration: " + document.body.innerText.slice(-500) + JSON.stringify(window.__restoredPositions))), 5000);
    });
  });
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls), [], "restoring position does not invoke domain mutations");
});

test("reopening setup restores the verified preparation review and enables Start", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required for preparation restoration");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const workflowId = "dd25f9b7-c98e-4c15-a31a-7d4f49ca1e68";
  const versionId = "48a69d1e-05af-4225-b1b5-69f93f6637fb";
  const organizationId = "44a4d854-30a4-4d7d-8950-09b3ba459765";
  const preparationId = "a48d8335-780c-4cb3-a469-62edf392a20a";
  const source = viewSession("87e001a2-4ce5-40a9-a1b9-dfa3bb2744ca", "prepare", "workflow", workflowId, {
    schemaVersion: 1, screen: "setup", workflowId, versionId,
  });
  const target = viewSession("b9c53d9f-b468-4e9f-a874-e357914d9f22", "prepare", "preparation", preparationId, {
    schemaVersion: 1, screen: "review", preparationId,
  });
  const setup = {
    workflow: { id: workflowId, organizationId, name: "Restored review" },
    selectedVersion: { id: versionId, workflowId, versionNumber: 1, definition: { settings: { inputSchema: { type: "object", properties: {} } }, nodes: [] } },
    inputSchema: { type: "object", properties: {} },
  };
  await mountApp(page, "prepare", setup, false, false, null, false, { "loomex/viewSession": source });
  await waitForPersistenceToolCount(page, "loomex_view_session_get", 1);
  source.state.forwardSession = { viewSessionId: target.viewSessionId, kind: target.kind, entityType: target.entityType, entityId: target.entityId };
  source.status = "inactive";
  const prepared = { preparationId, bindingDigest: "d".repeat(64), confirmationKey: "8d8351c8-c5fc-459a-a541-aa8db7dadba2",
    binding: { workflowId, versionId, organizationId, installationId: "47987b21-fd32-4df2-8a54-0a0be16219c6", workspacePath: "/Users/example/report", executionPolicy: "host_user/v1", inputs: {}, providerConfiguration: {} } };
  const presentation = { schemaVersion: "loomex/preparation-review/v1", preparationId, bindingDigest: prepared.bindingDigest,
    workflowId, versionId, organizationId, workflowName: "Restored review", workflowVersion: 1, organizationName: "Loomex", providers: [] };
  await page.evaluate((sessions: any[]) => {
    for (const session of sessions) window.__loomexPersistenceStore.sessions[session.viewSessionId] = structuredClone(session);
    window.__persistenceDelayMs = 100;
  }, [source, target]);
  const app = await mountApp(page, "prepare", setup, false, false, null, false, { "loomex/viewSession": source }, undefined, [
    { structuredContent: { ok: true, data: { status: "valid", operation: "runs.prepare", preparation: prepared } }, _meta: { "loomex/preparationReview": presentation } },
  ], true);
  await waitForEnabledPrimary(page, "Start run").catch(async (error: unknown) => {
    const diagnostics = await page.evaluate(() => ({ body: document.getElementById("app")?.contentDocument?.body?.innerText, calls: window.__loomexCalls, operations: window.__loomexPersistenceStore.operations }));
    throw new Error(`Restored Start was not enabled: ${JSON.stringify(diagnostics)}`, { cause: error });
  });
  await app.getByText("Restored review", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__loomexCalls.map((call: any) => call.name)), ["loomex_preparation_get"]);
  await page.evaluate(() => { window.__blockedPersistenceTools = ["loomex_delivery_get"]; });
  await app.getByRole("button", { name: "Start run", exact: true }).click();
  await waitForToolCount(page, "loomex_run_start_handoff_issue", 1);
  await waitForToolCount(page, "loomex_run_start_handoff_approve", 1);
  const approval = await page.evaluate(() => window.__loomexCalls.find((call: any) => call.name === "loomex_run_start_handoff_approve").arguments);
  assert.equal(approval.handoffRef, "11111111-1111-4111-8111-111111111111");
  const recovery = app.locator("[data-delivery-recovery]");
  await recovery.waitFor().catch(async (error:unknown)=>{throw new Error(JSON.stringify(await page.evaluate(()=>({body:document.getElementById("app")?.contentDocument?.body?.innerText,calls:window.__loomexPersistenceCalls,domain:window.__loomexCalls}))),{cause:error});});
  await recovery.getByText(/PERSISTENCE_UNAVAILABLE/).waitFor({state:"attached"});
  assert.equal(await page.evaluate(() => window.__loomexMessages.length), 0);
  await page.evaluate(() => { window.__blockedPersistenceTools = []; });
  const check = recovery.getByRole("button", {name:"Check chat delivery", exact:true});
  if (await check.count()) await check.click();
  await recovery.getByRole("button", {name:"Continue in chat", exact:true}).click();
  await page.waitForFunction(() => window.__loomexMessages.length === 1);
  const calls = await page.evaluate(() => window.__loomexCalls);
  assert.equal(calls.filter((call:any)=>call.name === "loomex_run_start_handoff_approve").length,1);
  assert.equal(calls.some((call: any) => call.name === "loomex_run_commit"), false);
});

test("organizations remain distinct, paginate and preserve a candidate through refresh", async (t) => {
  const available = await browserTools();
  assert.ok(available, "Chromium required");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const organizations = Array.from({ length: 7 }, (_, i) => ({ id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`, name: `Organization ${i}`, enrolled: i === 0 }));
  const projection = connectionProjection({ state: "authenticated", actions: ["organizations.list", "organizations.select", "auth.logout"], organization: { status: "connected", selected: organizations[0] }, organizations: organizations.map(({ id, name, enrolled }) => ({ id, name, enrolled })) });
  const app = await mountApp(page, "organizations", projection, false, false, null, false, undefined, undefined, [
    { structuredContent: { ok: true, data: { organizations } } },
    { structuredContent: { ok: true, data: projection } },
    { structuredContent: { ok: true, data: { organizations } } },
  ]);
  await app.getByRole("radio", { name: "Organization 1", exact: true }).evaluate((node: any) => { node.identityCheck = "retained"; });
  await app.getByRole("radio", { name: "Organization 1", exact: true }).check();
  assert.equal(await app.getByRole("radio").count(), 5);
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await waitForToolCount(page, "loomex_organizations_list", 2);
  await app.getByRole("button", { name: "Switch organization", exact: true }).waitFor();
  assert.equal(await app.getByRole("radio", { name: "Organization 1", exact: true }).isChecked(), true);
  assert.equal(await app.getByRole("radio", { name: "Organization 1", exact: true }).evaluate((node: any) => node.identityCheck), "retained", "refresh preserves the mounted control");
  assert.equal(await app.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
  await captureRequestedScreenshots(page, "organizations-selected");
  await app.getByRole("button", { name: "Next", exact: true }).click();
  assert.equal(await app.getByRole("radio").count(), 2);
  await app.getByRole("button", { name: "Connection", exact: true }).click();
  await app.getByRole("heading", { name: "Connection", exact: true }).waitFor();
  await captureRequestedScreenshots(page, "connection-connected");
});

test("opening the verification browser preserves polling and mounted code", async (t) => {
  const available = await browserTools(); assert.ok(available);
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pending = connectionProjection({ state: "verification_pending", actions: ["auth.poll"], login: { flowId: "flow-poll", verificationUri: "https://example.test/verify", userCode: "ABCD-1234", expiresAt: Math.floor(Date.now()/1000)+60, intervalSeconds: 1, retryAfterSeconds: 1 } });
  const app = await mountApp(page, "connection", pending, false, false, null, false, undefined, { openLink: { url: {} } });
  await app.getByRole("button", { name: "Open browser", exact: true }).click();
  await waitForToolCount(page, "loomex_auth_poll", 1);
  assert.equal(await app.getByText("ABCD-1234", { exact: true }).count(), 1);
  assert.equal(await app.locator("#verification-url").count(), 0);
  await captureRequestedScreenshots(page, "connection-verification");
});

test("connection navigation restores its page and fresh state after remount", async (t) => {
  const available = await browserTools(); assert.ok(available);
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const organization = { id: "11111111-1111-4111-8111-111111111111", name: "Example", enrolled: true };
  const projection = connectionProjection({ state: "authenticated", organization: { status: "connected", selected: organization }, organizations: [organization], actions: ["organizations.list", "organizations.select", "auth.logout"] });
  const session = { ...viewSession(randomUUID(), "browser", "catalog", "00000000-0000-0000-0000-000000000000", {}), kind: "connection" };
  const response = { structuredContent: { ok: true, data: projection } };
  const list = { structuredContent: { ok: true, data: { organizations: [organization] } } };
  let app = await mountApp(page, "connection", projection, false, false, null, false, { "loomex/viewSession": session }, undefined, [response, list]);
  await app.getByRole("button", { name: "Change organization", exact: true }).click();
  await app.getByRole("radio", { name: "Example Current", exact: true }).waitFor();
  await waitForPersistenceToolCount(page, "loomex_connection_view_update", 1);
  await page.evaluate(() => { window.__persistenceDelayMs = 100; });
  app = await mountApp(page, "connection", connectionProjection(), false, false, null, false, { "loomex/viewSession": session }, undefined, [response, list], true);
  await app.getByRole("heading", { name: "Organizations", exact: true }).waitFor();
  await app.getByRole("radio", { name: "Example Current", exact: true }).waitFor();
  assert.equal(await app.getByRole("button", { name: "Sign in", exact: true }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Switch organization", exact: true }).isDisabled(), true);
  const calls = await page.evaluate(() => window.__loomexCalls.map((call: any) => call.name));
  assert.equal(calls.some((name: string) => ["loomex_auth_start", "loomex_organization_select", "loomex_auth_logout"].includes(name)), false);
});

test("failed organization refresh retains unverified rows and disables switching", async (t) => {
  const available = await browserTools(); assert.ok(available);
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const organization = { id: "11111111-1111-4111-8111-111111111111", name: "Example", enrolled: false };
  const projection = connectionProjection({ state: "authenticated", organizations: [organization], actions: ["organizations.list", "organizations.select", "auth.logout"] });
  const app = await mountApp(page, "organizations", projection, false, false, null, false, undefined, undefined, [
    { structuredContent: { ok: true, data: { organizations: [organization] } } },
    { structuredContent: { ok: true, data: projection } },
    { isError: true, structuredContent: { ok: false, error: { code: "BACKEND_UNAVAILABLE", message: "Refresh unavailable" } } },
  ]);
  await app.getByRole("radio", { name: "Example", exact: true }).check();
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await app.getByText("Organizations could not be refreshed. Refresh to retry; your sign-in is unchanged.", { exact: true }).waitFor();
  assert.equal(await app.getByRole("radio", { name: "Example", exact: true }).isDisabled(), true);
  assert.equal(await app.getByRole("button", { name: "Use organization", exact: true }).isDisabled(), true);
  assert.equal(await app.getByRole("button", { name: "Sign in", exact: true }).count(), 0);
});

test("ambiguous organization selection survives remount and retries its exact key after reconciliation", async (t) => {
  const available = await browserTools(); assert.ok(available);
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const organization = { id: "11111111-1111-4111-8111-111111111111", name: "Example", enrolled: false };
  const projection = connectionProjection({ state: "authenticated", organizations: [organization], actions: ["organizations.list", "organizations.select", "auth.logout"] });
  const session = { ...viewSession(randomUUID(), "browser", "catalog", "00000000-0000-0000-0000-000000000000", {}), kind: "organizations" };
  const response = { structuredContent: { ok: true, data: projection } };
  const list = { structuredContent: { ok: true, data: { organizations: [organization] } } };
  let app = await mountApp(page, "organizations", projection, false, false, null, false, { "loomex/viewSession": session }, undefined, [response, list,
    { isError: true, structuredContent: { ok: false, error: { code: "NETWORK_AMBIGUOUS", message: "The response was interrupted." } } },
  ]);
  await app.getByRole("radio", { name: "Example", exact: true }).check();
  await app.getByRole("button", { name: "Use organization", exact: true }).click();
  await app.getByRole("button", { name: "Retry previous action", exact: true }).waitFor();
  const first = await page.evaluate(() => window.__loomexCalls.find((call: any) => call.name === "loomex_organization_select").arguments);
  const selected = { structuredContent: { ok: true, data: { ...projection, organization: { status: "connected", selected: organization } } } };
  app = await mountApp(page, "organizations", projection, false, false, null, false, { "loomex/viewSession": session }, undefined, [response, list, response,
    { structuredContent: { ok: true, data: { selected: true } } }, selected, list,
  ], true);
  await app.getByRole("button", { name: "Retry previous action", exact: true }).click();
  await app.getByRole("radio", { name: "Example Current", exact: true }).waitFor();
  const attempts = await page.evaluate(() => window.__loomexCalls.filter((call: any) => call.name === "loomex_organization_select"));
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1].arguments, first);
  assert.equal(await app.getByRole("button", { name: "Switch organization", exact: true }).isDisabled(), true);
});

test("all eight canonical modes expose one accessible shell and explicit action metadata", async (t) => {
  const available = await browserTools();
  assert.ok(available, "Chromium required");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const organization = { id: "95fdc8eb-c9d1-4d54-9f99-938d44eb40bc", name: "Canonical organization", enrolled: true };
  const organizations = [organization, ...Array.from({length: 5}, (_, index) => ({id: randomUUID(), name: `Team ${index + 2}`, enrolled: false}))];
  const requestId = "80863179-8e75-45ee-80b1-9d1d3bdbf7a1";
  const workflowId = "56cb5884-c2ed-4ad0-9b27-4e49a49f0ae8";
  const versionId = "e7414900-0ec3-42e3-a445-426258befb4b";
  const request = {
    id: requestId, status: "pending", schemaDigest: "a".repeat(64), type: "manual_input",
    inputSpec: { inputType: "text", question: "What should this mode collect?" },
    responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  };
  const connected = connectionProjection({
    state: "authenticated", organization: { status: "connected", selected: organization }, organizations,
    actions: ["organizations.list", "organizations.select", "auth.logout"],
  });
  const preparationPresentation = {
    schemaVersion: "loomex/preparation-review/v1", preparationId: "c3761e48-e423-497d-8e14-a8c188d52d43", bindingDigest: "b".repeat(64),
    workflowId, versionId, organizationId: organization.id, workflowName: "Canonical workflow", workflowVersion: 1,
    organizationName: organization.name, providers: [],
  };
  const cases: Array<{ mode: "interaction" | "authoring" | "prepare" | "monitor" | "browser" | "runs" | "connection" | "organizations"; data: Record<string, unknown>; heading: string; presentation?: Record<string, unknown>; responses?: Array<Record<string, unknown>> }> = [
    { mode: "browser", heading: "Browse workflows", data: { workflows: [{ id: workflowId, name: "Canonical workflow", latestVersion: 1, nodeCount: 1 }], nextCursor: null } },
    { mode: "authoring", heading: "What should this mode collect?", data: { builderSession: { id: "a270628e-f6f6-4e0f-adf6-0fbe0a9b4cb2" }, humanRequest: request } },
    { mode: "prepare", heading: "Canonical workflow", presentation: preparationPresentation, data: { preparationId: "c3761e48-e423-497d-8e14-a8c188d52d43", bindingDigest: "b".repeat(64), confirmationKey: "237f2b91-1fc4-4e22-b2c6-a6eb9092bf11", binding: { workflowId, versionId, organizationId: organization.id, installationId: "77d95646-63d9-4786-95d4-99a4ad1858f3", workspacePath: "/Users/example/canonical", executionPolicy: "host_user/v1", inputs: {}, providerConfiguration: {} } } },
    { mode: "monitor", heading: "Canonical workflow", data: { execution: { id: "639c8774-5d93-4de9-8c93-03d0502beaa1", workflowName: "Canonical workflow", status: "running" } } },
    { mode: "interaction", heading: "What should this mode collect?", data: { humanRequest: request } },
    { mode: "connection", heading: "Connection", data: connected },
    { mode: "organizations", heading: "Organizations", data: connected, responses: [{ structuredContent: { ok: true, data: { organizations } } }] },
  ];

  cases.push({mode: "runs", heading: "Workflow runs", data: {runs: [], nextCursor: null}});
  for (const item of cases) {
    const app = await mountApp(page, item.mode, item.data, false, false, item.presentation || null, false, undefined, undefined, item.responses || []);
    await app.getByRole("heading", { name: item.heading, exact: true }).waitFor();
    assert.equal(await app.locator(`body[data-mode="${item.mode}"]`).count(), 1, `${item.mode} keeps its canonical mode identity`);
    assert.equal(await app.locator("main").count(), 1, `${item.mode} has one embedded application shell`);
    assert.equal(await app.locator(".app-body[aria-label='Loomex workspace']").count(), 1, `${item.mode} names its workspace region`);
    assert.equal(await app.locator("button:visible").evaluateAll((buttons: any[]) => buttons.every(button =>
      Boolean(button.getAttribute("aria-label")) && button.querySelector("svg[aria-hidden='true']"))), true,
    `${item.mode} exposes every visible action through an accessible name and decorative icon`);
    assert.equal(await app.locator("#ui-tooltip, [data-tooltip]").count(), 0);
    for (const width of [390, 820]) {
      await page.setViewportSize({width, height: 1300});
      for (const nav of await app.locator(".ui-data-table-pagination").all()) {
        const geometry = await nav.evaluate((node: any) => {
          const summary = node.querySelector("output").getBoundingClientRect();
          const actions = node.querySelector(".ui-data-table-pagination-actions").getBoundingClientRect();
          return {summaryMiddle: summary.y + summary.height / 2, actionsMiddle: actions.y + actions.height / 2};
        });
        assert.ok(Math.abs(geometry.summaryMiddle - geometry.actionsMiddle) < 2, "page information and controls share one row");
      }
    }
    await captureRequestedScreenshots(page, `canonical-${item.mode}`);
  }

  const interaction = await mountApp(page, "interaction", { humanRequest: request });
  await interaction.locator("#question-0-value").fill("Document action intent");
  await interaction.getByRole("button", { name: "Review answer", exact: true }).click();
  await interaction.getByRole("heading", { name: "Answer preview", exact: true }).waitFor();
  const submit = interaction.getByRole("button", { name: "Submit answer", exact: true });
  assert.equal(await submit.getAttribute("data-answer-intent"), "submit");
  assert.equal(await submit.getAttribute("data-business-mutation"), "true");
  assert.equal(await submit.getAttribute("aria-label"), "Submit answer");
});

test("interaction execution context does not turn the answer card into a run monitor", async (t) => {
  const available = await browserTools();
  if (!available) {
    if (process.env.LOOMEX_REQUIRE_BROWSER === "1") assert.fail("Playwright requires an installed Chromium browser");
    t.skip("Playwright browser unavailable"); return;
  }
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const app = await mountApp(page, "interaction", {
    humanRequest: {
      id: "11ae0f7f-37d0-4817-8827-f025b87ff19b", type: "manual_input", status: "pending", schemaDigest: "a".repeat(64),
      execution: { id: "22ae0f7f-37d0-4817-8827-f025b87ff19b", status: "running", startedAt: new Date(Date.now() - 60_000).toISOString() },
      inputSpec: { schemaVersion: "loomex.human-input/v2", inputType: "boolean", question: "Accept delivery?" },
      responseSchema: { type: "object", properties: { value: { type: "boolean" } }, required: ["value"] },
    },
  });
  await app.getByRole("radio", { name: "Yes", exact: true }).waitFor();
  assert.equal(await app.locator("#run-clock").isVisible(), false);
});

for (const scenario of ["lost reply", "malformed reference", "substituted preparation", "unknown error"] as const) {
 test(`Start handoff ${scenario} retains its journal and restores without replay`,async(t)=>{
  const available=await browserTools();assert.ok(available);
  const browser=await available.tools.chromium.launch({executablePath:available.executablePath,headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  const prepared={preparationId:randomUUID(),bindingDigest:"a".repeat(64),confirmationKey:randomUUID(),binding:{workflowId:randomUUID(),versionId:randomUUID(),organizationId:randomUUID(),installationId:randomUUID(),workspacePath:"/Users/example/project",inputs:{idea:"Keep this idea"},executionPolicy:"host_user/v1",providerConfiguration:{}}};
  const presentation={schemaVersion:"loomex/preparation-review/v1",preparationId:prepared.preparationId,bindingDigest:prepared.bindingDigest,workflowId:prepared.binding.workflowId,versionId:prepared.binding.versionId,organizationId:prepared.binding.organizationId,workflowName:"Handoff recovery",workflowVersion:1,organizationName:"Loomex",providers:[]};
  const ref=randomUUID();
  const good={schemaVersion:"loomex.run-start-handoff/v2",handoffRef:ref,preparationId:prepared.preparationId,lifecycle:"prepared",approvalObserved:false,nextAction:"approve"};
  const response=scenario==="lost reply" || scenario==="unknown error"
   ? {isError:true,structuredContent:{ok:false,error:{code:scenario==="lost reply"?"NETWORK_AMBIGUOUS":"FUTURE_FAILURE"}}}
   : {structuredContent:{ok:true,data:{...good,...(scenario==="malformed reference"?{handoffRef:"invalid"}:{preparationId:randomUUID()})}}};
  const app=await mountApp(page,"prepare",prepared,false,false,presentation);
  await page.evaluate((response:any)=>{window.__handoffResponses=[response];},response);
  await waitForEnabledPrimary(page,"Start run");
  await app.getByRole("button",{name:"Start run",exact:true}).click();
  await waitForEnabledPrimary(page,"Restore Start");
  const issue=(await page.evaluate(()=>window.__loomexCalls))[0];
  assert.equal(issue.name,"loomex_run_start_handoff_issue");
  assert.equal(issue.arguments.preparationId,prepared.preparationId);
  assert.equal(issue.arguments.confirmationKey,prepared.confirmationKey);
  assert.equal(await page.evaluate(()=>window.__loomexMessages.length),0);
  await page.evaluate((good:any)=>{window.__handoffResponses=[{structuredContent:{ok:true,data:good}}];},good);
  await app.getByRole("button",{name:"Restore Start",exact:true}).click();
  await waitForToolCount(page,"loomex_run_start_handoff_restore",1);
  await waitForEnabledPrimary(page,"Start run");
  const calls=await page.evaluate(()=>window.__loomexCalls);
  assert.deepEqual(calls.map((c:any)=>c.name),["loomex_run_start_handoff_issue","loomex_run_start_handoff_restore"]);
  assert.deepEqual(calls[1].arguments,{idempotencyKey:issue.arguments.idempotencyKey});
  assert.equal(await page.evaluate(()=>window.__loomexMessages.length),0,"reconciliation never approves or dispatches chat");
 });
}

test("all eight resources hydrate through one lifecycle without editable flashing",async(t)=>{
 const available=await browserTools();if(!available)assert.fail("Chromium is required");
 const browser=await available.tools.chromium.launch({executablePath:available.executablePath,headless:true});t.after(()=>browser.close());
 const requestId=randomUUID(),runId=randomUUID(),workflowId=randomUUID(),preparationId=randomUUID(),builderId=randomUUID();
 const request={id:requestId,status:"pending",type:"manual_input",schemaDigest:"a".repeat(64),inputSpec:{inputType:"text",question:"Project name"},responseSchema:{type:"object",properties:{value:{type:"string"}},required:["value"]}};
 const cases=[
  {mode:"browser",data:{workflows:[],nextCursor:null},entityType:"catalog",entityId:"00000000-0000-0000-0000-000000000000"},
  {mode:"runs",data:{runs:[],nextCursor:null},entityType:"catalog",entityId:"00000000-0000-0000-0000-000000000000"},
  {mode:"connection",data:connectionProjection(),entityType:"catalog",entityId:"00000000-0000-0000-0000-000000000000"},
  {mode:"organizations",data:connectionProjection(),entityType:"catalog",entityId:"00000000-0000-0000-0000-000000000000"},
  {mode:"prepare",data:{workflow:{id:workflowId,organizationId:randomUUID(),name:"Example"},selectedVersion:{id:randomUUID(),workflowId,versionNumber:1,definition:{nodes:[],settings:{inputSchema:{type:"object",properties:{idea:{type:"string"}},required:["idea"]}}}}},entityType:"workflow",entityId:workflowId},
  {mode:"monitor",data:{execution:{id:runId,status:"completed",workflowName:"Example"}},entityType:"execution",entityId:runId},
  {mode:"interaction",data:{humanRequest:request},entityType:"request",entityId:requestId},
  {mode:"authoring",data:{humanRequest:request,builderSession:{id:builderId}},entityType:"builderSession",entityId:builderId},
 ] as const;
 for(const fixture of cases){
  const page=await browser.newPage({viewport:{width:760,height:900},reducedMotion:"reduce"});
  await page.addInitScript(()=>{window.__holdPersistence=true;});
  const session={viewSessionId:randomUUID(),kind:fixture.mode,entityType:fixture.entityType,entityId:fixture.entityId,revision:0,status:"active",createdAt:1,updatedAt:1,expiresAt:null,state:{schemaVersion:1},operation:null,restoreVersion:"presentation.sessions.restore/v1"};
  const app=await mountApp(page,fixture.mode,fixture.data,false,false,null,false,{"loomex/viewSession":session});
  await app.locator('main[data-restoring="true"]').waitFor();
  assert.equal(await app.locator("main").getAttribute("aria-busy"),"true");
  assert.equal(await app.locator("#activity").isVisible(),false,"only restoration owns loading");
  const directory=process.env.LOOMEX_UI_SCREENSHOT_DIR;
  if(directory){await mkdir(directory,{recursive:true});await app.locator("main").screenshot({path:resolve(directory,`${fixture.mode}-lifecycle-loading.png`)});}
  await page.evaluate(()=>{window.__holdPersistence=false;for(const deliver of window.__heldPersistence||[])deliver();window.__heldPersistence=[];});
  await app.locator('main[data-restoring="false"]').waitFor();
  await app.locator('main[data-lifecycle="ready"],main[data-lifecycle="read_only"]').waitFor().catch(async(error:unknown)=>{throw new Error(JSON.stringify({mode:fixture.mode,...await page.evaluate(()=>({body:document.getElementById("app").contentDocument.body.innerText,calls:window.__loomexCalls,persistence:window.__loomexPersistenceCalls}))}),{cause:error});});
  if(directory)await app.locator("main").screenshot({path:resolve(directory,`${fixture.mode}-lifecycle-restored.png`)});
  await page.evaluate(({data,session}:any)=>{
    window.__blockedPersistenceTools=["loomex_view_session_get","loomex_view_session_restore","loomex_connection_view_get"];
    document.getElementById("app").contentWindow.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:{structuredContent:{ok:true,data},_meta:{"loomex/viewSession":session}}},"*");
  },{data:fixture.data,session});
  await app.locator('main[data-lifecycle="verification_failed"]').waitFor();
  if(directory)await app.locator("main").screenshot({path:resolve(directory,`${fixture.mode}-lifecycle-recovery.png`)});
  await page.evaluate(()=>{window.__blockedPersistenceTools=[];});
  await app.locator("#refresh").click();
  await app.locator('main[data-lifecycle="ready"],main[data-lifecycle="read_only"]').waitFor().catch(async(error:unknown)=>{throw new Error(JSON.stringify({mode:fixture.mode,...await page.evaluate(()=>({body:document.getElementById("app").contentDocument.body.innerText,calls:window.__loomexCalls,persistence:window.__loomexPersistenceCalls}))}),{cause:error});});
  assert.equal(await page.evaluate(()=>window.__loomexCalls.some((call:any)=>["loomex_run_wait","loomex_run_commit","loomex_interaction_respond","loomex_auth_start"].includes(call.name))),false);
  await page.close();
 }
});

test("workflow read-only navigation survives presentation storage failure",async(t)=>{
 const available=await browserTools();if(!available)assert.fail("Chromium is required");
 const browser=await available.tools.chromium.launch({executablePath:available.executablePath,headless:true});t.after(()=>browser.close());
 const page=await browser.newPage(),id=randomUUID();
 const list={workflows:[{id,name:"Example"}],nextCursor:"second"};
 const app=await mountApp(page,"browser",list);
 await waitForPersistenceToolCount(page,"loomex_view_session_get",1);
 await page.evaluate(({id}:any)=>{window.__blockedPersistenceTools=["loomex_view_session_update"];window.__workflowResponses=[{structuredContent:{ok:true,data:{workflow:{id,name:"Example"},selectedVersion:{id,versionNumber:1,definition:{nodes:[]}}}}}];},{id});
 await app.getByRole("button",{name:"View: Example",exact:true}).click();
 await app.getByRole("heading",{name:"Example",exact:true}).waitFor();
 await app.getByRole("button",{name:"Back to workflows",exact:true}).click();
 await app.getByRole("button",{name:"Next",exact:true}).waitFor();
 assert.equal(await app.getByRole("button",{name:"Next",exact:true}).isEnabled(),true);
 await page.evaluate(()=>{window.__workflowResponses=[{structuredContent:{ok:true,data:{workflows:[],nextCursor:null}}}];});
 await app.getByRole("button",{name:"Next",exact:true}).click();
 await app.getByText("Page 2 · 0 workflows",{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__loomexCalls.some((call:any)=>call.name==="loomex_run_wait")),false);
});

test("refresh retains local answers when their draft and presentation stores are unavailable",async(t)=>{
 const available=await browserTools();if(!available)assert.fail("Chromium is required");
 const browser=await available.tools.chromium.launch({executablePath:available.executablePath,headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();
 const data={humanRequest:{id:randomUUID(),status:"pending",type:"manual_input",schemaDigest:"a".repeat(64),inputSpec:{inputType:"text",question:"Project name"},responseSchema:{type:"object",properties:{value:{type:"string"}},required:["value"]}}};
 const app=await mountApp(page,"interaction",data);
 await waitForPersistenceToolCount(page,"loomex_interaction_draft_get",1);
 await page.evaluate(({data}:any)=>{window.__blockedPersistenceTools=["loomex_view_session_update","loomex_interaction_draft_update"];window.__workflowResponses=[{structuredContent:{ok:true,data}}];},{data});
 await app.getByRole("textbox",{name:"Project name Your answer",exact:true}).fill("Keep this unsaved answer");
 await app.getByRole("button",{name:"Refresh",exact:true}).click();
 await waitForToolCount(page,"loomex_interaction_get",1);
 await available.tools.expect(app.locator("#question-0-value")).toHaveValue("Keep this unsaved answer").catch(async(error:unknown)=>{throw new Error(JSON.stringify(await page.evaluate(()=>({body:document.getElementById("app").contentDocument.body.innerText, form:document.getElementById("app").contentDocument.getElementById("form").outerHTML, calls:window.__loomexCalls}))),{cause:error});});
 assert.equal(await page.evaluate(()=>window.__loomexCalls.some((call:any)=>call.name==="loomex_interaction_respond")),false);
});

test("runs refresh preserves an unapplied status filter", async (t) => {
  const available = await browserTools();
  if (!available) assert.fail("Chromium is required");
  const browser = await available.tools.chromium.launch({ executablePath: available.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const app = await mountApp(page, "runs", { runs: [], nextCursor: null });
  await app.locator('main[data-lifecycle="ready"]').waitFor();
  await app.getByRole("combobox", { name: "Run status" }).selectOption("failed");
  await page.evaluate(() => {
    window.__workflowResponses = [{ structuredContent: { ok: true, data: { runs: [], nextCursor: null } } }];
  });
  await app.getByRole("button", { name: "Refresh runs", exact: true }).click();
  await app.locator('[aria-label="Workflow runs"][aria-busy="false"]').waitFor();
  await available.tools.expect(app.getByRole("combobox", { name: "Run status" })).toHaveValue("failed");
  assert.equal(await page.evaluate(() => window.__loomexCalls.some((call: any) => call.name === "loomex_run_wait")), false);
});

test("accepted response restores interrupted delivery as manual recovery without resubmitting", async (t) => {
  const available = await browserTools(); if (!available) assert.fail("Chromium is required");
  const browser = await available.tools.chromium.launch({executablePath:available.executablePath,headless:true}); t.after(()=>browser.close());
  const page = await browser.newPage(), requestId=randomUUID(),runId=randomUUID();
  const envelope={schema:"loomex/chat-continuation/v2",intent:"monitor_existing_run",runId,trigger:"interaction_accepted",acceptedInteraction:{requestId,status:"resolved"},state:"requires_fresh_read"};
  const text=`${expectedFollowMarkdown(runId)}\n\nLoomex continuation context:\n\n\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\``;
  const session=viewSession(randomUUID(),"interaction","request",requestId,{schemaVersion:1,screen:"interaction",requestId,continuationDelivery:{schemaVersion:1,identity:`follow:${runId}:${requestId}`,purpose:"accepted_interaction",text,status:"sending",attemptId:randomUUID()}});
  const app=await mountApp(page,"interaction",{humanRequest:{id:requestId,status:"resolved",type:"manual_input",execution:{id:runId},schemaDigest:"a".repeat(64),answer:{value:"Accepted"},inputSpec:{inputType:"text",question:"Name"},responseSchema:{type:"object",properties:{value:{type:"string"}},required:["value"]}}},false,false,null,false,{"loomex/viewSession":session});
  await app.getByRole("heading",{name:"Submitted answers",exact:true}).waitFor();
  await app.locator("[data-delivery-recovery]").waitFor();
  await captureRequestedScreenshots(page, "interrupted-delivery-read-only");
  assert.equal(await app.getByRole("button",{name:"Submit answer",exact:true}).count(),0);
  assert.equal(await app.getByRole("button",{name:"Continue in chat",exact:true}).count(),0);
  assert.equal(await page.evaluate(()=>window.__loomexMessages.length),0);
  assert.equal(await page.evaluate(()=>window.__loomexCalls.some((call:any)=>["loomex_interaction_respond","loomex_interaction_decide"].includes(call.name))),false);
});

test("monitor restores delivery for an accepted request absent from its latest run snapshot", async(t)=>{
 const available=await browserTools(); if(!available) assert.fail("Chromium is required");
 const browser=await available.tools.chromium.launch({executablePath:available.executablePath,headless:true});t.after(()=>browser.close());
 const page=await browser.newPage(), runId=randomUUID(), requestId=randomUUID();
 const identity=`follow:${runId}:${requestId}`;
 const state={schemaVersion:1,screen:"monitor",executionId:runId,acceptedRequestId:requestId,continuationDelivery:{schemaVersion:2,identity,purpose:"accepted_interaction"}};
 const session=viewSession(randomUUID(),"monitor","execution",runId,state);
 const request={id:requestId,status:"resolved",type:"manual_input",executionId:runId,schemaDigest:"a".repeat(64),answer:{value:"Accepted"},inputSpec:{inputType:"text",question:"Name"},responseSchema:{type:"object",properties:{value:{type:"string"}},required:["value"]}};
 const app=await mountApp(page,"monitor",{execution:{id:runId,status:"running",workflowName:"Build"}},false,false,null,false,{"loomex/viewSession":session},undefined,[{structuredContent:{ok:true,data:{humanRequest:request}}}]);
 await app.locator("[data-delivery-recovery]").waitFor();
 assert.equal(await page.evaluate(()=>window.__loomexMessages.length),0);
 assert.equal(await page.evaluate((identity:string)=>window.__loomexPersistenceCalls.some((c:any)=>c.name==="loomex_delivery_get"&&c.arguments.identity===identity),identity),true);
 assert.equal(await app.getByRole("button",{name:"Submit answer",exact:true}).count(),0);
});
