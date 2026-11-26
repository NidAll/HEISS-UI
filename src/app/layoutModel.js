/*
 * Layout's pure parts (mossLayout.tsx draws them): the builder's state, what
 * the MOSS node is sent, how boxes move, snap and survive an AI rewrite.
 * Plain JS so scripts/layout-model.test.js can run them in Node.
 *
 * A region is one box: { id, kind, x, y, w, h, text, description, colors,
 * tags, locked? } with x/y/w/h as fractions of the canvas. Regions are kept
 * front first, as the node's import returns them; box numbers count from the
 * back, as the node's messages do ("Region 01" is the backmost).
 */

export const KINDS = [
  { value: 'object', label: 'Object' },
  { value: 'character', label: 'Character' },
  { value: 'text', label: 'Text' }
];
export const CANVASES = [
  { value: 'single', label: 'Single' },
  { value: 'multi_panel', label: 'Panels' },
  { value: 'collage', label: 'Collage' }
];
/** Common MOSS-Image summary.meta genres, offered while typing in Meta. */
export const META_SUGGESTIONS = [
  'poster', 'minimal graphic design', 'editorial layout', 'magazine cover', 'book cover', 'album art', 'typographic poster',
  'product campaign', 'studio photography', 'advertisement', 'packaging mockup', 'social media post',
  'infographic', 'diagram', 'ui mockup', 'map',
  'illustration', 'anime illustration', 'comic', 'four panels', 'manga', 'flat vector art', 'concept art',
  'cinematic still', 'portrait photography', 'street photography', 'landscape photography', 'fashion editorial'
];
/** One-box placements as fractions; "centre" is half the canvas area. */
export const PLACES = [
  { value: 'fill', label: 'Fill', rect: { x: 0, y: 0, w: 1, h: 1 } },
  { value: 'centre', label: 'Centre', rect: { x: (1 - Math.SQRT1_2) / 2, y: (1 - Math.SQRT1_2) / 2, w: Math.SQRT1_2, h: Math.SQRT1_2 } },
  { value: 'left', label: 'Left half', rect: { x: 0, y: 0, w: 0.5, h: 1 } },
  { value: 'right', label: 'Right half', rect: { x: 0.5, y: 0, w: 0.5, h: 1 } },
  { value: 'top', label: 'Top half', rect: { x: 0, y: 0, w: 1, h: 0.5 } },
  { value: 'bottom', label: 'Bottom half', rect: { x: 0, y: 0.5, w: 1, h: 0.5 } },
  { value: 'top-left', label: 'Top left', rect: { x: 0, y: 0, w: 0.5, h: 0.5 } },
  { value: 'top-right', label: 'Top right', rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 } },
  { value: 'bottom-left', label: 'Bottom left', rect: { x: 0, y: 0.5, w: 0.5, h: 0.5 } },
  { value: 'bottom-right', label: 'Bottom right', rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }
];

