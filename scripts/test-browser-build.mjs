import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { browserCoverage } from './browser-coverage.mjs';
import { compileBrowserApplication } from './browser-build.mjs';

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

test('packaged browser graph minifies deterministically without changing resources or generating assets', async () => {
 const root = resolve(import.meta.dirname, '..');
 const names = ['browser-application.js', 'ui-artifacts.json', 'loomex-app.html', 'frontend-design-system.css'];
 const before = await Promise.all(names.map(name => readFile(join(root, 'assets', name))));
 const first = await compileBrowserApplication(root);
 const second = await compileBrowserApplication(root);
 assert.equal(first.code, second.code, 'identical source must produce identical browser bytes');
 assert.deepEqual(first.inputs, second.inputs);
 assert.ok(first.inputs.includes('src/ui-app/app.ts'));
 assert.ok(first.inputs.includes('src/ui-app/runtime-transport.ts'), 'transport remains in the checked graph');
 assert.ok(first.code.endsWith('\n'));
 assert.doesNotMatch(first.code, /sourceMappingURL|node_modules\/\.pnpm/);
 const whitespaceOnly = await build({absWorkingDir:root, entryPoints:['src/ui-app/app.ts'], bundle:true,
   platform:'browser', format:'iife', target:'es2022', charset:'utf8', legalComments:'none',
   minifyWhitespace:true, write:false, metafile:true, logLevel:'silent'});
 assert.deepEqual(first.inputs, Object.keys(whitespaceOnly.metafile.inputs), 'minification must retain complete source coverage');
 assert.ok(Buffer.byteLength(first.code) < whitespaceOnly.outputFiles[0].contents.length,
   'full minification must reduce the previous whitespace-only build');
 const after = await Promise.all(names.map(name => readFile(join(root, 'assets', name))));
 for (let index=0; index<names.length; index++) assert.deepEqual(after[index],before[index], `${names[index]} changed during a read-only build`);
});
