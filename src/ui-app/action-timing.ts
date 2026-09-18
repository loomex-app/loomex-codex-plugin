/** Bounded, opt-in-readable browser timings; never captures arguments or results. */
export function beginActionTiming(method:string, tool?:unknown): (outcome:"completed"|"failed")=>void {
 const operation = method === 'tools/call' && typeof tool === 'string' && /^loomex_[a-z_]+$/.test(tool) ? tool :
   ['ui/message','ui/initialize'].includes(method) ? method.replace('/','.') : 'host.request';
 const started=performance.now();let finished=false;
 return outcome=>{
  if(finished)return;finished=true;
  const name=`loomex.action.${operation}.${outcome}`;
  try {
   // Keep one recent sample per stage in the host performance buffer. Observers
   // can collect a qualification run without retaining prompts or identities.
   performance.clearMeasures(name);
   performance.measure(name,{start:started,end:performance.now()});
  }catch{/* Instrumentation cannot fail the operation. */}
 };
}
