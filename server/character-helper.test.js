import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { annotate, characterAnswer, characterConfig, characterRequest, checkTags, danbooru, loadKnown } from "./character-helper.js";

const known = new Set(["frieren", "sousou_no_frieren", "1girl", "solo", "elf", "pointy_ears", "white_hair", "fern_(sousou_no_frieren)"]);
const comfyError = (status, raw) => Object.assign(new Error(`Comfy ${status}`), { status, raw });

test("the config keeps a short head and the rating tags", () => {
  assert.deepEqual(characterConfig({ head: ["masterpiece", " best quality ", "a, b", ""] }), { head: ["masterpiece", "best quality", "a b"], safety: { general: "safe", sensitive: "sensitive" } });
  assert.deepEqual(characterConfig({ safety: { general: "", sensitive: "nsfw" } }).safety, { general: "", sensitive: "nsfw" });
  assert.deepEqual(characterConfig(true).head, []);
  assert.equal(characterConfig("yes"), null);
});

test("requests forward only the node's fields, capped, with two ratings", () => {
  assert.deepEqual(characterRequest("meta"), { method: "GET", path: "meta" });
  const auto = characterRequest("autocomplete", { field: "hair", q: "x".repeat(200), limit: "12", extra: 1 });
  assert.equal(auto.query.q.length, 80);
  assert.equal(auto.query.limit, "24");
  assert.throws(() => characterRequest("autocomplete", { field: "../meta", q: "a" }), /Unknown field/);
  assert.deepEqual(characterRequest("suggest", { field: "eyes", context: { hair: ["aqua_hair"] }, rating: "explicit", limit: 99 }).body, { field: "eyes", context: { hair: ["aqua_hair"] }, limit: 30, rating: "sensitive" });
  assert.deepEqual(characterRequest("random", { fields: ["hair", "pose"], counts: { hair: 40, pose: 2, bad: "x" }, rating: "general" }).body, { fields: ["hair", "pose"], counts: { hair: 9, pose: 2 }, context: {}, rating: "general" });
  assert.throws(() => characterRequest("random", { fields: [] }), /Choose/);
  assert.throws(() => characterRequest("suggest", { field: "hair", context: { hair: Array(41).fill("a") } }), /too many/);
  assert.throws(() => characterRequest("suggest", { field: "hair", context: { hair: ["x".repeat(97)] } }), /too long/);
  assert.throws(() => characterRequest("character", { name: "" }), /Pick a character/);
  assert.throws(() => characterRequest("delete", {}), (error) => error.status === 404);
});

test("answers are marked: known first, person check, unknown tags", () => {
  assert.equal(danbooru("Fern \\(sousou no frieren\\)"), "fern_(sousou_no_frieren)");
  assert.equal(danbooru("(white hair:1.2)"), "white_hair");
  const items = annotate("autocomplete", [{ tag: "frieren_x" }, { tag: "frieren" }, { tag: "fern_(sousou_no_frieren)" }], { known, limit: 2 });
  assert.deepEqual(items.map((item) => [item.tag, item.known]), [["frieren", true], ["fern_(sousou_no_frieren)", true]]);
  assert.equal(annotate("suggest", [{ tag: "x" }])[0].known, null, "without a list nothing is marked");
  const preset = { character: "kirby", fields: { character: ["kirby", "kirby_(series)"], subject: ["1girl"], hair: ["long_hair"] } };
  const creature = annotate("character", preset, { known, subject: [{ tag: "1girl", hint: "59%" }] });
  assert.equal(creature.person, false);
  assert.deepEqual(creature.unknown, ["kirby", "kirby_(series)", "long_hair"]);
  assert.deepEqual(annotate("meta", { fields: [{ id: "hair" }], ratings: ["general", "explicit"] }, { known }).ratings, ["general", "sensitive"]);
  assert.deepEqual(checkTags({ tags: ["Frieren", "elf", "made up tag"] }, known), { unknown: ["made up tag"], marksKnown: true });
  assert.throws(() => checkTags({ tags: Array(401).fill("a") }, known), /400/);
});

test("answers come from the node, and say what is wrong when they can't", async () => {
  const calls = [];
  const replies = [
    [{ tag: "frieren", count: 15248, kind: "character" }, { tag: "frieren_(cosplay)", count: 50, kind: "character" }],
    { character: "frieren", fields: { character: ["frieren"], subject: ["1girl", "solo"], body: ["elf"] } },
    [{ tag: "1girl", hint: "100%" }, { tag: "2girls" }],
    comfyError(404, 'Comfy 404: {"error": "unknown character"}'),
    comfyError(404, "Comfy 404: Not Found"),
    Object.assign(new Error("timed out"), { name: "TimeoutError" })
  ];
  const request = async (url, options) => {
    calls.push([url, options.method || "GET", options.body && JSON.parse(options.body)]);
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  assert.deepEqual(await characterAnswer("autocomplete", { field: "character", q: "frier", limit: "1" }, { request, known }), [{ tag: "frieren", count: 15248, kind: "character", known: true }]);
  assert.equal(calls[0][0], "/character_helper/autocomplete?field=character&q=frier&limit=2");
  const look = await characterAnswer("character", { name: "frieren" }, { request, known });
  assert.equal(look.person, true);
  assert.deepEqual(calls[2], ["/character_helper/suggest", "POST", { field: "subject", context: { character: ["frieren"] }, limit: 12, rating: "sensitive" }]);
  await assert.rejects(characterAnswer("character", { name: "nobody" }, { request }), (error) => error.status === 404 && /no usual look/.test(error.message));
  await assert.rejects(characterAnswer("meta", {}, { request }), (error) => error.status === 503 && error.restart === true);
  await assert.rejects(characterAnswer("meta", {}, { request }), /busy/);
  assert.deepEqual(await characterAnswer("check", { tags: ["frieren", "zzz"] }, { request, known }), { unknown: ["zzz"], marksKnown: true });
});

test("the known-tags list loads from the named file, or is absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-tags-"));
  const file = path.join(dir, "tags.json");
  fs.writeFileSync(file, JSON.stringify({ tags: ["aqua_hair"] }));
  assert.ok(loadKnown(file).has("aqua_hair"));
  assert.equal(loadKnown(path.join(dir, "missing.json")), null);
  assert.equal(loadKnown(""), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
