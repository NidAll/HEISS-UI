import React from 'react';
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, ArrowDown, ArrowUp,
  ChevronsDown, ChevronsUp, ClipboardPaste, Copy, CopyPlus, Download, FileUp, Grid3x3, GripVertical, ImagePlus, LayoutDashboard, LayoutGrid, Lock, LockOpen,
  Magnet, Maximize, Redo2, ScanText, Sparkles, Square, Trash2, Undo2, X, ZoomIn, ZoomOut
} from 'lucide-react';
import { cn } from './format';
import { Tip } from './components';
import { SafeImg } from './SafeImg';
import { Segmented } from './SettingsDialog';
import {
  CANVASES, FITS, GUIDES, KINDS, META_SUGGESTIONS, PLACE_ONE, PLACE_SPLIT, STARTERS, adaptState, alignRect, allCells, carryColours, clamp, clipboardFile,
  dragRect, emptyState, findLayout, fingerprint, fitRect, gridRect, guideLines, inferSourceSize, isGolden, issueFromError, keepLocked, layoutInfo,
  newRegion, normalizeLayout, ocrLines, overlap, pad2, payloadFor, pixelRect, placementRects, pngTexts, promptFormat, regionsToGrid, snapLines,
  splitList, starterState, stateFromImport, stateFromMing, toIdeogram,
  type Fit, type Format, type Guide, type GuideMode, type Imported, type Kind, type LayoutState, type Rect, type Region, type Size
} from './layoutModel.js';
import type { Extension, ExtensionContext } from './extensions';

/*
 * Layout (server/moss-layout.js): a builder for layout prompts, written in the
 * format the workflow reads: a MOSS-Image layout (a summary with caption,
 * meta, canvas and palette, and boxes for objects, characters and text) or a
 * Ming-Image prompt (an image style and ambient lighting, and layers for
 * objects and text). Every change is checked by the prompt node in ComfyUI,
 * which also writes the prompt; Use layout puts it in the prompt box, and
 * reopening imports it back. A MOSS, Ming or Ideogram 4 prompt from anywhere
 * (the prompt box, a file, the clipboard, a studio PNG) is converted to the
 * workflow's format, and the Prompt tab copies or saves the layout in any of
 * them. A reference image can sit under the boxes (it is never sent with the
 * prompt). With the workflow's assistant models, the AI tab extracts a
 * layout and its prompt from an image, plans or changes a layout from words,
 * writes captions, fits a box to its object and finds lettering.
 */

const ID = 'layout';
const STORE = 'heiss.layout.v1';
const SIZES = 'heiss.layout.sizes.v1';
const PREFS = 'heiss.layout.prefs.v1';
const AI_SIDE = 896;
const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8];
const TASK_TITLES: Record<string, string> = { image: 'Extracting the layout', text: 'Planning a layout', edit: 'Editing the layout', describe: 'Writing captions', snap: 'Fitting the box', ocr: 'Finding lettering' };
const NAMES: Record<string, string> = { moss: 'MOSS', ming: 'Ming', ideogram: 'Ideogram 4', assistant: 'assistant' };
const ALIGNS = [
  { where: 'left', label: 'Left edge', icon: AlignStartVertical }, { where: 'hcenter', label: 'Centre across', icon: AlignCenterVertical }, { where: 'right', label: 'Right edge', icon: AlignEndVertical },
  { where: 'top', label: 'Top edge', icon: AlignStartHorizontal }, { where: 'vcenter', label: 'Centre down', icon: AlignCenterHorizontal }, { where: 'bottom', label: 'Bottom edge', icon: AlignEndHorizontal }
] as const;
const SHORTCUTS: Array<[string, string]> = [
  ['O · C · T', 'Draw objects, characters or text'], ['Drag', 'Draw a box; Ctrl-drag draws over boxes'], ['Shift', 'Keep proportions, or move along one axis'],
  ['Ctrl on a handle', 'Resize about the centre'], ['Alt', 'Skip snapping'], ['Arrows', 'Nudge 1 px (Shift: 10 px)'], ['[ · ]', 'Send back · bring forward (Shift: to the end)'],
  ['L', 'Lock or unlock'], ['Ctrl+D', 'Duplicate'], ['Del', 'Delete'], ['P · I', 'Place menu · import'], ['+ · − · 0', 'Zoom in, out, fit'],
  ['Space-drag', 'Pan when zoomed (or the middle button)'], ['Ctrl+Z · Ctrl+Y', 'Undo · redo'], ['Ctrl+Enter', 'Use layout'], ['Right-click', 'Box and board menu']
];

type Tab = 'summary' | 'boxes' | 'ai' | 'prompt';
type View = Format | 'ideogram';
type Reference = { url: string; name: string; width: number; height: number };
type Notice = { text: string; tone?: 'warning'; action?: { label: string; run: () => void } } | null;
type Compiled = { prompt: string; mode?: string; warnings?: string[] };
type Job = { task: string; started: number; steps: string[]; id: string | null; thinking: string[]; canceled?: boolean };
type Models = { writer: boolean; detector: boolean } | null;
type AiOptions = { fresh?: boolean; targets?: string[]; rewrite?: boolean };
type Drag = { id: string; mode: string; start: Rect; origin: { x: number; y: number }; before: string; moved: boolean; through: string | null };
type Pan = { x: number; y: number; left: number; top: number };
type Pop = { kind: 'place' | 'guides' | 'import' | 'menu'; x: number; y: number; target?: string | null; at?: { x: number; y: number } } | null;

const readStore = <T,>(key: string, fallback: T): T => { try { return (JSON.parse(localStorage.getItem(key) || 'null') as T) ?? fallback; } catch { return fallback; } };
const writeStore = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* a per-device convenience */ } };
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const pretty = (text: string) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };

/** The size each used layout was made for, so a later size change rescales its boxes instead of clipping them. */
function rememberSize(prompt: string, size: Size) {
  const sizes = readStore<Record<string, [number, number, number]>>(SIZES, {});
  sizes[fingerprint(prompt)] = [size.width, size.height, Date.now()];
  writeStore(SIZES, Object.fromEntries(Object.entries(sizes).sort((a, b) => b[1][2] - a[1][2]).slice(0, 40)));
}
const knownSize = (prompt: string): Size | null => { const hit = readStore<Record<string, [number, number]>>(SIZES, {})[fingerprint(prompt)]; return hit ? { width: hit[0], height: hit[1] } : null; };

async function call<T>(operation: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/moss-layout/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `The layout check failed (${response.status}).`), { restart: Boolean(data.restart) });
  return data as T;
}

const sizeOf = (view: Record<string, any>): Size => {
  const width = Number(view.width), height = Number(view.height);
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? { width, height } : { width: 1024, height: 1024 };
};
const firstWarning = (warnings: string[] = []) => (warnings[0] ? `${warnings[0]}${warnings.length > 1 ? ` (and ${warnings.length - 1} more)` : ''}` : '');

/**
 * Imports a layout prompt of any format through its node, as builder state for `format`. A MOSS
 * layout is scaled from its remembered or inferred size to this canvas; Ideogram and assistant
 * answers go through the MOSS import, which converts them; a Ming prompt through the Ming import.
 */
async function readLayout(original: string, size: Size, format: Format): Promise<{ state: LayoutState; note: string; from: string }> {
  const from = promptFormat(original) || 'moss';
  if (from === 'ming') {
    const imported = await call<Imported>('import', { format: 'ming', prompt: original, width: size.width, height: size.height });
    const shape = imported.width && imported.height && Math.abs(imported.width / imported.height - size.width / size.height) > 0.01;
    const note = shape ? `This prompt was made for ${imported.width} × ${imported.height}; its boxes now stretch to ${size.width} × ${size.height}.` : firstWarning(imported.warnings);
    return { state: adaptState(stateFromMing(imported), format), note, from };
  }
  if (from === 'ideogram' || from === 'assistant') {
    const imported = await call<Imported>('import', { prompt: original, width: size.width, height: size.height });
    return { state: adaptState(stateFromImport(imported), format), note: firstWarning((imported.warnings || []).filter((warning) => !/^Converted from/.test(warning))), from };
  }
  const { text, size: stated, locks } = normalizeLayout(original);
  const remembered = knownSize(original) || stated;
  const inferred = remembered ? null : inferSourceSize(text, size);
  const made = remembered || inferred || size;
  const imported = await call<Imported>('import', { prompt: text, width: made.width, height: made.height });
  const state = stateFromImport(imported);
  // The node lists items back to front and answers front first.
  if (locks.some(Boolean) && locks.length === state.regions.length) state.regions.forEach((region, index) => { if (locks[locks.length - 1 - index]) region.locked = true; });
  let note = '';
  if (inferred) note = `This layout reached past ${size.width} × ${size.height}, so it was scaled down to fit, keeping its proportions.`;
  else if (imported.width && (imported.width !== size.width || imported.height !== size.height)) note = `This layout was made for ${imported.width} × ${imported.height}; its boxes now fit ${size.width} × ${size.height}.`;
  else note = firstWarning(imported.warnings);
  return { state: adaptState(state, format), note, from };
}

/** The reference lives for the page session (an object URL), so reopening the builder keeps it. */
let sessionReference: Reference | null = null;

/** Chips with an input that adds on Enter or a comma; `suggestions` feed a datalist. */
function ChipInput({ id, values, onChange, placeholder, suggestions }: { id: string; values: string[]; onChange: (next: string[]) => void; placeholder: string; suggestions?: string[] }) {
  const [draft, setDraft] = React.useState('');
  const add = (text: string) => {
    const next = splitList(text).filter((item) => !values.includes(item));
    if (next.length) onChange([...values, ...next]);
    setDraft('');
  };
  return (
    <div className="layout-chips">
      {values.map((value, index) => (
        <span key={`${value}-${index}`} className="layout-chip">
          {value}
          <button type="button" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((_, at) => at !== index))}><X size={12} /></button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        list={suggestions ? `${id}-list` : undefined}
        placeholder={values.length ? '' : placeholder}
        autoComplete="off"
        onChange={(event) => { const text = event.target.value; if (/[,\n]/.test(text)) add(text); else setDraft(text); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && draft.trim()) { event.preventDefault(); add(draft); }
          if (event.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1));
        }}
        onBlur={() => { if (draft.trim()) add(draft); }}
      />
      {suggestions ? <datalist id={`${id}-list`}>{suggestions.filter((item) => !values.includes(item)).map((item) => <option key={item} value={item} />)}</datalist> : null}
    </div>
  );
}

/** Hex colours as swatches, with a picker to add one. */
function Colours({ id, values, onChange, label }: { id: string; values: string[]; onChange: (next: string[]) => void; label: string }) {
  return (
    <div className="layout-colours" role="group" aria-label={label}>
      {values.map((value, index) => (
        <button key={`${value}-${index}`} type="button" className="layout-swatch" style={{ background: value }} aria-label={`Remove ${value}`} title={`${value} · click to remove`} onClick={() => onChange(values.filter((_, at) => at !== index))} />
      ))}
      {values.length < 6 ? (
        <label className="layout-swatch is-add" htmlFor={id} title="Add a colour">
          +
          <input id={id} type="color" className="sr-only" onChange={(event) => { const hex = event.target.value.toUpperCase(); if (!values.includes(hex)) onChange([...values, hex]); }} />
        </label>
      ) : null}
    </div>
  );
}

