import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {createMutationController, type MutationControllerServices, type MutationSessionProjection} from '../src/ui-app/mutation-controller.js';
import {createViewPersistence} from '../src/ui-app/persistence.js';
import type {ViewSessionProjection} from '../src/ui-app/contracts.js';
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

test('real runner retirement advances an accepted request view while settlement and chat delivery remain independent',async(t)=>{
 const executable=process.env.LOOMEX_PRESENTATION_FIXTURE;
 if(!executable){t.skip('Run test:cross-boundary to build the isolated Rust presentation fixture');return;}
 const child=spawn(executable,[],{stdio:['pipe','pipe','inherit']});
 const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
 const rpc=async(method:string,params:Readonly<JsonObject>):Promise<JsonObject>=>{
  child.stdin.write(JSON.stringify({method,params})+'\n');
  const line=await lines.next();assert.equal(line.done,false);
  const response=JSON.parse(line.value!) as {result?:JsonObject;error?:{code:string}};
  if(response.error)throw Object.assign(new Error(response.error.code),{code:response.error.code});
  return response.result!;
 };
 try{
  const requestId=randomUUID(),runId=randomUUID(),state:JsonObject={screen:'interaction',phase:'review'};
  const created=await rpc('presentation.sessions.create',{kind:'interaction',entityType:'request',entityId:requestId,state,idempotencyKey:randomUUID()});
  const viewSessionId=String(created.viewSessionId);
  let writes=0,acceptedEpoch:number|null=null,responses=0,latestRevision=Number(created.revision);
  const view=createViewPersistence<JsonObject>({
   read:async id=>await rpc('presentation.sessions.get',{viewSessionId:id}) as unknown as ViewSessionProjection<JsonObject>,
   write:async(id,expectedRevision,content,idempotencyKey,options)=>{
    writes++;
    return await rpc('presentation.sessions.update',{viewSessionId:id,expectedRevision,state:content,...(options?.status?{status:options.status}:{}),idempotencyKey}) as unknown as ViewSessionProjection<JsonObject>;
   },
  });
  view.configure(created as unknown as ViewSessionProjection<JsonObject>);
  const mapping:Record<string,string>={loomex_view_session_update:'presentation.sessions.update',loomex_view_session_get:'presentation.sessions.get',loomex_view_operation_get:'presentation.operations.get',loomex_view_operation_settle:'presentation.operations.settle'};
  const services:MutationControllerServices={
   createIdempotencyKey:randomUUID,dataOf:result=>result.structuredContent?.data??{},
   transport:{beginAuthoritativeRequest:()=>1,isAuthoritativeRequestCurrent:()=>true,callTool:async(name)=>{
    assert.equal(name,'loomex_interaction_respond');responses++;
    await rpc('fixture.entities.retire',{entityType:'request',ids:[requestId]});
    return {structuredContent:{ok:true,data:{requestId,requestStatus:'answered',executionId:runId}}};
   }},
   persistence:{ready:()=>true,currentSession:()=>({viewSessionId,revision:view.session!.revision,state}),
    flushCurrent:()=>view.flush(state),captureState:()=>state,
    acceptRevision:(id,revision)=>{if(id===viewSessionId){view.configure({viewSessionId:id,revision});latestRevision=revision;}},
    call:(name,args)=>rpc(mapping[name]!,args)},
   presentation:{authoritativeFailure:()=>{},present:()=>{},observe:()=>{},persistenceFailure:()=>{},lock:()=>{},unlock:()=>{},acceptTargetSession:()=>{},
    acceptInteraction:(id,sessionId)=>{assert.equal(id,requestId);acceptedEpoch=view.quiesceAcceptedSession(sessionId);}},
  };
  const controller=createMutationController(services);
  const outcome=await controller.callVerifiedInteractionMutation('loomex_interaction_respond',`interaction:respond:${requestId}`,
   {requestId,answer:{value:'fixture'}},{humanRequest:{id:requestId,status:'pending',execution:{id:runId}}});
  assert.equal(outcome.accepted,true);assert.equal(responses,1);assert.ok(acceptedEpoch!==null);
  const retired=await rpc('presentation.sessions.get',{viewSessionId});
  assert.equal(retired.status,'resolved');assert.equal(Number(retired.revision),latestRevision+1);
  assert.equal(view.adoptResolvedSession(retired as unknown as ViewSessionProjection<JsonObject>,acceptedEpoch),true);
  assert.equal(view.session?.revision,Number(retired.revision));
  assert.equal(await view.flush({screen:'interaction',phase:'review',readingPosition:{top:5,left:0}}),false);
  assert.equal(writes,0,'the accepted UI never sends a stale presentation update');
  await assert.rejects(()=>rpc('presentation.sessions.update',{viewSessionId,expectedRevision:latestRevision,state,idempotencyKey:randomUUID()}),/REVISION_CONFLICT/);
  const operation=outcome.operation;
  const settled=await rpc('presentation.operations.get',{viewSessionId,operationId:operation.operationId!});
  assert.equal(settled.status,'completed','the response operation settles after request-view retirement');
  const identity=`follow:${runId}:${requestId}`;
  const registered=await rpc('fixture.delivery.register',{identity,continuation:{kind:'follow',schemaVersion:'loomex.follow-session.continuation/v1',runId,receipt:'A'.repeat(16),trigger:'interaction_accepted',requestId,requestStatus:'answered'}});
  assert.equal(registered.status,'ready');
  const attemptId=randomUUID();
  const sending=await rpc('presentation.delivery.begin',{identity,expectedRevision:registered.revision,attemptId,idempotencyKey:randomUUID()});
  assert.equal(sending.status,'sending');
  const delivered=await rpc('presentation.delivery.settle',{identity,expectedRevision:sending.revision,attemptId,status:'acknowledged',idempotencyKey:randomUUID()});
  assert.equal(delivered.status,'acknowledged');
  assert.equal(view.session?.viewSessionId,viewSessionId,'delivery and journal recovery retain the exact view identity');
  assert.equal(responses,1,'delivery cannot replay the accepted response');
 }finally{child.stdin.end();await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}
});
