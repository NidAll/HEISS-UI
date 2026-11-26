/**
 * Workflow options: a workflow offers some inputs of one of its nodes as
 * choices in a panel (a dialog on a computer, a sheet on a phone), opened from
 * the composer. What you pick goes with each run and is written into that node;
 * Use these settings brings it back. A node that writes a prompt of its own
 * (an image-to-prompt node) can be named in `written`, and the viewer then
 * shows what it wrote for each picture.
 *
 *   heissUi.extensions["workflow-options"] = {
 *     title: "Architect",
 *     node: "17",
 *     options: [
 *       { key: "detail", input: "detail", label: "Detail", kind: "choice",
 *         choices: [{ value: "concise", label: "Concise" }, { value: "detailed", label: "Detailed" }] },
 *       { key: "visual", input: "include_visual_details", label: "Visual description", kind: "boolean" },
 *       { key: "threshold", input: "general_threshold", label: "Tags from the image", kind: "number", min: 0.15, max: 0.7, step: 0.05 },
 *       { key: "exclude", input: "exclude_tags", label: "Never use these tags", kind: "text", maxLength: 600 }
 *     ],
 *     written: { node: "17", label: "Written prompt" }
 *   }
 *
 * Each option's default is the node's own value in the graph. A run's value
 * is checked against the options; anything else is dropped.
 */

const key = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, max).trim();
const short = (value, max = 40) => clean(value, max);

function option(raw, inputs) {
  if (!plain(raw) || !key.test(String(raw.key || "")) || typeof raw.input !== "string" || !(raw.input in inputs)) return null;
  const base = { key: raw.key, input: raw.input, label: short(raw.label || raw.key), ...(raw.hint ? { hint: short(raw.hint, 200) } : {}) };
  const current = inputs[raw.input];
  if (raw.kind === "choice") {
    const choices = (Array.isArray(raw.choices) ? raw.choices : []).filter((item) => plain(item) && ["string", "number"].includes(typeof item.value)).slice(0, 8)
      .map((item) => ({ value: item.value, label: short(item.label ?? item.value, 24), ...(item.hint ? { hint: short(item.hint, 200) } : {}) }));
    if (choices.length < 2) return null;
    return { ...base, kind: "choice", choices, default: choices.some((item) => item.value === current) ? current : choices[0].value };
  }
  if (raw.kind === "boolean") return { ...base, kind: "boolean", default: current === true };
  if (raw.kind === "number") {
    const min = Number(raw.min), max = Number(raw.max), step = Number(raw.step || 0.01);
    if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min) || !(step > 0)) return null;
    const value = Number(current);
    return { ...base, kind: "number", min, max, step, default: Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min };
  }
  if (raw.kind === "text") {
    const maxLength = Math.max(1, Math.min(2000, Math.round(Number(raw.maxLength) || 200)));
    return { ...base, kind: "text", maxLength, ...(raw.placeholder ? { placeholder: short(raw.placeholder, 80) } : {}), default: typeof current === "string" ? current.slice(0, maxLength) : "" };
  }
  return null;
}

export function optionsConfig(config, { graph } = {}) {
  if (!plain(config)) return null;
  const node = String(config.node ?? "");
  const inputs = graph?.[node]?.inputs;
  if (!plain(inputs)) return null;
  const options = [];
  for (const raw of Array.isArray(config.options) ? config.options.slice(0, 12) : []) {
    const item = option(raw, inputs);
    if (item && !options.some((other) => other.key === item.key)) options.push(item);
  }
  const writtenNode = String(config.written?.node ?? "");
  const written = graph?.[writtenNode] ? { node: writtenNode, label: short(config.written.label || "Written prompt") } : null;
  if (!options.length && !written) return null;
  return { title: short(config.title || "Options", 24), node, options, written };
}

/** A run's choices, kept only where they fit their option; the rest stay the workflow's own. */
export function sanitizeOptions(value, config) {
  if (!plain(value) || !config) return undefined;
  const result = {};
  for (const item of config.options) {
    if (!(item.key in value) || value[item.key] == null) continue;
    const raw = value[item.key];
    if (item.kind === "choice" && item.choices.some((choice) => choice.value === raw)) result[item.key] = raw;
    else if (item.kind === "boolean" && typeof raw === "boolean") result[item.key] = raw;
    else if (item.kind === "number" && Number.isFinite(Number(raw))) {
      const stepped = Math.round((Math.min(item.max, Math.max(item.min, Number(raw))) - item.min) / item.step) * item.step + item.min;
      result[item.key] = Math.round(stepped * 1000) / 1000;
    } else if (item.kind === "text" && typeof raw === "string") result[item.key] = clean(raw, item.maxLength);
  }
  return Object.keys(result).length ? result : undefined;
}

/** The written prompt from a finished run's outputs: the node's first text value. */
export function writtenText(outputs, config) {
  const text = outputs?.[config?.written?.node]?.text;
  const first = Array.isArray(text) ? text.find((value) => typeof value === "string" && value.trim()) : "";
  return first ? first.trim().slice(0, 12000) : "";
}

export const workflowOptions = {
  id: "workflow-options",
  workflow: optionsConfig,
  profile(profile, { config }) {
    profile.workflowOptions = { title: config.title, options: config.options.map(({ input: _input, ...item }) => item), written: config.written?.label || "" };
  },
  body(value, { workflow }) {
    return sanitizeOptions(value, workflow?.extensions?.["workflow-options"]);
  },
  settings(value) {
    return value;
  },
  graph(graph, { workflow, value }) {
    const config = workflow?.extensions?.["workflow-options"];
    const inputs = config && graph?.[config.node]?.inputs;
    if (!inputs || !value) return;
    for (const item of config.options) if (item.key in value) inputs[item.input] = value[item.key];
  },
  result(outputs, { workflow }) {
    const text = writtenText(outputs, workflow?.extensions?.["workflow-options"]);
    return text ? { written: text } : undefined;
  }
};
