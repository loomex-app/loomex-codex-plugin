import * as assert from "node:assert/strict";
import { test } from "node:test";
import { createViewPersistence, ViewRestorationCoordinator, type ViewPersistenceController, type ViewPersistenceOptions } from "../src/ui-app/persistence.js";

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

test("accepted request quiesces an in-flight view save and adopts only its resolved projection", async () => {
  let rejectWrite: (error: Error) => void = () => undefined;
  const calls: WriteCall[] = [];
  const statuses: string[] = [];
  const store = controller({
    read: async () => saved(3, { screen: "interaction" }, "resolved"),
    write: (...args) => {
      calls.push(args);
      return new Promise<Projection>((_resolve, reject) => { rejectWrite = reject; });
    },
    onStatus: status => { statuses.push(status); },
  });
  const pending = store.flush({ screen: "interaction", phase: "review" });
  assert.equal(calls.length, 1);
  const epoch = store.quiesceAcceptedSession(sessionId);
  assert.ok(epoch !== null);
  assert.equal(store.acceptedSession(sessionId), true);
  rejectWrite(Object.assign(new Error("late conflict"), { code: "REVISION_CONFLICT" }));
  assert.equal(await pending, false);
  assert.equal(statuses.includes("save_failed"), false, "a pre-acceptance failure cannot dirty the accepted card");
  assert.equal(await store.flush({ screen: "interaction", phase: "review" }), false);
  assert.equal(calls.length, 1, "acceptance never replays the stale presentation mutation");
  assert.equal(store.adoptResolvedSession(saved(3, { screen: "interaction" }, "resolved"), epoch), true);
  assert.equal(store.session?.revision, 3);
  assert.equal(store.adoptResolvedSession(saved(2, { screen: "interaction" }, "resolved"), epoch), false);
  store.configure(saved(4, { screen: "other" }));
  assert.equal(store.acceptedSession(sessionId), true, "the exact accepted session remains read-only");
});

