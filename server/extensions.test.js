import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.HEISS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-extensions-"));
const {
  applyExtensionGraph, applyExtensionProfile, checkedExtensions, extensionRequiredNodes, extensionSettings,
  extensionWorkflowConfig, registerExtensionRoutes, sanitizeExtensionBody, serverExtensions
} = await import("./extensions.js");
const { detectWorkflowMetadata, metadataFromJson, saveImportedWorkflow } = await import("./custom-workflows.js");
const { generationSettings } = await import("./gallery-store.js");

// A small extension that uses every hook, as a real one would.
const notes = {
  id: "notes",
  routes(app, { requireLocal }) { app.get("/api/notes", (req, res) => { if (!requireLocal(req, res)) return; res.json({ ok: true }); }); },
  workflow(config) {
    if (!config?.node) throw new Error("A notes config needs a node.");
    return { node: String(config.node), input: String(config.input || "text") };
  },
  body(value) {
    if (value == null) return undefined;
    if (typeof value !== "string") throw new Error("A note must be text.");
    return value.trim().slice(0, 200);
  },
  settings(value, { privateVault }) { return privateVault ? undefined : value; },
  graph(graph, { workflow, value }) {
    const target = workflow?.extensions?.notes;
    if (target && value) graph[target.node].inputs[target.input] = value;
    return graph;
  },
  requiredNodes: () => ["NoteNode"],
  profile(profile, { config }) { return { ...profile, notesNode: config.node }; }
};

test("the studio ships with no extensions, and every helper is then a no-op", () => {
  assert.deepEqual(serverExtensions, []);
  assert.deepEqual(extensionWorkflowConfig({ notes: { node: "1" } }), {});
  assert.deepEqual(sanitizeExtensionBody({ notes: "hi" }), {});
  assert.deepEqual(extensionSettings({ extensions: { notes: "hi" } }), {});
  const graph = { 1: { class_type: "Note", inputs: {} } };
  assert.equal(applyExtensionGraph(graph, { extensions: { notes: "hi" } }), graph);
  assert.deepEqual(extensionRequiredNodes({ notes: {} }), []);
  const profile = { id: "custom:plain" };
  assert.equal(applyExtensionProfile(profile, { extensions: { notes: { node: "1" } } }), profile);
});

test("ids are checked: lowercase, dashes, no repeats", () => {
  assert.throws(() => checkedExtensions([{ id: "Notes" }]), /lowercase/);
  assert.throws(() => checkedExtensions([{ id: "a" }, { id: "a" }]), /Two extensions/);
  assert.equal(checkedExtensions([notes]).length, 1);
});

test("routes register behind the guards they are given", () => {
  const routes = [];
  registerExtensionRoutes({ get: (route) => routes.push(route) }, { requireLocal: () => true }, [notes]);
  assert.deepEqual(routes, ["/api/notes"]);
});

test("a workflow config is kept only for an extension that understands it, and a broken one is dropped", () => {
  assert.deepEqual(extensionWorkflowConfig({ notes: { node: 7 }, unknown: { a: 1 } }, {}, [notes]), { notes: { node: "7", input: "text" } });
  assert.deepEqual(extensionWorkflowConfig({ notes: {} }, {}, [notes]), {});
  assert.deepEqual(extensionWorkflowConfig("not an object", {}, [notes]), {});
  assert.deepEqual(extensionRequiredNodes({ notes: { node: "7" } }, [notes]), ["NoteNode"]);
});

test("a run's value is checked by its extension; unknown values are dropped and a refusal stops the run", () => {
  assert.deepEqual(sanitizeExtensionBody({ notes: "  hello  ", other: 1 }, {}, [notes]), { notes: "hello" });
  assert.deepEqual(sanitizeExtensionBody({ notes: null }, {}, [notes]), {});
  assert.throws(() => sanitizeExtensionBody({ notes: 5 }, {}, [notes]), /must be text/);
});

test("the gallery keeps what the extension allows, and a Hidden run keeps less", () => {
  assert.deepEqual(extensionSettings({ extensions: { notes: "hello" } }, [notes]), { notes: "hello" });
  assert.deepEqual(extensionSettings({ extensions: { notes: "hello" }, privateVault: true }, [notes]), {});
});

test("the graph hook runs where the workflow configures it or the run sends a value", () => {
  const workflow = { extensions: { notes: { node: "1", input: "text" } } };
  const graph = applyExtensionGraph({ 1: { class_type: "Note", inputs: {} } }, { extensions: { notes: "hi" } }, workflow, [notes]);
  assert.equal(graph[1].inputs.text, "hi");
  const untouched = { 1: { class_type: "Note", inputs: {} } };
  assert.equal(applyExtensionGraph(untouched, {}, null, [notes]), untouched);
});

test("with no extensions, workflows and gallery settings look as they did", () => {
  const workflow = metadataFromJson({
    heissUi: { id: "plain", extensions: { notes: { node: "1" } } },
    1: { class_type: "CLIPTextEncode", inputs: { text: "" } }
  });
  assert.deepEqual(workflow.extensions, {});
  assert.deepEqual(workflow.requiredNodes, ["CLIPTextEncode"]);
  assert.equal("extensions" in generationSettings({ kind: "image", extensions: { notes: "hi" } }), false);
});

test("importing keeps heissUi.extensions as written, for whichever extensions read it later", () => {
  const raw = {
    heissUi: { id: "keeps-extensions", name: "Keeps extensions", kind: "image", extensions: { notes: { node: "1" } } },
    1: { class_type: "CLIPTextEncode", inputs: { text: "" } }
  };
  assert.deepEqual(detectWorkflowMetadata(raw).extensions, { notes: { node: "1" } });
  assert.equal("extensions" in detectWorkflowMetadata({ 1: raw[1] }), false);
  const saved = saveImportedWorkflow(raw, detectWorkflowMetadata(raw));
  assert.deepEqual(JSON.parse(fs.readFileSync(saved.path, "utf8")).heissUi.extensions, { notes: { node: "1" } });
});

test("the profile hook changes only the profiles of workflows that configure it", () => {
  const configured = applyExtensionProfile({ id: "custom:a" }, { extensions: { notes: { node: "4" } } }, [notes]);
  assert.equal(configured.notesNode, "4");
  const plain = { id: "custom:b" };
  assert.equal(applyExtensionProfile(plain, { extensions: {} }, [notes]), plain);
  assert.equal(applyExtensionProfile(plain, null, [notes]), plain);
});
