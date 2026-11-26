// The Character panel's prompt (characterHelper.tsx): Danbooru tags in the
// order tag-trained models expect, written as such prompts are typed. Plain
// JavaScript so `node --test` can check it without a build step; the types
// live beside it in tagPrompt.d.ts.

const KEEP_UNDERSCORE = /^.{1,4}$|^[^a-z0-9]+_[^a-z0-9]+$/;

/** aqua_hair → aqua hair; ganyu_(genshin_impact) → ganyu \(genshin impact\); emoticons and weights kept. */
export function formatTag(tag) {
  const text = String(tag).trim();
  const weighted = /^\((.+):(\s*-?\d*\.?\d+)\)$/.exec(text);
  if (weighted) return `(${formatTag(weighted[1])}:${weighted[2]})`;
  const spaced = KEEP_UNDERSCORE.test(text) ? text : text.replace(/_/g, " ");
  return spaced.replace(/(?<!\\)([()])/g, "\\$1");
}

/** One tag's identity, however it was typed: "Aqua Hair", "aqua_hair" and "aqua hair" are one tag. */
export const tagKey = (tag) => String(tag).trim().toLowerCase().replace(/\\([()])/g, "$1").replace(/\s+/g, "_");

/** A character tag as a name: "fern_(sousou_no_frieren)" → "Fern (sousou no frieren)". */
export const displayName = (tag) => String(tag).replace(/_/g, " ").replace(/^[^(]+/, (base) => base.replace(/(^|[\s/-])([a-z])/g, (_, gap, letter) => gap + letter.toUpperCase()));

/**
 * The prompt for the panel's fields: the workflow's head (as written), the
 * rating's safety tag, then subject (the count) first and the other fields in
 * order, each tag once. Empty when no field has a tag.
 */
export function composeTagPrompt(fields, { head = [], safety = "", order = Object.keys(fields || {}) } = {}) {
  const names = ["subject", ...order.filter((id) => id !== "subject")];
  const body = names.flatMap((id) => fields?.[id] || []);
  if (!body.length) return "";
  const seen = new Set();
  const out = [];
  const push = (tag, raw) => {
    const id = tagKey(tag);
    if (id && !seen.has(id)) { seen.add(id); out.push(raw ? String(tag).trim() : formatTag(tag)); }
  };
  for (const tag of [...head, safety].filter(Boolean)) push(tag, true);
  for (const tag of body) push(tag, false);
  return out.join(", ");
}
