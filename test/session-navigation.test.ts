import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {createSessionNavigationController,type SessionNavigationServices} from '../src/ui-app/session-navigation.js';
import type {UiData,RpcResult,RunFlow,RuntimeViewSessionProjection} from '../src/ui-app/page-models.js';
const sessionId='cecfb615-af58-48c3-8294-1e6ef4f03256',runId='cecfb615-af58-48c3-8294-1e6ef4f03257',other='cecfb615-af58-48c3-8294-1e6ef4f03258';
function fixture(){
 let latest:UiData|null=null;const flowStore:{flow:RunFlow|null}={flow:null};const rendered:RpcResult[]=[];
 const host:SessionNavigationServices={flowStore,persistence:{session:{viewSessionId:sessionId,revision:0},changeVersion:0,configure:()=>false},elements:{form:{querySelectorAll:()=>[]} as unknown as HTMLFormElement,refresh:{dataset:{}} as HTMLButtonElement},
 setup:{selectedWorkflowVersion:()=>undefined,initializeRunSetup:()=>{},setupRequestIdentity:()=>undefined,initializePreparedRunReview:()=>{}},
 monitor:{initializeRunMonitor:data=>{flowStore.flow={stage:'monitor',result:data,operations:new Map(),busy:false};},renderIntegratedRunFlow:()=>{},acceptRunSnapshot:data=>data},presentation:{safeText:value=>typeof value==='string'?value:undefined,observePreparationReview:()=>{}},forms:{showQuestionStep:()=>{},beginAnswerReview:()=>true},mode:()=> 'monitor',setMode:()=>{},connected:()=>true,latest:()=>latest,setLatest:value=>{latest=value;},workflowIdValid:(value):value is string=>typeof value==='string'&&/^[0-9a-f-]{36}$/.test(value),dataOf:result=>result.structuredContent?.data||{},humanRequest:data=>data?.humanRequest??undefined,humanRequestResolved:request=>request.status==='resolved',executionId:data=>data?.execution?.id||'',interactionId:data=>data.humanRequest?.id,builderSessionId:()=>undefined,callTool:async()=>({structuredContent:{ok:true,data:{execution:{id:runId,status:'completed'}}}}),persistenceTool:async()=>({viewSessionId:sessionId,revision:0,kind:'monitor',entityType:'execution',entityId:runId}),requiredViewSession:value=>value as RuntimeViewSessionProjection,viewSessionProjection:result=>result._meta?.['loomex/viewSession'] as RuntimeViewSessionProjection??null,taskWorkspaceArguments:()=>({taskContext:{cwd:'/project'}}),restoreBrowserFromPersistence:async()=>{},restoreDisclosures:()=>{},restoreControls:()=>{},restoreReadingPosition:()=>{},fieldsetQuestionId:()=>null,render:result=>{rendered.push(result);},viewPersistenceFault:()=>null,enterSafeViewReentry:()=>{},syncRestorationVisibility:()=>{},persistenceStatus:()=>{},detachInteractionDraft:()=>{},hydrate:async()=>null,viewEntityMatches:()=>true,draftRequest:()=>null,loadInteractionDraft:async()=>true,restoreJournalOperation:async()=>true,ensureStartHandoff:async()=>{},setAction:()=>{},syncChrome:()=>{},desiredViewStatus:()=>undefined,markCurrentViewStatus:async()=>{},setError:()=>{}};
 return {host,view:createSessionNavigationController(host),flowStore,rendered,latest:()=>latest};
}
test('forwarded monitor restores from authoritative state and does not poison later restoration as cyclic',async()=>{
 const {view,flowStore}=fixture();const state={forwardSession:{viewSessionId:sessionId,kind:'monitor',entityType:'execution',entityId:runId}};
 assert.equal(await view.followForwardSession(state),true);assert.equal(flowStore.flow?.stage,'monitor');assert.equal(flowStore.flow?.result?.execution?.id,runId);
 assert.equal(view.state.followedViewSessions.size,0);assert.equal(await view.followForwardSession(state),true);
});
test('cyclic or substituted saved session paths fail without domain calls',async()=>{
 const {host}=fixture();let calls=0;host.callTool=async()=>{calls++;return {};};
 const forward={viewSessionId:sessionId,kind:'monitor',entityType:'execution',entityId:runId};
 host.persistenceTool=async()=>({revision:1,...forward,state:{forwardSession:forward}});
 const view=createSessionNavigationController(host);await assert.rejects(view.followForwardSession({forwardSession:forward}),/cyclic/);assert.equal(calls,0);assert.equal(view.state.followedViewSessions.size,0);
 host.persistenceTool=async()=>({revision:1,...forward,entityId:other});
 await assert.rejects(view.followForwardSession({forwardSession:forward}),/no longer matches/);assert.equal(calls,0);
});
test('reopened interaction replaces stale editable data with the authoritative resolved request',async()=>{
 const {host,rendered,latest}=fixture();host.callTool=async()=>({structuredContent:{ok:true,data:{humanRequest:{id:runId,status:'resolved',answer:{answer:true}}}}});
 const view=createSessionNavigationController(host);assert.equal(await view.refreshReopenedInteraction({viewSessionId:sessionId,requestId:runId},sessionId,0),true);
 assert.equal(latest()?.humanRequest?.status,'resolved');assert.equal(rendered.length,1);assert.equal(rendered[0]?._meta,undefined);
});
test('late reopened-request response cannot overwrite a new hydration generation',async()=>{
 const {host,rendered}=fixture();let release!:(result:RpcResult)=>void;host.callTool=()=>new Promise(resolve=>{release=resolve;});const view=createSessionNavigationController(host);
 const pending=view.refreshReopenedInteraction({viewSessionId:sessionId,requestId:runId},sessionId,0);view.lifecycle.invalidate();
 release({isError:true});assert.equal(await pending,false);assert.equal(rendered.length,0);
});
test('fresh authoritative content skips a redundant snapshot while disposal prevents later hydration',async()=>{
 const {host}=fixture();let release!:(value:RuntimeViewSessionProjection)=>void;host.hydrate=()=>new Promise(resolve=>{release=resolve;});const view=createSessionNavigationController(host);
 const pending=view.observeViewPersistence({_meta:{'loomex/viewSession':{viewSessionId:sessionId,revision:1,kind:'monitor',entityType:'execution',entityId:runId}}});await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(view.state.viewRestoring,false);view.dispose();release({viewSessionId:sessionId,revision:1});assert.equal(await pending,true);assert.equal(view.state.hydratedReadySessionId,'');
});

