import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMediaForceSyncRequest,
  remoteItemIsWatched,
  remoteItemToMedia,
} from "../server/src/utils/mediaForceSync.js";
import { normalizeLibraryForceSyncRequest } from "../server/src/utils/libraryForceSync.js";
import { createMediaForceSyncActivity, finishMediaForceSyncActivity, getMediaForceSyncActivity, isMediaForceSyncCancellationRequested, requestMediaForceSyncCancellation } from "../server/src/utils/mediaForceSyncActivity.js";
import { embyEpisodeMatchesCoordinates } from "../server/src/utils/embyClient.js";
import { jellyfinEpisodeMatchesCoordinates } from "../server/src/utils/jellyfinClient.js";

test("normalizes a show detail Force Sync request and provider ids", () => {
  assert.deepEqual(
    normalizeMediaForceSyncRequest({
      media_type: "tv",
      name: "The Acolyte",
      tmdbId: 4194,
      tvdb_id: "41077",
      mode: "push",
    }),
    {
      title: "The Acolyte",
      type: "show",
      ids: { imdb: "", tmdb: "4194", tvdb: "41077" },
      season: null,
      episode: null,
      seasons: [],
      mode: "push",
      source: "",
      target: "",
    },
  );
});

test("rejects a Force Sync request with no mode or an unrecognized mode", () => {
  assert.throws(
    () => normalizeMediaForceSyncRequest({ title: "The Acolyte", type: "show" }),
    /mode must be push or pull/,
  );
  assert.throws(
    () => normalizeMediaForceSyncRequest({ title: "The Acolyte", type: "show", mode: "full" }),
    /mode must be push or pull/,
  );
});

test("Jellyfin episode matching keeps duplicate quality copies", () => {
  const candidates = [
    { Id: "1080p-copy", ParentIndexNumber: 1, IndexNumber: 2 },
    { Id: "4k-copy", ParentIndexNumber: 1, IndexNumber: 2 },
    { Id: "other-episode", ParentIndexNumber: 1, IndexNumber: 3 },
  ];
  assert.deepEqual(
    candidates.filter((item) => jellyfinEpisodeMatchesCoordinates(item, 1, 2)).map((item) => item.Id),
    ["1080p-copy", "4k-copy"],
  );
});

test("Emby episode matching keeps duplicate quality copies", () => {
  const candidates = [
    { Id: "1080p-copy", ParentIndexNumber: 1, IndexNumber: 2 },
    { Id: "4k-copy", ParentIndexNumber: 1, IndexNumber: 2 },
    { Id: "other-episode", ParentIndexNumber: 1, IndexNumber: 3 },
  ];
  assert.deepEqual(
    candidates.filter((item) => embyEpisodeMatchesCoordinates(item, 1, 2)).map((item) => item.Id),
    ["1080p-copy", "4k-copy"],
  );
});

test("normalizes target-specific push and pull operations", () => {
  assert.deepEqual(
    normalizeMediaForceSyncRequest({ title: "The Acolyte", type: "show", mode: "push_to", push_to: "jellyfin" }),
    {
      title: "The Acolyte",
      type: "show",
      ids: { imdb: "", tmdb: "", tvdb: "" },
      season: null,
      episode: null,
      seasons: [],
      mode: "push",
      source: "",
      target: "jellyfin",
    },
  );
  assert.equal(normalizeMediaForceSyncRequest({ title: "The Acolyte", type: "show", mode: "pull_from", pull_from: "plex" }).mode, "pull");
});

test("normalizes a season subset for a show detail Force Sync request", () => {
  assert.deepEqual(
    normalizeMediaForceSyncRequest({ title: "The Acolyte", type: "show", mode: "push", seasons: [2, 1, 1, "3"] }).seasons,
    [1, 2, 3],
  );
  assert.deepEqual(
    normalizeMediaForceSyncRequest({ title: "The Acolyte", type: "show", mode: "push", seasons: "2,1" }).seasons,
    [1, 2],
  );
  assert.deepEqual(normalizeMediaForceSyncRequest({ title: "The Acolyte", type: "show", mode: "push" }).seasons, []);
});

test("normalizes the Settings library Force Sync options", () => {
  assert.equal(
    normalizeLibraryForceSyncRequest({ mode: "pull_from", pull_from: "jellyfin" }).source,
    "jellyfin",
  );
  assert.equal(
    normalizeLibraryForceSyncRequest({ mode: "push_to", push_to: "emby" }).target,
    "emby",
  );
  assert.throws(() => normalizeLibraryForceSyncRequest({ mode: "full_sync" }), /mode must be push or pull/);
});

test("Force Sync activity records a user cancellation", () => {
  const operationId = createMediaForceSyncActivity({ mode: "full", type: "library" });
  assert.equal(requestMediaForceSyncCancellation(operationId).status, "cancellation_requested");
  assert.equal(isMediaForceSyncCancellationRequested(operationId), true);
  finishMediaForceSyncActivity(operationId, { cancelled: true, results: [] });
  assert.equal(getMediaForceSyncActivity(operationId).status, "cancelled");
});

test("maps a watched Plex episode into a canonical Plembfin record", () => {
  const item = {
    type: "episode",
    title: "Lost / Found",
    grandparentTitle: "The Acolyte",
    parentIndex: 1,
    index: 2,
    ratingKey: "41077-ep-2",
    lastViewedAt: 1783379340,
    Guid: [
      { id: "tmdb://4194" },
      { id: "tvdb://41077" },
    ],
  };
  const requested = {
    title: "The Acolyte",
    type: "show",
    ids: { imdb: "", tmdb: "4194", tvdb: "41077" },
  };

  assert.equal(remoteItemIsWatched(item, "plex"), true);
  const media = remoteItemToMedia(item, "plex", requested);
  assert.equal(media.title, "The Acolyte - S01E02");
  assert.equal(media.show_title, "The Acolyte");
  assert.equal(media.season, 1);
  assert.equal(media.episode, 2);
  assert.equal(media.watched_at, "2026-07-06T23:09:00.000Z");
  assert.equal(media.ids.tmdb, "4194");
  assert.equal(media.ids.tvdb, "41077");
  assert.equal(media.watchProvenance.ingest_path, "force_sync");
});

test("maps an Emby played item and ignores an unplayed remote item", () => {
  const item = {
    Type: "Episode",
    Name: "Revenge / Justice",
    SeriesName: "The Acolyte",
    ParentIndexNumber: 1,
    IndexNumber: 1,
    Id: "emby-episode-1",
    ProviderIds: { Tvdb: "41076" },
    UserData: { Played: true, LastPlayedDate: "2026-07-07T18:30:00Z" },
  };
  const requested = { title: "The Acolyte", type: "show", ids: {} };

  assert.equal(remoteItemIsWatched(item, "emby"), true);
  const media = remoteItemToMedia(item, "emby", requested);
  assert.equal(media.title, "The Acolyte - S01E01");
  assert.equal(media.watched_at, "2026-07-07T18:30:00.000Z");
  assert.equal(media.itemId, "emby-episode-1");
  assert.equal(remoteItemIsWatched({ Type: "Episode", UserData: { Played: false } }, "emby"), false);
});
