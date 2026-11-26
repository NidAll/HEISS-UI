/**
 * Prompt from image: a workflow that writes its own prompt from its start image
 * (an image-to-prompt node feeding the text encoder) maps the prompt box to an
 * optional direction. Generate then runs with the box empty, as long as the
 * workflow's start or reference image is given (its media inputs require it).
 *
 *   heissUi.extensions["prompt-from-image"] = {}
 *
 * The client reads the same key from profile.extensions (promptFromImage.ts).
 * It needs a workflow that takes an image: a startImage control or a media input.
 */
export const promptFromImage = {
  id: "prompt-from-image",
  workflow(config, { controls, mediaInputs } = {}) {
    const takesImage = Boolean(controls?.startImage) || (Array.isArray(mediaInputs) && mediaInputs.some((input) => input?.kind === "image"));
    return takesImage ? {} : null;
  }
};

/** Whether a run of this custom workflow may have an empty prompt. */
export function promptIsOptional(workflow) {
  return Boolean(workflow?.extensions && "prompt-from-image" in workflow.extensions);
}
