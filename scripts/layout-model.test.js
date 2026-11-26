import assert from "node:assert/strict";
import test from "node:test";
import { STARTERS, carryColours, dragRect, findLayout, gridRect, inferSourceSize, issueFromError, keepLocked, layoutInfo, layoutPayload, normalizeLayout, ocrLines, pngTexts, regionsToGrid, snapLines, starterState, stateFromImport } from "../src/app/layoutModel.js";

const size = { width: 1000, height: 500 };
const box = (id, x, y, w, h, extra = {}) => ({ id, kind: "object", x, y, w, h, text: "", description: "", colors: [], tags: [], ...extra });
const compiled = JSON.stringify({ summary: { caption: "a park" }, bbox_coord_space: "abs_centralized", bbox_format: "yxyx", items: [{ label: "text", bbox: [-100, -200, 100, 200] }] });

test("the node gets only its fields, front first, without locks", () => {
  const state = { caption: "a park", meta: ["poster", "illustration"], canvas: "single", palette: ["#112233"], regions: [box("a", 0, 0, 0.5, 0.5, { locked: true, description: "a dog" })] };
  const payload = layoutPayload(state, size);
  assert.equal(payload.meta, "poster, illustration");
  assert.equal(payload.width, 1000);
  const regions = JSON.parse(payload.layers_data).regions;
  assert.deepEqual(Object.keys(regions[0]).sort(), ["colors", "description", "h", "id", "kind", "relation", "tags", "text", "w", "x", "y"]);
  const back = stateFromImport({ summary_caption: "x", meta: "a, b", regions: [{ id: "layer_1", kind: "text", x: 0, y: 0, w: 1, h: 1 }] });
  assert.deepEqual(back.meta, ["a", "b"]);
  assert.notEqual(back.regions[0].id, "layer_1", "imported boxes get fresh ids");
  assert.equal(back.regions[0].text, "");
});

test("starters come back to front so the first item is the backmost box", () => {
  const state = starterState(STARTERS[2]);
  assert.equal(state.regions.at(-1).description.startsWith("A misty pine forest"), true);
  assert.equal(starterState(STARTERS[0], "my own words").caption, "my own words");
});

test("a layout is found in a prompt, a graph or a saved file", () => {
  assert.deepEqual(layoutInfo(compiled), { items: 1, text: 1 });
  assert.equal(layoutInfo("a cat"), null);
  const graph = { 4: { inputs: { text: compiled } } };
  assert.equal(findLayout(JSON.stringify(graph)), compiled);
  assert.match(findLayout({ answer: { grid: "xyxy-1000", items: [] } }), /xyxy-1000/);
  assert.equal(findLayout({ prompt: "plain words" }), null);
});

test("sizes: a layout made bigger is scaled, and editor extras are dropped", () => {
  assert.equal(inferSourceSize(compiled, { width: 1024, height: 1024 }), null, "it fits");
  assert.deepEqual(inferSourceSize(compiled, { width: 200, height: 200 }), { width: 400, height: 400 });
  const extra = JSON.stringify({ ...JSON.parse(compiled), width: 900, height: 700, items: [{ label: "text", bbox: [0, 0, 1, 1], locked: true, color: "#fff" }] });
  const normal = normalizeLayout(extra);
  assert.deepEqual(normal.size, { width: 912, height: 704 });
  assert.deepEqual(normal.locks, [true]);
  assert.equal("locked" in JSON.parse(normal.text).items[0], false);
});

test("the AI grid round-trips boxes and keeps locked ones", () => {
  const regions = [box("front", 0.5, 0.5, 0.25, 0.25, { kind: "text", text: " HI " }), box("back", 0, 0, 1, 1, { description: "sky" })];
  const grid = regionsToGrid(regions);
  assert.deepEqual(grid[0], { label: "object", caption: "sky", bbox: [0, 0, 1000, 1000] }, "back first");
  assert.equal(grid[1].text, "HI");
  assert.deepEqual(gridRect([500, 500, 750, 750]), { x: 0.5, y: 0.5, w: 0.25, h: 0.25 });
  const locked = box("lock", 0, 0, 0.5, 0.5, { locked: true });
  const next = [box("n1", 0.02, 0, 0.5, 0.5), box("n2", 0.6, 0.6, 0.3, 0.3)];
  assert.deepEqual(keepLocked([locked], next).map((r) => r.id), ["lock", "n2"], "the lock takes the place of the box it overlaps");
  assert.deepEqual(keepLocked([box("far", 0.9, 0.9, 0.05, 0.05, { locked: true })], next).map((r) => r.id), ["far", "n1", "n2"]);
  assert.deepEqual(carryColours([box("o", 0, 0, 0.5, 0.5, { colors: ["#ff0000"] })], next)[0].colors, ["#ff0000"]);
});

test("lettering joins into lines and errors read as box fixes", () => {
  const words = [{ label: "WORLD", bbox: [300, 100, 500, 150] }, { label: "HELLO", bbox: [100, 100, 280, 150] }, { label: "below", bbox: [100, 600, 200, 650] }];
  assert.deepEqual(ocrLines(words, size).map((line) => line.text), ["HELLO WORLD", "below"]);
  assert.deepEqual(issueFromError("Region 3: write a caption."), { number: 3, need: "caption", text: "Box 03 needs a caption" });
  assert.equal(issueFromError("Something else").number, null);
});

test("drags move, resize and draw inside the canvas, and snap to edges", () => {
  const start = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  assert.deepEqual(dragRect({ mode: "move", start, origin: { x: 0.2, y: 0.2 }, point: { x: 1, y: 0.2 }, size }).rect, { x: 0.8, y: 0.1, w: 0.2, h: 0.2 }, "a move stops at the edge");
  const drawn = dragRect({ mode: "draw", start: { x: 0.5, y: 0.5, w: 0, h: 0 }, origin: { x: 0.5, y: 0.5 }, point: { x: 0.3, y: 0.7 }, size }).rect;
  assert.deepEqual([drawn.x, drawn.y].map((v) => v.toFixed(6)), ["0.300000", "0.500000"]);
  assert.ok(Math.abs(drawn.w - 0.2) < 1e-9 && Math.abs(drawn.h - 0.2) < 1e-9, "drawing up-left of the start still makes a box");
  const resized = dragRect({ mode: "e", start, origin: { x: 0.3, y: 0.2 }, point: { x: 0.497, y: 0.9 }, size, lines: snapLines([], "a"), board: { width: 1000, height: 500 } });
  assert.equal(resized.rect.x + resized.rect.w, 0.5, "the edge snaps to the centre line");
  assert.deepEqual(resized.guides, [{ axis: "x", at: 0.5 }]);
  assert.ok(Math.abs(resized.rect.h - 0.2) < 1e-9, "an east handle leaves the height alone");
});

test("a PNG's text chunks are read", async () => {
  const crc = () => Buffer.alloc(4);
  const chunk = (type, data) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); return Buffer.concat([length, Buffer.from(type), data, crc()]); };
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("tEXt", Buffer.from(`prompt\0${compiled}`)), chunk("IEND", Buffer.alloc(0))]);
  assert.deepEqual(await pngTexts(png), [compiled]);
  assert.deepEqual(await pngTexts(Buffer.from("nope")), []);
});
