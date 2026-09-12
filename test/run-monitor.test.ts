import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {createRunMonitorController,type RunMonitorServices} from '../src/ui-app/run-monitor.js';
import type {UiData,RunFlow} from '../src/ui-app/page-models.js';
const runId='cecfb615-af58-48c3-8294-1e6ef4f03256';
const org='cecfb615-af58-48c3-8294-1e6ef4f03257';
const requestId='cecfb615-af58-48c3-8294-1e6ef4f03258';
const nextId='cecfb615-af58-48c3-8294-1e6ef4f03259';
function fixture(){
 const flowStore:{flow:RunFlow|null}={flow:null};let latest:UiData|null=null;
 const host:RunMonitorServices={flowStore,elements:{} as RunMonitorServices['elements'],forms:{} as RunMonitorServices['forms'],connected:()=>true,latest:()=>latest,setLatest:value=>{latest=value;},capabilities:()=>({}),backendDraft:()=>null,detachInteractionDraft:()=>{},draftRequest:()=>undefined,requestSchemaDigest:request=>request.schemaDigest,humanRequest:data=>data?.humanRequest??undefined,humanRequestResolved:request=>['resolved','approved','rejected'].includes(request.status||''),executionId:data=>data?.execution?.id||'',interactionId:data=>data.humanRequest?.id||'',safeText:(value,max=4096)=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=max?value.trim():undefined,workflowIdValid:(value):value is string=>typeof value==='string'&&/^[0-9a-f-]{36}$/.test(value),terminalRun:run=>['completed','failed','canceled'].includes(run.status||''),renderRun:()=>{},renderHumanPresentation:()=>true,humanPresentation:request=>request.presentation,formatStatus:value=>String(value),setAction:()=>{},setMutationAction:()=>{},setInteractionAction:()=>{},setError:()=>{},syncChrome:()=>{},onRender:()=>{},runFlowError:()=>{},renderRunSetup:()=>{},renderRunReview:()=>{},dataOf:result=>result.structuredContent?.data||{},send:async()=>({}),persistenceTool:async()=>({}),settleMutationOperation:async()=>({}),transitionSessionAfterSuccess:async()=>({}),uuid:()=>runId};
 return {view:createRunMonitorController(host),flowStore,latest:()=>latest};
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
test('continuation requires matching receipt and accepted request facts',()=>{
 const {view}=fixture();const receipt='abcdefghijklmnop';
 assert.throws(()=>view.chatContinuation(runId,{trigger:'interaction_accepted',acceptedInteraction:{requestId,status:'pending'}}),/accepted interaction/);
 assert.throws(()=>view.chatContinuation(runId,{followContinuation:{runId:nextId,receipt}}),/receipt/);
 const continuation=view.chatContinuation(runId,{trigger:'interaction_accepted',acceptedInteraction:{requestId,status:'resolved'},followContinuation:{runId,receipt}});
 assert.equal(continuation.acceptedInteraction?.requestId,requestId);
 assert.match(view.formatChatContinuationMarkdown(runId,continuation),/^\$loomex-follow /);
 assert.match(view.formatChatContinuationMarkdown(runId),/^To continue/);
});
