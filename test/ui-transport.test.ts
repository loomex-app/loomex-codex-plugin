import * as assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeTransport } from "../src/ui-app/runtime-transport.js";
import { HostBridge } from "../src/ui-app/host-bridge.js";
import { RequestFence } from "../src/ui-app/lifecycle.js";
import { decodeUiError, decodeUiResult, toUiTransportError, UiResultDecodeError } from "../src/ui-app/result-decoder.js";
import { DEFAULT_TRANSPORT_OPERATION_POLICY, resolveTransportRequestOptions } from "../src/ui-app/transport-policy.js";

function deterministicTimers(): {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, milliseconds: number) => number;
  readonly clearTimeout: (id: number) => void;
  readonly advance: (milliseconds: number) => void;
} {
  let current = 0, nextId = 1;
  const scheduled = new Map<number, { due: number; callback: () => void }>();
  return {
    now: () => current,
    setTimeout: (callback, milliseconds) => {
      const id = nextId++;
      scheduled.set(id, { due: current + milliseconds, callback });
      return id;
    },
    clearTimeout: id => { scheduled.delete(id); },
    advance: milliseconds => {
      const target = current + milliseconds;
      for (;;) {
        const due = [...scheduled.entries()]
          .filter(([, timer]) => timer.due <= target)
          .sort(([, left], [, right]) => left.due - right.due || 0)[0];
        if (!due) break;
        const [id, timer] = due;
        scheduled.delete(id);
        current = timer.due;
        timer.callback();
      }
      current = target;
    },
  };
}

test("result decoding accepts host-shaped metadata and rejects a missing canonical envelope", () => {
  const data = decodeUiResult({
    structuredContent: { ok: true, data: { stale: true } },
    _meta: { "loomex/uiData": { ok: true, data: { schemaVersion: "loomex.runner.connection/v1" } } },
  });
  assert.deepEqual(data, { schemaVersion: "loomex.runner.connection/v1" });
  assert.throws(() => decodeUiResult({ structuredContent: {} }), (error: unknown) => {
    return error instanceof UiResultDecodeError && error.diagnostic.code === "UI_CANONICAL_DATA_MISSING";
  });
});

test("result decoding does not silently discard malformed structured content", () => {
  assert.throws(() => decodeUiResult({ structuredContent: [] }), (error: unknown) => {
    return error instanceof UiResultDecodeError && error.diagnostic.code === "UI_STRUCTURED_CONTENT_INVALID";
  });
});

test("result decoding preserves a structured retryable failure", () => {
  const failure = decodeUiError({
    structuredContent: { ok: false, error: { code: "NETWORK_AMBIGUOUS", message: "Retry safely.", retryable: true, correlationId: "corr-1" } },
  });
  assert.deepEqual(failure, { code: "NETWORK_AMBIGUOUS", message: "Retry safely.", retryable: true, correlationId: "corr-1" });
  const error = toUiTransportError(failure);
  assert.equal(error.code, "NETWORK_AMBIGUOUS");
  assert.equal(error.retryable, true);
  assert.equal(error.correlationId, "corr-1");
});

test("operation policy gives ui/message its bounded delivery window", () => {
  const delivery = resolveTransportRequestOptions("ui/message");
  assert.equal(delivery.timeoutMs, 120_000);
  assert.equal(delivery.slowAfterMs, 5_000);
  assert.equal(DEFAULT_TRANSPORT_OPERATION_POLICY.operations["ui/message"]?.timeoutMs, 120_000);

  const configured = resolveTransportRequestOptions("ui/message", {}, {
    default: { timeoutMs: 50 },
    operations: { "ui/message": { timeoutMs: 75, slowAfterMs: 10 } },
  });
  assert.deepEqual(configured, { timeoutMs: 75, slowAfterMs: 10 });
});

test("host bridge accepts only its target window and releases pending calls on disposal", async () => {
  const posted: unknown[] = [];
  const parent = { postMessage(message: unknown): void { posted.push(message); } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { parent, setTimeout, clearTimeout } });
  const bridge = new HostBridge({ target: parent as unknown as WindowProxy });
  const request = bridge.call("tools/call", { name: "loomex_run_get" }, { timeoutMs: 1_000 });
  const message = posted[0] as { id: number } | undefined;
  assert.ok(message);
  assert.equal(bridge.acceptEvent({ source: {} as MessageEventSource, data: { jsonrpc: "2.0", id: message.id, result: { unsafe: true } } } as MessageEvent<unknown>), false);
  assert.equal(bridge.accept({ jsonrpc: "2.0", id: message.id, error: { code: "RUNNER_BUSY", message: "Try again.", retryable: true, correlationId: "corr-2" } }), true);
  await assert.rejects(request, (error: unknown) => {
    const typed = toUiTransportError(error);
    return typed.code === "RUNNER_BUSY" && typed.retryable === true && typed.correlationId === "corr-2";
  });

  const pending = bridge.call("tools/call", { name: "loomex_run_get" }, { timeoutMs: 1_000 });
  bridge.dispose();
  await assert.rejects(pending, (error: unknown) => toUiTransportError(error).code === "HOST_BRIDGE_DISPOSED");
});

test("request fences reject late authoritative responses", () => {
  const fence = new RequestFence();
  const first = fence.begin();
  const second = fence.begin();
  assert.equal(fence.current(first), false);
  assert.equal(fence.current(second), true);
});

