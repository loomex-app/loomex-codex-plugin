import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {pageDefinitionFor} from '../src/ui-app/page-definitions.js';
test('canonical resources select stable metadata without callbacks into a general runtime',()=>{
 for(const mode of ['browser','authoring','prepare','monitor','interaction','connection','organizations']){
  const page=pageDefinitionFor(mode);assert.equal(page.mode,mode);assert.equal(Object.hasOwn(page,'render'),false);
 }
 assert.equal(pageDefinitionFor(undefined).mode,'browser');assert.equal(pageDefinitionFor('__proto__').mode,'browser');
 assert.notEqual(pageDefinitionFor('connection').title,pageDefinitionFor('organizations').title);
});
