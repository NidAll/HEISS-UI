/**
 * ComfyUI's node list (/object_info) and system stats, as the generate check,
 * the model list and the workflow list read them. A fetch costs ComfyUI real
 * work (it lists every node and model file), so callers share one: a reply up
 * to `freshMs` old is reused, and callers that arrive while one is out wait
 * for it instead of asking again.
 *
 * `allowStale` is for the hot paths (Generate, the workflow list): they take a
 * reply up to `staleMs` old at once, and a new one is fetched only once no job
 * is queued or running, so the refetch never competes with a sampler. A
 * caller that finds something missing from a stale reply asks again with
 * `force` (see generate in index.js).
 */
export function comfyContextLoader(fetchContext, { freshMs = 30_000, staleMs = 15 * 60_000, busy = () => false, idleCheckMs = 2000, unreachable = () => false } = {}) {
  let cache = null;
  let fetchedAt = 0;
  let pending = null;
  let idleTimer = null;
  // A reset (a new ComfyUI address) makes any fetch still out stale on arrival.
  let generation = 0;

  function fetchNow() {
    const started = generation;
    const request = fetchContext().then((context) => {
      if (started === generation) {
        cache = context;
        fetchedAt = Date.now();
      }
      return context;
    }).finally(() => {
      if (pending === request) pending = null;
    });
    pending = request;
    return request;
  }

  function refreshWhenIdle() {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      if (busy()) return;
      clearInterval(idleTimer);
      idleTimer = null;
      if (Date.now() - fetchedAt >= freshMs) fetchNow().catch(() => null);
    }, idleCheckMs);
    idleTimer.unref?.();
  }

  async function load({ force = false, allowStale = false } = {}) {
    const age = Date.now() - fetchedAt;
    if (!force && cache && age < freshMs) return cache;
    if (!force && allowStale && cache && age < staleMs && !unreachable()) {
      refreshWhenIdle();
      return cache;
    }
    // A forced fetch starts its own: one already out may predate a rescan or restart.
    if (!force && pending) return pending;
    return fetchNow();
  }

  return {
    load,
    /** The last reply, or null: for readers that must not fetch. */
    get cached() { return cache; },
    /** Forget the last reply, e.g. after switching to another ComfyUI. */
    reset() {
      generation += 1;
      cache = null;
      fetchedAt = 0;
      pending = null;
    }
  };
}
