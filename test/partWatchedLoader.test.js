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

// A fake card element good enough for renderPartWatched's own DOM calls:
// dataset for identity, and querySelector for the handful of sub-elements
// patchPartWatchedCardProgress reads/writes.
function makeFakeCard(id) {
  return {
    dataset: { partWatchedCardId: id },
    fill: { style: {} },
    text: { textContent: "" },
    lastPlayed: { textContent: "" },
    querySelector(selector) {
      if (selector === ".part-watched-progress-fill") return this.fill;
      if (selector === ".part-watched-progress-text") return this.text;
      if (selector === ".part-watched-last-played-value") return this.lastPlayed;
      return null;
    },
  };
}

// A fake panel that derives its "existing card" elements from whatever HTML
// was last assigned - close enough to a real DOM for renderPartWatched's
// purposes without pulling in a full DOM implementation. setCount lets a test
// assert a same-membership refresh never touches innerHTML at all.
function createFakePanel() {
  let html = "";
  let cards = [];
  let setCount = 0;
  return {
    dataset: {},
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      setCount += 1;
      cards = [...value.matchAll(/data-part-watched-card-id="([^"]*)"/g)].map(([, id]) => makeFakeCard(id));
    },
    querySelectorAll(selector) {
      return selector === "[data-part-watched-card-id]" ? cards : [];
    },
    get setCount() { return setCount; },
  };
}

test("a live refresh with the same cards patches progress in place instead of rebuilding the row", () => {
  const panel = createFakePanel();
  elements.partWatchedPanel = panel;
  elements.partWatchedSection = { classList: { add() {}, remove() {} } };
  document.documentElement = { style: { setProperty() {} } };

  const item = { id: "same", media_key: "movie:same", media_type: "movie", title: "Same Item", updated_at: 1000 };
  state.partWatchedRaw = [item];
  state.partWatchedHasMore = false;
  state.partWatchedLoading = false;
  state.partWatchedQueryKey = "default";

  renderPartWatched();
  assert.equal(panel.setCount, 1);
  assert.match(panel.innerHTML, /Same Item/);

  // A live refresh resets partWatchedRaw before re-fetching (resetPartWatchedView).
  // The card from before is still valid - it must stay on screen rather than
  // flashing a loading placeholder over it.
  state.partWatchedRaw = [];
  state.partWatchedLoading = true;
  renderPartWatched();
  assert.equal(panel.setCount, 1, "existing cards must not be replaced while a refresh is in flight");
  assert.doesNotMatch(panel.innerHTML, /Loading partly watched items/);

  // The refresh resolves with the same item further along - patched in place,
  // never touching innerHTML (and so never recreating the poster).
  state.partWatchedRaw = [{ ...item, updated_at: 2000 }];
  state.partWatchedLoading = false;
  renderPartWatched();
  assert.equal(panel.setCount, 1, "same membership must patch in place, not rebuild the row");
});

test("the loading placeholder only shows for a genuine first load with nothing on screen", () => {
  const panel = createFakePanel();
  elements.partWatchedPanel = panel;
  elements.partWatchedSection = { classList: { add() {}, remove() {} } };

  state.partWatchedRaw = [];
  state.partWatchedHasMore = false;
  state.partWatchedLoading = true;
  state.partWatchedQueryKey = "default";
  renderPartWatched();
  assert.match(panel.innerHTML, /Loading partly watched items/);
});

test("a genuine membership change rebuilds the row", () => {
  const panel = createFakePanel();
  elements.partWatchedPanel = panel;
  elements.partWatchedSection = { classList: { add() {}, remove() {} } };
  document.documentElement = { style: { setProperty() {} } };

  state.partWatchedRaw = [{ id: "a", media_key: "movie:a", media_type: "movie", title: "Item A" }];
  state.partWatchedHasMore = false;
  state.partWatchedLoading = false;
  state.partWatchedQueryKey = "default";
  renderPartWatched();
  assert.match(panel.innerHTML, /Item A/);

  state.partWatchedRaw = [{ id: "b", media_key: "movie:b", media_type: "movie", title: "Item B" }];
  renderPartWatched();
  assert.match(panel.innerHTML, /Item B/);
  assert.doesNotMatch(panel.innerHTML, /Item A/);
});
