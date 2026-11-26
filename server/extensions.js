/**
 * Built-in extensions: features that plug into HEISS UI without editing the
 * places a feature is otherwise wired by hand. Each extension is one object,
 * imported below, and every hook is optional. With no extensions listed, every
 * helper here is a no-op, so the studio behaves exactly as before.
 *
 * One namespace runs through every path, keyed by extension id:
 *   heissUi.extensions.<id>  workflow config, normalized by `workflow()`
 *   body.extensions.<id>     the client's value for a run, checked by `body()`
 *   settings.extensions.<id> what the gallery keeps for Try again, from `settings()`
 * so adding an extension touches none of the files that call these helpers.
 *
 * The guide is docs/guides/EXTENSIONS.md.
 */

import { promptFromImage } from "./prompt-from-image.js";

/**
 * @typedef {object} ServerExtension
 * @property {string} id  Lowercase letters, digits and dashes; the key in every namespace.
 * @property {(app: import("express").Express, helpers: object) => void} [routes]
 *   Registers its routes after sign-in. Use the helpers' guards: `if (!helpers.requireLocal(req, res)) return;`.
 * @property {(config: unknown, context: { graph: object, controls: object, mediaInputs: object[] }) => unknown} [workflow]
 *   Normalizes `heissUi.extensions.<id>`. Return null to ignore it; a throw drops it too.
 * @property {(value: unknown, context: { workflow: object | null, profile: object | null, info: object }) => unknown} [body]
 *   Checks the client's value for a run. Return undefined to drop it; throw to refuse the run with that message.
 * @property {(value: unknown, context: { privateVault: boolean }) => unknown} [settings]
 *   What the gallery keeps. A Hidden run keeps only what this returns for `privateVault: true`.
 * @property {(graph: object, context: { workflow: object | null, body: object, value: unknown }) => object | void} [graph]
 *   Last change to the graph before it is queued. Return a new graph or change it in place.
 * @property {(config: unknown) => string[]} [requiredNodes]  Node classes its workflow config needs.
 * @property {(outputs: object, context: { workflow: object | null, body: object }) => object | void} [result]
 *   Reads a finished run's ComfyUI outputs (a prompt a node wrote, say). What it returns joins
 *   `settings.extensions.<id>` in the gallery. Runs for workflows that configure the extension.
 * @property {(profile: object, context: { config: unknown, workflow: object }) => object | void} [profile]
 *   Changes the model profile a configured workflow shows (its controls' limits, sizes, defaults).
 *   Return a new profile or change it in place. The generate check reads the same profile.
 */

import { samplingModes } from "./sampling-modes.js";
import { sizeTiers } from "./size-tiers.js";
import { workflowGroup } from "./workflow-group.js";
import { promptEnhance } from "./prompt-enhance.js";
import { workflowOptions } from "./workflow-options.js";

/** @type {ServerExtension[]} */
export const serverExtensions = [samplingModes, sizeTiers, promptFromImage, workflowGroup, promptEnhance, workflowOptions];

const validId = /^[a-z][a-z0-9-]{0,39}$/;

/** The registered extensions, checked once: a bad or repeated id is a programming error. */
export function checkedExtensions(list = serverExtensions) {
  const seen = new Set();
  for (const extension of list) {
    if (!validId.test(String(extension?.id || ""))) throw new Error(`Extension id “${extension?.id}” must be lowercase letters, digits and dashes.`);
    if (seen.has(extension.id)) throw new Error(`Two extensions use the id “${extension.id}”.`);
    seen.add(extension.id);
  }
  return list;
}

const plainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function registerExtensionRoutes(app, helpers = {}, list = serverExtensions) {
  for (const extension of checkedExtensions(list)) extension.routes?.(app, helpers);
}

/** `heissUi.extensions` → `{ id: normalized config }` for the extensions that understand their key. Unknown keys are dropped. */
export function extensionWorkflowConfig(raw, context = {}, list = serverExtensions) {
  const result = {};
  if (!plainObject(raw)) return result;
  for (const extension of list) {
    if (!extension.workflow || !(extension.id in raw)) continue;
    try {
      const config = extension.workflow(raw[extension.id], context);
      if (config !== null && config !== undefined) result[extension.id] = config;
    } catch {
      // A broken config switches only that extension off for this workflow.
    }
  }
  return result;
}

/** `body.extensions` from the client → only the values their extensions accept. A refusal stops the run. */
export function sanitizeExtensionBody(raw, context = {}, list = serverExtensions) {
  const result = {};
  if (!plainObject(raw)) return result;
  for (const extension of list) {
    if (!extension.body || !(extension.id in raw)) continue;
    const value = extension.body(raw[extension.id], context);
    if (value !== undefined) result[extension.id] = value;
  }
  return result;
}

/** What the gallery keeps of `body.extensions`. Nothing is kept for an extension without a `settings` hook. */
export function extensionSettings(body = {}, list = serverExtensions) {
  const result = {};
  const values = plainObject(body.extensions) ? body.extensions : {};
  for (const extension of list) {
    if (!extension.settings || !(extension.id in values)) continue;
    const kept = extension.settings(values[extension.id], { privateVault: Boolean(body.privateVault) });
    if (kept !== undefined) result[extension.id] = kept;
  }
  return result;
}

/** What extensions read from a finished run, by id, for workflows that configure them. A failing reader keeps nothing. */
export function extensionResults(outputs = {}, body = {}, workflow = null, list = serverExtensions) {
  const result = {};
  for (const extension of list) {
    if (!extension.result || !(workflow?.extensions && extension.id in workflow.extensions)) continue;
    try {
      const value = extension.result(outputs, { workflow, body });
      if (plainObject(value)) result[extension.id] = value;
    } catch {
      // A reader that fails keeps nothing for that run.
    }
  }
  return result;
}

/** Each extension's last say over the graph, in list order. `workflow` is the custom workflow, or null for a built-in family. */
export function applyExtensionGraph(graph, body = {}, workflow = null, list = serverExtensions) {
  const values = plainObject(body.extensions) ? body.extensions : {};
  let current = graph;
  for (const extension of list) {
    if (!extension.graph) continue;
    const configured = Boolean(workflow?.extensions && extension.id in workflow.extensions);
    if (!configured && !(extension.id in values)) continue;
    current = extension.graph(current, { workflow, body, value: values[extension.id] }) || current;
  }
  return current;
}

/** Node classes the workflow's extension configs need, beyond its own graph. */
export function extensionRequiredNodes(configs = {}, list = serverExtensions) {
  const nodes = new Set();
  for (const extension of list) {
    if (!extension.requiredNodes || !(extension.id in configs)) continue;
    for (const node of extension.requiredNodes(configs[extension.id]) || []) nodes.add(String(node));
  }
  return [...nodes];
}

/** The profile a custom workflow shows, after each extension it configures has had its say. */
export function applyExtensionProfile(profile, workflow = null, list = serverExtensions) {
  const configs = workflow?.extensions || {};
  let current = profile;
  for (const extension of list) {
    if (!extension.profile || !(extension.id in configs)) continue;
    current = extension.profile(current, { config: configs[extension.id], workflow }) || current;
  }
  return current;
}
