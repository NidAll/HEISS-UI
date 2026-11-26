import test from "node:test";
import assert from "node:assert/strict";
import { optionsConfig, sanitizeOptions, workflowOptions, writtenText } from "./workflow-options.js";
import { extensionResults } from "./extensions.js";
import { generationSettings } from "./gallery-store.js";

const graph = {
  17: { class_type: "Architect", inputs: { detail: "detailed", include_visual_details: true, general_threshold: 0.35, exclude_tags: "", seed: 1 } },
  9: { class_type: "Save", inputs: {} }
};
const raw = {
  title: "Architect",
  node: "17",
  options: [
    { key: "detail", input: "detail", label: "Detail", kind: "choice", choices: [{ value: "concise", label: "Concise" }, { value: "detailed", label: "Detailed" }] },
    { key: "visual", input: "include_visual_details", label: "Visual description", kind: "boolean" },
    { key: "threshold", input: "general_threshold", label: "Tags", kind: "number", min: 0.15, max: 0.7, step: 0.05 },
    { key: "exclude", input: "exclude_tags", label: "Never use", kind: "text", maxLength: 20 },
    { key: "ghost", input: "not_there", label: "Ghost", kind: "boolean" },
    { key: "one", input: "detail", kind: "choice", choices: [{ value: "x" }] }
  ],
  written: { node: "17", label: "Architect prompt" }
};

test("options take their defaults from the node; inputs it lacks and one-choice menus are dropped", () => {
  const config = optionsConfig(raw, { graph });
  assert.deepEqual(config.options.map((item) => [item.key, item.default]), [["detail", "detailed"], ["visual", true], ["threshold", 0.35], ["exclude", ""]]);
  assert.deepEqual(config.written, { node: "17", label: "Architect prompt" });
  assert.equal(optionsConfig({ ...raw, node: "99" }, { graph }), null);
  const profile = {};
  workflowOptions.profile(profile, { config });
  assert.equal(profile.workflowOptions.title, "Architect");
  assert.ok(profile.workflowOptions.options.every((item) => !("input" in item)), "node inputs stay on the server");
});

test("a run's values are checked against the options; the rest stay the workflow's", () => {
  const config = optionsConfig(raw, { graph });
  assert.deepEqual(sanitizeOptions({ detail: "concise", visual: "yes", threshold: 0.93, exclude: "smile,\u0007 white dress, extra words", other: 1 }, config),
    { detail: "concise", threshold: 0.7, exclude: "smile, white dress," });
  assert.equal(sanitizeOptions({ detail: "wild" }, config), undefined);
  assert.equal(sanitizeOptions("x", config), undefined);
});

test("the graph gets the values; the written prompt is read back into the gallery settings", () => {
  const config = optionsConfig(raw, { graph });
  const workflow = { extensions: { "workflow-options": config } };
  const run = structuredClone(graph);
  workflowOptions.graph(run, { workflow, value: { detail: "concise", threshold: 0.2 } });
  assert.equal(run[17].inputs.detail, "concise");
  assert.equal(run[17].inputs.general_threshold, 0.2);
  assert.equal(run[17].inputs.seed, 1);
  const outputs = { 17: { text: ["  1girl, solo, red hair  "] }, 9: { images: [] } };
  assert.equal(writtenText(outputs, config), "1girl, solo, red hair");
  const read = extensionResults(outputs, {}, workflow, [workflowOptions]);
  assert.deepEqual(read, { "workflow-options": { written: "1girl, solo, red hair" } });
  const settings = generationSettings({ prompt: "red hair", extensions: { "workflow-options": { detail: "concise" } }, extensionResults: read });
  assert.deepEqual(settings.extensions["workflow-options"], { detail: "concise", written: "1girl, solo, red hair" });
});
