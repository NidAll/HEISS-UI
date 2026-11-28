/**
 * Layout: a visual builder for layout prompts, boxes on a board the shape of
 * the picture. It writes MOSS-Image Layout prompts (a summary and boxes
 * labelled object, character or text) or Ming-Image prompts (canvas settings
 * and layers, objects and text), whichever the workflow reads. HEISS has no
 * serializer of its own: every compile and import goes to the Ming / MOSS
 * Image Prompt Builder pack's routes in ComfyUI (/moss_prompt_builder/*,
 * /ming_prompt_builder/*), so the studio and ComfyUI write the same prompt.
 * The MOSS import also reads Ideogram 4 captions and assistant answers, which
 * is how the builder converts between formats. Nothing is queued or saved.
 *
 * The AI menu runs one ComfyUI graph per action, as a job (status at
 * /api/jobs/:id, Stop through its cancel route), never touching the gallery.
 * The Layout AI node pack does the work: a vision-language writer
 * (LayoutAIAssist) plans, edits and describes layouts as JSON, in the
 * workflow's format (MOSS boxes or Ming layers), and LayoutAIDetect finds
 * boxes and lettering in a reference image with a SAM 3 checkpoint. Core's
 * WeVisOneDetect is the fallback detector when no SAM 3 checkpoint is
 * installed. Boxes travel as xyxy on a 0-1000 grid; the builder node's import
 * places them on the canvas.
 *
 *   heissUi.extensions.layout = {
 *     format: "ming",                             // optional: "moss" (the default) or "ming"
 *     assist: {                                   // optional: without it there is no AI menu
 *       writer: "lfm3.*vl",                       // pattern for the writer's model file
 *       sam: "sam3.*int8",                        // optional: the SAM 3 checkpoint (default: any sam3 file, int8 first)
 *       detector: "wevisone.*\\.safetensors$"     // optional fallback: the WeVisOne text encoder
 *     }
 *   }
 */

import crypto from "node:crypto";
import { comfy } from "./comfy.js";

const ID = "layout";
export const TASKS = ["image", "describe", "text", "edit", "snap", "ocr"];
const OPERATIONS = new Set(["serialize", "import"]);
export const FORMATS = ["moss", "ming"];
const FIELDS = {
  moss: {
    serialize: ["width", "height", "summary_caption", "meta", "canvas", "palette", "layers_data", "output_format"],
    import: ["prompt", "width", "height"]
  },
  ming: {
    serialize: ["width", "height", "image_style", "ambient_lighting", "layers_data", "output_format"],
    import: ["prompt", "width", "height"]
  }
};
const ROUTES = { moss: "moss_prompt_builder", ming: "ming_prompt_builder" };
const NAMES = { moss: "MOSS", ming: "Ming" };
const formatOf = (value) => (value === "ming" ? "ming" : "moss");
const LIMIT = 400_000;
const MAX_IMAGE = 12 * 1024 * 1024;
const MAX_ITEMS = 24;
const CACHE_SIZE = 40;
const DETECT_TOKENS = { detection: 256, referring: 160, ocr: 640 };
const LETTERING = ["title", "text"];
const headers = { "content-type": "application/json" };
const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What each task does, in order, for the progress line. */
export const STEPS = {
  image: ["Looking at the image", "Finding objects and lettering", "Describing every box"],
  describe: ["Describing the boxes"],
  text: ["Planning the layout"],
  edit: ["Editing the layout"],
  snap: ["Finding it in the reference"],
  ocr: ["Reading the lettering"]
};

// The job and upload modules load this registry themselves, so they are imported when first used.
async function runtime() {
  const [{ cancelPrompt, promptTracker }, { jobs, setTerminalJob }, { uploadBufferToComfy }, { getCustomWorkflow }] = await Promise.all([
    import("./comfy-queue.js"), import("./jobs.js"), import("./reference-assets.js"), import("./custom-workflows.js")
  ]);
  return { cancel: cancelPrompt, tracker: promptTracker, jobMap: jobs, terminal: setTerminalJob, getCustomWorkflow,
    upload: async (image) => (await uploadBufferToComfy({ buffer: image.buffer, mime: image.mime, name: "layout-reference" })).comfyName };
}

function pattern(value) {
  if (typeof value !== "string" || !value || value.length > 200) return "";
  try { new RegExp(value, "i"); return value; } catch { return ""; }
}

const SAM = "sam3.*\\.safetensors$";

