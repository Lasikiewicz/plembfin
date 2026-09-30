import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

// Loose-ends step 20: a show rewatched from an older season keeps the rewatch
// card and gains the newly arrived episode as a second card.
makeTempDataDir("plembfin-up-next-rewatch-");
const { db } = await import("../server/src/db.js");
const { buildUpNextProjection, collapseUncertainEpisodeQueues } = await import("../server/src/utils/upNextService.js");
const { insertWatchRecordSync } = await import("../server/src/utils/dataRepo.js");
const { createUpNextDismissalFilter, recordUpNextDismissal, restoreAllUpNextDismissals } = await import("../server/src/utils/upNextDismissals.js");
const { refreshProviderRail } = await import("../server/src/utils/upNextProviderSync.js");
const { rewatchPosition } = await import("../server/src/utils/upNextRewatch.js");

function seedSeasons(tmdbId, title, seasons) {
  db.prepare(
    `INSERT INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, schema_version, updated_at_ms)
     VALUES (?, ?, 'tv', ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET details = excluded.details`,
  ).run(`tv_${tmdbId}`, tmdbId, title, JSON.stringify({
    id: Number(tmdbId),
    name: title,
    external_ids: { tvdb_id: tmdbId },
    seasons: Object.keys(seasons).map((season) => ({ season_number: Number(season) })),
  }), Date.now());
  for (const [season, episodes] of Object.entries(seasons)) {
    db.prepare(
      `INSERT INTO tvdb_season_cache (id, tvdb_id, season_number, details, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET details = excluded.details`,
    ).run(`${tmdbId}_${season}`, tmdbId, Number(season), JSON.stringify({
      episodes: episodes.map((aired, index) => ({ number: index + 1, name: `Episode ${index + 1}`, aired })),
    }), Date.now());
  }
}

function watch(tmdbId, title, season, episode, watchedAt) {
  insertWatchRecordSync({
    title: `${title} - S${season}E${episode}`,
    show_title: title,
    episode_title: `Episode ${episode}`,
    media_type: "episode",
    season,
    episode,
    tmdb_id: tmdbId,
    tvdb_id: tmdbId,
    watched_at: watchedAt,
    source: "manual",
  });
}

// S13E1-3 watched, then a rewatch started at S11E1. S13E4 airs 29 September.
function seedRewatchShow(tmdbId, title) {
  seedSeasons(tmdbId, title, {
    11: ["2020-01-01", "2020-01-08", "2020-01-15"],
    12: ["2021-01-01"],
    13: ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-29"],
  });
  watch(tmdbId, title, 13, 1, "2026-09-02T20:00:00.000Z");
  watch(tmdbId, title, 13, 2, "2026-09-09T20:00:00.000Z");
  watch(tmdbId, title, 13, 3, "2026-09-16T20:00:00.000Z");
  watch(tmdbId, title, 11, 1, "2026-09-20T20:00:00.000Z");
}

function project(tmdbId, title, { now, resolveProviderItems }) {
  return buildUpNextProjection({
    now: Date.parse(now),
    shows: [{ id: `show-${tmdbId}`, title, tmdb_id: tmdbId, tvdb_id: tmdbId, episode_count: 4, latest_watched_at: "2026-09-20T20:00:00.000Z" }],
    progressRows: [],
    playstateRows: [],
    providerItems: [],
    resolveProviderItems,
  });
}

const everyLibrary = async (candidate) => ({ plex: [`s${candidate.season}e${candidate.episode}`] });
const coordinates = (items) => items.map((item) => `S${item.season}E${item.episode}:${item.up_next_lane || "-"}`).sort();

test("a rewatch and a newly aired, playable episode are two cards", async () => {
  seedRewatchShow("93001", "Rewatch Both");
  const projection = await project("93001", "Rewatch Both", { now: "2026-09-30T12:00:00.000Z", resolveProviderItems: everyLibrary });
  assert.deepEqual(coordinates(projection.items), ["S11E2:rewatch", "S13E4:new"]);
  const byLane = Object.fromEntries(projection.items.map((item) => [item.up_next_lane, item]));
  assert.deepEqual(byLane.rewatch.provider_items, { plex: ["s11e2"] });
  assert.deepEqual(byLane.new.provider_items, { plex: ["s13e4"] });
});

test("a newly aired episode missing from every library leaves only the rewatch card", async () => {
  seedRewatchShow("93002", "Rewatch Missing");
  const projection = await project("93002", "Rewatch Missing", {
    now: "2026-09-30T12:00:00.000Z",
    resolveProviderItems: async (candidate) => (candidate.season === 13 ? {} : everyLibrary(candidate)),
  });
  assert.deepEqual(coordinates(projection.items), ["S11E2:rewatch"]);
});

