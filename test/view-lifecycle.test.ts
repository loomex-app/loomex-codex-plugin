import {test} from "node:test";
import * as assert from "node:assert/strict";
import {ViewRestorationCoordinator, type ViewLifecycleAdapter} from "../src/ui-app/persistence.js";
import {restorationSurface} from "../src/ui-app/runtime-shell.js";
import type {UiMode} from "../src/ui-app/contracts.js";

const modes:UiMode[]=["browser","runs","connection","organizations","prepare","monitor","interaction","authoring"];
const deferred=<T>()=>{let resolve!:(value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const until=async(check:()=>boolean)=>{for(let i=0;i<100;i++){if(check())return;await new Promise<void>(r=>setImmediate(r));}assert.ok(check());};
for(const mode of modes) test(`${mode}: lifecycle conformance, independent storage and completion, ordered restoration and disposal`,async()=>{
 const view=new ViewRestorationCoordinator();
 const snapshot=deferred<{safe:string}>(), authority=deferred<"ready"|"read_only">();
 const events:string[]=[];
 const adapter:ViewLifecycleAdapter<{safe:string}>={mode,identity:"card:entity",domainIdentity:"entity",snapshot:()=>snapshot.promise,
 display:()=>{events.push("display");},verify:async()=>{events.push("authority");return authority.promise;},
 reconcile:async()=>{events.push("journal");},restoreDraft:async()=>{events.push("draft");},
 project:async()=>{events.push("project");return "ready";},failed:()=>assert.fail("unexpected failure"),cleanup:()=>events.push("dispose")};
 const opening=view.open(adapter);
 assert.equal(view.state.phase,"loading_snapshot");assert.equal(view.permissions().edit,false);
 snapshot.resolve({safe:"display"});await opening;
 assert.equal(view.state.phase,"verifying");assert.equal(view.permissions().mutate,false);
 authority.resolve("ready");await until(()=>view.state.phase==="ready");
 assert.deepEqual(events,["display","authority","journal","draft","project"]);
 assert.equal(view.permissions("another-card").mutate,false);
 view.persistence("save_failed");assert.equal(view.permissions().navigate,true);assert.equal(view.permissions().edit,true);assert.equal(view.permissions().mutate,false);assert.equal(view.permissions().retryPersistence,true);
 view.persistence("saved");assert.equal(view.permissions().mutate,true);
 const list=view.request("list"),draft=view.request("draft");view.request("list");assert.equal(list.current(),false);assert.equal(draft.current(),true);
 view.complete();view.persistence("save_failed");assert.equal(view.permissions().edit,false);assert.equal(view.permissions().retryPersistence,false);
 view.dispose();assert.equal(draft.current(),false);assert.equal(view.permissions().navigate,false);assert.equal(events.at(-1),"dispose");
});

test("verification timeout invalidates late domain responses and a fresh open recovers",async()=>{
 const view=new ViewRestorationCoordinator({verificationTimeoutMs:5});const late=deferred<void>();let applied=false;const failed=deferred<void>();
 const adapter:ViewLifecycleAdapter<{}>={mode:"interaction",identity:"card:request:a",domainIdentity:"request:a",snapshot:async()=>({}),display:()=>{},verify:async(_,fence)=>{await late.promise;if(fence.current())applied=true;return "ready";},failed:()=>failed.resolve()};
 await view.open(adapter);await failed.promise;late.resolve();await new Promise<void>(r=>setImmediate(r));assert.equal(applied,false);assert.equal(view.state.phase,"verification_failed");
 await view.open({...adapter,verify:async()=>"ready"});await until(()=>view.state.phase==="ready");view.dispose();
});

test("resolved authority never restores editable drafts even when presentation writes failed",async()=>{
 const view=new ViewRestorationCoordinator();let draft=false,journal=false;
 await view.open({mode:"interaction",identity:"resolved",domainIdentity:"request",snapshot:async()=>({}),display:()=>{},verify:async()=>"read_only",reconcile:async()=>{journal=true;},restoreDraft:async()=>{draft=true;},failed:()=>assert.fail()});
 await until(()=>view.state.phase==="read_only");view.persistence("save_failed");assert.equal(journal,true);assert.equal(draft,false);assert.equal(view.permissions().mutate,false);view.dispose();
});

test("disposed refresh settles locally and cannot apply a late response",async()=>{
 const view=new ViewRestorationCoordinator();const response=deferred<string>();let applied=false;
 const pending=view.refresh("list",()=>response.promise,()=>{applied=true;});view.dispose();assert.equal(await pending,false);response.resolve("late");await new Promise<void>(r=>setImmediate(r));assert.equal(applied,false);
});

test("a successful draft save cannot conceal a presentation conflict",async()=>{
 const view=new ViewRestorationCoordinator();
 view.persistence("save_failed",Object.assign(new Error("conflict"),{code:"REVISION_CONFLICT"}),"presentation");
 view.persistence("saved",undefined,"draft");assert.equal(view.state.persistence,"conflicted");
 view.persistence("saved",undefined,"presentation");assert.equal(view.state.persistence,"clean");view.dispose();
});

test("a cached completed projection never enables actions before verification",async()=>{
 const view=new ViewRestorationCoordinator();const done=deferred<"ready">();
 await view.open({mode:"prepare",identity:"card",domainIdentity:"entity",snapshot:async()=>({}),display:()=>"read_only",verify:()=>done.promise,failed:()=>assert.fail()});
 assert.equal(view.permissions().authority,false);assert.equal(view.permissions().mutate,false);done.resolve("ready");await until(()=>view.state.phase==="ready");view.dispose();
});

test("initial restoration stays skeletal unless a cached read-only projection is visible",async()=>{
 const view=new ViewRestorationCoordinator();const authority=deferred<"ready">();let cachedVisible=false;
 const opening=view.open({mode:"interaction",identity:"card",domainIdentity:"request",snapshot:async()=>({}),display:()=>{cachedVisible=true;return "verifying";},verify:()=>authority.promise,failed:()=>assert.fail()});
 assert.equal(restorationSurface(view.state.phase,cachedVisible),"skeleton");
 await opening;
 assert.equal(view.state.phase,"verifying");
 assert.equal(restorationSurface(view.state.phase,cachedVisible),"snapshot");
 cachedVisible=false;
 assert.equal(restorationSurface(view.state.phase,cachedVisible),"skeleton","canonical answers stay covered while their draft is restored");
 authority.resolve("ready");await until(()=>view.state.phase==="ready");
 assert.equal(restorationSurface(view.state.phase,cachedVisible),"content");
 view.dispose();
});

test("overlapping unrelated refreshes retain refreshing until both settle",async()=>{
 const view=new ViewRestorationCoordinator();const a=deferred<void>(),b=deferred<void>();
 const first=view.refresh("a",()=>a.promise,()=>{}),second=view.refresh("b",()=>b.promise,()=>{});
 a.resolve();await first;assert.equal(view.state.refresh,"refreshing");b.resolve();await second;assert.equal(view.state.refresh,"idle");view.dispose();
});

test("repeated mount and dispose releases each local resource once",async()=>{
 let resources=0;
 for(let i=0;i<20;i++){
  const view=new ViewRestorationCoordinator();
  await view.open({mode:"connection",identity:"card",domainIdentity:"entity",snapshot:async()=>({}),display:()=>{},verify:async()=>"ready",failed:()=>assert.fail(),cleanup:()=>{resources--;}});resources++;
  await until(()=>view.state.phase==="ready");view.dispose();view.dispose();assert.equal(resources,0);
  let released=false;view.ownResource("late",()=>{released=true;});assert.equal(released,true);
 }
});
