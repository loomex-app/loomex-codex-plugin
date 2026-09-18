import {deliveryJournalFixture} from "./delivery-fixture.js";
import {ContinuationDeliveryController} from "../src/ui-app/continuation-delivery.js";
import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {createRunActionsController,type RunActionsServices} from '../src/ui-app/run-actions.js';
import {createRunPresentation} from '../src/ui-app/run-presentation.js';
import type {RunFlow,RpcResult} from '../src/ui-app/page-models.js';
const id='cecfb615-af58-48c3-8294-1e6ef4f03256';const other='cecfb615-af58-48c3-8294-1e6ef4f03257';
function fixture(){
 const flowStore:{flow:RunFlow|null}={flow:{stage:'setup',selected:{workflowId:id,versionId:id,organizationId:id},canonicalWorkspace:'/project',installationId:id,operations:new Map(),busy:false}};
 const calls:Array<{name:string,args:Record<string,unknown>}> = [];const errors:string[]=[];let renderCount=0;
 const idValid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f-]{36}$/.test(value);
 const presentation=createRunPresentation({context:{} as HTMLElement,questionCopyValues:()=>[],workflowIdValid:idValid});
 const host:RunActionsServices={delivery:new ContinuationDeliveryController({available:()=>true,uuid:()=>"test-attempt",journal:deliveryJournalFixture(),send:text=>host.send("ui/message",{role:"user",content:[{type:"text",text}]})}),flowStore,browserState:{page:null,args:{limit:5},history:[],selected:null,detailResponse:null,busy:false,epoch:0,focusReturn:null},summary:{classList:{add:()=>{},remove:()=>{}},setAttribute:()=>{},textContent:''} as unknown as HTMLElement,
 setup:{selectedWorkflowVersion:()=>undefined,initializeRunSetup:()=>{},setupRequestIdentity:()=>undefined,collectRunSetupInputs:()=>({}),reprepareArguments:()=>undefined},
 monitor:{stalePreparationError:()=>false,acceptRunSnapshot:()=>({}),renderIntegratedRunFlow:()=>{renderCount++;},initializeRunMonitor:()=>{},handoffRunToChat:async()=>{},captureRunHumanDraft:()=>{}},presentation,
 workflowIdValid:idValid,workflowVersionNumber:()=>1,runFlowError:message=>{errors.push(message);},structuredError:result=>result.structuredContent?.error||null,errorCodeOf:result=>result.structuredContent?.error?.code||'',dataOf:result=>result.structuredContent?.data||{},executionId:data=>data?.execution?.id||'',humanRequest:data=>data?.humanRequest,
 callTool:async(name,args)=>{calls.push({name,args});return {structuredContent:{ok:true,data:{}}};},sessionTool:async()=>({viewSessionId:id,revision:1}),persistenceTool:async()=>({}),viewSessionProjection:()=>null,exactSessionUpdate:async()=>({viewSessionId:id,revision:1}),observeViewPersistence:()=>{},session:()=>null,captureViewState:()=>({}),flushCurrentPersistence:async()=>true,requireMutationHydrationReady:()=>{},journalMutationOperation:async operation=>{operation.operationId=id;operation.viewSessionId=id;operation.stage="journaled";},settleMutationOperation:async(operation,status)=>{operation.journalStatus=status;},transitionSessionAfterSuccess:async()=>{},authoritativeStateStale:()=>false,setAuthoritativeStateStale:()=>{},setLatest:()=>{},showBrowserSkeleton:()=>{},clearBrowserSkeleton:()=>{},renderBrowser:()=>{},restoreBrowserFocus:()=>{},setError:()=>{},taskWorkspaceArguments:()=>({taskContext:{cwd:'/project'}}),send:async()=>({}),restorePreparationPresentation:()=>{},draft:()=>null,detachInteractionDraft:()=>{},uuid:()=>id};
 return {host,view:createRunActionsController(host),flowStore,calls,errors,presentation,renders:()=>renderCount};
}
function prepared():RpcResult {return {structuredContent:{ok:true,data:{preparationId:id,confirmationKey:other,bindingDigest:'a'.repeat(64),binding:{workflowId:id,versionId:id,organizationId:id,installationId:id,workspacePath:'/project',executionPolicy:'host_user/v1',inputs:{idea:'A'},providerConfiguration:{}}}},_meta:{'loomex/preparationReview':{schemaVersion:'loomex/preparation-review/v1',preparationId:id,bindingDigest:'a'.repeat(64),workflowId:id,versionId:id,organizationId:id,workflowName:'W',organizationName:'O',workflowVersion:1,providers:[]}}};}
test('preparation validation checks exact inputs, workspace, organization and reviewed metadata',()=>{
 const {view}=fixture();const result=prepared();assert.ok(view.validateRunPreparationResult(result,{inputs:{idea:'A'}}));
 assert.throws(()=>view.validateRunPreparationResult(result,{inputs:{idea:'B'}}),/sealed setup/);
 for(const change of [{workspacePath:'/other'},{organizationId:other},{installationId:other},{executionPolicy:'unknown'}]){
  const modified=structuredClone(result);if(modified.structuredContent?.data?.binding)Object.assign(modified.structuredContent.data.binding,change);
  assert.throws(()=>view.validateRunPreparationResult(modified,{inputs:{idea:'A'}}),/sealed setup/);
 }
 assert.throws(()=>view.validateRunPreparationResult({...result,_meta:{}},{inputs:{idea:'A'}}),/sealed setup/);
});
test('commit acceptance requires the original preparation and execution policy',()=>{
 const {view}=fixture();const result={structuredContent:{ok:true,data:{execution:{id},preparationId:id,executionPolicy:'host_user/v1'}}};
 assert.equal(view.validateRunCommitResult(result,{preparationId:id}).runId,id);
 assert.throws(()=>view.validateRunCommitResult(result,{preparationId:other}),/exact preparation/);
});
test('ambiguous run action retries the frozen arguments and key even after caller edits',async()=>{
 const {host,flowStore,calls}=fixture();let accepted=0;
 host.callTool=async(name,args)=>{calls.push({name,args});return calls.length===1?{structuredContent:{ok:false,error:{code:'NETWORK_AMBIGUOUS'}}}:{structuredContent:{ok:true,data:{}}};};
 const view=createRunActionsController(host);
 await view.runFlowMutation('loomex_workspace_grant','workspace','check',{workspacePath:'/project'},async()=>{accepted++;});
 assert.equal(flowStore.flow?.operations.size,1);
 await view.runFlowMutation('loomex_workspace_grant','workspace','check',{workspacePath:'/changed'},async()=>{accepted++;});
 assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0]);assert.equal(accepted,1);assert.equal(flowStore.flow?.operations.size,0);
});
test('disposing during journal write prevents domain dispatch while retaining exact recovery intent',async()=>{
 const {host,calls,flowStore}=fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 host.journalMutationOperation=async operation=>{operation.operationId=id;operation.viewSessionId=id;operation.stage="journaled";await gate;};
 const view=createRunActionsController(host);const pending=view.runFlowMutation('loomex_workspace_grant','workspace','check',{workspacePath:'/project'},async()=>{});
 await Promise.resolve();view.dispose();release();await pending;assert.equal(calls.length,0);assert.equal(flowStore.flow?.operations.size,1);
});
test('a delayed snapshot cannot update a replacement view',async()=>{
 const {host,flowStore,renders}=fixture();flowStore.flow={stage:'monitor',operations:new Map(),busy:false,result:{execution:{id,status:'running'}},humanDrafts:new Map(),resolvedRequestIds:new Set()};
 let release!:(value:RpcResult)=>void;host.callTool=()=>new Promise(resolve=>{release=resolve;});const view=createRunActionsController(host);
 const pending=view.readRunSnapshot();await Promise.resolve();flowStore.flow=null;const before=renders();release({structuredContent:{ok:true,data:{execution:{id,status:'completed'}}}});
 assert.equal(await pending,false);assert.equal(renders(),before);assert.equal(flowStore.flow,null);
});

