/**
 * Sampling modes: a workflow tuned for a few step counts names them, and the
 * steps control offers only those, by name, in place of a free number.
 *
 *   heissUi.extensions["sampling-modes"] = {
 *     modes: [{ steps: 8, label: "Quality (8-step)" }, { steps: 4, label: "Flash (4-step)" }]
 *   }
 *
 * The choices reach the client as the profile's constraints.steps.choices, and
 * Generate turns down any other count for that model (validation.js). The
 * workflow needs a mapped steps control; without one the config is ignored.
 */
export const samplingModes = {
  id: "sampling-modes",
  workflow(config, { controls } = {}) {
    if (!controls?.steps) return null;
    const seen = new Set();
    const modes = [];
    for (const item of Array.isArray(config?.modes) ? config.modes : []) {
      const steps = Math.round(Number(item?.steps));
      if (!(steps >= 1 && steps <= 10000) || seen.has(steps)) continue;
      seen.add(steps);
      modes.push({ steps, label: String(item?.label || "").trim().slice(0, 40) || `${steps} steps` });
    }
    // One mode is no choice: the workflow's own steps default says it already.
    return modes.length >= 2 ? { modes } : null;
  },
  profile(profile, { config }) {
    const choices = config.modes.map(({ steps, label }) => ({ value: steps, label }));
    const current = Number(profile.defaults?.steps);
    return {
      ...profile,
      defaults: choices.some((choice) => choice.value === current) ? profile.defaults : { ...profile.defaults, steps: choices[0].value },
      constraints: { ...profile.constraints, steps: { ...(profile.constraints?.steps || {}), choices } }
    };
  }
};
