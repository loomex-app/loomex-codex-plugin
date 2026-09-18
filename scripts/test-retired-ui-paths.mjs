import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRetiredUiPaths } from './retired-ui-paths.mjs';
test('package gate rejects retired code and retains canonical checked modules', () => {
  assert.deepEqual(checkRetiredUiPaths(['src/ui-app/runtime-shell.ts', 'src/ui-app/persistence.ts'], '', ''), []);
  assert.equal(checkRetiredUiPaths(['src/ui-app/runtime-legacy.js'], '', '').length, 1);
  assert.equal(checkRetiredUiPaths(['assets/view-persistence.js'], '', '').length, 1);
  assert.equal(checkRetiredUiPaths([], 'const tooltipCloseTimer = 1', '').length, 1);
  assert.equal(checkRetiredUiPaths([], '', '.tooltip {position:fixed}').length, 1);
});