/** `heissUi.extensions.layout` → `{ format: 'moss' | 'ming', assist: { writer, sam, detector } | null }`. */
export function layoutConfig(config) {
  if (config === true) config = {};
  if (!plain(config)) return null;
  const writer = pattern(config.assist?.writer), detector = pattern(config.assist?.detector);
  const sam = pattern(config.assist?.sam) || SAM;
  return { format: formatOf(config.format), assist: writer || detector || pattern(config.assist?.sam) ? { writer, sam, detector } : null };
}

/** The pack route a request goes to: `body.format` "ming" picks the Ming builder, anything else MOSS. */
export function layoutRoute(operation, body) {
  return `/${ROUTES[formatOf(body?.format)]}/${operation}`;
}

/** Only the fields the node reads, with the types it expects. */
export function layoutRequest(operation, body) {
  if (!OPERATIONS.has(operation)) throw fail("Unknown layout operation.", 404);
  if (!plain(body)) throw fail("The request must be a JSON object.");
  if (body.format != null && !FORMATS.includes(body.format)) throw fail("Unknown layout format.");
  const out = {};
  for (const key of FIELDS[formatOf(body.format)][operation]) {
    if (!(key in body)) continue;
    const value = body[key];
    if (key === "width" || key === "height") {
      if (!Number.isInteger(value)) throw fail(`${key} must be a whole number.`);
    } else if (typeof value !== "string") throw fail(`${key} must be text.`);
    out[key] = value;
  }
  if (JSON.stringify(out).length > LIMIT) throw fail("This layout is too large.");
  return out;
}

const text = (value, name, limit = 2000) => {
  if (value == null) return "";
  if (typeof value !== "string") throw fail(`${name} must be text.`);
  if (value.length > limit) throw fail(`${name} is too long.`);
  return value.trim();
};

function box(value) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((v) => Number.isFinite(v))) return null;
  const [x1, y1, x2, y2] = value.map((v) => Math.max(0, Math.min(1000, Math.round(v))));
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null;
}

function cleanLayout(layout) {
  if (layout == null) return { caption: "", items: [] };
  if (!plain(layout)) throw fail("layout must be an object.");
  const items = Array.isArray(layout.items) ? layout.items.slice(0, MAX_ITEMS) : [];
  return {
    caption: text(layout.caption, "caption", 4000),
    meta: Array.isArray(layout.meta) ? layout.meta.filter((m) => typeof m === "string").slice(0, 8).map((m) => m.slice(0, 60)) : [],
    items: items.map((item, index) => {
      const bbox = box(item?.bbox);
      if (!bbox) throw fail(`Box ${index + 1} has no usable position.`);
      return { label: text(item.label, "label", 60) || "object", caption: text(item.caption, "box caption", 600), bbox, ...(item.text ? { text: text(item.text, "box text", 300) } : {}) };
    })
  };
}

export function parseImage(dataUrl) {
  if (typeof dataUrl !== "string") throw fail("Add a reference image first.");
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw fail("The reference must be a PNG, JPEG or WebP image.");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_IMAGE) throw fail("The reference image is too large (12 MB at most).");
  return { buffer, mime: match[1] };
}

/** A checked AI request; throws a 400 with a plain message. */
export function validateAssist(body) {
  if (!plain(body)) throw fail("The request must be a JSON object.");
  const { task } = body;
  if (!TASKS.includes(task)) throw fail("Unknown layout assistant task.");
  const width = Number(body.width), height = Number(body.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 16384 || height > 16384) throw fail("The canvas size isn't valid.");
  const out = { task, width, height, fresh: body.fresh === true };
  if (task === "image" || task === "snap" || task === "ocr" || (task === "describe" && body.image)) out.image = parseImage(body.image);
  if (task === "image") {
    out.labels = text(body.labels, "labels", 400).split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
    out.findText = body.findText !== false;
  }
  if (task === "describe" || task === "edit") out.layout = cleanLayout(body.layout);
  if (task === "describe" && !out.layout.items.length) throw fail("Draw a box to describe first.");
  if (task === "text" || task === "edit") {
    out.request = text(body.request, "request", 1200);
    if (!out.request) throw fail(task === "text" ? "Describe the picture you want first." : "Write what to change first.");
  }
  if (task === "describe") out.request = text(body.request, "scene note", 1200);
  if (task === "snap") {
    out.query = text(body.query, "query", 300);
    if (!out.query) throw fail("Give the box a caption or a name to look for.");
  }
  return out;
}

export function cacheKey(args) {
  const hash = crypto.createHash("sha256");
  const { image, fresh: _fresh, seed: _seed, temperature: _temperature, ...rest } = args;
  hash.update(JSON.stringify(rest));
  if (image) hash.update(image.buffer);
  return hash.digest("hex");
}

