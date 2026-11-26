import React from 'react';
import { ArrowDown, ArrowUp, Copy, CopyPlus, FileUp, Grid3x3, ImagePlus, LayoutDashboard, Lock, LockOpen, Magnet, Redo2, ScanText, Sparkles, Square, Trash2, Undo2, X } from 'lucide-react';
import { cn } from './format';
import { Tip } from './components';
import { SafeImg } from './SafeImg';
import { Segmented } from './SettingsDialog';
import {
  CANVASES, KINDS, META_SUGGESTIONS, PLACES, STARTERS, carryColours, clamp, clipboardFile, dragRect, emptyState, findLayout, fingerprint,
  fitRect, foreignKind, gridRect, inferSourceSize, issueFromError, keepLocked, layoutInfo, layoutPayload, newRegion, normalizeLayout, ocrLines,
  overlap, pad2, pngTexts, regionsToGrid, snapLines, splitList, starterState, stateFromImport,
  type Guide, type Imported, type Kind, type LayoutState, type Rect, type Region, type Size
} from './layoutModel.js';
import type { Extension, ExtensionContext } from './extensions';

/*
 * Layout (server/moss-layout.js): a builder for MOSS-Image Layout prompts. A
 * summary (caption, meta, canvas, palette) and boxes on a board the shape of
 * the picture, each an object, a character or a line of text with its own
 * caption. Every change is checked by the MOSS node in ComfyUI, which also
 * writes the prompt; Use layout puts it in the prompt box, and reopening
 * imports it back. A reference image can sit under the boxes (it is never
 * sent with the prompt). With the workflow's assistant models, the AI tab
 * reads a reference into boxes, plans or changes a layout from words, writes
 * captions, fits a box to its object and finds lettering.
 */

const ID = 'layout';
const STORE = 'heiss.layout.v1';
const SIZES = 'heiss.layout.sizes.v1';
const PREFS = 'heiss.layout.prefs.v1';
const AI_SIDE = 896;
const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
const TASK_TITLES: Record<string, string> = { image: 'Reading the image', text: 'Planning a layout', edit: 'Editing the layout', describe: 'Writing captions', snap: 'Fitting the box', ocr: 'Finding lettering' };

type Tab = 'summary' | 'boxes' | 'ai';
type Fit = 'cover' | 'contain';
type Reference = { url: string; name: string; width: number; height: number };
type Notice = { text: string; tone?: 'warning'; action?: { label: string; run: () => void } } | null;
type Compiled = { prompt: string; mode: string; warnings?: string[] };
type Job = { task: string; started: number; steps: string[]; id: string | null; thinking: string[]; canceled?: boolean };
type Models = { writer: boolean; detector: boolean } | null;
type AiOptions = { fresh?: boolean; targets?: string[]; rewrite?: boolean };
type Drag = { id: string; mode: string; start: Rect; origin: { x: number; y: number }; before: string; moved: boolean; through: string | null };

const readStore = <T,>(key: string, fallback: T): T => { try { return (JSON.parse(localStorage.getItem(key) || 'null') as T) ?? fallback; } catch { return fallback; } };
const writeStore = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* a per-device convenience */ } };
const foreignText = (text: string) => { try { return foreignKind(JSON.parse(text)); } catch { return null; } };

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

