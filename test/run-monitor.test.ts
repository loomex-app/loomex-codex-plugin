import {deliveryJournalFixture} from "./delivery-fixture.js";
import {ContinuationDeliveryController} from "../src/ui-app/continuation-delivery.js";
import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {createRunMonitorController,type RunMonitorServices} from '../src/ui-app/run-monitor.js';
import type {UiData,RunFlow} from '../src/ui-app/page-models.js';
import {queueLabel, queueObservation} from '../src/queue-observation.js';
const runId='cecfb615-af58-48c3-8294-1e6ef4f03256';
const org='cecfb615-af58-48c3-8294-1e6ef4f03257';
const requestId='cecfb615-af58-48c3-8294-1e6ef4f03258';
const nextId='cecfb615-af58-48c3-8294-1e6ef4f03259';
function fixture(){
 const flowStore:{flow:RunFlow|null}={flow:null};let latest:UiData|null=null;
 const host:RunMonitorServices={delivery:new ContinuationDeliveryController({available:()=>true,uuid:()=>"test-attempt",journal:deliveryJournalFixture(),send:async()=>({})}),flowStore,elements:{} as RunMonitorServices['elements'],forms:{} as RunMonitorServices['forms'],connected:()=>true,latest:()=>latest,setLatest:value=>{latest=value;},capabilities:()=>({}),canSendFollowUpMessage:()=>false,backendDraft:()=>null,detachInteractionDraft:()=>{},draftRequest:()=>undefined,requestSchemaDigest:request=>request.schemaDigest,humanRequest:data=>data?.humanRequest??undefined,humanRequestResolved:request=>['resolved','approved','rejected'].includes(request.status||''),executionId:data=>data?.execution?.id||'',interactionId:data=>data.humanRequest?.id||'',safeText:(value,max=4096)=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=max?value.trim():undefined,workflowIdValid:(value):value is string=>typeof value==='string'&&/^[0-9a-f-]{36}$/.test(value),terminalRun:run=>['completed','failed','canceled'].includes(run.status||''),renderRun:()=>{},renderHumanPresentation:()=>true,humanPresentation:request=>request.presentation,formatStatus:value=>String(value),setAction:()=>{},setMutationAction:()=>{},setInteractionAction:()=>{},setError:()=>{},syncChrome:()=>{},onRender:()=>{},runFlowError:()=>{},renderRunSetup:()=>{},renderRunReview:()=>{},dataOf:result=>result.structuredContent?.data||{},send:async()=>({}),persistenceTool:async()=>({}),settleMutationOperation:async()=>({}),transitionSessionAfterSuccess:async()=>({}),uuid:()=>runId};
 return {host,view:createRunMonitorController(host),flowStore,latest:()=>latest};
}
function snapshot(sequence=1):UiData{return {execution:{id:runId,organizationId:org,status:'running'},latestSequence:sequence,humanRequest:{id:requestId,status:'pending',execution:{id:runId,organizationId:org},organizationId:org}};}