function handoff(lifecycle:string){return {structuredContent:{ok:true,data:{handoffRef:id,preparationId:id,lifecycle,approvalObserved:lifecycle!=='prepared',nextAction:'inspect'}}};}
function issue(){return {structuredContent:{ok:true,data:{handoffRef:id,preparationId:id,lifecycle:'prepared',approvalObserved:false,nextAction:'approve'}}};}
function reviewed(flowStore:{flow:RunFlow|null},presentation:ReturnType<typeof createRunPresentation>){
 presentation.restorePreparationPresentation(prepared()._meta?.['loomex/preparationReview']);
 flowStore.flow={stage:'review',selected:{workflowId:id,versionId:id,organizationId:id},canonicalWorkspace:'/project',installationId:id,operations:new Map(),busy:false,prepared:prepared().structuredContent!.data!,startHandoffRef:id,startHandoffState:'prepared'} as unknown as RunFlow;
 return flowStore.flow as RunFlow & {startHandoffRef:string;startHandoffState:string;startHandoffOperation?:Record<string,unknown>};
}
async function reviewedFromIssue(host:RunActionsServices,flowStore:{flow:RunFlow|null},presentation:ReturnType<typeof createRunPresentation>){
 host.restorePreparationPresentation=value=>{presentation.restorePreparationPresentation(value);};
 const view=createRunActionsController(host);const afterPrepared=await view.acceptRunPreparation(prepared(),{inputs:{idea:'A'}});await afterPrepared?.();
 return {view,flow:flowStore.flow as RunFlow & {startHandoffRef:string;startHandoffState:string;startHandoffOperation?:Record<string,unknown>;startHandoffReady?:boolean}};
}

