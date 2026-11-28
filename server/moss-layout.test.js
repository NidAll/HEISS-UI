import test from "node:test";
import assert from "node:assert/strict";
import { answerBoxes, assistGraph, assistModels, cacheKey, createLayoutAssist, layoutConfig, layoutRequest, layoutRoute, mossLayout, parseGrounding, validateAssist } from "./moss-layout.js";

const png = `data:image/png;base64,${Buffer.from("not really a png").toString("base64")}`;
const info = {
  LayoutAIAssist: {}, LayoutAIDetect: {}, WeVisOneDetect: {},
  LayoutAILoadVLM: { input: { required: { model_name: ["COMBO", { options: ["other.safetensors", "writer-vl-2b.safetensors"] }] } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sd15.safetensors", "sam3/sam3_fp16.safetensors", "sam3/sam3_int8.safetensors"]] } } },
  CLIPLoader: { input: { required: { clip_name: [["t5.safetensors", "detector-vl.safetensors"]] } } }
};
const assist = layoutConfig({ assist: { writer: "writer.*vl", detector: "detector" } }).assist;
const fallback = { ...info, LayoutAIDetect: undefined };

test("the config keeps usable patterns and the AI menu needs one", () => {
  assert.deepEqual(layoutConfig(true), { format: "moss", assist: null });
  assert.deepEqual(layoutConfig({ assist: { writer: "lfm3.*vl", detector: "([" } }), { format: "moss", assist: { writer: "lfm3.*vl", sam: "sam3.*\\.safetensors$", detector: "" } }, "a broken pattern is dropped; SAM 3 is looked for by default");
  assert.equal(layoutConfig({ assist: { writer: "x", sam: "mysam" } }).assist.sam, "mysam");
  assert.equal(layoutConfig("yes"), null);
});

test("a workflow picks the prompt format, and the profile says which", () => {
  assert.equal(layoutConfig({ format: "ming" }).format, "ming");
  assert.equal(layoutConfig({ format: "ideogram" }).format, "moss", "an unknown format falls back to MOSS");
  const profile = {};
  mossLayout.profile(profile, { config: layoutConfig({ format: "ming", assist: { writer: "x" } }) });
  assert.deepEqual(profile.layout, { assist: true, format: "ming" });
});

test("each format goes to its own builder route with its own fields", () => {
  assert.equal(layoutRoute("serialize", { format: "ming" }), "/ming_prompt_builder/serialize");
  assert.equal(layoutRoute("import", {}), "/moss_prompt_builder/import");
  assert.deepEqual(layoutRequest("serialize", { format: "ming", width: 864, height: 1152, image_style: "flat poster", summary_caption: "dropped", layers_data: "[]" }),
    { width: 864, height: 1152, image_style: "flat poster", layers_data: "[]" });
  assert.deepEqual(layoutRequest("serialize", { width: 1024, height: 1024, image_style: "dropped", summary_caption: "a park" }), { width: 1024, height: 1024, summary_caption: "a park" });
  assert.throws(() => layoutRequest("serialize", { format: "ideogram" }), /Unknown layout format/);
});

test("the builder proxy forwards only the node's fields, typed", () => {
  assert.deepEqual(layoutRequest("import", { prompt: "{}", width: 1024, height: 768, extra: "x" }), { prompt: "{}", width: 1024, height: 768 });
  assert.throws(() => layoutRequest("serialize", { width: "1024" }), /whole number/);
  assert.throws(() => layoutRequest("serialize", { meta: 3 }), /text/);
  assert.throws(() => layoutRequest("export", {}), (error) => error.status === 404);
  assert.throws(() => layoutRequest("serialize", { summary_caption: "x".repeat(400_001) }), /too large/);
});

test("AI requests are checked before anything is queued", () => {
  const base = { width: 1024, height: 1024 };
  assert.throws(() => validateAssist({ ...base, task: "draw" }), /Unknown/);
  assert.throws(() => validateAssist({ task: "text", width: 10, height: 10, request: "x" }), /canvas size/);
  assert.throws(() => validateAssist({ ...base, task: "text" }), /Describe the picture/);
  assert.throws(() => validateAssist({ ...base, task: "image", image: "data:text/plain;base64,AA==" }), /PNG, JPEG or WebP/);
  assert.throws(() => validateAssist({ ...base, task: "describe", layout: { items: [] } }), /Draw a box/);
  assert.throws(() => validateAssist({ ...base, task: "edit", request: "x", layout: { items: [{ bbox: [5, 5, 5, 9] }] } }), /Box 1/);
  const edit = validateAssist({ ...base, task: "edit", request: " bigger dog ", layout: { caption: "a park", items: [{ label: "dog", caption: "a dog", bbox: [-4, 10.4, 500, 1200] }] } });
  assert.equal(edit.request, "bigger dog");
  assert.deepEqual(edit.layout.items[0].bbox, [0, 10, 500, 1000], "boxes are clamped to the 0-1000 grid");
  const image = validateAssist({ ...base, task: "image", image: png, labels: "cat, dog\nsign" });
  assert.deepEqual(image.labels, ["cat", "dog", "sign"]);
  assert.equal(image.image.mime, "image/png");
});

test("models come from the workflow's patterns, and only when their nodes are loaded", () => {
  assert.deepEqual(assistModels(info, assist), { writer: "writer-vl-2b.safetensors", sam: "sam3/sam3_int8.safetensors", wevisone: "detector-vl.safetensors", detector: true, reader: true }, "an int8 SAM 3 file first");
  assert.equal(assistModels(fallback, assist).sam, "", "without the Layout AI detector node there is no SAM");
  assert.equal(assistModels({ ...fallback, WeVisOneDetect: undefined }, assist).detector, false);
  assert.deepEqual(assistModels(info, { writer: "", sam: "", detector: "" }), { writer: "", sam: "sam3/sam3_int8.safetensors", wevisone: "", detector: true, reader: false }, "SAM 3 is found without a pattern");
  assert.equal(assistModels({ ...info, LayoutAIAssist: undefined, WeVisOneDetect: undefined }, assist).reader, false, "SAM finds lettering but the writer reads it");
});

test("each task builds its own graph, SAM first", () => {
  const models = assistModels(info, assist);
  const image = validateAssist({ task: "image", width: 1024, height: 768, image: png, labels: "cat, dog" });
  const graph = assistGraph(image, models, "ref.png", "ming");
  assert.equal(graph.img.inputs.image, "ref.png");
  assert.equal(graph.sam.inputs.ckpt_name, "sam3/sam3_int8.safetensors");
  assert.equal(graph.detect.class_type, "LayoutAIDetect");
  assert.equal(graph.detect.inputs.labels, "cat\ntitle\ntext\ndog", "subject first, then lettering, then the rest");
  assert.deepEqual(graph.describe.inputs.objects, ["detect", 0]);
  assert.equal(graph.describe.inputs.output_format, "ming", "the answer comes in the workflow's format");
  assert.deepEqual(graph.preview, { class_type: "LayoutAIPreview", inputs: { text: ["describe", 0], inspection: ["describe", 2] } });
  const open = assistGraph({ ...image, labels: [] }, models, "ref.png");
  assert.deepEqual(open.detect.inputs.labels, ["list", 1], "without labels the writer lists the objects first");
  assert.deepEqual(open.detect.inputs.scene, ["list", 0]);
  assert.equal(open.list.inputs.output_format, "moss");
  const solo = assistGraph(image, { ...models, sam: "", wevisone: "", detector: false }, "ref.png");
  assert.equal(solo.describe.inputs.task, "image_layout", "without a detector the writer plans from the image alone");
  const snap = assistGraph(validateAssist({ task: "snap", width: 1024, height: 768, image: png, query: "red car" }), models, "ref.png");
  assert.equal(snap.detect.inputs.mode, "snap");
  assert.equal(snap.load, undefined, "snapping needs no writer");
  const ocr = assistGraph(validateAssist({ task: "ocr", width: 1024, height: 768, image: png }), models, "ref.png");
  assert.equal(ocr.find.inputs.mode, "lettering");
  assert.equal(ocr.ocr.inputs.task, "read_text");
  const text = assistGraph(validateAssist({ task: "text", width: 1024, height: 768, request: "a cat on a sofa" }), models, "", "ming");
  assert.equal(text.assist.inputs.task, "text_layout");
  assert.equal(text.assist.inputs.output_format, "ming");
  assert.equal(text.img, undefined);
  const describe = assistGraph(validateAssist({ task: "describe", width: 1024, height: 768, layout: { items: [{ bbox: [1, 1, 50, 50] }] } }), models, "", "ming");
  assert.equal(describe.describe.inputs.output_format, "moss", "captions land on the boxes they were asked for");
});

test("without SAM 3 the WeVisOne detector is the fallback", () => {
  const models = assistModels(fallback, assist);
  const image = validateAssist({ task: "image", width: 1024, height: 768, image: png, labels: "cat, dog" });
  const graph = assistGraph(image, models, "ref.png");
  assert.equal(graph.detect.class_type, "WeVisOneDetect");
  assert.equal(graph.detect.inputs.query, "cat\ntitle\ntext\ndog");
  assert.deepEqual(graph.describe.inputs.objects, ["detect", 1]);
  const snap = assistGraph(validateAssist({ task: "snap", width: 1024, height: 768, image: png, query: "red car" }), models, "ref.png");
  assert.equal(snap.detect.inputs.task, "referring");
  const ocr = assistGraph(validateAssist({ task: "ocr", width: 1024, height: 768, image: png }), models, "ref.png");
  assert.equal(ocr.ocr.inputs.task, "ocr");
  assert.deepEqual(ocr.preview.inputs, { text: ["ocr", 3], inspection: ["ocr", 3] });
});

test("snap and OCR answers become boxes from either detector", () => {
  assert.deepEqual(answerBoxes('[{"label": "fox", "bbox": [592, 213, 997, 1000]}]'), [{ label: "fox", bbox: [592, 213, 997, 1000] }]);
  const read = { caption: "", items: [{ label: "text", text: "THE", bbox: [470, 50, 532, 71] }, { label: "text", text: "", bbox: [1, 1, 9, 9] }] };
  assert.deepEqual(answerBoxes(JSON.stringify(read)), [{ label: "THE", bbox: [470, 50, 532, 71] }], "a read crop's words are its label; an empty read is dropped");
  assert.deepEqual(answerBoxes("<ref>dog</ref><box><10><20><300><400></box>"), [{ label: "dog", bbox: [10, 20, 300, 400] }]);
  assert.deepEqual(answerBoxes("{broken"), []);
});

test("detector answers become boxes on the 0-1000 grid", () => {
  const boxes = parseGrounding("<ref>dog</ref><box><10><20><300><400>,<500><500><600><700></box><ref>sign</ref><box><1><1><1><9></box><ref>cat</ref><box><0><0><50><60>");
  assert.deepEqual(boxes, [
    { label: "dog", bbox: [10, 20, 300, 400] },
    { label: "dog", bbox: [500, 500, 600, 700] },
    { label: "cat", bbox: [0, 0, 50, 60] }
  ], "an empty box is dropped and a cut-off answer still reads");
});

test("a run queues one graph, finishes as a job and is cached", async () => {
  const jobMap = new Map();
  const terminal = (id, patch) => jobMap.set(id, { ...jobMap.get(id), ...patch, terminal: true });
  const queued = [];
  const request = async (path, init) => {
    queued.push(JSON.parse(init.body).prompt);
    return { prompt_id: "p1" };
  };
  const tracker = () => ({ check: async () => ({ state: "done", entry: { outputs: { preview: { text: [JSON.stringify({ caption: "a cat", items: [] })], inspection: [JSON.stringify({ tokens_per_second: 40 })] } } } }) });
  let n = 0;
  const start = createLayoutAssist({ jobMap, terminal, request, tracker, cancel: async () => null, upload: async () => "ref.png", uuid: () => `job${++n}`, delay: async () => undefined });
  const body = { task: "text", width: 1024, height: 1024, request: "a cat" };
  const { jobId } = start(body, { info, assist });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(jobMap.get(jobId).status, "done");
  assert.deepEqual(jobMap.get(jobId).result.layout, { caption: "a cat", items: [] });
  assert.equal(jobMap.get(jobId).result.tokensPerSecond, 40);
  const again = start(body, { info, assist });
  assert.equal(jobMap.get(again.jobId).result.cached, true, "the same request comes from the cache");
  assert.equal(queued.length, 1);
  assert.notEqual(cacheKey(validateAssist(body)), cacheKey(validateAssist({ ...body, request: "a dog" })));
  assert.throws(() => start(body, { info: {}, assist }), (error) => error.status === 503 && /writer/.test(error.message));
  const ming = start(body, { info, assist, format: "ming" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(jobMap.get(ming.jobId).result.cached, undefined, "another format is another request");
  assert.equal(queued.at(-1).assist.inputs.output_format, "ming");
  assert.throws(() => start({ task: "ocr", width: 1024, height: 1024, image: png }, { info: { ...info, LayoutAIAssist: undefined, WeVisOneDetect: undefined }, assist }), (error) => error.status === 503 && /Reading lettering/.test(error.message));
});
