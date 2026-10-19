import {test} from "node:test";
import * as assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {PERSONA_INPUTS,PERSONA_RESULTS} from "../src/persona-contracts.js";
import {TOOL_DEFINITIONS,APP_CALLABLE_TOOLS} from "../src/tool-catalog.js";
import {personaSelectionEntries,collectPersonaSelection} from "../src/ui-app/persona-selection.js";
import {personaFrontendUrl} from "../src/ui-app/persona-frontend.js";
import {personaContextReference,personaDisplayCopy} from "../src/ui-app/persona-controller.js";
import {personaCreationArguments,personaCreatedResult} from "../src/ui-app/persona-authoring.js";
import {personaChatMessage} from "../src/ui-app/persona-context.js";
import {completePersonaResponse} from "../src/ui-app/persona-response.js";
const personId="11111111-1111-4111-8111-111111111111",roleId="22222222-2222-4222-8222-222222222222",organizationId="33333333-3333-4333-8333-333333333333",conversationId="44444444-4444-4444-8444-444444444444",chatId="55555555-5555-4555-8555-555555555555",key="66666666-6666-4666-8666-666666666666",digest="a".repeat(64);
const context={personId,conversationId,chatId};
test("Persona display uses public role descriptions and excludes runtime prompts and identities",()=>{
 const person={role:"Legacy role",roleSummary:{id:roleId,name:"Reviewer",description:"Checks assumptions and explains tradeoffs."},effectiveConfig:{prompt:"Private prompt"},config:{description:"Private configuration"}};
 assert.deepEqual(personaDisplayCopy(person),{role:"Reviewer",description:"Checks assumptions and explains tradeoffs."});
 assert.deepEqual(personaDisplayCopy({role:"Reviewer"},{name:"Fallback",description:"Public role description"}),{role:"Reviewer",description:"Public role description"});
 assert.deepEqual(personaDisplayCopy({id:personId,config:{prompt:"Private"}}),{role:"AI Persona",description:""});
});
test("Persona tools are fixed strict contracts and discovery has no mutation authority",()=>{
  const tools=TOOL_DEFINITIONS.filter(t=>t.rpcMethod.startsWith("personas.")||t.rpcMethod.startsWith("persona.roles."));assert.equal(tools.length,14);assert.ok(tools.every(t=>t.optionalRunnerMethod===true));
  assert.equal(TOOL_DEFINITIONS.find(t=>t.name==="loomex_persona_context_create")?.mutating,true);assert.equal(TOOL_DEFINITIONS.find(t=>t.name==="loomex_persona_context_get")?.mutating,false);assert.ok(APP_CALLABLE_TOOLS.has("loomex_personas_view"));
  assert.equal(PERSONA_INPUTS.create.safeParse({personId,idempotencyKey:key,conversationId}).success,false);
  for(const name of ["search","read","write","update"] as const){const args=name==="search"?{query:"project constraint"}:name==="read"||name==="update"?{memoryId:key}:{content:"Stable project constraint"};assert.equal(PERSONA_INPUTS[name].safeParse({...context,arguments:{...args,organizationId},idempotencyKey:key}).success,false);}
  assert.equal(PERSONA_INPUTS.write.safeParse({...context,arguments:{content:"stable fact"}}).success,false);
  assert.equal(PERSONA_INPUTS.search.safeParse({...context,arguments:{query:"stable fact",types:[]}}).success,true);
  assert.equal(PERSONA_INPUTS.search.safeParse({...context,arguments:{query:"stable fact",types:["fact","fact"]}}).success,false);
});
test("Persona operation receipts keep not-found and processing distinct from complete identity",()=>{
 const schema=PERSONA_RESULTS["personas.operations.get"]!;assert.ok(schema.safeParse({operation:"memory.write",key,status:"not_found"}).success);assert.ok(schema.safeParse({operation:"memory.write",key,status:"processing",requestDigest:digest}).success);assert.equal(schema.safeParse({operation:"memory.write",key,status:"completed"}).success,false);assert.ok(schema.safeParse({operation:"memory.write",key,status:"completed",requestDigest:digest,response:{result:{status:"candidate"}}}).success);
});
test("Nested Persona selections consume exact encoded keys and reject mutable enums",()=>{
 const field={type:"object","x-loomex-input-kind":"persona_selections",properties:{persona_review_2f_node:{type:"string","x-loomex-input-kind":"persona_select","x-loomex-role-id":roleId,"x-loomex-node-key":"review/node"}},required:["persona_review_2f_node"]};const entries=personaSelectionEntries("aiPersonaSelections",field)!;assert.equal(entries[0]?.persona?.selectionKey,"persona_review_2f_node");const inputs={};collectPersonaSelection(inputs,entries[0]!,personId);assert.deepEqual(inputs,{aiPersonaSelections:{persona_review_2f_node:personId}});
 assert.throws(()=>personaSelectionEntries("aiPersonaSelections",{...field,properties:{x:{...field.properties.persona_review_2f_node,enum:[personId]}}}));
});
test("Persona management navigation preserves configured root and workspace bases",()=>{
 assert.equal(personaFrontendUrl("https://example.test","persons"),"https://example.test/persons");assert.equal(personaFrontendUrl("https://example.test/workspace/?x=1#old","persona-roles"),"https://example.test/workspace/persona-roles");assert.equal(personaFrontendUrl("http://localhost:3000/base","memory"),"http://localhost:3000/base/memory");for(const v of [undefined,"/workspace","javascript:alert(1)","https://user:pass@example.test"])assert.throws(()=>personaFrontendUrl(v,"persons"));
});
test("Persona context references require exact active identities and exclude prompt/memory from delivery",()=>{
 const data={contractVersion:"loomex.ai-persona-chat/v1",person:{id:personId,organizationId,roleId,name:"Reviewer",status:"active",roleSummary:{id:roleId,status:"active"}},conversation:{conversationId,chatId},configDigest:digest,effectiveConfig:{prompt:"private prompt"},memory:{content:"private memory"}};const ref=personaContextReference(data,personId);const message=personaChatMessage(ref);assert.ok(message.includes(personId));assert.ok(!message.includes("private prompt")&&!message.includes("private memory"));assert.throws(()=>personaContextReference({...data,person:{...data.person,status:"disabled"}},personId));assert.throws(()=>personaContextReference(data,key));
});
test("Persona response spools drain pages and verify immutable bytes without replay",async()=>{
 const bytes=Buffer.from(JSON.stringify({person:{id:personId}})),checksumSha256=createHash("sha256").update(bytes).digest("hex");const offsets:number[]=[];const data=await completePersonaResponse({responseRef:key,encoding:"json",sizeBytes:bytes.length,checksumSha256},async args=>{const offset=args.offset as number;offsets.push(offset);const end=Math.min(offset+9,bytes.length);return {responseRef:key,offset,sizeBytes:bytes.length,checksumSha256,dataBase64:bytes.subarray(offset,end).toString("base64"),nextOffset:end===bytes.length?null:end};});assert.deepEqual(data,{person:{id:personId}});assert.ok(offsets.length>1);await assert.rejects(()=>completePersonaResponse({responseRef:key,encoding:"json",sizeBytes:bytes.length,checksumSha256},async()=>({responseRef:key,offset:0,sizeBytes:bytes.length,checksumSha256,dataBase64:bytes.toString("base64"),nextOffset:0})),/cursor/);
});