test('preparation settles and transitions its source card without issuing a Start handoff', async () => {
 const {host,flowStore,presentation}=fixture();const events:string[]=[];
 host.restorePreparationPresentation=value=>{presentation.restorePreparationPresentation(value);};
 host.sessionTool=async()=>({viewSessionId:other,revision:1,kind:'prepare',entityType:'preparation',entityId:id});
 host.callTool=async(name,args)=>{
  events.push(`call:${name}`);
  if(name==='loomex_run_prepare') return prepared();
  if(name==='loomex_run_start_handoff_issue') return issue();
  throw new Error(`unexpected ${name}`);
 };
 host.settleMutationOperation=async(operation,status)=>{events.push(`settle:${operation.name}:${status}`);operation.journalStatus=status;};
 host.transitionSessionAfterSuccess=async operation=>{events.push(`transition:${operation.name}`);};
 const view=createRunActionsController(host);
 await view.runFlowMutation('loomex_run_prepare',`prepare:${id}:/project`,'review',{versionId:id,workflowId:id,workspacePath:'/project',inputs:{idea:'A'}},view.acceptRunPreparation);
 const settled=events.indexOf('settle:loomex_run_prepare:completed');
 const transitioned=events.indexOf('transition:loomex_run_prepare');
 assert.ok(settled>=0 && transitioned>settled,events.join(', '));
 assert.equal(events.includes('call:loomex_run_start_handoff_issue'),false,events.join(', '));
 assert.equal(flowStore.flow?.operations.has(`prepare:${id}:/project`),false);
});

test('Start records the app-only approval before handing off to chat',async()=>{
 const {host,flowStore,calls,errors,presentation}=fixture();let sent=0;
 host.send=async(method,args)=>{sent++;assert.ok(['ui/update-model-context','ui/message'].includes(method));assert.match(String((args.content as Array<{text:string}>)[0]?.text),new RegExp(id));return {};};
 host.callTool=async(name,args)=>{
  calls.push({name,args});
  if(name==='loomex_run_start_handoff_issue') return issue();
  if(name==='loomex_run_start_handoff_approve') return handoff('approved');
  throw new Error(`unexpected ${name}`);
 };
 const {view,flow}=await reviewedFromIssue(host,flowStore,presentation);
 await view.handleRunFlowPrimary();
 assert.equal(calls.filter(call=>call.name==='loomex_run_start_handoff_approve').length,1);
 assert.equal(sent,1);assert.equal(flow.startHandoffState,'approved');assert.equal(errors.length,0);
});

