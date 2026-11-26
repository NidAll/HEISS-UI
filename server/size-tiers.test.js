import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.HEISS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-size-tiers-"));
const { sizeTiers, tierSize } = await import("./size-tiers.js");
const { detectWorkflowMetadata, saveImportedWorkflow } = await import("./custom-workflows.js");
const { inferModels } = await import("./models.js");

const tier = { megapixels: 2.36, divisibleBy: 64 };

test("sizes come out as the Flux resolution calculator draws them", () => {
  assert.deepEqual(tierSize(1, 1, tier), { width: 1536, height: 1536 });
  assert.deepEqual(tierSize(3, 4, tier), { width: 1344, height: 1792 });
  assert.deepEqual(tierSize(4, 3, tier), { width: 1792, height: 1344 });
  assert.deepEqual(tierSize(9, 16, tier), { width: 1152, height: 2048 });
  assert.deepEqual(tierSize(16, 9, tier), { width: 2048, height: 1152 });
  // 1 MP on the same grid: the sizes 1K presets had before.
  assert.deepEqual(tierSize(3, 4, { megapixels: 1, divisibleBy: 64 }), { width: 896, height: 1152 });
});

test("only a 2K tier with a sensible size is kept", () => {
  assert.deepEqual(sizeTiers.workflow({ tiers: [{ label: "2k", megapixels: "2.36" }] }), tier);
  assert.equal(sizeTiers.workflow({ tiers: [{ label: "4K", megapixels: 8 }] }), null);
  assert.equal(sizeTiers.workflow({ tiers: [{ label: "2K", megapixels: 0 }] }), null);
  assert.equal(sizeTiers.workflow({ tiers: [{ label: "2K", megapixels: 2, divisibleBy: 3 }] }), null);
  assert.equal(sizeTiers.workflow(null), null);
});

test("the model's 2K tab draws each shape at the workflow's own size, and doesn't warn", () => {
  const info = {
    EmptyFlux2LatentImage: { input: { required: { width: ["INT", { min: 16, max: 16384, step: 16 }], height: ["INT", { min: 16, max: 16384, step: 16 }], batch_size: ["INT", { min: 1, max: 8 }] } } },
    KSampler: { input: { required: { steps: ["INT", { min: 1, max: 100 }], sampler_name: [["euler"]], scheduler: [["simple"]] } } },
    CLIPTextEncode: { input: { required: { text: ["STRING", {}] } } },
    VAEDecode: {},
    SaveImage: {}
  };
  const raw = {
    1: { class_type: "CLIPTextEncode", inputs: { text: "" } },
    2: { class_type: "EmptyFlux2LatentImage", inputs: { width: 880, height: 1184, batch_size: 1 } },
    3: { class_type: "KSampler", inputs: { seed: 1, steps: 8 } },
    4: { class_type: "SaveImage", inputs: { filename_prefix: "x" } },
    heissUi: {
      id: "two-sizes", name: "Two sizes", kind: "image",
      controls: { prompt: { node: "1", input: "text" }, width: { node: "2", input: "width" }, height: { node: "2", input: "height" } },
      defaults: { width: 880, height: 1184 },
      aspectRatios: [["Square", 1, 1], ["Portrait", 3, 4], ["Landscape", 4, 3], ["Tall", 9, 16], ["Wide", 16, 9]],
      extensions: { "size-tiers": { tiers: [{ label: "2K", megapixels: 2.36, divisibleBy: 64 }] } }
    }
  };
  saveImportedWorkflow(raw, detectWorkflowMetadata(raw));
  const profile = inferModels(info, {}).profiles.find((item) => item.id === "custom:two-sizes");
  assert.equal(profile.native["2k"], "yes");
  assert.deepEqual(profile.aspectPresets.map((preset) => `${preset.label} ${preset.value}`),
    ["Square 1024x1024", "Portrait 880x1184", "Landscape 1184x880", "Tall 768x1360", "Wide 1360x768"]);
  assert.deepEqual(Object.fromEntries(Object.entries(profile.native.sizes2k).map(([key, size]) => [key, `${size.width}x${size.height}`])), {
    "1024x1024": "1536x1536", "880x1184": "1344x1792", "1184x880": "1792x1344", "768x1360": "1152x2048", "1360x768": "2048x1152"
  });
});
