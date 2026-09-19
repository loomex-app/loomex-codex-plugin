import { test } from "node:test";
import * as assert from "node:assert/strict";
import { decodePersistenceReceipt, decodePersistenceResult } from "../src/ui-app/result-decoder.js";
import { decodeDeliveryProjection } from "../src/ui-app/continuation-delivery.js";

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

test("persistence reports the selected canonical channel and method without changing data choice", () => {
  const structured = { ok: true, method: "presentation.delivery.get", data: { schemaVersion: 2, identity: "start:one" } };
  const metadata = { ok: true, method: "another.method", data: { schemaVersion: 2, identity: "start:two" } };
  assert.deepEqual(decodePersistenceReceipt({ structuredContent: structured }), {
    data: structured.data, channel: "structuredContent", method: "presentation.delivery.get",
  });
  assert.deepEqual(decodePersistenceReceipt({ structuredContent: structured, _meta: { "loomex/uiData": metadata } }), {
    data: metadata.data, channel: "meta", method: "another.method",
  });
});

test("valid delivery projections decode from both host result channels", () => {
  const ref = "11111111-1111-4111-8111-111111111111";
  const projection = {
    schemaVersion: 2, identity: `start:${ref}`,
    continuation: { kind: "start", schemaVersion: "loomex.start-continuation/v1", handoffRef: ref },
    revision: 0, status: "ready", attemptId: null,
  };
  const envelope = { ok: true, method: "presentation.delivery.get", data: projection };
  for (const result of [{ structuredContent: envelope }, { _meta: { "loomex/uiData": envelope } }]) {
    const receipt = decodePersistenceReceipt(result);
    assert.deepEqual(decodeDeliveryProjection(receipt.data, {
      channel: receipt.channel,
      method: receipt.method === "presentation.delivery.get" ? "expected" : "unexpected",
    }), projection);
  }
});
