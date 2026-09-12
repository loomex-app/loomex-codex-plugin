import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { setupOwnsActivity } from '../src/ui-app/runtime-shell.js';
test('automatic setup suppresses only its own operations',()=>{
 assert.equal(setupOwnsActivity('loomex_workspace_grant',true),true);
 assert.equal(setupOwnsActivity('loomex_run_prepare',true),true);
 assert.equal(setupOwnsActivity('ui/initialize',true),false);
 assert.equal(setupOwnsActivity('loomex_interaction_respond',true),false);
 assert.equal(setupOwnsActivity('loomex_run_prepare',false),false);
});
