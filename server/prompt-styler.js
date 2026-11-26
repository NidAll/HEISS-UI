/**
 * Styles: the composer's Styles button opens PromptStyler Next's own picker
 * (looks, colour grades and effects, each at a strength), and the chosen
 * styles go with each run. The picker, its catalog and the prompt engine all
 * belong to the PromptStyler Next node pack; HEISS serves the pack's browser
 * module, runs its Python service on demand behind the sign-in, and puts one
 * PSNextCompose node in front of the workflow's prompt input. Without the pack
 * on this machine nothing shows.
 *
 *   heissUi.extensions["prompt-styler"] = {
 *     node: "4", input: "text",   // the prompt input the styles apply to (default: the prompt control)
 *     model: "anima-turbo"        // the PromptStyler model profile (default: picked from the family)
 *   }
 *
 * The pack is found at HEISS_PROMPTSTYLER_DIR, or in ComfyUI's custom_nodes as
 * ComfyUI-PromptStyler-Next. Its service runs with HEISS_PROMPTSTYLER_PYTHON,
 * else ComfyUI's own Python.
 */

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { comfyPython, comfyRootDir } from "./node-install.js";

const ID = "prompt-styler";
const PACK = "ComfyUI-PromptStyler-Next";
const AXES = ["medium", "lighting", "palette", "composition", "texture", "mood", "detail"];
const styleId = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const modelId = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const textOrLink = (value) => typeof value === "string" || (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]));

// The pack's browser files, at fixed names. The web client is served directly,
// so the panel's `./client.mjs` import needs no folder above it.
const ASSETS = {
  "react-panel.mjs": "studio/react-panel.mjs",
  "model-profile.mjs": "studio/model-profile.mjs",
  "client.mjs": "promptstyler_next/web/client.mjs",
  "panel.css": "studio/panel.css"
};

/** The PromptStyler Next folder on this machine, or "" when it isn't installed. */
export function stylerDir(env = process.env, root = comfyRootDir()) {
  const explicit = String(env.HEISS_PROMPTSTYLER_DIR || "").trim();
  const dir = explicit ? path.resolve(explicit) : root ? path.join(root, "custom_nodes", PACK) : "";
  return dir && fs.existsSync(path.join(dir, "studio", "server.mjs")) ? dir : "";
}

/** `heissUi.extensions["prompt-styler"]` → `{ node, input, model }` on a text input the graph has, or null. */
export function stylerConfig(config, { graph, controls } = {}) {
  if (!plain(config)) return null;
  const node = String(config.node ?? controls?.prompt?.node ?? "");
  const input = String(config.input ?? controls?.prompt?.input ?? "");
  const inputs = graph?.[node]?.inputs;
  if (!plain(inputs) || !input || !(input in inputs) || !textOrLink(inputs[input])) return null;
  const model = typeof config.model === "string" && modelId.test(config.model) ? config.model : "";
  return { node, input, model };
}

/** A run's styles, checked for shape (the engine checks the ids). Undefined when none are chosen; a throw refuses the run. */
export function checkRecipe(value, fallbackModel = "") {
  if (!plain(value)) return undefined;
  const bad = () => new Error("The chosen styles can't be read. Open Styles and choose them again.");
  if ((value.schema_version !== undefined && value.schema_version !== 1) || !Array.isArray(value.styles) || value.styles.length > 16) throw bad();
  const ids = new Set();
  const styles = value.styles.map((layer) => {
    const intensity = layer?.intensity === undefined ? 1 : Number(layer.intensity);
    if (!plain(layer) || typeof layer.id !== "string" || layer.id.length > 96 || !styleId.test(layer.id) || ids.has(layer.id) || !(intensity >= 0 && intensity <= 1)) throw bad();
    ids.add(layer.id);
    return { id: layer.id, intensity };
  });
  if (!styles.length) return undefined;
  const conflict = value.conflict_policy ?? "last_wins";
  const prompt = value.prompt_conflicts ?? "replace";
  const locked = value.locked_axes ?? [];
  if (!["last_wins", "first_wins", "error"].includes(conflict) || !["replace", "keep"].includes(prompt)
    || !Array.isArray(locked) || locked.some((axis) => !AXES.includes(axis)) || new Set(locked).size !== locked.length) throw bad();
  const model = typeof value.model === "string" && modelId.test(value.model) ? value.model : fallbackModel;
  return { schema_version: 1, ...(model ? { model } : {}), styles, conflict_policy: conflict, locked_axes: [...locked], prompt_conflicts: prompt };
}