function optionsOf(info, node, key) {
  const definition = info?.[node]?.input?.required?.[key];
  return (Array.isArray(definition?.[0]) ? definition[0] : definition?.[1]?.options || []).map(String);
}

/** The model files the graphs use, picked from what ComfyUI offers by the workflow's patterns. SAM 3 is the
 * detector when its checkpoint is there (an int8 one first); WeVisOne is the fallback. */
export function assistModels(info, assist) {
  const all = (node, key, wanted) => (wanted ? optionsOf(info, node, key).filter((name) => new RegExp(wanted, "i").test(name)) : []);
  const sams = info?.LayoutAIDetect ? all("CheckpointLoaderSimple", "ckpt_name", assist?.sam || SAM) : [];
  const writer = info?.LayoutAIAssist ? all("LayoutAILoadVLM", "model_name", assist?.writer)[0] || "" : "";
  const sam = sams.find((name) => /int8/i.test(name)) || sams[0] || "";
  const wevisone = info?.WeVisOneDetect ? all("CLIPLoader", "clip_name", assist?.detector)[0] || "" : "";
  // OCR with SAM needs the writer to read the boxes; without it only WeVisOne reads.
  return { writer, sam, wevisone, detector: Boolean(sam || wevisone), reader: Boolean((sam && writer) || wevisone) };
}

const json = (value) => JSON.stringify(value);

/** The ComfyUI API graph for one task. `name` is the uploaded reference's ComfyUI input name; `format` the
 * workflow's prompt format, which image, text and edit answers come back in. */
export function assistGraph(args, models, name = "", format = "moss") {
  const { task, width, height } = args;
  const graph = {};
  const image = name ? ["img", 0] : null;
  const size = json({ width, height });
  const outputFormat = formatOf(format);
  if (name) graph.img = { class_type: "LoadImage", inputs: { image: name } };
  const writer = () => { graph.load = { class_type: "LayoutAILoadVLM", inputs: { model_name: models.writer } }; };
  const sam = (id, mode, labels, extra = {}) => {
    graph.sam = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: models.sam } };
    graph[id] = { class_type: "LayoutAIDetect", inputs: { model: ["sam", 0], clip: ["sam", 1], image, mode, labels, ...extra } };
  };
  // The caps stop a rare repetition loop and the long tail of one label repeated all over a picture.
  const wevisone = (id, kind, query) => {
    graph.clip = { class_type: "CLIPLoader", inputs: { clip_name: models.wevisone, type: "stable_diffusion", device: "default" } };
    graph[id] = { class_type: "WeVisOneDetect", inputs: { clip: ["clip", 0], image, task: kind, query, individual_masks: false, max_length: DETECT_TOKENS[kind] } };
  };
  const assist = (id, inputs) => { graph[id] = { class_type: "LayoutAIAssist", inputs: { vlm: ["load", 0], request: "", seed: args.seed ?? 0, temperature: args.temperature ?? 0, output_format: "moss", ...inputs } }; };
  const preview = (from, inspection) => { graph.preview = { class_type: "LayoutAIPreview", inputs: { text: from, inspection } }; };
  if (task === "snap" || task === "ocr") {
    if (models.sam && task === "snap") {
      sam("detect", "snap", args.query);
      preview(["detect", 1], ["detect", 2]);
    } else if (models.sam && models.writer) {
      writer();
      sam("find", "lettering", "");
      assist("ocr", { task: "read_text", image, objects: ["find", 0], layout: size });
      preview(["ocr", 0], ["ocr", 2]);
    } else {
      const id = task === "ocr" ? "ocr" : "detect";
      wevisone(id, task === "ocr" ? "ocr" : "referring", task === "ocr" ? "" : args.query);
      preview([id, 3], [id, 3]);
    }
    return graph;
  }
  writer();
  if (task === "image") {
    if (!models.detector) {
      assist("describe", { task: "image_layout", image, layout: size, output_format: outputFormat });
    } else {
      // Subject first, then lettering, then the rest: WeVisOne stops at its token cap; SAM asks each label alone.
      let query = [...args.labels.slice(0, 1), ...(args.labels.length && args.findText ? LETTERING : []), ...args.labels.slice(1)].join("\n");
      let scene = {};
      if (!query) { assist("list", { task: "list_objects", image }); query = ["list", 1]; scene = { scene: ["list", 0] }; }
      if (models.sam) sam("detect", "objects", query, scene);
      else wevisone("detect", "detection", query);
      assist("describe", { task: "describe_regions", image, objects: ["detect", models.sam ? 0 : 1], ...scene, ...(args.findText ? {} : { read_words: false }), layout: size, output_format: outputFormat });
    }
    preview(["describe", 0], ["describe", 2]);
    return graph;
  }
  if (task === "describe") {
    // Captions land on the boxes they were asked for, so this answer stays MOSS boxes in either format.
    assist("describe", { task: "describe_regions", ...(image ? { image } : {}), request: args.request || args.layout.caption, layout: json({ ...args.layout, width, height }) });
    preview(["describe", 0], ["describe", 2]);
    return graph;
  }
  assist("assist", { task: task === "text" ? "text_layout" : "edit_layout", request: args.request, layout: json({ ...(args.layout || {}), width, height }), output_format: outputFormat });
  preview(["assist", 0], ["assist", 2]);
  return graph;
}

