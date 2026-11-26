/**
 * Size tiers: a workflow trained for a second, larger size says what the size
 * menu's 2K tab draws for it, in place of each shape with its long side at 2048.
 *
 *   heissUi.extensions["size-tiers"] = { tiers: [{ label: "2K", megapixels: 2.36, divisibleBy: 64 }] }
 *
 * Each of the workflow's shapes is drawn at `megapixels` million pixels, both
 * sides on a `divisibleBy` grid, rounded the way ComfyUI's Flux resolution
 * calculator rounds (whole pixels first, then to the nearest grid line, ties to
 * the even one), then onto the size node's own step. 2.36 MP at 64 gives
 * 1536 × 1536, 1344 × 1792 for 3:4 and 1152 × 2048 for 9:16. The model is
 * marked as made for that size, so the 2K tab doesn't warn about it.
 */

/** One side onto the size node's step and limits (models.js imports this file's registry, so not from there). */
function onNodeStep(value, meta = {}) {
  const step = Number(meta.step || 1) || 1;
  const min = Number(meta.min || step) || step;
  const max = Number(meta.max || 16384) || 16384;
  return Math.max(min, Math.min(max, Math.round(value / step) * step));
}

function gridSide(value, grid) {
  const units = Math.trunc(value) / grid;
  const lower = Math.floor(units);
  return (units - lower === 0.5 ? lower + (lower % 2) : Math.round(units)) * grid;
}

/** A shape `ratioW`:`ratioH` at `megapixels` million pixels on the grid. */
export function tierSize(ratioW, ratioH, { megapixels, divisibleBy }) {
  const scale = Math.sqrt((megapixels * 1_000_000) / Math.max(1e-9, ratioW * ratioH));
  return { width: gridSide(ratioW * scale, divisibleBy), height: gridSide(ratioH * scale, divisibleBy) };
}

/** The workflow's own ratio for a preset label ("Portrait" → 3:4), as aspectRatios declares it. */
function declaredRatio(aspectRatios, label) {
  for (const item of Array.isArray(aspectRatios) ? aspectRatios : []) {
    const [name, w, h] = Array.isArray(item) ? item : [item?.label || item?.value, item?.w, item?.h];
    if (name === label && Number(w) > 0 && Number(h) > 0) return [Number(w), Number(h)];
  }
  return null;
}

export const sizeTiers = {
  id: "size-tiers",
  workflow(config) {
    const tiers = Array.isArray(config?.tiers) ? config.tiers : [];
    // The size menu has one larger tab, 2K; that is the tier a workflow can set.
    const tier = tiers.find((item) => String(item?.label || "").trim().toUpperCase() === "2K");
    if (!tier) return null;
    const megapixels = Number(tier.megapixels);
    const divisibleBy = Math.round(Number(tier.divisibleBy ?? 64));
    if (!(megapixels > 0 && megapixels <= 16) || !(divisibleBy >= 8 && divisibleBy <= 256)) return null;
    return { megapixels, divisibleBy };
  },
  profile(profile, { config, workflow }) {
    const sizes2k = {};
    for (const preset of profile.aspectPresets || []) {
      const [ratioW, ratioH] = declaredRatio(workflow?.aspectRatios, preset.label) || [preset.w, preset.h];
      const size = tierSize(ratioW, ratioH, config);
      sizes2k[preset.value] = {
        width: onNodeStep(size.width, profile.constraints?.width),
        height: onNodeStep(size.height, profile.constraints?.height)
      };
    }
    return { ...profile, native: { ...profile.native, "2k": "yes", sizes2k } };
  }
};