test('saved snapshot renders provisionally before the independent authoritative read completes',async()=>{
 const {host}=fixture();let release!:(value:RuntimeViewSessionProjection)=>void;const displayed:string[]=[];
 host.persistence.restoreSnapshot=async()=>({viewSessionId:sessionId,revision:1,kind:'monitor',entityType:'execution',entityId:runId});
 host.hydrate=()=>new Promise(resolve=>{release=resolve;});
 host.renderRestorationSnapshot=(_projection,phase)=>{displayed.push(phase);};
 const view=createSessionNavigationController(host);
 const restoring=view.observeViewPersistence({_meta:{'loomex/viewSession':{restoreVersion:'presentation.sessions.restore/v1',viewSessionId:sessionId,revision:1,kind:'monitor',entityType:'execution',entityId:runId}}});
 assert.equal(await restoring,true);assert.deepEqual(displayed,['verifying']);assert.equal(view.state.viewRestoring,false);assert.equal(view.state.hydratedReadySessionId,'');
 release({viewSessionId:sessionId,revision:1,kind:'monitor',entityType:'execution',entityId:runId});
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(view.state.viewRestorationPhase,'ready');assert.equal(view.state.hydratedReadySessionId,sessionId);
});

test('a stale preparation cannot substitute a different preparation or authoring operation to select a run',async()=>{
 const {host}=fixture();const calls:string[]=[];
 host.persistenceTool=async()=>({viewSessionId:sessionId,revision:1,kind:'prepare',entityType:'preparation',entityId:other});
 let response:UiData={status:'stale',reason:'commit_started',preparationId:sessionId,operation:'runs.prepare',executionId:runId};
 host.callTool=async(name)=>{calls.push(name);return {structuredContent:{ok:true,data:response}};};
 const view=createSessionNavigationController(host),state={forwardSession:{viewSessionId:sessionId,kind:'prepare',entityType:'preparation',entityId:other}};
 await assert.rejects(view.followForwardSession(state),/preparation is no longer available/);
 response={...response,preparationId:other,operation:'builder.prepare'};
 await assert.rejects(view.followForwardSession(state),/preparation is no longer available/);
 assert.deepEqual(calls,['loomex_preparation_get','loomex_preparation_get']);
});

