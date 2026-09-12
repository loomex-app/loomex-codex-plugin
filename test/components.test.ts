import * as assert from "node:assert/strict";
import { test } from "node:test";
import { clampPageIndex } from "../src/ui-app/components.js";

test("pagination cursors stay inside a non-empty page range", () => {
  assert.equal(clampPageIndex(-1, 3), 0);
  assert.equal(clampPageIndex(0, 3), 0);
  assert.equal(clampPageIndex(2, 3), 2);
  assert.equal(clampPageIndex(9, 3), 2);
});

test("invalid page counts retain a stable first page", () => {
  assert.equal(clampPageIndex(4, 0), 0);
  assert.equal(clampPageIndex(4, Number.NaN), 0);
  assert.equal(clampPageIndex(Number.NaN, 3), 0);
});