/** Starting layouts for an empty canvas: [kind, x, y, w, h, caption, words], back first. */
export const STARTERS = [
  { id: 'poster', name: 'Poster', hint: 'Title, hero illustration, footer line', canvas: 'single', meta: ['poster'],
    caption: 'A minimalist travel poster on a warm cream background, with a flat layered illustration, generous margins and confident modern typography.',
    items: [
      ['text', 0.12, 0.08, 0.76, 0.13, 'Large dark-blue uppercase title, centered, wide letter spacing, no backing panel.', 'EXPLORE'],
      ['object', 0.18, 0.27, 0.64, 0.56, 'A flat illustration of blue mountains with layered ridges, a pale sun and a winding trail.'],
      ['text', 0.28, 0.88, 0.44, 0.05, 'Small dark-blue sans-serif line, evenly spaced.', 'Summer trails 2026']
    ] },
  { id: 'product', name: 'Product hero', hint: 'Product left, headline and copy right', canvas: 'single', meta: ['product campaign', 'studio photography'],
    caption: 'A calm studio campaign photograph for a handmade ceramic cup, ivory backdrop, soft side light and restrained dark-green typography.',
    items: [
      ['object', 0.08, 0.2, 0.44, 0.66, 'An ivory ceramic cup with a rounded handle, fine speckled glaze and a soft contact shadow, at a three-quarter angle.'],
      ['text', 0.58, 0.28, 0.34, 0.14, 'Large dark-green serif headline in crisp, moderately heavy lettering.', 'Slow mornings'],
      ['text', 0.58, 0.48, 0.32, 0.1, 'Smaller dark-green supporting copy on two lines, comfortably legible.', 'Hand-thrown stoneware\nmade to be used daily']
    ] },
  { id: 'portrait', name: 'Character', hint: 'A figure in a setting, with a nameplate', canvas: 'single', meta: ['illustration'],
    caption: 'A cinematic fantasy illustration at dusk, painterly brushwork, warm rim light against a cool misty forest.',
    items: [
      ['object', 0, 0, 1, 1, 'A misty pine forest at dusk with shafts of amber light and drifting fog.'],
      ['character', 0.26, 0.14, 0.48, 0.82, 'A young knight in weathered silver armour holding a lantern, calm expression, full body, three-quarter view.'],
      ['text', 0.3, 0.06, 0.4, 0.06, 'Elegant engraved gold serif lettering.', 'THE LANTERN BEARER']
    ] },
  { id: 'panels', name: 'Four panels', hint: 'A 2 × 2 comic page', canvas: 'multi_panel', meta: ['comic', 'four panels'],
    caption: 'A four-panel comic page in clean ink lines and flat pastel colors about a cat discovering a cardboard box.',
    items: [
      ['object', 0.03, 0.03, 0.455, 0.455, 'Panel one: an orange cat stares at a large empty cardboard box in a sunny living room.'],
      ['object', 0.515, 0.03, 0.455, 0.455, 'Panel two: the cat cautiously sniffs the edge of the box, tail raised.'],
      ['object', 0.03, 0.515, 0.455, 0.455, 'Panel three: the cat leaps into the box mid-air, paws stretched forward.'],
      ['object', 0.515, 0.515, 0.455, 0.455, 'Panel four: only the cat\'s ears and eyes peek out of the box, looking delighted.']
    ] }
];

const GRID = 1000;
const MAX_SIDE = 16384;
export const SNAP_PX = 7;
export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
export const uid = () => `box_${Math.random().toString(36).slice(2, 10)}`;
export const splitList = (text) => String(text || '').split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
export const pad2 = (value) => String(value).padStart(2, '0');
const up16 = (value) => clamp(Math.ceil(value / 16) * 16, 16, MAX_SIDE);

export const emptyState = () => ({ caption: '', meta: [], canvas: 'single', palette: [], regions: [] });
export const newRegion = (kind, rect) => ({ id: uid(), kind, ...rect, text: '', description: '', colors: [], tags: [] });

/** The state a starter gives; a caption already written on an empty canvas is kept. */
export function starterState(starter, caption = '') {
  return {
    caption: caption.trim() || starter.caption, meta: [...starter.meta], canvas: starter.canvas, palette: [],
    regions: starter.items.map(([kind, x, y, w, h, description, text = '']) => ({ ...newRegion(kind, { x, y, w, h }), description, text })).reverse()
  };
}

/** What the node's serialize route reads. Locks are editor-only and never sent. */
export function layoutPayload(state, size, format = 'compact') {
  return {
    width: size.width, height: size.height, summary_caption: state.caption, meta: state.meta.join(', '), canvas: state.canvas,
    palette: state.palette.join(', '), output_format: format,
    layers_data: JSON.stringify({ version: 1, order: 'front_to_back', regions: state.regions.map(({ id, x, y, w, h, kind, text, description, colors, tags }) =>
      ({ id, x, y, w, h, kind, text: text || '', description: description || '', relation: '', colors: colors || [], tags: tags || [] })) })
  };
}

/** The node's import answer as builder state, with fresh ids. */
export function stateFromImport(imported) {
  return {
    caption: imported.summary_caption || '', meta: splitList(imported.meta), canvas: imported.canvas || 'single', palette: splitList(imported.palette),
    regions: (imported.regions || []).map((region) => ({ ...region, id: uid(), text: region.text || '', description: region.description || '', tags: region.tags || [], colors: region.colors || [] }))
  };
}

/** 'assistant' for a Layout assistant answer (xyxy on 0-1000), which the MOSS node converts; else null. */
export function foreignKind(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.grid === 'xyxy-1000' && Array.isArray(value.items)) return 'assistant';
  return null;
}

const isLayout = (value) => Boolean(value) && typeof value === 'object' && Array.isArray(value.items) && Boolean(value.summary) && Boolean(value.bbox_coord_space);

/** `{ items, text }` when the text is a compiled or draft MOSS layout; null otherwise. */
export function layoutInfo(text) {
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return null;
  try {
    const value = JSON.parse(text);
    if (!isLayout(value)) return null;
    return { items: value.items.length, text: value.items.filter((item) => item?.label === 'text').length };
  } catch { return null; }
}

