import type {DeliveryJournal,DeliveryProjection} from '../src/ui-app/continuation-delivery.js';
/** In-memory owner journal for controller tests. Browser and Rust suites test cross-card CAS. */
export function deliveryJournalFixture():DeliveryJournal {
 const records=new Map<string,DeliveryProjection>();
 return {
  get:async identity=>{
   let value=records.get(identity);
   if(!value){const parts=identity.split(':');value={schemaVersion:2,identity,continuation:identity.startsWith('start:')?{handoffRef:parts[1]!}:identity.startsWith('question:')?{requestId:parts[1]!}:{runId:parts[1]!,requestId:parts[2]!,receipt:'fixture-continuation-receipt'},revision:0,status:'ready',attemptId:null};records.set(identity,value);}
   return structuredClone(value);
  },
  begin:async p=>{const v=records.get(p.identity)!;if(v.revision!==p.expectedRevision||!['ready','not_sent','rejected'].includes(v.status))throw new Error('CONFLICT');const next={...v,status:'sending' as const,revision:v.revision+1,attemptId:p.attemptId};records.set(p.identity,next);return structuredClone(next);},
  settle:async p=>{const v=records.get(p.identity)!;if(v.revision!==p.expectedRevision||v.attemptId!==p.attemptId)throw new Error('CONFLICT');const next={...v,status:p.status,revision:v.revision+1};records.set(p.identity,next);return structuredClone(next);},
 };
}
