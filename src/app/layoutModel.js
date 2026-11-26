/*
 * Layout's pure parts (mossLayout.tsx draws them): the builder's state, what
 * the prompt node is sent, how boxes move, snap and survive an AI rewrite, and
 * how one prompt format becomes another. Plain JS so
 * scripts/layout-model.test.js can run them in Node.
 *
 * A region is one box: { id, kind, x, y, w, h, text, description, relation,
 * colors, tags, locked?, raw_description? } with x/y/w/h as fractions of the
 * canvas. Regions are kept front first, as the node's import returns them; box
 * numbers count from the back, as MOSS messages do ("Region 01" is the
 * backmost).
 *
 * Formats: a MOSS layout (`summary` + `items`, pixel boxes), a Ming-Image
 * prompt (`canvas_settings` + `layers`, back to front, centre boxes on 0-1), an
 * Ideogram 4 caption (`compositional_deconstruction`, [y1, x1, y2, x2] on
 * 0-1000) and a Layout assistant answer (xyxy on 0-1000). MOSS and Ming are
 * written by their nodes; Ideogram is written here, and read by the MOSS node.
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

/** One-box placements by grid cell: [value, label, columns, rows, [column, row] | null (centre)]. */
export const PLACE_ONE = [
  ['fill', 'Fill', 1, 1, [0, 0]], ['centre', 'Centre', 0, 0, null],
  ['top-left', 'Top left', 2, 2, [0, 0]], ['top-right', 'Top right', 2, 2, [1, 0]],
  ['bottom-left', 'Bottom left', 2, 2, [0, 1]], ['bottom-right', 'Bottom right', 2, 2, [1, 1]],
  ['left', 'Left half', 2, 1, [0, 0]], ['right', 'Right half', 2, 1, [1, 0]],
  ['top', 'Top half', 1, 2, [0, 0]], ['bottom', 'Bottom half', 1, 2, [0, 1]]
];
/** Splits of the whole canvas: [value, label, columns, rows]. */
export const PLACE_SPLIT = [['2c', '2 columns', 2, 1], ['2r', '2 rows', 1, 2], ['3c', '3 columns', 3, 1], ['3r', '3 rows', 1, 3],
  ['2x2', '2 × 2 grid', 2, 2], ['4c', '4 columns', 4, 1], ['4r', '4 rows', 1, 4], ['3x3', '3 × 3 grid', 3, 3]];

const PHI = 0.6180339887;
export const GUIDES = [
  { value: 'off', label: 'No guides' }, { value: 'thirds', label: 'Rule of thirds' },
  { value: 'golden', label: 'Golden ratio' }, { value: 'both', label: 'Thirds and golden ratio' }
];
const GUIDE_LINES = { off: [], thirds: [1 / 3, 2 / 3], golden: [1 - PHI, PHI], both: [1 / 3, 2 / 3, 1 - PHI, PHI] };
/** The guide lines (fractions, both axes) a guide mode draws and snaps to. */
export const guideLines = (mode) => GUIDE_LINES[mode] || [];
export const isGolden = (value) => Math.abs(value - PHI) < 1e-6 || Math.abs(value - (1 - PHI)) < 1e-6;

export const FITS = [
  { value: 'cover', label: 'Fill' }, { value: 'contain', label: 'Fit' }, { value: 'fill', label: 'Stretch' }, { value: 'actual', label: '1:1' }
];
export const FORMATS = [{ value: 'moss', label: 'MOSS' }, { value: 'ming', label: 'Ming' }, { value: 'ideogram', label: 'Ideogram 4' }];

const GRID = 1000;
const MAX_SIDE = 16384;
const HEX = /^#[0-9a-f]{6}$/i;
export const SNAP_PX = 7;
export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
export const uid = () => `box_${Math.random().toString(36).slice(2, 10)}`;
export const splitList = (text) => String(text || '').split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
export const pad2 = (value) => String(value).padStart(2, '0');
const up16 = (value) => clamp(Math.ceil(value / 16) * 16, 16, MAX_SIDE);
const onGrid = (value) => Math.round(clamp(value, 0, 1) * GRID);

export const emptyState = () => ({ caption: '', meta: [], canvas: 'single', palette: [], style: '', lighting: '', regions: [] });
export const newRegion = (kind, rect) => ({ id: uid(), kind, ...rect, text: '', description: '', relation: '', colors: [], tags: [] });