test('an exact committed preparation restores its own read-only run snapshot',async()=>{
 const {host,flowStore}=fixture();const calls:string[]=[];
 host.persistenceTool=async()=>({viewSessionId:sessionId,revision:1,kind:'prepare',entityType:'preparation',entityId:other});
 host.callTool=async(name)=>{calls.push(name);return {structuredContent:{ok:true,data:name==='loomex_preparation_get'?{status:'stale',reason:'commit_started',preparationId:other,operation:'runs.prepare',executionId:runId}:{execution:{id:runId,status:'completed'}}}};};
 const view=createSessionNavigationController(host);
 assert.equal(await view.followForwardSession({forwardSession:{viewSessionId:sessionId,kind:'prepare',entityType:'preparation',entityId:other}}),true);
 assert.deepEqual(calls,['loomex_preparation_get','loomex_run_get']);assert.equal(flowStore.flow?.stage,'monitor');assert.equal(flowStore.flow?.result?.execution?.id,runId);
 assert.equal(flowStore.flow?.prepared?.preparationId,other,'the immutable preparation card retains its identity while showing the committed run');
 assert.equal(flowStore.flow?.summaryOwner,'preparation','only a restored preparation owns this inert summary');
});

test('a submitted review remount reconciles its committed run before Start can be restored',async()=>{
 const {host,flowStore}=fixture();const calls:string[]=[];let handoffIssues=0;
 const prepared={preparationId:other,binding:{workflowId:sessionId,versionId:sessionId,organizationId:sessionId,installationId:sessionId,workspacePath:'/project',executionPolicy:'host_user/v1',inputs:{},providerConfiguration:{}}};
 flowStore.flow={stage:'review',prepared,operations:new Map(),busy:false,startHandoffState:'unknown'};
 host.ensureStartHandoff=async()=>{handoffIssues++;};
 host.callTool=async(name)=>{calls.push(name);return {structuredContent:{ok:true,data:name==='loomex_preparation_get'
  ?{status:'stale',reason:'commit_started',preparationId:other,operation:'runs.prepare',executionId:runId}
  :{execution:{id:runId,status:'completed',workflowName:'Committed workflow'}}}};};
 const view=createSessionNavigationController(host);
 assert.equal(await view.restoreViewState({schemaVersion:1,screen:'review',preparationId:other,startHandoffState:'submitted'}),true);
 assert.deepEqual(calls,['loomex_preparation_get','loomex_run_get']);
 assert.equal(handoffIssues,0);assert.equal(flowStore.flow?.stage,'monitor');
 assert.equal(flowStore.flow?.result?.execution?.id,runId);
 assert.equal(flowStore.flow?.prepared?.preparationId,other,'the remounted preparation remains preparation-identified after commitment');
 assert.equal(flowStore.flow?.summaryOwner,'preparation');
});

test('a legacy serialized ambiguous resume is ignored because idempotency keys are not presentation state',async()=>{
 const {host,flowStore}=fixture();let resumeCalls=0;const observed:unknown[]=[];
 const prepared={preparationId:other,binding:{workflowId:sessionId,versionId:sessionId,organizationId:sessionId,installationId:sessionId,workspacePath:'/project',executionPolicy:'host_user/v1',inputs:{},providerConfiguration:{}}};
 flowStore.flow={stage:'review',prepared,operations:new Map(),busy:false,startHandoffState:'unknown'};
 // This models the automatic run-action reconciliation: a restored recovery
 // marker blocks a new resume until the person explicitly chooses Restore Start.
 host.ensureStartHandoff=async()=>{
  observed.push(structuredClone(flowStore.flow?.startHandoffOperation));
  if (!flowStore.flow?.startHandoffOperation) resumeCalls++;
 };
 const saved=JSON.parse(JSON.stringify({schemaVersion:1,screen:'review',preparationId:other,startHandoff:{schemaVersion:2,handoffRef:sessionId,lifecycle:'unknown',operation:{handoffRef:sessionId,resume:{state:'ambiguous',idempotencyKey:runId}}}}));
 const view=createSessionNavigationController(host);await view.restoreViewState(saved);
 assert.deepEqual(observed,[]);
 assert.equal(resumeCalls,0);
 assert.equal(flowStore.flow?.startHandoffReady,false);
});

