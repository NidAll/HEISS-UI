import assert from "node:assert/strict";
import test from "node:test";
import { comfyContextLoader } from "./comfy-context.js";

function counted(reply = () => ({ info: { Node: {} } })) {
  const fetcher = async () => {
    fetcher.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return reply(fetcher.calls);
  };
  fetcher.calls = 0;
  return fetcher;
}

test("callers that arrive together share one fetch, and a fresh reply is reused", async () => {
  const fetcher = counted();
  const loader = comfyContextLoader(fetcher);
  const [a, b] = await Promise.all([loader.load(), loader.load()]);
  assert.equal(fetcher.calls, 1);
  assert.equal(a, b);
  assert.equal(await loader.load(), a);
  assert.equal(fetcher.calls, 1);
});

test("force always fetches anew", async () => {
  const fetcher = counted((n) => ({ n }));
  const loader = comfyContextLoader(fetcher);
  await loader.load();
  assert.equal((await loader.load({ force: true })).n, 2);
});

test("a stale reply serves the hot paths at once and is refreshed only when no job runs", async () => {
  const fetcher = counted((n) => ({ n }));
  let busy = true;
  const loader = comfyContextLoader(fetcher, { freshMs: 0, busy: () => busy, idleCheckMs: 5 });
  await loader.load();
  assert.equal((await loader.load({ allowStale: true })).n, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fetcher.calls, 1, "no refetch while a job runs");
  busy = false;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fetcher.calls, 2);
  assert.equal(loader.cached.n, 2);
});

test("without allowStale, an old reply is fetched again", async () => {
  const fetcher = counted((n) => ({ n }));
  const loader = comfyContextLoader(fetcher, { freshMs: 0 });
  await loader.load();
  assert.equal((await loader.load()).n, 2);
});

test("after a reset, a fetch that was already out doesn't fill the cache", async () => {
  const fetcher = counted((n) => ({ n }));
  const loader = comfyContextLoader(fetcher);
  const out = loader.load();
  loader.reset();
  await out;
  assert.equal(loader.cached, null);
});
