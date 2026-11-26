import { RotateCcw, Scaling, Stamp } from 'lucide-react';
import type { Extension, ExtensionContext } from './extensions';
import { promptOptional } from './promptFromImage';
import type { GalleryItem, Profile } from './types';

/*
 * Quick actions on a finished picture, on its tile, in the viewer and in the
 * phone's sheets:
 *   Again       the same run with a new seed
 *   Clone this  the picture as the start image of a model that writes its own
 *               prompt from it (a workflow with prompt-from-image)
 *   Final 2K    the same seed at the workflow's own 2K size for that shape
 *               (a workflow with size-tiers)
 * Again and Final need the picture's model to be installed and ready.
 */

const profiles = (context: ExtensionContext): Profile[] => context.view.models?.profiles || [];
const ready = (profile: Profile | undefined): profile is Profile => Boolean(profile) && profile!.ready !== false;
const finished = (item: GalleryItem) => item.status === 'done' && !item.vaultLocked && !item.library;
const nameOf = (profile: Profile) => profile.displayName || profile.label || 'that model';

/** The model that made this picture, while it is still installed. */
function ownProfile(item: GalleryItem, context: ExtensionContext) {
  const id = String(item.settings?.profileId || item.model || '');
  return profiles(context).find((profile) => profile.id === id);
}

/** The first ready model that writes its own prompt from a start image (the server only allows it on workflows that take one). */
function cloneProfile(context: ExtensionContext) {
  return profiles(context).find((profile) => ready(profile) && profile.kind === 'image' && promptOptional(profile));
}

/** This picture's size at its workflow's 2K tier, when the workflow has one for it. */
function finalSize(item: GalleryItem, context: ExtensionContext) {
  const profile = ownProfile(item, context);
  const width = Number(item.settings?.width || item.width || 0);
  const height = Number(item.settings?.height || item.height || 0);
  return ready(profile) ? profile.native?.sizes2k?.[`${width}x${height}`] : undefined;
}

const retry = (context: ExtensionContext) => context.view.failureFixes?.retry as ((item: GalleryItem, options: Record<string, unknown>) => Promise<void>) | undefined;

const again = {
  id: 'again',
  label: 'Again',
  icon: RotateCcw,
  when: (item: GalleryItem, context: ExtensionContext) => finished(item) && ready(ownProfile(item, context)),
  run: (item: GalleryItem, context: ExtensionContext) => { void retry(context)?.(item, { newSeed: true, label: 'Again, with a new seed' }); }
};

const clone = {
  id: 'clone',
  label: 'Clone this',
  shortLabel: 'Clone',
  icon: Stamp,
  when: (item: GalleryItem, context: ExtensionContext) => finished(item) && item.type === 'image' && Boolean(item.url) && Boolean(cloneProfile(context)),
  run: async (item: GalleryItem, context: ExtensionContext) => {
    const target = cloneProfile(context);
    if (!target) return;
    if (await context.view.useOutputInModel?.(item, target.id)) context.showToast(`Sent to ${nameOf(target)}. Press Generate to clone it.`, 'success');
  }
};

const final = {
  id: 'final',
  label: 'Final 2K',
  shortLabel: 'Final',
  icon: Scaling,
  when: (item: GalleryItem, context: ExtensionContext) => finished(item) && item.type === 'image' && Boolean(finalSize(item, context)),
  run: (item: GalleryItem, context: ExtensionContext) => {
    const size = finalSize(item, context);
    if (size) void retry(context)?.(item, { size, label: `Final at ${size.width} × ${size.height}` });
  }
};

export const quickActions: Extension = {
  id: 'quick-actions',
  name: 'Quick actions',
  tile: [again, clone, final],
  viewer: [again, clone, final],
  settings: {
    description: 'Again, Clone this and Final 2K on finished pictures: a new seed, the picture as a start image, or the same seed at the model’s 2K size.'
  }
};
