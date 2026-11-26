/**
 * Parts of the studio a person can switch off in Settings › Features, for a
 * simpler studio. Everything is on unless switched off; switching a part off
 * hides it and its settings, and nothing it would send is sent.
 */
export type FeatureId = 'video' | 'negative' | 'variants' | 'steps' | 'findModels' | 'community' | 'hfToken' | 'civitai' | 'earlierImages';

export const featureSwitches: Array<{ id: FeatureId; label: string; description: string }> = [
  { id: 'video', label: 'Video', description: 'The Image and Video switch, video models in the model gallery, and the video starting values.' },
  { id: 'negative', label: 'Negative prompt', description: 'The Negative button in the prompt bar. Off sends no negative prompt.' },
  { id: 'variants', label: 'Images per run', description: 'The Images control in the prompt bar. Off makes one image per run.' },
  { id: 'steps', label: 'Steps', description: 'The Steps control. Off uses each model’s own count; named modes such as Flash stay.' },
  { id: 'findModels', label: 'Find models', description: 'Find models, the starter models and model downloads.' },
  { id: 'community', label: 'Community links', description: 'Join the Discord, Idea or bug, and the links in About.' },
  { id: 'hfToken', label: 'Hugging Face token', description: 'The token field in Settings › Models, for gated downloads.' },
  { id: 'civitai', label: 'Civitai-ready images', description: 'The Library setting that saves pictures in the format Civitai reads.' },
  { id: 'earlierImages', label: 'Earlier images', description: 'Bringing in pictures from another app’s output folder, in Library.' }
];

/** Switched on unless turned off in Settings › Features. */
export function featureOn(prefs: { features?: Partial<Record<FeatureId, boolean>> } | undefined, id: FeatureId) {
  return prefs?.features?.[id] !== false;
}