test("Frozen Persona summary binds exact reviewed input, version and config fingerprint",async()=>{
 const {preparedPersonaSummary}=await import("../src/ui-app/persona-preparation.js");const row={workflowVersionId:key,nodeKey:"review/node",selectionKey:"persona_review_2f_node",personId,personName:"Reviewer",roleId,roleName:"Review",configDigest:digest};const binding={versionId:key,inputs:{aiPersonaSelections:{persona_review_2f_node:personId}},workflowClosureReview:{personas:[row]}};assert.deepEqual(preparedPersonaSummary(binding),[row]);assert.equal(preparedPersonaSummary({...binding,workflowClosureReview:{personas:[{...row,personId:chatId}]}}),undefined);assert.equal(preparedPersonaSummary({...binding,workflowClosureReview:{personas:[{...row,workflowVersionId:chatId}]}}),undefined);assert.equal(preparedPersonaSummary({...binding,workflowClosureReview:{}}),undefined);
});

test("Persona scope upgrades reject duplicate reviewed scopes before dispatch",()=>{const organizationId=randomUUID(),idempotencyKey=randomUUID();assert.equal(PERSONA_INPUTS.scopeUpgrade.safeParse({organizationId,idempotencyKey,requestedScopes:["runner.personas.read","runner.personas.read"]}).success,false);assert.equal(PERSONA_INPUTS.scopeUpgrade.safeParse({organizationId,idempotencyKey,requestedScopes:["runner.personas.read","runner.personas.chat"]}).success,true);});

