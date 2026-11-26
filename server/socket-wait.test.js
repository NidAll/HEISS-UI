import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.HEISS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-socket-wait-"));
const { waitForSocketOpen } = await import("./jobs.js");

const OPEN = 1, CLOSED = 3;

class FakeSocket extends EventTarget {
  constructor(readyState) { super(); this.readyState = readyState; this.listening = 0; }
  addEventListener(type, listener, options) { this.listening += 1; super.addEventListener(type, listener, options); }
  removeEventListener(type, listener, options) { this.listening -= 1; super.removeEventListener(type, listener, options); }
}

test("a socket that already closed is not waited for", { skip: typeof WebSocket !== "function" }, async () => {
  const started = Date.now();
  await waitForSocketOpen(new FakeSocket(CLOSED));
  assert.ok(Date.now() - started < 100);
});

test("once the socket opens, the wait leaves no listener behind", { skip: typeof WebSocket !== "function" }, async () => {
  const socket = new FakeSocket(0);
  const waiting = waitForSocketOpen(socket);
  assert.equal(socket.listening, 2);
  socket.readyState = OPEN;
  socket.dispatchEvent(new Event("open"));
  await waiting;
  assert.equal(socket.listening, 0);
});
