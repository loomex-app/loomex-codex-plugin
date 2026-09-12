import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRunPresentation } from '../src/ui-app/run-presentation.js';

const id = 'cecfb615-af58-48c3-8294-1e6ef4f03256';
const id2 = 'cecfb615-af58-48c3-8294-1e6ef4f03257';
function controller() {
  return createRunPresentation({ context: {} as HTMLElement, questionCopyValues: () => [], workflowIdValid: (value): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value) });
}
function prepared() {
  return { preparationId: id, bindingDigest: 'digest', binding: {workflowId:id, versionId:id, organizationId:id, installationId:id, workspacePath:'/workspace', executionPolicy:'host_user/v1', inputs:{}, providerConfiguration:{} } };
}
function review() {
  return {schemaVersion:'loomex/preparation-review/v1',preparationId:id,bindingDigest:'digest',workflowId:id,versionId:id,organizationId:id,workflowName:'Workflow',organizationName:'Organization',workflowVersion:1,providers:[]};
}

test('restored review metadata cannot authorize a changed preparation binding', () => {
  const view=controller();
  view.restorePreparationPresentation(review());
  assert.equal(view.preparationReviewable(prepared()),true);
  assert.equal(view.preparationReviewable({...prepared(), preparationId:id2}),false);
  assert.equal(view.preparationReviewable({...prepared(), bindingDigest:'different'}),false);
  assert.equal(view.preparationReviewable({...prepared(), binding:{...prepared().binding,organizationId:id2}}),false);
  assert.equal(view.preparationReviewable({...prepared(), binding:{...prepared().binding,executionPolicy:'unknown/v1'}}),false);
});

test('authoritative observation invalidates stale or malformed preparation review metadata', () => {
  const view=controller();
  view.restorePreparationPresentation(review());
  view.observePreparationReview({}, {...prepared(),preparationId:id2});
  assert.equal(view.preparationPresentation,null);
  view.observePreparationReview({_meta:{'loomex/preparationReview':review()}},prepared());
  assert.equal(view.preparationReviewable(prepared()),true);
  view.observePreparationReview({_meta:{'loomex/preparationReview':{...review(),providers:[{name:'',model:null}]}}},prepared());
  assert.equal(view.preparationPresentation,null);
});

test('presentation helpers reject incomplete pages, malformed result metadata and invalid times', () => {
  const view=controller();
  assert.equal(view.workflowPageData({workflows:[],nextCursor:null})?.workflows?.length,0);
  assert.equal(view.workflowPageData({workflows:[{name:'Missing identity'}],nextCursor:null}),undefined);
  assert.equal(view.pagedResponse({responseRef:id,encoding:'json'}),undefined);
  assert.equal(view.pagedResponse({responseRef:id,encoding:'json',sizeBytes:0})?.sizeBytes,0);
  assert.equal(view.humanPresentation({presentation:{version:1,kind:'review',summary:'Readable'}})?.kind,'review');
  assert.equal(view.humanPresentation({presentation:{version:1,kind:'review',summary:'  '}}),undefined);
  assert.equal(view.formatDateTime('not a date'),undefined);
  assert.equal(view.formatDuration('2026-01-01T00:00:10Z','2026-01-01T00:00:00Z'),undefined);
  assert.equal(view.formatDuration('2026-01-01T00:00:00Z','2026-01-01T00:01:05Z'),'1m 5s');
});