test("Verified Persona scope status preserves empty authority without exposing backend self metadata",()=>{
 const baseline={organizationId,runnerId:personId,delegationId:conversationId,deviceId:chatId,scopes:[],status:"verified"};
 for(const method of ["auth.scope_status","auth.scope_upgrade"]){
  const schema=PERSONA_RESULTS[method]!;
  assert.equal(schema.safeParse(baseline).success,true);
  const {scopes,...unknown}=baseline;
  assert.equal(schema.safeParse(unknown).success,false);
  assert.equal(schema.safeParse({...baseline,scopeContext:{grantedScopes:[],effectiveTokenScopes:[]}}).success,false);
 }
});

test("Persona creation exposes closed canonical fields and conservative form defaults",()=>{
 const common={organizationId,name:"Reviewer",idempotencyKey:key};
 assert.ok(PERSONA_INPUTS.roleCreate.safeParse({...common,config:{promptPolicy:{basePrompt:"Instructions"},skills:["review",{id:"explain",enabled:true,priority:2}]}}).success);
 for(const config of [{model:"gpt"},{promptPolicy:{prompt:"arbitrary"}},{memoryPolicy:{maxItems:201}},{tools:["execute"]}])assert.equal(PERSONA_INPUTS.personCreate.safeParse({...common,roleId,config}).success,false);
 assert.equal(PERSONA_INPUTS.roleCreate.safeParse({...common,organizationId:undefined}).success,false);
 assert.equal(PERSONA_INPUTS.personCreate.safeParse({...common,roleId,status:"disabled"}).success,false);
 assert.ok(PERSONA_INPUTS.scopeUpgrade.safeParse({organizationId,idempotencyKey:key,requestedScopes:["runner.personas.manage"]}).success);
 for(const name of ["loomex_persona_role_create","loomex_persona_create"]){const tool=TOOL_DEFINITIONS.find(t=>t.name===name)!;assert.equal(tool.mutating,true);assert.equal(tool.destructive,false);assert.ok(APP_CALLABLE_TOOLS.has(name));}
 const form={organizationId,name:"  Reviewer  ",description:"Public description",instructions:"Role rules",roleId,personality:"Thoughtful",outputStyle:"Concise",memoryInstruction:"Durable facts only",maxItems:50,writeMemory:false,available:false};
 const person=personaCreationArguments("person",form);assert.equal(person.status,"draft");assert.deepEqual((person.config as any).memoryPolicy,{maxItems:50,writeMemory:false});assert.equal(person.name,"Reviewer");assert.equal(personaCreationArguments("person",{...form,available:true}).status,"active");assert.deepEqual((personaCreationArguments("role",form).config as any).promptPolicy,{basePrompt:"Role rules"});assert.throws(()=>personaCreationArguments("person",{...form,roleId:""}));
});

test("Persona accepted entities require exact requested status including creation defaults",()=>{
 const person={id:personId,organizationId,roleId,name:"Draft",status:"draft"},args={organizationId,roleId,name:"Draft"};
 assert.equal(personaCreatedResult(person,"person",args,key).status,"draft");
 assert.throws(()=>personaCreatedResult({...person,status:"active"},"person",args,key),/requested status/);
 assert.equal(personaCreatedResult({...person,status:"active"},"person",{...args,status:"active"},key).status,"active");
 assert.throws(()=>personaCreatedResult(person,"person",{...args,status:"active"},key),/requested status/);
 const role={id:roleId,organizationId,name:"Reviewer",status:"active"};
 assert.equal(personaCreatedResult(role,"role",{organizationId,name:"Reviewer"},key).status,"active");
 assert.throws(()=>personaCreatedResult({...role,status:"disabled"},"role",{organizationId,name:"Reviewer"},key),/requested status/);
});

test("Process-wide memory read carries a bounded cursor without accepting a caller-selected contract",()=>{
 assert.ok(PERSONA_INPUTS.read.safeParse({...context,arguments:{memoryId:personId,cursor:"opaque-v2-cursor"}}).success);
 for(const arguments_ of [{memoryId:personId,cursor:""},{memoryId:personId,cursor:"x".repeat(16385)},{memoryId:personId,contractVersion:2}])assert.equal(PERSONA_INPUTS.read.safeParse({...context,arguments:arguments_}).success,false);
});