/** The first MOSS layout inside a value: a layout string, or JSON that holds one (a ComfyUI graph, a saved file). */
export function findLayout(value, depth = 0) {
  if (value == null || depth > 8) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text.startsWith('{')) return null;
    if (layoutInfo(text)) return text;
    try { return findLayout(JSON.parse(text), depth + 1); } catch { return null; }
  }
  if (typeof value !== 'object') return null;
  if (!Array.isArray(value) && (isLayout(value) || foreignKind(value))) return JSON.stringify(value);
  for (const child of Object.values(value)) {
    const hit = findLayout(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * A compiled layout carries no size, so its centred pixel boxes are read on
 * the current canvas. When a box reaches past it (a layout made at another
 * size), this is the smallest same-shaped canvas that holds every box, so the
 * import scales it down instead of clipping it.
 */
export function inferSourceSize(text, size) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || !Array.isArray(doc.items) || !doc.items.length || foreignKind(doc)) return null;
  if ((doc.bbox_coord_space ?? 'abs_centralized') !== 'abs_centralized' || (doc.bbox_format ?? 'yxyx') !== 'yxyx') return null;
  let reachX = 0, reachY = 0;
  for (const item of doc.items) {
    const box = item?.bbox;
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return null;
    reachY = Math.max(reachY, Math.abs(box[0]), Math.abs(box[2]));
    reachX = Math.max(reachX, Math.abs(box[1]), Math.abs(box[3]));
  }
  const { width, height } = size;
  if (reachX <= width / 2 + 1 && reachY <= height / 2 + 1) return null;
  const scale = Math.max((2 * reachX) / width, (2 * reachY) / height);
  return { width: up16(width * scale), height: up16(height * scale) };
}

/** Some editors add keys to a compiled layout (width/height, color, locked): the size and locks are used, the rest dropped. */
export function normalizeLayout(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return { text, size: null, locks: [] }; }
  if (!doc || typeof doc !== 'object' || doc.bbox_coord_space !== 'abs_centralized' || !Array.isArray(doc.items)) return { text, size: null, locks: [] };
  const extras = ['color', 'locked', 'aspect_locked'];
  const size = Number.isFinite(doc.width) && Number.isFinite(doc.height) && doc.width >= 16 && doc.height >= 16 ? { width: up16(doc.width), height: up16(doc.height) } : null;
  const locks = doc.items.map((item) => item?.locked === true);
  const extra = 'width' in doc || 'height' in doc || doc.items.some((item) => item && typeof item === 'object' && extras.some((key) => key in item));
  if (!extra) return { text, size, locks };
  const { width: _width, height: _height, ...clean } = doc;
  clean.items = doc.items.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const copy = { ...item };
    for (const key of extras) delete copy[key];
    return copy;
  });
  return { text: JSON.stringify(clean), size, locks };
}

const onGrid = (value) => Math.round(clamp(value, 0, 1) * GRID);

/** Regions (front first, fractions) → assistant items (back first, [x1, y1, x2, y2] on 0-1000). */
export function regionsToGrid(regions) {
  return regions.slice().reverse().map((region) => ({
    label: region.kind, caption: String(region.description || '').trim(),
    bbox: [onGrid(region.x), onGrid(region.y), onGrid(region.x + region.w), onGrid(region.y + region.h)],
    ...(region.kind === 'text' && String(region.text || '').trim() ? { text: region.text.trim() } : {})
  }));
}

/** [x1, y1, x2, y2] on 0-1000 → a rectangle in fractions, at least one grid step wide. */
export function gridRect(bbox) {
  const [x1, y1, x2, y2] = bbox.map((value) => clamp(Number(value) / GRID, 0, 1));
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.max(Math.abs(x2 - x1), 1 / GRID), h: Math.max(Math.abs(y2 - y1), 1 / GRID) };
}

/** Intersection over union of two rectangles. */
export function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** Locked boxes survive an AI rewrite: each takes the place of the new box it overlaps most (IoU at least 0.5), or goes in front. */
export function keepLocked(previous, next) {
  const out = next.slice(), front = [];
  for (const lock of previous.filter((region) => region.locked)) {
    let best = -1, score = 0.5;
    out.forEach((region, index) => { if (region.locked) return; const value = overlap(lock, region); if (value >= score) { best = index; score = value; } });
    if (best >= 0) out[best] = lock; else front.push(lock);
  }
  return [...front, ...out];
}

