import {test} from "node:test";
import * as assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import recoveryContract from "../contracts/error-recovery.json" with {type:"json"};
import {errorRecovery,LOCAL_PROTOCOL,RecoverySchema,RpcResponseSchema,ToolOutputSchema} from "../src/protocol.js";
import {LocalControlError,toolErrorOutput} from "../src/local-control.js";
import {createServer} from "../src/server.js";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";

test("every pinned recovery rule survives strict RPC and tool error projection",()=>{
 const values=new Set<string>();
 for(const [code,rule] of Object.entries(recoveryContract.codes)) {
  values.add(rule.recovery);assert.deepEqual(errorRecovery(code),rule,code);
  const output=toolErrorOutput("auth.scope_status",new LocalControlError({code}));
  assert.equal(ToolOutputSchema.safeParse(output).success,true,code);
  assert.equal(RpcResponseSchema.safeParse({protocol:LOCAL_PROTOCOL,id:randomUUID(),error:{...output.error,message:"safe fixed error",correlationId:randomUUID()}}).success,true,code);
 }
 values.add(recoveryContract.default.recovery);
 assert.deepEqual([...RecoverySchema.options].sort(),[...values].sort());
 assert.equal(RecoverySchema.safeParse("grant_scopes_automatically").success,false);
 assert.equal(ToolOutputSchema.safeParse({ok:false,protocol:LOCAL_PROTOCOL,method:"auth.scope_status",requestId:randomUUID(),error:{code:"AUTH_SCOPE_VERIFICATION_REQUIRED",message:"safe",retryable:false,recovery:"explicit_scope_upgrade",outcome:"unknown",scopeGrant:{approved:true}}}).success,false);
});

test("MCP scope verification returns the actionable fixed error without output validation failure or grant",async()=>{
 const calls:string[]=[];
 const server=createServer({call:async(method)=>{calls.push(method);throw new LocalControlError({code:"AUTH_SCOPE_VERIFICATION_REQUIRED"});}});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
 const client=new Client({name:"scope-prerequisite-regression",version:"1.0.0"});
 try {
  await server.connect(serverTransport);await client.connect(clientTransport);
  const result=await client.callTool({name:"loomex_persona_scope_status",arguments:{organizationId:randomUUID()}});
  const output=ToolOutputSchema.parse(result.structuredContent);
  assert.equal(result.isError,true);assert.equal(output.ok,false);assert.equal(output.error?.code,"AUTH_SCOPE_VERIFICATION_REQUIRED");assert.equal(output.error?.recovery,"explicit_scope_upgrade");assert.equal(output.error?.outcome,"unknown");assert.match(output.error?.message??"",/explicit approval/);
  assert.deepEqual(calls,["auth.scope_status"]);
 } finally {await client.close();await server.close();}
});

test("denied Persona picker preserves the authorization checkpoint without creating a session or granting scopes",async()=>{
 const calls:string[]=[];
 const server=createServer({call:async(method)=>{calls.push(method);throw new LocalControlError({code:"AUTHORIZATION_FAILED"});}});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();const client=new Client({name:"persona-denied-prerequisite-regression",version:"1.0.0"});
 try {
  await server.connect(serverTransport);await client.connect(clientTransport);
  const result=await client.callTool({name:"loomex_personas_view",arguments:{}});const output=ToolOutputSchema.parse(result.structuredContent);
  assert.equal(result.isError,true);assert.equal(output.error?.code,"AUTHORIZATION_FAILED");assert.deepEqual(calls,["personas.list"]);assert.match(output.error?.message??"",/required scopes/);
  assert.equal((result._meta as Record<string,unknown>)?.["loomex/viewSession"],undefined);
 }finally{await client.close();await server.close();}
});
