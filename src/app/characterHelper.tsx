import React from 'react';
import { Dices, Lock, LockOpen, Sparkles, Trash2, Undo2, UserRound, X } from 'lucide-react';
import { cn } from './format';
import { Tip } from './components';
import { Segmented } from './SettingsDialog';
import { composeTagPrompt, displayName, tagKey } from './tagPrompt.js';
import type { Extension, ExtensionContext } from './extensions';
import type { Profile } from './types';

/*
 * Character (server/character-helper.js): builds a Danbooru tag prompt for one
 * character, in the Character Helper node's fields. Each field completes as you
 * type (or suggests what fits the rest when empty), has a dice and a lock;
 * Randomize rolls every unlocked field from one real picture, and Usual look
 * fills them from the character's own pictures. Use prompt writes it into the
 * prompt box, with Undo in the toast. The last character is kept on this device.
 */

const ID = 'character';
const STORE = 'heiss.character.v1';
const UNDO_STEPS = 30;
const RATINGS = [{ value: 'general', label: 'General' }, { value: 'sensitive', label: 'Sensitive' }] as const;
type Rating = typeof RATINGS[number]['value'];
type Field = { id: string; label: string; count: number; group: string };
type State = { fields: Record<string, string[]>; locks: Record<string, true>; rating: Rating };
type Item = { tag: string; count?: number; kind?: string; series?: string; alias?: string | null; hint?: string; field?: string; known?: boolean | null };
type Status = { text: string; error?: boolean; action?: { label: string; run: () => void } } | null;

const pretty = (tag: string) => tag.replace(/_/g, ' ');
const shortCount = (n = 0) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const splitTags = (text: string) => text.split(/[,\n]/).map((tag) => tag.trim()).filter(Boolean);
const configOf = (profile: Profile | null) => profile?.character || null;