/** A number field in canvas pixels that commits on Enter or blur. */
function PixelField({ label, value, disabled, onCommit }: { label: string; value: number; disabled?: boolean; onCommit: (next: number) => void }) {
  const [draft, setDraft] = React.useState(String(Math.round(value)));
  React.useEffect(() => setDraft(String(Math.round(value))), [value]);
  const commit = () => { const next = Number(draft); if (Number.isFinite(next) && Math.round(next) !== Math.round(value)) onCommit(next); else setDraft(String(Math.round(value))); };
  return (
    <label className="layout-px">
      <span>{label}</span>
      <input type="number" inputMode="numeric" value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} />
    </label>
  );
}

/** A small picture of a placement: the canvas and the boxes it would make. */
function PlaceTile({ label, rects, size, onPick }: { label: string; rects: Rect[]; size: Size; onPick: () => void }) {
  const k = 40 / Math.max(size.width, size.height), w = size.width * k, h = size.height * k;
  return (
    <button type="button" role="menuitem" className="layout-tile" title={label} aria-label={label} onClick={onPick}>
      <svg viewBox={`-1 -1 ${w + 2} ${h + 2}`} width={w + 2} height={h + 2} aria-hidden="true">
        <rect x={0} y={0} width={w} height={h} rx={2} className="layout-tile-frame" />
        {rects.map((rect, index) => <rect key={index} x={rect.x * w} y={rect.y * h} width={rect.w * w} height={rect.h * h} rx={1.5} className="layout-tile-box" />)}
      </svg>
      <span>{label}</span>
    </button>
  );
}

function AiCard({ job, onStop }: { job: Job; onStop: () => void }) {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(timer); }, []);
  return (
    <div className="layout-ai-card" role="status">
      <Sparkles size={16} className="layout-ai-spark" />
      <div className="layout-ai-main">
        <strong>{TASK_TITLES[job.task] || 'Working'}</strong>
        <span>{job.steps.join(' · ') || 'Starting'} · {((now - job.started) / 1000).toFixed(1)} s</span>
      </div>
      <button type="button" className="btn" onClick={onStop}><Square size={12} /> Stop</button>
    </div>
  );
}

