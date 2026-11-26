import React from 'react';
import { ScrollText, Settings2 } from 'lucide-react';
import type { Extension, ExtensionContext } from './extensions';
import { PhoneSlider } from './phoneControls';
import { Row, Segmented, Switch } from './SettingsDialog';
import type { GalleryItem, Profile } from './types';

/*
 * Workflow options (server/workflow-options.js): a workflow offers some inputs
 * of one node as choices. The composer gets a button named for them (the
 * phone's Create sheet a row) that opens a panel: a dialog on a computer, a
 * sheet on a phone. The choices go with each run and come back with Use these
 * settings. When the workflow names a node that writes its own prompt, the
 * viewer shows what it wrote, with Copy and Use as prompt.
 */

type Option = NonNullable<Profile['workflowOptions']>['options'][number];
type Values = Record<string, string | number | boolean>;
const ID = 'workflow-options';

const optionsOf = (context: ExtensionContext) => context.profile?.workflowOptions || null;
const valuesOf = (context: ExtensionContext): Values => (context.value && typeof context.value === 'object' ? context.value as Values : {});
const current = (option: Option, values: Values) => (option.key in values ? values[option.key] : option.default);
const changedCount = (context: ExtensionContext) => {
  const values = valuesOf(context);
  return (optionsOf(context)?.options || []).filter((option) => option.key in values && values[option.key] !== option.default).length;
};
const written = (item: GalleryItem) => {
  const kept = (item.settings?.extensions as Record<string, { written?: unknown }> | undefined)?.[ID];
  return typeof kept?.written === 'string' ? kept.written : '';
};

function OptionControl({ option, value, phone, onChange }: { option: Option; value: string | number | boolean; phone: boolean; onChange: (next: string | number | boolean) => void }) {
  if (option.kind === 'choice') {
    const hint = option.choices.find((choice) => choice.value === value)?.hint || option.hint;
    return (
      <Row label={option.label} description={hint} stacked>
        <Segmented label={option.label} value={String(value)} options={option.choices.map((choice) => ({ value: String(choice.value), label: choice.label }))} onChange={(next) => onChange(option.choices.find((choice) => String(choice.value) === next)?.value ?? next)} />
      </Row>
    );
  }
  if (option.kind === 'boolean') {
    return (
      <Row label={option.label} description={option.hint}>
        <Switch label={option.label} checked={value === true} onChange={onChange} />
      </Row>
    );
  }
  if (option.kind === 'number') {
    const decimals = String(option.step).split('.')[1]?.length || 0;
    return phone
      ? <PhoneSlider label={option.label} value={Number(value)} min={option.min} max={option.max} step={option.step} onChange={onChange} format={(next) => next.toFixed(decimals)} hint={option.hint} />
      : (
        <Row label={option.label} description={option.hint}>
          <span className="workflow-option-range">
            <input type="range" min={option.min} max={option.max} step={option.step} value={Number(value)} aria-label={option.label} onChange={(event) => onChange(Number(event.target.value))} />
            <output>{Number(value).toFixed(decimals)}</output>
          </span>
        </Row>
      );
  }
  return (
    <Row label={option.label} description={option.hint} stacked>
      <input value={String(value)} maxLength={option.maxLength} placeholder={option.placeholder} aria-label={option.label} spellCheck={false} autoComplete="off" onChange={(event) => onChange(event.target.value)} />
    </Row>
  );
}

function OptionsPanel({ context, close }: { context: ExtensionContext; close: () => void }) {
  const config = optionsOf(context);
  if (!config) return null;
  const values = valuesOf(context);
  const set = (key: string, next: string | number | boolean) => {
    const option = config.options.find((item) => item.key === key);
    const { [key]: _old, ...rest } = values;
    // A choice back at the workflow's own value isn't sent at all.
    const merged = option && next === option.default ? rest : { ...rest, [key]: next };
    context.setValue(Object.keys(merged).length ? merged : undefined);
  };
  return (
    <div className="workflow-options">
      {config.options.map((option) => (
        <OptionControl key={option.key} option={option} value={current(option, values)} phone={context.phone} onChange={(next) => set(option.key, next)} />
      ))}
      <div className="workflow-options-foot">
        <button type="button" className="btn" disabled={!changedCount(context)} onClick={() => context.setValue(undefined)}>Reset to the workflow’s own</button>
        <button type="button" className="btn is-primary" onClick={close}>Done</button>
      </div>
    </div>
  );
}

// The picture whose written prompt the panel shows.
let shown: GalleryItem | null = null;

function WrittenPanel({ context, close }: { context: ExtensionContext; close: () => void }) {
  const text = shown ? written(shown) : '';
  if (!text) return null;
  return (
    <div className="workflow-written">
      <pre>{text}</pre>
      <div className="workflow-options-foot">
        <button type="button" className="btn" onClick={() => { void context.view.copyToClipboard?.(text); context.showToast('Copied', 'success'); }}>Copy</button>
        <button type="button" className="btn is-primary" onClick={() => { context.view.setPrompt?.(text); close(); context.showToast('In the prompt box', 'success'); }}>Use as prompt</button>
      </div>
    </div>
  );
}

export const workflowOptions: Extension = {
  id: ID,
  name: 'Workflow options',
  composer: [{
    id: 'options',
    label: (context) => `${optionsOf(context)?.title || 'Workflow options'}${changedCount(context) ? ` · ${changedCount(context)} changed` : ''}`,
    icon: Settings2,
    when: (context) => Boolean(optionsOf(context)?.options.length),
    active: (context) => changedCount(context) > 0,
    run: (context) => context.openPanel('options')
  }],
  createRows: [{
    id: 'options',
    label: (context) => optionsOf(context)?.title || 'Workflow options',
    icon: Settings2,
    when: (context) => Boolean(optionsOf(context)?.options.length),
    detail: (context) => {
      const count = changedCount(context);
      return count ? `${count} changed` : 'As the workflow has them';
    },
    run: (context) => context.openPanel('options')
  }],
  viewer: [{
    id: 'written',
    label: 'Written prompt',
    shortLabel: 'Written',
    icon: ScrollText,
    when: (item) => Boolean(written(item)),
    run: (item, context) => { shown = item; context.openPanel('written'); }
  }],
  panels: [
    { id: 'options', title: (context) => optionsOf(context)?.title || 'Workflow options', description: 'How this workflow runs. Your choices go with each run.', size: 'form', render: (context, close) => <OptionsPanel context={context} close={close} /> },
    { id: 'written', title: 'Written prompt', description: 'What the workflow wrote for this picture.', size: 'form', render: (context, close) => <WrittenPanel context={context} close={close} /> }
  ],
  settings: {
    description: 'Choices a workflow offers for how it runs, in a panel from the composer, and the prompt a workflow wrote for a picture, in the viewer.'
  },
  restore: (kept) => {
    if (!kept || typeof kept !== 'object') return undefined;
    const { written: _written, ...values } = kept as Record<string, unknown>;
    return Object.keys(values).length ? values : undefined;
  }
};
