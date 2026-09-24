import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { normalizedConnection } from '../src/ui-app/connection-controller.js';
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

test('connection presentation restores only bridge-elided nullable fields',()=>{
 const data=projection();
 const bridgeShape={...data,organization:{status:'organization_required'},};
 delete (bridgeShape as {login?: unknown}).login;
 assert.ok(normalizedConnection(bridgeShape), 'absent null fields are restored for MCP Apps presentation');
 assert.equal(normalizedConnection({...data,login:'not-null'}),undefined, 'present malformed values remain invalid');
 assert.equal(normalizedConnection({...data,organization:{status:'organization_required',selected:'not-null'}}),undefined);
});
