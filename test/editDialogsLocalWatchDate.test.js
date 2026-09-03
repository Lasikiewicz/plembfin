import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

import { state } from "../public/modules/state.js";
import { applyArtworkToLocalWatchRecords, applyWatchedAtToLocalWatchRecord } from "../public/modules/edit-dialogs.js";
import { renderShowRecord } from "../public/modules/explorer.js";

test("editing a movie watch date updates the retained Movies page record", () => {
  const original = "2026-06-05T12:00:00.000Z";
  const updated = "2025-12-25T12:00:00.000Z";
  state.history = [{ id: "snowman-watch", media_type: "movie", title: "The Snowman", watched_at: original }];
  state.historyViewRaw = [];
  state.moviesRaw = [{
    id: "snowman-watch",
    media_type: "movie",
    title: "The Snowman",
    watched_at: original,
    playHistory: [{ id: "snowman-watch", watched_at: original }],
  }];

  const record = applyWatchedAtToLocalWatchRecord("snowman-watch", updated);

  assert.equal(record, state.moviesRaw[0]);
  assert.equal(state.moviesRaw[0].watched_at, updated);
  assert.equal(state.moviesRaw[0].playHistory[0].watched_at, updated);
});

test("editing one rewatch keeps the movie card on the latest remaining watch date", () => {
  state.history = [];
  state.historyViewRaw = [];
  state.moviesRaw = [{
    id: "latest-watch",
    media_type: "movie",
    watched_at: "2026-06-05T12:00:00.000Z",
    playHistory: [
      { id: "older-watch", watched_at: "2025-01-01T12:00:00.000Z" },
      { id: "latest-watch", watched_at: "2026-06-05T12:00:00.000Z" },
    ],
  }];

  applyWatchedAtToLocalWatchRecord("latest-watch", "2024-12-25T12:00:00.000Z");

  assert.equal(state.moviesRaw[0].watched_at, "2025-01-01T12:00:00.000Z");
});

test("editing a movie poster updates loaded library snapshots and related rewatches", () => {
  const posterUrl = "/media/posters/the-snowman.webp?v=2";
  state.history = [{ id: "snowman-watch", media_type: "movie", poster_url: "/media/posters/old.webp" }];
  state.historyViewRaw = [{ id: "snowman-rewatch", media_type: "movie", poster_url: "/media/posters/old.webp" }];
  state.moviesRaw = [{
    id: "snowman-watch",
    media_type: "movie",
    poster_url: "/media/posters/old.webp",
    playHistory: [{ id: "snowman-rewatch" }],
  }];

  const result = applyArtworkToLocalWatchRecords({
    id: "snowman-watch",
    mediaType: "movie",
    posterUrl,
    updatedIds: ["snowman-watch", "snowman-rewatch"],
  });

  assert.equal(result.movies, 1);
  assert.equal(state.moviesRaw[0].poster_url, posterUrl);
  assert.equal(state.history[0].poster_url, posterUrl);
  assert.equal(state.historyViewRaw[0].poster_url, posterUrl);
});

test("editing a show poster updates only the matching show and preserves episode stills", () => {
  const posterUrl = "/media/posters/the-office.webp?v=2";
  const oldPosterUrl = "/media/posters/the-office-old.webp?v=1";
  const selectedShow = {
    title: "The Office",
    tmdb_id: "123",
    poster_url: oldPosterUrl,
    show_poster_url: oldPosterUrl,
    canonical_poster_url: oldPosterUrl,
    episodes: [{ id: "office-episode", poster_url: "/media/posters/episode-still.webp" }],
  };
  state.showsRaw = [selectedShow, {
    title: "The Office",
    tmdb_id: "456",
    poster_url: "/media/posters/other-office.webp",
    show_poster_url: "/media/posters/other-office.webp",
  }];
  state.history = [{
    id: "office-episode",
    media_type: "episode",
    title: "The Office - S01E01 - Pilot",
    show_title: "The Office",
    show_tmdb_id: "123",
    poster_url: "/media/posters/episode-still.webp",
    show_poster_url: oldPosterUrl,
  }];
  state.historyViewRaw = [];

  applyArtworkToLocalWatchRecords({
    id: "office-episode",
    mediaType: "tv",
    posterUrl,
    showIdentity: { title: "The Office", tmdb_id: "123" },
    previousPosterUrl: oldPosterUrl,
  });

  assert.equal(selectedShow.show_poster_url, posterUrl);
  assert.equal(selectedShow.poster_url, posterUrl);
  assert.equal(selectedShow.episodes[0].poster_url, "/media/posters/episode-still.webp");
  assert.equal(state.history[0].show_poster_url, posterUrl);
  assert.equal(state.history[0].poster_url, "/media/posters/episode-still.webp");
  assert.equal(state.showsRaw[1].show_poster_url, "/media/posters/other-office.webp");
});

test("TV library cards render the shared show poster instead of the representative episode still", () => {
  state.explorerMode = "shows";
  state.explorerViewShows = "posters";
  const html = renderShowRecord({
    title: "The Office",
    tmdb_id: "123",
    show_poster_url: "/media/posters/the-office.webp?v=2",
    representative_episode: {
      id: "office-episode",
      title: "The Office - S01E01 - Pilot",
      poster_url: "/media/posters/episode-still.webp",
      watched_at: "2026-01-01T12:00:00.000Z",
    },
    episodes: [{
      id: "office-episode",
      title: "The Office - S01E01 - Pilot",
      poster_url: "/media/posters/episode-still.webp",
      watched_at: "2026-01-01T12:00:00.000Z",
    }],
    episode_count: 1,
  });

  assert.match(html, /src="\/media\/posters\/the-office\.webp\?v=2"/);
  assert.doesNotMatch(html, /src="\/media\/posters\/episode-still\.webp"/);
});