test('a legacy serialized ambiguous issue is ignored because recovery comes from the operation journal',async()=>{
 const {host,flowStore}=fixture();let issueCalls=0;const observed:unknown[]=[];
 const prepared={preparationId:other,binding:{workflowId:sessionId,versionId:sessionId,organizationId:sessionId,installationId:sessionId,workspacePath:'/project',executionPolicy:'host_user/v1',inputs:{},providerConfiguration:{}}};
 flowStore.flow={stage:'review',prepared,operations:new Map(),busy:false,startHandoffState:'unknown'};
 host.ensureStartHandoff=async()=>{
  observed.push(structuredClone(flowStore.flow?.startHandoffOperation));
  if (!flowStore.flow?.startHandoffOperation) issueCalls++;
 };
 const saved=JSON.parse(JSON.stringify({schemaVersion:1,screen:'review',preparationId:other,startHandoff:{schemaVersion:2,handoffRef:null,lifecycle:'unknown',operation:{issue:{state:'ambiguous',idempotencyKey:runId}}}}));
 const view=createSessionNavigationController(host);await view.restoreViewState(saved);
 assert.deepEqual(observed,[]);
 assert.equal(issueCalls,0);
 assert.equal(flowStore.flow?.startHandoffReady,false);
});

test('committed preparation restoration rejects an actual active-card identity mismatch',async()=>{
 const {host,flowStore}=fixture();const errors:unknown[]=[];
 const prepared={preparationId:other,binding:{workflowId:sessionId,versionId:sessionId,organizationId:sessionId,installationId:sessionId,workspacePath:'/project',executionPolicy:'host_user/v1',inputs:{},providerConfiguration:{}}};
 flowStore.flow={stage:'review',prepared,operations:new Map(),busy:false,startHandoffState:'unknown'};
 const projection={viewSessionId:sessionId,revision:1,kind:'prepare',entityType:'preparation',entityId:other,state:{schemaVersion:1,screen:'review',preparationId:other,startHandoffState:'submitted'}} as RuntimeViewSessionProjection;
 host.hydrate=async()=>projection;
 host.callTool=async(name)=>({structuredContent:{ok:true,data:name==='loomex_preparation_get'
  ?{status:'stale',reason:'commit_started',preparationId:other,operation:'runs.prepare',executionId:runId}
  :{execution:{id:runId,status:'completed'}}}});
 host.viewEntityMatches=()=>false;
 host.setError=value=>{errors.push(value);};
 const view=createSessionNavigationController(host);
 assert.equal(await view.observeViewPersistence({_meta:{'loomex/viewSession':projection}}),true);
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(view.state.viewRestorationPhase,'verification_failed');
 assert.match(String(errors[0]),/no longer matches this card/);
 assert.equal(flowStore.flow?.stage,'review','a rejected identity does not replace the active preparation card');
});

test('disposing during committed-preparation reconciliation silently discards the late result',async()=>{
 const {host,flowStore}=fixture();const errors:unknown[]=[];let release!:(value:RpcResult)=>void;
 const prepared={preparationId:other,binding:{workflowId:sessionId,versionId:sessionId,organizationId:sessionId,installationId:sessionId,workspacePath:'/project',executionPolicy:'host_user/v1',inputs:{},providerConfiguration:{}}};
 flowStore.flow={stage:'review',prepared,operations:new Map(),busy:false,startHandoffState:'unknown'};
 const projection={viewSessionId:sessionId,revision:1,kind:'prepare',entityType:'preparation',entityId:other,state:{schemaVersion:1,screen:'review',preparationId:other,startHandoffState:'submitted'}} as RuntimeViewSessionProjection;
 host.hydrate=async()=>projection;
 host.callTool=()=>new Promise(resolve=>{release=resolve;});
 host.setError=value=>{errors.push(value);};
 const view=createSessionNavigationController(host);
 await view.observeViewPersistence({_meta:{'loomex/viewSession':projection}});
 await new Promise<void>(resolve=>setImmediate(resolve));
 view.dispose();
 release({structuredContent:{ok:true,data:{status:'stale',reason:'commit_started',preparationId:other,operation:'runs.prepare',executionId:runId}}});
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.deepEqual(errors,[]);
 assert.equal(flowStore.flow?.stage,'review');
});
