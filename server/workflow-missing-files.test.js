import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.HEISS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-missing-files-"));
const { workflowMissingFiles, workflowOptionIssues } = await import("./custom-workflows.js");

const loraSchema = { input: { required: { lora_name: [["have.safetensors"]] } } };
const info = { LoraLoader: loraSchema, LoraLoaderModelOnly: loraSchema };

test("a LoRA a workflow loads by name counts as a file it needs", () => {
  const workflow = { graph: {
    1: { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "lightning-4step.safetensors" } },
    2: { class_type: "LoraLoader", inputs: { lora_name: "have.safetensors" } }
  } };
  assert.deepEqual(workflowMissingFiles(workflow, info).map(({ file, folder }) => [file, folder]), [["lightning-4step.safetensors", "loras"]]);
  assert.deepEqual(workflowOptionIssues(workflow, info), ["Missing LoRA: lightning-4step.safetensors. Put it in ComfyUI’s models/loras folder."]);
});