function LayoutPanel({ context, close }: { context: ExtensionContext; close: () => void }) {
  const live = React.useRef(context);
  live.current = context;
  const size = sizeOf(context.view);
  const sizeRef = React.useRef(size);
  sizeRef.current = size;
  const assist = Boolean(context.profile?.layout?.assist);
  const format: Format = context.profile?.layout?.format === 'ming' ? 'ming' : 'moss';
  const ming = format === 'ming';
  const kinds = ming ? KINDS.filter((kind) => kind.value !== 'character') : KINDS;
  const uidBase = React.useId();
  const fieldId = (name: string) => `${uidBase}-${name}`;

  // ---------- state and history ----------
  const [state, setRaw] = React.useState<LayoutState>(emptyState);
  const latest = React.useRef(state);
  const history = React.useRef({ past: [] as string[], future: [] as string[], key: '', at: 0 });
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<Tab>('summary');
  const [tool, setTool] = React.useState<Kind>('object');
  const [prefs, setPrefs] = React.useState(() => {
    const saved = readStore<Record<string, unknown>>(PREFS, {});
    const guides = (typeof saved.guides === 'string' ? saved.guides : saved.thirds === false ? 'off' : 'thirds') as GuideMode;
    return { snap: true, opacity: 0.45, fit: 'cover' as Fit, labels: '', lettering: true, gutters: true, ...saved, guides };
  });
  const [reference, setReference] = React.useState<Reference | null>(sessionReference);
  const [notice, setNotice] = React.useState<Notice>(null);
  const [compiled, setCompiled] = React.useState<Compiled | null>(null);
  const [error, setError] = React.useState<(Error & { restart?: boolean }) | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [job, setJob] = React.useState<Job | null>(null);
  const jobRef = React.useRef<Job | null>(null);
  const [models, setModels] = React.useState<Models>(null);
  const [request, setRequest] = React.useState('');
  const [last, setLast] = React.useState<{ task: string; extra: Record<string, unknown>; targets: string[] } | null>(null);
  const [guides, setGuides] = React.useState<Guide[]>([]);
  const [born, setBorn] = React.useState<Set<string>>(new Set());
  const [zoom, setZoom] = React.useState(1);
  const [pop, setPop] = React.useState<Pop>(null);
  const [view, setView] = React.useState<View>(format);
  const [other, setOther] = React.useState<{ view: View; text: string; warnings: string[] } | null>(null);
  const [pad, setPad] = React.useState('');
  const [dragRow, setDragRow] = React.useState<string | null>(null);
  const [spaceHeld, setSpaceHeld] = React.useState(false);
  const panel = React.useRef<HTMLDivElement>(null);
  const stage = React.useRef<HTMLDivElement>(null);
  const board = React.useRef<HTMLDivElement>(null);
  const caption = React.useRef<HTMLTextAreaElement>(null);
  const boxCaption = React.useRef<HTMLTextAreaElement>(null);
  const requestBox = React.useRef<HTMLTextAreaElement>(null);
  const referenceInput = React.useRef<HTMLInputElement>(null);
  const importInput = React.useRef<HTMLInputElement>(null);
  const drag = React.useRef<Drag | null>(null);
  const pan = React.useRef<Pan | null>(null);
  const extractAfterPick = React.useRef(false);
  const [fitSize, setFitSize] = React.useState<Size>({ width: 0, height: 0 });
  const boardSize = { width: Math.round(fitSize.width * zoom), height: Math.round(fitSize.height * zoom) };

  const updatePrefs = (patch: Partial<typeof prefs>) => setPrefs((old) => { const next = { ...old, ...patch }; writeStore(PREFS, next); return next; });
  const say = (text: string, extra: Omit<NonNullable<Notice>, 'text'> = {}) => setNotice({ text, ...extra });

  const put = (next: LayoutState) => { latest.current = next; setRaw(next); bump(); };
  /** One change: recorded for Undo (typing in one field within a second is one step) and kept on this device. */
  const set = (next: LayoutState, key = '') => {
    const h = history.current, now = Date.now();
    if (!(key && key === h.key && now - h.at < 1000)) { h.past.push(JSON.stringify(latest.current)); if (h.past.length > 100) h.past.shift(); }
    h.key = key; h.at = now; h.future = [];
    writeStore(STORE, { state: next, at: now });
    put(next);
  };
  const edit = (change: (old: LayoutState) => LayoutState, key = '') => set(change(latest.current), key);
  const editRegion = (id: string, patch: Partial<Region>, key = '') => edit((old) => ({ ...old, regions: old.regions.map((region) => (region.id === id ? { ...region, ...patch } : region)) }), key);
  const step = (from: 'past' | 'future', to: 'past' | 'future') => {
    const h = history.current;
    const value = h[from].pop();
    if (!value) return;
    h[to].push(JSON.stringify(latest.current)); h.key = '';
    const next = { ...emptyState(), ...(JSON.parse(value) as LayoutState) };
    writeStore(STORE, { state: next, at: Date.now() });
    put(next);
  };
  const undo = () => step('past', 'future');
  const redo = () => step('future', 'past');
  const region = (id: string | null | undefined) => latest.current.regions.find((item) => item.id === id) || null;
  const numberOf = (item: Region) => latest.current.regions.length - latest.current.regions.findIndex((other) => other.id === item.id);
  const select = (id: string | null) => { setSelected(id); if (id) setTab('boxes'); };

  // ---------- loading ----------
  React.useEffect(() => {
    let alive = true;
    const prompt = String(live.current.view.prompt || '');
    const saved = readStore<{ state?: LayoutState } | null>(STORE, null);
    void (async () => {
      if (promptFormat(prompt)) {
        try {
          const { state: imported, note, from } = await readLayout(prompt, sizeRef.current, format);
          if (!alive) return;
          put(imported);
          const converted = from !== format ? ` It was a ${NAMES[from]} prompt; Use layout writes it as ${NAMES[format]}.` : '';
          say(`${note || `The layout in your prompt is back: ${plural(imported.regions.length, 'box', 'boxes')}.`}${converted}`);
        } catch (failure) {
          if (alive) say((failure as Error).message, { tone: 'warning' });
        }
      } else {
        const text = prompt.trim().startsWith('{') ? '' : prompt;
        put({ ...emptyState(), ...(ming ? { style: text } : { caption: text }) });
        if (saved?.state?.regions?.length) say('Your last layout is saved on this device.', { action: { label: 'Bring it back', run: () => { set(adaptState({ ...emptyState(), ...(saved.state as LayoutState) }, format)); setNotice(null); } } });
      }
      if (alive) setLoaded(true);
    })();
    return () => { alive = false; };
  }, []);

  // ---------- the node's check, as you edit ----------
  React.useEffect(() => {
    if (!loaded) return;
    let alive = true;
    setChecking(true);
    const timer = setTimeout(() => {
      call<Compiled>('serialize', payloadFor(format, state, size)).then((result) => {
        if (!alive) return;
        setCompiled(result); setError(null);
      }, (failure) => {
        if (!alive) return;
        setCompiled(null); setError(failure);
      }).finally(() => { if (alive) setChecking(false); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [state, size.width, size.height, loaded]);

  // The Prompt tab's other formats, written when shown.
  React.useEffect(() => {
    if (tab !== 'prompt' || view === format) return;
    if (view === 'ideogram') { setOther({ view, text: JSON.stringify(toIdeogram(adaptState(state, 'moss')), null, 2), warnings: [] }); return; }
    let alive = true;
    const timer = setTimeout(() => {
      call<Compiled>('serialize', payloadFor(view, adaptState(state, view), size, 'pretty')).then(
        (result) => { if (alive) setOther({ view, text: result.prompt, warnings: result.warnings || [] }); },
        (failure) => { if (alive) setOther({ view, text: '', warnings: [(failure as Error).message] }); }
      );
    }, 150);
    return () => { alive = false; clearTimeout(timer); };
  }, [tab, view, state, size.width, size.height]);

  // ---------- the board's size and zoom ----------
  React.useLayoutEffect(() => {
    const host = stage.current;
    if (!host) return;
    const fit = () => {
      const k = Math.min(host.clientWidth / size.width, host.clientHeight / size.height);
      setFitSize({ width: Math.max(1, Math.floor(size.width * k)), height: Math.max(1, Math.floor(size.height * k)) });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    return () => observer.disconnect();
  }, [size.width, size.height]);
  /** Zooms keeping `focus` (client pixels, the stage centre by default) where it is. */
  const zoomTo = (next: number, focus?: { x: number; y: number }) => {
    const host = stage.current, surface = board.current;
    const value = clamp(next, 1, ZOOM_STEPS[ZOOM_STEPS.length - 1]);
    if (!host || !surface || value === zoom) { setZoom(value); return; }
    const box = surface.getBoundingClientRect(), view = host.getBoundingClientRect();
    const at = focus || { x: view.left + view.width / 2, y: view.top + view.height / 2 };
    const fx = (at.x - box.left) / box.width, fy = (at.y - box.top) / box.height;
    setZoom(value);
    requestAnimationFrame(() => {
      const moved = surface.getBoundingClientRect();
      host.scrollLeft += moved.left + fx * moved.width - at.x;
      host.scrollTop += moved.top + fy * moved.height - at.y;
    });
  };
  const zoomStep = (direction: 1 | -1) => {
    const next = direction > 0 ? ZOOM_STEPS.find((value) => value > zoom + 1e-6) : [...ZOOM_STEPS].reverse().find((value) => value < zoom - 1e-6);
    zoomTo(next ?? zoom);
  };
  React.useEffect(() => {
    const host = stage.current;
    if (!host) return;
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      zoomRef.current(zoomValue.current * Math.exp(-event.deltaY * 0.002), { x: event.clientX, y: event.clientY });
    };
    host.addEventListener('wheel', wheel, { passive: false });
    return () => host.removeEventListener('wheel', wheel);
  }, []);
  const zoomRef = React.useRef(zoomTo);
  zoomRef.current = zoomTo;
  const zoomValue = React.useRef(zoom);
  zoomValue.current = zoom;

  // ---------- popovers ----------
  const openPop = (kind: NonNullable<Pop>['kind'], anchor: HTMLElement | { x: number; y: number }, extra: Partial<NonNullable<Pop>> = {}) => {
    const host = panel.current?.getBoundingClientRect();
    if (!host) return;
    const point = anchor instanceof HTMLElement ? (() => { const rect = anchor.getBoundingClientRect(); return { x: rect.left, y: rect.bottom + 6 }; })() : anchor;
    setPop((old) => (old?.kind === kind && !extra.at && !('target' in extra) ? null : { kind, x: point.x - host.left, y: point.y - host.top, ...extra }));
  };
  React.useLayoutEffect(() => {
    // Keep an open popover inside the panel.
    const node = panel.current?.querySelector<HTMLElement>('.layout-pop');
    const host = panel.current;
    if (!node || !host || !pop) return;
    const x = clamp(pop.x, 8, Math.max(8, host.clientWidth - node.offsetWidth - 8)), y = clamp(pop.y, 8, Math.max(8, host.clientHeight - node.offsetHeight - 8));
    if (Math.abs(x - pop.x) > 0.5 || Math.abs(y - pop.y) > 0.5) setPop({ ...pop, x, y });
  }, [pop]);
  React.useEffect(() => {
    if (!pop) return;
    const away = (event: PointerEvent) => { if (!(event.target as HTMLElement)?.closest?.('.layout-pop, [data-pop]')) setPop(null); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [pop]);

  // ---------- keys ----------
  const keys = React.useRef<(event: KeyboardEvent) => void>(() => undefined);
  keys.current = (event) => {
    const typing = (event.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable="true"]');
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'z' && !typing) { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (mod && key === 'y' && !typing) { event.preventDefault(); redo(); return; }
    if (mod && event.key === 'Enter') { event.preventDefault(); void apply(); return; }
    if (typing) return;
    if (event.key === ' ' && !event.repeat) { setSpaceHeld(true); event.preventDefault(); return; }
    if (!mod && !event.altKey) {
      const kind = ({ o: 'object', c: ming ? null : 'character', t: 'text' } as Record<string, Kind | null>)[key];
      if (kind) { setTool(kind); return; }
      if (event.key === '+' || event.key === '=') { zoomStep(1); return; }
      if (event.key === '-' || event.key === '_') { zoomStep(-1); return; }
      if (event.key === '0') { setZoom(1); return; }
      if (key === 'p') { const anchor = panel.current?.querySelector<HTMLElement>('[data-pop="place"]'); if (anchor) openPop('place', anchor); return; }
      if (key === 'i') { importInput.current?.click(); return; }
    }
    if (!selected) return;
    const item = region(selected);
    if (!item) return;
    if (mod && key === 'd') { event.preventDefault(); duplicate(item.id); return; }
    if (mod) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(item.id); return; }
    if (key === 'l') { editRegion(item.id, { locked: !item.locked || undefined }); return; }
    if (event.key === '[' || event.key === '{') { restack(item.id, false, event.shiftKey || event.key === '{'); return; }
    if (event.key === ']' || event.key === '}') { restack(item.id, true, event.shiftKey || event.key === '}'); return; }
    const by = event.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, -by], ArrowDown: [0, by] };
    const move = moves[event.key];
    if (move && !item.locked) {
      event.preventDefault();
      editRegion(item.id, { x: clamp(item.x + move[0] / size.width, 0, 1 - item.w), y: clamp(item.y + move[1] / size.height, 0, 1 - item.h) }, `nudge-${item.id}`);
    }
  };
  React.useEffect(() => {
    const listen = (event: KeyboardEvent) => keys.current(event);
    const release = (event: KeyboardEvent) => { if (event.key === ' ') setSpaceHeld(false); };
    // Escape closes a popover, then clears the selection, before it closes the dialog. Registered
    // before the dialog's own listener (a child's effect runs first), so preventDefault keeps it open.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || jobRef.current) return;
      if (popRef.current) { event.preventDefault(); setPop(null); return; }
      if (selectedRef.current && !(event.target as HTMLElement)?.closest?.('input, textarea, select')) { event.preventDefault(); setSelected(null); }
    };
    window.addEventListener('keydown', listen);
    window.addEventListener('keyup', release);
    document.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('keydown', listen); window.removeEventListener('keyup', release); document.removeEventListener('keydown', escape, true); };
  }, []);
  const popRef = React.useRef(pop);
  popRef.current = pop;
  const selectedRef = React.useRef(selected);
  selectedRef.current = selected;

  // A running assistant stops with the panel.
  React.useEffect(() => () => { const running = jobRef.current; if (running?.id) void fetch(`/api/jobs/${encodeURIComponent(running.id)}/cancel`, { method: 'POST' }).catch(() => null); }, []);

  // ---------- boxes ----------
  const remove = (id: string) => {
    const item = region(id);
    if (!item) return;
    if (item.locked) { say(`Box ${pad2(numberOf(item))} is locked. Unlock it to remove it.`, { tone: 'warning' }); return; }
    edit((old) => ({ ...old, regions: old.regions.filter((other) => other.id !== id) }));
    setSelected(null);
  };
  const duplicate = (id: string) => {
    const item = region(id);
    if (!item) return;
    const { locked: _locked, ...rest } = item;
    const copy = { ...rest, id: newRegion(item.kind, item).id, x: clamp(item.x + 0.03, 0, 1 - item.w), y: clamp(item.y + 0.03, 0, 1 - item.h) };
    edit((old) => ({ ...old, regions: [copy, ...old.regions] }));
    select(copy.id);
  };
  /** Forward is towards the front (the start of the list); `end` goes all the way. */
  const restack = (id: string, forward: boolean, end = false) => edit((old) => {
    const regions = old.regions.slice();
    const from = regions.findIndex((item) => item.id === id);
    const to = end ? (forward ? 0 : regions.length - 1) : from + (forward ? -1 : 1);
    if (from < 0 || to < 0 || to >= regions.length || to === from) return old;
    const [item] = regions.splice(from, 1);
    regions.splice(to, 0, item);
    return { ...old, regions };
  });
  /** A box moved in the list to where another one is (the list shows front first). */
  const moveTo = (id: string, target: string) => edit((old) => {
    const regions = old.regions.slice();
    const from = regions.findIndex((item) => item.id === id), to = regions.findIndex((item) => item.id === target);
    if (from < 0 || to < 0 || from === to) return old;
    const [item] = regions.splice(from, 1);
    regions.splice(to, 0, item);
    return { ...old, regions };
  });
  const addBox = (kind: Kind = tool, at?: { x: number; y: number }) => {
    const w = kind === 'text' ? 0.6 : 0.4, h = Math.min(1, kind === 'text' ? Math.max(0.08, 96 / size.height) : (0.4 * size.width) / size.height);
    const x = at ? clamp(at.x - w / 2, 0, 1 - w) : (1 - w) / 2, y = at ? clamp(at.y - h / 2, 0, 1 - h) : clamp((1 - h) / 2, 0, 1 - h);
    const item = newRegion(kind, { x, y, w, h });
    edit((old) => ({ ...old, regions: [item, ...old.regions] }));
    select(item.id);
    requestAnimationFrame(() => boxCaption.current?.focus());
  };
  /** A placement: one rect moves the target box (or adds one), several add a box each in reading order. */
  const place = (rects: Rect[], label: string, target: Region | null) => {
    setPop(null);
    if (target && rects.length === 1) {
      editRegion(target.id, rects[0]);
      say(`Box ${pad2(numberOf(target))} → ${label.toLowerCase()}.`);
      return;
    }
    const added = rects.map((rect) => newRegion(tool, rect)).reverse();
    edit((old) => ({ ...old, regions: [...added, ...old.regions] }));
    select(added[added.length - 1].id);
    if (added.length > 1) say(`Added ${added.length} ${KINDS.find((kind) => kind.value === tool)?.label.toLowerCase()} boxes (${label.toLowerCase()}). Describe each one; Undo removes them all.`, { action: { label: 'Undo', run: undo } });
    requestAnimationFrame(() => boxCaption.current?.focus({ preventScroll: true }));
  };

  const point = (event: { clientX: number; clientY: number }) => {
    const rect = board.current!.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width, 0, 1), y: clamp((event.clientY - rect.top) / rect.height, 0, 1) };
  };
  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (jobRef.current) return;
    if (event.button === 1 || (event.button === 0 && spaceHeld)) {
      // Pan the zoomed board.
      const host = stage.current;
      if (!host) return;
      event.preventDefault();
      pan.current = { x: event.clientX, y: event.clientY, left: host.scrollLeft, top: host.scrollTop };
      try { board.current?.setPointerCapture(event.pointerId); } catch { /* the pointer is gone */ }
      return;
    }
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('.layout-starters')) return;
    const handle = target.dataset.handle || '';
    const element = target.closest<HTMLElement>('.layout-box');
    let item = element ? region(element.dataset.id || '') : null;
    let through: string | null = null;
    // Ctrl-drag draws over boxes (a background behind them); so does any drag on a locked box.
    if (item && (item.locked || ((event.ctrlKey || event.metaKey) && !handle))) { through = item.id; item = null; }
    const origin = point(event);
    const before = JSON.stringify(latest.current);
    if (!item) {
      item = newRegion(tool, { x: origin.x, y: origin.y, w: 0, h: 0 });
      put({ ...latest.current, regions: [item, ...latest.current.regions] });
    }
    setSelected(item.id);
    setPop(null);
    event.preventDefault();
    board.current?.focus({ preventScroll: true });
    try { board.current?.setPointerCapture(event.pointerId); } catch { /* the pointer is gone; the drag ends at pointerup */ }
    drag.current = { id: item.id, mode: handle || (item.w === 0 ? 'draw' : 'move'), start: { x: item.x, y: item.y, w: item.w, h: item.h }, origin, before, moved: false, through };
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pan.current) {
      const host = stage.current;
      if (host) { host.scrollLeft = pan.current.left - (event.clientX - pan.current.x); host.scrollTop = pan.current.top - (event.clientY - pan.current.y); }
      return;
    }
    const current = drag.current;
    if (!current) return;
    const at = point(event);
    if (Math.abs(at.x - current.origin.x) + Math.abs(at.y - current.origin.y) > 0.002) current.moved = true;
    const snap = prefs.snap && !event.altKey;
    const { rect, guides: lines } = dragRect({ mode: current.mode, start: current.start, origin: current.origin, point: at, size,
      lines: snap ? snapLines(latest.current.regions, current.id, guideLines(prefs.guides)) : null, board: snap ? boardSize : null,
      shift: event.shiftKey, centred: event.ctrlKey || event.metaKey });
    setGuides(lines);
    put({ ...latest.current, regions: latest.current.regions.map((item) => (item.id === current.id ? { ...item, ...rect } : item)) });
  };
  const pointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pan.current) { pan.current = null; try { board.current?.releasePointerCapture(event.pointerId); } catch { /* released */ } return; }
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setGuides([]);
    try { board.current?.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    const item = region(current.id);
    if (current.mode === 'draw' && (!item || item.w * size.width < 12 || item.h * size.height < 12)) {
      // A click, not a drag: it selects the box under it (a locked one too), or clears the selection.
      put(JSON.parse(current.before));
      setSelected(current.through);
      if (current.through) setTab('boxes');
      return;
    }
    if (!current.moved && current.mode !== 'draw') { setTab('boxes'); return; }
    const h = history.current;
    h.past.push(current.before); h.future = []; h.key = '';
    writeStore(STORE, { state: latest.current, at: Date.now() });
    bump();
    setTab('boxes');
    if (current.mode === 'draw' && !context.phone) requestAnimationFrame(() => boxCaption.current?.focus({ preventScroll: true }));
  };
  const contextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (jobRef.current) return;
    const element = (event.target as HTMLElement).closest<HTMLElement>('.layout-box');
    const item = element ? region(element.dataset.id) : null;
    if (item) setSelected(item.id);
    openPop(item ? 'menu' : 'place', { x: event.clientX, y: event.clientY }, item ? { target: item.id } : { at: point(event) });
  };

  // ---------- reference, import and the clipboard ----------
  const placeReference = async (file: File, announce = true) => {
    const url = URL.createObjectURL(file);
    const probe = new Image();
    probe.src = url;
    try { await probe.decode(); } catch { URL.revokeObjectURL(url); say(`${file.name || 'That image'} can’t be read as an image.`, { tone: 'warning' }); return false; }
    if (sessionReference?.url && sessionReference.url !== url) URL.revokeObjectURL(sessionReference.url);
    sessionReference = { url, name: file.name || 'Pasted image', width: probe.naturalWidth, height: probe.naturalHeight };
    setReference(sessionReference);
    if (extractAfterPick.current) { extractAfterPick.current = false; extract(); return true; }
    if (announce) say('The reference is under the boxes. It is never sent with the prompt.', assist ? { action: { label: 'Extract layout + prompt', run: () => extract() } } : {});
    return true;
  };
  const clearReference = () => { if (sessionReference) URL.revokeObjectURL(sessionReference.url); sessionReference = null; setReference(null); };

  const importText = async (text: string, source: string) => {
    const layout = findLayout(text);
    if (!layout) { say(`${source} holds no MOSS, Ming or Ideogram layout.`, { tone: 'warning' }); return; }
    try {
      const { state: imported, note, from } = await readLayout(layout, size, format);
      set(imported);
      setSelected(null);
      const converted = from !== format ? ` (a ${NAMES[from]} prompt, now ${NAMES[format]})` : '';
      say(note || `Imported ${plural(imported.regions.length, 'box', 'boxes')} from ${source}${converted}. Undo brings back what you had.`, { action: { label: 'Undo', run: undo } });
    } catch (failure) { say((failure as Error).message, { tone: 'warning' }); }
  };
  /** Images become the reference (a studio PNG offers its layout too); text files are imported. */
  const handleFiles = async (files: File[], { importOnly = false } = {}) => {
    const textFile = files.find((file) => /json|text/.test(file.type) || /\.(json|txt|bbox)$/i.test(file.name));
    if (textFile) { await importText(await textFile.text(), textFile.name); return; }
    const image = files.find((file) => file.type.startsWith('image/'));
    if (!image) { if (files.length) say('Drop an image to trace over, or a layout .json.', { tone: 'warning' }); return; }
    let layout: string | null = null;
    if (image.type === 'image/png') {
      try { for (const text of await pngTexts(await image.arrayBuffer())) { layout = findLayout(text); if (layout) break; } } catch { layout = null; }
    }
    if (importOnly) {
      if (layout) await importText(layout, image.name);
      else say(`${image.name} carries no layout. Use Reference to trace over it instead.`, { tone: 'warning' });
      return;
    }
    if (!(await placeReference(image, !layout))) return;
    if (!layout) return;
    const blank = !latest.current.regions.length && !latest.current.caption.trim() && !latest.current.style.trim();
    if (blank) await importText(layout, image.name);
    else say(`${image.name} is the reference now, and it carries a layout.`, { action: { label: 'Use its layout', run: () => { void importText(layout as string, image.name); } } });
  };
  const paste = (event: React.ClipboardEvent) => {
    const image = clipboardFile(event.clipboardData);
    if (image) { event.preventDefault(); setPop(null); void handleFiles([image]); return; }
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea') && !target.closest('.layout-pad')) return;
    const text = event.clipboardData.getData('text/plain');
    if (text && findLayout(text)) { event.preventDefault(); setPop(null); setPad(''); void importText(text, 'the clipboard'); }
  };
  /** One-tap clipboard reads need a secure page (HTTPS or localhost); elsewhere the paste pad or Ctrl+V does it. */
  const canRead = typeof window !== 'undefined' && window.isSecureContext && Boolean(navigator.clipboard?.read);
  const pasteImage = async () => {
    if (!canRead) { say('This page can’t read the clipboard. Press Ctrl+V on the board, or paste into the pad in Import.', { tone: 'warning' }); return; }
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((name) => name.startsWith('image/'));
        if (type) { const blob = await item.getType(type); await handleFiles([new File([blob], `Pasted image.${type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'}`, { type })]); return; }
      }
      say('There is no picture on the clipboard.', { tone: 'warning' });
    } catch { say('The browser didn’t allow reading the clipboard.', { tone: 'warning' }); }
  };
  const pasteText = async () => {
    try { const text = await navigator.clipboard.readText(); setPop(null); await importText(text, 'the clipboard'); }
    catch { say('The browser didn’t allow reading the clipboard. Paste into the pad instead.', { tone: 'warning' }); }
  };

  // ---------- the assistant ----------
  React.useEffect(() => {
    if (!assist || tab !== 'ai' || models) return;
    let alive = true;
    fetch(`/api/moss-layout/ai?profileId=${encodeURIComponent(context.profile?.id || '')}`, { cache: 'no-store' })
      .then((response) => response.json()).then((found) => { if (alive) setModels(found); }, () => { if (alive) setModels({ writer: false, detector: false }); });
    return () => { alive = false; };
  }, [assist, tab, models]);

  /** The reference as the board shows it (same crop, letterbox or stretch), at most AI_SIDE px: what you see is what the model reads. */
  const referenceData = async () => {
    const ref = sessionReference as Reference;
    const image = new Image();
    image.src = ref.url;
    await image.decode();
    const k = Math.min(1, AI_SIDE / Math.max(size.width, size.height));
    const out = { width: Math.round(size.width * k), height: Math.round(size.height * k) };
    const canvas = document.createElement('canvas');
    canvas.width = out.width; canvas.height = out.height;
    const draw = canvas.getContext('2d')!;
    draw.fillStyle = '#000'; draw.fillRect(0, 0, out.width, out.height);
    draw.imageSmoothingQuality = 'high';
    const rect = fitRect(ref, prefs.fit, out, size);
    draw.drawImage(image, rect.x, rect.y, rect.w, rect.h);
    return canvas.toDataURL('image/jpeg', 0.92);
  };
  const sceneNote = () => latest.current.caption.trim() || latest.current.style.trim();
  const aiLayout = (regions: Region[]) => ({ caption: sceneNote(), meta: latest.current.meta, items: regionsToGrid(regions) });

  const stopAi = (silent = false) => {
    const running = jobRef.current;
    if (!running) return;
    running.canceled = true;
    if (running.id) void fetch(`/api/jobs/${encodeURIComponent(running.id)}/cancel`, { method: 'POST' }).catch(() => null);
    jobRef.current = null; setJob(null);
    if (!silent) say('Stopped. Nothing was changed.');
  };

  const runAi = async (task: string, extra: Record<string, unknown>, { fresh = false, targets = [], rewrite = false }: AiOptions = {}) => {
    if (jobRef.current) return;
    const body: Record<string, unknown> = { task, width: size.width, height: size.height, fresh, profileId: context.profile?.id, ...extra };
    if (sessionReference && ['image', 'snap', 'ocr', 'describe'].includes(task)) {
      try { body.image = await referenceData(); } catch { say('The reference image can’t be read.', { tone: 'warning' }); return; }
    }
    const running: Job = { task, started: Date.now(), steps: [], id: null, thinking: task === 'describe' || task === 'snap' ? targets : [] };
    jobRef.current = running; setJob({ ...running });
    setNotice(null);
    setPop(null);
    try {
      const started = await fetch('/api/moss-layout/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await started.json().catch(() => ({}));
      if (!started.ok) throw new Error(data.error || `The assistant couldn’t start (${started.status}).`);
      running.id = data.jobId;
      let result: any = null;
      while (!running.canceled) {
        const status = await fetch(`/api/jobs/${encodeURIComponent(running.id as string)}`, { cache: 'no-store' }).then((reply) => reply.json());
        if (status.progress?.steps && status.progress.steps.join() !== running.steps.join()) { running.steps = status.progress.steps; setJob({ ...running }); }
        if (status.status === 'done') { result = status.result; break; }
        if (status.status === 'error') throw new Error(status.error || 'The assistant didn’t finish.');
        if (status.status === 'missing') throw new Error('The assistant stopped: HEISS restarted while it worked. Nothing was changed.');
        if (status.status === 'canceled') return;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (running.canceled || !result) return;
      setLast({ task, extra, targets });
      await applyAi(task, result, { targets, rewrite });
    } catch (failure) {
      if (!running.canceled) {
        setModels(null);
        say((failure as Error).message, { tone: 'warning', action: { label: 'Try again', run: () => { void runAi(task, extra, { fresh, targets, rewrite }); } } });
      }
    } finally {
      if (jobRef.current === running) { jobRef.current = null; setJob(null); }
    }
  };

  const applyAi = async (task: string, result: any, { targets = [], rewrite = false }: AiOptions) => {
    const took = result.cached ? 'instantly (the same request as before)' : `in ${result.seconds} s`;
    const finish = (next: LayoutState, text: string, fresh: string[] = []) => {
      set(next);
      setBorn(new Set(fresh));
      setTimeout(() => setBorn(new Set()), 900);
      if (selected && !next.regions.some((item) => item.id === selected)) setSelected(null);
      say(text, { action: { label: 'Undo', run: undo } });
    };
    const previous = latest.current;
    if (task === 'image' || task === 'text' || task === 'edit') {
      const { state: read } = await readLayout(JSON.stringify(result.layout), size, 'moss');
      let next: LayoutState = { ...read, canvas: previous.canvas };
      // Your palette carries into a planned or edited layout; an image brings its own look.
      if (!next.palette.length && task !== 'image') next.palette = previous.palette;
      if (task === 'edit') {
        if (!next.caption.trim()) next.caption = previous.caption;
        if (!next.meta.length) next.meta = previous.meta;
        next.regions = carryColours(previous.regions, next.regions);
      }
      // A Ming style and lighting you wrote stay; an image writes its own style from what it saw.
      if (task !== 'image') { next.style = previous.style; next.lighting = previous.lighting; }
      next = adaptState(next, format);
      next.regions = keepLocked(previous.regions, next.regions);
      const count = next.regions.length, kept = previous.regions.filter((item) => item.locked).length;
      const what = task === 'image' ? 'Extracted the layout and its prompt' : task === 'text' ? 'Planned the layout' : 'Changed the layout';
      setSelected(null);
      finish(next, `${what}: ${plural(count, 'box', 'boxes')} and ${ming ? 'a style' : 'a summary'}, ${took}.${kept ? ` ${plural(kept, 'locked box', 'locked boxes')} kept.` : ''}`, next.regions.filter((item) => !item.locked).map((item) => item.id));
      return;
    }
    if (task === 'describe') {
      // Items come back in the order they were sent: back to front of the targets.
      const items = result.layout?.items || [];
      const order = targets.slice().reverse();
      const captions = new Map<string, string>();
      items.forEach((item: any, index: number) => {
        const target = previous.regions.find((other) => other.id === order[index]), text = String(item?.caption || '').trim();
        if (target && !target.locked && text && (rewrite || !target.description.trim())) captions.set(target.id, text);
      });
      if (!captions.size) { say(`The assistant wrote no captions for those boxes. Try again, or add a scene note to the ${ming ? 'style' : 'summary'}.`, { tone: 'warning' }); return; }
      let next = { ...previous, regions: previous.regions.map((item) => (captions.has(item.id) ? { ...item, description: captions.get(item.id) as string } : item)) };
      if (!next.caption.trim() && result.layout?.caption) next.caption = result.layout.caption;
      if (!next.meta.length && Array.isArray(result.layout?.meta)) next.meta = result.layout.meta.slice(0, 6);
      next = adaptState(next, format);
      finish(next, `Wrote ${plural(captions.size, 'caption')}, ${took}.`);
      return;
    }
    const found = (result.boxes || []).map((item: { label: string; bbox: number[] }) => ({ ...item, rect: gridRect(item.bbox) }));
    if (task === 'snap') {
      const target = previous.regions.find((item) => item.id === targets[0]);
      if (!target || target.locked) return;
      if (!found.length) { say(`“${(target.description || target.text).slice(0, 60)}” wasn’t found in the reference.`, { tone: 'warning' }); return; }
      const best = found.reduce((top: any, item: any) => (overlap(item.rect, target) > overlap(top.rect, target) ? item : top), found[0]);
      finish({ ...previous, regions: previous.regions.map((item) => (item.id === target.id ? { ...item, ...best.rect } : item)) }, `Box ${pad2(numberOf(target))} fits “${best.label.slice(0, 50)}” now, ${took}.`, [target.id]);
      return;
    }
    if (task === 'ocr') {
      const lines = ocrLines(result.boxes || [], size);
      if (!lines.length) { say('No lettering was found in the reference.', { tone: 'warning' }); return; }
      const regions = previous.regions.map((item) => ({ ...item }));
      const added: Region[] = [];
      let filled = 0;
      for (const line of lines) {
        const rect = gridRect(line.bbox);
        const existing = regions.find((item) => item.kind === 'text' && overlap(item, rect) >= 0.3);
        if (existing) { if (!existing.text.trim() && !existing.locked) { existing.text = line.text; filled += 1; } continue; }
        added.push({ ...newRegion('text', rect), text: line.text });
      }
      finish({ ...previous, regions: [...added.reverse(), ...regions] }, `Found ${plural(lines.length, 'line')} of lettering: ${plural(added.length, 'new text box', 'new text boxes')}${filled ? `, ${filled} filled in` : ''}, ${took}. Describe their look for the best match.`, added.map((item) => item.id));
    }
  };

  /** Extract layout + prompt: without a reference it asks for an image first, then runs. */
  const extract = (fresh = false) => {
    if (!sessionReference) { extractAfterPick.current = true; referenceInput.current?.click(); return; }
    void runAi('image', { labels: prefs.labels, findText: prefs.lettering }, { fresh });
  };
  const plan = (fresh = false) => {
    if (!request.trim()) { say('Write what the picture should show first.', { tone: 'warning' }); requestBox.current?.focus(); return; }
    void runAi('text', { request }, { fresh });
  };
  const change = (fresh = false) => {
    if (!request.trim()) { say('Write what to change first.', { tone: 'warning' }); requestBox.current?.focus(); return; }
    if (!latest.current.regions.length) { plan(fresh); return; }
    void runAi('edit', { request, layout: aiLayout(latest.current.regions) }, { fresh });
  };
  const describe = (list: Region[], rewrite = false, fresh = false) => {
    if (!list.length) return;
    void runAi('describe', { layout: aiLayout(list), request: sceneNote() }, { fresh, targets: list.map((item) => item.id), rewrite });
  };
  const snapBox = (fresh = false) => {
    const target = region(selected);
    if (!target || target.locked) return;
    const query = target.description.trim() || target.text.trim() || target.tags[0] || '';
    if (!query) { say('Give the box a caption first, so the assistant knows what to look for.', { tone: 'warning' }); return; }
    void runAi('snap', { query: query.slice(0, 300) }, { fresh, targets: [target.id] });
  };
  const again = () => {
    if (!last) return;
    if (last.task === 'describe') { describe(last.targets.map(region).filter(Boolean) as Region[], true, true); return; }
    if (last.task === 'snap') { snapBox(true); return; }
    void runAi(last.task, last.task === 'edit' ? { ...last.extra, layout: aiLayout(latest.current.regions) } : last.extra, { fresh: true });
  };
  const askAi = () => { setTab('ai'); requestAnimationFrame(() => requestBox.current?.focus()); };

  // ---------- output ----------
  const issue = error ? issueFromError(error.message, { format, count: latest.current.regions.length }) : null;
  const issueBox = issue?.number ? latest.current.regions[latest.current.regions.length - issue.number] : null;
  const fixIssue = () => {
    if (!issueBox) return;
    select(issueBox.id);
    requestAnimationFrame(() => boxCaption.current?.focus());
  };
  const isLayout = (result: Compiled) => ming ? latest.current.regions.length > 0 : result.mode === 'layout';
  const apply = async () => {
    try {
      const result = await call<Compiled>('serialize', payloadFor(format, latest.current, sizeOf(live.current.view)));
      if (!result.prompt.trim() || (ming && !latest.current.regions.length && !latest.current.style.trim())) { say(`Write ${ming ? 'a style' : 'a summary'} or add a box first.`, { tone: 'warning' }); return; }
      if (!ming && result.mode === 'layout') rememberSize(result.prompt, sizeOf(live.current.view));
      try { localStorage.removeItem(STORE); } catch { /* ignore */ }
      const before = String(live.current.view.prompt || '');
      live.current.view.setPrompt?.(result.prompt);
      const count = latest.current.regions.length;
      live.current.showToast(isLayout(result) ? `Layout with ${plural(count, 'box', 'boxes')} is in the prompt` : ming ? 'The Ming prompt is in the prompt box' : 'The summary is in the prompt', 'success', { action: { label: 'Undo', onClick: () => live.current.view.setPrompt?.(before) } });
      close();
    } catch (failure) {
      setError(failure as Error);
      say((failure as Error).message, { tone: 'warning' });
    }
  };
  const shown = view === format ? (compiled?.prompt ? pretty(compiled.prompt) : '') : other?.view === view ? other.text : '';
  const shownWarnings = view === format ? compiled?.warnings || [] : other?.view === view ? other.warnings : [];
  const copyText = async (text: string, what: string) => {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); say(`${what} copied.`); } catch { say('The browser blocked the clipboard here.', { tone: 'warning' }); }
  };
  const saveJson = () => {
    if (!shown) return;
    const blob = new Blob([shown], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `layout-${view}-${size.width}x${size.height}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const current = region(selected);
  const regions = state.regions;
  const empty = regions.filter((item) => !item.locked && !item.description.trim());
  const textCount = regions.filter((item) => item.kind === 'text').length;
  const foot = error
    ? <span className="is-error">{issue?.text || error.message}{issueBox ? <button type="button" className="layout-link" onClick={fixIssue}>Show</button> : null}</span>
    : checking && !compiled ? <span className="layout-muted">Checking…</span>
    : compiled?.prompt ? <span>{isLayout(compiled) ? `${NAMES[format]} layout · ${plural(regions.length, 'box', 'boxes')}${textCount ? `, ${textCount} text` : ''}` : ming ? 'Ming prompt (no boxes yet)' : 'Plain prompt (no boxes yet)'} · {size.width} × {size.height}{compiled.warnings?.length ? <span className="layout-flag"> · {compiled.warnings[0]}</span> : null}</span>
    : <span className="layout-muted">{ming ? 'Write a style, or draw a box on the board.' : 'Write a summary, or draw a box on the board.'}</span>;

  const boxes = regions.slice().reverse().map((item, index) => ({ item, number: index + 1 })).reverse();
  const lines = guideLines(prefs.guides);
  const refStyle: React.CSSProperties = reference && prefs.fit === 'actual'
    ? (() => { const w = (100 * reference.width) / size.width, h = (100 * reference.height) / size.height; return { objectFit: 'fill', width: `${w}%`, height: `${h}%`, left: `${(100 - w) / 2}%`, top: `${(100 - h) / 2}%`, opacity: prefs.opacity }; })()
    : { objectFit: prefs.fit as 'cover' | 'contain' | 'fill', opacity: prefs.opacity };
  const geometry = current ? { x: current.x * size.width, y: current.y * size.height, w: current.w * size.width, h: current.h * size.height } : null;
  const placeTarget = pop?.kind === 'place' && !pop.at && current && !current.locked ? current : null;
  const menuBox = pop?.kind === 'menu' ? region(pop.target) : null;

  const placeMenu = (
    <>
      <p className="layout-pop-head"><strong>Place</strong><span>{placeTarget ? `Shapes move box ${pad2(numberOf(placeTarget))}; splits add ${tool} boxes.` : `Adds ${tool} boxes. Pick the kind in the toolbar.`}</span></p>
      {pop?.at ? <button type="button" className="btn is-small" onClick={() => { setPop(null); addBox(tool, pop.at); }}><CopyPlus size={13} /> Add a {tool} box here</button> : null}
      <p className="layout-pop-label">{placeTarget ? 'Move the selected box' : 'One box'}</p>
      <div className="layout-tiles" role="menu">
        {PLACE_ONE.map(([value, label, columns, rows, cell]) => { const rects = placementRects(columns, rows, cell ? [cell] : null, size, prefs.gutters); return <PlaceTile key={value} label={label} rects={rects} size={size} onPick={() => place(rects, label, placeTarget)} />; })}
      </div>
      <p className="layout-pop-label">Split the canvas</p>
      <div className="layout-tiles" role="menu">
        {PLACE_SPLIT.map(([value, label, columns, rows]) => { const rects = placementRects(columns, rows, allCells(columns, rows), size, prefs.gutters); return <PlaceTile key={value} label={label} rects={rects} size={size} onPick={() => place(rects, label, null)} />; })}
      </div>
      <label className="layout-check"><input type="checkbox" checked={prefs.gutters} onChange={(event) => updatePrefs({ gutters: event.target.checked })} /> Gutters between and around boxes</label>
    </>
  );

  return (
    <div
      ref={panel}
      className={cn('layout-panel', context.phone && 'is-phone', job && 'is-busy')}
      onPaste={paste}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
      onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void handleFiles([...event.dataTransfer.files]); } }}
    >
      <div className="layout-tools">
        <Segmented label="Kind of box to draw" value={tool} options={kinds} onChange={setTool} />
        <Tip content="Add a box in the middle"><button type="button" className="icon-button" aria-label="Add a box" onClick={() => addBox()}><CopyPlus size={15} /></button></Tip>
        <Tip content="Place a box or split the canvas (P)"><button type="button" data-pop="place" className={cn('icon-button', pop?.kind === 'place' && 'active')} aria-label="Place and split" aria-expanded={pop?.kind === 'place'} onClick={(event) => openPop('place', event.currentTarget)}><LayoutGrid size={15} /></button></Tip>
        <span className="layout-tools-gap" />
        <Tip content="A picture to trace over (never sent)"><button type="button" className="btn layout-tool-text" aria-label="Reference image" onClick={() => referenceInput.current?.click()}><ImagePlus size={14} /><span>Reference</span></button></Tip>
        <Tip content="Import a MOSS, Ming or Ideogram layout (I)"><button type="button" data-pop="import" className="btn layout-tool-text" aria-label="Import a layout" aria-expanded={pop?.kind === 'import'} onClick={(event) => openPop('import', event.currentTarget)}><FileUp size={14} /><span>Import</span></button></Tip>
        <Tip content="Guides"><button type="button" data-pop="guides" className={cn('icon-button', prefs.guides !== 'off' && 'active')} aria-label="Guides" aria-expanded={pop?.kind === 'guides'} onClick={(event) => openPop('guides', event.currentTarget)}><Grid3x3 size={15} /></button></Tip>
        <Tip content={prefs.snap ? 'Snapping on (hold Alt to skip)' : 'Snapping off'}><button type="button" className={cn('icon-button', prefs.snap && 'active')} aria-pressed={prefs.snap} aria-label="Snap to edges" onClick={() => updatePrefs({ snap: !prefs.snap })}><Magnet size={15} /></button></Tip>
        <span className="layout-zoom" role="group" aria-label="Zoom">
          <Tip content="Zoom out (−)"><button type="button" className="icon-button" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => zoomStep(-1)}><ZoomOut size={15} /></button></Tip>
          <Tip content="Fit the board (0)"><button type="button" className="layout-zoom-value" aria-label="Fit the board" onClick={() => setZoom(1)}>{zoom === 1 ? <Maximize size={13} /> : `${Math.round(zoom * 100)}%`}</button></Tip>
          <Tip content="Zoom in (+, Ctrl+wheel)"><button type="button" className="icon-button" aria-label="Zoom in" disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} onClick={() => zoomStep(1)}><ZoomIn size={15} /></button></Tip>
        </span>
        <Tip content="Undo (Ctrl+Z)"><button type="button" className="icon-button" aria-label="Undo" disabled={!history.current.past.length} onClick={undo}><Undo2 size={15} /></button></Tip>
        <Tip content="Redo (Ctrl+Y)"><button type="button" className="icon-button" aria-label="Redo" disabled={!history.current.future.length} onClick={redo}><Redo2 size={15} /></button></Tip>
        <Tip content="Clear the layout"><button type="button" className="icon-button" aria-label="Clear the layout" disabled={!regions.length && !state.caption && !state.style} onClick={() => { set({ ...emptyState(), regions: regions.filter((item) => item.locked) }); setSelected(null); say('Cleared. Undo brings it back; locked boxes stay.', { action: { label: 'Undo', run: undo } }); }}><Trash2 size={15} /></button></Tip>
        <input ref={referenceInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) { extractAfterPick.current = false; return; } void placeReference(file).then((placed) => { if (placed && assist) setTab('ai'); }); }} />
        <input ref={importInput} type="file" accept=".json,.txt,.bbox,application/json,text/plain,image/png" hidden onChange={(event) => { const files = [...(event.target.files || [])]; event.target.value = ''; void handleFiles(files, { importOnly: true }); }} />
      </div>

      <div className="layout-main">
        <div className="layout-stage-wrap">
          <div className={cn('layout-stage', zoom > 1 && 'is-zoomed', spaceHeld && 'is-panning')} ref={stage}>
            <div
              ref={board}
              className="layout-board"
              style={{ width: boardSize.width, height: boardSize.height }}
              tabIndex={0}
              role="application"
              aria-label={`Layout board, ${size.width} by ${size.height}. Drag to draw a ${tool} box; drag a box to move it; right-click for more.`}
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onContextMenu={contextMenu}
              onPointerCancel={() => { pan.current = null; if (drag.current) { put(JSON.parse(drag.current.before)); drag.current = null; setGuides([]); } }}
            >
              {reference ? <SafeImg className="layout-reference" src={reference.url} style={refStyle} draggable={false} /> : null}
              {lines.length ? (
                <div className="layout-lines" aria-hidden="true">
                  {lines.flatMap((at) => [<i key={`x${at}`} className={cn('is-x', isGolden(at) && 'is-golden')} style={{ left: `${at * 100}%` }} />, <i key={`y${at}`} className={cn('is-y', isGolden(at) && 'is-golden')} style={{ top: `${at * 100}%` }} />])}
                </div>
              ) : null}
              {boxes.slice().reverse().map(({ item, number }) => (
                <div
                  key={item.id}
                  data-id={item.id}
                  className={cn('layout-box', `is-${item.kind}`, item.id === selected && 'is-selected', item.locked && 'is-locked', issueBox?.id === item.id && 'is-issue', job?.thinking.includes(item.id) && 'is-thinking', born.has(item.id) && 'is-born')}
                  style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%`, width: `${item.w * 100}%`, height: `${item.h * 100}%`, zIndex: regions.length - regions.indexOf(item) }}
                >
                  <span className="layout-box-tag">{pad2(number)}{item.locked ? <Lock size={9} /> : null}</span>
                  <span className="layout-box-text">{item.kind === 'text' ? item.text || item.description : item.description || item.tags.join(', ')}</span>
                  {item.id === selected && !item.locked ? HANDLES.map((handle) => <i key={handle} data-handle={handle} className={`layout-handle is-${handle}`} />) : null}
                </div>
              ))}
              {guides.map((guide) => <i key={`${guide.axis}${guide.at}`} className={`layout-guide is-${guide.axis}`} style={guide.axis === 'x' ? { left: `${guide.at * 100}%` } : { top: `${guide.at * 100}%` }} />)}
              {loaded && !regions.length ? (
                <div className="layout-starters">
                  <p>Drag on the board to draw a box, or start from one of these.</p>
                  <div className="layout-starts">
                    {assist ? <button type="button" className="btn" onClick={() => extract()}><ScanText size={14} /> From an image</button> : null}
                    {assist ? <button type="button" className="btn" onClick={askAi}><Sparkles size={14} /> Describe it to AI</button> : null}
                    <button type="button" className="btn" data-pop="place" onClick={(event) => openPop('place', event.currentTarget)}><LayoutGrid size={14} /> Quick split</button>
                  </div>
                  <div>
                    {STARTERS.map((starter) => (
                      <button key={starter.id} type="button" className="layout-starter" onClick={() => { set(adaptState({ ...starterState(starter, latest.current.caption), style: latest.current.style, lighting: latest.current.lighting }, format)); say(`${starter.name} placed. Rewrite its captions and words for your picture.`, { action: { label: 'Undo', run: undo } }); }}>
                        <strong>{starter.name}</strong><span>{starter.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <div className="layout-board-row">
            {geometry ? <span className="layout-coords">Box {pad2(numberOf(current as Region))} · {Math.round(geometry.x)}, {Math.round(geometry.y)} · {Math.round(geometry.w)} × {Math.round(geometry.h)} px</span> : <span className="layout-coords">{size.width} × {size.height} px · writes {NAMES[format]}</span>}
            {reference ? (
              <div className="layout-reference-row">
                <span className="layout-reference-name" title={`${reference.name} · ${reference.width} × ${reference.height}`}>{reference.name}</span>
                <Segmented label="How the reference covers the board" value={prefs.fit} options={FITS} onChange={(fit) => updatePrefs({ fit })} />
                <input type="range" min={0.05} max={1} step={0.05} value={prefs.opacity} aria-label="Reference opacity" onChange={(event) => updatePrefs({ opacity: Number(event.target.value) })} />
                <Tip content="Use the picture on the clipboard"><button type="button" className="icon-button" aria-label="Paste a reference" onClick={() => { void pasteImage(); }}><ClipboardPaste size={14} /></button></Tip>
                <Tip content="Remove the reference"><button type="button" className="icon-button" aria-label="Remove the reference" onClick={clearReference}><X size={14} /></button></Tip>
              </div>
            ) : null}
          </div>
        </div>

        <div className="layout-side">
          <Segmented<Tab> label="Panel" value={tab} onChange={setTab} options={[{ value: 'summary', label: ming ? 'Style' : 'Summary' }, { value: 'boxes', label: regions.length ? `Boxes · ${regions.length}` : 'Boxes' }, ...(assist ? [{ value: 'ai' as Tab, label: 'AI' }] : []), { value: 'prompt', label: 'Prompt' }]} />
          <div className="layout-side-body">
            {tab === 'summary' && ming ? (
              <>
                <div className="layout-field">
                  <label htmlFor={fieldId('style')}>Image style</label>
                  <textarea id={fieldId('style')} rows={4} value={state.style} placeholder="Medium, look and finish: a flat editorial poster with risograph grain, bold sans-serif type…" onChange={(event) => edit((old) => ({ ...old, style: event.target.value }), 'style')} />
                </div>
                <div className="layout-field">
                  <label htmlFor={fieldId('lighting')}>Ambient lighting</label>
                  <textarea id={fieldId('lighting')} rows={2} value={state.lighting} placeholder="Soft overcast daylight, gentle shadows…" onChange={(event) => edit((old) => ({ ...old, lighting: event.target.value }), 'lighting')} />
                </div>
                <p className="layout-muted">Ming reads the picture as layers, back to front: each box is one layer, with its own colours and how it sits among the others. Text boxes are quoted exactly once.</p>
              </>
            ) : null}
            {tab === 'summary' && !ming ? (
              <>
                <div className="layout-field">
                  <label htmlFor={fieldId('caption')}>Summary</label>
                  <textarea id={fieldId('caption')} ref={caption} rows={4} value={state.caption} placeholder="The whole picture in a sentence or two: subject, setting, look." onChange={(event) => edit((old) => ({ ...old, caption: event.target.value }), 'caption')} />
                </div>
                <div className="layout-field">
                  <label htmlFor={fieldId('meta')}>Meta</label>
                  <ChipInput id={fieldId('meta')} values={state.meta} placeholder="poster, illustration…" suggestions={META_SUGGESTIONS} onChange={(meta) => edit((old) => ({ ...old, meta }))} />
                </div>
                <div className="layout-field">
                  <span className="layout-label" id={fieldId('canvas')}>Canvas</span>
                  <div aria-labelledby={fieldId('canvas')}><Segmented label="Canvas" value={state.canvas} options={CANVASES} onChange={(canvas) => edit((old) => ({ ...old, canvas }))} /></div>
                </div>
                <div className="layout-field">
                  <label htmlFor={fieldId('palette')}>Palette</label>
                  <Colours id={fieldId('palette')} label="Palette" values={state.palette} onChange={(palette) => edit((old) => ({ ...old, palette }))} />
                </div>
              </>
            ) : null}

            {tab === 'boxes' ? (
              <>
                {current ? (
                  <div className="layout-inspector">
                    <div className="layout-inspector-head">
                      <strong>Box {pad2(numberOf(current))}</strong>
                      <Segmented label="Kind" value={current.kind} options={kinds} onChange={(kind) => editRegion(current.id, { kind })} />
                    </div>
                    {current.kind === 'text' ? (
                      <div className="layout-field">
                        <label htmlFor={fieldId('box-text')}>Exact words</label>
                        <textarea id={fieldId('box-text')} rows={2} value={current.text} placeholder="The words, as written" onChange={(event) => editRegion(current.id, { text: event.target.value }, `text-${current.id}`)} />
                      </div>
                    ) : null}
                    <div className="layout-field">
                      <label htmlFor={fieldId('box-caption')}>{current.kind === 'text' ? 'Look of the lettering' : 'What’s in this box'}</label>
                      <textarea id={fieldId('box-caption')} ref={boxCaption} rows={3} value={current.description} placeholder={current.kind === 'text' ? 'Large white serif title, centred…' : current.kind === 'character' ? 'Who they are, what they wear and do…' : 'What it is, how it looks…'} onChange={(event) => editRegion(current.id, { description: event.target.value }, `caption-${current.id}`)} />
                    </div>
                    <div className="layout-field">
                      <label htmlFor={fieldId('box-relation')}>{ming ? 'Hierarchy and relation' : 'Relation to other boxes'}</label>
                      <textarea id={fieldId('box-relation')} rows={2} value={current.relation} placeholder={current.kind === 'text' ? 'Above the product, the largest type on the page…' : 'In front of the forest, below the title…'} onChange={(event) => editRegion(current.id, { relation: event.target.value }, `relation-${current.id}`)} />
                    </div>
                    {!ming ? (
                      <div className="layout-field">
                        <label htmlFor={fieldId('box-tags')}>Tags</label>
                        <ChipInput id={fieldId('box-tags')} values={current.tags} placeholder="red scarf, smiling…" onChange={(tags) => editRegion(current.id, { tags })} />
                      </div>
                    ) : null}
                    <div className="layout-field">
                      <label htmlFor={fieldId('box-colours')}>Colours</label>
                      <Colours id={fieldId('box-colours')} label="Box colours" values={current.colors} onChange={(colors) => editRegion(current.id, { colors })} />
                    </div>
                    {geometry ? (
                      <div className="layout-field">
                        <span className="layout-label">Position (px)</span>
                        <div className="layout-geometry">
                          {(['x', 'y', 'w', 'h'] as const).map((key) => <PixelField key={key} label={key.toUpperCase()} value={geometry[key]} disabled={current.locked} onCommit={(value) => editRegion(current.id, pixelRect(current, { [key]: value }, size))} />)}
                        </div>
                        <div className="layout-aligns" role="group" aria-label="Align to the canvas">
                          {ALIGNS.map(({ where, label, icon: Icon }) => <Tip key={where} content={label}><button type="button" className="icon-button" aria-label={label} disabled={current.locked} onClick={() => editRegion(current.id, alignRect(current, where))}><Icon size={15} /></button></Tip>)}
                        </div>
                      </div>
                    ) : null}
                    <div className="layout-inspector-tools">
                      <Tip content={current.locked ? 'Unlock (L)' : 'Lock: the assistant and drags leave it alone (L)'}><button type="button" className={cn('icon-button', current.locked && 'active')} aria-pressed={Boolean(current.locked)} aria-label="Lock the box" onClick={() => editRegion(current.id, { locked: !current.locked || undefined })}>{current.locked ? <Lock size={15} /> : <LockOpen size={15} />}</button></Tip>
                      <Tip content="Bring to front (Shift+])"><button type="button" className="icon-button" aria-label="Bring to front" disabled={regions[0]?.id === current.id} onClick={() => restack(current.id, true, true)}><ChevronsUp size={15} /></button></Tip>
                      <Tip content="Bring forward (])"><button type="button" className="icon-button" aria-label="Bring forward" disabled={regions[0]?.id === current.id} onClick={() => restack(current.id, true)}><ArrowUp size={15} /></button></Tip>
                      <Tip content="Send back ([)"><button type="button" className="icon-button" aria-label="Send back" disabled={regions.at(-1)?.id === current.id} onClick={() => restack(current.id, false)}><ArrowDown size={15} /></button></Tip>
                      <Tip content="Send to back (Shift+[)"><button type="button" className="icon-button" aria-label="Send to back" disabled={regions.at(-1)?.id === current.id} onClick={() => restack(current.id, false, true)}><ChevronsDown size={15} /></button></Tip>
                      <Tip content="Duplicate (Ctrl+D)"><button type="button" className="icon-button" aria-label="Duplicate" onClick={() => duplicate(current.id)}><Copy size={15} /></button></Tip>
                      <Tip content="Delete (Del)"><button type="button" className="icon-button" aria-label="Delete the box" disabled={current.locked} onClick={() => remove(current.id)}><Trash2 size={15} /></button></Tip>
                    </div>
                  </div>
                ) : null}
                {boxes.length ? (
                  <ul className="layout-list" aria-label="Boxes, front first">
                    {boxes.map(({ item, number }) => (
                      <li
                        key={item.id}
                        draggable
                        className={cn(dragRow === item.id && 'is-dragging')}
                        onDragStart={(event) => { setDragRow(item.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/x-layout-box', item.id); }}
                        onDragOver={(event) => { if (dragRow) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
                        onDrop={(event) => { if (dragRow) { event.preventDefault(); event.stopPropagation(); moveTo(dragRow, item.id); setDragRow(null); } }}
                        onDragEnd={() => setDragRow(null)}
                      >
                        <button type="button" className={cn('layout-row', item.id === selected && 'active', issueBox?.id === item.id && 'is-issue')} aria-current={item.id === selected || undefined} onClick={() => select(item.id === selected ? null : item.id)}>
                          <GripVertical size={12} className="layout-row-grip" aria-hidden="true" />
                          <span className="layout-row-number">{pad2(number)}</span>
                          <span className="layout-row-kind">{KINDS.find((kind) => kind.value === item.kind)?.label}</span>
                          <span className="layout-row-text">{(item.kind === 'text' ? item.text : '') || item.description || <em>No caption yet</em>}</span>
                          {item.locked ? <Lock size={12} /> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="layout-muted">No boxes yet. Drag on the board to draw one.</p>}
                {!current ? (
                  <details className="layout-help" open={!regions.length}>
                    <summary>How it works</summary>
                    <p className="layout-muted">Each box is one {ming ? 'layer' : 'item'}: draw it where it goes, say what is in it, and for text, the exact words. {ming ? 'Ming reads the layers back to front, with their colours and relations.' : 'The summary describes the whole picture; boxes add where things go.'} Use layout writes the prompt; drag the rows to restack.</p>
                    <dl className="layout-keys">{SHORTCUTS.filter(([keysText]) => !(ming && keysText.startsWith('O · C'))).map(([keysText, what]) => <React.Fragment key={keysText}><dt>{keysText}</dt><dd>{what}</dd></React.Fragment>)}</dl>
                  </details>
                ) : null}
              </>
            ) : null}

            {tab === 'ai' && assist ? (
              <div className="layout-ai">
                {models ? (
                  <p className="layout-models">
                    <span className={cn(models.writer ? 'is-ok' : 'is-off')}>Writer {models.writer ? 'ready' : 'not loaded'}</span>
                    <span className={cn(models.detector ? 'is-ok' : 'is-off')}>Detector {models.detector ? 'ready' : 'not loaded'}</span>
                  </p>
                ) : null}
                <section>
                  <h3>From an image</h3>
                  {reference ? (
                    <div className="layout-ref-card">
                      <SafeImg src={reference.url} alt="" draggable={false} />
                      <div><strong title={reference.name}>{reference.name}</strong><span>{reference.width} × {reference.height}</span></div>
                      <button type="button" className="btn is-small" onClick={() => referenceInput.current?.click()}>Replace…</button>
                      <button type="button" className="btn is-small" onClick={() => { void pasteImage(); }}>Paste</button>
                    </div>
                  ) : (
                    <p className="layout-muted">Add an image to read its layout, lettering and look into boxes and {ming ? 'a style' : 'a summary'}. Paste or drop one anywhere here, too.</p>
                  )}
                  <div className="layout-field">
                    <label htmlFor={fieldId('labels')}>Only look for (optional)</label>
                    <input id={fieldId('labels')} className="layout-input" value={prefs.labels} placeholder="knight, lantern" autoComplete="off" onChange={(event) => updatePrefs({ labels: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); extract(); } }} />
                  </div>
                  <label className="layout-check"><input type="checkbox" checked={prefs.lettering} onChange={(event) => updatePrefs({ lettering: event.target.checked })} /> Read lettering into text boxes</label>
                  <div className="layout-actions">
                    <button type="button" className="btn is-primary" onClick={() => extract()}><Sparkles size={14} /> Extract layout + prompt</button>
                    {reference ? <button type="button" className="btn" onClick={() => { void runAi('ocr', {}); }}><ScanText size={14} /> Lettering</button> : null}
                    {reference && current && !current.locked ? <button type="button" className="btn" onClick={() => snapBox()}>Fit box {pad2(numberOf(current))}</button> : null}
                    {!reference ? <button type="button" className="btn" onClick={() => { void pasteImage(); }}><ClipboardPaste size={14} /> Paste image</button> : null}
                  </div>
                </section>
                <section>
                  <h3>From words</h3>
                  <div className="layout-field">
                    <label htmlFor={fieldId('request')}>{regions.length ? 'What to change' : 'The picture you want'}</label>
                    <textarea id={fieldId('request')} ref={requestBox} rows={3} value={request} placeholder={regions.length ? 'Move the title to the top, add a cat on the left…' : 'A night-market poster, a big neon title, two friends under umbrellas…'} onChange={(event) => setRequest(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); if (regions.length) change(); else plan(); } }} />
                  </div>
                  <div className="layout-actions">
                    {regions.length ? <button type="button" className="btn is-primary" onClick={() => change()}>Change this layout</button> : null}
                    <button type="button" className={cn('btn', !regions.length && 'is-primary')} onClick={() => plan()}>{regions.length ? 'New layout instead' : 'Plan a layout'}</button>
                  </div>
                </section>
                {regions.length ? (
                  <section>
                    <h3>Captions</h3>
                    <div className="layout-actions">
                      {empty.length ? <button type="button" className="btn" onClick={() => describe(empty)}>Describe {plural(empty.length, 'empty box', 'empty boxes')}</button> : null}
                      {current && !current.locked ? <button type="button" className="btn" onClick={() => describe([current], true)}>Rewrite box {pad2(numberOf(current))}</button> : null}
                      {!empty.length && !current ? <span className="layout-muted">Every box has a caption. Select one to rewrite it.</span> : null}
                    </div>
                  </section>
                ) : null}
                {last ? <button type="button" className="btn" onClick={again}>Another take</button> : null}
                <p className="layout-muted">Runs in your ComfyUI. Every result is one Undo away, and locked boxes are kept.{ming ? ' Results are written as Ming layers.' : ''}</p>
              </div>
            ) : null}

            {tab === 'prompt' ? (
              <div className="layout-prompt">
                <Segmented<View> label="Show the layout as" value={view} onChange={setView} options={[{ value: format, label: `${NAMES[format]} (this model)` }, ...(['moss', 'ming', 'ideogram'] as View[]).filter((value) => value !== format).map((value) => ({ value, label: NAMES[value] }))]} />
                {view !== format ? <p className="layout-muted">{view === 'ideogram' ? 'An Ideogram 4 caption: the summary, the style and the boxes front first, on a 0-1000 grid. Characters become objects.' : `The same boxes written for ${NAMES[view]}; empty fields are filled from the ${ming ? 'style' : 'summary'}.`}</p> : null}
                <pre className="layout-code" tabIndex={0} aria-label="The prompt">{shown || (error && view === format ? issue?.text || error.message : 'Nothing to show yet.')}</pre>
                {shownWarnings.length ? <ul className="layout-warnings">{shownWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
                <div className="layout-actions">
                  <button type="button" className="btn" disabled={!shown} onClick={() => { void copyText(view === format && compiled?.prompt ? compiled.prompt : shown, `The ${NAMES[view]} prompt`); }}><Copy size={14} /> Copy</button>
                  <button type="button" className="btn" disabled={!shown} onClick={saveJson}><Download size={14} /> Save .json</button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {pop ? (
        <div className={cn('layout-pop', `is-${pop.kind}`)} style={{ left: pop.x, top: pop.y }} role="dialog" aria-label={pop.kind === 'menu' ? 'Box menu' : pop.kind}>
          {pop.kind === 'place' ? placeMenu : null}
          {pop.kind === 'guides' ? (
            <div role="menu" aria-label="Guides" className="layout-menu">
              {GUIDES.map((guide) => <button key={guide.value} type="button" role="menuitemradio" aria-checked={prefs.guides === guide.value} className={cn('layout-menu-item', prefs.guides === guide.value && 'active')} onClick={() => { updatePrefs({ guides: guide.value }); setPop(null); }}>{guide.label}</button>)}
            </div>
          ) : null}
          {pop.kind === 'import' ? (
            <>
              <p className="layout-pop-head"><strong>Import a layout</strong><span>MOSS, Ming or Ideogram 4 JSON, a .bbox or .txt file, or a studio PNG. It becomes a {NAMES[format]} layout.</span></p>
              <div className="layout-actions">
                <button type="button" className="btn is-small" onClick={() => { setPop(null); importInput.current?.click(); }}><FileUp size={13} /> From a file…</button>
                {canRead ? <button type="button" className="btn is-small" onClick={() => { void pasteText(); }}><ClipboardPaste size={13} /> From the clipboard</button> : null}
              </div>
              <textarea className="layout-pad" rows={4} value={pad} placeholder="Or paste a prompt or a picture here" aria-label="Paste pad" onChange={(event) => setPad(event.target.value)} />
              <div className="layout-actions"><button type="button" className="btn is-small is-primary" disabled={!pad.trim()} onClick={() => { const text = pad; setPad(''); setPop(null); void importText(text, 'the paste pad'); }}>Import</button></div>
            </>
          ) : null}
          {pop.kind === 'menu' && menuBox ? (
            <div role="menu" aria-label={`Box ${pad2(numberOf(menuBox))}`} className="layout-menu">
              <p className="layout-pop-label">Box {pad2(numberOf(menuBox))}</p>
              {kinds.map((kind) => <button key={kind.value} type="button" role="menuitemradio" aria-checked={menuBox.kind === kind.value} className={cn('layout-menu-item', menuBox.kind === kind.value && 'active')} onClick={() => { editRegion(menuBox.id, { kind: kind.value }); setPop(null); }}>{kind.label}</button>)}
              <hr />
              <button type="button" role="menuitem" className="layout-menu-item" onClick={() => { editRegion(menuBox.id, { locked: !menuBox.locked || undefined }); setPop(null); }}>{menuBox.locked ? 'Unlock' : 'Lock'}<kbd>L</kbd></button>
              <button type="button" role="menuitem" className="layout-menu-item" onClick={() => { setPop(null); duplicate(menuBox.id); }}>Duplicate<kbd>Ctrl+D</kbd></button>
              <button type="button" role="menuitem" className="layout-menu-item" onClick={() => { restack(menuBox.id, true, true); setPop(null); }}>Bring to front<kbd>⇧]</kbd></button>
              <button type="button" role="menuitem" className="layout-menu-item" onClick={() => { restack(menuBox.id, false, true); setPop(null); }}>Send to back<kbd>⇧[</kbd></button>
              {assist && reference && !menuBox.locked ? <button type="button" role="menuitem" className="layout-menu-item" onClick={() => { setPop(null); snapBox(); }}>Fit to the reference</button> : null}
              {assist && !menuBox.locked ? <button type="button" role="menuitem" className="layout-menu-item" onClick={() => { setPop(null); describe([menuBox], true); }}>Rewrite the caption</button> : null}
              <hr />
              <button type="button" role="menuitem" className="layout-menu-item is-danger" disabled={menuBox.locked} onClick={() => { setPop(null); remove(menuBox.id); }}>Delete<kbd>Del</kbd></button>
            </div>
          ) : null}
        </div>
      ) : null}

      {job ? <AiCard job={job} onStop={() => stopAi()} /> : null}
      {notice ? (
        <p className={cn('layout-status', notice.tone === 'warning' && 'is-warning')} role="status">
          {notice.text}
          {notice.action ? <button type="button" className="layout-link" onClick={() => { notice.action?.run(); }}>{notice.action.label}</button> : null}
          <button type="button" className="layout-status-x" aria-label="Dismiss" onClick={() => setNotice(null)}><X size={12} /></button>
        </p>
      ) : null}
      <div className="layout-foot">
        <p className="layout-summary">{foot}</p>
        <div className="layout-foot-actions">
          <Tip content={`Copy the ${NAMES[format]} prompt (other formats: the Prompt tab)`}><button type="button" className="icon-button" aria-label="Copy the prompt" disabled={!compiled?.prompt} onClick={() => { void copyText(compiled?.prompt || '', 'Prompt'); }}><Copy size={15} /></button></Tip>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="button" className="btn is-primary" disabled={!compiled?.prompt || Boolean(job)} onClick={() => { void apply(); }}><LayoutDashboard size={14} /> Use layout</button>
        </div>
      </div>
    </div>
  );
}

const promptLayout = (context: ExtensionContext) => layoutInfo(String(context.view.prompt || ''));

export const mossLayout: Extension = {
  id: ID,
  name: 'Layout',
  available: (context) => Boolean(context.profile?.layout) && context.profile?.kind !== 'video',
  composer: [{ id: 'open', label: (context) => (promptLayout(context) ? 'Layout: edit the layout in the prompt' : 'Layout: place boxes for the picture'), icon: LayoutDashboard, active: (context) => Boolean(promptLayout(context)), run: (context) => context.openPanel('builder') }],
  createRows: [{ id: 'open', label: 'Layout', icon: LayoutDashboard, detail: (context) => { const info = promptLayout(context); return info ? `${plural(info.items, 'box', 'boxes')} in the prompt` : 'Place boxes for the picture'; }, run: (context) => context.openPanel('builder') }],
  promptLabel: (prompt) => {
    const info = layoutInfo(prompt);
    if (!info) return null;
    return `Layout · ${plural(info.items, 'box', 'boxes')}${info.caption ? ` · ${info.caption}` : ''}`;
  },
  panels: [{ id: 'builder', title: 'Layout', description: 'Boxes for objects, characters and lettering, written as the layout prompt this model reads (MOSS or Ming).', size: 'wide', render: (context, close) => <LayoutPanel context={context} close={close} /> }],
  settings: {
    description: 'Places objects, characters and lettering in boxes on a board the shape of the picture, and writes them as the layout prompt the model reads: MOSS-Image or Ming-Image. It converts MOSS, Ming and Ideogram 4 prompts into each other. With the workflow’s assistant, it can also extract a layout and its prompt from an image or plan one from words.'
  }
};
