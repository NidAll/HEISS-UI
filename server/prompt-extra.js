/**
 * What a generation run tells ComfyUI beside its graph. Live previews are GPU
 * work every step: asked for, they use ComfyUI's "auto" method; switched off
 * (Settings › Generation › Previews), the run keeps ComfyUI's own launch policy,
 * e.g. --preview-method none. heiss_hidden stays with a Hidden run in ComfyUI's
 * history, so no recovery ever takes it for a gallery image.
 */
export function promptExtraData(body = {}, hidden = false) {
  return {
    ...(body.livePreview !== false ? { preview_method: "auto" } : {}),
    ...(hidden ? { heiss_hidden: true } : {})
  };
}
