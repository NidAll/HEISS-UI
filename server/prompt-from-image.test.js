import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.HEISS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-prompt-from-image-"));
const { promptFromImage, promptIsOptional } = await import("./prompt-from-image.js");
const { detectWorkflowMetadata, saveImportedWorkflow } = await import("./custom-workflows.js");
const { inferModels } = await import("./models.js");
const { sanitizeGenerateBody } = await import("./validation.js");

test("only a workflow that takes an image can write its own prompt", () => {
  assert.deepEqual(promptFromImage.workflow({}, { controls: {}, mediaInputs: [{ id: "reference", kind: "image" }] }), {});
  assert.deepEqual(promptFromImage.workflow({}, { controls: { startImage: { node: "5", input: "image" } } }), {});
  assert.equal(promptFromImage.workflow({}, { controls: {}, mediaInputs: [] }), null);
  assert.equal(promptIsOptional({ extensions: { "prompt-from-image": {} } }), true);
  assert.equal(promptIsOptional({ extensions: {} }), false);
  assert.equal(promptIsOptional(null), false);
});

const info = {
  LoadImage: { input: { required: { image: [["x.png"], {}] } } },
  CLIPTextEncode: { input: { required: { text: ["STRING", {}] } } },
  KSampler: { input: { required: {
    seed: ["INT", { min: 0, max: 999999 }], steps: ["INT", { min: 1, max: 100 }], cfg: ["FLOAT", { min: 0, max: 100, step: 0.1 }],
    sampler_name: [["euler"]], scheduler: [["simple"]], denoise: ["FLOAT", { min: 0, max: 1, step: 0.01 }]
  } } },
  EmptyLatentImage: { input: { required: { width: ["INT", { min: 16, max: 16384, step: 8 }], height: ["INT", { min: 16, max: 16384, step: 8 }], batch_size: ["INT", { min: 1, max: 8 }] } } },
  VAEDecode: {},
  SaveImage: {}
};

function workflow(id, extensions, required) {
  return {
    1: { class_type: "CLIPTextEncode", inputs: { text: "" } },
    2: { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    3: { class_type: "KSampler", inputs: { seed: 1, steps: 4, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
    4: { class_type: "SaveImage", inputs: { filename_prefix: "x" } },
    5: { class_type: "LoadImage", inputs: { image: "x.png" } },
    heissUi: {
      id, name: id, kind: "image",
      controls: { prompt: { node: "1", input: "text" }, width: { node: "2", input: "width" }, height: { node: "2", input: "height" }, seed: { node: "3", input: "seed" } },
      mediaInputs: [{ id: "reference", kind: "image", label: "Start image", required, control: { node: "5", input: "image" } }],
      defaults: { width: 1024, height: 1024 },
      extensions
    }
  };
}

function bodyFor(id) {
  const profile = inferModels(info, {}).profiles.find((item) => item.id === `custom:${id}`);
  return { kind: "image", workflow: profile.workflow, profileId: profile.id, model: profile.model, prompt: "", width: 1024, height: 1024, cfg: 1, count: 1 };
}

test("Generate runs with an empty prompt once the image is in, and asks for one otherwise", () => {
  for (const [id, extensions, required] of [["clone", { "prompt-from-image": {} }, true], ["clone-optional", { "prompt-from-image": {} }, false], ["plain", {}, true]]) {
    const raw = workflow(id, extensions, required);
    saveImportedWorkflow(raw, detectWorkflowMetadata(raw));
  }
  const image = { referenceAssets: [{ slot: "reference", assetId: "asset-1" }] };
  assert.equal(sanitizeGenerateBody({ ...bodyFor("clone"), ...image }, info).prompt, "");
  assert.throws(() => sanitizeGenerateBody(bodyFor("clone"), info), /Start image is required/);
  assert.throws(() => sanitizeGenerateBody(bodyFor("clone-optional"), info), /Enter a prompt or add a start image/);
  assert.throws(() => sanitizeGenerateBody({ ...bodyFor("plain"), ...image }, info), /Enter a prompt\./);
  assert.equal(sanitizeGenerateBody({ ...bodyFor("clone"), ...image, prompt: "warmer light" }, info).prompt, "warmer light");
});
