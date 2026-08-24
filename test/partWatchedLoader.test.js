import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { state, elements } = await import("../public/modules/state.js");
const { loadPartWatched, renderPartWatched, resetPartWatchedView } = await import("../public/modules/dashboard.js");

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

test("the loading placeholder is replaced when a refresh returns the same cards", () => {
  const panel = {
    dataset: {},
    innerHTML: "",
    querySelectorAll() { return []; },
  };
  elements.partWatchedPanel = panel;
  elements.partWatchedSection = { classList: { add() {}, remove() {} } };
  document.documentElement = { style: { setProperty() {} } };

  const item = { id: "same", media_key: "movie:same", media_type: "movie", title: "Same Item" };
  state.partWatchedRaw = [item];
  state.partWatchedHasMore = false;
  state.partWatchedLoading = false;
  state.partWatchedQueryKey = "default";
  renderPartWatched();
  const cardHtml = panel.innerHTML;
  assert.match(cardHtml, /Same Item/);

  state.partWatchedRaw = [];
  state.partWatchedLoading = true;
  renderPartWatched();
  assert.match(panel.innerHTML, /Loading partly watched items/);

  state.partWatchedRaw = [item];
  state.partWatchedLoading = false;
  renderPartWatched();
  assert.equal(panel.innerHTML, cardHtml);
  assert.doesNotMatch(panel.innerHTML, /Loading partly watched items/);
});
