import * as assert from "node:assert/strict";
import { test } from "node:test";
import { HostBridge } from "../src/ui-app/host-bridge.js";
import { UiTransportError } from "../src/ui-app/result-decoder.js";

test("synchronous host posting failures clear their exact pending request and both timers", async () => {
  const timers = new Map<number, () => void>();
  const callbacks: Array<() => void> = [];
  const posted: Array<{ id: number }> = [];
  let nextTimer = 0, slowCalls = 0, settlements = 0, throwing = true;
  const target = { postMessage(message: { id: number }) {
    posted.push(message);
    if (throwing) throw new Error("private host posting details");
  } };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    parent: target,
    setTimeout(callback: () => void) { callbacks.push(callback); timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id: number) { timers.delete(id); },
  } });
  const bridge = new HostBridge({ target: target as unknown as WindowProxy });
  try {
    const failed = bridge.call("ui/message", {}, { timeoutMs: 120_000, slowAfterMs: 5_000, onSlow: () => { slowCalls++; } });
    void failed.then(() => { settlements++; }, () => { settlements++; });
    await assert.rejects(failed, (error: unknown) => error instanceof UiTransportError &&
      error.code === "HOST_SEND_FAILED" && !error.message.includes("private"));
    assert.equal(timers.size, 0);
    assert.equal(bridge.accept({ jsonrpc: "2.0", id: posted[0]!.id, result: {} }), false);
    for (const callback of callbacks) callback(); // Even already queued timer callbacks are fenced.
    assert.equal(slowCalls, 0);
    assert.equal(settlements, 1);

    throwing = false;
    const healthy = bridge.call("tools/call", {}, { timeoutMs: 1_000 });
    assert.equal(timers.size, 1);
    assert.equal(bridge.accept({ jsonrpc: "2.0", id: posted[1]!.id, result: { recovered: true } }), true);
    assert.deepEqual(await healthy, { recovered: true });
    bridge.dispose();
    assert.equal(timers.size, 0);
    assert.equal(bridge.accept({ jsonrpc: "2.0", id: posted[0]!.id, result: {} }), false);
    assert.equal(posted.length, 2);
  } finally {
    bridge.dispose();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("posting failure leaves an independent pending request intact", async () => {
  const posted: Array<{ id: number }> = [];
  let throwing = false;
  const target = { postMessage(message: { id: number }) { posted.push(message); if (throwing) throw new Error("synthetic posting failure"); } };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { parent: target, setTimeout, clearTimeout } });
  const bridge = new HostBridge({ target: target as unknown as WindowProxy });
  try {
    const first = bridge.call("tools/call", {}, { timeoutMs: 1000 });
    throwing = true;
    await assert.rejects(bridge.call("ui/message", {}, { timeoutMs: 1000 }), error => error instanceof UiTransportError && error.code === "HOST_SEND_FAILED");
    assert.equal(bridge.accept({ jsonrpc: "2.0", id: posted[1]!.id, result: {} }), false);
    assert.equal(bridge.accept({ jsonrpc: "2.0", id: posted[0]!.id, result: "first receipt" }), true);
    assert.equal(await first, "first receipt");
  } finally {
    bridge.dispose();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

for (const action of ["accept", "dispose"]) test(`a posting adapter that ${action}s then throws cannot settle the request twice`, async () => {
  let bridge!: HostBridge, settlements = 0;
  const target = { postMessage(message: { id: number }) {
    if (action === "accept") bridge.accept({ jsonrpc: "2.0", id: message.id, result: "receipt" });
    else bridge.dispose();
    throw new Error("synthetic error after settlement");
  } };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { parent: target, setTimeout, clearTimeout } });
  bridge = new HostBridge({ target: target as unknown as WindowProxy });
  try {
    const request = bridge.call("ui/message", {}, { timeoutMs: 1000 });
    void request.then(() => { settlements++; }, () => { settlements++; });
    if (action === "accept") assert.equal(await request, "receipt");
    else await assert.rejects(request, error => error instanceof UiTransportError && error.code === "HOST_BRIDGE_DISPOSED");
    assert.equal(settlements, 1);
    assert.equal(bridge.accept({ jsonrpc: "2.0", id: 1, result: "stale" }), false);
  } finally {
    bridge.dispose();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
