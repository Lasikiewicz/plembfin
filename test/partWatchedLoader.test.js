import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { state } = await import("../public/modules/state.js");
const { loadPartWatched, resetPartWatchedView } = await import("../public/modules/dashboard.js");

function response(body, ok = true, status = 200) {
  return { ok, status, async json() { return body; } };
}

test("resetting Part Watched aborts the stale request without clobbering its replacement", async () => {
  state.token = "test-token";
  resetPartWatchedView("default");

  let staleSignal;
  globalThis.fetch = (_url, options = {}) => new Promise((resolve, reject) => {
    staleSignal = options.signal;
    staleSignal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });

  const staleLoad = loadPartWatched();
  assert.equal(state.partWatchedLoading, true);

  resetPartWatchedView("default");
  assert.equal(staleSignal.aborted, true);
  assert.equal(state.partWatchedLoading, false);

  globalThis.fetch = async () => response({ progress: [{ id: "fresh", media_key: "movie:fresh", media_type: "movie", title: "Fresh" }] });
  const freshLoad = loadPartWatched();
  await Promise.all([staleLoad, freshLoad]);

  assert.equal(state.partWatchedLoading, false);
  assert.deepEqual(state.partWatchedRaw.map((row) => row.id), ["fresh"]);
});

test("a failed Part Watched request clears loading instead of leaving the dashboard spinner stuck", async () => {
  resetPartWatchedView("default");
  globalThis.fetch = async () => response({ error: "backend unavailable" }, false, 503);

  await assert.rejects(loadPartWatched(), /backend unavailable/);
  assert.equal(state.partWatchedLoading, false);
  assert.equal(state.partWatchedHasMore, false);
});
