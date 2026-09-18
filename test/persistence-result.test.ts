import { test } from "node:test";
import * as assert from "node:assert/strict";
import { decodePersistenceResult } from "../src/ui-app/result-decoder.js";

test("persistence accepts canonical root, structured and metadata receipts without projection loss", () => {
  const envelope = { ok: true, data: { draft: { revision: 9 } } };
  for (const result of [envelope, { structuredContent: envelope }, { _meta: { "loomex/uiData": envelope } }]) {
    assert.deepEqual(decodePersistenceResult(result), envelope.data);
  }
});

test("persistence rejects canonical failures and retains their actionable cause", () => {
  const envelope = { ok: false, error: { code: "DRAFT_CONFLICT", message: "A newer draft exists.", retryable: false } };
  for (const result of [envelope, { structuredContent: envelope }, { _meta: { "loomex/uiData": envelope } }]) {
    assert.throws(() => decodePersistenceResult(result), { code: "DRAFT_CONFLICT", message: "A newer draft exists." });
  }
});
