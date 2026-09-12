import * as assert from "node:assert/strict";
import { test } from "node:test";
import { createViewPersistence, type ViewPersistenceController, type ViewPersistenceOptions } from "../src/ui-app/persistence.js";

type State = Record<string, unknown>;
type Projection = { viewSessionId: string; revision: number; state: State; status?: string };
type WriteCall = [string, number, State, string, State | undefined];
const sessionId = "b3cc8197-6fbe-468a-b751-7f058af551da";

function saved(revision: number, state: State, status = "active"): Projection {
  return { viewSessionId: sessionId, revision, state, status };
}

function controller(options: ViewPersistenceOptions<State>): ViewPersistenceController<State> {
  const store = createViewPersistence(options);
  store.configure({ viewSessionId: sessionId, revision: 0 });
  return store;
}

test("conflicting presentation saves retain their exact attempt and cannot overwrite a newer card", async () => {
  const attempts: WriteCall[] = [];
  const store = controller({
    read: async () => saved(1, { answer: "another card" }),
    write: async (...args) => {
      attempts.push(args);
      throw Object.assign(new Error("conflict"), { code: "REVISION_CONFLICT" });
    },
  });
  assert.equal(await store.flush({ answer: "mine" }), false);
  assert.equal(await store.flush({ answer: "edited locally" }), false);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.[1], 0);
});

test("simultaneous flushes share a failed write without an uncaught rejection", async () => {
  let fail: (error: Error) => void = () => undefined;
  const pending = new Promise<Projection>((_resolve, reject: (error: Error) => void) => { fail = reject; });
  const store = controller({ read: async () => null, write: () => pending });
  const first = store.flush({ answer: "first" });
  const second = store.flush({ answer: "second" });
  fail(new Error("connection lost"));
  const outcomes = await Promise.allSettled([first, second]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "fulfilled"]);
  for (const outcome of outcomes) if (outcome.status === "fulfilled") assert.equal(outcome.value, false);
});

test("a lost save response retains the complete tuple including snapshotted status", async () => {
  let status = "active";
  const calls: WriteCall[] = [];
  const store = controller({
    read: async () => null,
    snapshot: () => ({ status }),
    write: async (...args) => {
      calls.push(args);
      if (calls.length === 1) throw new Error("lost response");
      return saved(1, args[2], typeof args[4]?.status === "string" ? args[4].status : "active");
    },
  });
  assert.equal(await store.flush({ position: 1 }), false);
  status = "resolved";
  assert.equal(await store.flush(), true);
  assert.deepEqual(calls[1], calls[0]);
});

test("edits arriving during a slow save drain serially without another user action", async () => {
  let release: (value: Projection) => void = () => undefined;
  const calls: WriteCall[] = [];
  const store = controller({
    read: async () => null,
    write: async (...args) => {
      calls.push(args);
      if (calls.length === 1) return new Promise<Projection>((resolve) => { release = resolve; });
      return saved(2, args[2]);
    },
  });
  const first = store.flush({ answer: "first" });
  const second = store.flush({ answer: "latest" });
  release(saved(1, { answer: "first" }));
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call[1]), [0, 1]);
  assert.equal(calls[1]?.[2].answer, "latest");
  assert.equal(store.pendingState, undefined);
});

test("a durable status transition survives a later ordinary edit without another status request", async () => {
  let release: (value: Projection) => void = () => undefined;
  const calls: WriteCall[] = [];
  const store = controller({
    read: async () => null,
    snapshot: () => ({ status: "active" }),
    write: async (...args) => {
      calls.push(args);
      if (calls.length === 1) return new Promise<Projection>((resolve) => { release = resolve; });
      return saved(2, args[2], typeof args[4]?.status === "string" ? args[4].status : "active");
    },
  });
  const capture = store.flush({ screen: "monitor" });
  const firstStatus = store.flushStatus({ screen: "monitor" }, "resolved");
  store.markDirty({ screen: "monitor", position: 4 });
  release(saved(1, { screen: "monitor" }, "active"));
  assert.deepEqual(await Promise.all([capture, firstStatus]), [true, true]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.[1], 0);
  assert.equal(calls[1]?.[1], 1);
  assert.deepEqual(calls[1]?.[2], { screen: "monitor", position: 4 });
  assert.deepEqual(calls[1]?.[4], { status: "resolved" });
});

test("late hydration cannot adopt another card's revision underneath local edits", async () => {
  let release: (value: Projection) => void = () => undefined;
  let calls = 0;
  const store = controller({
    debounceMs: 10_000,
    read: () => new Promise<Projection>((resolve) => { release = resolve; }),
    write: async () => { calls += 1; return saved(3, {}); },
  });
  const hydration = store.hydrate();
  store.markDirty({ answer: "local" });
  release(saved(2, { answer: "other card" }));
  assert.equal(await hydration, null);
  assert.equal(store.session?.revision, 0);
  assert.equal(await store.flush(), false);
  assert.equal(calls, 0);
});

test("explicit saved-version recovery clears conflict only after the read succeeds", async () => {
  let available = false;
  const store = controller({
    debounceMs: 10_000,
    read: async () => {
      if (!available) throw new Error("offline");
      return saved(2, { answer: "remote" });
    },
    write: async () => { throw Object.assign(new Error("conflict"), { code: "REVISION_CONFLICT" }); },
  });
  assert.equal(await store.flush({ answer: "local" }), false);
  assert.equal(await store.useSavedVersion(), null);
  assert.equal(store.pendingState?.answer, "local");
  available = true;
  const projection = await store.useSavedVersion();
  assert.ok(projection);
  assert.equal(projection.state?.answer, "remote");
  assert.equal(store.conflict, null);
  assert.equal(store.pendingState, undefined);
  assert.equal(store.session?.revision, 2);
});

test("retiring an expired session ignores a delayed read and never writes a replacement", async () => {
  let release: (value: Projection) => void = () => undefined;
  let writes = 0;
  const store = controller({
    read: () => new Promise<Projection>((resolve) => { release = resolve; }),
    write: async () => { writes += 1; return saved(1, {}); },
  });
  const hydration = store.hydrate();
  store.clear();
  release(saved(1, { screen: "stale" }));
  assert.equal(await hydration, null);
  assert.equal(store.session, null);
  assert.equal(await store.flush({ screen: "fresh" }), true);
  assert.equal(writes, 0);
});
