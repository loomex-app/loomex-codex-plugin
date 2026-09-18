import { test } from "node:test";
import * as assert from "node:assert/strict";
import { ContinuationDeliveryController, continuationMessage, decodeDelivery, type DeliveryProjection, type DeliveryJournal } from "../src/ui-app/continuation-delivery.js";
import { UiTransportError, UiResultDecodeError } from "../src/ui-app/result-decoder.js";
const input = { identity: "start:exact", purpose: "reviewed_start" as const, text: continuationMessage("Read exact handoff", {handoffRef:"exact"}) };
function journal() {
 let value:DeliveryProjection={schemaVersion:2,identity:input.identity,continuation:{handoffRef:"exact"},revision:0,status:"ready",attemptId:null};
 const api:DeliveryJournal={
  get:async()=>structuredClone(value),
  begin:async p=>{assert.equal(p.expectedRevision,value.revision);assert.ok(["ready","not_sent","rejected"].includes(value.status));value={...value,status:"sending",revision:value.revision+1,attemptId:p.attemptId};return structuredClone(value);},
  settle:async p=>{assert.equal(p.expectedRevision,value.revision);assert.equal(p.attemptId,value.attemptId);value={...value,status:p.status,revision:value.revision+1};return structuredClone(value);},
 };
 return {api,read:()=>structuredClone(value)};
}
function fixture(send:()=>Promise<unknown> = async()=>({}),j=journal()) {
 let calls=0,ids=0;
 const controller=new ContinuationDeliveryController({available:()=>true,uuid:()=>`attempt-${++ids}`,journal:j.api,send:async()=>{calls++;return send();}});
 return {controller,j,calls:()=>calls};
}
test("durable delivery reserves before one host post and acknowledges independently of display saves",async()=>{
 const f=fixture();assert.equal(await f.controller.deliver(input),"acknowledged");assert.equal(await f.controller.deliver(input),"acknowledged");assert.equal(f.calls(),1);assert.equal(f.j.read().status,"acknowledged");
});
test("failure before reservation is known unsent and explicitly retryable",async()=>{
 const f=fixture();const get=f.j.api.get;f.j.api.get=async()=>{throw new Error("offline");};
 assert.equal(await f.controller.deliver(input),"not_sent");assert.equal(f.calls(),0);
 f.j.api.get=get;assert.equal(await f.controller.deliver(input,true),"acknowledged");assert.equal(f.calls(),1);
});
test("lost reservation response never authorizes a fresh attempt",async()=>{
 const f=fixture();const begin=f.j.api.begin;f.j.api.begin=async p=>{await begin(p);throw new Error("lost");};
 assert.equal(await f.controller.deliver(input),"unknown");await f.controller.deliver(input,true);assert.equal(f.calls(),0);assert.equal(f.j.read().status,"sending");
});
test("explicit host rejection permits an explicit delivery retry only",async()=>{
 const f=fixture(async()=>({isError:true}));await f.controller.deliver(input);await f.controller.deliver(input);assert.equal(f.calls(),1);await f.controller.deliver(input,true);assert.equal(f.calls(),2);
});
test("timeout and remounted in-flight records never automatically resend",async()=>{
 const f=fixture(async()=>{throw new UiTransportError({code:"HOST_TIMEOUT",message:"timeout"});});await f.controller.deliver(input);await f.controller.deliver(input,true);assert.equal(f.calls(),1);
 const record={...input,schemaVersion:1 as const,attemptId:"attempt",status:"sending" as const};assert.equal(decodeDelivery(record)?.status,"unknown");
 const other=fixture(async()=>({}),f.j);await other.controller.reconcile(input);assert.equal(other.controller.record?.status,"unknown");await other.controller.deliver(input,true);assert.equal(other.calls(),0);
});
test("result rendering does not erase an active delivery and disposal still settles its exact outcome",async()=>{
 let release!:(v:unknown)=>void;let started!:()=>void;const begun=new Promise<void>(resolve=>{started=resolve;});const f=fixture(()=>new Promise(resolve=>{release=resolve;started();}));
 const pending=f.controller.deliver(input);await begun;f.controller.restore(undefined);await f.controller.deliver(input);f.controller.dispose();release({});
 assert.equal(await pending,"acknowledged");assert.equal(f.calls(),1);assert.equal(f.j.read().status,"acknowledged");
});
test("two cards cannot dispatch the same continuation twice",async()=>{
 const j=journal(),a=fixture(async()=>({}),j),b=fixture(async()=>({}),j);
 await Promise.all([a.controller.deliver(input),b.controller.deliver(input)]);assert.equal(a.calls()+b.calls(),1);
});
test("lost final settlement does not erase host acknowledgement or authorize replay",async()=>{
 const f=fixture();f.j.api.settle=async()=>{throw new Error("lost");};assert.equal(await f.controller.deliver(input),"acknowledged");await f.controller.deliver(input,true);assert.equal(f.calls(),1);
 const other=fixture(async()=>({}),f.j);await other.controller.reconcile(input);assert.equal(other.controller.record?.status,"unknown");
});
test("restoration rejects mismatched safe continuation identity",()=>{
 assert.equal(decodeDelivery({...input,schemaVersion:1,identity:"start:other",attemptId:"one",status:"rejected"}),undefined);
});
test("unsupported host retains recovery without claiming dispatch",async()=>{
 const j=journal();let calls=0;const c=new ContinuationDeliveryController({available:()=>false,uuid:()=>"a",journal:j.api,send:async()=>{calls++;return {};}});
 assert.equal(await c.deliver(input),"unsupported");assert.equal(calls,0);assert.equal(j.read().status,"ready");
});
test("request replacement during reservation does not dispatch old continuation",async()=>{
 let scope="first",release!:()=>void;const j=journal();const begin=j.api.begin;j.api.begin=async p=>{const value=await begin(p);await new Promise<void>(r=>{release=r;});return value;};let calls=0;
 const controller=new ContinuationDeliveryController({scope:()=>scope,available:()=>true,uuid:()=>"a",journal:j.api,send:async()=>{calls++;return {};}});
 const pending=controller.deliver(input);while(!release)await Promise.resolve();scope="replacement";release();await pending;assert.equal(calls,0);assert.equal(j.read().status,"not_sent");
});

