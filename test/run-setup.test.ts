import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRunSetupController, type RunSetupServices } from '../src/ui-app/run-setup.js';
import type { TaskWorkspace, UiData } from '../src/ui-app/page-models.js';
const id='cecfb615-af58-48c3-8294-1e6ef4f03256';
const id2='cecfb615-af58-48c3-8294-1e6ef4f03257';
function setup(inputSchema: UiData['inputSchema'] = {type:'object',properties:{}}): UiData {
  return { workflow:{id,organizationId:id,name:'Example'},selectedVersion:{id,workflowId:id,definition:{nodes:[]}},...(inputSchema?{inputSchema}:{}) };
}
function fixture() {
  let workspace: TaskWorkspace | null={taskContext:{cwd:'/project'}};
  let ready=true;
  let calls=0;
  const host:RunSetupServices={
    elements:{} as RunSetupServices['elements'], connected:()=>true,hydrationReady:()=>ready,
    taskWorkspace:()=>workspace,setTaskWorkspace:value=>{workspace=value;}, taskWorkspaceFrom:value=>value as TaskWorkspace,
    suggestedWorkspacePath:()=>workspace?.workspacePath || workspace?.taskContext?.cwd || '',
    safeText:(value,max=4096)=>typeof value==='string' && value.trim().length>0 && value.trim().length<=max?value.trim():undefined,
    authoredLabel:(key)=>key,workflowIdValid:(value):value is string=>typeof value==='string' && /^[0-9a-f-]{36}$/.test(value),workflowVersionNumber:value=>value?.version,
    rpcResult:value=>value as ReturnType<RunSetupServices['rpcResult']>,setAction:()=>{},setMutationAction:()=>{},renderFailure:()=>{},renderIntegratedRunFlow:()=>{},beginSetupReview:async()=>{calls++;},preparationView:()=>{},preparationReviewable:()=>true,
  };
  return {view:createRunSetupController(host),calls:()=>calls,setReady:(value:boolean)=>{ready=value;},setWorkspace:(value:TaskWorkspace)=>{workspace=value;}};
}
test('setup identity retains drafts only for the same version, organization and task workspace',()=>{
  const {view,setWorkspace}=fixture();const data=setup();
  view.initializeRunSetup(data,false,'source');
  assert.equal(view.matchesRunSetup(data,'source'),true);
  assert.equal(view.matchesRunSetup({...data,workflow:{id,organizationId:id2}},'source'),false);
  assert.equal(view.matchesRunSetup({...data,selectedVersion:{id:id2,definition:{nodes:[]}}},'source'),false);
  assert.equal(view.matchesRunSetup(data,'replacement'),false);
  setWorkspace({taskContext:{cwd:'/changed'}});
  assert.equal(view.matchesRunSetup(data,'source'),false);
  assert.equal(view.matchesRunSetup(data,'source',view.flow,true),true);
  assert.equal(view.matchesRunSetup(data,'',view.flow,true),false);
});
test('automatic preparation requires hydrated authority and cannot replay after scheduling or disposal',async()=>{
  const {view,setReady,calls}=fixture();view.initializeRunSetup(setup());
  setReady(false);assert.equal(view.scheduleAutomaticPreparation(),false);
  setReady(true);assert.equal(view.scheduleAutomaticPreparation(),true);
  assert.equal(view.scheduleAutomaticPreparation(),false);
  await Promise.resolve();assert.equal(calls(),1);
  view.initializeRunSetup(setup());assert.equal(view.scheduleAutomaticPreparation(),true);
  view.dispose();await Promise.resolve();assert.equal(calls(),1);
});
test('replacing a setup fences its pending automatic preparation',async()=>{
  const {view,calls}=fixture();view.initializeRunSetup(setup());view.scheduleAutomaticPreparation();
  view.initializeRunSetup(setup({type:'object',properties:{idea:{type:'string'}},required:['idea']}));
  await Promise.resolve();assert.equal(calls(),0);assert.equal(view.autoPreparationEligible(),false);
});
test('unsupported constraints and required fields fail closed to conversation',()=>{
  const {view}=fixture();
  assert.equal(view.setupSchemaAnalysis(setup({type:'object',properties:{},required:['missing']})).supported,false);
  assert.equal(view.setupSchemaAnalysis(setup({type:'object',properties:{value:{type:'string',pattern:'secret'}}})).supported,false);
  assert.equal(view.setupSchemaAnalysis(setup({type:'object',properties:{value:{type:'string'}},required:['value']})).supported,true);
});