/** The state a starter gives; a caption already written on an empty canvas is kept. */
export function starterState(starter, caption = '') {
  return {
    caption: caption.trim() || starter.caption, meta: [...starter.meta], canvas: starter.canvas, palette: [], style: '', lighting: '',
    regions: starter.items.map(([kind, x, y, w, h, description, text = '']) => ({ ...newRegion(kind, { x, y, w, h }), description, text })).reverse()
  };
}

const sentence = (...parts) => parts.map((part) => String(part || '').trim().replace(/[.\s]+$/, '')).filter(Boolean).join('. ') + (parts.some((part) => String(part || '').trim()) ? '.' : '');

/** What the MOSS node's serialize route reads. Locks are editor-only and never sent. */
export function layoutPayload(state, size, format = 'compact') {
  return {
    width: size.width, height: size.height, summary_caption: state.caption, meta: state.meta.join(', '), canvas: state.canvas,
    palette: state.palette.join(', '), output_format: format,
    layers_data: JSON.stringify({ version: 1, order: 'front_to_back', regions: state.regions.map(({ id, x, y, w, h, kind, text, description, relation, colors, tags }) =>
      ({ id, x, y, w, h, kind, text: text || '', description: description || '', relation: relation || '', colors: colors || [], tags: tags || [] })) })
  };
}

/**
 * What the Ming node's serialize route reads. Ming knows objects and text only, so a character is
 * sent as an object; tags stand in for an empty caption. `raw_description` keeps an imported
 * text layer's own wording while its words and look are unchanged.
 */
export function mingPayload(state, size, format = 'compact') {
  return {
    width: size.width, height: size.height, image_style: state.style || '', ambient_lighting: state.lighting || '', output_format: format,
    layers_data: JSON.stringify({ version: 1, order: 'front_to_back', regions: state.regions.map(({ id, x, y, w, h, kind, text, description, relation, colors, tags, raw_description: raw }) => ({
      id, x, y, w, h, kind: kind === 'text' ? 'text' : 'object', text: kind === 'text' ? text || '' : '',
      description: kind === 'text' ? lookOf(description) : String(description || '').trim() || (tags || []).join(', '), relation: relation || '', colors: colors || [],
      ...(typeof raw === 'string' && kind === 'text' ? { raw_description: raw } : {})
    })) })
  };
}

/** Ming writes a text box as `A text element reading exactly "…" in <look>`, so the look starts lower case ("Large title" → "large title", "UI" stays). */
function lookOf(description) {
  const text = String(description || '').trim();
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

/** The serialize body for a format: 'ming' or 'moss'. */
export const payloadFor = (format, state, size, output = 'compact') => (format === 'ming' ? { format, ...mingPayload(state, size, output) } : layoutPayload(state, size, output));

/** The MOSS node's import answer as builder state, with fresh ids. */
export function stateFromImport(imported) {
  return {
    caption: imported.summary_caption || '', meta: splitList(imported.meta), canvas: imported.canvas || 'single', palette: splitList(imported.palette), style: '', lighting: '',
    regions: (imported.regions || []).map((region) => ({ ...region, id: uid(), text: region.text || '', description: region.description || '', relation: region.relation || '', tags: region.tags || [], colors: region.colors || [] }))
  };
}

/** The Ming node's import answer (`regions`, `image_style`, `ambient_lighting`) as builder state, with fresh ids. */
export function stateFromMing(imported) {
  return {
    ...emptyState(), style: imported.image_style || '', lighting: imported.ambient_lighting || '',
    regions: (imported.regions || []).map((region) => ({ ...region, id: uid(), kind: region.kind === 'text' ? 'text' : 'object', text: region.text || '', description: region.description || '', relation: region.relation || '', tags: [], colors: region.colors || [] }))
  };
}

/**
 * Fills what `format` needs from what another format left: a MOSS summary from a Ming style and
 * lighting, a Ming style from a MOSS caption and meta, a palette from the boxes' colours. Only
 * empty fields are filled, so converting back and forth keeps what you wrote. Ming has no
 * characters, so they become objects there.
 */
export function adaptState(state, format) {
  const next = { ...emptyState(), ...state };
  if (format === 'ming') {
    if (!next.style.trim()) next.style = sentence(next.meta.join(', '), next.caption);
    // Ming knows objects and text: a character is an object there.
    if (next.regions.some((region) => region.kind === 'character')) next.regions = next.regions.map((region) => (region.kind === 'character' ? { ...region, kind: 'object' } : region));
  } else {
    if (!next.caption.trim()) next.caption = sentence(next.style, next.lighting);
    if (!next.palette.length) next.palette = [...new Set(next.regions.flatMap((region) => region.colors || []))].slice(0, 6);
  }
  return next;
}

const isLayout = (value) => Boolean(value) && typeof value === 'object' && Array.isArray(value.items) && Boolean(value.summary) && Boolean(value.bbox_coord_space);
const isMing = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.layers)
  && Boolean(value.canvas_settings) && typeof value.canvas_settings === 'object' && !Array.isArray(value.canvas_settings);

