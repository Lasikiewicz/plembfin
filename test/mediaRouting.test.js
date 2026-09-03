import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { tvShowBaseHrefFromEpisode, tvShowHrefFromEpisode } = await import("../public/modules/utils.js");
const { mediaCardHref } = await import("../public/modules/media-card.js");
const { renderDashboardHistoryPageCard } = await import("../public/modules/dashboard.js");

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
  assert.match(html, /data-media-card-href="\/tvshow\/the-war-between-the-land-and-the-sea\/season\/1\/episode\/5"/);
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
