import assert from "node:assert/strict";
import test from "node:test";
import { STARTERS, adaptState, alignRect, allCells, carryColours, dragRect, findLayout, fitRect, gridRect, inferSourceSize, issueFromError, keepLocked, layoutInfo, layoutPayload, mingPayload, normalizeLayout, ocrLines, payloadFor, pixelRect, placementRects, pngTexts, promptFormat, regionsToGrid, snapLines, starterState, stateFromImport, stateFromMing, toIdeogram } from "../src/app/layoutModel.js";

const size = { width: 1000, height: 500 };
const box = (id, x, y, w, h, extra = {}) => ({ id, kind: "object", x, y, w, h, text: "", description: "", relation: "", colors: [], tags: [], ...extra });
const ming = JSON.stringify({ canvas_settings: { aspect_ratio: "3:4", ambient_lighting: "soft daylight", image_style: "flat editorial poster" }, layers: [
  { description: "A cream paper background.", coordinates: "cx: 0.500, cy: 0.500, w: 1.000, h: 1.000", hierarchy_and_relation: "Background.", color_specs: ["#F4EBDD"] },
  { description: 'A text element reading exactly "HELLO" in bold red type.', coordinates: "cx: 0.500, cy: 0.100, w: 0.800, h: 0.100", hierarchy_and_relation: "Title above everything.", color_specs: [] }
] });
const compiled = JSON.stringify({ summary: { caption: "a park" }, bbox_coord_space: "abs_centralized", bbox_format: "yxyx", items: [{ label: "text", bbox: [-100, -200, 100, 200] }] });

