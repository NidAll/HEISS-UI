import type React from 'react';
import type { LucideIcon } from 'lucide-react';
import type { GalleryItem, Profile } from './types';

/**
 * Built-in extensions: features that plug into the studio's existing places
 * (the composer, tiles, the viewer, Settings › Features, dialogs and sheets)
 * without editing them. Each one is an object added to `extensions` below;
 * every slot is optional and renders with the studio's own controls, so an
 * extension looks like the rest of the app. With the list empty nothing
 * renders and nothing is sent.
 *
 * Its server half (routes, workflow config, run values) lives in
 * server/extensions.js under the same id. Guide: docs/guides/EXTENSIONS.md.
 */

/** What a slot gets when it renders or runs. */
export type ExtensionContext = {
  /** The studio's view bag, as StudioView gets it. */
  view: Record<string, any>;
  profile: Profile | null;
  /** This extension's normalized `heissUi.extensions.<id>` for the current model, if it has one. */
  config: unknown;
  phone: boolean;
  /** This extension's value for the next run; sent as `extensions.<id>` with Generate. */
  value: unknown;
  setValue: (next: unknown) => void;
  /** Opens one of this extension's panels: a dialog on a computer, a sheet on a phone. */
  openPanel: (panelId: string) => void;
  showToast: (message: string, tone?: string, options?: Record<string, unknown>) => void;
};

/** A button beside Recent prompts in the composer. Icon-only like it, with the label in the tooltip. */
export type ComposerSlot = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Lit while its feature is in use for the next run. */
  active?: (context: ExtensionContext) => boolean;
  run: (context: ExtensionContext) => void;
};

/** A row in the phone's Create sheet: an icon, a label and an optional line under it. */
export type CreateRowSlot = {
  id: string;
  label: string;
  icon: LucideIcon;
  detail?: (context: ExtensionContext) => string;
  run: (context: ExtensionContext) => void;
};

/** An action on one gallery item: a tile's hover icons, the viewer dock, the phone's sheets and bar. */
export type ItemActionSlot = {
  id: string;
  label: string;
  /** Short word for the phone viewer bar; defaults to the label. */
  shortLabel?: string;
  icon: LucideIcon;
  /** Key shown in the tooltip, e.g. "A". Handling the key is up to the extension. */
  keyHint?: string;
  when?: (item: GalleryItem, context: ExtensionContext) => boolean;
  run: (item: GalleryItem, context: ExtensionContext) => void;
};

export type PanelSlot = {
  id: string;
  title: string;
  description?: string;
  /** The dialog size on a computer; phones always get a full sheet. */
  size?: 'form' | 'wide' | 'sheet';
  render: (context: ExtensionContext, close: () => void) => React.ReactNode;
};

/** Its drawer in Settings › Features. The on/off switch is drawn for it; this adds what sits under it. */
export type SettingsSlot = {
  /** One or two sentences under the switch: what it does. */
  description: string;
  /** The drawer's summary while on, after "On · ". */
  summary?: (context: ExtensionContext) => string;
  render?: (context: ExtensionContext) => React.ReactNode;
};

export type Extension = {
  id: string;
  name: string;
  /** Whether it applies right now, e.g. only for models whose workflow configures it. */
  available?: (context: ExtensionContext) => boolean;
  composer?: ComposerSlot[];
  createRows?: CreateRowSlot[];
  tile?: ItemActionSlot[];
  viewer?: ItemActionSlot[];
  panels?: PanelSlot[];
  settings?: SettingsSlot;
  /** "Use these settings": the value to bring back from an output's `settings.extensions.<id>`. Default: as kept. */
  restore?: (kept: unknown) => unknown;
};

export const extensions: Extension[] = [];

/** Switched on unless turned off in Settings › Features. */
export function extensionEnabled(prefs: { extensions?: Record<string, boolean> } | undefined, id: string) {
  return prefs?.extensions?.[id] !== false;
}

/** The values to send with a run: only switched-on extensions, only values that are set. */
export function extensionRunValues(values: Record<string, unknown> | undefined, prefs: { extensions?: Record<string, boolean> } | undefined, list: Extension[] = extensions) {
  const result: Record<string, unknown> = {};
  for (const extension of list) {
    const value = values?.[extension.id];
    if (value !== undefined && value !== null && extensionEnabled(prefs, extension.id)) result[extension.id] = value;
  }
  return result;
}

/** "Use these settings": each extension's value from an output's kept settings. */
export function restoredExtensionValues(kept: unknown, list: Extension[] = extensions) {
  const result: Record<string, unknown> = {};
  if (!kept || typeof kept !== 'object') return result;
  for (const extension of list) {
    if (!(extension.id in (kept as Record<string, unknown>))) continue;
    const value = (kept as Record<string, unknown>)[extension.id];
    const restored = extension.restore ? extension.restore(value) : value;
    if (restored !== undefined) result[extension.id] = restored;
  }
  return result;
}