test("accepted request does not discard an editable conflict on another session", async () => {
  const otherSessionId = "7364a198-b7d6-4d3f-8c03-0c7d4e292cfb";
  const store = controller({
    read: async () => null,
    write: async () => { throw Object.assign(new Error("conflict"), { code: "REVISION_CONFLICT" }); },
  });
  assert.equal(await store.flush({ position: "local" }), false);
  assert.equal(store.quiesceAcceptedSession(otherSessionId), null);
  assert.equal(store.pendingState?.position, "local");
  assert.ok(store.attempt);
  assert.ok(store.conflict);
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

test("an acknowledged presentation state is not rewritten before an unrelated mutation", async () => {
  const calls: WriteCall[] = [];
  const store = createViewPersistence<State>({
    read: async () => saved(7, { screen: "interaction", phase: "review" }),
    write: async (...args) => {
      calls.push(args);
      return saved(args[1] + 1, args[2], typeof args[4]?.status === "string" ? args[4].status : "active");
    },
  });
  store.configure(saved(7, { screen: "interaction", phase: "review" }));

  assert.equal(await store.flush({ screen: "interaction", phase: "review" }), true);
  store.markDirty({ screen: "interaction", phase: "review" });
  assert.equal(await store.flush(), true);
  assert.equal(calls.length, 0, "a submit-time presentation flush must not manufacture a new revision");

  assert.equal(await store.flushStatus({ screen: "interaction", phase: "review" }, "resolved"), true);
  assert.equal(calls.length, 1, "a real lifecycle transition remains durable");
  assert.equal(calls[0]?.[1], 7);
  assert.deepEqual(calls[0]?.[4], { status: "resolved" });
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

test("staged saved-view recovery preserves local state until the verified snapshot is adopted", async () => {
  const store = controller({
    read: async () => saved(2, { answer: "server" }),
    write: async () => { throw Object.assign(new Error("conflict"), { code: "REVISION_CONFLICT" }); },
  });
  assert.equal(await store.flush({ answer: "local" }), false);
  const prepared = await store.prepareSavedVersion();
  assert.ok(prepared);
  assert.equal(store.pendingState?.answer, "local");
  assert.ok(store.conflict);
  assert.equal(store.adoptSavedVersion(prepared)?.state?.answer, "server");
  assert.equal(store.pendingState, undefined);
  assert.equal(store.conflict, null);
});

test("a mismatched ambiguous view write cannot be discarded by saved-version recovery", async () => {
  const store = controller({
    read: async () => saved(2, { answer: "unrelated remote" }),
    write: async () => { throw Object.assign(new Error("unknown receipt"), { code: "NETWORK_AMBIGUOUS" }); },
  });
  assert.equal(await store.flush({ answer: "possibly written" }), false);
  assert.equal(await store.prepareSavedVersion(), null);
  assert.equal(store.pendingState?.answer, "possibly written");
  assert.ok(store.attempt);
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

test("a restoration displays the owner-checked snapshot before independent verification completes", async () => {
  const phases: string[] = [];
  let releaseVerification: (phase: "ready" | "read_only") => void = () => undefined;
  const coordinator = new ViewRestorationCoordinator({ onPhase: (state) => { phases.push(state.phase); } });
  const begun = coordinator.begin("saved-card", {
    snapshot: async () => ({ screen: "monitor" }),
    display: (snapshot) => { assert.equal(snapshot.screen, "monitor"); return "read_only"; },
    verify: () => new Promise<"ready" | "read_only">((resolve) => { releaseVerification = resolve; }),
    failed: () => assert.fail("the saved snapshot should remain readable"),
  });
  assert.equal(await begun, true);
  assert.deepEqual(phases, ["loading_snapshot", "verifying"]);
  releaseVerification("ready");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(phases, ["loading_snapshot", "verifying", "ready"]);
});

test("request fences isolate unrelated verification reads", async () => {
  let captured = "";
  const coordinator = new ViewRestorationCoordinator({ onPhase: (state) => { captured = state.phase; } });
  await coordinator.begin("card", {
    snapshot: async () => ({ id: "saved" }),
    display: () => "verifying",
    verify: async (_snapshot, fence) => {
      const first = fence.request("interaction");
      const other = fence.request("journal");
      const newer = fence.request("interaction");
      assert.equal(fence.currentRequest(first), false);
      assert.equal(fence.currentRequest(other), true);
      assert.equal(fence.currentRequest(newer), true);
      return "ready";
    },
    failed: () => assert.fail("verification should succeed"),
  });
  await Promise.resolve();
  assert.equal(captured, "ready");
});

test("verification timeout preserves the displayed snapshot and identifies the retry section", async () => {
  const phases: string[] = [];
  let failedSection = "";
  let finished!:()=>void;
  const failure=new Promise<void>(resolve=>{finished=resolve;});
  const coordinator = new ViewRestorationCoordinator({
    verificationTimeoutMs: 2,
    onPhase: (state) => { phases.push(state.phase); },
  });
  assert.equal(await coordinator.begin("card", {
    snapshot: async () => ({ screen: "monitor" }),
    display: () => "read_only",
    verify: () => new Promise<"ready" | "read_only">(() => undefined),
    failed: (section) => { failedSection = section; finished(); },
  }), true);
  await failure;
  assert.deepEqual(phases, ["loading_snapshot", "verifying", "verification_failed"]);
  assert.equal(failedSection, "verification");
  assert.equal(coordinator.state.failedSection, "verification");
});

test("restore snapshots do not adopt a revision before authoritative hydration", async () => {
  const store = controller({
    restore: async () => saved(2, { screen: "cached" }),
    read: async () => saved(3, { screen: "authoritative" }),
    write: async () => saved(4, {}),
  });
  const snapshot = await store.restoreSnapshot();
  assert.equal(snapshot?.revision, 2);
  assert.equal(store.session?.revision, 0);
  const authoritative = await store.hydrate();
  assert.equal(authoritative?.revision, 3);
  assert.equal(store.session?.revision, 3);
});

test("explicit reapplication uses the newly read revision and retains local edits on another conflict",async()=>{
 let remote=saved(2,{screen:"setup",answer:"remote"});let reject=true;
 const store=createViewPersistence<State>({read:async()=>remote,write:async(id,revision,state)=>{
   assert.equal(revision,reject?1:2);
   if(reject)throw Object.assign(new Error("conflict"),{code:"REVISION_CONFLICT"});
   remote=saved(3,state);return remote;
 }});
 store.configure(saved(1,{screen:"setup",answer:"before"}));store.markDirty({screen:"setup",answer:"local"});
 assert.equal(await store.flush(),false);assert.equal(store.pendingState?.answer,"local");reject=false;
 assert.equal(await store.reapplyLocal((saved,local)=>({...saved,answer:local.answer})),true);
 assert.equal(remote.state?.answer,"local");assert.equal(store.conflict,null);
});

test("a clean presentation verifies an identical newer snapshot before generating its write tuple", async () => {
  const calls: WriteCall[] = [];
  let remote = saved(2, { screen: "review", preparationId: "original" });
  const store = createViewPersistence<State>({ read: async () => structuredClone(remote), write: async (...args) => {
    calls.push(args); remote = saved(3, args[2]); return remote;
  } });
  store.configure(saved(1, { screen: "review", preparationId: "original" }));
  assert.equal(await store.flush({ screen: "review", preparationId: "original", readingPosition: { top: 0 } }, true), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![1], 2, "verification precedes creation of the exact revision/key tuple");
  assert.equal(store.session?.revision, 3);
  assert.equal(store.conflict, null);
});

test("a consequential clean no-op verifies the latest identical revision without manufacturing a view write", async () => {
  const state = { screen: "review", preparationId: "original" };
  let writes = 0;
  let reads = 0;
  const store = createViewPersistence<State>({ read: async () => { reads++; return saved(2, state); },
    write: async () => { writes++; return saved(3, state); } });
  store.configure(saved(1, state));
  assert.equal(await store.flush(state, true), true);
  assert.equal(reads, 1);
  assert.equal(writes, 0);
  assert.equal(store.session?.revision, 2);
  assert.equal(store.attempt, null);
  assert.equal(store.dirty(), false);
});

test("ordinary clean navigation saves retain their existing behavior around a pending operation", async () => {
  const remote = { ...saved(1, { screen: "setup" }), operation: { operationId: "workspace-check", status: "pending" } };
  let reads = 0;
  const writes: WriteCall[] = [];
  const store = createViewPersistence<State>({ read: async () => { reads++; return remote; }, write: async (...args) => {
    writes.push(args); return { ...remote, revision: 2, state: args[2] };
  } });
  store.configure(remote);
  assert.equal(await store.flush({ screen: "setup", position: 1 }), true);
  assert.equal(reads, 0, "read-only navigation is not a consequential mutation boundary");
  assert.equal(writes.length, 1);
  assert.equal(remote.operation.operationId, "workspace-check");
});

test("clean snapshot verification rejects changed state, status, binding and unresolved operations", async () => {
  for (const replacement of [
    saved(2, { screen: "review", preparationId: "different" }),
    saved(2, { screen: "review", preparationId: "original" }, "inactive"),
    { ...saved(2, { screen: "review", preparationId: "original" }), entityId: "substituted" },
    { ...saved(2, { screen: "review", preparationId: "original" }), operation: { operationId: "original-operation", status: "ambiguous" } },
  ]) {
    for (const noOp of [false, true]) {
    const before = structuredClone(replacement);
    let writes = 0;
    const store = createViewPersistence<State>({ read: async () => replacement, write: async () => { writes++; return replacement; } });
    store.configure(saved(1, { screen: "review", preparationId: "original" }));
    assert.equal(await store.flush({ screen: "review", preparationId: "original", ...(noOp ? {} : { localDisplay: true }) }, true), false);
    assert.equal(store.session?.revision, 1);
    assert.ok(store.conflict);
    assert.equal(writes, 0);
    assert.equal(store.pendingState?.localDisplay, noOp ? undefined : true);
    assert.deepEqual(replacement, before);
    }
  }
});

test("local edits retain the rejected exact save tuple instead of adopting another card's identical revision", async () => {
  const remote = saved(2, { screen: "review", answer: "before" });
  const calls: WriteCall[] = [];
  let reads = 0;
  const store = createViewPersistence<State>({ read: async () => { reads++; return remote; }, write: async (...args) => {
    calls.push(args); throw Object.assign(new Error("conflict"), { code: "REVISION_CONFLICT" });
  } });
  store.configure(saved(1, { screen: "review", answer: "before" }));
  store.markDirty({ screen: "review", answer: "local" });
  assert.equal(await store.flush(undefined, true), false);
  const attempt = store.attempt;
  assert.equal(await store.flush(undefined, true), false);
  assert.equal(reads, 0, "dirty edits need explicit saved-version recovery");
  assert.equal(calls.length, 1);
  assert.equal(store.attempt, attempt, "a rejected save retains the original attempt, including its diagnostic");
  assert.equal(store.pendingState?.answer, "local");
});

test("an ambiguous save keeps its original revision and key after another revision becomes readable", async () => {
  let remote = saved(1, { screen: "review" });
  const calls: WriteCall[] = [];
  let reads = 0;
  const store = createViewPersistence<State>({ read: async () => { reads++; return remote; }, write: async (...args) => {
    calls.push(args); throw Object.assign(new Error("unknown write outcome"), { code: "NETWORK_AMBIGUOUS" });
  } });
  store.configure(remote);
  assert.equal(await store.flush({ screen: "review", position: 1 }, true), false);
  remote = saved(2, { screen: "review" });
  assert.equal(await store.flush(), false);
  assert.equal(reads, 1);
  assert.deepEqual(calls[1], calls[0], "no fresh revision or key can replace an unresolved exact tuple");
});

test("late clean snapshot reads cannot adopt a replacement card or overwrite edits made during verification", async () => {
  for (const replaceCard of [true, false]) {
    let release!: (value: Projection) => void;
    let writes = 0;
    const store = createViewPersistence<State>({ read: () => new Promise(resolve => { release = resolve; }),
      write: async () => { writes++; return saved(3, {}); } });
    store.configure(saved(1, { screen: "review" }));
    const flushing = store.flush({ screen: "review", position: 0 }, true);
    if (replaceCard) store.configure({ viewSessionId: "replacement-card", revision: 9, state: { screen: "other" } });
    else store.markDirty({ screen: "review", position: 5 });
    release(saved(2, { screen: "review" }));
    assert.equal(await flushing, false);
    assert.equal(writes, 0);
    assert.equal(store.session?.revision, replaceCard ? 9 : 1);
    if (!replaceCard) assert.equal(store.pendingState?.position, 5);
    store.clear();
  }
});
