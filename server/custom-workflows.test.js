import assert from "node:assert/strict";
import test from "node:test";
import { detectWorkflowMetadata, graphFromJson, metadataFromJson } from "./custom-workflows.js";

test("visual workflow conversion prefers named widgets and ignores UI-only widget values", () => {
  const raw = {
    nodes: [{
      id: 373,
      type: "KSampler",
      inputs: [],
      widgets_values: [123, "randomize", 2, 1, "euler", "simple", 1],
      widgets_values_named: {
        seed: 123,
        control_after_generate: "randomize",
        steps: 2,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1
      }
    }],
    links: []
  };
  const info = {
    KSampler: { input: { required: {
      seed: ["INT"], steps: ["INT"], cfg: ["FLOAT"], sampler_name: [["euler"]], scheduler: [["simple"]], denoise: ["FLOAT"]
    } } }
  };
  assert.deepEqual(graphFromJson(raw, info)["373"].inputs, {
    seed: 123, steps: 2, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1
  });
});

test("legacy start image metadata is normalized into a media input", () => {
  const workflow = metadataFromJson({
    jAiStudio: {
      id: "legacy-edit",
      controls: { prompt: { node: "2", input: "prompt" }, startImage: { node: "1", input: "image" } },
      capabilities: { startImageRequired: true }
    },
    "1": { class_type: "LoadImage", inputs: { image: "example.png" } },
    "2": { class_type: "TextEncodeQwenImageEditPlus", inputs: { prompt: "", image1: ["1", 0] } },
    "3": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "test" } }
  });
  assert.equal(workflow.capabilities.imageToImage, true);
  assert.equal(workflow.capabilities.startImageRequired, true);
  assert.deepEqual(workflow.mediaInputs[0].control, { node: "1", input: "image" });
});

test("a one-frame video latent saved as a picture is an image workflow; more frames or a video output stay video", () => {
  const graph = (length, output = "SaveImage") => ({
    1: { class_type: "UNETLoader", inputs: { unet_name: "model.safetensors", weight_dtype: "default" } },
    2: { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["9", 0] } },
    3: { class_type: "EmptyHunyuanLatentVideo", inputs: { width: 864, height: 1152, length, batch_size: 1 } },
    4: { class_type: "KSampler", inputs: { seed: 1, steps: 12, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1, model: ["1", 0], positive: ["2", 0], negative: ["2", 0], latent_image: ["3", 0] } },
    5: { class_type: "VAEDecode", inputs: { samples: ["4", 0], vae: ["8", 0] } },
    6: { class_type: output, inputs: { images: ["5", 0] } }
  });
  const still = detectWorkflowMetadata(graph(1), "still");
  assert.equal(still.kind, "image");
  assert.equal("frames" in still.controls, false);
  assert.deepEqual(still.controls.width, { node: "3", input: "width" });
  assert.equal(detectWorkflowMetadata(graph(81), "clip").kind, "video");
  assert.deepEqual(detectWorkflowMetadata(graph(81), "clip").controls.frames, { node: "3", input: "length" });
  assert.equal(detectWorkflowMetadata(graph(1, "SaveAnimatedWEBP"), "webp").kind, "video");
});