test('a rejected app-only approval does not send chat or create a browser request',async()=>{
 const {host,flowStore,calls,errors,presentation}=fixture();let messages=0;
 host.send=async()=>{messages++;return {};};
 host.callTool=async(name,args)=>{
  calls.push({name,args});
  if(name==='loomex_run_start_handoff_issue') return issue();
  if(name==='loomex_run_start_handoff_approve') return {structuredContent:{ok:false,error:{code:'START_HANDOFF_STALE'}}};
  throw new Error(`unexpected ${name}`);
 };
 const {view}=await reviewedFromIssue(host,flowStore,presentation);
 await view.handleRunFlowPrimary();
 assert.equal(messages,0);assert.equal(calls.filter(call=>call.name==='loomex_run_start_handoff_approve').length,1);
 assert.match(errors.at(-1) || '',/Start approval/);
});

test('remount reconciliation uses the handoff reference and never issues or approves a duplicate operation',async()=>{
 const {host,flowStore,calls,presentation}=fixture();const flow=reviewed(flowStore,presentation);flow.startHandoffState='unknown';
 host.session=()=>({viewSessionId:id,revision:1,state:{startHandoffRef:id}});
 host.callTool=async(name,args)=>{calls.push({name,args});return handoff('committed');};
 const view=createRunActionsController(host);await view.ensureStartHandoff();await view.ensureStartHandoff();
 assert.equal(flow.startHandoffState,'committed');
 assert.deepEqual(calls.map(call=>call.name),['loomex_run_start_handoff_get','loomex_run_start_handoff_get']);
 assert.equal(calls.some(call=>call.name==='loomex_run_start_handoff_issue'||call.name==='loomex_run_start_handoff_approve'),false);
});

test('definitively invalid remounted handoffs retire the preparation and clear their dead reference',async()=>{
 const outcomes:Array<[string, RpcResult]> = [
  ['expired',handoff('expired')],
  ['missing',{structuredContent:{ok:false,error:{code:'START_HANDOFF_NOT_FOUND'}}}],
  ['mismatched',{structuredContent:{ok:true,data:{handoffRef:other,preparationId:id,lifecycle:'prepared',approvalObserved:false,nextAction:'approve'}}}],
 ];
 for (const [label,outcome] of outcomes) {
  const {host,flowStore,calls,errors,presentation}=fixture();const flow=reviewed(flowStore,presentation);flow.startHandoffState='unknown';
  host.session=()=>({viewSessionId:id,revision:1,state:{startHandoff:{handoffRef:id,lifecycle:'unknown'}}});
  host.callTool=async(name,args)=>{calls.push({name,args});return outcome;};
  const view=createRunActionsController(host);
  await view.ensureStartHandoff();
  assert.equal(flow.preparationStale,true,label);
  assert.equal(flow.startHandoffRef,undefined,label);
  assert.equal(flow.startHandoffState,'unknown',label);
  assert.equal(flow.startHandoffReady,false,label);
  assert.match(errors.at(-1) || '',/Review the run again/,label);
  await view.ensureStartHandoff();
  assert.deepEqual(calls.map(call=>call.name),['loomex_run_start_handoff_get'],label);
 }
});

test('a prepared remount enables Start without a browser-network recovery',async()=>{
 const {host,flowStore,calls,presentation}=fixture();const flow=reviewed(flowStore,presentation);flow.startHandoffState='unknown';
 host.session=()=>({viewSessionId:id,revision:1,state:{startHandoffRef:id}});
 host.callTool=async(name,args)=>{calls.push({name,args});if(name==='loomex_run_start_handoff_get')return handoff('prepared');throw new Error(`unexpected ${name}`);};
 const view=createRunActionsController(host);await Promise.all([view.ensureStartHandoff(),view.ensureStartHandoff()]);
 assert.equal(flow.startHandoffState,'prepared');assert.equal(flow.startHandoffReady,true);
 assert.deepEqual(calls.map(call=>call.name),['loomex_run_start_handoff_get','loomex_run_start_handoff_get']);
});

