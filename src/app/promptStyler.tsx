import React from 'react';
import { cn } from './format';
import { setPromptLook, setRunValue, type Extension, type ExtensionContext } from './extensions';
import type { Profile } from './types';

/*
 * Styles (server/prompt-styler.js): the PromptStyler Next node pack ships its
 * own picker, a React component built with the studio's React. It is loaded
 * from the pack the first time a workflow with Styles is open, and drawn as
 * one button in the composer row (under the prompt on a phone) that opens the
 * pack's dialog. The pack keeps the choice per model family in this browser;
 * Generate reads it, Use these settings puts a picture's styles back, and
 * Enhance aims at the chosen look.
 */

const ID = 'prompt-styler';
const ASSETS = '/api/extensions/prompt-styler/assets';

type Recipe = { styles: Array<{ id: string; intensity: number }> } & Record<string, unknown>;
type Pack = {
  Panel: React.ComponentType<{ profile?: Profile; prompt?: string; negative?: string; mode?: string }>;
  selection: (profile: Profile) => Recipe | undefined;
  restore: (profile: Profile, recipe: unknown) => void;
};

let loaded: Pack | null = null;
let loading: Promise<Pack> | null = null;
let warned = false;

function loadPack() {
  if (!document.querySelector('link[data-prompt-styler]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${ASSETS}/panel.css`;
    link.dataset.promptStyler = '';
    document.head.append(link);
  }
  return loading ||= import(/* @vite-ignore */ `${ASSETS}/react-panel.mjs`).then((module) => {
    loaded = { Panel: module.createPromptStylerPanel(React), selection: module.studioPromptStylerSelection, restore: module.restoreStudioPromptStylerSelection };
    return loaded;
  }).catch((error) => {
    loading = null;
    if (!warned) console.warn('[HEISS] Styles could not load PromptStyler Next:', error);
    warned = true;
    throw error;
  });
}

function usePack() {
  const [pack, setPack] = React.useState<Pack | null>(loaded);
  React.useEffect(() => {
    if (pack) return;
    let live = true;
    loadPack().then((next) => { if (live) setPack(next); }, () => undefined);
    return () => { live = false; };
  }, [pack]);
  return pack;
}

/** The chosen styles in words, as the pack composes them with no prompt: what Enhance aims at. */
async function lookOf(recipe: Recipe | undefined) {
  if (!recipe?.styles.length) return '';
  const response = await fetch('/api/promptstyler/v1/compose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...recipe, prompt: '', negative: '' }) });
  if (!response.ok) return '';
  const composition = await response.json();
  return typeof composition?.positive === 'string' ? composition.positive.replace(/\s+/g, ' ').trim().slice(0, 1500) : '';
}

function StylesTool({ context }: { context: ExtensionContext }) {
  const pack = usePack();
  const { profile, view } = context;
  if (!pack || !profile) return null;
  const { Panel } = pack;
  return (
    <span className={cn('styles-tool', context.phone && 'is-phone')}>
      <Panel profile={profile} prompt={view.prompt || ''} negative={view.negative || ''} mode={view.mode || 'image'} />
    </span>
  );
}

/** Hands Generate and Enhance the current choice, and puts restored styles back into the pack. */
function StylesRun({ context }: { context: ExtensionContext }) {
  const pack = usePack();
  const profile = React.useRef(context.profile);
  profile.current = context.profile;
  React.useEffect(() => {
    if (!pack) return;
    const current = () => (profile.current ? pack.selection(profile.current) : undefined);
    setRunValue(ID, current);
    setPromptLook(ID, () => lookOf(current()));
    return () => { setRunValue(ID, null); setPromptLook(ID, null); };
  }, [pack]);
  const restored = context.value;
  React.useEffect(() => {
    if (!pack || !context.profile || restored === undefined) return;
    try {
      pack.restore(context.profile, restored);
    } catch {
      context.showToast('Those styles can’t be used with this model.', 'warning');
    }
    context.setValue(undefined);
  // context is new each render; the restored value and the model are what matter.
  }, [pack, restored, context.profile?.id]);
  return null;
}

export const promptStyler: Extension = {
  id: ID,
  name: 'Styles',
  available: (context) => Boolean(context.profile?.promptStyler) && context.profile?.kind !== 'video',
  promptTools: [{ id: 'styles', render: (context) => <StylesTool context={context} /> }],
  background: [{ id: 'run', render: (context) => <StylesRun context={context} /> }],
  settings: {
    description: 'Looks, colour grades and effects from PromptStyler Next, chosen from the composer and added to each run. Workflows that support them show a Styles button.'
  }
};
