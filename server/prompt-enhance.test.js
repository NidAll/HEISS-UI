import test from "node:test";
import assert from "node:assert/strict";
import { checkEnhanceRequest, createEnhancer, enhanceConfig, enhanceGraph, enhanceResult, enhanceSummary, styleClause } from "./prompt-enhance.js";

const raw = {
  graph: {
    load: { class_type: "LoadWriter", inputs: { model_name: "old.safetensors" } },
    write: { class_type: "WritePrompt", inputs: { writer: ["load", 0], prompt: "", seed: 0, temperature: 0.5 } },
    show: { class_type: "ShowPrompt", inputs: { text: ["write", 0] } }
  },
  prompt: { node: "write", input: "prompt" },
  seed: { node: "write", input: "seed" },
  style: { node: "write", input: "style" },
  output: "show",
  pick: [{ node: "load", input: "model_name", prefer: ["writer.*mtp", "writer"] }],
  modes: [
    { id: "faithful", label: "Faithful", inputs: { write: { temperature: 0 } } },
    { id: "explore", label: "Explore", inputs: { write: { temperature: 0.6, extra: { nested: true } }, ghost: { x: 1 } } },
    { id: "Bad id", label: "Nope" }
  ]
};
const info = {
  LoadWriter: { input: { required: { model_name: [["writer-v2.safetensors", "writer-v2-mtp.safetensors", "other.safetensors"]] } } },
  WritePrompt: { input: { required: {} } },
  ShowPrompt: { input: { required: {} } }
};

test("the config keeps what can run and drops the rest", () => {
  const config = enhanceConfig(raw);
  assert.deepEqual(config.modes.map((mode) => mode.id), ["faithful", "explore"], "a bad mode id is dropped");
  assert.deepEqual(config.modes[1].inputs, { write: { temperature: 0.6 } }, "only plain values on nodes the graph has");
  assert.deepEqual(enhanceSummary(config), { modes: [{ id: "faithful", label: "Faithful" }, { id: "explore", label: "Explore" }], style: true });
  assert.equal(enhanceConfig({ ...raw, output: "nowhere" }), null, "the output node must be in the graph");
  assert.equal(enhanceConfig({ ...raw, prompt: { node: "ghost", input: "prompt" } }), null);
  assert.equal(enhanceConfig({ ...raw, graph: { a: { inputs: {} } } }), null, "every node needs a class");
  assert.equal(enhanceConfig("yes"), null);
});

test("the graph gets the prompt, the mode, a seed, the look and the preferred file", () => {
  const config = enhanceConfig(raw);
  const graph = enhanceGraph(config, { prompt: "a fox", mode: "explore", style: "  watercolour,   soft light.  ", seed: 42, info });
  assert.equal(graph.write.inputs.prompt, "a fox");
  assert.equal(graph.write.inputs.temperature, 0.6);
  assert.equal(graph.write.inputs.seed, 42);
  assert.equal(graph.write.inputs.style, "watercolour, soft light");
  assert.equal(graph.load.inputs.model_name, "writer-v2-mtp.safetensors", "the first pattern that matches wins");
  assert.equal(raw.graph.write.inputs.prompt, "", "the workflow's own graph is left alone");
  assert.equal(enhanceGraph(config, { prompt: "x", mode: "unknown", info }).write.inputs.temperature, 0, "an unknown mode is the first one");
});

test("missing nodes or a missing model file say what to fix", () => {
  const config = enhanceConfig(raw);
  assert.throws(() => enhanceGraph(config, { prompt: "x", info: { LoadWriter: info.LoadWriter } }), /WritePrompt, ShowPrompt/);
  const bare = { ...info, LoadWriter: { input: { required: { model_name: [["unrelated.safetensors"]] } } } };
  assert.throws(() => enhanceGraph(config, { prompt: "x", info: bare }), /model file/);
});

test("Hidden, empty, long and JSON prompts are turned down; text that only looks like JSON is not", () => {
  assert.throws(() => checkEnhanceRequest({ prompt: "a fox", privateVault: true }), /Hidden/);
  assert.throws(() => checkEnhanceRequest({ prompt: "   " }), /idea first/);
  assert.throws(() => checkEnhanceRequest({ prompt: "x".repeat(6001) }), /6,000/);
  assert.throws(() => checkEnhanceRequest({ prompt: '{"scene": "fox"}' }), /JSON/);
  assert.equal(checkEnhanceRequest({ prompt: "[fox] in snow" }), "[fox] in snow");
  assert.equal(styleClause(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ")).split(" ").length, 30);
});

test("the result is the output node's text, with its inspection when it has one", () => {
  assert.deepEqual(enhanceResult({ text: ["  a red fox  "], inspection: ['{"ok":1}'] }), { prompt: "a red fox", inspection: '{"ok":1}' });
  assert.deepEqual(enhanceResult({ string: ["b"] }), { prompt: "b" });
  assert.throws(() => enhanceResult({ text: [""] }), /without a prompt/);
});

function harness(states) {
  const jobMap = new Map();
  const sent = [];
  const canceled = [];
  const start = createEnhancer({
    jobMap,
    terminal: (id, patch) => jobMap.set(id, { ...jobMap.get(id), ...patch, terminal: true }),
    request: async (path, options) => { sent.push({ path, body: JSON.parse(options.body) }); return { prompt_id: "p1" }; },
    cancel: async (id) => { canceled.push(id); },
    tracker: () => ({ check: async () => states.shift() || { state: "pending" } }),
    uuid: () => "job-1",
    delay: () => new Promise((resolve) => setImmediate(resolve)),
    seed: () => 7
  });
  const settled = () => new Promise((resolve) => {
    const tick = () => (jobMap.get("job-1")?.terminal ? resolve(jobMap.get("job-1")) : setImmediate(tick));
    tick();
  });
  return { start, jobMap, sent, canceled, settled };
}

test("a run queues the graph, then keeps the new prompt as the job's result", async () => {
  const { start, sent, settled } = harness([{ state: "pending" }, { state: "done", entry: { status: { status_str: "success" }, outputs: { show: { text: ["a red fox in snow"] } } } }]);
  assert.deepEqual(start({ config: enhanceConfig(raw), prompt: "fox", info }), { jobId: "job-1" });
  const job = await settled();
  assert.equal(sent[0].path, "/prompt");
  assert.equal(sent[0].body.prompt.write.inputs.prompt, "fox");
  assert.equal(sent[0].body.prompt.write.inputs.seed, 7);
  assert.equal(job.status, "done");
  assert.deepEqual(job.result, { prompt: "a red fox in snow" });
});

test("Stop cancels the ComfyUI run; an error says ComfyUI's own message", async () => {
  const stopped = harness([{ state: "pending" }, { state: "pending" }]);
  stopped.start({ config: enhanceConfig(raw), prompt: "fox", info });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  stopped.jobMap.set("job-1", { ...stopped.jobMap.get("job-1"), status: "canceling" });
  const job = await stopped.settled();
  assert.equal(job.status, "canceled");
  assert.deepEqual(stopped.canceled, ["p1"]);

  const failed = harness([{ state: "done", entry: { status: { status_str: "error", messages: [["execution_error", { exception_message: "Out of memory" }]] } } }]);
  failed.start({ config: enhanceConfig(raw), prompt: "fox", info });
  const error = await failed.settled();
  assert.equal(error.status, "error");
  assert.equal(error.error, "Out of memory");
});
