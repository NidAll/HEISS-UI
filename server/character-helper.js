/**
 * Character: a panel that builds a Danbooru tag prompt for one character, in
 * fields (character, subject, hair, eyes, outfit, pose, background…). The tag
 * database and its lookups belong to the Character Helper node pack in
 * ComfyUI (its /character_helper/* routes); HEISS forwards only the fields the
 * node reads, with sizes capped. Nothing is queued or saved.
 *
 *   heissUi.extensions.character = {
 *     head: ["masterpiece", "best quality", "score_7"],   // written first, as is (optional)
 *     safety: { general: "safe", sensitive: "sensitive" }  // the rating tag after the head (optional)
 *   }
 *
 * HEISS_CHARACTER_KNOWN_TAGS may name a JSON file `{ "tags": [...] }` of the
 * tags the model knows (in Danbooru form); the panel then marks the others.
 */

import fs from "node:fs";
import { comfy } from "./comfy.js";

const ID = "character";
/** Ratings offered; the node also has questionable and explicit, which are not requested. */
export const RATINGS = ["general", "sensitive"];
export const DEFAULT_RATING = "sensitive";
/** Tags that say how many people are drawn; a character mostly drawn without them is not a person. */
const PEOPLE = ["1girl", "1boy", "1other"];
const PERSON_PERCENT = 60;
const FIELD = /^[a-z_]{1,24}$/;
const MAX_TAG = 96, MAX_TAGS = 40, MAX_FIELDS = 20, MAX_QUERY = 80, MAX_COUNT = 9;
const GET_OPS = new Set(["meta", "autocomplete", "character"]);
const POST_OPS = new Set(["suggest", "random", "check"]);

const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const shortTag = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f,]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);

/** `heissUi.extensions.character` → `{ head, safety }`. */
export function characterConfig(config) {
  if (config === true) config = {};
  if (!plain(config)) return null;
  const head = (Array.isArray(config.head) ? config.head : []).map(shortTag).filter(Boolean).slice(0, 8);
  const safety = {};
  for (const rating of RATINGS) safety[rating] = config.safety?.[rating] === "" ? "" : shortTag(config.safety?.[rating] ?? (rating === "general" ? "safe" : "sensitive"));
  return { head, safety };
}

/** The Danbooru form: lower case, underscores, no prompt escapes or weights. */
export function danbooru(tag) {
  let text = String(tag ?? "").trim();
  const weighted = /^\((.+):\s*-?\d*\.?\d+\)$/.exec(text);
  if (weighted) text = weighted[1];
  return text.replace(/\\([()])/g, "$1").trim().toLowerCase().replace(/\s+/g, "_");
}

/** The known tags as a Set, or null without a list (then nothing is marked). */
export function loadKnown(file = process.env.HEISS_CHARACTER_KNOWN_TAGS) {
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(String(file), "utf8"));
    return Array.isArray(data?.tags) ? new Set(data.tags.map(String)) : null;
  } catch {
    return null;
  }
}

function cleanTag(value) {
  if (typeof value !== "string") throw fail("Tags must be text.");
  const tag = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (tag.length > MAX_TAG) throw fail("A tag is too long.");
  return tag;
}
function cleanField(value) {
  if (typeof value !== "string" || !FIELD.test(value)) throw fail("Unknown field.");
  return value;
}
function cleanTags(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_TAGS) throw fail("A field holds too many tags.");
  return value.map(cleanTag).filter(Boolean);
}
/** `{ field: [tags] }` with known-looking field names only. */
export function cleanContext(value) {
  if (value == null) return {};
  if (!plain(value)) throw fail("The fields must be an object.");
  const entries = Object.entries(value);
  if (entries.length > MAX_FIELDS) throw fail("Too many fields.");
  return Object.fromEntries(entries.map(([field, tags]) => [cleanField(field), cleanTags(tags)]));
}
const cleanRating = (value) => (RATINGS.includes(value) ? value : DEFAULT_RATING);
const cleanLimit = (value, fallback, top) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Math.min(top, Number(value)) : fallback);

/** What to ask the node for one panel operation: `{ method, path, query, body }`. Throws a 400 or 404. */
export function characterRequest(operation, input = {}) {
  if (!GET_OPS.has(operation) && !POST_OPS.has(operation)) throw fail("Unknown Character operation.", 404);
  if (!plain(input)) throw fail("The request must be an object.");
  switch (operation) {
    case "meta": return { method: "GET", path: "meta" };
    case "autocomplete": {
      const limit = cleanLimit(input.limit, 12, 24);
      // Ask for more, so known tags can be listed first without losing the best matches.
      return { method: "GET", path: "autocomplete", query: { field: cleanField(String(input.field ?? "")), q: String(input.q ?? "").slice(0, MAX_QUERY), limit: String(Math.min(50, limit * 2)) }, limit };
    }
    case "character": {
      const name = cleanTag(String(input.name ?? ""));
      if (!name) throw fail("Pick a character first.");
      return { method: "GET", path: "character", query: { name } };
    }
    case "suggest":
      return { method: "POST", path: "suggest", body: { field: cleanField(input.field), context: cleanContext(input.context), limit: cleanLimit(input.limit, 14, 30), rating: cleanRating(input.rating) } };
    case "random": {
      if (!Array.isArray(input.fields) || !input.fields.length || input.fields.length > MAX_FIELDS) throw fail("Choose the fields to roll.");
      const counts = {};
      for (const [field, n] of Object.entries(plain(input.counts) ? input.counts : {})) {
        if (Number.isInteger(n)) counts[cleanField(field)] = Math.max(0, Math.min(MAX_COUNT, n));
      }
      return { method: "POST", path: "random", body: { fields: input.fields.map(cleanField), counts, context: cleanContext(input.context), rating: cleanRating(input.rating) } };
    }
  }
  throw fail("Unknown Character operation.", 404);
}

