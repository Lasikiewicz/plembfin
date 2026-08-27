import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { applyWatchDateChoice, closeWatchDatePrompt, initWatchAction, savingEpisodeKeysForShow } = await import("../public/modules/watch-action.js");
const { state } = await import("../public/modules/state.js");

test("closeWatchDatePrompt removes every mounted date dialog", () => {
  const previousQuerySelectorAll = document.querySelectorAll;
  let removed = 0;
  const overlays = [
    { remove: () => { removed += 1; } },
    { remove: () => { removed += 1; } },
  ];

  document.querySelectorAll = (selector) => selector === ".watch-date-overlay" ? overlays : [];
  state.pendingWatchAction = { scope: "episode" };

  try {
    closeWatchDatePrompt();
    assert.equal(removed, overlays.length);
    assert.equal(state.pendingWatchAction, null);
  } finally {
    document.querySelectorAll = previousQuerySelectorAll;
  }
});

test("savingEpisodeKeysForShow includes episodes in concurrent watch actions", () => {
  state.savingWatchActions.clear();
  const action = {
    showTitle: "The Office",
    episodes: [{ key: "the-office:s04e16" }],
    resyncEpisodes: [{ key: "the-office:s04e17" }],
  };
  state.savingWatchActions.add(action);

  try {
    assert.deepEqual([...savingEpisodeKeysForShow("The Office")].sort(), ["the-office:s04e16", "the-office:s04e17"]);
  } finally {
    state.savingWatchActions.clear();
  }
});

test("watch-date selection renders the active show as Saving before sync resolves", async () => {
  const previousQuerySelectorAll = document.querySelectorAll;
  const previousQuerySelector = document.querySelector;
  const previousFetch = globalThis.fetch;
  const previousState = {
    activeShowModalKey: state.activeShowModalKey,
    activeShowModalSeason: state.activeShowModalSeason,
    activeShowRenderContext: state.activeShowRenderContext,
    pendingWatchAction: state.pendingWatchAction,
    showsRaw: state.showsRaw,
    showModalEpisodes: state.showModalEpisodes,
    showModalEpisodeIndex: state.showModalEpisodeIndex,
  };
  let removed = 0;
  const renderCalls = [];
  const overlays = [{ remove: () => { removed += 1; } }];
  const action = {
    scope: "episode",
    showTitle: "The Office",
    showTmdbId: "2316",
    episodes: [{
      key: "the-office:s04e16",
      showTitle: "The Office",
      showTmdbId: "2316",
      seasonNumber: 4,
      episodeNumber: 16,
      title: "After Hours",
      airDate: "2008-04-10",
    }],
    resyncEpisodes: [],
    referenceWatchedAt: "",
  };

  document.querySelectorAll = (selector) => selector === ".watch-date-overlay" ? overlays : [];
  document.querySelector = () => null;
  globalThis.fetch = async (url) => String(url).includes("/api/manual-watch")
    ? { ok: true, json: async () => ({ inserted: 1, skipped: 0, rejected: 0, propagated: 1, syncQueued: 1, results: [] }) }
    : { ok: true, json: async () => ({ show: { title: "The Office", episodes: [] } }) };
  initWatchAction({
    setMessage() {},
    clearDerivedUiCaches() {},
    renderShowModalContent: (show, options) => renderCalls.push({ show, options }),
    renderImmersiveShowModal: async () => {},
  });
  state.activeShowModalKey = "the-office";
  state.activeShowModalSeason = 4;
  state.activeShowRenderContext = {
    show: { title: "The Office", episodes: [] },
    activeSeasonNum: 4,
    tmdbData: null,
    seasonDetailsByNumber: new Map(),
    loading: false,
    imdbPillHtml: "",
  };
  state.showsRaw = [{ title: "The Office", episodes: [] }];
  state.showModalEpisodes = [];
  state.showModalEpisodeIndex = new Map();
  state.pendingWatchAction = action;
  state.savingWatchActions.clear();

  try {
    const update = applyWatchDateChoice("now");
    assert.equal(removed, 1);
    assert.equal(renderCalls.length, 1);
    assert.equal(renderCalls[0].options.activeSeasonNum, 4);
    assert.deepEqual([...state.savingWatchActions], [action]);
    await update;
    assert.equal(state.savingWatchActions.size, 0);
  } finally {
    document.querySelectorAll = previousQuerySelectorAll;
    document.querySelector = previousQuerySelector;
    globalThis.fetch = previousFetch;
    state.activeShowModalKey = previousState.activeShowModalKey;
    state.activeShowModalSeason = previousState.activeShowModalSeason;
    state.activeShowRenderContext = previousState.activeShowRenderContext;
    state.pendingWatchAction = previousState.pendingWatchAction;
    state.showsRaw = previousState.showsRaw;
    state.showModalEpisodes = previousState.showModalEpisodes;
    state.showModalEpisodeIndex = previousState.showModalEpisodeIndex;
    state.savingWatchActions.clear();
  }
});
