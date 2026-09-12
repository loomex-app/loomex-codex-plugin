import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserCoverage } from './browser-coverage.mjs';

test('real bundle graph exposes declaration-hidden executable JavaScript', async () => {
 const root = await mkdtemp(join(tmpdir(),'loomex-bundle-'));
 try {
  await Promise.all(Object.entries({
   'tsconfig.json': JSON.stringify({compilerOptions:{strict:true,noEmit:true},files:['entry.ts']}),
   'entry.ts': "import {run} from './hidden.js'; run();",
   'hidden.js': 'export function run() { return 1; }',
   'hidden.d.ts': 'export declare function run(): number;'
  }).map(([name,text])=>writeFile(join(root,name),text)));
  const result=await build({absWorkingDir:root,entryPoints:['entry.ts'],bundle:true,write:false,metafile:true,platform:'browser'});
  assert.match(browserCoverage(root,Object.keys(result.metafile.inputs)).join('\n'),/hidden.js: implementation/);
 } finally { await rm(root,{recursive:true,force:true}); }
});