test('an ambiguous initial issue is durable and Restore Start only reads its exact handoff',async()=>{
 const {host,flowStore,calls,presentation}=fixture();let issues=0;let keyIndex=0;host.uuid=()=>[id,other][keyIndex++] || other;
 host.restorePreparationPresentation=value=>{presentation.restorePreparationPresentation(value);};
 host.callTool=async(name,args)=>{
  calls.push({name,args});
  if(name==='loomex_run_start_handoff_issue') return ++issues===1?{structuredContent:{ok:false,error:{code:'NETWORK_AMBIGUOUS'}}}:issue();
  if(name==='loomex_run_start_handoff_restore') return handoff('prepared');
  throw new Error(`unexpected ${name}`);
 };
 const view=createRunActionsController(host);const afterPrepared=view.acceptRunPreparation(prepared(),{inputs:{idea:'A'}});if(typeof afterPrepared==='function')await afterPrepared();
 const flow=flowStore.flow as RunFlow & {startHandoffState?:string;startHandoffOperation?:Record<string,unknown>};
 assert.equal(flow.startHandoffState,'unknown');assert.equal(flow.startHandoffOperation,undefined);
 await view.handleRunFlowPrimary();assert.equal(issues,1);assert.deepEqual(flow.startHandoffOperation,{reconciliation:'pending'});
 await view.handleRunFlowPrimary();assert.equal(flow.startHandoffState,'prepared');
 const first=calls.find(call=>call.name==='loomex_run_start_handoff_issue');const restore=calls.find(call=>call.name==='loomex_run_start_handoff_restore');
 assert.ok(first&&restore);assert.deepEqual(restore.args,{idempotencyKey:first.args.idempotencyKey});
 assert.equal(calls.some(call=>call.name==='loomex_run_start_handoff_resume'),false);
});

test('issued handoffs retain only a reference and prepared lifecycle in the UI flow',async()=>{
 const {host,flowStore,presentation}=fixture();host.callTool=async name=>name==='loomex_run_start_handoff_issue'
  ?issue():handoff('prepared');
 host.restorePreparationPresentation=value=>{presentation.restorePreparationPresentation(value);};
 const view=createRunActionsController(host);const afterPrepared=view.acceptRunPreparation(prepared(),{inputs:{idea:'A'}});if(typeof afterPrepared==='function')await afterPrepared();
 await view.ensureStartHandoff();
 const flow=flowStore.flow as RunFlow & {startHandoffRef?:string;startHandoffState?:string;startHandoffOperation?:Record<string,unknown>;startHandoffReady?:boolean};
 assert.equal(flow.startHandoffRef,id);assert.equal(flow.startHandoffState,'prepared');assert.equal(flow.startHandoffReady,true);
 assert.deepEqual(flow.startHandoffOperation,{handoffRef:id,lifecycle:'prepared'});
});

test('manual workspace setup validates form inputs before requiring the collected workspace', async () => {
  const {host, flowStore, calls} = fixture();
  const flow = flowStore.flow!;
  flow.analysis = {supported: true, schema: {}, entries: []};
  flow.workspaceDraft = '';
  let collected = false;
  host.setup.collectRunSetupInputs = () => {
    collected = true;
    throw new Error('Complete the required inputs before continuing.');
  };
  const view = createRunActionsController(host);
  await assert.rejects(view.beginSetupReview(), /Complete the required inputs/);
  assert.equal(collected, true);
  assert.equal(calls.length, 0);
});

test('committed run continues after failed target transition and never redispatches on recovery', async () => {
 const {host, calls, flowStore}=fixture(); let sent=0, transitions=0;
 host.transitionSessionAfterSuccess=async()=>{if(++transitions===1)throw new Error('presentation unavailable');};
 host.sessionTool=async()=>({viewSessionId:other,revision:1,kind:'monitor',entityType:'execution',entityId:id});
 host.callTool=async(name,args)=>{calls.push({name,args});return {structuredContent:{ok:true,data:{execution:{id,status:'running'},preparationId:id,executionPolicy:'host_user/v1'}}};};
 host.send=async()=>{sent++;return {};};
 const accept=async()=>async()=>{await host.delivery.deliver({identity:`follow:${id}:run_started`,purpose:'follow_run',text:'unused'});};
 const view=createRunActionsController(host);
 await view.runFlowMutation('loomex_run_commit','commit','start',{preparationId:id},accept);
 assert.equal(calls.filter(c=>c.name==='loomex_run_commit').length,1);assert.equal(sent,1);
 assert.equal(flowStore.flow?.operations.get('commit')?.journalStatus,'completed');
 await view.runFlowMutation('loomex_run_commit','commit','start',{preparationId:id},accept);
 assert.equal(calls.filter(c=>c.name==='loomex_run_commit').length,1);assert.equal(sent,1);
 assert.equal(flowStore.flow?.operations.size,0);
});