test("reconciling a ready continuation does not suppress its first authorized delivery",async()=>{
 const f=fixture();await f.controller.reconcile(input);
 assert.equal(f.controller.record?.status,"ready");assert.equal(f.calls(),0);
 assert.equal(await f.controller.deliver(input),"acknowledged");
 assert.equal(f.calls(),1);assert.equal(f.j.read().revision,2);
});

test("a failed background reconciliation cannot suppress the first authorized delivery", async () => {
 const f=fixture();const get=f.j.api.get;
 f.j.api.get=async()=>{throw new Error("temporary read failure");};
 await f.controller.reconcile(input);
 assert.equal(f.controller.record?.status,"unknown");
 f.j.api.get=get;
 assert.equal(await f.controller.deliver(input),"acknowledged");
 assert.equal(f.calls(),1);assert.equal(f.j.read().revision,2);
});

test("a superseded card cannot expose its old continuation while a read completes", async () => {
 let scope="first",release!:(value:DeliveryProjection)=>void;
 const j=journal();let calls=0;
 j.api.get=()=>new Promise(resolve=>{release=resolve;});
 const c=new ContinuationDeliveryController({scope:()=>scope,available:()=>true,uuid:()=>"a",journal:j.api,send:async()=>{calls++;return {};}});
 const pending=c.deliver(input);scope="replacement";
 assert.equal(c.record,undefined);
 release(j.read());await pending;
 assert.equal(c.record,undefined);assert.equal(calls,0);
});

test("a replacement continuation retains its own recovery while the old read settles", async () => {
 let scope="first",release!:(value:DeliveryProjection)=>void;
 const j=journal();let calls=0;
 j.api.get=()=>new Promise(resolve=>{release=resolve;});
 const c=new ContinuationDeliveryController({scope:()=>scope,available:()=>true,uuid:()=>"a",journal:j.api,send:async()=>{calls++;return {};}});
 const old=c.deliver(input);scope="replacement";
 const replacement={...input,identity:"start:replacement"};
 assert.equal(await c.deliver(replacement),"ready");
 assert.equal(c.record?.identity,replacement.identity);
 release(j.read());await old;
 assert.equal(c.record?.identity,replacement.identity);assert.equal(calls,0);
});

test("replacement hydration reconciles once the previous card delivery finishes", async () => {
 let scope="first",release!:(value:unknown)=>void,reads=0;
 const j=journal();const originalGet=j.api.get;
 const replacement={...input,identity:"start:replacement"};
 j.api.get=async identity=>{reads++;return identity===input.identity ? originalGet(identity) : {...j.read(),identity:replacement.identity,continuation:{handoffRef:"replacement"},status:"ready",attemptId:null};};
 const c=new ContinuationDeliveryController({scope:()=>scope,available:()=>true,uuid:()=>"a",journal:j.api,send:()=>new Promise(resolve=>{release=resolve;})});
 const old=c.deliver(input);while(!release)await Promise.resolve();scope="replacement";
 await c.reconcile(replacement);
 assert.equal(c.record,undefined);
 release({});await old;
 assert.equal(reads,2);
 const current=()=>c.record;
 assert.equal(current()?.identity,replacement.identity);
 assert.equal(current()?.status,"ready");
});

test("delivery preserves numeric host RPC failures without including host text",async()=>{
 const f=fixture();f.j.api.get=async()=>{throw new UiTransportError({code:"-32601",message:"private host response"});};
 assert.equal(await f.controller.deliver(input),"not_sent");
 assert.equal(f.controller.record?.failureCode,"HOST_RPC_MINUS_32601");
 assert.equal(f.calls(),0);
});

test("delivery preserves canonical decoder diagnostics without retaining payloads",async()=>{
 const f=fixture();f.j.api.get=async()=>{throw new UiResultDecodeError("invalid",{format:"loomex/ui-result-diagnostic/v1",stage:"canonical",channel:"root",code:"UI_SUCCESS_DATA_INVALID",fields:["ok:boolean"]});};
 assert.equal(await f.controller.deliver(input),"not_sent");
 assert.equal(f.controller.record?.failureCode,"UI_SUCCESS_DATA_INVALID");
 assert.equal(f.calls(),0);
});

test("arbitrary local error codes are not copied into support details",async()=>{
 const f=fixture();f.j.api.get=async()=>{throw Object.assign(new Error("private"),{code:"PRIVATEANSWER"});};
 await f.controller.deliver(input);
 assert.equal(f.controller.record?.failureCode,"DELIVERY_PREPARATION_UNAVAILABLE");
});
