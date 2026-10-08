import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {parseTaskWorkspace, selectedAdditionalWorkspaces, boundWorkspaceSetValid, compareWorkspacePaths} from '../src/ui-app/workspace-context.js';
import {TOOL_DEFINITIONS} from '../src/tool-catalog.js';

test('only verified caller context contributes project directories; overrides replace it',()=>{
 const context=parseTaskWorkspace({taskContext:{cwd:'/primary',projectDirectories:['/b','/primary','/b','/a']},filesystem:{workspace_roots:['/unrelated']}});
 assert.deepEqual(selectedAdditionalWorkspaces(context),['/a','/b']);
 assert.deepEqual(selectedAdditionalWorkspaces(parseTaskWorkspace({taskContext:{cwd:'/primary',projectDirectories:['/other']},workspacePath:'/override'})),[]);
 assert.deepEqual(selectedAdditionalWorkspaces(parseTaskWorkspace({taskContext:{cwd:'/primary',projectDirectories:['/other']},workspacePath:'/override',additionalWorkspacePaths:['/explicit']})),['/explicit']);
 assert.deepEqual(selectedAdditionalWorkspaces(parseTaskWorkspace({taskContext:{cwd:'/primary'}})),[]);
 assert.equal(parseTaskWorkspace({taskContext:{cwd:'/primary',projectDirectories:['relative']}}),null);
});

test('sealed root contracts preserve single-root records and reject unnegotiated additions',()=>{
 assert.ok(boundWorkspaceSetValid({workspacePath:'/primary'}));
 assert.ok(boundWorkspaceSetValid({workspacePath:'/primary',workspaceSetContract:'execution.workspace-set/v1',additionalWorkspacePaths:['/a','/b']}));
 for(const additionalWorkspacePaths of [['/primary'],['/b','/a'],['/a','/a'],['relative']]) {
  assert.equal(boundWorkspaceSetValid({workspacePath:'/primary',workspaceSetContract:'execution.workspace-set/v1',additionalWorkspacePaths}),false);
 }
 assert.equal(boundWorkspaceSetValid({workspacePath:'/primary',additionalWorkspacePaths:['/a']}),false);
});

test('visual, headless preparation and grant schemas accept explicit roots without adding authoring cards',()=>{
 const id='11111111-1111-4111-8111-111111111111';
 const setup=TOOL_DEFINITIONS.find(t=>t.name==='loomex_run_setup')!;
 assert.ok(setup.inputSchema.safeParse({workflowId:id,taskContext:{cwd:'/primary',projectDirectories:['/extra']},additionalWorkspacePaths:['/explicit']}).success);
 for(const name of ['loomex_run_prepare','loomex_workspace_grant']) {
  const tool=TOOL_DEFINITIONS.find(t=>t.name===name)!;
  const parsed=tool.inputSchema.safeParse({...(name==='loomex_run_prepare'?{workflowId:id,versionId:id}:{}),workspacePath:'/primary',additionalWorkspacePaths:['/extra'],idempotencyKey:id});
  assert.ok(parsed.success,name);
 }
 const native=TOOL_DEFINITIONS.find(t=>t.name==='loomex_builder_start')!;
 assert.equal(native.inputSchema.safeParse({prompt:'Build it',idempotencyKey:id,workspacePath:'/primary'}).success,false);
});


test('workspace ordering matches Unicode scalar order across contract boundaries',()=>{
 assert.deepEqual(['/😀','/\uffff','/a'].sort(compareWorkspacePaths),['/a','/\uffff','/😀']);
});
