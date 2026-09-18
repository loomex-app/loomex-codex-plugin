import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {ConcurrentReads} from '../src/ui-app/read-coordinator.js';
test('equivalent concurrent reads share work without caching completed authority',async()=>{
 const c=new ConcurrentReads();let calls=0,resolve!:(v:number)=>void;const load=()=>{calls++;return new Promise<number>(r=>{resolve=r;});};
 const a=c.read('org:request','draft',{a:1,b:2},load),b=c.read('org:request','draft',{b:2,a:1},load);assert.equal(calls,1);resolve(3);assert.deepEqual(await Promise.all([a,b]),[3,3]);
 const next=c.read('org:request','draft',{a:1,b:2},load);assert.equal(calls,2);resolve(4);assert.equal(await next,4);
});
test('identity changes and invalidation never share old pending reads',async()=>{
 const c=new ConcurrentReads();let calls=0;const load=async()=>++calls;
 const a=c.read('a','read',{},load);const b=c.read('b','read',{},load);c.invalidate();const next=c.read('a','read',{},load);
 assert.deepEqual(await Promise.all([a,b,next]),[1,2,3]);
});
