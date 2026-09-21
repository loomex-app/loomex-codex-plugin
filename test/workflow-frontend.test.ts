import { test } from "node:test";
import * as assert from "node:assert/strict";
import { workflowFrontendUrl } from "../src/ui-app/workflow-frontend.js";
const id = "39f69fd1-e9ca-4700-8c31-0fa7fc009517";
test("workflow navigation uses the configured frontend and drops query credentials", () => {
  assert.equal(workflowFrontendUrl("https://app.example.com/?token=private#old", id), `https://app.example.com/workspace/workflows/${id}/builder`);
  assert.equal(workflowFrontendUrl("http://localhost:5173", id), `http://localhost:5173/workspace/workflows/${id}/builder`);
  for (const base of [undefined, "javascript:alert(1)", "https://user:password@example.com", "file:///tmp"]) assert.throws(() => workflowFrontendUrl(base, id));
});