/**
 * Puts one PSNextCompose node in front of the mapped prompt input: it takes
 * what the input had (the text, or the node that wrote it) and the styles, and
 * feeds both prompts. The negative input, when the workflow maps one, takes its
 * second output, so style negatives join yours.
 */
export function injectStyles(graph, { config, controls = {}, recipe, negative = "" }) {
  const inputs = graph?.[config.node]?.inputs;
  if (!inputs || !textOrLink(inputs[config.input])) throw new Error("This workflow's prompt input moved, so Styles can't reach it.");
  let id = "promptstyler_next";
  for (let index = 1; graph[id]; index += 1) id = `promptstyler_next_${index}`;
  graph[id] = {
    class_type: "PSNextCompose",
    inputs: { recipe: JSON.stringify({ ...recipe, prompt: "", negative: String(negative || "") }), prompt: inputs[config.input] },
    _meta: { title: "PromptStyler Next" }
  };
  inputs[config.input] = [id, 0];
  const target = controls.negative;
  if (target?.node && target?.input && graph[target.node]?.inputs) graph[target.node].inputs[target.input] = [id, 1];
  return graph;
}

/** The body the pack's own transport reads: Express has parsed JSON already, so it gets the same JSON back as a stream. */
function asRawRequest(req) {
  const bytes = req.body === undefined ? [] : [Buffer.from(JSON.stringify(req.body))];
  return Object.assign(Readable.from(bytes), { method: req.method, url: req.url, headers: req.headers, socket: req.socket });
}

let sidecar = null;

/** Starts the pack's Python service on first use; one for the server's life, stopped with it. */
async function service(dir) {
  if (sidecar) return sidecar;
  sidecar = (async () => {
    const { createManagedPromptStyler } = await import(pathToFileURL(path.join(dir, "studio", "server.mjs")).href);
    const python = String(process.env.HEISS_PROMPTSTYLER_PYTHON || "").trim() || comfyPython(comfyRootDir()) || "python3";
    const managed = createManagedPromptStyler({ python, projectRoot: dir });
    // gallery-store re-raises a stop signal once it has saved, and Node then ends
    // without an "exit" event, so the service is stopped on the signal itself.
    for (const signal of process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"]) process.prependOnceListener(signal, managed.stop);
    return managed;
  })().catch((error) => { sidecar = null; throw error; });
  return sidecar;
}

export const promptStyler = {
  id: ID,
  workflow: stylerConfig,
  profile(profile, { config }) {
    if (!stylerDir()) return;
    profile.promptStyler = { model: config.model };
  },
  body(value, { workflow, info }) {
    const config = workflow?.extensions?.[ID];
    if (!config) return undefined;
    const recipe = checkRecipe(value, config.model);
    if (recipe && info && !info.PSNextCompose) throw new Error("ComfyUI hasn't loaded PromptStyler Next. Restart ComfyUI, then generate with styles.");
    return recipe;
  },
  settings(value, { privateVault }) {
    return privateVault ? undefined : value;
  },
  graph(graph, { workflow, body, value }) {
    const config = workflow?.extensions?.[ID];
    if (!config || !value?.styles?.length) return;
    return injectStyles(graph, { config, controls: workflow.controls, recipe: value, negative: body.negative });
  },
  routes(app) {
    app.use("/api/promptstyler/v1", async (req, res) => {
      const dir = stylerDir();
      if (!dir) return res.status(404).json({ error: { code: "not_installed", message: "PromptStyler Next isn't installed in ComfyUI.", path: "" } });
      try {
        const managed = await service(dir);
        await managed.middleware(asRawRequest(req), res);
      } catch {
        if (!res.headersSent) res.status(503).json({ error: { code: "styler_unavailable", message: "PromptStyler could not start. Check its installation and try again.", path: "" } });
      }
    });
    app.get("/api/extensions/prompt-styler/assets/:file", (req, res) => {
      const relative = Object.hasOwn(ASSETS, req.params.file) ? ASSETS[req.params.file] : "";
      const dir = stylerDir();
      if (!relative || !dir) return res.status(404).end();
      res.sendFile(path.join(dir, relative), { headers: { "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" } });
    });
  }
};