test("before the new episode airs only the rewatch card shows", async () => {
  seedRewatchShow("93003", "Rewatch Early");
  const projection = await project("93003", "Rewatch Early", { now: "2026-09-25T12:00:00.000Z", resolveProviderItems: everyLibrary });
  assert.deepEqual(coordinates(projection.items), ["S11E2:rewatch"]);
});

test("a viewer watching in order still gets exactly one card", async () => {
  seedSeasons("93004", "In Order", { 1: ["2026-08-01", "2026-08-08", "2026-08-15"] });
  watch("93004", "In Order", 1, 1, "2026-08-02T20:00:00.000Z");
  watch("93004", "In Order", 1, 2, "2026-08-09T20:00:00.000Z");
  const projection = await project("93004", "In Order", { now: "2026-09-30T12:00:00.000Z", resolveProviderItems: everyLibrary });
  assert.deepEqual(coordinates(projection.items), ["S1E3:-"]);
});

test("an already-watched episode after the rewatch never becomes a card", async () => {
  seedRewatchShow("93005", "Rewatch Seen");
  watch("93005", "Rewatch Seen", 11, 2, "2019-01-01T20:00:00.000Z");
  const projection = await project("93005", "Rewatch Seen", { now: "2026-09-30T12:00:00.000Z", resolveProviderItems: everyLibrary });
  // No rewatch card, so the new episode is an ordinary single card.
  assert.deepEqual(coordinates(projection.items), ["S13E4:-"]);
});

test("a rewatch episode missing from every library leaves the new episode an ordinary card", async () => {
  // Found on the local server (American Horror Story, 30 September 2026): the
  // new episode was tagged "new" with no rewatch card beside it, so the app
  // rail refresh skipped it and the apps' own rails stopped following it.
  seedRewatchShow("93010", "Rewatch Unplayable");
  const projection = await project("93010", "Rewatch Unplayable", {
    now: "2026-09-30T12:00:00.000Z",
    resolveProviderItems: async (candidate) => (candidate.season === 11 ? {} : everyLibrary(candidate)),
  });
  assert.deepEqual(coordinates(projection.items), ["S13E4:-"]);
});

test("a season marked watched in one go opens no rewatch lane", () => {
  const at = "2026-09-01T00:00:00.000Z";
  assert.equal(rewatchPosition([
    { season: 1, episode: 1, watched_at: at },
    { season: 1, episode: 2, watched_at: at },
  ]), null);
  assert.deepEqual(rewatchPosition([
    { season: 2, episode: 1, watched_at: "2026-09-01T00:00:00.000Z" },
    { season: 1, episode: 1, watched_at: "2026-09-02T00:00:00.000Z" },
  ]), { latest: { season: 1, episode: 1 }, frontier: { season: 2, episode: 1 } });
});

test("the new-episode card survives the one-card-per-show collapse, even beside a part-watched rewatch", () => {
  const show = { media_type: "episode", show_title: "Lane Show", updated_at: 1_000 };
  const items = collapseUncertainEpisodeQueues([
    { ...show, id: "resume", season: 11, episode: 2, queue_kind: "resume", progress: 30 },
    { ...show, id: "later", season: 11, episode: 3, queue_kind: "next_up" },
    { ...show, id: "new", season: 13, episode: 4, queue_kind: "next_up", up_next_lane: "new" },
  ]);
  assert.deepEqual(items.map((item) => item.id).sort(), ["new", "resume"]);
});

test("hiding a season leaves the show's other card, hiding the show hides both", () => {
  const card = (season, episode) => ({
    media_type: "episode",
    title: "Dismiss Show",
    show_title: "Dismiss Show",
    show_tmdb_id: "93006",
    season,
    episode,
    provider_items: { plex: [`d${season}${episode}`] },
  });
  recordUpNextDismissal({ ...card(11, 2), dismissal_scope: "season" });
  let filter = createUpNextDismissalFilter();
  assert.equal(filter.isDismissed(card(11, 2)), true);
  assert.equal(filter.isDismissed(card(11, 3)), true);
  assert.equal(filter.isDismissed(card(13, 4)), false);

  restoreAllUpNextDismissals();
  recordUpNextDismissal(card(11, 2));
  filter = createUpNextDismissalFilter();
  assert.equal(filter.isDismissed(card(13, 4)), true);
  restoreAllUpNextDismissals();
});

test("the app rails follow the rewatch, so the new-episode card is not refreshed there", async () => {
  const result = await refreshProviderRail({
    provider: "jellyfin",
    config: { jellyfin: { baseUrl: "http://jellyfin.invalid", apiKey: "test", userId: "user" } },
    targets: [{ providerItemId: "new-1", item: { media_type: "episode", title: "Lane Show", season: 13, episode: 4, up_next_lane: "new" } }],
  });
  assert.equal(result.skipped_count, 1);
  assert.match(result.results[0].reason, /rewatch card drives/);
});