test("the node gets only its fields, front first, without locks", () => {
  const state = { caption: "a park", meta: ["poster", "illustration"], canvas: "single", palette: ["#112233"], style: "", lighting: "", regions: [box("a", 0, 0, 0.5, 0.5, { locked: true, description: "a dog", relation: "in front" })] };
  const payload = layoutPayload(state, size);
  assert.equal(payload.meta, "poster, illustration");
  assert.equal(payload.width, 1000);
  const regions = JSON.parse(payload.layers_data).regions;
  assert.deepEqual(Object.keys(regions[0]).sort(), ["colors", "description", "h", "id", "kind", "relation", "tags", "text", "w", "x", "y"]);
  assert.equal(regions[0].relation, "in front", "the relation is sent");
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
  assert.deepEqual(layoutInfo(compiled), { format: "moss", items: 1, text: 1, caption: "a park" });
  assert.deepEqual(layoutInfo(ming), { format: "ming", items: 2, text: 1, caption: "flat editorial poster" });
  assert.equal(findLayout({ 7: { inputs: { text: ming } } }), ming, "a Ming prompt is found in a graph");
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
  assert.deepEqual(issueFromError("Region 1.description must be a non-empty string.", { format: "ming", count: 4 }), { number: 4, need: "caption", text: "Box 04 needs a caption" }, "Ming counts from the front");
  assert.equal(issueFromError("Region 2.text must be a non-empty string.", { format: "ming", count: 2 }).need, "text");
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

test("formats are told apart", () => {
  assert.equal(promptFormat(compiled), "moss");
  assert.equal(promptFormat(ming), "ming");
  assert.equal(promptFormat(JSON.stringify({ high_level_description: "x", compositional_deconstruction: { elements: [] } })), "ideogram");
  assert.equal(promptFormat(JSON.stringify({ grid: "xyxy-1000", items: [] })), "assistant");
  assert.equal(promptFormat("{ not json"), null);
  assert.equal(promptFormat("a cat"), null);
});

test("Ming: characters go as objects, the style and lighting go along, and text keeps its wording", () => {
  const state = { caption: "", meta: [], canvas: "single", palette: [], style: "flat poster", lighting: "soft", regions: [
    box("t", 0.1, 0.1, 0.8, 0.1, { kind: "text", text: "HELLO", description: "bold red type", raw_description: 'A text element reading exactly "HELLO" in bold red type.' }),
    box("c", 0.2, 0.2, 0.5, 0.7, { kind: "character", description: "a knight", tags: ["armour"] }),
    box("o", 0, 0, 1, 1, { tags: ["sky", "clouds"], locked: true })
  ] };
  const payload = mingPayload(state, { width: 864, height: 1152 });
  assert.equal(payload.image_style, "flat poster");
  assert.equal(payload.ambient_lighting, "soft");
  assert.equal("summary_caption" in payload, false);
  const regions = JSON.parse(payload.layers_data).regions;
  assert.deepEqual(regions.map((r) => r.kind), ["text", "object", "object"]);
  assert.equal(regions[2].description, "sky, clouds", "tags stand in for an empty caption");
  assert.equal(JSON.parse(mingPayload({ ...state, regions: [box("t", 0, 0, 1, 1, { kind: "text", text: "A", description: "Large title" }), box("u", 0, 0, 1, 1, { kind: "text", text: "B", description: "UI label" })] }, { width: 864, height: 1152 }).layers_data).regions.map((r) => r.description).join("|"), "large title|UI label", "a text look reads on after \"… in\"");
  assert.equal(regions[0].raw_description.startsWith("A text element"), true);
  assert.equal("raw_description" in regions[1], false);
  assert.equal("locked" in regions[2], false, "locks stay in the editor");
  assert.equal(payloadFor("ming", state, { width: 864, height: 1152 }).format, "ming");
  assert.equal("format" in payloadFor("moss", state, { width: 864, height: 1152 }), false);
  const back = stateFromMing({ image_style: "s", ambient_lighting: "l", regions: [{ id: "layer_2", kind: "text", text: "HI", description: "red", relation: "top", colors: ["#FF0000"], x: 0, y: 0, w: 1, h: 0.1 }] });
  assert.equal(back.style, "s");
  assert.equal(back.regions[0].relation, "top");
  assert.notEqual(back.regions[0].id, "layer_2");
});

test("converting fills only what the other format left empty", () => {
  const moss = { caption: "A quiet lake at dawn", meta: ["poster"], canvas: "single", palette: [], style: "", lighting: "", regions: [box("a", 0, 0, 1, 1, { colors: ["#112233"] })] };
  assert.equal(adaptState(moss, "ming").style, "poster. A quiet lake at dawn.");
  assert.equal(adaptState({ ...moss, regions: [box("c", 0, 0, 1, 1, { kind: "character" })] }, "ming").regions[0].kind, "object", "Ming has no characters");
  const fromMing = adaptState({ ...moss, caption: "", meta: [], style: "Flat poster", lighting: "soft dawn light." }, "moss");
  assert.equal(fromMing.caption, "Flat poster. soft dawn light.");
  assert.deepEqual(fromMing.palette, ["#112233"], "the boxes' colours become the palette");
  assert.equal(adaptState({ ...moss, style: "kept" }, "ming").style, "kept");
  assert.equal(adaptState({ ...moss, caption: "", meta: [] }, "ming").style, "", "nothing to fill from stays empty");
});

test("Ideogram export: front first, yxyx on 0-1000, characters as objects", () => {
  const doc = toIdeogram({ caption: "A park", meta: ["poster"], palette: ["#ff0000", "bad"], style: "", lighting: "", canvas: "single", regions: [
    box("t", 0.5, 0.1, 0.25, 0.2, { kind: "text", text: "HI", description: "red type" }), box("c", 0, 0, 1, 1, { kind: "character", description: "a girl" })] });
  assert.equal(doc.high_level_description, "A park");
  assert.deepEqual(doc.style_description, { aesthetics: "poster", color_palette: ["#FF0000"] });
  assert.deepEqual(doc.compositional_deconstruction.elements[0], { type: "text", bbox: [100, 500, 300, 750], text: "HI", desc: "red type" });
  assert.equal(doc.compositional_deconstruction.elements[1].type, "obj");
  assert.equal(promptFormat(JSON.stringify(doc)), "ideogram", "the export reads back as Ideogram");
  assert.equal(toIdeogram({ caption: "", meta: [], palette: [], style: "Ink", lighting: "Moonlight", regions: [] }).style_description.lighting, "Moonlight");
});

test("placement, alignment, pixel fields and the reference fits", () => {
  const rects = placementRects(2, 1, allCells(2, 1), { width: 1000, height: 500 }, true);
  assert.equal(rects.length, 2);
  assert.ok(Math.abs(rects[0].x - 0.016) < 1e-9 && Math.abs(rects[1].x + rects[1].w - 0.984) < 1e-9, "gutters around and between");
  assert.deepEqual(placementRects(1, 1, [[0, 0]], size), [{ x: 0, y: 0, w: 1, h: 1 }]);
  assert.deepEqual(allCells(2, 2), [[0, 0], [1, 0], [0, 1], [1, 1]]);
  assert.deepEqual(alignRect({ x: 0.1, y: 0.1, w: 0.5, h: 0.2 }, "right"), { x: 0.5, y: 0.1, w: 0.5, h: 0.2 });
  assert.equal(alignRect({ x: 0.1, y: 0.1, w: 0.5, h: 0.2 }, "vcenter").y, 0.4);
  assert.deepEqual(pixelRect({ x: 0, y: 0, w: 0.1, h: 0.1 }, { x: 990, w: 50 }, size), { x: 0.95, y: 0, w: 0.05, h: 0.1 }, "kept inside the canvas");
  assert.deepEqual(fitRect({ width: 500, height: 500 }, "fill", { width: 100, height: 50 }), { x: 0, y: 0, w: 100, h: 50 });
  assert.deepEqual(fitRect({ width: 500, height: 250 }, "actual", { width: 100, height: 50 }, size), { x: 25, y: 12.5, w: 50, h: 25 }, "1:1 keeps pixels on canvas pixels");
});

test("Shift keeps a move on one axis and a resize in proportion; guides snap", () => {
  const start = { x: 0.1, y: 0.1, w: 0.2, h: 0.4 };
  const moved = dragRect({ mode: "move", start, origin: { x: 0.2, y: 0.2 }, point: { x: 0.5, y: 0.25 }, size, shift: true }).rect;
  assert.equal(moved.y, 0.1, "the smaller move is dropped");
  const resized = dragRect({ mode: "se", start, origin: { x: 0.3, y: 0.5 }, point: { x: 0.4, y: 0.5 }, size, shift: true }).rect;
  assert.ok(Math.abs((resized.w * size.width) / (resized.h * size.height) - 1) < 1e-9, "the box keeps its 1:1 pixel shape");
  const square = dragRect({ mode: "draw", start: { x: 0.5, y: 0.5, w: 0, h: 0 }, origin: { x: 0.5, y: 0.5 }, point: { x: 0.7, y: 0.9 }, size, shift: true }).rect;
  assert.ok(Math.abs(square.w * size.width - square.h * size.height) < 1e-6, "Shift draws a square");
  const around = dragRect({ mode: "e", start, origin: { x: 0.3, y: 0.3 }, point: { x: 0.35, y: 0.3 }, size, centred: true }).rect;
  assert.ok(Math.abs(around.x + around.w / 2 - 0.2) < 1e-9, "Ctrl resizes about the centre");
  assert.ok(snapLines([], "a", "golden").x.some((v) => Math.abs(v - 0.618) < 0.001));
  assert.ok(snapLines([], "a", true).x.includes(1 / 3), "true still means the thirds");
});
