import assert from "node:assert/strict";
import test from "node:test";
import { isPlaceholderEpisodeTitle, isRemoteEpisodeImportValid, remoteEpisodeImportError } from "../server/src/utils/episodeImportGuard.js";

const libraryHistory = {
  source: "jellyfin",
  watch_provenance: {
    event: "library_history",
    ingest_path: "jellyfin_scheduled_library_history",
    user: "configured-user",
    source_timestamp: "2026-08-20T10:00:00.000Z",
  },
};

test("recognizes synthetic media-server episode titles", () => {
  assert.equal(isPlaceholderEpisodeTitle("S10E0?"), true);
  assert.equal(isPlaceholderEpisodeTitle("S04E01"), true);
  assert.equal(isPlaceholderEpisodeTitle("The Engagement Party"), false);
});

test("rejects a placeholder episode from automatic library history when it has no provider identity", () => {
  const result = remoteEpisodeImportError({
    ...libraryHistory,
    type: "episode",
    title: "Platonic - S10E09",
    show_title: "Platonic",
    episode_title: "S10E0?",
    season: 10,
    episode: 9,
    ids: {},
  });

  assert.deepEqual(result, {
    code: "placeholder-episode-title",
    message: "media server returned a placeholder episode title without a provider ID",
  });
  assert.equal(isRemoteEpisodeImportValid({
    ...libraryHistory,
    type: "episode",
    title: "Platonic - S10E09",
    show_title: "Platonic",
    episode_title: "S10E0?",
    season: 10,
    episode: 9,
  }), false);
});

test("rejects an uncertain coordinate title even when only a series provider id is present", () => {
  const result = remoteEpisodeImportError({
    ...libraryHistory,
    type: "episode",
    title: "Platonic - S10E09",
    show_title: "Platonic",
    episode_title: "S10E0?",
    season: 10,
    episode: 9,
    ids: { tvdb: "391020" },
  });

  assert.deepEqual(result, {
    code: "placeholder-episode-title",
    message: "media server returned an uncertain placeholder episode title",
  });
});

test("accepts a real episode title even when an older server item has no provider id", () => {
  assert.equal(isRemoteEpisodeImportValid({
    ...libraryHistory,
    type: "episode",
    title: "Trying - S05E05",
    show_title: "Trying",
    episode_title: "The Last Resort",
    season: 5,
    episode: 5,
    ids: {},
  }), true);
});

test("fails closed when automatic metadata is incomplete", () => {
  assert.equal(remoteEpisodeImportError({
    ...libraryHistory,
    type: "episode",
    title: "undefined - S01E01",
    show_title: "undefined",
    season: 1,
    episode: 1,
    episode_title: "Pilot",
  })?.code, "missing-show-title");

});

test("rejects impossible episode coordinates but does not police manual history writes", () => {
  const invalid = remoteEpisodeImportError({
    ...libraryHistory,
    type: "episode",
    title: "Show - S02E00",
    show_title: "Show",
    episode_title: "Pilot",
    season: 2,
    episode: 0,
  });
  assert.equal(invalid?.code, "invalid-episode");

  assert.equal(remoteEpisodeImportError({
    ...libraryHistory,
    type: "episode",
    title: "Show - S01E01",
    show_title: "Show",
    season: null,
    episode: 1,
    episode_title: "Pilot",
  })?.code, "invalid-season");

  assert.equal(remoteEpisodeImportError({
    source: "manual",
    type: "episode",
    title: "Show - S10E09",
    episode_title: "S10E0?",
    season: 10,
    episode: 9,
  }), null);
});
