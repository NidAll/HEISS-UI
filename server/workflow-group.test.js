import test from "node:test";
import assert from "node:assert/strict";
import { workflowGroup } from "./workflow-group.js";
import { extensionWorkflowConfig } from "./extensions.js";

test("a workflow group is a short name, trimmed; anything else is ignored", () => {
  assert.deepEqual(workflowGroup.workflow({ name: "  Anime   quick " }), { name: "Anime quick" });
  assert.equal(workflowGroup.workflow({ name: "" }), null);
  assert.equal(workflowGroup.workflow({ name: "x".repeat(41) }), null);
  assert.equal(workflowGroup.workflow("Anime"), null);
});

test("the group reaches the profile the picker shows", () => {
  const config = extensionWorkflowConfig({ "workflow-group": { name: "Photoreal" } }, {}, [workflowGroup]);
  const profile = { id: "custom:a" };
  workflowGroup.profile(profile, { config: config["workflow-group"], workflow: {} });
  assert.equal(profile.group, "Photoreal");
});
