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
 const host:RunActionsServices={flowStore,browserState:{page:null,args:{limit:5},history:[],selected:null,detailResponse:null,busy:false,epoch:0,focusReturn:null},summary:{} as HTMLElement,
 setup:{selectedWorkflowVersion:()=>undefined,initializeRunSetup:()=>{},setupRequestIdentity:()=>undefined,collectRunSetupInputs:()=>({}),reprepareArguments:()=>undefined},
 monitor:{stalePreparationError:()=>false,acceptRunSnapshot:()=>({}),renderIntegratedRunFlow:()=>{renderCount++;},initializeRunMonitor:()=>{},handoffRunToChat:async()=>{},captureRunHumanDraft:()=>{}},presentation,
 workflowIdValid:idValid,workflowVersionNumber:()=>1,runFlowError:message=>{errors.push(message);},structuredError:result=>result.structuredContent?.error||null,errorCodeOf:result=>result.structuredContent?.error?.code||'',dataOf:result=>result.structuredContent?.data||{},executionId:data=>data?.execution?.id||'',humanRequest:data=>data?.humanRequest,
 callTool:async(name,args)=>{calls.push({name,args});return {structuredContent:{ok:true,data:{}}};},sessionTool:async()=>({viewSessionId:id,revision:1}),persistenceTool:async()=>({}),viewSessionProjection:()=>null,exactSessionUpdate:async()=>({viewSessionId:id,revision:1}),observeViewPersistence:()=>{},session:()=>null,captureViewState:()=>({}),flushCurrentPersistence:async()=>true,requireMutationHydrationReady:()=>{},journalMutationOperation:async operation=>{operation.operationId=id;},settleMutationOperation:async(operation,status)=>{operation.journalStatus=status;},transitionSessionAfterSuccess:async()=>{},authoritativeStateStale:()=>false,setAuthoritativeStateStale:()=>{},setLatest:()=>{},showBrowserSkeleton:()=>{},clearBrowserSkeleton:()=>{},renderBrowser:()=>{},restoreBrowserFocus:()=>{},setError:()=>{},taskWorkspaceArguments:()=>({taskContext:{cwd:'/project'}}),send:async()=>({}),restorePreparationPresentation:()=>{},draft:()=>null,detachInteractionDraft:()=>{},uuid:()=>id};
 return {host,view:createRunActionsController(host),flowStore,calls,errors,renders:()=>renderCount};
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
 host.journalMutationOperation=async operation=>{operation.operationId=id;await gate;};
 const view=createRunActionsController(host);const pending=view.runFlowMutation('loomex_workspace_grant','workspace','check',{workspacePath:'/project'},async()=>{});
 await Promise.resolve();view.dispose();release();await pending;assert.equal(calls.length,0);assert.equal(flowStore.flow?.operations.size,1);
});
test('a delayed snapshot cannot update a replacement view',async()=>{
 const {host,flowStore,renders}=fixture();flowStore.flow={stage:'monitor',operations:new Map(),busy:false,result:{execution:{id,status:'running'}},humanDrafts:new Map(),resolvedRequestIds:new Set()};
 let release!:(value:RpcResult)=>void;host.callTool=()=>new Promise(resolve=>{release=resolve;});const view=createRunActionsController(host);
 const pending=view.readRunSnapshot();await Promise.resolve();flowStore.flow=null;const before=renders();release({structuredContent:{ok:true,data:{execution:{id,status:'completed'}}}});
 assert.equal(await pending,false);assert.equal(renders(),before);assert.equal(flowStore.flow,null);
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
