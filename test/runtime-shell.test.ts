import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { restorationSurface, setupOwnsActivity, pageActionEnabled } from '../src/ui-app/runtime-shell.js';
import { ViewRestorationCoordinator, PresentationConflictError } from '../src/ui-app/persistence.js';
test('automatic setup suppresses only its own operations',()=>{
 assert.equal(setupOwnsActivity('loomex_workspace_grant',true),true);
 assert.equal(setupOwnsActivity('loomex_run_prepare',true),true);
 assert.equal(setupOwnsActivity('ui/initialize',true),false);
 assert.equal(setupOwnsActivity('loomex_interaction_respond',true),false);
 assert.equal(setupOwnsActivity('loomex_run_prepare',false),false);
});

test('restoration surface keeps unverified canonical content behind one skeleton',()=>{
 assert.equal(restorationSurface('loading_snapshot',false),'skeleton');
 assert.equal(restorationSurface('verifying',false),'skeleton');
 assert.equal(restorationSurface('verifying',true),'snapshot');
 assert.equal(restorationSurface('ready',false),'content');
 assert.equal(restorationSurface('read_only',true),'content');
 assert.equal(restorationSurface('verification_failed',false),'content');
});

test('legacy restoration remains skeletal when no lifecycle phase is supplied',()=>{
 assert.equal(restorationSurface(undefined,false,true),'skeleton');
 assert.equal(restorationSurface(undefined,false,false),'content');
});

test('contextual navigation survives storage loss while reviewed actions require current authority', () => {
 const execute = () => {};
 const pending = { authorityStale: true, reentry: false, mutationReady: false };
 assert.equal(pageActionEnabled({ id: 'back', label: 'Back', intent: 'navigate', execute }, pending, false), true);
 assert.equal(pageActionEnabled({ id: 'start', label: 'Run', intent: 'review', execute }, pending, false), false);
 assert.equal(pageActionEnabled({ id: 'publish', label: 'Publish', intent: 'mutation', execute }, { authorityStale: false, reentry: false, mutationReady: true }, false), true);
 assert.equal(pageActionEnabled({ id: 'publish', label: 'Publish', intent: 'mutation', execute }, { authorityStale: false, reentry: false, mutationReady: true }, true), false);
});

test('a presentation conflict gates a rendered Start action without hiding the ready review', async () => {
 const lifecycle = new ViewRestorationCoordinator();
 await lifecycle.begin('review-card', { snapshot: async () => ({}), display: () => {}, verify: async () => 'ready', failed: () => {} });
 await Promise.resolve();
 assert.equal(lifecycle.state.phase, 'ready');
 lifecycle.persistence('save_failed', new PresentationConflictError());
 const projection = { authorityStale: false, reentry: false, mutationReady: lifecycle.permissions().mutate };
 const execute = () => {};
 assert.equal(pageActionEnabled({ id: 'start', label: 'Start run', intent: 'mutation', execute }, projection, false), false);
 assert.equal(pageActionEnabled({ id: 'back', label: 'Back', intent: 'navigate', execute }, projection, false), true);
 assert.equal(restorationSurface(lifecycle.state.phase, false), 'content');
 lifecycle.dispose();
});
