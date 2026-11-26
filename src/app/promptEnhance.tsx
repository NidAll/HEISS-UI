import React from 'react';
import { Redo2, Sparkles, Square, Undo2 } from 'lucide-react';
import { apiJson } from './api';
import { cn } from './format';
import { Tip } from './components';
import { Row, Segmented, Switch } from './SettingsDialog';
import { setBeforeGenerate, type Extension, type ExtensionContext } from './extensions';
import type { Preferences, Profile } from './types';

/*
 * Enhance (server/prompt-enhance.js): a workflow that brings its own
 * text-only rewrite graph gets one button beside the prompt. It rewrites the
 * prompt in place while the box glows and stays read-only; Stop cancels it.
 * Undo and Redo (and Ctrl+Z / Ctrl+Shift+Z in the box) step through every
 * rewrite, as long as the text is still what Enhance left there.
 *
 * Settings › Features › Enhance picks, per model on this device, the mode it
 * writes in (the workflow names them, e.g. Faithful / Explore) and whether
 * prompts under twelve words are enhanced before Generate. Off in Hidden.
 */

const AUTO_WORDS = 12;
type Edit = { before: string; after: string };
type Result = { prompt: string; inspection?: string };
type JobState = { status: string; error?: string; result?: Result };

// Kept outside the component, so a composer that remounts (Zen, phone sheets) keeps its history.
const store = { jobId: '', undo: [] as Edit[], redo: [] as Edit[], profileId: '' };
const listeners = new Set<() => void>();
let version = 0;
const changed = () => { version += 1; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
const useStore = () => React.useSyncExternalStore(subscribe, () => version);

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
/** A JSON prompt (a layout, say) is written by a tool; Enhance leaves it as it is, as the server would. */
const structured = (text: string) => { const trimmed = text.trim(); if (!/^[[{]/.test(trimmed)) return false; try { JSON.parse(trimmed); return true; } catch { return false; } };
const modeFor = (prefs: Preferences | undefined, profile: Profile) => prefs?.enhance?.modes?.[profile.id] || profile.enhance?.modes[0]?.id || '';
const autoFor = (prefs: Preferences | undefined, profile: Profile) => Boolean(prefs?.enhance?.auto?.[profile.id]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a tagger-style enhancer says it recognised (an `inspection` with `recognised` lists), as one short line. */
export function recognisedLine(inspection?: string) {
  try {
    const found = JSON.parse(inspection || '')?.recognised;
    const names = ['characters', 'series', 'artists'].flatMap((key) => (Array.isArray(found?.[key]) ? found[key] : []))
      .map((tag: unknown) => String(tag).replace(/\s*\(.*\)\s*$/, '').replace(/_/g, ' ')).filter(Boolean);
    return names.length ? `Recognised ${[...new Set(names)].slice(0, 4).join(', ')}` : '';
  } catch {
    return '';
  }
}

/** Runs Enhance on `prompt` and waits for it. Null when it was stopped. */
async function runEnhance(profile: Profile, prompt: string, context: ExtensionContext): Promise<Result | null> {
  const { view } = context;
  const { jobId } = await apiJson<{ jobId: string }>('/api/prompt-enhance', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileId: profile.id, prompt, mode: modeFor(view.prefs, profile), style: view.enhanceStyle || '', privateVault: Boolean(view.hiddenSpace) })
  });
  store.jobId = jobId;
  changed();
  try {
    while (true) {
      await sleep(250);
      const job: JobState = await apiJson<JobState>(`/api/jobs/${encodeURIComponent(jobId)}`).catch(() => ({ status: 'reconnecting' }));
      if (job.status === 'done' && job.result) return job.result;
      if (job.status === 'canceled') return null;
      if (job.status === 'error' || job.status === 'missing') throw new Error(job.error || 'Enhance stopped before it finished.');
    }
  } finally {
    if (store.jobId === jobId) store.jobId = '';
    changed();
  }
}

function stop() {
  if (store.jobId) void apiJson(`/api/jobs/${encodeURIComponent(store.jobId)}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
}

/** The composer's prompt box around a control inside it. */
const promptBox = (node: HTMLElement | null) => node?.closest<HTMLElement>('.zen-prompt, .phone-compose') || null;
const promptArea = (box: HTMLElement | null) => box?.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Prompt"]') || null;

function EnhanceTool({ context }: { context: ExtensionContext }) {
  useStore();
  const { view, phone, profile } = context;
  const rootRef = React.useRef<HTMLSpanElement | null>(null);
  const prompt = String(view.prompt || '');
  const pending = Boolean(store.jobId);
  const top = store.undo[store.undo.length - 1];
  const next = store.redo[store.redo.length - 1];
  const canUndo = Boolean(top) && prompt === top.after && !pending;
  const canRedo = Boolean(next) && prompt === next.before && !pending;
  const latest = React.useRef({ prompt, canUndo, canRedo });
  latest.current = { prompt, canUndo, canRedo };

  // History belongs to one model: another model starts clean, and a run for the old one stops.
  React.useEffect(() => {
    if (!profile || store.profileId === profile.id) return;
    if (store.profileId) stop();
    Object.assign(store, { profileId: profile.id, undo: [], redo: [] });
    changed();
  }, [profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const undo = React.useCallback(() => {
    const edit = store.undo.pop();
    if (!edit) return;
    store.redo.push(edit);
    view.setPrompt(edit.before);
    changed();
  }, [view]);
  const redo = React.useCallback(() => {
    const edit = store.redo.pop();
    if (!edit) return;
    store.undo.push(edit);
    view.setPrompt(edit.after);
    changed();
  }, [view]);

  // While it writes, the box glows and can't be typed in.
  React.useEffect(() => {
    const box = promptBox(rootRef.current);
    const area = promptArea(box);
    if (!pending || !area || !box) return;
    const wasReadOnly = area.readOnly;
    area.readOnly = true;
    area.setAttribute('aria-busy', 'true');
    box.classList.add('is-enhancing');
    return () => { area.readOnly = wasReadOnly; area.removeAttribute('aria-busy'); box.classList.remove('is-enhancing'); };
  }, [pending]);

  // Ctrl+Z right after a rewrite brings back what was there; Ctrl+Shift+Z or Ctrl+Y does it again.
  React.useEffect(() => {
    const area = promptArea(promptBox(rootRef.current));
    if (!area) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const wantsRedo = (key === 'z' && event.shiftKey) || key === 'y';
      if (key === 'z' && !event.shiftKey && latest.current.canUndo) { event.preventDefault(); undo(); }
      else if (wantsRedo && latest.current.canRedo) { event.preventDefault(); redo(); }
    };
    area.addEventListener('keydown', onKey);
    return () => area.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  if (!profile?.enhance) return null;
  const hidden = Boolean(view.hiddenSpace);
  const empty = !prompt.trim();
  const reason = hidden ? 'Enhance is off in Hidden' : empty ? 'Write an idea first, then Enhance it' : structured(prompt) ? 'This prompt is structured (JSON), so Enhance leaves it as it is' : '';
  const modeLabel = profile.enhance.modes.find((mode) => mode.id === modeFor(view.prefs, profile))?.label || '';

  const enhance = async () => {
    if (pending) { stop(); return; }
    if (reason) { context.showToast(reason, 'warning'); return; }
    const source = prompt;
    try {
      const result = await runEnhance(profile, source, context);
      if (!result) { context.showToast('Enhance stopped. Your prompt is as it was.', 'default'); return; }
      const apply = () => {
        store.undo.push({ before: latest.current.prompt, after: result.prompt });
        store.redo = [];
        view.setPrompt(result.prompt);
        changed();
        const box = promptBox(rootRef.current);
        box?.classList.remove('is-revealed');
        void box?.offsetWidth;
        box?.classList.add('is-revealed');
      };
      if (latest.current.prompt !== source) {
        context.showToast('Your prompt changed while Enhance ran.', 'default', { action: { label: 'Use it', onClick: apply } });
        return;
      }
      apply();
      const line = recognisedLine(result.inspection);
      if (line) context.showToast(line, 'success');
    } catch (error) {
      context.showToast(error instanceof Error ? error.message : 'Enhance stopped before it finished.', 'error');
    }
  };

  const label = pending ? 'Stop enhancing' : `Enhance${modeLabel ? ` (${modeLabel})` : ''}`;
  const button = 'negative-toggle is-density-mini';
  return (
    <span ref={rootRef} className={cn('enhance-tool', phone && 'is-phone')}>
      <Tip content={reason || label}>
        <button type="button" className={cn(phone ? 'phone-compose-recent' : button, 'enhance-button', pending && 'is-running', reason && 'is-unavailable')} aria-label={label} aria-busy={pending || undefined} onClick={() => { void enhance(); }}>
          {pending ? <Square size={phone ? 13 : 12} fill="currentColor" /> : <Sparkles size={phone ? 15 : 14} />}
          {phone ? <span>{pending ? 'Stop' : 'Enhance'}</span> : null}
        </button>
      </Tip>
      {canUndo ? (
        <Tip content="Undo Enhance (Ctrl+Z)">
          <button type="button" className={phone ? 'phone-compose-recent' : button} aria-label="Undo Enhance" onClick={undo}><Undo2 size={phone ? 15 : 14} /></button>
        </Tip>
      ) : null}
      {canRedo ? (
        <Tip content="Redo Enhance (Ctrl+Shift+Z)">
          <button type="button" className={phone ? 'phone-compose-recent' : button} aria-label="Redo Enhance" onClick={redo}><Redo2 size={phone ? 15 : 14} /></button>
        </Tip>
      ) : null}
    </span>
  );
}

/** Enhance short prompts before Generate, for a model where that is switched on. */
function AutoEnhance({ context }: { context: ExtensionContext }) {
  const { view, profile } = context;
  const on = Boolean(profile?.enhance) && autoFor(view.prefs, profile!) && !view.hiddenSpace && view.mode !== 'video';
  const latest = React.useRef(context);
  latest.current = context;
  React.useEffect(() => {
    if (!on) return;
    setBeforeGenerate('prompt-enhance', async (prompt) => {
      const current = latest.current;
      if (!current.profile || !prompt.trim() || structured(prompt) || words(prompt) >= AUTO_WORDS || store.jobId) return prompt;
      current.view.setStatus?.('Enhancing your prompt first');
      try {
        const result = await runEnhance(current.profile, prompt, current);
        if (!result) return prompt;
        store.undo.push({ before: prompt, after: result.prompt });
        store.redo = [];
        changed();
        return result.prompt;
      } catch (error) {
        current.showToast(`${error instanceof Error ? error.message : 'Enhance stopped'}. Generating with your prompt as written.`, 'warning');
        return prompt;
      }
    });
    return () => setBeforeGenerate('prompt-enhance', null);
  }, [on]);
  return null;
}

function EnhanceSettings({ context }: { context: ExtensionContext }) {
  const { view, profile } = context;
  if (!profile?.enhance) return <Row label="This model" description="Choose a model whose workflow has Enhance to set it up here." />;
  const prefs = view.prefs as Preferences;
  const set = (patch: { modes?: Record<string, string>; auto?: Record<string, boolean> }) => view.setPrefs({ enhance: { ...prefs.enhance, ...patch } });
  const name = profile.displayName || profile.label;
  return (
    <>
      {profile.enhance.modes.length > 1 ? (
        <Row label="Writes" description={`How Enhance rewrites prompts for ${name}.`}>
          <Segmented label="Enhance mode" value={modeFor(prefs, profile)} options={profile.enhance.modes.map((mode) => ({ value: mode.id, label: mode.label }))} onChange={(next) => set({ modes: { ...prefs.enhance?.modes, [profile.id]: next } })} />
        </Row>
      ) : null}
      <Row label="Before Generate" description={`Enhance prompts under ${AUTO_WORDS} words when you press Generate with ${name}.`}>
        <Switch label="Enhance before Generate" checked={autoFor(prefs, profile)} onChange={(next) => set({ auto: { ...prefs.enhance?.auto, [profile.id]: next } })} />
      </Row>
    </>
  );
}

export const promptEnhance: Extension = {
  id: 'prompt-enhance',
  name: 'Enhance',
  available: (context) => Boolean(context.profile?.enhance) && context.view.mode !== 'video',
  promptTools: [{ id: 'enhance', render: (context) => <EnhanceTool context={context} /> }],
  background: [{ id: 'auto', render: (context) => <AutoEnhance context={context} /> }],
  settings: {
    description: 'Rewrites the prompt with the model’s own Enhance step, for workflows that have one. Undo brings back what you wrote.',
    summary: (context) => (context.profile?.enhance ? context.profile.enhance.modes.find((mode) => mode.id === modeFor(context.view.prefs, context.profile!))?.label || 'Ready' : 'For workflows with Enhance'),
    render: (context) => <EnhanceSettings context={context} />
  }
};
