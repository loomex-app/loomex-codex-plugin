import * as assert from "node:assert/strict";
import { test } from "node:test";
import { viewSessionMeta } from "../src/view-session.js";
import { TOOL_DEFINITIONS } from "../src/tool-catalog.js";
import type { ToolOutput } from "../src/protocol.js";
const id = "463ce151-4f03-471f-93f8-8974c131ace8";
const workflow = "ee8e2ea2-cbbc-4a7a-be39-cc7c4924789e";
const ok = (data: any): ToolOutput => ({ok:true,protocol:"loomex.local-control/v2",method:"workflows.get",requestId:id,data});

test("view sessions carry stable identity without forwarding it as execution context", async () => {
  const definition = TOOL_DEFINITIONS.find(item=>item.name === "loomex_workflow_view")!;
  assert.ok(definition.localOnlyInputKeys?.includes("viewSessionId"));
  const calls: any[]=[];
  const session={viewSessionId:id,kind:"authoring",entityType:"workflow",entityId:workflow,revision:0,state:{},status:"active"};
  const client={async call(method:any,params:any){calls.push({method,params});return ok(session)}};
  const result=await viewSessionMeta(client,definition,{workflowId:workflow},ok({workflow:{id:workflow}}));
  assert.deepEqual(result["loomex/viewSession"],session);
  assert.equal(calls[0].method,"presentation.sessions.create");
  await viewSessionMeta(client,definition,{workflowId:workflow,viewSessionId:id},ok({workflow:{id:workflow}}));
  assert.deepEqual(calls[1],{method:"presentation.sessions.get",params:{viewSessionId:id}});
});

test("wrong-bound or unavailable view stores cannot restore state",async()=>{
 const definition=TOOL_DEFINITIONS.find(item=>item.name === "loomex_workflow_view")!;
 const client={async call(){return ok({viewSessionId:id,kind:"authoring",entityType:"workflow",entityId:id})}};
 assert.deepEqual(await viewSessionMeta(client,definition,{workflowId:workflow,viewSessionId:id},ok({workflow:{id:workflow}})),{"loomex/viewPersistence":{status:"unavailable"}});
});

test("chat interactions do not create presentation sessions",async()=>{
 const definition=TOOL_DEFINITIONS.find(item=>item.name === "loomex_interaction_view")!;
 const client={async call():Promise<ToolOutput>{throw new Error("Must remain headless")}};
 assert.deepEqual(await viewSessionMeta(client,definition,{requestId:id},ok({humanRequest:{id,answerChannel:"chat"}})),{"loomex/answerChannel":"chat"});
});

test("monitor and authoring session identities stay bound to their parent while a question is pending",async()=>{
 for (const [name,kind,entityType,key] of [
   ["loomex_run_view","monitor","execution","runId"],
   ["loomex_builder_get","authoring","builderSession","sessionId"],
 ] as const) {
  const definition=TOOL_DEFINITIONS.find(item=>item.name === name)!;
  const calls:any[]=[];
  const client={async call(_method:any,params:any){calls.push(params);return ok({viewSessionId:id,...params,revision:0,status:"active"})}};
  const result=await viewSessionMeta(client,definition,{[key]:workflow},ok({humanRequest:{id,answerChannel:"chat"},[entityType]:{id:workflow}}));
  assert.equal(calls.length,1);
  assert.equal(calls[0].kind,kind);
  assert.equal(calls[0].entityType,entityType);
  assert.equal(calls[0].entityId,workflow);
  assert.ok(result["loomex/viewSession"]);
 }
});
