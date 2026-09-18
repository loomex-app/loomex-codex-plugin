import type {JsonObject} from './contracts.js';
/** Coalesces concurrent equivalent reads only; it never caches completed authority. */
export class ConcurrentReads {
  #generation = 0;
  #pending = new Map<string, Promise<unknown>>();
  invalidate():void {this.#generation++;this.#pending.clear();}
  read<T>(scope:string,method:string,args:JsonObject,load:()=>Promise<T>):Promise<T> {
    const key=JSON.stringify([this.#generation,scope,method,canonical(args)]);
    const current=this.#pending.get(key);
    if(current)return current as Promise<T>;
    const pending=load().finally(()=>{if(this.#pending.get(key)===pending)this.#pending.delete(key);});
    this.#pending.set(key,pending);return pending;
  }
}
function canonical(value:unknown):unknown {
 if(Array.isArray(value))return value.map(canonical);
 if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
 return value;
}