test("V2 memory fragments preserve source documents and require canonical model text",async()=>{
 const {personaMemoryContent}=await import("../src/persona-contracts.js");
 const document=JSON.stringify({content:"English فارسی 😀",artifactSources:[{source:{artifactId:key,checksumSha256:digest},text:"source text"}]});
 const result={ok:true,tool:"person_memory.read",schemaVersion:"ai.persona-memory/v2",memoryId:personId,revision:2,page:{text:document.slice(0,12),encoding:"application/json; fragment=unicode-codepoints",start:0,end:12,totalChars:Array.from(document).length,documentSha256:createHash("sha256").update(document).digest("hex"),complete:false,nextCursor:"opaque"},budget:{accountingContract:"o200k_base/v1",maxTokens:2048,maxBytes:16384}};
 const canonicalText=JSON.stringify(result);const schema=PERSONA_RESULTS["personas.memory.read"]!;
 assert.ok(schema.safeParse({result,canonicalText}).success);assert.equal(personaMemoryContent({result,canonicalText}),canonicalText);
 assert.throws(()=>personaMemoryContent({result}),/canonical/);assert.throws(()=>personaMemoryContent({result,canonicalText:JSON.stringify({...result,revision:3})}),/canonical/);
 for(const page of [{...result.page,complete:true},{...result.page,end:13},{...result.page,encoding:"text/plain"},{...result.page,nextCursor:null}])assert.equal(schema.safeParse({result:{...result,page},canonicalText}).success,false);
 assert.equal(schema.safeParse({result:{...result,budget:{...result.budget,maxBytes:16385}},canonicalText}).success,false);
 assert.equal(personaMemoryContent({result:{memory:{id:personId,content:"legacy"}}}),undefined);
});

test("Final discussion results require attributed released messages and honest deterministic tally",async()=>{
 const {discussionResults}=await import("../src/ui-app/discussion-presentation.js");
 const output={schemaVersion:"loomex.persona-discussion/v1",subject:"Choose a direction",goal:"Assess options",synthesis:"Unresolved tradeoffs",recommendation:null,goalStatus:"undetermined",stopReason:"round_cap",agreements:[],disagreements:["Cost remains disputed"],openQuestions:[],messageReferences:["m1"],participants:[{slotKey:"a",roleId,personId},{slotKey:"b",roleId,personId:chatId}],messages:[{messageId:"m1",slotKey:"a",personId,phase:"ballot",round:1,output:{optionId:null,explanation:"Needs more evidence"}}],moderation:[],proposalReceipts:[],warnings:[],tally:{rule:"majority",participantCount:2,ballotCount:2,abstentions:1,threshold:2,counts:{x:1},decision:null}};
 const row={nodeKey:"discuss",nodeExecutionId:key,output};assert.deepEqual(discussionResults([row]),[row]);
 for(const changed of [{...output,recommendation:"x"},{...output,messageReferences:["unknown"]},{...output,messages:[{...output.messages[0],personId:chatId}]}])assert.equal(discussionResults([{...row,output:changed}]),undefined);
 assert.deepEqual(discussionResults(undefined),[]);
});

test("Reviewed discussion participants consume exact sealed selection keys and limits",async()=>{
 const {preparedDiscussionSummary,preparedPersonaSummary}=await import("../src/ui-app/persona-preparation.js");
 const row={workflowVersionId:key,nodeKey:"a/b",mode:"independent_then_discuss",maxRounds:3,moderatorSlot:"b",synthesizerSlot:"b",contextBudget:{accountingContract:"o200k_base/v1",maxTokens:16384,maxBytes:131072},finalMemoryProposals:true,voting:{options:[],rule:"majority"},configDigest:digest,participants:[{slotKey:"a",selectionKey:"exact:key/a",personId,personName:"Researcher",roleId,roleName:"Research",provider:"codex",model:"gpt-test",reasoningEffort:"high",configDigest:digest},{slotKey:"b",selectionKey:"exact:key/b",personId:chatId,personName:"Reviewer",roleId,roleName:"Research",provider:"codex",model:"gpt-test",reasoningEffort:null,configDigest:digest}]};
 const binding={versionId:key,inputs:{aiPersonaSelections:{"exact:key/a":personId,"exact:key/b":chatId}},workflowClosureReview:{personas:[],discussions:[row]}};
 assert.deepEqual(preparedDiscussionSummary(binding),[row]);assert.deepEqual(preparedPersonaSummary(binding),[]);
 const poisoned={...row,prompt:"private peer prompt",participants:row.participants.map(p=>({...p,privateSnapshot:"private peer memory"})),contextBudget:{...row.contextBudget,privateContext:"private source"},voting:{...row.voting,privateBallot:"private ballot"}};
 assert.deepEqual(preparedDiscussionSummary({...binding,workflowClosureReview:{discussions:[poisoned]}}),[row]);
 for(const change of [{...row,maxRounds:11},{...row,moderatorSlot:"outsider"},{...row,participants:[row.participants[0],row.participants[0]]},{...row,contextBudget:{...row.contextBudget,maxBytes:524289}}])assert.equal(preparedDiscussionSummary({...binding,workflowClosureReview:{discussions:[change]}}),undefined);
 assert.equal(preparedPersonaSummary({...binding,workflowClosureReview:{personas:[]}}),undefined);
});