/** A snap or OCR answer as boxes on 0-1000: SAM's `[{label, bbox}]`, a read_text layout (each item's words as
 * its label) or WeVisOne's grounding text. */
export function answerBoxes(answer) {
  const raw = String(answer || "").trim();
  if (!raw.startsWith("[") && !raw.startsWith("{")) return parseGrounding(raw);
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  return items.flatMap((item) => {
    // A read_text item's label is "text": its words, when it has any, are the label.
    const found = box(item?.bbox), label = String((plain(item) && "text" in item ? item.text : item?.label) || "").trim();
    return found && label ? [{ label: label.slice(0, 300), bbox: found }] : [];
  });
}

/** The detector's answer ("<ref>dog</ref><box><x1><y1><x2><y2>,...</box>") as xyxy boxes on 0-1000. */
export function parseGrounding(raw) {
  const boxes = [];
  for (const match of String(raw || "").matchAll(/<ref>(.*?)<\/ref>\s*<box>(.*?)(?:<\/box>|(?=<ref>)|$)/gs)) {
    const label = match[1].trim() || "object";
    for (const segment of match[2].split(",")) {
      const values = [...segment.matchAll(/<(\d{1,4})>/g)].map((m) => Number(m[1]));
      for (let i = 0; i + 3 < values.length; i += 4) {
        const found = box(values.slice(i, i + 4));
        if (found) boxes.push({ label, bbox: found });
      }
    }
  }
  return boxes;
}

const stopping = (job) => !job || job.status === "canceling" || job.status === "canceled";

/** Starts AI layout jobs on the job map; a test passes its own of each. */
export function createLayoutAssist({ jobMap, terminal, request = comfy, cancel, tracker, upload, uuid = crypto.randomUUID, delay = wait, cache = new Map() }) {
  const remember = (key, value) => {
    cache.delete(key); cache.set(key, value);
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  };
  async function run(id, args, key, models, format) {
    let promptId = "";
    const started = Date.now();
    const canceled = async () => {
      if (promptId) await cancel(promptId).catch(() => null);
      terminal(id, { status: "canceled", promptId });
    };
    try {
      const name = args.image ? await upload(args.image) : "";
      if (stopping(jobMap.get(id))) return canceled();
      const queued = await request("/prompt", { method: "POST", headers, body: JSON.stringify({ prompt: assistGraph(args, models, name, format), client_id: id }) });
      promptId = String(queued?.prompt_id || "");
      if (!promptId) throw new Error("ComfyUI didn't take the layout run.");
      jobMap.set(id, { ...jobMap.get(id), status: "running", promptId });
      const watch = tracker(promptId, { request });
      while (true) {
        if (stopping(jobMap.get(id))) return canceled();
        const checked = await watch.check();
        if (checked.state === "done") {
          const entry = checked.entry;
          if (entry?.status?.status_str === "error") {
            const failure = entry.status.messages?.find(([type]) => type === "execution_error")?.[1];
            throw new Error(failure?.exception_message?.trim() || "The layout assistant didn't finish.");
          }
          const out = entry?.outputs?.preview;
          const answer = out?.text?.[0];
          if (typeof answer !== "string") throw new Error("ComfyUI finished without a layout.");
          let result;
          if (args.task === "snap" || args.task === "ocr") result = { boxes: answerBoxes(answer) };
          else {
            let inspection = {};
            try { inspection = JSON.parse(out?.inspection?.[0] || "{}"); } catch { /* optional */ }
            result = { layout: JSON.parse(answer), tokensPerSecond: inspection.tokens_per_second ?? null };
          }
          result.seconds = Math.round((Date.now() - started) / 100) / 10;
          if (!args.fresh) remember(key, result);
          terminal(id, { status: "done", promptId, result });
          return;
        }
        await delay(checked.state === "reconnecting" ? checked.delayMs : 150);
      }
    } catch (error) {
      if (stopping(jobMap.get(id))) return canceled();
      terminal(id, { status: "error", promptId, error: error?.message || "The layout assistant didn't finish." });
    }
  }
  return function start(body, { info, assist, format = "moss" }) {
    const args = validateAssist(body);
    const models = assistModels(info, assist);
    if (!models.writer && !["snap", "ocr"].includes(args.task)) throw fail("The layout writer isn't loaded in ComfyUI. Install the Layout AI nodes and the workflow's assist.writer file, then restart ComfyUI.", 503);
    if (!models.detector && args.task === "snap") throw fail("No layout detector is installed in ComfyUI: add a SAM 3 checkpoint (or the workflow's assist.detector file) and restart ComfyUI.", 503);
    if (!models.reader && args.task === "ocr") throw fail("Reading lettering needs a SAM 3 checkpoint and the layout writer (or the workflow's assist.detector file) in ComfyUI.", 503);
    if (args.fresh) { args.seed = crypto.randomInt(0, 2 ** 31); args.temperature = 0.5; }
    const key = cacheKey({ ...args, format: formatOf(format), detector: models.sam ? "sam" : models.wevisone ? "wevisone" : "" });
    const id = uuid();
    if (!args.fresh && cache.has(key)) {
      const result = { ...cache.get(key), cached: true };
      remember(key, cache.get(key));
      jobMap.set(id, { status: "done", kind: "layout-assist", startedAt: Date.now(), result, terminal: true });
      return { jobId: id };
    }
    jobMap.set(id, { status: "queued", kind: "layout-assist", startedAt: Date.now(), progress: { phase: STEPS[args.task][0], steps: STEPS[args.task] } });
    setTimeout(() => { void run(id, args, key, models, format); }, 0);
    return { jobId: id };
  };
}

