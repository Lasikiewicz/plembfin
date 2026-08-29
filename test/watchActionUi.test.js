import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { applyWatchDateChoice, closeWatchDatePrompt, initWatchAction, renderWatchDatePrompt, savingEpisodeKeysForShow, watchActionFromButton, watchedAtForChoice, watchedAtForEpisodeBatch, watchedReferenceFor } = await import("../public/modules/watch-action.js");
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

test("single episode watch-date reference uses the nearest watched episode before the target", () => {
  const watchedAt = "2026-08-12T12:00:00.000Z";
  const reference = watchedReferenceFor([
    { seasonNumber: 1, episodeNumber: 1, watched: { watched_at: watchedAt }, runtime: 23 },
    { seasonNumber: 1, episodeNumber: 2 },
    { seasonNumber: 1, episodeNumber: 3, watched: { watched_at: "2026-08-12T12:30:00.000Z" }, runtime: 24 },
  ], { seasonNumber: 1, episodeNumber: 2 });

  assert.deepEqual(reference, {
    watchedAt,
    label: "S01E01",
    runtime: 23,
    direction: "after_last",
  });
  assert.equal(
    watchedAtForChoice("match_watched", {}, "", 0, watchedAt, reference.direction, reference.runtime),
    "2026-08-12T12:24:00.000Z",
  );
});

test("single episode watch-date reference uses the next watched episode when no previous episode is watched", () => {
  const watchedAt = "2026-08-12T12:00:00.000Z";
  const reference = watchedReferenceFor([
    { seasonNumber: 1, episodeNumber: 1 },
    { seasonNumber: 1, episodeNumber: 2, watched: { watched_at: watchedAt }, runtime: 23 },
  ], { seasonNumber: 1, episodeNumber: 1 });

  assert.deepEqual(reference, {
    watchedAt,
    label: "S01E02",
    runtime: 23,
    direction: "before_next",
  });
  assert.equal(
    watchedAtForChoice("match_watched", {}, "", 0, watchedAt, reference.direction, reference.runtime),
    "2026-08-12T11:36:00.000Z",
  );
});

test("single episode watch-date prompt labels the directional reference choices", () => {
  const html = renderWatchDatePrompt({
    scope: "episode",
    label: "Mark S01E01 watched",
    showTitle: "The Office",
    countLabel: "1 episode",
    episodes: [{ seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2005-03-24" }],
    referenceWatchedAt: "2026-08-12T12:00:00.000Z",
    referenceEpisodeLabel: "S01E02",
    referenceDirection: "before_next",
  });

  assert.match(html, />Before next episode</);
  assert.doesNotMatch(html, />Same as other episodes</);
});

test("season/show watch batches space shared dates by each episode runtime", () => {
  const entries = watchedAtForEpisodeBatch("custom", [
    { seasonNumber: 1, episodeNumber: 3, runtime: 41 },
    { seasonNumber: 1, episodeNumber: 1, runtime: 23 },
    { seasonNumber: 1, episodeNumber: 2, runtime: 30 },
  ], "2026-08-12T12:00:00.000Z");

  assert.deepEqual(entries.map(({ episode, watchedAt }) => [episode.episodeNumber, watchedAt]), [
    [1, "2026-08-12T12:00:00.000Z"],
    [2, "2026-08-12T12:24:00.000Z"],
    [3, "2026-08-12T12:55:00.000Z"],
  ]);
});

test("season/show watch batches continue after an existing watched episode", () => {
  const entries = watchedAtForEpisodeBatch("match_watched", [
    { seasonNumber: 1, episodeNumber: 3, runtime: 41 },
    { seasonNumber: 1, episodeNumber: 2, runtime: 30 },
  ], "", "2026-08-12T12:00:00.000Z", 23);

  assert.deepEqual(entries.map(({ watchedAt }) => watchedAt), [
    "2026-08-12T12:24:00.000Z",
    "2026-08-12T12:55:00.000Z",
  ]);
});

test("episode watch actions carry the directional reference into the prompt", () => {
  const previousEpisodes = state.showModalEpisodes;
  const previousIndex = state.showModalEpisodeIndex;
  const episodes = [
    { key: "S01E02", seasonNumber: 1, episodeNumber: 2, showTitle: "The Office", title: "Dunder Mifflin Infinity" },
    { key: "S01E01", seasonNumber: 1, episodeNumber: 1, showTitle: "The Office", title: "Pilot", runtime: 23, watched: { watched_at: "2026-08-12T12:00:00.000Z" } },
  ];
  state.showModalEpisodes = episodes;
  state.showModalEpisodeIndex = new Map(episodes.map((episode) => [episode.key, episode]));

  try {
    const action = watchActionFromButton({ dataset: { watchScope: "episode", episodeKey: "S01E02" } });
    assert.equal(action.referenceDirection, "after_last");
    assert.equal(action.referenceRuntime, 23);
    assert.equal(action.referenceEpisodeLabel, "S01E01");
  } finally {
    state.showModalEpisodes = previousEpisodes;
    state.showModalEpisodeIndex = previousIndex;
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