test("V2 discovery retains canonical passage source revision and work ceilings",()=>{
 const passage={id:personId,revision:2,type:"fact",summary:"Preference",matchedPassage:"فارسی 😀",passageStart:0,passageEnd:7,contentChars:7,truncated:false,score:1,provenance:{personId,workflowId:key},source:{type:"artifact",id:key,checksum:digest,artifactId:key,artifactVersionId:chatId,artifactVersion:1},chunkId:digest,chunkOrdinal:0,chunkerVersion:"memory-text/v1",generation:digest,title:"Section"};
 const result={ok:true,tool:"person_memory.search",schemaVersion:"ai.persona-memory/v2",memoryIds:[personId],items:[passage],snapshotId:null,omittedCount:0,truncated:true,budget:{accountingContract:"o200k_base/v1",maxTokens:4096,maxBytes:32768},sourceWork:{limited:true,maxArtifactBytes:4194304,maxTextBytes:4194304,maxArtifacts:8}};
 const schema=PERSONA_RESULTS["personas.memory.search"]!,canonicalText=JSON.stringify(result);
 assert.deepEqual(schema.parse({result,canonicalText}),{result,canonicalText});
 assert.equal(schema.safeParse({result:{...result,truncated:false},canonicalText:JSON.stringify({...result,truncated:false})}).success,false);
 assert.equal(schema.safeParse({result:{...result,items:[{...passage,passageEnd:8}]},canonicalText}).success,false);
 assert.equal(schema.safeParse({result:{...result,sourceWork:{...result.sourceWork,maxArtifacts:9}},canonicalText}).success,false);
});

test("V2 mutation acknowledgements keep content out of bounded receipts",()=>{
 const result={ok:true,tool:"person_memory.write",schemaVersion:"ai.persona-memory/v2",memory:{id:personId,type:"fact",status:"needs_review"},budget:{accountingContract:"o200k_base/v1",maxTokens:4096,maxBytes:32768}};
 const schema=PERSONA_RESULTS["personas.memory.write"]!,canonicalText=JSON.stringify(result);assert.deepEqual(schema.parse({result,canonicalText}),{result,canonicalText});
 const expanded={...result,memory:{...result.memory,content:"private full content"}};assert.equal(schema.safeParse({result:expanded,canonicalText:JSON.stringify(expanded)}).success,false);
 const inventedRevision={...result,memory:{...result.memory,revision:3}};assert.equal(schema.safeParse({result:inventedRevision,canonicalText:JSON.stringify(inventedRevision)}).success,false);
 assert.equal(PERSONA_RESULTS["personas.memory.update"]!.safeParse({result,canonicalText}).success,false);
});

test("backend acknowledgement has only immutable identity type and status",()=>{
 const result={ok:true,tool:"person_memory.write",schemaVersion:"ai.persona-memory/v2",memory:{id:personId,type:"fact",status:"needs_review"},budget:{accountingContract:"o200k_base/v1",maxTokens:4096,maxBytes:32768}};
 assert.equal(PERSONA_RESULTS["personas.memory.write"]!.safeParse({result,canonicalText:JSON.stringify(result)}).success,true);
});

test("typed v2 rejection stays a bounded normal result for each exact memory operation",()=>{
 for(const method of ["search","read","write","update"]){
  const budget={accountingContract:"o200k_base/v1",maxTokens:method==="read"?2048:4096,maxBytes:method==="read"?16384:32768};
  const result={ok:false,tool:`person_memory.${method}`,schemaVersion:"ai.persona-memory/v2",error:"Persona memory operation was rejected; inspect current context and policy.",budget};
  assert.equal(PERSONA_RESULTS[`personas.memory.${method}`]!.safeParse({result,canonicalText:JSON.stringify(result)}).success,true,method);
  const schema=PERSONA_RESULTS[`personas.memory.${method}`]!;
  const invalid=[{...result,tool:"person_memory.peer"},{...result,error:"raw provider stderr secret"},{...result,error:{message:"raw private error"}},{...result,rawError:"private backend diagnostics"},{...result,budget:{...budget,extra:"private scope"}},{...result,budget:{...budget,maxBytes:1}},{...result,budget:{...budget,maxTokens:0}},{...result,budget:{...budget,maxTokens:budget.maxTokens+1}},{...result,budget:{...budget,maxBytes:budget.maxBytes+1}}];
  for(const rejected of invalid)assert.equal(schema.safeParse({result:rejected,canonicalText:JSON.stringify(rejected)}).success,false,method);
 }
});
