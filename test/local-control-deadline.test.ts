import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { build, stop } from "esbuild";
import type { LocalControlClient } from "../src/local-control.js";

// Exercise the actual transport with synthetic OS adapters; no real runner or
// socket is contacted, and production dependency injection is unnecessary.
let transportSource = "";
before(async () => {
  const result = await build({ entryPoints: [resolve("src/local-control.ts")], bundle: true, write: false,
    platform: "node", format: "cjs", target: "node24", plugins: [{ name: "transport-os-fixture", setup(builder) {
      builder.onResolve({ filter: /^node:(fs\/promises|net|perf_hooks)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents:
        args.path === "node:fs/promises" ? "export const lstat = path => __transportFixture.lstat(path);" :
        args.path === "node:net" ? "export const createConnection = path => __transportFixture.connect(path);" :
        "export const performance = { now: () => __transportFixture.now ?? globalThis.performance.now() };", loader: "js" }));
    } }] });
  transportSource = result.outputFiles[0]!.text;
});

after(async () => { await stop(); });

type Frame = { protocol: string; id: string; method: string; params: Record<string, unknown> };
class SyntheticSocket extends EventEmitter {
  destroyed = false;
  constructor(readonly onWrite: (frame: Frame, socket: SyntheticSocket) => void) { super(); }
  setNoDelay(): void {}
  write(frame: string): void { this.onWrite(JSON.parse(frame) as Frame, this); }
  destroy(): void { this.destroyed = true; }
  negotiate(frame: Frame): void {
    this.emit("data", Buffer.from(JSON.stringify({ protocol: frame.protocol, id: frame.id, result: {
      selectedProtocol: frame.protocol, capabilities: frame.params.requiredCapabilities,
      maxFrameBytes: 1024 * 1024, serverVersion: "0.1.0",
    } }) + "\n"));
  }
}
function fixture() {
  const sockets: SyntheticSocket[] = [], frames: Frame[] = [];
  const state = { now: undefined as number | undefined, wallNow: undefined as number | undefined,
    setTimer: undefined as ((callback: () => void, timeoutMs: number) => NodeJS.Timeout) | undefined,
    clearTimer: undefined as ((timer: NodeJS.Timeout) => void) | undefined,
    afterDecode: (_decoded: unknown): void => {},
    owner: async (_path: string): Promise<void> => {},
    onConnect: (socket: SyntheticSocket) => { queueMicrotask(() => socket.emit("connect")); },
    onWrite: (frame: Frame, socket: SyntheticSocket) => { if (frame.method === "protocol.negotiate") queueMicrotask(() => socket.negotiate(frame)); },
    lstat: async (path: string) => { await state.owner(path); return { uid: process.geteuid!(), mode: 0o700,
      isDirectory: () => true, isSocket: () => true }; },
    connect: (_path: string) => { const socket = new SyntheticSocket((frame, socket) => { frames.push(frame); state.onWrite(frame, socket); });
      sockets.push(socket); state.onConnect(socket); return socket; },
  };
  const module = { exports: {} as { LocalControlClient: new () => LocalControlClient } };
  class FixtureDate extends Date { static override now(): number { return state.wallNow ?? Date.now(); } }
  const fixtureJson = Object.create(JSON) as typeof JSON;
  fixtureJson.parse = (text, reviver) => { const decoded: unknown = JSON.parse(text, reviver); state.afterDecode(decoded); return decoded; };
  new Function("require", "module", "exports", "__transportFixture", "Date", "setTimeout", "clearTimeout", "JSON", transportSource)(
    createRequire(import.meta.url), module, module.exports, state, FixtureDate,
    (callback: () => void, timeoutMs: number) => state.setTimer ? state.setTimer(callback, timeoutMs) : setTimeout(callback, timeoutMs),
    (timer: NodeJS.Timeout) => state.clearTimer ? state.clearTimer(timer) : clearTimeout(timer),
    fixtureJson,
  );
  return { state, sockets, frames, client: new module.exports.LocalControlClient() };
}
function keepAlive(context: { after: (callback: () => void) => void }): void {
  const timer = setInterval(() => {}, 1000);
  context.after(() => clearInterval(timer));
}
function errorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

for (const mutating of [false, true]) test(`ownership wait is bounded before a ${mutating ? "mutation" : "read"} connects`, async context => {
  keepAlive(context);
  const f = fixture();
  let release!: () => void;
  const ownership = new Promise<void>(resolve => { release = resolve; });
  f.state.owner = async () => ownership;
  let settled = false;
  const call = f.client.call("status.get", {}, { mutating, timeoutMs: 20 });
  void call.finally(() => { settled = true; }).catch(() => {});
  await delay(50);
  const settledBeforeOwner = settled;
  release();
  await assert.rejects(call, error => errorCode(error, "RUNNER_UNAVAILABLE"));
  await delay(5);
  assert.equal(settledBeforeOwner, true, "deadline must settle while OS ownership work remains outstanding");
  assert.equal(f.sockets.length, 0, "late ownership completion cannot connect");
  assert.equal(f.frames.length, 0);
});

