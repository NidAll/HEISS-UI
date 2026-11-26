import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.HEISS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-wf-thumb-"));
const { gallery } = await import("./gallery-store.js");
const { latestThumbnailFor } = await import("./workflow-catalog.js");

const item = (n, extra = {}) => ({ id: `i${n}`, status: "done", type: "image", url: `/comfy/view?filename=${n}.png`, thumbnailUrl: `/comfy/thumb?filename=${n}.png`, settings: { profileId: "custom:a" }, ...extra });

test("a card shows its saved picture's thumbnail while that picture is in the gallery", () => {
  gallery.splice(0, gallery.length, item(2), item(1));
  assert.equal(latestThumbnailFor("custom:a", "a", { thumbnails: { "custom:a": "/comfy/view?filename=1.png" } }), "/comfy/thumb?filename=1.png");
});

test("once the saved picture is gone, the newest one made with the template takes its place", () => {
  gallery.splice(0, gallery.length, item(3), item(2));
  assert.equal(latestThumbnailFor("custom:a", "a", { thumbnails: { "custom:a": "/comfy/view?filename=1.png" } }), "/comfy/thumb?filename=3.png");
});

test("a Hidden picture is never a card's picture", () => {
  gallery.splice(0, gallery.length, item(3, { privateVault: true }), item(2));
  assert.equal(latestThumbnailFor("custom:a", "a", { thumbnails: { "custom:a": "/comfy/view?filename=3.png" } }), "/comfy/thumb?filename=2.png");
  gallery.splice(0, gallery.length);
  assert.equal(latestThumbnailFor("custom:a", "a", {}), "");
});
