import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserCoverage } from './browser-coverage.mjs';
function fixture(files, run) {
 const root=mkdtempSync(join(tmpdir(),'loomex-coverage-'));
 try { for (const [name,text] of Object.entries(files)) writeFileSync(join(root,name),text); run(root); }
 finally {rmSync(root,{recursive:true,force:true});}
}
const config=JSON.stringify({compilerOptions:{strict:true,noEmit:true},files:['entry.ts']});
test('rejects JavaScript hidden by declaration wrapper',()=>fixture({'tsconfig.json':config,'entry.ts':"import {start} from './runtime.js'; start();",'runtime.js':'export function start() {}','runtime.d.ts':'export declare function start(): void;'}, root=>assert.match(browserCoverage(root,['entry.ts','runtime.js']).join(),/runtime.js: implementation/)));
test('rejects excluded TypeScript bundled through separate entry',()=>fixture({'tsconfig.json':config,'entry.ts':'export const a=1;','excluded.ts':'export const b=2;'},root=>assert.match(browserCoverage(root,['entry.ts','excluded.ts']).join(),/excluded.ts: implementation/)));
test('accepts checked source and rejects explicit type escapes',()=>fixture({'tsconfig.json':config,'entry.ts':'export const a: number=1;'},root=>{assert.deepEqual(browserCoverage(root,['entry.ts']),[]);writeFileSync(join(root,'entry.ts'),'export const a: any=1;');assert.match(browserCoverage(root,['entry.ts']).join(),/explicit any/);}));

test('rejects suppressions and reports real semantic errors',()=>fixture({'tsconfig.json':config,'entry.ts':'export const a: number="bad";'},root=>{assert.match(browserCoverage(root,['entry.ts']).join(),/not assignable/);writeFileSync(join(root,'entry.ts'),'// @ts-nocheck\nexport const a=1;');assert.match(browserCoverage(root,['entry.ts']).join(),/type-check suppression/);}));


test('rejects compiler options that silently disable implementation checking',()=>fixture({'tsconfig.json':config,'entry.ts':'export function identity(value) { return value; }'},root=>{
 for(const compilerOptions of [{strict:false},{strict:true,noImplicitAny:false},{strict:true,noCheck:true}]) {
  writeFileSync(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{...compilerOptions,noEmit:true},files:['entry.ts']}));
  assert.match(browserCoverage(root,['entry.ts']).join(),/must use strict checking/);
 }
}));