export const mossLayout = {
  id: ID,
  workflow: layoutConfig,
  profile(profile, { config }) {
    profile.layout = { assist: Boolean(config.assist), format: config.format || "moss" };
  },
  routes(app, { loadComfyContext }) {
    let ready = null;
    const load = () => (ready ||= runtime().then(({ getCustomWorkflow, ...deps }) => ({ getCustomWorkflow, start: createLayoutAssist(deps) })));
    const assistFor = (getCustomWorkflow, profileId) => {
      const config = getCustomWorkflow(String(profileId || ""))?.extensions?.[ID];
      if (!config?.assist) throw fail("This model has no layout assistant.");
      return config;
    };
    // Before the :operation route, so it never reads "ai" as an operation.
    app.post("/api/moss-layout/ai", async (req, res) => {
      res.set("Cache-Control", "no-store");
      try {
        const { getCustomWorkflow, start } = await load();
        const config = assistFor(getCustomWorkflow, req.body?.profileId);
        const { info } = await loadComfyContext();
        res.json(start(req.body, { info, assist: config.assist, format: config.format }));
      } catch (error) {
        res.status(error.status || 400).json({ error: error.message });
      }
    });
    app.get("/api/moss-layout/ai", async (req, res) => {
      res.set("Cache-Control", "no-store");
      try {
        const { getCustomWorkflow } = await load();
        const { info } = await loadComfyContext();
        const models = assistModels(info, assistFor(getCustomWorkflow, req.query.profileId).assist);
        res.json({ writer: Boolean(models.writer), detector: models.detector, reader: models.reader });
      } catch {
        res.json({ writer: false, detector: false });
      }
    });
    app.post("/api/moss-layout/:operation", async (req, res) => {
      res.set("Cache-Control", "no-store");
      let payload;
      try { payload = layoutRequest(req.params.operation, req.body); }
      catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
      try {
        res.json(await comfy(layoutRoute(req.params.operation, req.body), { method: "POST", headers, body: JSON.stringify(payload), timeout: 15_000 }));
      } catch (error) {
        if (error.status === 404 || error.status === 405) return res.status(503).json({ error: `Restart ComfyUI to load the ${NAMES[formatOf(req.body?.format)]} prompt builder node.`, restart: true });
        if (error.status) {
          let message = error.message;
          try { message = JSON.parse(String(error.raw || "").replace(/^Comfy \d+: /, "")).error || message; } catch { /* plain text */ }
          return res.status(error.status >= 500 ? 502 : 400).json({ error: message });
        }
        res.status(503).json({ error: error.name === "TimeoutError" ? "ComfyUI is busy; try again in a moment." : "ComfyUI isn't reachable, so the layout can't be checked." });
      }
    });
  }
};
