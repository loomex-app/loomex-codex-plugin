import * as assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeTransport } from "../src/ui-app/runtime-transport.js";
import { HostBridge } from "../src/ui-app/host-bridge.js";
import { RequestFence } from "../src/ui-app/lifecycle.js";
import { decodeUiError, toUiTransportError } from "../src/ui-app/result-decoder.js";

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

test("host bridge accepts only its target window and releases pending calls on disposal", async () => {
  const posted: unknown[] = [];
  const parent = { postMessage(message: unknown): void { posted.push(message); } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { parent, setTimeout, clearTimeout } });
  const bridge = new HostBridge({ target: parent as unknown as WindowProxy });
  const request = bridge.call("tools/call", { name: "loomex_run_get" }, 1_000);
  const message = posted[0] as { id: number } | undefined;
  assert.ok(message);
  assert.equal(bridge.acceptEvent({ source: {} as MessageEventSource, data: { jsonrpc: "2.0", id: message.id, result: { unsafe: true } } } as MessageEvent<unknown>), false);
  assert.equal(bridge.accept({ jsonrpc: "2.0", id: message.id, error: { code: "RUNNER_BUSY", message: "Try again.", retryable: true, correlationId: "corr-2" } }), true);
  await assert.rejects(request, (error: unknown) => {
    const typed = toUiTransportError(error);
    return typed.code === "RUNNER_BUSY" && typed.retryable === true && typed.correlationId === "corr-2";
  });

  const pending = bridge.call("tools/call", { name: "loomex_run_get" }, 1_000);
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
