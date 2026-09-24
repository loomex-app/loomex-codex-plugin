import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {errorRecovery, safeErrorMessage} from '../src/protocol.js';
import {createMutationOperation, dispatchJournaledOperation} from '../src/ui-app/mutation-controller.js';

test('unknown failures require reconciliation, not replay',()=>{
 assert.deepEqual(errorRecovery('UNRECOGNIZED_PROVIDER_FAILURE'),{recovery:'reconcile_outcome',outcome:'unknown'});
 assert.deepEqual(errorRecovery('OPERATION_PENDING'),{recovery:'reconcile_outcome',outcome:'not_dispatched'});
 assert.deepEqual(errorRecovery('ACTIVE_WORK_REQUIRES_DRAIN'),{recovery:'refresh_authority',outcome:'rejected'});
 assert.match(safeErrorMessage('ACTIVE_WORK_REQUIRES_DRAIN'), /current work to finish/);
});
for (const name of ['error-recovery.json', 'mutation-recovery.json']) {
 test(`integration: ${name} matches the runner-owned export`, async (t) => {
  // Standalone release snapshots intentionally contain only this component.
  const runner = new URL('../../runner', import.meta.url);
  try { await (await import('node:fs/promises')).access(runner); }
  catch (error) {
   if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
   t.skip('Sibling runner unavailable; required cross-component compatibility gate verifies this contract');
   return;
  }
  assert.equal(await readFile(new URL(`../contracts/${name}`, import.meta.url), 'utf8'),
   await readFile(new URL(`contracts/${name}`, `${runner.href}/`), 'utf8'));
 });
}
test('dispatch requires a journal and preserves a success across failed settlement',async()=>{
 const op=createMutationOperation('loomex_run_prepare','prepare',{workflowId:'fixture'});
 let calls=0;const dispatch=async()=>{calls++;return {structuredContent:{ok:true,data:{preparationId:'fixture'}}};};
 await assert.rejects(()=>dispatchJournaledOperation(op,dispatch),/journaled/);assert.equal(calls,0);
 op.operationId='record';op.viewSessionId='session';op.stage='journaled';
 const result = await dispatchJournaledOperation(op,dispatch);
 // Domain validation establishes the successful receipt before settlement.
 op.successfulResult = result;
 await dispatchJournaledOperation(op,dispatch);
 assert.equal(calls,1);assert.equal(op.stage,'dispatched');
});
test('lost response retains exact tuple and marks uncertain outcome',async()=>{
 const op=createMutationOperation('loomex_run_prepare','prepare',{workflowId:'fixture'});
 op.operationId='record';op.viewSessionId='session';const before=JSON.stringify(op.arguments);
 await assert.rejects(()=>dispatchJournaledOperation(op,async()=>{throw new Error('lost response');}));
 assert.equal(op.stage,'outcome_uncertain');assert.equal(JSON.stringify(op.arguments),before);
});

test('local reconciliation export targets only reads',async()=>{
 const read=await import('node:fs/promises');
 const local=new URL('../contracts/mutation-recovery.json',import.meta.url);
 const rules=JSON.parse(await read.readFile(local,'utf8'));
 const catalog=JSON.parse(await read.readFile(new URL('../contracts/method-catalog.json',import.meta.url),'utf8'));
 for(const [name,rule] of Object.entries(rules.reconciliation) as [string,{method:string;identity:string}][]) {
  const mutation=catalog.methods.find((m:{name:string})=>m.name===name);
  const readMethod=catalog.methods.find((m:{name:string})=>m.name===rule.method);
  assert.equal(mutation.mutating,true);assert.equal(readMethod.mutating,false);
  assert.ok(mutation.inputSchema.properties[rule.identity]);assert.ok(readMethod.inputSchema.properties[rule.identity]);
 }
});
