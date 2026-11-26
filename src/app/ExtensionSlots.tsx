import React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from './format';
import { Tip } from './components';
import { Modal } from './Modal';
import { Sheet } from './PhoneStudio';
import { haptic, HapticTarget } from './phoneControls';
import { extensionEnabled, extensions, type Extension, type ExtensionContext, type ItemActionSlot } from './extensions';
import type { GalleryItem } from './types';

/*
 * Where built-in extensions (extensions.ts) appear. Each host draws its slots
 * with the studio's own classes, so an extension's button is a tile icon, a
 * dock button or a phone row like any other. With no extensions every host
 * renders nothing, not even a wrapper.
 */

type Host = { view: Record<string, any>; phone: boolean; openPanel: (extensionId: string, panelId: string) => void };

const HostContext = React.createContext<Host | null>(null);

/** Gives the hosts the view and opens extension panels: a dialog on a computer, a full sheet on a phone. */
export function ExtensionsProvider({ view, phone, children }: React.PropsWithChildren<{ view: Record<string, any>; phone: boolean }>) {
  const [panel, setPanel] = React.useState<{ extensionId: string; panelId: string } | null>(null);
  const openPanel = React.useCallback((extensionId: string, panelId: string) => setPanel({ extensionId, panelId }), []);
  const host = React.useMemo(() => ({ view, phone, openPanel }), [view, phone, openPanel]);
  return (
    <HostContext.Provider value={host}>
      {children}
      {extensions.length ? <ExtensionPanel host={host} panel={panel} onClose={() => setPanel(null)} /> : null}
      {extensions.length ? <ExtensionBackground /> : null}
    </HostContext.Provider>
  );
}

function contextFor(extension: Extension, host: Host): ExtensionContext {
  const { view } = host;
  const profile = view.currentProfile || null;
  return {
    view,
    profile,
    config: profile?.extensions?.[extension.id],
    phone: host.phone,
    value: view.extensionValues?.[extension.id],
    setValue: (next) => view.setExtensionValues?.((values: Record<string, unknown>) => ({ ...values, [extension.id]: next })),
    openPanel: (panelId) => host.openPanel(extension.id, panelId),
    showToast: view.showToast
  };
}

/** The switched-on extensions that apply now, each with its context. */
function useLive(): Array<[Extension, ExtensionContext]> {
  const host = React.useContext(HostContext);
  if (!host || !extensions.length) return [];
  return extensions
    .filter((extension) => extensionEnabled(host.view.prefs, extension.id))
    .map((extension) => [extension, contextFor(extension, host)] as [Extension, ExtensionContext])
    .filter(([extension, context]) => extension.available?.(context) !== false);
}

function itemActions(live: Array<[Extension, ExtensionContext]>, slot: 'tile' | 'viewer', item: GalleryItem) {
  return live.flatMap(([extension, context]) => (extension[slot] || [])
    .filter((action) => action.when?.(item, context) !== false)
    .map((action) => ({ key: `${extension.id}:${action.id}`, action, context })));
}

const tipLabel = (action: ItemActionSlot) => (action.keyHint ? `${action.label} (${action.keyHint})` : action.label);

/** Each switched-on extension's background slots, mounted once inside the provider. */
function ExtensionBackground() {
  const live = useLive();
  return (
    <>
      {live.flatMap(([extension, context]) => (extension.background || []).map((slot) => (
        <React.Fragment key={`${extension.id}:${slot.id}`}>{slot.render(context)}</React.Fragment>
      )))}
    </>
  );
}

/** Beside the prompt: each extension's own control (promptTools), in the composer row or under the phone's prompt. */
export function ExtensionPromptTools() {
  const live = useLive();
  return (
    <>
      {live.flatMap(([extension, context]) => (extension.promptTools || []).map((slot) => (
        <React.Fragment key={`${extension.id}:${slot.id}`}>{slot.render(context)}</React.Fragment>
      )))}
    </>
  );
}

/** Composer: icon buttons beside Recent prompts, in the same family. */
export function ExtensionComposerActions() {
  const live = useLive();
  return (
    <>
      {live.flatMap(([extension, context]) => (extension.composer || []).map((slot) => {
        const Icon = slot.icon;
        const on = Boolean(slot.active?.(context));
        return (
          <Tip key={`${extension.id}:${slot.id}`} content={slot.label}>
            <button type="button" className={cn('negative-toggle is-density-mini', on && 'active')} aria-label={slot.label} aria-pressed={slot.active ? on : undefined} onClick={() => slot.run(context)}>
              <Icon size={14} />
            </button>
          </Tip>
        );
      }))}
    </>
  );
}

