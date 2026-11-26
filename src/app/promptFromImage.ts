import type { Profile } from './types';

/**
 * A model that writes its own prompt from its start image (the workflow sets
 * heissUi.extensions["prompt-from-image"], server/prompt-from-image.js): what
 * you type is an optional direction, so Generate runs with the box empty.
 */
export function promptOptional(profile: Profile | null | undefined) {
  return Boolean(profile?.extensions && 'prompt-from-image' in profile.extensions);
}

/** The prompt box's placeholder: a painted mask, Hidden, an optional direction, or the usual. */
export function promptPlaceholder({ painting = false, hidden = false, optional = false }: { painting?: boolean; hidden?: boolean; optional?: boolean }) {
  if (painting) return 'Describe what the painted part becomes…';
  if (optional) return hidden ? 'Optional direction, kept private…' : 'Optional direction…';
  return hidden ? 'Describe what to make, privately…' : 'Describe what to make…';
}
