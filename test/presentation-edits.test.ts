import {test} from "node:test";
import * as assert from "node:assert/strict";
import {reapplyPresentationEdits} from "../src/ui-app/presentation-edits.js";
test("explicit edits cannot erase newer recovery or completion references",()=>{
 const saved={schemaVersion:1,screen:"setup",workflowId:"same",controls:{idea:"saved"},operation:{operationId:"new"}};
 assert.deepEqual(reapplyPresentationEdits(saved,{...saved,controls:{idea:"local"},operation:{operationId:"old"}}),{...saved,controls:{idea:"local"}});
 assert.throws(()=>reapplyPresentationEdits({...saved,forwardSession:{viewSessionId:"next"}},saved));
 assert.throws(()=>reapplyPresentationEdits(saved,{...saved,workflowId:"another"}));
});
