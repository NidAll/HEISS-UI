import assert from "node:assert/strict";
import test from "node:test";
import { composeTagPrompt, displayName, formatTag, tagKey } from "../src/app/tagPrompt.js";

test("the prompt: head, safety, count first, then formatted tags once each", () => {
  const fields = { character: ["fern_(sousou_no_frieren)", "sousou_no_frieren"], subject: ["1girl", "solo"], hair: ["purple_hair", "long_hair"], eyes: ["purple_eyes"], expression: ["^_^", "smile"], pose: ["(looking_at_viewer:1.2)"], view: [], background: ["Simple Background", "simple_background"] };
  const order = ["character", "subject", "hair", "eyes", "expression", "pose", "view", "background"];
  const head = ["masterpiece", "best quality", "score_7"];
  assert.equal(composeTagPrompt(fields, { head, safety: "sensitive", order }),
    "masterpiece, best quality, score_7, sensitive, 1girl, solo, fern \\(sousou no frieren\\), sousou no frieren, purple hair, long hair, purple eyes, ^_^, smile, (looking at viewer:1.2), Simple Background");
  assert.match(composeTagPrompt(fields, { safety: "safe", order }), /^safe, 1girl, solo, fern/, "no head when the workflow names none");
  assert.equal(composeTagPrompt({ hair: [] }, { head }), "", "nothing to say without tags");
});

test("tags are written as typed prompts write them, and compare however typed", () => {
  assert.equal(formatTag("ganyu_(genshin_impact)"), "ganyu \\(genshin impact\\)");
  assert.equal(formatTag("already \\(escaped\\)"), "already \\(escaped\\)");
  assert.equal(formatTag(">_<"), ">_<");
  assert.equal(tagKey("Aqua Hair"), tagKey("aqua_hair"));
  assert.equal(displayName("fern_(sousou_no_frieren)"), "Fern (sousou no frieren)");
  assert.equal(displayName("k/da_ahri"), "K/Da Ahri");
});