test("abort settles during ownership verification and late completion cannot connect", async context => {
  keepAlive(context);
  const f = fixture(), controller = new AbortController();
  let release!: () => void;
  const ownership = new Promise<void>(resolve => { release = resolve; });
  f.state.owner = async () => ownership;
  let settled = false;
  const call = f.client.call("status.get", {}, { mutating: true, timeoutMs: 1000, signal: controller.signal });
  void call.finally(() => { settled = true; }).catch(() => {});
  controller.abort();
  await delay(5);
  const settledBeforeOwner = settled;
  release();
  await assert.rejects(call, error => errorCode(error, "CANCELLED"));
  assert.equal(settledBeforeOwner, true);
  assert.equal(f.sockets.length, 0);
});

for (const phase of ["owner", "connect", "negotiation"]) test(`monotonic deadline fences ${phase} completion before action send`, async context => {
  keepAlive(context);
  const f = fixture();
  f.state.now = 0;
  if (phase === "owner") f.state.owner = async () => { f.state.now = 31; };
  if (phase === "connect") f.state.onConnect = socket => { queueMicrotask(() => { f.state.now = 31; socket.emit("connect"); }); };
  if (phase === "negotiation") f.state.onWrite = (frame, socket) => { queueMicrotask(() => { f.state.now = 31; socket.negotiate(frame); }); };
  await assert.rejects(f.client.call("status.get", {}, { mutating: true, timeoutMs: 30 }), error => errorCode(error, "RUNNER_UNAVAILABLE"));
  assert.equal(f.frames.filter(frame => frame.method === "status.get").length, 0);
  assert.equal(f.sockets.length, phase === "owner" ? 0 : 1);
  if (phase === "connect") assert.equal(f.frames.length, 0);
});

test("a read retry shares its ownership deadline and preserves the first sent request identity", async context => {
  keepAlive(context);
  const f = fixture();
  f.state.now = 0;
  f.state.owner = async () => { if (f.sockets.length === 1) f.state.now = 31; };
  f.state.onWrite = (frame, socket) => { queueMicrotask(() => {
    if (frame.method === "protocol.negotiate") socket.negotiate(frame);
    else { f.state.now = 15; socket.emit("error", new Error("synthetic read connection lost")); }
  }); };
  await assert.rejects(f.client.call("status.get", {}, { mutating: false, timeoutMs: 30 }), error =>
    errorCode(error, "RUNNER_RESPONSE_UNAVAILABLE") && "requestId" in (error as object) &&
    (error as { requestId: string }).requestId === f.frames.find(frame => frame.method === "status.get")?.id);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.frames.length, 2);
});

test("a sent mutation deadline preserves its ambiguous identity without replay", async context => {
  keepAlive(context);
  const f = fixture(), idempotencyKey = "07586a1b-18e0-471e-83c9-06ac38611a9a";
  await assert.rejects(f.client.call("workflows.create", { name: "Deadline fixture", idempotencyKey }, { mutating: true, timeoutMs: 20 }), error =>
    errorCode(error, "NETWORK_AMBIGUOUS") && "idempotencyKey" in (error as object) &&
    (error as { idempotencyKey: string }).idempotencyKey === idempotencyKey);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.frames.filter(frame => frame.method === "workflows.create").length, 1);
});

test("a backwards wall-clock jump cannot extend a read's retry budget", async context => {
  keepAlive(context);
  const f = fixture();
  f.state.now = 0;
  f.state.wallNow = 1000;
  f.state.onWrite = (frame, socket) => { queueMicrotask(() => {
    if (frame.method === "protocol.negotiate") socket.negotiate(frame);
    else { f.state.now = 31; f.state.wallNow = 0; socket.emit("error", new Error("synthetic expired read")); }
  }); };
  await assert.rejects(f.client.call("status.get", {}, { mutating: false, timeoutMs: 30 }), error => errorCode(error, "RUNNER_RESPONSE_UNAVAILABLE"));
  assert.equal(f.sockets.length, 1);
});