/** Imports a layout through the node, scaled from its remembered or inferred size to this canvas. */
async function readLayout(original: string, size: Size): Promise<{ state: LayoutState; note: string }> {
  if (foreignText(original)) {
    const imported = await call<Imported>('import', { prompt: original, width: size.width, height: size.height });
    const warnings = (imported.warnings || []).filter((warning) => !/^Converted from/.test(warning));
    return { state: stateFromImport(imported), note: warnings[0] ? `${warnings[0]}${warnings.length > 1 ? ` (and ${warnings.length - 1} more)` : ''}` : '' };
  }
  const { text, size: stated, locks } = normalizeLayout(original);
  const remembered = knownSize(original) || stated;
  const inferred = remembered ? null : inferSourceSize(text, size);
  const from = remembered || inferred || size;
  const imported = await call<Imported>('import', { prompt: text, width: from.width, height: from.height });
  const state = stateFromImport(imported);
  // The node lists items back to front and answers front first.
  if (locks.some(Boolean) && locks.length === state.regions.length) state.regions.forEach((region, index) => { if (locks[locks.length - 1 - index]) region.locked = true; });
  const warnings = imported.warnings || [];
  let note = '';
  if (inferred) note = `This layout reached past ${size.width} × ${size.height}, so it was scaled down to fit, keeping its proportions.`;
  else if (imported.width && (imported.width !== size.width || imported.height !== size.height)) note = `This layout was made for ${imported.width} × ${imported.height}; its boxes now fit ${size.width} × ${size.height}.`;
  else if (warnings.length) note = warnings.length > 1 ? `${warnings[0]} (and ${warnings.length - 1} more)` : warnings[0];
  return { state, note };
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
  const [prefs, setPrefs] = React.useState(() => ({ thirds: true, snap: true, opacity: 0.45, fit: 'cover' as Fit, labels: '', lettering: true, ...readStore<Record<string, unknown>>(PREFS, {}) }));
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
  const stage = React.useRef<HTMLDivElement>(null);
  const board = React.useRef<HTMLDivElement>(null);
  const caption = React.useRef<HTMLTextAreaElement>(null);
  const boxCaption = React.useRef<HTMLTextAreaElement>(null);
  const referenceInput = React.useRef<HTMLInputElement>(null);
  const importInput = React.useRef<HTMLInputElement>(null);
  const drag = React.useRef<Drag | null>(null);
  const [boardSize, setBoardSize] = React.useState<Size>({ width: 0, height: 0 });

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
  const undo = () => {
    const h = history.current;
    const previous = h.past.pop();
    if (!previous) return;
    h.future.push(JSON.stringify(latest.current)); h.key = '';
    const next = JSON.parse(previous) as LayoutState;
    writeStore(STORE, { state: next, at: Date.now() });
    put(next);
  };
  const redo = () => {
    const h = history.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(JSON.stringify(latest.current)); h.key = '';
    const value = JSON.parse(next) as LayoutState;
    writeStore(STORE, { state: value, at: Date.now() });
    put(value);
  };
  const region = (id: string | null) => latest.current.regions.find((item) => item.id === id) || null;
  const numberOf = (item: Region) => latest.current.regions.length - latest.current.regions.findIndex((other) => other.id === item.id);
  const select = (id: string | null) => { setSelected(id); if (id) setTab('boxes'); };

  // ---------- loading ----------
  React.useEffect(() => {
    let alive = true;
    const prompt = String(live.current.view.prompt || '');
    const saved = readStore<{ state?: LayoutState } | null>(STORE, null);
    void (async () => {
      if (layoutInfo(prompt) || foreignText(prompt)) {
        try {
          const { state: imported, note } = await readLayout(prompt, sizeRef.current);
          if (!alive) return;
          put(imported);
          say(note || `The layout in your prompt is back: ${imported.regions.length} ${imported.regions.length === 1 ? 'box' : 'boxes'}.`);
        } catch (failure) {
          if (alive) say((failure as Error).message, { tone: 'warning' });
        }
      } else {
        const text = prompt.trim().startsWith('{') ? '' : prompt;
        put({ ...emptyState(), caption: text });
        if (saved?.state?.regions?.length) say('Your last layout is saved on this device.', { action: { label: 'Bring it back', run: () => { set(saved.state as LayoutState); setNotice(null); } } });
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
      call<Compiled>('serialize', layoutPayload(state, size)).then((result) => {
        if (!alive) return;
        setCompiled(result); setError(null);
      }, (failure) => {
        if (!alive) return;
        setCompiled(null); setError(failure);
      }).finally(() => { if (alive) setChecking(false); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [state, size.width, size.height, loaded]);

  // ---------- the board's size ----------
  React.useLayoutEffect(() => {
    const host = stage.current;
    if (!host) return;
    const fit = () => {
      const k = Math.min(host.clientWidth / size.width, host.clientHeight / size.height);
      setBoardSize({ width: Math.max(1, Math.floor(size.width * k)), height: Math.max(1, Math.floor(size.height * k)) });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    return () => observer.disconnect();
  }, [size.width, size.height]);

  // ---------- keys: undo, redo, delete, nudge ----------
  const keys = React.useRef<(event: KeyboardEvent) => void>(() => undefined);
  keys.current = (event) => {
    const typing = (event.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable="true"]');
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'z' && !typing) { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (mod && event.key.toLowerCase() === 'y' && !typing) { event.preventDefault(); redo(); return; }
    if (mod && event.key === 'Enter') { event.preventDefault(); void apply(); return; }
    if (typing || !selected) return;
    const item = region(selected);
    if (!item) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(item.id); return; }
    const step = event.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (move && !item.locked) {
      event.preventDefault();
      editRegion(item.id, { x: clamp(item.x + move[0] / size.width, 0, 1 - item.w), y: clamp(item.y + move[1] / size.height, 0, 1 - item.h) }, `nudge-${item.id}`);
    }
  };
  React.useEffect(() => {
    const listen = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener('keydown', listen);
    return () => window.removeEventListener('keydown', listen);
  }, []);

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
  /** Forward is towards the front (the start of the list). */
  const restack = (id: string, forward: boolean) => edit((old) => {
    const regions = old.regions.slice();
    const from = regions.findIndex((item) => item.id === id), to = from + (forward ? -1 : 1);
    if (from < 0 || to < 0 || to >= regions.length) return old;
    [regions[from], regions[to]] = [regions[to], regions[from]];
    return { ...old, regions };
  });
  const addBox = () => {
    const w = tool === 'text' ? 0.6 : 0.4, h = Math.min(1, tool === 'text' ? Math.max(0.08, 96 / size.height) : (0.4 * size.width) / size.height);
    const item = newRegion(tool, { x: (1 - w) / 2, y: clamp((1 - h) / 2, 0, 1 - h), w, h });
    edit((old) => ({ ...old, regions: [item, ...old.regions] }));
    select(item.id);
    requestAnimationFrame(() => boxCaption.current?.focus());
  };

  const point = (event: React.PointerEvent) => {
    const rect = board.current!.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width, 0, 1), y: clamp((event.clientY - rect.top) / rect.height, 0, 1) };
  };
  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || jobRef.current) return;
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
    event.preventDefault();
    board.current?.focus({ preventScroll: true });
    try { board.current?.setPointerCapture(event.pointerId); } catch { /* the pointer is gone; the drag ends at pointerup */ }
    drag.current = { id: item.id, mode: handle || (item.w === 0 ? 'draw' : 'move'), start: { x: item.x, y: item.y, w: item.w, h: item.h }, origin, before, moved: false, through };
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const at = point(event);
    if (Math.abs(at.x - current.origin.x) + Math.abs(at.y - current.origin.y) > 0.002) current.moved = true;
    const snap = prefs.snap && !event.altKey;
    const { rect, guides: lines } = dragRect({ mode: current.mode, start: current.start, origin: current.origin, point: at, size,
      lines: snap ? snapLines(latest.current.regions, current.id, prefs.thirds) : null, board: snap ? boardSize : null });
    setGuides(lines);
    put({ ...latest.current, regions: latest.current.regions.map((item) => (item.id === current.id ? { ...item, ...rect } : item)) });
  };
  const pointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
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

  // ---------- reference and import ----------
  const placeReference = async (file: File, announce = true) => {
    const url = URL.createObjectURL(file);
    const probe = new Image();
    probe.src = url;
    try { await probe.decode(); } catch { URL.revokeObjectURL(url); say(`${file.name || 'That image'} can’t be read as an image.`, { tone: 'warning' }); return false; }
    if (sessionReference?.url && sessionReference.url !== url) URL.revokeObjectURL(sessionReference.url);
    sessionReference = { url, name: file.name || 'Pasted image', width: probe.naturalWidth, height: probe.naturalHeight };
    setReference(sessionReference);
    if (announce) say('The reference is under the boxes. It is never sent with the prompt.', assist ? { action: { label: 'Read it into boxes', run: () => { void extract(); } } } : {});
    return true;
  };
  const clearReference = () => { if (sessionReference) URL.revokeObjectURL(sessionReference.url); sessionReference = null; setReference(null); };

  const importText = async (text: string, source: string) => {
    const layout = findLayout(text);
    if (!layout) { say(`${source} holds no MOSS layout.`, { tone: 'warning' }); return; }
    try {
      const { state: imported, note } = await readLayout(layout, size);
      set(imported);
      setSelected(null);
      say(note || `Imported ${imported.regions.length} ${imported.regions.length === 1 ? 'box' : 'boxes'} from ${source}. Undo brings back what you had.`, { action: { label: 'Undo', run: undo } });
    } catch (failure) { say((failure as Error).message, { tone: 'warning' }); }
  };
  /** Images become the reference (a studio PNG offers its layout too); text files are imported. */
  const handleFiles = async (files: File[], { importOnly = false } = {}) => {
    const textFile = files.find((file) => /json|text/.test(file.type) || /\.(json|txt)$/i.test(file.name));
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
    const blank = !latest.current.regions.length && !latest.current.caption.trim();
    if (blank) await importText(layout, image.name);
    else say(`${image.name} is the reference now, and it carries a layout.`, { action: { label: 'Use its layout', run: () => { void importText(layout as string, image.name); } } });
  };
  const paste = (event: React.ClipboardEvent) => {
    const image = clipboardFile(event.clipboardData);
    if (image) { event.preventDefault(); void handleFiles([image]); return; }
    if ((event.target as HTMLElement).closest('input, textarea')) return;
    const text = event.clipboardData.getData('text/plain');
    if (text && findLayout(text)) { event.preventDefault(); void importText(text, 'the clipboard'); }
  };

  // ---------- the assistant ----------
  React.useEffect(() => {
    if (!assist || tab !== 'ai' || models) return;
    let alive = true;
    fetch(`/api/moss-layout/ai?profileId=${encodeURIComponent(context.profile?.id || '')}`, { cache: 'no-store' })
      .then((response) => response.json()).then((found) => { if (alive) setModels(found); }, () => { if (alive) setModels({ writer: false, detector: false }); });
    return () => { alive = false; };
  }, [assist, tab, models]);

  /** The reference as the board shows it (same crop or letterbox), at most AI_SIDE px: what you see is what the model reads. */
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
    const rect = fitRect(ref, prefs.fit, out);
    draw.drawImage(image, rect.x, rect.y, rect.w, rect.h);
    return canvas.toDataURL('image/jpeg', 0.92);
  };
  const aiLayout = (regions: Region[]) => ({ caption: latest.current.caption, meta: latest.current.meta, items: regionsToGrid(regions) });

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
      const { state: imported } = await readLayout(JSON.stringify(result.layout), size);
      const next: LayoutState = { ...imported, canvas: previous.canvas };
      // Your palette carries into a planned or edited layout; an image brings its own look.
      if (!next.palette.length && task !== 'image') next.palette = previous.palette;
      if (task === 'edit') {
        if (!next.caption.trim()) next.caption = previous.caption;
        if (!next.meta.length) next.meta = previous.meta;
        next.regions = carryColours(previous.regions, next.regions);
      }
      next.regions = keepLocked(previous.regions, next.regions);
      const count = next.regions.length, kept = previous.regions.filter((item) => item.locked).length;
      const what = task === 'image' ? 'Read the image' : task === 'text' ? 'Planned the layout' : 'Changed the layout';
      setSelected(null);
      finish(next, `${what}: ${count} ${count === 1 ? 'box' : 'boxes'} and a summary, ${took}.${kept ? ` ${kept} locked ${kept === 1 ? 'box' : 'boxes'} kept.` : ''}`, next.regions.filter((item) => !item.locked).map((item) => item.id));
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
      if (!captions.size) { say('The assistant wrote no captions for those boxes. Try again, or add a scene note to the summary.', { tone: 'warning' }); return; }
      const next = { ...previous, regions: previous.regions.map((item) => (captions.has(item.id) ? { ...item, description: captions.get(item.id) as string } : item)) };
      if (!next.caption.trim() && result.layout?.caption) next.caption = result.layout.caption;
      if (!next.meta.length && Array.isArray(result.layout?.meta)) next.meta = result.layout.meta.slice(0, 6);
      finish(next, `Wrote ${captions.size} ${captions.size === 1 ? 'caption' : 'captions'}, ${took}.`);
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
      finish({ ...previous, regions: [...added.reverse(), ...regions] }, `Found ${lines.length} ${lines.length === 1 ? 'line' : 'lines'} of lettering: ${added.length} new text ${added.length === 1 ? 'box' : 'boxes'}${filled ? `, ${filled} filled in` : ''}, ${took}. Describe their look for the best match.`, added.map((item) => item.id));
    }
  };

  const extract = (fresh = false) => {
    if (!sessionReference) { referenceInput.current?.click(); return; }
    void runAi('image', { labels: prefs.labels, findText: prefs.lettering }, { fresh });
  };
  const plan = (fresh = false) => {
    if (!request.trim()) { say('Write what the picture should show first.', { tone: 'warning' }); return; }
    void runAi('text', { request }, { fresh });
  };
  const change = (fresh = false) => {
    if (!request.trim()) { say('Write what to change first.', { tone: 'warning' }); return; }
    if (!latest.current.regions.length) { plan(fresh); return; }
    void runAi('edit', { request, layout: aiLayout(latest.current.regions) }, { fresh });
  };
  const describe = (list: Region[], rewrite = false, fresh = false) => {
    if (!list.length) return;
    void runAi('describe', { layout: aiLayout(list), request: latest.current.caption }, { fresh, targets: list.map((item) => item.id), rewrite });
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

  // ---------- output ----------
  const issue = error ? issueFromError(error.message) : null;
  const issueBox = issue?.number ? latest.current.regions[latest.current.regions.length - issue.number] : null;
  const fixIssue = () => {
    if (!issueBox) return;
    select(issueBox.id);
    requestAnimationFrame(() => boxCaption.current?.focus());
  };
  const apply = async () => {
    try {
      const result = await call<Compiled>('serialize', layoutPayload(latest.current, sizeOf(live.current.view)));
      if (!result.prompt.trim()) { say('Write a summary or add a box first.', { tone: 'warning' }); return; }
      if (result.mode === 'layout') rememberSize(result.prompt, sizeOf(live.current.view));
      try { localStorage.removeItem(STORE); } catch { /* ignore */ }
      const before = String(live.current.view.prompt || '');
      live.current.view.setPrompt?.(result.prompt);
      const count = latest.current.regions.length;
      live.current.showToast(result.mode === 'layout' ? `Layout with ${count} ${count === 1 ? 'box' : 'boxes'} is in the prompt` : 'The summary is in the prompt', 'success', { action: { label: 'Undo', onClick: () => live.current.view.setPrompt?.(before) } });
      close();
    } catch (failure) {
      setError(failure as Error);
      say((failure as Error).message, { tone: 'warning' });
    }
  };
  const copy = async () => {
    if (!compiled?.prompt) return;
    try { await navigator.clipboard.writeText(compiled.prompt); say('Prompt copied.'); } catch { say('The browser blocked the clipboard here.', { tone: 'warning' }); }
  };

  const current = region(selected);
  const regions = state.regions;
  const empty = regions.filter((item) => !item.locked && !item.description.trim());
  const textCount = regions.filter((item) => item.kind === 'text').length;
  const foot = error
    ? <span className="is-error">{issue?.text || error.message}{issueBox ? <button type="button" className="layout-link" onClick={fixIssue}>Show</button> : null}</span>
    : checking && !compiled ? <span className="layout-muted">Checking…</span>
    : compiled?.prompt ? <span>{compiled.mode === 'layout' ? `Layout · ${regions.length} ${regions.length === 1 ? 'box' : 'boxes'}${textCount ? `, ${textCount} text` : ''}` : 'Plain prompt (no boxes yet)'} · {size.width} × {size.height}{compiled.warnings?.length ? <span className="layout-flag"> · {compiled.warnings[0]}</span> : null}</span>
    : <span className="layout-muted">Write a summary, or draw a box on the board.</span>;

  const boxes = regions.slice().reverse().map((item, index) => ({ item, number: index + 1 })).reverse();

  return (
    <div
      className={cn('layout-panel', context.phone && 'is-phone', job && 'is-busy')}
      onPaste={paste}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
      onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void handleFiles([...event.dataTransfer.files]); } }}
    >
      <div className="layout-tools">
        <Segmented label="Kind of box to draw" value={tool} options={KINDS} onChange={setTool} />
        <Tip content="Add a box in the middle"><button type="button" className="icon-button" aria-label="Add a box" onClick={addBox}><CopyPlus size={15} /></button></Tip>
        <span className="layout-tools-gap" />
        <Tip content="A picture to trace over (never sent)"><button type="button" className="btn layout-tool-text" aria-label="Reference image" onClick={() => referenceInput.current?.click()}><ImagePlus size={14} /><span>Reference</span></button></Tip>
        <Tip content="Import a layout (.json, or a studio PNG)"><button type="button" className="btn layout-tool-text" aria-label="Import a layout" onClick={() => importInput.current?.click()}><FileUp size={14} /><span>Import</span></button></Tip>
        <Tip content={prefs.thirds ? 'Hide the thirds' : 'Show the thirds'}><button type="button" className={cn('icon-button', prefs.thirds && 'active')} aria-pressed={prefs.thirds} aria-label="Rule of thirds" onClick={() => updatePrefs({ thirds: !prefs.thirds })}><Grid3x3 size={15} /></button></Tip>
        <Tip content={prefs.snap ? 'Snapping on (hold Alt to skip)' : 'Snapping off'}><button type="button" className={cn('icon-button', prefs.snap && 'active')} aria-pressed={prefs.snap} aria-label="Snap to edges" onClick={() => updatePrefs({ snap: !prefs.snap })}><Magnet size={15} /></button></Tip>
        <Tip content="Undo (Ctrl+Z)"><button type="button" className="icon-button" aria-label="Undo" disabled={!history.current.past.length} onClick={undo}><Undo2 size={15} /></button></Tip>
        <Tip content="Redo (Ctrl+Y)"><button type="button" className="icon-button" aria-label="Redo" disabled={!history.current.future.length} onClick={redo}><Redo2 size={15} /></button></Tip>
        <Tip content="Clear the layout"><button type="button" className="icon-button" aria-label="Clear the layout" disabled={!regions.length && !state.caption} onClick={() => { set({ ...emptyState(), regions: regions.filter((item) => item.locked) }); setSelected(null); say('Cleared. Undo brings it back; locked boxes stay.', { action: { label: 'Undo', run: undo } }); }}><Trash2 size={15} /></button></Tip>
        <input ref={referenceInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void placeReference(file).then((placed) => { if (placed && assist) setTab('ai'); }); }} />
        <input ref={importInput} type="file" accept=".json,.txt,image/png" hidden onChange={(event) => { const files = [...(event.target.files || [])]; event.target.value = ''; void handleFiles(files, { importOnly: true }); }} />
      </div>

      <div className="layout-main">
        <div className="layout-stage-wrap">
          <div className="layout-stage" ref={stage}>
            <div
              ref={board}
              className="layout-board"
              style={{ width: boardSize.width, height: boardSize.height }}
              tabIndex={0}
              role="application"
              aria-label={`Layout board, ${size.width} by ${size.height}. Drag to draw a ${tool} box; drag a box to move it.`}
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onPointerCancel={(event) => { if (drag.current) { put(JSON.parse(drag.current.before)); drag.current = null; setGuides([]); } void event; }}
            >
              {reference ? <SafeImg className="layout-reference" src={reference.url} style={{ objectFit: prefs.fit, opacity: prefs.opacity }} draggable={false} /> : null}
              {prefs.thirds ? <div className="layout-thirds" aria-hidden="true" /> : null}
              {boxes.slice().reverse().map(({ item, number }) => (
                <div
                  key={item.id}
                  data-id={item.id}
                  className={cn('layout-box', `is-${item.kind}`, item.id === selected && 'is-selected', item.locked && 'is-locked', issueBox?.id === item.id && 'is-issue', job?.thinking.includes(item.id) && 'is-thinking', born.has(item.id) && 'is-born')}
                  style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%`, width: `${item.w * 100}%`, height: `${item.h * 100}%`, zIndex: regions.length - regions.indexOf(item) }}
                >
                  <span className="layout-box-tag">{pad2(number)}{item.locked ? <Lock size={9} /> : null}</span>
                  <span className="layout-box-text">{item.kind === 'text' ? item.text || item.description : item.description}</span>
                  {item.id === selected && !item.locked ? HANDLES.map((handle) => <i key={handle} data-handle={handle} className={`layout-handle is-${handle}`} />) : null}
                </div>
              ))}
              {guides.map((guide) => <i key={`${guide.axis}${guide.at}`} className={`layout-guide is-${guide.axis}`} style={guide.axis === 'x' ? { left: `${guide.at * 100}%` } : { top: `${guide.at * 100}%` }} />)}
              {loaded && !regions.length ? (
                <div className="layout-starters">
                  <p>Drag on the board to draw a box, or start from one of these.</p>
                  <div>
                    {STARTERS.map((starter) => (
                      <button key={starter.id} type="button" className="layout-starter" onClick={() => { set(starterState(starter, latest.current.caption)); say(`${starter.name} placed. Rewrite its captions and words for your picture.`, { action: { label: 'Undo', run: undo } }); }}>
                        <strong>{starter.name}</strong><span>{starter.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          {reference ? (
            <div className="layout-reference-row">
              <span className="layout-reference-name" title={reference.name}>{reference.name}</span>
              <Segmented label="How the reference fits the board" value={prefs.fit} options={[{ value: 'cover', label: 'Fill' }, { value: 'contain', label: 'Fit' }]} onChange={(fit) => updatePrefs({ fit })} />
              <input type="range" min={0.1} max={1} step={0.05} value={prefs.opacity} aria-label="Reference opacity" onChange={(event) => updatePrefs({ opacity: Number(event.target.value) })} />
              <Tip content="Remove the reference"><button type="button" className="icon-button" aria-label="Remove the reference" onClick={clearReference}><X size={14} /></button></Tip>
            </div>
          ) : null}
        </div>

        <div className="layout-side">
          <Segmented<Tab> label="Panel" value={tab} onChange={setTab} options={[{ value: 'summary', label: 'Summary' }, { value: 'boxes', label: regions.length ? `Boxes · ${regions.length}` : 'Boxes' }, ...(assist ? [{ value: 'ai' as Tab, label: 'AI' }] : [])]} />
          <div className="layout-side-body">
            {tab === 'summary' ? (
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
                      <Segmented label="Kind" value={current.kind} options={KINDS} onChange={(kind) => editRegion(current.id, { kind })} />
                    </div>
                    <div className="layout-field">
                      <label htmlFor={fieldId('box-caption')}>{current.kind === 'text' ? 'Look of the lettering' : 'What’s in this box'}</label>
                      <textarea id={fieldId('box-caption')} ref={boxCaption} rows={3} value={current.description} placeholder={current.kind === 'text' ? 'Large white serif title, centred…' : current.kind === 'character' ? 'Who they are, what they wear and do…' : 'What it is, how it looks…'} onChange={(event) => editRegion(current.id, { description: event.target.value }, `caption-${current.id}`)} />
                    </div>
                    {current.kind === 'text' ? (
                      <div className="layout-field">
                        <label htmlFor={fieldId('box-text')}>Exact words</label>
                        <textarea id={fieldId('box-text')} rows={2} value={current.text} placeholder="The words, as written" onChange={(event) => editRegion(current.id, { text: event.target.value }, `text-${current.id}`)} />
                      </div>
                    ) : null}
                    <div className="layout-field">
                      <label htmlFor={fieldId('box-colours')}>Colours</label>
                      <Colours id={fieldId('box-colours')} label="Box colours" values={current.colors} onChange={(colors) => editRegion(current.id, { colors })} />
                    </div>
                    <div className="layout-field">
                      <label htmlFor={fieldId('box-place')}>Place</label>
                      <select id={fieldId('box-place')} className="layout-select" value="" disabled={current.locked} onChange={(event) => { const place = PLACES.find((item) => item.value === event.target.value); if (place) editRegion(current.id, place.rect); }}>
                        <option value="">Move to…</option>
                        {PLACES.map((place) => <option key={place.value} value={place.value}>{place.label}</option>)}
                      </select>
                    </div>
                    <div className="layout-inspector-tools">
                      <Tip content={current.locked ? 'Unlock' : 'Lock: the assistant and drags leave it alone'}><button type="button" className={cn('icon-button', current.locked && 'active')} aria-pressed={Boolean(current.locked)} aria-label="Lock the box" onClick={() => editRegion(current.id, { locked: !current.locked || undefined })}>{current.locked ? <Lock size={15} /> : <LockOpen size={15} />}</button></Tip>
                      <Tip content="Bring forward"><button type="button" className="icon-button" aria-label="Bring forward" disabled={regions[0]?.id === current.id} onClick={() => restack(current.id, true)}><ArrowUp size={15} /></button></Tip>
                      <Tip content="Send back"><button type="button" className="icon-button" aria-label="Send back" disabled={regions.at(-1)?.id === current.id} onClick={() => restack(current.id, false)}><ArrowDown size={15} /></button></Tip>
                      <Tip content="Duplicate"><button type="button" className="icon-button" aria-label="Duplicate" onClick={() => duplicate(current.id)}><Copy size={15} /></button></Tip>
                      <Tip content="Delete (Del)"><button type="button" className="icon-button" aria-label="Delete the box" disabled={current.locked} onClick={() => remove(current.id)}><Trash2 size={15} /></button></Tip>
                    </div>
                  </div>
                ) : null}
                {boxes.length ? (
                  <ul className="layout-list" aria-label="Boxes, front first">
                    {boxes.map(({ item, number }) => (
                      <li key={item.id}>
                        <button type="button" className={cn('layout-row', item.id === selected && 'active', issueBox?.id === item.id && 'is-issue')} aria-current={item.id === selected || undefined} onClick={() => select(item.id === selected ? null : item.id)}>
                          <span className="layout-row-number">{pad2(number)}</span>
                          <span className="layout-row-kind">{KINDS.find((kind) => kind.value === item.kind)?.label}</span>
                          <span className="layout-row-text">{(item.kind === 'text' ? item.text : '') || item.description || <em>No caption yet</em>}</span>
                          {item.locked ? <Lock size={12} /> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="layout-muted">No boxes yet. Drag on the board to draw one.</p>}
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
                  <h3>From the reference</h3>
                  {reference ? (
                    <>
                      <div className="layout-field">
                        <label htmlFor={fieldId('labels')}>Only look for (optional)</label>
                        <input id={fieldId('labels')} className="layout-input" value={prefs.labels} placeholder="knight, lantern" autoComplete="off" onChange={(event) => updatePrefs({ labels: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); extract(); } }} />
                      </div>
                      <label className="layout-check"><input type="checkbox" checked={prefs.lettering} onChange={(event) => updatePrefs({ lettering: event.target.checked })} /> Read lettering into text boxes</label>
                      <div className="layout-actions">
                        <button type="button" className="btn is-primary" onClick={() => extract()}><Sparkles size={14} /> Read into boxes</button>
                        <button type="button" className="btn" onClick={() => { void runAi('ocr', {}); }}><ScanText size={14} /> Lettering</button>
                        {current && !current.locked ? <button type="button" className="btn" onClick={() => snapBox()}>Fit box {pad2(numberOf(current))}</button> : null}
                      </div>
                    </>
                  ) : (
                    <div className="layout-actions">
                      <button type="button" className="btn" onClick={() => referenceInput.current?.click()}><ImagePlus size={14} /> Add a reference</button>
                      <span className="layout-muted">or paste or drop one here.</span>
                    </div>
                  )}
                </section>
                <section>
                  <h3>From words</h3>
                  <div className="layout-field">
                    <label htmlFor={fieldId('request')}>{regions.length ? 'What to change' : 'The picture you want'}</label>
                    <textarea id={fieldId('request')} rows={3} value={request} placeholder={regions.length ? 'Move the title to the top, add a cat on the left…' : 'A night-market poster, a big neon title, two friends under umbrellas…'} onChange={(event) => setRequest(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); if (regions.length) change(); else plan(); } }} />
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
                      {empty.length ? <button type="button" className="btn" onClick={() => describe(empty)}>Describe {empty.length} empty {empty.length === 1 ? 'box' : 'boxes'}</button> : null}
                      {current && !current.locked ? <button type="button" className="btn" onClick={() => describe([current], true)}>Rewrite box {pad2(numberOf(current))}</button> : null}
                      {!empty.length && !current ? <span className="layout-muted">Every box has a caption. Select one to rewrite it.</span> : null}
                    </div>
                  </section>
                ) : null}
                {last ? <button type="button" className="btn" onClick={again}>Another take</button> : null}
                <p className="layout-muted">Runs in your ComfyUI. Every result is one Undo away, and locked boxes are kept.</p>
              </div>
            ) : null}
          </div>
        </div>
      </div>

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
          <Tip content="Copy the prompt"><button type="button" className="icon-button" aria-label="Copy the prompt" disabled={!compiled?.prompt} onClick={() => { void copy(); }}><Copy size={15} /></button></Tip>
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
  createRows: [{ id: 'open', label: 'Layout', icon: LayoutDashboard, detail: (context) => { const info = promptLayout(context); return info ? `${info.items} ${info.items === 1 ? 'box' : 'boxes'} in the prompt` : 'Place boxes for the picture'; }, run: (context) => context.openPanel('builder') }],
  promptLabel: (prompt) => {
    const info = layoutInfo(prompt);
    if (!info) return null;
    let caption = '';
    try { caption = String(JSON.parse(prompt).summary?.caption || '').trim(); } catch { /* the count is enough */ }
    return `Layout · ${info.items} ${info.items === 1 ? 'box' : 'boxes'}${caption ? ` · ${caption}` : ''}`;
  },
  panels: [{ id: 'builder', title: 'Layout', description: 'Boxes for objects, characters and lettering, written as a MOSS layout prompt.', size: 'wide', render: (context, close) => <LayoutPanel context={context} close={close} /> }],
  settings: {
    description: 'Places objects, characters and lettering in boxes on a board the shape of the picture, and writes them as a MOSS layout prompt. With the workflow’s assistant, it can also read a reference image into boxes or plan a layout from words.'
  }
};
