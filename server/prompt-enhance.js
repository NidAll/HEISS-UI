/**
 * Enhance: a workflow brings its own text-only ComfyUI graph that rewrites a
 * prompt (a prompt upsampler, a tagger, a small language model), and the
 * composer's Enhance button runs it on what is in the prompt box. The run is a
 * job like any other (status at /api/jobs/:id, Stop through its cancel route),
 * but it makes no picture and never touches the gallery.
 *
 *   heissUi.extensions["prompt-enhance"] = {
 *     graph: { ...ComfyUI API graph... },
 *     prompt: { node: "write", input: "prompt" },   // where the prompt goes (required)
 *     seed:   { node: "write", input: "seed" },     // a fresh seed per click (optional)
 *     style:  { node: "write", input: "style" },    // the chosen look, at most 30 words (optional)
 *     output: "show",                               // the node whose output holds the new prompt
 *     pick:   [{ node: "load", input: "model_name", prefer: ["upsampler.*mtp", "upsampler"] }],
 *     modes:  [{ id: "faithful", label: "Faithful", inputs: { write: { temperature: 0 } } },
 *              { id: "explore", label: "Explore", inputs: { write: { temperature: 0.6 } } }]
 *   }
 *
 * The output node's first `text` (or `string`) value is the new prompt; an
 * `inspection` string beside it, when the node writes one, comes back as is.
 * `pick` chooses a file from what ComfyUI offers for that input, the first
 * pattern that matches winning. Each mode sets inputs on top of the graph; the
 * first mode is the default. Hidden runs, JSON prompts and empty prompts are
 * turned down, so a private prompt never leaves the browser this way.
 */

import crypto from "node:crypto";

// The job and workflow modules load this registry themselves (custom-workflows.js
// reads extension configs), so they are imported when the route first runs.
async function runtime() {
  const [{ comfy }, { cancelPrompt, promptTracker }, { jobs, setTerminalJob }, { getCustomWorkflow }] = await Promise.all([
    import("./comfy.js"), import("./comfy-queue.js"), import("./jobs.js"), import("./custom-workflows.js")
  ]);
  return { request: comfy, cancel: cancelPrompt, tracker: promptTracker, jobMap: jobs, terminal: setTerminalJob, getCustomWorkflow };
}

export const ENHANCE_MAX_CHARS = 6000;
const STYLE_WORDS = 30;
const modeId = /^[a-z][a-z0-9-]{0,23}$/;
const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const primitive = (value) => ["string", "number", "boolean"].includes(typeof value);

function mapping(raw, graph) {
  if (!plain(raw)) return null;
  const node = String(raw.node ?? ""), input = String(raw.input ?? "");
  return graph[node] && input ? { node, input } : null;
}

/** `heissUi.extensions["prompt-enhance"]` → a checked config, or null when it can't run. */
export function enhanceConfig(config) {
  if (!plain(config) || !plain(config.graph)) return null;
  const graph = {};
  for (const [id, node] of Object.entries(config.graph)) {
    if (!plain(node) || typeof node.class_type !== "string" || !node.class_type) return null;
    graph[id] = { class_type: node.class_type, inputs: plain(node.inputs) ? { ...node.inputs } : {} };
  }
  const prompt = mapping(config.prompt, graph);
  const output = String(config.output ?? "");
  if (!prompt || !graph[output]) return null;
  const modes = [];
  for (const item of Array.isArray(config.modes) ? config.modes.slice(0, 6) : []) {
    const id = String(item?.id ?? "");
    if (!modeId.test(id) || modes.some((mode) => mode.id === id)) continue;
    const inputs = {};
    for (const [node, values] of Object.entries(plain(item.inputs) ? item.inputs : {})) {
      if (!graph[node] || !plain(values)) continue;
      const kept = Object.fromEntries(Object.entries(values).filter(([, value]) => primitive(value)));
      if (Object.keys(kept).length) inputs[node] = kept;
    }
    modes.push({ id, label: String(item.label || id).trim().slice(0, 24), inputs });
  }
  const pick = [];
  for (const item of Array.isArray(config.pick) ? config.pick.slice(0, 4) : []) {
    const target = mapping(item, graph);
    const prefer = (Array.isArray(item?.prefer) ? item.prefer : []).map(String).filter((pattern) => pattern && pattern.length <= 200).slice(0, 6);
    if (target && prefer.length) pick.push({ ...target, prefer });
  }
  return { graph, prompt, output, seed: mapping(config.seed, graph), style: mapping(config.style, graph), modes, pick };
}

/** What the composer needs to know: the modes to offer and whether a look is used. */
export function enhanceSummary(config) {
  return { modes: config.modes.map(({ id, label }) => ({ id, label })), style: Boolean(config.style) };
}

function optionsFor(info, classType, input) {
  const inputs = info?.[classType]?.input || {};
  const definition = inputs.required?.[input] || inputs.optional?.[input];
  const options = Array.isArray(definition?.[0]) ? definition[0] : definition?.[1]?.options;
  return Array.isArray(options) ? options.map(String) : null;
}

function matcher(pattern) {
  try { return new RegExp(pattern, "i"); } catch { return null; }
}

/** The look as one short clause: words only, at most 30, no trailing punctuation. */
export function styleClause(style) {
  if (typeof style !== "string") return "";
  return style.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, STYLE_WORDS).join(" ").replace(/[\s.,;:]+$/, "");
}

/** Turns down what Enhance can't take, with the reason it says. */
export function checkEnhanceRequest({ prompt, privateVault }) {
  if (privateVault) throw new Error("Enhance is off in Hidden, so your prompt stays on this device.");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Write an idea first, then Enhance it.");
  if (Array.from(prompt).length > ENHANCE_MAX_CHARS) throw new Error("Enhance takes up to 6,000 characters.");
  const text = prompt.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      JSON.parse(text);
      throw new Error("This prompt is structured (JSON), so Enhance leaves it as it is.");
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return prompt;
}

