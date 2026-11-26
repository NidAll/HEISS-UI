import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRecipe, injectStyles, promptStyler, stylerConfig, stylerDir } from "./prompt-styler.js";

const graph = () => ({
  "4": { class_type: "CLIPTextEncode", inputs: { text: "a fox", clip: ["1", 0] } },
  "5": { class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["1", 0] } },
  "9": { class_type: "Writer", inputs: { image: ["2", 0] } }
});
const controls = { prompt: { node: "4", input: "text" }, negative: { node: "5", input: "text" } };

test("the config names a text input the graph has, or the prompt control", () => {
  assert.deepEqual(stylerConfig({ node: "4", input: "text", model: "anima-turbo" }, { graph: graph() }), { node: "4", input: "text", model: "anima-turbo" });
  assert.deepEqual(stylerConfig({}, { graph: graph(), controls }), { node: "4", input: "text", model: "" });
  assert.equal(stylerConfig({ node: "4", input: "clip_skip" }, { graph: graph() }), null, "an input the node lacks");
  assert.equal(stylerConfig({ node: "9", input: "image", model: "Bad Model" }, { graph: { 9: { inputs: { image: 3 } } } }), null, "not text or a link");
  assert.equal(stylerConfig({ node: "4", input: "text", model: "../x" }, { graph: graph() }).model, "", "a model id that isn't one is dropped");
  assert.equal(stylerConfig(true, { graph: graph() }), null);
});

test("a run's styles are checked for shape; none chosen sends nothing", () => {
  const recipe = checkRecipe({ schema_version: 1, styles: [{ id: "anime.cel", intensity: 0.5, name: "Cel" }, { id: "grade.teal" }], locked_axes: ["palette"] }, "anima-turbo");
  assert.deepEqual(recipe, { schema_version: 1, model: "anima-turbo", styles: [{ id: "anime.cel", intensity: 0.5 }, { id: "grade.teal", intensity: 1 }], conflict_policy: "last_wins", locked_axes: ["palette"], prompt_conflicts: "replace" });
  assert.equal(checkRecipe({ styles: [] }), undefined);
  assert.equal(checkRecipe("cel"), undefined);
  assert.throws(() => checkRecipe({ styles: [{ id: "Bad Id" }] }), /choose them again/);
  assert.throws(() => checkRecipe({ styles: [{ id: "a.b", intensity: 2 }] }), /choose them again/);
  assert.throws(() => checkRecipe({ styles: [{ id: "a.b" }, { id: "a.b" }] }), /choose them again/);
  assert.throws(() => checkRecipe({ styles: [{ id: "a.b" }], locked_axes: ["everything"] }), /choose them again/);
  assert.throws(() => checkRecipe({ styles: Array.from({ length: 17 }, (_, i) => ({ id: `s.${i}` })) }), /choose them again/);
});

test("the styles node sits between the prompt and its encoders", () => {
  const recipe = checkRecipe({ styles: [{ id: "anime.cel" }] });
  const result = injectStyles(graph(), { config: { node: "4", input: "text" }, controls, recipe, negative: "blurry" });
  assert.equal(result.promptstyler_next.class_type, "PSNextCompose");
  assert.equal(result.promptstyler_next.inputs.prompt, "a fox");
  assert.deepEqual(JSON.parse(result.promptstyler_next.inputs.recipe), { ...recipe, prompt: "", negative: "blurry" });
  assert.deepEqual(result["4"].inputs.text, ["promptstyler_next", 0]);
  assert.deepEqual(result["5"].inputs.text, ["promptstyler_next", 1]);
  const linked = { ...graph(), "4": { class_type: "CLIPTextEncode", inputs: { text: ["9", 0] } }, promptstyler_next: { class_type: "Other", inputs: {} } };
  const again = injectStyles(linked, { config: { node: "4", input: "text" }, recipe });
  assert.deepEqual(again.promptstyler_next_1.inputs.prompt, ["9", 0], "a prompt another node writes is styled too, under a free id");
});

test("a run is refused when ComfyUI lacks the node; Hidden keeps no styles", () => {
  const workflow = { extensions: { "prompt-styler": { node: "4", input: "text", model: "" } }, controls };
  const value = { styles: [{ id: "anime.cel" }] };
  assert.throws(() => promptStyler.body(value, { workflow, info: {} }), /Restart ComfyUI/);
  assert.equal(promptStyler.body(value, { workflow, info: { PSNextCompose: {} } }).styles.length, 1);
  assert.equal(promptStyler.body(value, { workflow: { extensions: {} }, info: {} }), undefined, "a workflow without Styles ignores them");
  assert.equal(promptStyler.settings(value, { privateVault: true }), undefined);
  const untouched = graph();
  assert.equal(promptStyler.graph(untouched, { workflow, body: {}, value: undefined }), undefined);
  assert.equal(untouched["4"].inputs.text, "a fox");
});

test("the pack is found where ComfyUI keeps it, or where the setting says", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-styler-"));
  const pack = path.join(root, "custom_nodes", "ComfyUI-PromptStyler-Next");
  assert.equal(stylerDir({}, root), "");
  fs.mkdirSync(path.join(pack, "studio"), { recursive: true });
  fs.writeFileSync(path.join(pack, "studio", "server.mjs"), "");
  assert.equal(stylerDir({}, root), pack);
  assert.equal(stylerDir({ HEISS_PROMPTSTYLER_DIR: path.join(root, "elsewhere") }, root), "");
  assert.equal(stylerDir({}, ""), "");
  fs.rmSync(root, { recursive: true, force: true });
});