const isKnown = (known, tag) => (known ? known.has(danbooru(tag)) : null);
const unknownOf = (known, fields) => (known ? [...new Set(Object.values(fields || {}).flat().filter((tag) => !known.has(danbooru(tag))))] : []);

/** The node's answer with `known` flags; for a usual look also the unknown tags and whether it is a person. */
export function annotate(operation, data, { known = null, limit, subject = null } = {}) {
  if (operation === "meta") return { fields: Array.isArray(data?.fields) ? data.fields : [], ratings: RATINGS, marksKnown: Boolean(known) };
  if (operation === "autocomplete" || operation === "suggest") {
    const items = (Array.isArray(data) ? data : []).map((item) => ({ ...item, known: isKnown(known, item.tag) }));
    if (operation === "suggest") return items;
    // Stable: the node's ranking holds within the known and the unknown group.
    return items.map((item, i) => [item, i]).sort((a, b) => (a[0].known === false) - (b[0].known === false) || a[1] - b[1]).map(([item]) => item).slice(0, limit || items.length);
  }
  if (operation === "character") {
    const percent = Object.fromEntries((Array.isArray(subject) ? subject : []).map((item) => [item.tag, parseInt(item.hint, 10) || 0]));
    const people = Math.max(0, ...PEOPLE.map((tag) => percent[tag] || 0));
    return { ...data, person: subject ? people >= PERSON_PERCENT : null, personPercent: subject ? people : null, unknown: unknownOf(known, data?.fields) };
  }
  if (operation === "random") return { ...data, unknown: unknownOf(known, data?.fields) };
  return data;
}

/** `{ unknown, marksKnown }` for up to 400 tags; without a list nothing is unknown. */
export function checkTags(input, known) {
  const tags = input?.tags;
  if (!Array.isArray(tags) || tags.length > 400) throw fail("Send up to 400 tags.");
  const clean = tags.map(cleanTag).filter(Boolean);
  return { unknown: known ? [...new Set(clean.filter((tag) => !known.has(danbooru(tag))))] : [], marksKnown: Boolean(known) };
}

/** Answers one panel operation; `request` is ComfyUI's (a test passes its own). */
export async function characterAnswer(operation, input, { request = comfy, known = null } = {}) {
  if (operation === "check") return checkTags(input, known);
  const ask = characterRequest(operation, input);
  const call = (item) => {
    const query = item.query ? `?${new URLSearchParams(item.query)}` : "";
    return request(`/character_helper/${item.path}${query}`, item.method === "POST"
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(item.body), timeout: 20_000 }
      : { timeout: 20_000 });
  };
  let data;
  try {
    data = await call(ask);
  } catch (error) {
    // The node's own 404 (a character without pictures) carries its JSON error; a missing route does not.
    if (operation === "character" && error.status === 404 && /"error"/.test(String(error.raw || ""))) throw fail("There is no usual look for this character.", 404);
    if (error.status === 404 || error.status === 405) throw Object.assign(fail("Restart ComfyUI to load the Character Helper node.", 503), { restart: true });
    if (error.status) throw fail(error.message, error.status >= 500 ? 502 : 400);
    throw fail(error.name === "TimeoutError" ? "ComfyUI is busy; try again in a moment." : "ComfyUI isn't reachable, so the tags can't be looked up.", 503);
  }
  if (data == null || data instanceof ArrayBuffer) throw fail("ComfyUI sent an answer the panel can't read.", 502);
  let subject = null;
  if (operation === "character") {
    // The character's own subject tags with percentages tell a person from a creature or object.
    const check = await call({ method: "POST", path: "suggest", body: { field: "subject", context: { character: [data.character] }, limit: 12, rating: DEFAULT_RATING } }).catch(() => null);
    if (Array.isArray(check)) subject = check.filter((item) => /%$/.test(String(item.hint || "")));
  }
  return annotate(operation, data, { known, limit: ask.limit, subject });
}

export const characterHelper = {
  id: ID,
  workflow: characterConfig,
  profile(profile, { config }) {
    profile.character = config;
  },
  routes(app) {
    let known;
    const knownTags = () => (known === undefined ? (known = loadKnown()) : known);
    const handle = async (operation, input, res) => {
      res.set("Cache-Control", "no-store");
      try {
        res.json(await characterAnswer(operation, input, { known: knownTags() }));
      } catch (error) {
        res.status(error.status || 400).json({ error: error.message, ...(error.restart ? { restart: true } : {}) });
      }
    };
    app.get("/api/character-helper/:operation", (req, res) => {
      if (POST_OPS.has(req.params.operation)) return res.status(405).json({ error: "Use POST for this." });
      void handle(req.params.operation, req.query || {}, res);
    });
    app.post("/api/character-helper/:operation", (req, res) => {
      if (GET_OPS.has(req.params.operation)) return res.status(405).json({ error: "Use GET for this." });
      void handle(req.params.operation, req.body || {}, res);
    });
  }
};