/** Phone Create sheet: rows in their own group after the model and size, each opening something like those do. */
export function ExtensionCreateRows() {
  const live = useLive();
  const rows = live.flatMap(([extension, context]) => (extension.createRows || []).map((slot) => ({ key: `${extension.id}:${slot.id}`, slot, context })));
  if (!rows.length) return null;
  return (
    <div className="phone-group">
      {rows.map(({ key, slot, context }) => {
        const Icon = slot.icon;
        const detail = slot.detail?.(context);
        return (
          <button key={key} type="button" className="phone-row" onClick={() => slot.run(context)}>
            <Icon size={20} />
            <span>{slot.label}{detail ? <small>{detail}</small> : null}</span>
            <ChevronRight size={18} className="phone-row-end" />
          </button>
        );
      })}
    </div>
  );
}

/** Tile hover icons (desktop) and the More menu's labels; `act` closes the menu first. */
export function ExtensionTileActions({ item, act }: { item: GalleryItem; act: (run: () => void) => void }) {
  const actions = itemActions(useLive(), 'tile', item);
  return (
    <>
      {actions.map(({ key, action, context }) => {
        const Icon = action.icon;
        return (
          <Tip key={key} content={tipLabel(action)} side="left">
            <button type="button" className="tile-icon" aria-label={action.label} onClick={() => act(() => action.run(item, context))}>
              <Icon size={14} /><span className="tile-menu-label">{action.shortLabel || action.label}</span>
            </button>
          </Tip>
        );
      })}
    </>
  );
}

/** The viewer: dock icon buttons on a computer, labelled buttons in the phone bar. */
export function ExtensionViewerActions({ item, phone = false }: { item: GalleryItem; phone?: boolean }) {
  const actions = itemActions(useLive(), 'viewer', item);
  return (
    <>
      {actions.map(({ key, action, context }) => {
        const Icon = action.icon;
        return phone ? (
          <button key={key} type="button" onClick={() => { haptic('tap'); action.run(item, context); }}>
            <Icon size={21} /><span>{action.shortLabel || action.label}</span><HapticTarget />
          </button>
        ) : (
          <Tip key={key} content={tipLabel(action)}>
            <button className="icon-button" aria-label={action.label} onClick={() => action.run(item, context)}><Icon size={15} /></button>
          </Tip>
        );
      })}
    </>
  );
}

/** The phone's long-press sheet for one item: rows before "Select several". */
export function ExtensionItemRows({ item, run }: { item: GalleryItem; run: (action: () => void) => void }) {
  const actions = itemActions(useLive(), 'tile', item);
  return (
    <>
      {actions.map(({ key, action, context }) => {
        const Icon = action.icon;
        return <button key={key} type="button" className="phone-row" onClick={() => run(() => action.run(item, context))}><Icon size={20} /><span>{action.label}</span></button>;
      })}
    </>
  );
}

function ExtensionPanel({ host, panel, onClose }: { host: Host; panel: { extensionId: string; panelId: string } | null; onClose: () => void }) {
  const extension = panel ? extensions.find((item) => item.id === panel.extensionId) : null;
  const slot = extension?.panels?.find((item) => item.id === panel?.panelId);
  // Keep the last panel's content while it animates closed.
  const last = React.useRef<{ extension: Extension; slot: NonNullable<Extension['panels']>[number] } | null>(null);
  if (extension && slot) last.current = { extension, slot };
  const shown = last.current;
  if (!shown) return null;
  const open = Boolean(extension && slot);
  const body = shown.slot.render(contextFor(shown.extension, host), onClose);
  return host.phone
    ? <Sheet open={open} onClose={onClose} title={shown.slot.title} full>{body}</Sheet>
    : <Modal open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={shown.slot.title} description={shown.slot.description} size={shown.slot.size || 'wide'}>{body}</Modal>;
}

/** Settings › Features rows, drawn by SettingsDialog with its own Group, drawer and switch. */
export function extensionSettingsRows(view: Record<string, any>, phone: boolean) {
  const host: Host = { view, phone, openPanel: () => undefined };
  return extensions.map((extension) => {
    const context = contextFor(extension, host);
    const on = extensionEnabled(view.prefs, extension.id);
    const summary = on ? extension.settings?.summary?.(context) : '';
    return {
      extension,
      on,
      description: on ? (summary ? `On · ${summary}` : 'On') : 'Off',
      body: on ? extension.settings?.render?.(context) : null,
      toggle: (next: boolean) => view.setPrefs({ extensions: { ...(view.prefs?.extensions || {}), [extension.id]: next } })
    };
  });
}