test('monitor snapshots reject cross-run, cross-organization, stale and unresolved replacement states',()=>{
 const {view,flowStore}=fixture();view.initializeRunMonitor(snapshot());const prior=flowStore.flow?.result;
 assert.equal(view.runHumanRequest()?.id,requestId);
 assert.throws(()=>view.acceptRunSnapshot({...snapshot(),execution:{id:nextId,organizationId:org}},runId),/different run/);
 assert.throws(()=>view.acceptRunSnapshot({...snapshot(),execution:{id:runId,organizationId:nextId}},runId),/different organization/);
 assert.throws(()=>view.acceptRunSnapshot(snapshot(0),runId),/older run snapshot/);
 assert.throws(()=>view.acceptRunSnapshot({...snapshot(),humanRequest:{...snapshot().humanRequest,id:nextId}},runId),/before the current response/);
 assert.equal(flowStore.flow?.result,prior);
});
test('terminal result cannot revive a resolved question or lose accepted review on rejection',()=>{
 const {view,flowStore}=fixture();view.initializeRunMonitor(snapshot());
 view.acceptRunSnapshot({...snapshot(2),humanRequest:{...snapshot().humanRequest,status:'resolved'}},runId);
 assert.equal(flowStore.flow?.resolvedRequestIds?.has(requestId),true);
 assert.throws(()=>view.acceptRunSnapshot(snapshot(3),runId),/already resolved/);
 const accepted={id:requestId,status:'resolved',answer:{answer:true}};if(flowStore.flow)flowStore.flow.acceptedRequest=accepted;
 assert.throws(()=>view.acceptRunSnapshot({...snapshot(4),execution:{id:runId,organizationId:org,status:'completed'},humanRequest:{...snapshot().humanRequest,id:nextId}},runId),/pending request for a terminal/);
 assert.equal(flowStore.flow?.acceptedRequest,accepted);
 view.acceptRunSnapshot({execution:{id:runId,organizationId:org,status:'completed'},latestSequence:4},runId);
 assert.throws(()=>view.acceptRunSnapshot({execution:{id:runId,organizationId:org,status:'running'},latestSequence:5},runId),/non-terminal/);
});
test('accepted commit retains safe execution identity when its question cannot be verified',()=>{
 const {view,flowStore}=fixture();view.initializeRunMonitor({...snapshot(),humanRequest:{id:requestId,execution:{id:nextId}}},null,{acceptedCommit:true});
 assert.equal(flowStore.flow?.baselineRequired,true);assert.equal(flowStore.flow?.result?.execution?.id,runId);
 assert.equal(flowStore.flow?.result?.humanRequest,undefined);assert.equal(view.runHumanRequest(),undefined);
});
test('a normal accepted commit keeps preparation provenance without restoring preparation-owned summary controls',()=>{
 const {view,flowStore}=fixture();
 const prepared={preparationId:nextId};
 view.initializeRunMonitor(snapshot(),{stage:'review',prepared,summaryOwner:'preparation',operations:new Map(),busy:false},{acceptedCommit:true});
 assert.equal(flowStore.flow?.prepared?.preparationId,nextId);
 assert.equal(flowStore.flow?.summaryOwner,undefined);
});
test('continuation requires matching receipt and accepted request facts',()=>{
 const {view}=fixture();const receipt='abcdefghijklmnop';
 assert.throws(()=>view.chatContinuation(runId,{trigger:'interaction_accepted',acceptedInteraction:{requestId,status:'pending'}}),/accepted interaction/);
 assert.throws(()=>view.chatContinuation(runId,{followContinuation:{runId:nextId,receipt}}),/receipt/);
 const continuation=view.chatContinuation(runId,{trigger:'interaction_accepted',acceptedInteraction:{requestId,status:'resolved'},followContinuation:{runId,receipt}});
 assert.equal(continuation.acceptedInteraction?.requestId,requestId);
 assert.match(view.formatChatContinuationMarkdown(runId,continuation),/^\$loomex-runs follow-existing-run /);
 assert.match(view.formatChatContinuationMarkdown(runId),/^To continue/);
});

test('monitor queue captions use fixed worker vocabulary and reject foreign evidence',()=>{
 const execution={id:runId,status:'queued'};
 const evidence={schemaVersion:'loomex.workflow-queue-observation/v1',executionId:runId,state:'queued',
  queuedAt:'2026-10-16T00:00:00Z',observedAt:'2026-10-16T00:01:00Z',waitSeconds:60};
 for(const [workerState,code,label] of [
  ['available','WORKFLOW_QUEUED','Queued · waiting for workflow worker'],
  ['starting','WORKFLOW_WORKER_STARTING','Queued · workflow worker starting'],
  ['busy','WORKFLOW_WORKER_BUSY','Queued · waiting for workflow worker capacity'],
  ['unavailable','WORKFLOW_WORKER_UNAVAILABLE','Queued · workflow worker unavailable'],
  ['unknown','WORKFLOW_WORKER_OBSERVATION_UNKNOWN','Queued · waiting for workflow worker'],
 ] as const){
  const observation=queueObservation({...evidence,workerState,code,message:'private provider text'},execution);
  assert.ok(observation);
  assert.equal(queueLabel(observation),label);
  assert.doesNotMatch(JSON.stringify(observation),/private|executionId/);
 }
 assert.equal(queueObservation({...evidence,workerState:'unavailable',code:'WORKFLOW_WORKER_UNAVAILABLE',executionId:nextId},execution),undefined);
 assert.equal(queueObservation({...evidence,workerState:'unavailable',code:'WORKFLOW_WORKER_UNAVAILABLE'},{...execution,status:'completed'}),undefined);
});

test('resolved monitor requests detach only their matching local draft without deleting remote drafts',()=>{
 const {host}=fixture();let detached=0;const calls:string[]=[];
 host.backendDraft=()=>({requestId,revision:1,schemaDigest:'a'.repeat(64)});
 host.detachInteractionDraft=()=>{detached++;};
 host.persistenceTool=async name=>{calls.push(name);return {};};
 const view=createRunMonitorController(host);
 view.initializeRunMonitor(snapshot());
 view.acceptRunSnapshot({...snapshot(2),humanRequest:{...snapshot().humanRequest,status:'resolved'}},runId);
 assert.equal(detached,1);
 assert.equal(calls.includes('loomex_interaction_draft_delete'),false);
});
