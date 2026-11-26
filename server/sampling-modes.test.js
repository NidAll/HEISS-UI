import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.HEISS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-sampling-modes-"));
const { samplingModes } = await import("./sampling-modes.js");
const { detectWorkflowMetadata, saveImportedWorkflow } = await import("./custom-workflows.js");
const { inferModels } = await import("./models.js");
const { sanitizeGenerateBody } = await import("./validation.js");

const modes = [{ steps: 8, label: "Quality (8-step)" }, { steps: 4, label: "Flash (4-step)" }];
const controls = { steps: { node: "3", input: "steps" } };

test("a workflow's modes are kept in order, each count once, and need a steps control and two modes", () => {
  assert.deepEqual(samplingModes.workflow({ modes: [...modes, { steps: "4", label: "Again" }, { steps: 0 }] }, { controls }), { modes });
  assert.deepEqual(samplingModes.workflow({ modes: [{ steps: 6 }, { steps: 12, label: "  " }] }, { controls }).modes,
    [{ steps: 6, label: "6 steps" }, { steps: 12, label: "12 steps" }]);
  assert.equal(samplingModes.workflow({ modes }, { controls: {} }), null);
  assert.equal(samplingModes.workflow({ modes: modes.slice(0, 1) }, { controls }), null);
  assert.equal(samplingModes.workflow("nonsense", { controls }), null);
});

test("the profile offers the modes as the steps control's choices and starts on one of them", () => {
  const profile = { defaults: { steps: 8 }, constraints: { steps: { min: 1, max: 100 } } };
  const shaped = samplingModes.profile(profile, { config: { modes } });
  assert.deepEqual(shaped.constraints.steps, { min: 1, max: 100, choices: [{ value: 8, label: "Quality (8-step)" }, { value: 4, label: "Flash (4-step)" }] });
  assert.equal(shaped.defaults.steps, 8);
  assert.equal(samplingModes.profile({ ...profile, defaults: { steps: 20 } }, { config: { modes } }).defaults.steps, 8);
});

const info = {
  EmptyLatentImage: { input: { required: { width: ["INT", { min: 16, max: 16384, step: 8 }], height: ["INT", { min: 16, max: 16384, step: 8 }], batch_size: ["INT", { min: 1, max: 8 }] } } },
  KSampler: { input: { required: {
    seed: ["INT", { min: 0, max: 999999 }], steps: ["INT", { min: 1, max: 100 }], cfg: ["FLOAT", { min: 0, max: 100, step: 0.1 }],
    sampler_name: [["euler"]], scheduler: [["simple"]], denoise: ["FLOAT", { min: 0, max: 1, step: 0.01 }]
  } } },
  CLIPTextEncode: { input: { required: { text: ["STRING", {}] } } },
  VAEDecode: {},
  SaveImage: {}
};

test("Generate runs at a mode's count and turns any other down", () => {
  const raw = {
    1: { class_type: "CLIPTextEncode", inputs: { text: "" } },
    2: { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    3: { class_type: "KSampler", inputs: { seed: 1, steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
    4: { class_type: "SaveImage", inputs: { filename_prefix: "x" } },
    heissUi: {
      id: "two-modes", name: "Two modes", kind: "image",
      controls: { prompt: { node: "1", input: "text" }, width: { node: "2", input: "width" }, height: { node: "2", input: "height" }, steps: { node: "3", input: "steps" }, seed: { node: "3", input: "seed" } },
      defaults: { width: 1024, height: 1024, steps: 8 },
      capabilities: { steps: true },
      extensions: { "sampling-modes": { modes } }
    }
  };
  saveImportedWorkflow(raw, detectWorkflowMetadata(raw));
  const profile = inferModels(info, {}).profiles.find((item) => item.id === "custom:two-modes");
  assert.deepEqual(profile.constraints.steps.choices.map((choice) => choice.value), [8, 4]);
  const body = { kind: "image", workflow: profile.workflow, profileId: profile.id, model: profile.model, prompt: "a lighthouse", width: 1024, height: 1024, cfg: 1, count: 1 };
  assert.equal(sanitizeGenerateBody({ ...body, steps: 4 }, info).steps, 4);
  assert.throws(() => sanitizeGenerateBody({ ...body, steps: 6 }, info), /runs at 8 or 4 steps/);
});
