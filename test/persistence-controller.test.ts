import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

async function controller(options: Record<string, unknown>) {
  const context = { structuredClone, crypto, setTimeout, clearTimeout } as Record<string, any>;
  runInNewContext(await readFile("assets/loomex-persistence.js", "utf8"), context);
  const store = context.LoomexViewPersistence.create(options);
  store.configure({viewSessionId:"b3cc8197-6fbe-468a-b751-7f058af551da",revision:0});
  return store;
}

test("conflicting presentation saves retain their exact attempt and cannot overwrite a newer card", async () => {
  const attempts: unknown[][] = [];
  const store = await controller({read: async () => ({revision:1,state:{answer:"another card"}}),
    write: async (...args: unknown[]) => {attempts.push(args); throw Object.assign(new Error("conflict"),{code:"REVISION_CONFLICT"});}});
  assert.equal(await store.flush({answer:"mine"}),false);
  assert.equal(await store.flush({answer:"edited locally"}),false);
  assert.equal(attempts.length,1);
  assert.equal(attempts[0]?.[1],0);
});

test("simultaneous flushes share a failed write without an uncaught rejection", async () => {
  let fail!: (error: Error) => void;
  const pending = new Promise((_resolve,reject) => {fail=reject;});
  const store = await controller({read: async () => null, write: () => pending});
  const first = store.flush({answer:"first"});
  const second = store.flush({answer:"second"});
  fail(new Error("connection lost"));
  const outcomes = await Promise.allSettled([first,second]);
  assert.deepEqual(outcomes.map(outcome => outcome.status),["fulfilled","fulfilled"]);
  for (const outcome of outcomes) if(outcome.status === "fulfilled") assert.equal(outcome.value,false);
});


const sessionId = "b3cc8197-6fbe-468a-b751-7f058af551da";
const saved = (revision:number,state:unknown,status="active") => ({viewSessionId:sessionId,revision,state,status});

test("a lost save response retains the complete tuple including snapshotted status",async()=>{
  let status="active";
  const calls:any[]=[];
  const store=await controller({read:async()=>null,snapshot:()=>({status}),write:async(...args:any[])=>{
    calls.push(args);if(calls.length===1)throw new Error("lost response");return saved(1,args[2],args[4].status);
  }});
  assert.equal(await store.flush({position:1}),false);
  status="resolved";
  assert.equal(await store.flush(),true);
  assert.deepEqual(calls[1],calls[0]);
});

test("edits arriving during a slow save drain serially without another user action",async()=>{
  let release!:(value:unknown)=>void;
  const calls:any[]=[];
  const store=await controller({read:async()=>null,write:async(...args:any[])=>{
    calls.push(args);if(calls.length===1)return new Promise(resolve=>{release=resolve;});return saved(2,args[2]);
  }});
  const first=store.flush({answer:"first"});
  const second=store.flush({answer:"latest"});
  release(saved(1,{answer:"first"}));
  assert.deepEqual(await Promise.all([first,second]),[true,true]);
  assert.equal(calls.length,2);
  assert.deepEqual(calls.map(call=>call[1]),[0,1]);
  assert.equal(calls[1][2].answer,"latest");
  assert.equal(store.pendingState,undefined);
});

test("late hydration cannot adopt another card's revision underneath local edits",async()=>{
  let release!:(value:unknown)=>void;
  let calls=0;
  const store=await controller({debounceMs:10000,read:()=>new Promise(resolve=>{release=resolve;}),write:async()=>{calls++;return saved(3,{});}});
  const hydration=store.hydrate();
  store.markDirty({answer:"local"});
  release(saved(2,{answer:"other card"}));
  assert.equal(await hydration,null);
  assert.equal(store.session.revision,0);
  assert.equal(await store.flush(),false);
  assert.equal(calls,0);
});

test("explicit saved-version recovery clears conflict only after the read succeeds",async()=>{
  let available=false;
  const store=await controller({debounceMs:10000,read:async()=>{if(!available)throw new Error("offline");return saved(2,{answer:"remote"});},write:async()=>{throw Object.assign(new Error("conflict"),{code:"REVISION_CONFLICT"});}});
  assert.equal(await store.flush({answer:"local"}),false);
  assert.equal(await store.useSavedVersion(),null);
  assert.equal(store.pendingState.answer,"local");
  available=true;
  assert.equal((await store.useSavedVersion()).state.answer,"remote");
  assert.equal(store.conflict,null);
  assert.equal(store.pendingState,undefined);
  assert.equal(store.session.revision,2);
});
