import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {createMutationController, type MutationControllerServices, type MutationSessionProjection} from '../src/ui-app/mutation-controller.js';
import type {JsonObject} from '../src/ui-app/contracts.js';

test('real runner journal fences predecessors, lost writes, duplicates and owner substitution',async(t)=>{
 const executable=process.env.LOOMEX_PRESENTATION_FIXTURE;
 if(!executable){t.skip('Run test:cross-boundary to build the isolated Rust presentation fixture');return;}
 const child=spawn(executable,[],{stdio:['pipe','pipe','inherit']});
 const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
 const rpc=async(method:string,params:Readonly<JsonObject>,org='fixture-org'):Promise<JsonObject>=>{
  child.stdin.write(JSON.stringify({method,params,org})+'\n');
  const line=await lines.next();assert.equal(line.done,false);
  const response=JSON.parse(line.value!) as {result?:JsonObject;error?:{code:string}};
  if(response.error)throw Object.assign(new Error(response.error.code),{code:response.error.code});
  return response.result!;
 };
 try {
  let session=await rpc('presentation.sessions.create',{kind:'prepare',entityType:'preparation',entityId:randomUUID(),state:{},idempotencyKey:randomUUID()}) as unknown as MutationSessionProjection;
  let lose=true;const mapping:Record<string,string>={loomex_view_session_update:'presentation.sessions.update',loomex_view_session_get:'presentation.sessions.get',loomex_view_operation_get:'presentation.operations.get',loomex_view_operation_settle:'presentation.operations.settle'};
  const services:MutationControllerServices={createIdempotencyKey:randomUUID,dataOf:r=>r.structuredContent?.data??{},transport:{beginAuthoritativeRequest:()=>1,isAuthoritativeRequestCurrent:()=>true,callTool:async()=>{throw new Error('No domain execution in journal fixture');}},persistence:{ready:()=>true,currentSession:()=>session,flushCurrent:async()=>true,captureState:()=>({screen:'review'}),acceptRevision:(_id,revision)=>{session={...session,revision};},call:async(name,args)=>{const result=await rpc(mapping[name]!,args);if(lose&&name==='loomex_view_session_update'){lose=false;throw Object.assign(new Error('lost reply'),{code:'NETWORK_AMBIGUOUS'});}return result;}},presentation:{authoritativeFailure:()=>{},present:()=>{},observe:()=>{},persistenceFailure:()=>{},lock:()=>{},unlock:()=>{},acceptTargetSession:()=>{}}};
  const controller=createMutationController(services);
  const first=controller.operation('loomex_run_start_handoff_issue','first',{preparationId:randomUUID(),bindingDigest:'a'.repeat(64),confirmationKey:randomUUID()});
  await controller.journal(first);assert.ok(first.operationId);assert.equal(first.stage,'journaled');
  const duplicate=await rpc('presentation.sessions.update',first.journalAttempt! as unknown as JsonObject);
  assert.equal((duplicate.operation as JsonObject).operationId,first.operationId);
  await assert.rejects(()=>rpc('presentation.sessions.update',{viewSessionId:session.viewSessionId,expectedRevision:0,state:{},idempotencyKey:randomUUID()}),/REVISION_CONFLICT/);
  const second=controller.operation('loomex_run_start_handoff_approve','second',{handoffRef:randomUUID()});
  await assert.rejects(()=>controller.journal(second),/OPERATION_PENDING/);assert.equal(second.stage,'not_journaled');
  await assert.rejects(()=>rpc('presentation.sessions.get',{viewSessionId:session.viewSessionId},'other-owner'),/VIEW_SESSION_NOT_FOUND/);
  await controller.settle(first,'completed',{structuredContent:{ok:true,data:{}}});
  await controller.recoverOperationConflicts(second);
  await controller.journal(second);assert.ok(second.operationId);
  const saved=await rpc('presentation.operations.get',{viewSessionId:session.viewSessionId,operationId:second.operationId!});
  assert.equal(saved.idempotencyKey,second.arguments.idempotencyKey);
 } finally {child.stdin.end();await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}
});