test("follow-up sends one standard message and does not retry an ambiguous delivery", async () => {
  const posted: { id: number; method: string }[] = [];
  const parent = { postMessage(message: { id: number; method: string }) { posted.push(message); } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { parent, setTimeout, clearTimeout } });
  const transport = new RuntimeTransport({ target: parent as unknown as WindowProxy });
  const pending = transport.sendFollowUpMessage({ role: "user", content: [{ type: "text", text: "Follow this run." }] }, { timeoutMs: 1000 });
  assert.equal(posted[0]?.method, "ui/message");
  transport.accept({ jsonrpc: "2.0", id: posted[0]!.id, error: { code: -32603, message: "ambiguous delivery" } });
  await assert.rejects(pending, /ambiguous delivery/);
  assert.equal(posted.length, 1);
  transport.dispose();
});

test("delayed host acknowledgements report safe slow diagnostics and settle their timers", async () => {
  const posted: Array<{ id: number; method: string }> = [];
  const diagnostics: Array<{ stage: string; operation: string; elapsedMs: number }> = [];
  const parent = { postMessage(message: { id: number; method: string }): void { posted.push(message); } };
  const timers = deterministicTimers();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { parent, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } });
  const transport = new RuntimeTransport({
    target: parent as unknown as WindowProxy,
    now: timers.now,
    operationPolicy: { default: { timeoutMs: 30 }, operations: { "ui/message": { timeoutMs: 30, slowAfterMs: 5 } } },
  });

  try {
    const delayed = transport.sendFollowUpMessage(
      { role: "user", content: [{ type: "text", text: "Private prompt content" }] },
      { onSlow: diagnostic => { diagnostics.push(diagnostic); throw new Error("diagnostic sinks are optional"); } },
    );
    void delayed.catch(() => undefined);
    timers.advance(5);
    assert.equal(posted.length, 1);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.stage, "slow");
    assert.equal(diagnostics[0]?.operation, "ui/message");
    assert.equal(diagnostics[0]?.elapsedMs, 5);
    assert.equal(JSON.stringify(diagnostics).includes("Private prompt content"), false);
    assert.equal(transport.accept({ jsonrpc: "2.0", id: posted[0]!.id, result: {} }), true);
    assert.deepEqual(await delayed, {});

    const settled = transport.sendFollowUpMessage(
      { role: "user", content: [{ type: "text", text: "Immediate acknowledgement" }] },
      { onSlow: diagnostic => diagnostics.push(diagnostic) },
    );
    void settled.catch(() => undefined);
    const settledMessage = posted[1]!;
    assert.equal(transport.accept({ jsonrpc: "2.0", id: settledMessage.id, result: {} }), true);
    await settled;
    timers.advance(30);
    assert.equal(diagnostics.length, 1);

    const disposed = transport.sendFollowUpMessage(
      { role: "user", content: [{ type: "text", text: "Disposed before host acknowledgement" }] },
      { onSlow: diagnostic => diagnostics.push(diagnostic) },
    );
    void disposed.catch(() => undefined);
    const disposedMessage = posted[2]!;
    transport.dispose();
    await assert.rejects(disposed, (error: unknown) => toUiTransportError(error).code === "HOST_BRIDGE_DISPOSED");
    timers.advance(30);
    assert.equal(diagnostics.length, 1);
    assert.equal(transport.accept({ jsonrpc: "2.0", id: disposedMessage.id, result: {} }), false);
  } finally {
    transport.dispose();
  }
});


test("independent transport scopes do not invalidate each other and disposal fences all results", async () => {
  const parent = { postMessage(): void {} };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { parent, setTimeout, clearTimeout } });
  const transport = new RuntimeTransport({ target: parent as unknown as WindowProxy });
  const page = transport.beginAuthoritativeRequest();
  const draft = transport.beginAuthoritativeRequest("draft");
  assert.equal(transport.isAuthoritativeRequestCurrent(page), true);
  assert.equal(transport.isAuthoritativeRequestCurrent(draft, "draft"), true);
  transport.beginAuthoritativeRequest("draft");
  assert.equal(transport.isAuthoritativeRequestCurrent(draft, "draft"), false);
  assert.equal(transport.isAuthoritativeRequestCurrent(page), true);
  const pending = transport.request("tools/call", {name:"loomex_run_get"}, {timeoutMs:1000});
  transport.dispose();
  assert.equal(transport.isAuthoritativeRequestCurrent(page), false);
  assert.throws(() => transport.beginAuthoritativeRequest(), /disposed/);
  await assert.rejects(pending, (error: unknown) => toUiTransportError(error).code === "HOST_BRIDGE_DISPOSED");
});

test("initialization uses one transport timeout and a retry supersedes an older attempt", async () => {
  const posted: Array<{ id?: number; method?: string }> = [];
  const parent = { postMessage(message: { id?: number; method?: string }): void { posted.push(message); } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { parent, setTimeout, clearTimeout } });
  const transport = new RuntimeTransport({ target: parent as unknown as WindowProxy });
  const first = transport.initialize({ protocolVersion: "2026-01-26" }, { timeoutMs: 1_000 });
  const firstMessage = posted[0];
  assert.equal(firstMessage?.method, "ui/initialize");
  const second = transport.initialize({ protocolVersion: "2026-01-26" }, { timeoutMs: 1_000 });
  const secondMessage = posted[1];
  assert.equal(secondMessage?.method, "ui/initialize");
  assert.equal(transport.accept({ jsonrpc: "2.0", id: firstMessage?.id!, result: {} }), true);
  await assert.rejects(first, /superseded/);
  assert.equal(transport.accept({ jsonrpc: "2.0", id: secondMessage?.id!, result: { hostCapabilities: {} } }), true);
  await second;
  assert.equal(transport.initializationStatus(), "ready");
});
