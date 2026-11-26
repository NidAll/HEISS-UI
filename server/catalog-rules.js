/**
 * Catalog rules: an owner's own say over the model picker, kept in the data
 * folder so a release update never undoes it. Every rule is optional; without
 * the file the picker is as HEISS builds it.
 *
 *   <data>/catalog.json (or HEISS_CATALOG_FILE) = {
 *     "retired": ["sdxl-base-refiner"],         // workflow ids never listed, bundled ones too
 *     "keep": ["my-portrait"],                   // workflow ids the picker never offers to delete
 *     "hideFiles": ["old_model.safetensors"],    // model files never listed as automatic entries
 *     "hideCovered": true,                       // no automatic entry for a file a workflow already loads
 *     "defaults": ["custom:my-portrait"]         // what a new device opens on: the first ready one listed
 *   }
 *
 * Request validation never sees these rules, so older pictures keep replaying.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.HEISS_DATA_DIR || process.env.JAI_DATA_DIR ? path.resolve(process.env.HEISS_DATA_DIR || process.env.JAI_DATA_DIR) : path.join(root, "data");
const EMPTY = Object.freeze({ retired: new Set(), keep: new Set(), hideFiles: new Set(), hideCovered: false, defaults: [] });
const plainId = (value) => String(value || "").replace(/^custom:/, "");
const strings = (value, limit = 500) => (Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()).slice(0, limit) : []);

/** The rules as sets, from raw JSON; anything unreadable is left out. */
export function parseCatalogRules(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY;
  return {
    retired: new Set(strings(raw.retired).map(plainId)),
    keep: new Set(strings(raw.keep).map(plainId)),
    hideFiles: new Set(strings(raw.hideFiles)),
    hideCovered: raw.hideCovered === true,
    defaults: strings(raw.defaults, 50)
  };
}

let cached = { file: "", mtime: -1, rules: EMPTY };

/** The current rules, read again when the file changes. */
export function catalogRules(file = process.env.HEISS_CATALOG_FILE || path.join(dataDir, "catalog.json")) {
  let mtime = -1;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return EMPTY; }
  if (cached.file === file && cached.mtime === mtime) return cached.rules;
  let rules = EMPTY;
  try { rules = parseCatalogRules(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { /* a broken file changes nothing */ }
  cached = { file, mtime, rules };
  return rules;
}

export const isRetiredWorkflow = (id, rules = catalogRules()) => rules.retired.has(plainId(id));
export const isKeptWorkflow = (id, rules = catalogRules()) => rules.keep.has(plainId(id));

/** Every text value a workflow's graph or sampling modes set: the model files it loads are among them. */
export function workflowStrings(records) {
  const values = new Set();
  const collect = (inputs) => { for (const value of Object.values(inputs || {})) if (typeof value === "string") values.add(value); };
  for (const workflow of records || []) {
    for (const node of Object.values(workflow.graph || {})) collect(node?.inputs);
    for (const mode of workflow.samplingModes || []) for (const inputs of Object.values(mode?.inputs || {})) collect(inputs);
  }
  return values;
}

/**
 * The picker's model list with the rules applied: hidden automatic entries
 * dropped, and the defaults naming a listed profile, the owner's first ready
 * choice first.
 */
export function curateModelResult(result, { rules = catalogRules(), records = [] } = {}) {
  if (!Array.isArray(result?.profiles)) return result;
  const covered = rules.hideCovered ? workflowStrings(records) : new Set();
  const hidden = new Set(result.profiles
    .filter((profile) => !String(profile.id).startsWith("custom:") && (rules.hideFiles.has(profile.model) || covered.has(profile.model)))
    .map((profile) => profile.id));
  if (!hidden.size && !rules.defaults.length) return result;
  const keep = (items) => (Array.isArray(items) ? items.filter((item) => !hidden.has(item?.id ?? item?.value)) : items);
  const profiles = keep(result.profiles);
  const ready = (profile) => profile && profile.ready !== false;
  const pick = (kind, current) => {
    const listed = (id) => profiles.find((profile) => profile.id === id && profile.kind === kind);
    const chosen = rules.defaults.map(listed).find(ready);
    if (chosen) return chosen.id;
    if (listed(current)) return current;
    const ofKind = profiles.filter((profile) => profile.kind === kind);
    return (ofKind.find(ready) || ofKind[0])?.id || "";
  };
  const defaults = result.defaults || {};
  return {
    ...result, profiles, imageModels: keep(result.imageModels), videoModels: keep(result.videoModels),
    defaults: { ...defaults, imageModel: pick("image", defaults.imageModel), videoModel: pick("video", defaults.videoModel) }
  };
}
