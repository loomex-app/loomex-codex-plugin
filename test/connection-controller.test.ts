import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { normalizedConnection, credentialStoreMessage } from '../src/ui-app/connection-controller.js';
import { safeErrorMessage } from '../src/protocol.js';
const id='cecfb615-af58-48c3-8294-1e6ef4f03256';
function projection() { return { schemaVersion:'loomex.runner.connection/v2',state:'authenticated',activeWork:0,actions:['organizations.list','organizations.select'],organization:{status:'connected',selected:{id,name:'Current'}},organizations:[{id,name:'Current',enrolled:false}],login:null }; }
test('unenrolled organizations remain selectable even with current scope',()=>{
 const result=normalizedConnection(projection());assert.ok(result);assert.equal(result.organizations[0]?.id,id);assert.ok(result.actions.has('organizations.select'));
});
test('duplicate organization identifiers and inconsistent connection are rejected',()=>{
 const data=projection();assert.equal(normalizedConnection({...data,organizations:[...data.organizations,...data.organizations]}),undefined);
 assert.equal(normalizedConnection({...data,organization:{status:'connected',selected:null}}),undefined);
 assert.equal(normalizedConnection({...data,actions:['organizations.list','organizations.list']}),undefined);
});
test('login projection requires a safe browser URL and complete flow identity',()=>{
 const data={...projection(),state:'browser_pending',login:{flowId:'flow',authorizationUrl:'https://example.test/authorize',expiresAt:100}};
 assert.ok(normalizedConnection(data));
 assert.equal(normalizedConnection({...data,login:{...data.login,authorizationUrl:'https://user:password@example.test/'}}),undefined);
 assert.equal(normalizedConnection({...data,login:{...data.login,flowId:''}}),undefined);
 assert.equal(normalizedConnection({...data,login:null}),undefined);
});

test('expired sign-in recovery retains its exact cancel capability and actionable errors',()=>{
 const data={...projection(),state:'recovery_pending',actions:['auth.recover','auth.cancel'],
  login:{flowId:'expired-flow',authorizationUrl:null,expiresAt:0}};
 const result=normalizedConnection(data);assert.ok(result);
 assert.equal(result.login?.flowId,'expired-flow');assert.ok(result.actions.has('auth.cancel'));
 assert.match(safeErrorMessage('RUNNER_BROWSER_AUTH_INVALID'),/Restart sign-in/);
 assert.match(safeErrorMessage('RUNNER_BROWSER_AUTH_RETRY'),/same cancellation/);
 assert.doesNotMatch(safeErrorMessage('RUNNER_BROWSER_AUTH_INVALID'),/local Loomex runner could not complete/);
});

test('connection presentation restores only bridge-elided nullable fields',()=>{
 const data=projection();
 const bridgeShape={...data,organization:{status:'organization_required'},};
 delete (bridgeShape as {login?: unknown}).login;
 assert.ok(normalizedConnection(bridgeShape), 'absent null fields are restored for MCP Apps presentation');
 assert.equal(normalizedConnection({...data,login:'not-null'}),undefined, 'present malformed values remain invalid');
 assert.equal(normalizedConnection({...data,organization:{status:'organization_required',selected:'not-null'}}),undefined);
});

test('credential store diagnostics retain only fixed categories with a neutral legacy fallback',()=>{
 const unavailable={...projection(),state:'credential_store_unavailable',actions:[],organization:{status:'organization_required',selected:null},organizations:[]};
 for(const code of ['STORE_ACCESS_REQUIRED','STORE_ACCESS_DENIED','STORE_UNAVAILABLE','STORE_OPERATION_PENDING']) {
  const value=normalizedConnection({...unavailable,details:{credentialStoreCode:code,message:'private token /private/item ACL'}});
  assert.equal(value?.credentialStoreCode,code);
  assert.equal(credentialStoreMessage(value?.credentialStoreCode),safeErrorMessage(code));
  assert.doesNotMatch(JSON.stringify(value),/private token|private\/item|ACL/);
 }
 for(const details of [{},{credentialStoreCode:'private ACL'},{credentialStoreCode:'__proto__'},{credentialStoreCode:{token:'private'}}]) {
  const value=normalizedConnection({...unavailable,details});assert.equal(value?.credentialStoreCode,undefined);
  assert.match(credentialStoreMessage(value?.credentialStoreCode),/availability and access settings/);
  assert.doesNotMatch(credentialStoreMessage(value?.credentialStoreCode),/Unlock|private|ACL/);
 }
 assert.equal(normalizedConnection({...projection(),details:{credentialStoreCode:'STORE_ACCESS_DENIED'}})?.credentialStoreCode,undefined);
});