async function call<T>(operation: string, { query, body }: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
  const url = `/api/character-helper/${operation}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const response = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Character Helper didn’t answer.'), { restart: Boolean(data.restart) });
  return data as T;
}

function readStore(): { state?: State; prompt?: string } | null {
  try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; }
}
function writeStore(value: { state?: State; prompt?: string }) {
  try { localStorage.setItem(STORE, JSON.stringify(value)); } catch { /* kept for this visit only */ }
}

function blank(fields: Field[]): State {
  return { fields: Object.fromEntries(fields.map((field) => [field.id, []])), locks: {}, rating: 'sensitive' };
}
/** A kept state, with anything missing or malformed replaced by the blank one. */
function restoreState(fields: Field[], saved: State | undefined): State {
  const state = blank(fields);
  for (const { id } of fields) {
    const tags = saved?.fields?.[id];
    if (Array.isArray(tags)) state.fields[id] = tags.map(String).filter(Boolean).slice(0, 40);
    if (saved?.locks?.[id]) state.locks[id] = true;
  }
  if (RATINGS.some((rating) => rating.value === saved?.rating)) state.rating = saved!.rating;
  return state;
}

function itemHint(item: Item, fieldId: string, labels: Record<string, string>) {
  if (item.alias) return `← ${pretty(item.alias)}`;
  if (item.kind === 'character') return pretty(item.series || '');
  if (item.kind === 'series') return 'series';
  if (item.hint) return item.hint;
  return item.field && item.field !== fieldId ? labels[item.field] || item.field : '';
}

const UNKNOWN = 'Not in this model’s tag list, so it may not know it.';

/** One field: its tags as chips, an input that completes as you type, a dice and a lock. */
function FieldRow({ field, state, unknown, labels, onAdd, onRemove, onAccept, onRoll, onLock, onFail }: {
  field: Field; state: State; unknown: Set<string>; labels: Record<string, string>;
  onAdd: (tags: string[]) => void; onRemove: (index: number) => void; onAccept: (item: Item) => void;
  onRoll: () => void; onLock: () => void; onFail: (error: unknown) => void;
}) {
  const tags = state.fields[field.id] || [];
  const locked = Boolean(state.locks[field.id]);
  const [text, setText] = React.useState('');
  const [items, setItems] = React.useState<Item[]>([]);
  const [title, setTitle] = React.useState('');
  const [active, setActive] = React.useState(-1);
  const input = React.useRef<HTMLInputElement>(null);
  const seq = React.useRef(0);

  const query = async (typed: string) => {
    const mine = ++seq.current;
    try {
      const found = typed.trim()
        ? await call<Item[]>('autocomplete', { query: { field: field.id, q: typed.trim(), limit: '12' } })
        : await call<Item[]>('suggest', { body: { field: field.id, context: state.fields, rating: state.rating } });
      if (mine !== seq.current || document.activeElement !== input.current) return;
      setItems(found);
      setTitle(typed.trim() ? '' : field.id === 'character' ? 'Popular characters' : 'Goes well with the rest');
      setActive(typed.trim() && found.length ? 0 : -1);
    } catch (error) {
      if (mine === seq.current) onFail(error);
    }
  };
  const close = () => { seq.current += 1; setItems([]); setActive(-1); };
  const commit = () => {
    const typed = splitTags(text);
    setText('');
    if (typed.length) onAdd(typed);
  };
  const accept = (item: Item) => {
    setText('');
    onAccept(item);
    if (item.kind === 'character') close();
    else void query('');
  };
  const onKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!items.length) { void query(text); return; }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index) => ((index < 0 && step < 0 ? 0 : index) + step + items.length) % items.length);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      const pick = active >= 0 ? items[active] : null;
      if (pick) { event.preventDefault(); accept(pick); }
      else if (text.trim()) { if (event.key === 'Enter') event.preventDefault(); commit(); close(); }
    } else if (event.key === ',') {
      event.preventDefault(); commit(); close();
    } else if (event.key === 'Backspace' && !text && tags.length) {
      event.preventDefault(); onRemove(tags.length - 1);
    } else if (event.key === 'Escape' && items.length) {
      event.preventDefault(); event.stopPropagation(); close();
    }
  };

  return (
    <div className={cn('character-row', locked && 'is-locked')} data-field={field.id}>
      <label className="character-label" htmlFor={`character-${field.id}`}>{field.label}</label>
      <div className="character-box" onMouseDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); input.current?.focus(); } }}>
        {tags.map((tag, index) => (
          <span key={`${tag}:${index}`} className={cn('character-chip', unknown.has(tagKey(tag)) && 'is-unknown')} title={unknown.has(tagKey(tag)) ? UNKNOWN : undefined}>
            <button type="button" className="character-chip-text" onClick={() => { commit(); onRemove(index); setText(pretty(tag)); requestAnimationFrame(() => input.current?.select()); }}>{pretty(tag)}</button>
            <button type="button" className="character-chip-x" tabIndex={-1} aria-label={`Remove ${pretty(tag)}`} onClick={() => onRemove(index)}><X size={11} /></button>
          </span>
        ))}
        <input
          ref={input}
          id={`character-${field.id}`}
          value={text}
          spellCheck={false}
          autoComplete="off"
          enterKeyHint="done"
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={`character-${field.id}-options`}
          placeholder={field.id === 'character' && !tags.length ? 'Type a name: frieren, miku…' : ''}
          onChange={(event) => { setText(event.target.value); void query(event.target.value); }}
          onFocus={() => { void query(text); }}
          onBlur={() => { commit(); close(); }}
          onKeyDown={onKey}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData('text');
            if (!/[,\n]/.test(pasted)) return;
            event.preventDefault();
            onAdd(splitTags(pasted));
          }}
        />
        {items.length ? (
          <div className="character-options" id={`character-${field.id}-options`} role="listbox" onMouseDown={(event) => event.preventDefault()}>
            {title ? <div className="character-options-title">{title}</div> : null}
            {items.map((item, index) => {
              const hint = itemHint(item, field.id, labels);
              return (
                <div key={item.tag} role="option" aria-selected={index === active} className={cn('character-option', index === active && 'is-active', item.known === false && 'is-unknown')} title={item.known === false ? UNKNOWN : undefined} onClick={() => accept(item)}>
                  <span className="character-option-tag">{pretty(item.tag)}</span>
                  {hint ? <span className="character-option-hint">{hint}</span> : null}
                  <span className="character-option-count">{shortCount(Math.abs(item.count || 0))}</span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
      <span className="character-row-tools">
        <Tip content={field.id === 'character' ? 'Random well-known character' : `Random ${field.label} that fits the rest`}>
          <button type="button" className="icon-button" aria-label={field.id === 'character' ? 'Random character' : `Random ${field.label}`} onClick={onRoll}><Dices size={14} /></button>
        </Tip>
        <Tip content={locked ? `Unlock ${field.label}` : `Lock ${field.label}: Randomize, Usual look and Clear leave it alone`}>
          <button type="button" className={cn('icon-button', locked && 'active')} aria-label={`${locked ? 'Unlock' : 'Lock'} ${field.label}`} aria-pressed={locked} onClick={onLock}>{locked ? <Lock size={14} /> : <LockOpen size={14} />}</button>
        </Tip>
      </span>
    </div>
  );
}

function CharacterPanel({ context, close }: { context: ExtensionContext; close: () => void }) {
  const config = configOf(context.profile);
  const [fields, setFields] = React.useState<Field[] | null>(null);
  const [marksKnown, setMarksKnown] = React.useState(false);
  const [state, setState] = React.useState<State | null>(null);
  const [unknown, setUnknown] = React.useState<Set<string>>(() => new Set());
  const [status, setStatus] = React.useState<Status>({ text: 'Loading the tag database…' });
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const undo = React.useRef<string[]>([]);
  const checked = React.useRef(new Set<string>());
  const timer = React.useRef<number>(0);
  const latest = React.useRef<State | null>(null);
  latest.current = state;
  // Ctrl+Z and Ctrl+Enter anywhere in the dialog, wherever the focus sits.
  const keys = React.useRef<(event: KeyboardEvent) => void>(() => undefined);
  React.useEffect(() => {
    const listen = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener('keydown', listen);
    return () => window.removeEventListener('keydown', listen);
  }, []);

  const say = (next: Status, keep = false) => {
    window.clearTimeout(timer.current);
    setStatus(next);
    if (next && !keep && !next.action && !next.error) timer.current = window.setTimeout(() => setStatus(null), 5000);
  };
  const fail = (error: unknown) => {
    const restart = Boolean((error as { restart?: boolean })?.restart);
    say({ text: restart ? 'Restart ComfyUI to load the Character Helper node, then open this again.' : error instanceof Error ? error.message : 'Character Helper isn’t reachable.', error: true });
  };

  const load = React.useCallback(async () => {
    setFailed(false);
    setStatus({ text: 'Loading the tag database…' });
    try {
      const meta = await call<{ fields: Field[]; marksKnown: boolean }>('meta');
      if (!meta.fields?.length) throw new Error('The Character Helper node sent no fields.');
      const stored = readStore();
      setFields(meta.fields);
      setMarksKnown(Boolean(meta.marksKnown));
      const restored = restoreState(meta.fields, stored?.state);
      setState(restored);
      const filled = Object.values(restored.fields).some((tags) => tags.length);
      setStatus({ text: filled ? (stored?.prompt && stored.prompt === context.view.prompt ? 'Editing the character in your prompt.' : 'Your last character is back. Clear starts over.') : 'Pick a character, or Randomize an original one.' });
    } catch (error) {
      setFailed(true);
      fail(error);
    }
  // Once per open: `context` is new on every render.
  }, []);
  React.useEffect(() => { void load(); return () => window.clearTimeout(timer.current); }, [load]);

  // Marks the tags the model's list lacks; only tags not asked about before.
  React.useEffect(() => {
    if (!marksKnown || !state) return;
    const tags = [...new Set(Object.values(state.fields).flat())].filter((tag) => !checked.current.has(tagKey(tag)));
    if (!tags.length) return;
    call<{ unknown: string[] }>('check', { body: { tags: tags.slice(0, 400) } }).then(({ unknown: missing }) => {
      for (const tag of tags) checked.current.add(tagKey(tag));
      if (missing?.length) setUnknown((old) => new Set([...old, ...missing.map(tagKey)]));
    }, () => undefined);
  }, [marksKnown, state]);

  if (!config) return null;
  const labels = Object.fromEntries((fields || []).map((field) => [field.id, field.label]));
  const order = (fields || []).map((field) => field.id);
  const safety = state ? config.safety[state.rating] : '';
  const prompt = state ? composeTagPrompt(state.fields, { head: config.head, safety, order }) : '';
  const unknownCount = state ? Object.values(state.fields).flat().filter((tag) => unknown.has(tagKey(tag))).length : 0;

  /** Every change: kept on this device, and one Undo step before it. Reads the latest state, so changes in one event chain. */
  const change = (next: State | ((old: State) => State), snapshot = true) => {
    const old = latest.current;
    if (!old) return;
    if (snapshot) { undo.current.push(JSON.stringify(old)); if (undo.current.length > UNDO_STEPS) undo.current.shift(); }
    const value = typeof next === 'function' ? next(old) : next;
    latest.current = value;
    writeStore({ ...(readStore() || {}), state: value });
    setState(value);
  };
  const editField = (id: string, edit: (tags: string[]) => string[]) => change((old) => ({ ...old, fields: { ...old.fields, [id]: edit(old.fields[id] || []) } }));
  const withTags = (tags: string[], more: string[]) => [...tags, ...more.filter((tag, index) => !tags.some((old) => tagKey(old) === tagKey(tag)) && more.findIndex((other) => tagKey(other) === tagKey(tag)) === index)];
  const unlocked = () => order.filter((id) => !state?.locks[id]);
  const markUnknown = (tags: string[] | undefined) => { if (tags?.length) setUnknown((old) => new Set([...old, ...tags.map(tagKey)])); };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); } catch (error) { fail(error); } finally { setBusy(false); }
  };
  const usualLook = (force = false) => run(async () => {
    const name = state?.fields.character?.[0];
    if (!name) { say({ text: 'Pick a character first.', error: true }); return; }
    const preset = await call<{ character: string; count: number; fields: Record<string, string[]>; person: boolean | null; personPercent: number | null; unknown: string[] }>('character', { query: { name } });
    if (preset.person === false && !force) {
      say({ text: `${displayName(name)} is mostly drawn as a creature or object (a person in ${preset.personPercent}% of pictures), so this look would come from fan art.`, action: { label: 'Fill anyway', run: () => { void usualLook(true); } } });
      return;
    }
    markUnknown(preset.unknown);
    change((old) => {
      const next = { ...old, fields: { ...old.fields } };
      for (const id of order) if (id !== 'character' && !old.locks[id] && Array.isArray(preset.fields?.[id])) next.fields[id] = preset.fields[id];
      return next;
    });
    say({ text: `Usual look of ${displayName(preset.character)}, from ${shortCount(preset.count)} pictures. Locked fields were kept.` });
  });
  const randomize = (ids: string[]) => run(async () => {
    if (!state) return;
    if (!ids.length) { say({ text: 'Every field is locked.', error: true }); return; }
    const counts = Object.fromEntries((fields || []).map((field) => [field.id, field.count]));
    const rolled = await call<{ fields: Record<string, string[]>; unknown: string[] }>('random', { body: { fields: ids, counts, context: state.fields, rating: state.rating } });
    markUnknown(rolled.unknown);
    change((old) => ({ ...old, fields: { ...old.fields, ...rolled.fields } }));
    if (ids.length > 1) say({ text: state.fields.character?.length ? 'Rolled. With a character set, their hair, eyes and body follow their usual look.' : 'Rolled an original character from one real picture. Lock what you like and roll again.' });
    else if (!rolled.fields[ids[0]]?.length) say({ text: 'Nothing found for this field.', error: true });
    else if (ids[0] === 'character') say({ text: `${displayName(rolled.fields.character[0])} rolled.`, action: { label: 'Usual look', run: () => { void usualLook(); } } });
  });
  const stepBack = () => {
    const last = undo.current.pop();
    if (!last) return;
    change(JSON.parse(last), false);
    say({ text: 'Undone.' });
  };
  const apply = () => {
    if (!prompt || !state) return;
    const before = String(context.view.prompt || '');
    writeStore({ state, prompt });
    context.view.setPrompt?.(prompt);
    close();
    const name = state.fields.character?.[0];
    context.showToast(name ? `${displayName(name)} is in the prompt` : 'Your character is in the prompt', 'success', { action: { label: 'Undo', onClick: () => context.view.setPrompt?.(before) } });
  };

  keys.current = (event: KeyboardEvent) => {
    const typing = event.target instanceof HTMLInputElement && event.target.value;
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z' && !typing) { event.preventDefault(); stepBack(); }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); apply(); }
  };

  return (
    <div className={cn('character-panel', busy && 'is-busy', context.phone && 'is-phone')}>
      <div className="character-tools">
        <button type="button" className="btn is-primary" disabled={!state || busy} onClick={() => { void randomize(unlocked()); }}><Dices size={14} /> Randomize</button>
        <button type="button" className="btn" disabled={!state || busy} onClick={() => { void usualLook(); }}><Sparkles size={14} /> Usual look</button>
        <span className="character-tools-gap" />
        {state ? <Segmented label="Pictures the dice and suggestions draw from" value={state.rating} options={RATINGS.map((rating) => ({ ...rating }))} onChange={(rating) => change((old) => ({ ...old, rating }), false)} /> : null}
        <Tip content="Undo (Ctrl+Z)"><button type="button" className="icon-button" aria-label="Undo" disabled={!undo.current.length} onClick={stepBack}><Undo2 size={15} /></button></Tip>
        <Tip content="Clear the unlocked fields"><button type="button" className="icon-button" aria-label="Clear the unlocked fields" disabled={!state} onClick={() => { change((old) => ({ ...old, fields: { ...old.fields, ...Object.fromEntries(unlocked().map((id) => [id, []])) } })); say({ text: 'Cleared. Undo brings them back.' }); }}><Trash2 size={15} /></button></Tip>
      </div>
      {state && fields ? (
        <div className="character-list">
          {fields.map((field, index) => (
            <React.Fragment key={field.id}>
              {index > 0 && field.group !== fields[index - 1].group ? <hr className="character-group-gap" /> : null}
              <FieldRow
                field={field}
                state={state}
                unknown={unknown}
                labels={labels}
                onAdd={(tags) => editField(field.id, (old) => withTags(old, tags))}
                onRemove={(at) => editField(field.id, (old) => old.filter((_, index) => index !== at))}
                onAccept={(item) => {
                  if (item.known === false) markUnknown([item.tag]);
                  if (item.kind === 'character') {
                    change((old) => ({ ...old, fields: { ...old.fields, character: item.series ? [item.tag, item.series] : [item.tag] }, locks: { ...old.locks, character: true } }));
                    say({ text: `${displayName(item.tag)} picked.`, action: { label: 'Usual look', run: () => { void usualLook(); } } });
                    return;
                  }
                  editField(field.id, (old) => withTags(old, [item.tag]));
                }}
                onRoll={() => { void randomize([field.id]); }}
                onLock={() => change((old) => {
                  const locks = { ...old.locks };
                  if (locks[field.id]) delete locks[field.id]; else locks[field.id] = true;
                  return { ...old, locks };
                }, false)}
                onFail={fail}
              />
            </React.Fragment>
          ))}
        </div>
      ) : null}
      {status ? (
        <p className={cn('character-status', status.error && 'is-error')} role="status">
          {status.text}
          {status.action ? <button type="button" className="character-status-action" onClick={status.action.run}>{status.action.label}</button> : null}
          {failed ? <button type="button" className="character-status-action" onClick={() => { void load(); }}>Try again</button> : null}
        </p>
      ) : null}
      <div className="character-foot">
        <p className="character-preview">
          {prompt || <span className="character-muted">The prompt appears here as you add tags.</span>}
          {unknownCount ? <span className="character-preview-flag"> · {unknownCount} {unknownCount === 1 ? 'tag' : 'tags'} not in this model’s list</span> : null}
        </p>
        <div className="character-foot-actions">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="button" className="btn is-primary" disabled={!prompt} onClick={apply}><UserRound size={14} /> Use prompt</button>
        </div>
      </div>
    </div>
  );
}

const lastName = () => {
  const name = readStore()?.state?.fields?.character?.[0];
  return name ? displayName(name) : '';
};

export const characterHelper: Extension = {
  id: ID,
  name: 'Character',
  available: (context) => Boolean(configOf(context.profile)) && context.profile?.kind !== 'video',
  composer: [{ id: 'open', label: 'Character: build a tag prompt', icon: UserRound, run: (context) => context.openPanel('builder') }],
  createRows: [{ id: 'open', label: 'Character', icon: UserRound, detail: () => lastName() || 'Build a tag prompt', run: (context) => context.openPanel('builder') }],
  panels: [{ id: 'builder', title: 'Character', description: 'Danbooru tags for one character, from the Character Helper node.', size: 'wide', render: (context, close) => <CharacterPanel context={context} close={close} /> }],
  settings: {
    description: 'Builds a tag prompt for one character (hair, eyes, outfit, pose, scene) with completion, dice and locks, for workflows that take Danbooru tags.'
  }
};

