import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { designConsumers,verifyDesignConsumers } from './design-consumers.mjs';
test('changing a consumer class invalidates styles without a frontend checkout',async()=>{
 const root=await mkdtemp(join(tmpdir(),'loomex-consumer-'));
 try{
  await mkdir(join(root,'assets'));await mkdir(join(root,'src/ui-app'),{recursive:true});
  await writeFile(join(root,'assets/loomex-app.html'),'<main></main>');
  const path=join(root,'src/ui-app/app.ts');await writeFile(path,'export const classes="p-2";');
  const snapshot={schema:'loomex/frontend-design-system/v3',consumerSourcesSha256:(await designConsumers(root)).sha256};
  await verifyDesignConsumers(root,snapshot);
  await writeFile(path,'export const classes="p-4";');
  await assert.rejects(verifyDesignConsumers(root,snapshot),/Stale consumer styles/);
 }finally{await rm(root,{recursive:true,force:true});}
});
