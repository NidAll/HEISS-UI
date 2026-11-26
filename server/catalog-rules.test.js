import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { catalogRules, curateModelResult, isKeptWorkflow, isRetiredWorkflow, parseCatalogRules, workflowStrings } from "./catalog-rules.js";

const profile = (id, kind, model, ready = true) => ({ id, kind, model, ready });
const result = () => {
  const profiles = [
    profile("image:anima:unet:a.safetensors", "image", "a.safetensors"),
    profile("image:moss:unet:old.safetensors", "image", "old.safetensors"),
    profile("custom:portrait", "image", "custom:portrait"),
    profile("custom:broken", "image", "custom:broken", false),
    profile("video:h3:unet:h3.safetensors", "video", "h3.safetensors")
  ];
  return { profiles, imageModels: profiles.filter((p) => p.kind === "image").map((p) => ({ label: p.id, value: p.id })), videoModels: [{ label: "h3", value: "video:h3:unet:h3.safetensors" }], defaults: { imageModel: "image:moss:unet:old.safetensors", videoModel: "video:h3:unet:h3.safetensors" } };
};

test("rules are read from JSON and a broken file changes nothing", () => {
  const rules = parseCatalogRules({ retired: ["custom:sdxl", 3], keep: ["portrait"], hideFiles: ["old.safetensors"], hideCovered: true, defaults: ["custom:portrait"] });
  assert.deepEqual([...rules.retired], ["sdxl"]);
  assert.equal(isKeptWorkflow("custom:portrait", rules), true);
  assert.equal(isRetiredWorkflow("sdxl", rules), true);
  assert.equal(parseCatalogRules("nope").hideCovered, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-catalog-"));
  const file = path.join(dir, "catalog.json");
  assert.equal(catalogRules(file).retired.size, 0, "no file, no rules");
  fs.writeFileSync(file, JSON.stringify({ retired: ["x"] }));
  assert.equal(catalogRules(file).retired.has("x"), true);
  fs.writeFileSync(file, "{ broken");
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(catalogRules(file).retired.size, 0);
});

test("without rules the picker is as HEISS builds it", () => {
  const input = result();
  assert.equal(curateModelResult(input, { rules: parseCatalogRules({}) }), input);
});

test("hidden and covered files leave the picker, and the default is a listed choice", () => {
  const records = [{ graph: { 1: { class_type: "Loader", inputs: { unet_name: "a.safetensors" } } }, samplingModes: [{ inputs: { 1: { unet_name: "b.safetensors" } } }] }];
  assert.deepEqual([...workflowStrings(records)], ["a.safetensors", "b.safetensors"]);
  const rules = parseCatalogRules({ hideFiles: ["old.safetensors"], hideCovered: true, defaults: ["custom:broken", "custom:portrait"] });
  const curated = curateModelResult(result(), { rules, records });
  assert.deepEqual(curated.profiles.map((p) => p.id), ["custom:portrait", "custom:broken", "video:h3:unet:h3.safetensors"]);
  assert.deepEqual(curated.imageModels.map((m) => m.value), ["custom:portrait", "custom:broken"]);
  assert.equal(curated.defaults.imageModel, "custom:portrait", "the first ready default wins");
  assert.equal(curated.defaults.videoModel, "video:h3:unet:h3.safetensors", "a listed default stays");
  const noDefaults = curateModelResult(result(), { rules: parseCatalogRules({ hideFiles: ["old.safetensors"] }) });
  assert.equal(noDefaults.defaults.imageModel, "image:anima:unet:a.safetensors", "a hidden default moves to the first ready listed one");
});
