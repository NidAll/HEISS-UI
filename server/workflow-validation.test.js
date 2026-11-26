import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.HEISS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-wf-offline-"));
const { workflowSummaries } = await import("./workflow-catalog.js");

test("with ComfyUI offline, a sound workflow is unchecked, not broken", () => {
  const offline = workflowSummaries({ info: {}, profiles: [] });
  assert.ok(offline.length > 0);
  for (const workflow of offline) {
    assert.equal(workflow.validation.unverified, true);
    assert.equal(workflow.validation.ok, workflow.validation.issues.length === 0, workflow.id);
  }
});