/** An edited box that still sits where an old one was keeps that box's colours when the answer gave none. */
export function carryColours(previous, next) {
  return next.map((region) => {
    if (region.colors?.length) return region;
    const match = previous.find((old) => old.colors?.length && old.kind === region.kind && overlap(old, region) >= 0.6);
    return match ? { ...region, colors: [...match.colors] } : region;
  });
}

/** OCR word boxes ({label, bbox} on 0-1000) → one text line each, top to bottom, merged in canvas pixels. */
export function ocrLines(words, { width, height }, limit = 6) {
  const items = (words || []).map(({ label, bbox }) => ({ text: String(label || '').trim(),
    x1: (bbox[0] * width) / GRID, y1: (bbox[1] * height) / GRID, x2: (bbox[2] * width) / GRID, y2: (bbox[3] * height) / GRID }))
    .filter((item) => item.text && item.x2 > item.x1 && item.y2 > item.y1)
    .sort((a, b) => a.x1 - b.x1);
  const lines = [];
  for (const item of items) {
    const cy = (item.y1 + item.y2) / 2, h = item.y2 - item.y1;
    const line = lines.find((row) => {
      const rh = row.y2 - row.y1, gap = item.x1 - row.x2;
      return Math.abs(cy - (row.y1 + row.y2) / 2) < 0.5 * Math.max(h, rh) && gap > -0.5 * h && gap < 1.5 * Math.max(h, rh);
    });
    if (line) { line.words.push(item.text); line.x2 = Math.max(line.x2, item.x2); line.y1 = Math.min(line.y1, item.y1); line.y2 = Math.max(line.y2, item.y2); }
    else lines.push({ ...item, words: [item.text] });
  }
  lines.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
  return lines.slice(0, limit).map((line) => ({ text: line.words.join(' '),
    bbox: [Math.round((line.x1 / width) * GRID), Math.round((line.y1 / height) * GRID), Math.round((line.x2 / width) * GRID), Math.round((line.y2 / height) * GRID)] }));
}

/** The node's compile error as a short line; `number` is the box it names, `need` is 'caption', 'text' or null. */
export function issueFromError(message) {
  const text = String(message || '').trim().replace(/\.$/, '');
  const match = /^Region\s+(\d+)\s*:\s*(.+)$/i.exec(text);
  if (!match) return { number: null, need: null, text };
  const number = Number(match[1]), rest = match[2];
  const need = /write a caption/i.test(rest) ? 'caption' : /exact words|needs the exact/i.test(rest) ? 'text' : null;
  return { number, need, text: need === 'caption' ? `Box ${pad2(number)} needs a caption` : need === 'text' ? `Box ${pad2(number)} needs its words` : `Box ${pad2(number)}: ${rest}` };
}

/** Where the reference lands on an `out`-sized copy of the canvas: 'cover' fills it, 'contain' fits inside. */
export function fitRect(image, fit, out) {
  const k = fit === 'contain' ? Math.min(out.width / image.width, out.height / image.height) : Math.max(out.width / image.width, out.height / image.height);
  const w = image.width * k, h = image.height * k;
  return { x: (out.width - w) / 2, y: (out.height - h) / 2, w, h };
}

/** The lines a moving box snaps to: the canvas edges and centre, the thirds when shown, and every other box's edges and centre. */
export function snapLines(regions, id, thirds = false) {
  const base = [0, 0.5, 1, ...(thirds ? [1 / 3, 2 / 3] : [])];
  const x = [...base], y = [...base];
  for (const other of regions) {
    if (other.id === id || !other.w) continue;
    x.push(other.x, other.x + other.w / 2, other.x + other.w);
    y.push(other.y, other.y + other.h / 2, other.y + other.h);
  }
  return { x, y };
}

/** The nearest snap within SNAP_PX screen pixels: `{ delta, line }` or null. */
export function snapAxis(points, lines, pixels) {
  let best = null;
  for (const point of points) for (const line of lines) {
    const delta = line - point;
    if (Math.abs(delta * pixels) <= SNAP_PX && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, line };
  }
  return best;
}

/**
 * One pointer step of a drag. `mode` is 'move', 'draw' or a resize handle
 * ('n', 'se', …); `start` is the box when the drag began and `origin`/`point`
 * are fractions. `lines` (from snapLines) and `board` (its size in pixels)
 * turn on snapping. Returns `{ rect, guides }`.
 */
