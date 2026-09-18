import { test } from "node:test";
import * as assert from "node:assert/strict";
import { decodePersistedHandoff } from "../src/ui-app/persisted-presentation.js";

test("presentation decoding retains only a safe reference, never historical authority", () => {
  const ref = "cecfb615-af58-48c3-8294-1e6ef4f03256";
  for (const schemaVersion of [2, 3]) {
    assert.deepEqual(decodePersistedHandoff({ startHandoff: { schemaVersion, handoffRef: ref, lifecycle: "approved", operation: { idempotencyKey: "do-not-restore-from-display" } } }), { ref, lifecycle: "approved" });
  }
  assert.deepEqual(decodePersistedHandoff({}), { lifecycle: "unknown" });
  assert.deepEqual(decodePersistedHandoff({ startHandoffTicket: "old-approval" }), { lifecycle: "legacy" });
  assert.deepEqual(decodePersistedHandoff({ startHandoff: { schemaVersion: 99, handoffRef: ref } }), { lifecycle: "legacy" });
  assert.deepEqual(decodePersistedHandoff({ startHandoff: { schemaVersion: 3, handoffRef: "invalid", lifecycle: "unexpected" } }), { lifecycle: "unknown" });
});
