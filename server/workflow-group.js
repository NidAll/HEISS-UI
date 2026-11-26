/**
 * Workflow groups: a workflow names the group it belongs to, and the model
 * picker lists it under that name instead of the one "Your workflows" list.
 * The gallery search shows each group, and each workflow in one, as a chip
 * that keeps only the pictures made with it.
 *
 *   heissUi.extensions["workflow-group"] = { name: "Anime" }
 *
 * Workflows without a group stay under "Your workflows", with no chip.
 */

export const workflowGroup = {
  id: "workflow-group",
  workflow(config) {
    const name = String(config?.name ?? "").replace(/\s+/g, " ").trim();
    if (!name || name.length > 40) return null;
    return { name };
  },
  profile(profile, { config }) {
    profile.group = config.name;
  }
};
