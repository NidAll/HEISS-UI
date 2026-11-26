import test from "node:test";
import assert from "node:assert/strict";
import { assistGraph, assistModels, cacheKey, createLayoutAssist, layoutConfig, layoutRequest, layoutRoute, mossLayout, parseGrounding, validateAssist } from "./moss-layout.js";

const png = `data:image/png;base64,${Buffer.from("not really a png").toString("base64")}`;
const info = {
  PSNextLayoutAssist: {}, WeVisOneDetect: {},
  PSNextLoadUpscaler: { input: { required: { model_name: ["COMBO", { options: ["other.safetensors", "writer-vl-2b.safetensors"] }] } } },
  CLIPLoader: { input: { required: { clip_name: [["t5.safetensors", "detector-vl.safetensors"]] } } }
};
const assist = { writer: "writer.*vl", detector: "detector" };

test("the config keeps usable patterns and the AI menu needs one", () => {
  assert.deepEqual(layoutConfig(true), { format: "moss", assist: null });
  assert.deepEqual(layoutConfig({ assist: { writer: "lfm3.*vl", detector: "([" } }), { format: "moss", assist: { writer: "lfm3.*vl", detector: "" } }, "a broken pattern is dropped");
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
  assert.deepEqual(assistModels(info, assist), { writer: "writer-vl-2b.safetensors", detector: "detector-vl.safetensors" });
  assert.deepEqual(assistModels({ ...info, WeVisOneDetect: undefined }, assist).detector, "");
  assert.deepEqual(assistModels(info, { writer: "", detector: "" }), { writer: "", detector: "" });
});

test("each task builds its own graph", () => {
  const models = assistModels(info, assist);
  const image = validateAssist({ task: "image", width: 1024, height: 768, image: png, labels: "cat, dog" });
  const graph = assistGraph(image, models, "ref.png");
  assert.equal(graph.img.inputs.image, "ref.png");
  assert.equal(graph.detect.inputs.query, "cat\ntitle\ntext\ndog", "subject first, then lettering, then the rest");
  assert.deepEqual(graph.describe.inputs.objects, ["detect", 1]);
  assert.deepEqual(graph.preview.inputs.base_prompt, ["describe", 0]);
  const open = assistGraph({ ...image, labels: [] }, models, "ref.png");
  assert.deepEqual(open.detect.inputs.query, ["list", 1], "without labels the writer lists the objects first");
  const solo = assistGraph(image, { ...models, detector: "" }, "ref.png");
  assert.equal(solo.describe.inputs.task, "image_layout", "without a detector the writer plans from the image alone");
  const snap = assistGraph(validateAssist({ task: "snap", width: 1024, height: 768, image: png, query: "red car" }), models, "ref.png");
  assert.equal(snap.detect.inputs.task, "referring");
  assert.equal(snap.load, undefined, "snapping needs no writer");
  const text = assistGraph(validateAssist({ task: "text", width: 1024, height: 768, request: "a cat on a sofa" }), models);
  assert.equal(text.assist.inputs.task, "text_layout");
  assert.equal(text.img, undefined);
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
});