for (const mutating of [false, true]) test(`a ${mutating ? "mutation" : "read"} response observed after the deadline remains uncertain`, async context => {
  keepAlive(context);
  const f = fixture(), idempotencyKey = "07586a1b-18e0-471e-83c9-06ac38611a9a";
  f.state.now = 0;
  f.state.onWrite = (frame, socket) => { queueMicrotask(() => {
    if (frame.method === "protocol.negotiate") socket.negotiate(frame);
    else {
      f.state.now = 31;
      socket.emit("data", Buffer.from(JSON.stringify({ protocol: frame.protocol, id: frame.id, result: {
        version: "0.1.0", protocol: frame.protocol, activeJobs: 0, draining: false, updateDeferred: false,
      } }) + "\n"));
    }
  }); };
  await assert.rejects(f.client.call("status.get", mutating ? { idempotencyKey } : {}, { mutating, timeoutMs: 30 }), error =>
    errorCode(error, mutating ? "NETWORK_AMBIGUOUS" : "RUNNER_RESPONSE_UNAVAILABLE"));
  assert.equal(f.sockets.length, 1);
  assert.equal(f.frames.length, 2);
});

test("late ownership rejection is consumed after a deadline without starting transport", async context => {
  keepAlive(context);
  const f = fixture();
  let rejectOwner!: (error: Error) => void;
  const ownership = new Promise<void>((_resolve, reject) => { rejectOwner = reject; });
  f.state.owner = async () => ownership;
  await assert.rejects(f.client.call("status.get", {}, { mutating: true, timeoutMs: 10 }), error => errorCode(error, "RUNNER_UNAVAILABLE"));
  rejectOwner(new Error("synthetic late filesystem failure"));
  await delay(5);
  assert.equal(f.sockets.length, 0);
});

test("an early timer wakeup waits for the monotonic deadline without creating a read retry", async () => {
  const f = fixture(), timers = new Map<NodeJS.Timeout, () => void>();
  f.state.now = 0;
  f.state.setTimer = callback => { const timer = { unref() {} } as NodeJS.Timeout; timers.set(timer, callback); return timer; };
  f.state.clearTimer = timer => { timers.delete(timer); };
  const fireNextTimer = (): void => {
    const [timer, callback] = timers.entries().next().value!;
    timers.delete(timer);
    callback();
  };
  let settled = false;
  const call = f.client.call("status.get", {}, { mutating: false, timeoutMs: 20 });
  void call.finally(() => { settled = true; }).catch(() => {});
  await delay(0);
  assert.equal(f.frames.length, 2);
  f.state.now = 19;
  fireNextTimer();
  await delay(0);
  assert.equal(settled, false);
  assert.equal(f.sockets.length, 1);
  f.state.now = 20;
  fireNextTimer();
  await assert.rejects(call, error => errorCode(error, "RUNNER_RESPONSE_UNAVAILABLE"));
  assert.equal(f.sockets.length, 1);
  assert.equal(timers.size, 0);
});

for (const mutating of [false, true]) for (const outcome of ["error", "success"]) for (const interruption of ["deadline", "abort"]) {
  test(`decoding a ${mutating ? "mutation" : "read"} ${outcome} response across ${interruption} preserves uncertainty`, async context => {
    keepAlive(context);
    const f = fixture(), controller = new AbortController(), idempotencyKey = "07586a1b-18e0-471e-83c9-06ac38611a9a";
    f.state.now = 0;
    f.state.afterDecode = () => {
      if (f.frames.length !== 2) return;
      if (interruption === "deadline") f.state.now = 31;
      else controller.abort();
    };
    f.state.onWrite = (frame, socket) => { queueMicrotask(() => {
      if (frame.method === "protocol.negotiate") socket.negotiate(frame);
      else socket.emit("data", Buffer.from(JSON.stringify({ protocol: frame.protocol, id: frame.id,
        ...(outcome === "error" ? { error: { code: "INVALID_ARGUMENT", message: "fixture", correlationId: "fixture", retryable: false } } :
          { result: { version: "0.1.0", protocol: frame.protocol, activeJobs: 0, draining: false, updateDeferred: false } }),
      }) + "\n"));
    }); };
    const expectedCode = mutating ? "NETWORK_AMBIGUOUS" : interruption === "deadline" ? "RUNNER_RESPONSE_UNAVAILABLE" : "CANCELLED";
    await assert.rejects(f.client.call("status.get", mutating ? { idempotencyKey } : {},
      { mutating, timeoutMs: 30, signal: controller.signal }), error => errorCode(error, expectedCode) &&
        "requestId" in (error as object) && (error as { requestId: string }).requestId === f.frames[1]?.id &&
        (!mutating || "idempotencyKey" in (error as object) && (error as { idempotencyKey: string }).idempotencyKey === idempotencyKey));
    assert.equal(f.sockets.length, 1);
    assert.equal(f.frames.length, 2);
  });
}
