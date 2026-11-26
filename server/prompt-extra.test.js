import assert from "node:assert/strict";
import test from "node:test";
import { promptExtraData } from "./prompt-extra.js";

test("live previews are asked for unless switched off, and a Hidden run is marked", () => {
  assert.deepEqual(promptExtraData({}), { preview_method: "auto" });
  assert.deepEqual(promptExtraData({ livePreview: true }, true), { preview_method: "auto", heiss_hidden: true });
  assert.deepEqual(promptExtraData({ livePreview: false }), {});
  assert.deepEqual(promptExtraData({ livePreview: false }, true), { heiss_hidden: true });
});
