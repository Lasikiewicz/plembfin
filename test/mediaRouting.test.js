import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { tvShowBaseHrefFromEpisode, tvShowHrefFromEpisode } = await import("../public/modules/utils.js");
const { mediaCardHref } = await import("../public/modules/media-card.js");
const { renderDashboardHistoryPageCard } = await import("../public/modules/dashboard.js");
const { tmdbLookupIdsFromShow } = await import("../public/modules/explorer.js");

const episodeWithLeafIds = {
  id: "up-next-episode",
  media_type: "episode",
  title: "The War Between the Land and the Sea - S01E05",
  show_title: "The War Between the Land and the Sea",
  tmdb_id: "6278773",
  tvdb_id: "10652667",
  imdb_id: "tt38807772",
  season: 1,
  episode: 5,
  queue_kind: "next_up",
  source: "emby",
};

test("episode links never promote leaf provider ids into a TV show route", () => {
  const expected = "/tvshow/the-war-between-the-land-and-the-sea/season/1/episode/5";
  assert.equal(tvShowHrefFromEpisode(episodeWithLeafIds), expected);
  assert.equal(mediaCardHref(episodeWithLeafIds), expected);

  const html = renderDashboardHistoryPageCard(episodeWithLeafIds, { upNext: true });
  assert.match(html, /data-media-card-href="\/tvshow\/the-war-between-the-land-and-the-sea#season1"/);
  assert.doesNotMatch(html, /\/season\/1\/episode\/5/);
  assert.doesNotMatch(html, /tvshow\/(?:tmdb\/6278773|tvdb\/10652667)/);
  assert.doesNotMatch(html, /data-prefetch-tmdb="6278773"/);
});

test("episode links prefer explicit series identities", () => {
  assert.equal(
    tvShowHrefFromEpisode({ ...episodeWithLeafIds, show_tmdb_id: "259886" }),
    "/tvshow/tmdb/259886-the-war-between-the-land-and-the-sea/season/1/episode/5",
  );
  assert.equal(
    tvShowBaseHrefFromEpisode({ ...episodeWithLeafIds, show_tvdb_id: "444613" }),
    "/tvshow/tvdb/444613-the-war-between-the-land-and-the-sea",
  );
});

test("episode links recover the show title when payloads omit show_title", () => {
  assert.equal(
    mediaCardHref({ ...episodeWithLeafIds, show_title: undefined }),
    "/tvshow/the-war-between-the-land-and-the-sea/season/1/episode/5",
  );
});

test("TV metadata lookup can resolve a title from a representative episode TVDB id", () => {
  const ids = tmdbLookupIdsFromShow({
    title: "Scrubs",
    imdb_id: "tt0696547",
    representative_episode: {
      media_type: "episode",
      season: 1,
      episode: 3,
      tvdb_id: "184604",
    },
  });

  assert.equal(ids.imdbId, "tt0696547");
  assert.equal(ids.tvdbId, "184604");
  assert.equal(
    tmdbLookupIdsFromShow({
      title: "Scrubs",
      tvdb_id: "76156",
      representative_episode: { tvdb_id: "184604" },
    }).tvdbId,
    "76156",
  );
});

test("resume cards align a red Clear action with the watch percentage", () => {
  const html = renderDashboardHistoryPageCard({
    ...episodeWithLeafIds,
    queue_kind: "resume",
    position_ms: 120_000,
    duration_ms: 600_000,
  }, { upNext: true });

  assert.match(html, /<div class="up-next-progress-row">[\s\S]*<span class="part-watched-progress-text">20% watched<\/span>[\s\S]*data-up-next-clear="[^"]+">Clear<\/button>/);
  assert.doesNotMatch(html, /data-up-next-clear="[^"]+">&times;<\/button>/);
});