/** 'ideogram' for an Ideogram 4 caption, 'assistant' for a Layout assistant answer (xyxy on 0-1000); the MOSS node converts both. */
export function foreignKind(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const scene = value.compositional_deconstruction;
  if (scene && typeof scene === 'object' && !Array.isArray(scene) && (scene.elements == null || Array.isArray(scene.elements))) return 'ideogram';
  if (value.grid === 'xyxy-1000' && Array.isArray(value.items)) return 'assistant';
  return null;
}

/** The format of a parsed prompt: 'moss', 'ming', 'ideogram', 'assistant' or null. */
export function formatOf(value) {
  if (isLayout(value)) return 'moss';
  if (isMing(value)) return 'ming';
  return foreignKind(value);
}

/** The format of a prompt's text, or null for plain words. */
export function promptFormat(text) {
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return null;
  try { return formatOf(JSON.parse(text)); } catch { return null; }
}

/** `{ format, items, text, caption }` when the text is a MOSS layout or a Ming prompt; null otherwise. */
export function layoutInfo(text) {
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return null;
  try {
    const value = JSON.parse(text);
    if (isLayout(value)) return { format: 'moss', items: value.items.length, text: value.items.filter((item) => item?.label === 'text').length, caption: String(value.summary?.caption || '').trim() };
    if (isMing(value)) return { format: 'ming', items: value.layers.length, text: value.layers.filter((layer) => /reading exactly "/i.test(String(layer?.description || ''))).length, caption: String(value.canvas_settings.image_style || '').trim() };
    return null;
  } catch { return null; }
}

/** The first layout prompt inside a value (MOSS, Ming, Ideogram or an assistant answer): the prompt itself, or JSON that holds one (a ComfyUI graph, a saved file). */
export function findLayout(value, depth = 0) {
  if (value == null || depth > 8) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text.startsWith('{')) return null;
    if (layoutInfo(text)) return text;
    try { return findLayout(JSON.parse(text), depth + 1); } catch { return null; }
  }
  if (typeof value !== 'object') return null;
  if (!Array.isArray(value) && formatOf(value)) return JSON.stringify(value);
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
  if (!doc || !Array.isArray(doc.items) || !doc.items.length || formatOf(doc) !== 'moss') return null;
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

/**
 * The node's compile error as a short line; `number` is the box it names (counted from the back,
 * like the box tags), `need` is 'caption', 'text' or null. MOSS counts from the back ("Region 01:
 * write a caption…"); Ming counts from the front ("Region 1.description must be a non-empty
 * string"), so a Ming message needs `count`, the number of boxes.
 */
export function issueFromError(message, { format = 'moss', count = 0 } = {}) {
  const text = String(message || '').trim().replace(/\.$/, '');
  const moss = /^Region\s+(\d+)\s*:\s*(.+)$/i.exec(text);
  const ming = moss ? null : /^Region\s+(\d+)\.(\w+)\s+(.+)$/i.exec(text);
  if (!moss && !ming) return { number: null, need: null, text };
  let number = Number((moss || ming)[1]);
  if (format === 'ming' && count) number = count - number + 1;
  const rest = moss ? moss[2] : `${ming[2]} ${ming[3]}`;
  const need = moss
    ? (/write a caption/i.test(rest) ? 'caption' : /exact words|needs the exact/i.test(rest) ? 'text' : null)
    : (/non-empty/i.test(rest) ? (ming[2] === 'description' ? 'caption' : ming[2] === 'text' ? 'text' : null) : null);
  return { number, need, text: need === 'caption' ? `Box ${pad2(number)} needs a caption` : need === 'text' ? `Box ${pad2(number)} needs its words` : `Box ${pad2(number)}: ${rest}` };
}

/**
 * Where the reference lands on an `out`-sized copy of the canvas, matching the board: 'cover'
 * fills it, 'contain' fits inside, 'fill' stretches, 'actual' keeps the image's pixels on the
 * canvas's pixels around the centre (the way MOSS boxes are measured; needs `size`).
 */
export function fitRect(image, fit, out, size = out) {
  if (fit === 'fill') return { x: 0, y: 0, w: out.width, h: out.height };
  const k = fit === 'actual' ? out.width / size.width
    : fit === 'contain' ? Math.min(out.width / image.width, out.height / image.height) : Math.max(out.width / image.width, out.height / image.height);
  const w = image.width * k, h = image.height * k;
  return { x: (out.width - w) / 2, y: (out.height - h) / 2, w, h };
}

/** Grid cells as fractions, with gutters (fractions of width and height) around and between them. */
export function gridRects(columns, rows, cells, gapX = 0, gapY = 0) {
  const cellW = (1 - gapX * (columns + 1)) / columns, cellH = (1 - gapY * (rows + 1)) / rows;
  return cells.map(([column, row]) => ({ x: gapX + column * (cellW + gapX), y: gapY + row * (cellH + gapY), w: cellW, h: cellH }));
}

/** Every cell of a grid in reading order (top-left first). */
export const allCells = (columns, rows) => Array.from({ length: columns * rows }, (_, index) => [index % columns, Math.floor(index / columns)]);

/** The rectangles for a placement: `cells` null is the centred half-area box; gutters are 3% of the short side, at least 16 px. */
export function placementRects(columns, rows, cells, size, gutters = false) {
  if (!cells) return [{ x: (1 - Math.SQRT1_2) / 2, y: (1 - Math.SQRT1_2) / 2, w: Math.SQRT1_2, h: Math.SQRT1_2 }];
  const gap = gutters ? Math.max(16, Math.round((Math.min(size.width, size.height) * 0.03) / 8) * 8) : 0;
  return gridRects(columns, rows, cells, gap / size.width, gap / size.height);
}

/** A box moved to a side or the centre of the canvas: 'left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'. */
export function alignRect(rect, where) {
  const x = { left: 0, hcenter: (1 - rect.w) / 2, right: 1 - rect.w }[where];
  const y = { top: 0, vcenter: (1 - rect.h) / 2, bottom: 1 - rect.h }[where];
  return { ...rect, ...(x == null ? {} : { x }), ...(y == null ? {} : { y }) };
}

/** A box from pixel fields (any of x, y, w, h), clamped to the canvas and at least 8 px. */
export function pixelRect(rect, patch, size) {
  const px = { x: rect.x * size.width, y: rect.y * size.height, w: rect.w * size.width, h: rect.h * size.height, ...patch };
  const w = clamp(Number(px.w) || 8, 8, size.width), h = clamp(Number(px.h) || 8, 8, size.height);
  const x = clamp(Number(px.x) || 0, 0, size.width - w), y = clamp(Number(px.y) || 0, 0, size.height - h);
  return { x: x / size.width, y: y / size.height, w: w / size.width, h: h / size.height };
}

/** The builder's state as an Ideogram 4 caption: elements front first, bbox [ymin, xmin, ymax, xmax] on 0-1000. Characters become objects. */
export function toIdeogram(state) {
  const hexes = (list) => (list || []).filter((value) => HEX.test(value)).map((value) => value.toUpperCase()).slice(0, 5);
  const doc = { high_level_description: String(state.caption || '').trim() || sentence(state.style, state.lighting).replace(/^\.$/, '') };
  const palette = hexes(state.palette);
  const aesthetics = [...(state.meta || []), ...(state.caption?.trim() && state.style?.trim() ? [state.style.trim()] : [])].join(', ');
  if (aesthetics || palette.length || state.lighting?.trim()) {
    doc.style_description = { ...(aesthetics ? { aesthetics } : {}), ...(state.lighting?.trim() ? { lighting: state.lighting.trim() } : {}), ...(palette.length ? { color_palette: palette } : {}) };
  }
  doc.compositional_deconstruction = { background: '', elements: state.regions.map((region) => {
    const text = region.kind === 'text' && String(region.text || '').trim() ? region.text : '';
    const element = { type: text ? 'text' : 'obj', bbox: [onGrid(region.y), onGrid(region.x), onGrid(region.y + region.h), onGrid(region.x + region.w)] };
    if (text) element.text = text;
    element.desc = String(region.description || '').trim();
    const colours = hexes(region.colors);
    if (colours.length) element.color_palette = colours;
    return element;
  }) };
  return doc;
}

/**
 * Keeps `ratio` (width / height in pixels) while resizing: corners follow the larger change, edges
 * set the other side around its centre. The fixed corner, edge or centre stays put, and the box
 * shrinks to fit the canvas. `W`/`H` are the canvas size in pixels.
 */
export function keepAspect(sides, start, rect, ratio, centred, W, H) {
  let w = (rect.right - rect.left) * W, h = (rect.bottom - rect.top) * H;
  const horizontal = /[we]/.test(sides), vertical = /[ns]/.test(sides);
  if (horizontal && vertical ? w / Math.max(h, 1e-9) > ratio : horizontal) h = w / ratio; else w = h * ratio;
  const sx = start.x * W, sy = start.y * H, sw = start.w * W, sh = start.h * H;
  const dirX = centred || !horizontal ? 0 : sides.includes('w') ? -1 : 1;
  const dirY = centred || !vertical ? 0 : sides.includes('n') ? -1 : 1;
  const ax = dirX === 1 ? sx : dirX === -1 ? sx + sw : sx + sw / 2;
  const ay = dirY === 1 ? sy : dirY === -1 ? sy + sh : sy + sh / 2;
  const roomX = dirX === 1 ? W - ax : dirX === -1 ? ax : 2 * Math.min(ax, W - ax);
  const roomY = dirY === 1 ? H - ay : dirY === -1 ? ay : 2 * Math.min(ay, H - ay);
  const k = Math.min(1, roomX / Math.max(w, 1e-9), roomY / Math.max(h, 1e-9));
  w *= k; h *= k;
  const left = dirX === 1 ? ax : dirX === -1 ? ax - w : ax - w / 2;
  const top = dirY === 1 ? ay : dirY === -1 ? ay - h : ay - h / 2;
  return { left: left / W, top: top / H, right: (left + w) / W, bottom: (top + h) / H };
}

/**
 * The lines a moving box snaps to: the canvas edges and centre, the guide lines shown (`guides` is
 * a guide mode, an array of fractions, or true for the thirds), and every other box's edges and centre.
 */
export function snapLines(regions, id, guides = false) {
  const extra = guides === true ? GUIDE_LINES.thirds : Array.isArray(guides) ? guides : typeof guides === 'string' ? guideLines(guides) : [];
  const base = [0, 0.5, 1, ...extra];
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
 * turn on snapping. `shift` keeps a move on one axis and a resize in
 * proportion (a square while drawing); `centred` resizes about the centre.
 * Returns `{ rect, guides }`.
 */
export function dragRect({ mode, start, origin, point, size, lines = null, board = null, shift = false, centred = false }) {
  const guides = [];
  let dx = point.x - origin.x, dy = point.y - origin.y;
  if (mode === 'move') {
    if (shift) { if (Math.abs(dx * size.width) >= Math.abs(dy * size.height)) dy = 0; else dx = 0; }
    let x = clamp(start.x + dx, 0, 1 - start.w), y = clamp(start.y + dy, 0, 1 - start.h);
    if (lines && board) {
      const sx = !(shift && dx === 0) && snapAxis([x, x + start.w / 2, x + start.w], lines.x, board.width);
      const sy = !(shift && dy === 0) && snapAxis([y, y + start.h / 2, y + start.h], lines.y, board.height);
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
  const around = centred && mode !== 'draw';
  if (mode === 'draw') {
    left = Math.min(origin.x, ex); right = Math.max(origin.x, ex); top = Math.min(origin.y, ey); bottom = Math.max(origin.y, ey);
  } else if (around) {
    const cx = start.x + start.w / 2, cy = start.y + start.h / 2;
    if (/[we]/.test(sides)) { const half = clamp(Math.abs(ex - cx), minW / 2, Math.min(cx, 1 - cx)); left = cx - half; right = cx + half; }
    if (/[ns]/.test(sides)) { const half = clamp(Math.abs(ey - cy), minH / 2, Math.min(cy, 1 - cy)); top = cy - half; bottom = cy + half; }
  } else {
    if (sides.includes('w')) left = clamp(ex, 0, right - minW);
    if (sides.includes('e')) right = clamp(ex, left + minW, 1);
    if (sides.includes('n')) top = clamp(ey, 0, bottom - minH);
    if (sides.includes('s')) bottom = clamp(ey, top + minH, 1);
  }
  if (shift) {
    const from = mode === 'draw' ? { x: origin.x, y: origin.y, w: 0, h: 0 } : start;
    const ratio = mode === 'draw' ? 1 : (start.w * size.width) / (start.h * size.height);
    if (Number.isFinite(ratio) && ratio > 0) ({ left, top, right, bottom } = keepAspect(sides, from, { left, top, right, bottom }, ratio, around, size.width, size.height));
    guides.length = 0;
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