/** The graph to queue: the workflow's own, with the prompt, mode, seed, look and picked files filled in. */
export function enhanceGraph(config, { prompt, mode = "", style = "", seed = 0, info = null }) {
  const graph = structuredClone(config.graph);
  const missing = [...new Set(Object.values(graph).map((node) => node.class_type))].filter((type) => info && !info[type]);
  if (missing.length) throw new Error(`Enhance needs ${missing.join(", ")} in ComfyUI. Install it, then restart ComfyUI.`);
  const chosen = config.modes.find((item) => item.id === mode) || config.modes[0];
  for (const [node, values] of Object.entries(chosen?.inputs || {})) Object.assign(graph[node].inputs, values);
  for (const target of config.pick) {
    const options = optionsFor(info, graph[target.node].class_type, target.input);
    if (!options) continue;
    const found = target.prefer.map(matcher).filter(Boolean).map((pattern) => options.find((name) => pattern.test(name))).find(Boolean);
    if (found) graph[target.node].inputs[target.input] = found;
    else if (!options.includes(String(graph[target.node].inputs[target.input] ?? ""))) throw new Error("Enhance can't find its model file in ComfyUI.");
  }
  graph[config.prompt.node].inputs[config.prompt.input] = prompt;
  if (config.seed) graph[config.seed.node].inputs[config.seed.input] = seed;
  const look = config.style ? styleClause(style) : "";
  if (look) graph[config.style.node].inputs[config.style.input] = look;
  return graph;
}

/** The new prompt from the output node: its first text value, and the inspection it wrote, if any. */
export function enhanceResult(output) {
  const first = (key) => (Array.isArray(output?.[key]) ? output[key].find((value) => typeof value === "string") : undefined);
  const prompt = first("text") ?? first("string");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("ComfyUI finished without a prompt.");
  const inspection = first("inspection");
  return { prompt: prompt.trim(), ...(inspection ? { inspection } : {}) };
}

const headers = { "content-type": "application/json" };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stopping = (job) => !job || job.status === "canceling" || job.status === "canceled";

/** Starts Enhance jobs on the job map, through ComfyUI's queue; a test passes its own of each. */
export function createEnhancer({ jobMap, terminal, request, cancel, tracker, uuid = crypto.randomUUID, delay = wait, seed = () => crypto.randomInt(0, 2 ** 48 - 1) }) {
  async function run(id, graph) {
    let promptId = "";
    const canceled = async () => {
      if (promptId) await cancel(promptId).catch(() => null);
      terminal(id, { status: "canceled", promptId });
    };
    try {
      const queued = await request("/prompt", { method: "POST", headers, body: JSON.stringify({ prompt: graph, client_id: id }) });
      promptId = String(queued?.prompt_id || "");
      if (!promptId) throw new Error("ComfyUI didn't take the Enhance run.");
      if (stopping(jobMap.get(id))) return canceled();
      jobMap.set(id, { ...jobMap.get(id), status: "running", promptId });
      const watch = tracker(promptId, { request });
      while (true) {
        const checked = await watch.check();
        const job = jobMap.get(id);
        if (stopping(job)) return canceled();
        if (checked.state === "done") {
          const entry = checked.entry;
          if (entry?.status?.status_str === "error") {
            const failure = entry.status.messages?.find(([type]) => type === "execution_error")?.[1];
            throw new Error(failure?.exception_message || "Enhance didn't finish.");
          }
          terminal(id, { status: "done", promptId, result: enhanceResult(entry?.outputs?.[job.output]) });
          return;
        }
        const reconnecting = checked.state === "reconnecting";
        if (Boolean(job.progress?.reconnecting) !== reconnecting) jobMap.set(id, { ...job, progress: { phase: reconnecting ? "Reconnecting…" : "Enhancing…", ...(reconnecting ? { reconnecting: true } : {}) } });
        await delay(reconnecting ? checked.delayMs : 150);
      }
    } catch (error) {
      if (stopping(jobMap.get(id))) return canceled();
      terminal(id, { status: "error", promptId, error: error?.message || "Enhance didn't finish." });
    }
  }
  return function start({ config, prompt, mode, style, privateVault, info }) {
    checkEnhanceRequest({ prompt, privateVault });
    // Built before the job exists, so a bad setup is this request's error.
    const graph = enhanceGraph(config, { prompt, mode, style, seed: seed(), info });
    const id = uuid();
    jobMap.set(id, { status: "queued", kind: "prompt-enhance", output: config.output, startedAt: Date.now(), progress: { phase: "Enhancing…" } });
    setTimeout(() => { void run(id, graph); }, 0);
    return { jobId: id };
  };
}

export const promptEnhance = {
  id: "prompt-enhance",
  workflow: enhanceConfig,
  profile(profile, { config }) {
    profile.enhance = enhanceSummary(config);
  },
  routes(app, { loadComfyContext }) {
    let ready = null;
    const load = () => (ready ||= runtime().then(({ getCustomWorkflow, ...deps }) => ({ getCustomWorkflow, start: createEnhancer(deps) })));
    app.post("/api/prompt-enhance", async (req, res) => {
      try {
        const body = req.body || {};
        const { getCustomWorkflow, start } = await load();
        const workflow = getCustomWorkflow(String(body.profileId || ""));
        const config = workflow?.extensions?.["prompt-enhance"];
        if (!config) throw new Error("This model has no Enhance.");
        const { info } = await loadComfyContext();
        res.json(start({ config, prompt: body.prompt, mode: String(body.mode || ""), style: body.style, privateVault: Boolean(body.privateVault), info }));
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    });
  }
};