export function dragRect({ mode, start, origin, point, size, lines = null, board = null }) {
  const guides = [];
  const dx = point.x - origin.x, dy = point.y - origin.y;
  if (mode === 'move') {
    let x = clamp(start.x + dx, 0, 1 - start.w), y = clamp(start.y + dy, 0, 1 - start.h);
    if (lines && board) {
      const sx = snapAxis([x, x + start.w / 2, x + start.w], lines.x, board.width);
      const sy = snapAxis([y, y + start.h / 2, y + start.h], lines.y, board.height);
      if (sx) { x = clamp(x + sx.delta, 0, 1 - start.w); guides.push({ axis: 'x', at: sx.line }); }
      if (sy) { y = clamp(y + sy.delta, 0, 1 - start.h); guides.push({ axis: 'y', at: sy.line }); }
    }
    return { rect: { x, y, w: start.w, h: start.h }, guides };
  }
  const minW = 8 / size.width, minH = 8 / size.height;
  const sides = mode === 'draw' ? (point.x >= origin.x ? 'e' : 'w') + (point.y >= origin.y ? 's' : 'n') : mode;
  let ex = mode === 'draw' ? point.x : sides.includes('w') ? start.x + dx : start.x + start.w + dx;
  let ey = mode === 'draw' ? point.y : sides.includes('n') ? start.y + dy : start.y + start.h + dy;
  if (lines && board) {
    const sx = /[we]/.test(sides) && snapAxis([ex], lines.x, board.width);
    const sy = /[ns]/.test(sides) && snapAxis([ey], lines.y, board.height);
    if (sx) { ex += sx.delta; guides.push({ axis: 'x', at: sx.line }); }
    if (sy) { ey += sy.delta; guides.push({ axis: 'y', at: sy.line }); }
  }
  let left = start.x, top = start.y, right = start.x + start.w, bottom = start.y + start.h;
  if (mode === 'draw') {
    left = Math.min(origin.x, ex); right = Math.max(origin.x, ex); top = Math.min(origin.y, ey); bottom = Math.max(origin.y, ey);
  } else {
    if (sides.includes('w')) left = clamp(ex, 0, right - minW);
    if (sides.includes('e')) right = clamp(ex, left + minW, 1);
    if (sides.includes('n')) top = clamp(ey, 0, bottom - minH);
    if (sides.includes('s')) bottom = clamp(ey, top + minH, 1);
  }
  left = clamp(left, 0, 1); top = clamp(top, 0, 1);
  return { rect: { x: left, y: top, w: clamp(right, 0, 1) - left, h: clamp(bottom, 0, 1) - top }, guides };
}

/** The image on a paste or drop: files first, then file items (some Safari pastes carry it only there). */
export function clipboardFile(data) {
  const isImage = (file) => Boolean(file) && /^image\//.test(file.type || '');
  const file = [...(data?.files || [])].find(isImage);
  if (file) return file;
  const item = [...(data?.items || [])].find((entry) => entry.kind === 'file' && /^image\//.test(entry.type || ''));
  return item?.getAsFile?.() || null;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Text values of a PNG's tEXt, zTXt and iTXt chunks (ComfyUI keeps its graph there, so a studio picture brings its layout back). */
export async function pngTexts(buffer) {
  const bytes = new Uint8Array(buffer);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8 || signature.some((value, index) => bytes[index] !== value)) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const utf8 = new TextDecoder();
  const texts = [];
  for (let pos = 8; pos + 12 <= bytes.length;) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, Math.min(bytes.length, pos + 8 + length));
    pos += 12 + length;
    try {
      const zero = data.indexOf(0);
      if (type === 'tEXt' && zero >= 0) texts.push(utf8.decode(data.subarray(zero + 1)));
      else if (type === 'zTXt' && zero >= 0) texts.push(utf8.decode(await inflate(data.subarray(zero + 2))));
      else if (type === 'iTXt' && zero >= 0) {
        const compressed = data[zero + 1] === 1;
        let at = data.indexOf(0, zero + 3); at = data.indexOf(0, at + 1);
        if (at < 0) continue;
        const body = data.subarray(at + 1);
        texts.push(utf8.decode(compressed ? await inflate(body) : body));
      } else if (type === 'IEND') break;
    } catch { /* an unreadable chunk is skipped */ }
  }
  return texts;
}

/** A short, stable key for a prompt, so the size a layout was made for can be remembered. */
export function fingerprint(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36) + text.length;
}
