import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-library-availability-");

const repo = await import("../server/src/utils/dataRepo.js");
const { mediaFromLibraryItem, reconcileAvailableWatchedItems } = await import("../server/src/utils/libraryAvailabilitySync.js");

function embyEpisode(overrides = {}) {
  return {
    Id: "emby-4k-reacher-s3e3",
    Type: "Episode",
    Name: "Number 2 with a Bullet",
    SeriesName: "Reacher",
    ParentIndexNumber: 3,
    IndexNumber: 3,
    ProviderIds: { Imdb: "tt-episode-3" },
    SeriesProviderIds: { Imdb: "tt-reacher" },
    UserData: { Played: false, PlayCount: 0 },
    ...overrides,
  };
}

function embyConfig() {
  return {
    plex: { disabled: true },
    emby: { baseUrl: "https://emby.example", apiKey: "key", userId: "user" },
    jellyfin: { disabled: true },
  };
}

function plexConfig() {
  return {
    plex: { baseUrl: "https://plex.example", token: "token" },
    emby: { disabled: true },
    jellyfin: { disabled: true },
  };
}

test("library inventory media keeps series identity and exact provider item id", () => {
  const media = mediaFromLibraryItem("emby", embyEpisode());
  assert.equal(media.title, "Reacher - S03E03");
  assert.equal(media.show_title, "Reacher");
  assert.equal(media.episodeTitle, "Number 2 with a Bullet");
  assert.equal(media.ids.imdb, "tt-reacher");
  assert.deepEqual(media.provider_items, { emby: ["emby-4k-reacher-s3e3"] });
  assert.equal(media.provider_item_id, "emby-4k-reacher-s3e3");
});

test("availability reconciliation repairs a present unplayed item from canonical watched state", async () => {
  const canonical = {
    title: "Reacher - S03E03",
    show_title: "Reacher",
    media_type: "episode",
    type: "episode",
    season: 3,
    episode: 3,
    ids: { imdb: "tt-reacher" },
  };
  const watched = await repo.insertWatchRecord({
    title: canonical.title,
    show_title: canonical.show_title,
    media_type: "episode",
    season: 3,
    episode: 3,
    imdb_id: "tt-reacher",
    watched_at: "2026-09-01T21:45:00.000Z",
    source: "plex",
  });
  await repo.upsertPlaystateForMedia(canonical, "watched", watched.record.watched_at);

  const marked = [];
  const result = await reconcileAvailableWatchedItems(embyConfig(), {
    clients: {
      emby: { fetch: async () => [embyEpisode()] },
    },
    markWatched: async (media, provider) => {
      marked.push({ media, provider });
      return { status: "success" };
    },
  });

  assert.equal(result.marked, 1);
  assert.equal(marked[0].provider, "emby");
  assert.deepEqual(marked[0].media.provider_items, { emby: ["emby-4k-reacher-s3e3"] });
});

test("Plex filtered inventory repairs missing viewCount items using explicit unplayed-feed evidence", async () => {
  const canonical = {
    title: "The Walking Dead - S05E02",
    show_title: "The Walking Dead",
    media_type: "episode",
    type: "episode",
    season: 5,
    episode: 2,
    ids: { imdb: "tt-walking-dead" },
  };
  const watched = await repo.insertWatchRecord({
    title: canonical.title,
    show_title: canonical.show_title,
    media_type: "episode",
    season: 5,
    episode: 2,
    imdb_id: "tt-walking-dead",
    watched_at: "2026-09-01T22:00:00.000Z",
    source: "plex",
  });
  await repo.upsertPlaystateForMedia(canonical, "watched", watched.record.watched_at);

  let marked;
  const result = await reconcileAvailableWatchedItems(plexConfig(), {
    clients: {
      plex: { fetch: async () => [{
        ratingKey: "plex-walking-dead-s5e2",
        type: "episode",
        title: "Strangers",
        grandparentTitle: "The Walking Dead",
        parentIndex: 5,
        index: 2,
        Guid: [{ id: "imdb://tt-walking-dead-episode-2" }],
        grandparentGuid: "imdb://tt-walking-dead",
        __plembfinUnwatchedFeed: true,
      }] },
    },
    markWatched: async (media, provider) => {
      marked = { media, provider };
      return { status: "success" };
    },
  });

  assert.equal(result.marked, 1);
  assert.equal(marked.provider, "plex");
  assert.deepEqual(marked.media.provider_items, { plex: ["plex-walking-dead-s5e2"] });
});

test("Plex incomplete inventory without filtered-feed evidence is not treated as unplayed", async () => {
  let markCount = 0;
  const result = await reconcileAvailableWatchedItems(plexConfig(), {
    clients: {
      plex: { fetch: async () => [{
        ratingKey: "plex-incomplete-item",
        type: "episode",
        title: "Unknown",
        grandparentTitle: "Unknown Show",
        parentIndex: 1,
        index: 1,
      }] },
    },
    markWatched: async () => {
      markCount += 1;
      return { status: "success" };
    },
  });

  assert.equal(markCount, 0);
  assert.equal(result.marked, 0);
  assert.equal(result.providers.plex.candidates, 0);
});

test("availability reconciliation does not overwrite a canonical unwatch", async () => {
  const canonical = {
    title: "Reacher - S03E04",
    show_title: "Reacher",
    media_type: "episode",
    type: "episode",
    season: 3,
    episode: 4,
    ids: { imdb: "tt-reacher-s3e4" },
  };
  const watched = await repo.insertWatchRecord({
    title: canonical.title,
    show_title: canonical.show_title,
    media_type: "episode",
    season: 3,
    episode: 4,
    imdb_id: "tt-reacher-s3e4",
    watched_at: "2026-09-01T21:50:00.000Z",
    source: "plex",
  });
  await repo.upsertPlaystateForMedia(canonical, "watched", watched.record.watched_at);
  await repo.upsertPlaystateForMedia(canonical, "unwatched", "2026-09-04T10:00:00.000Z");

  let markCount = 0;
  const result = await reconcileAvailableWatchedItems(embyConfig(), {
    clients: {
      emby: { fetch: async () => [embyEpisode({ Id: "emby-4k-reacher-s3e4", IndexNumber: 4, Name: "Dominique", ProviderIds: { Imdb: "tt-episode-4" }, SeriesProviderIds: { Imdb: "tt-reacher" } })] },
    },
    markWatched: async () => {
      markCount += 1;
      return { status: "success" };
    },
  });

  assert.equal(result.marked, 0);
  assert.equal(markCount, 0);
});

test("a failed provider inventory produces no writes and no inferred unwatch", async () => {
  let markCount = 0;
  const result = await reconcileAvailableWatchedItems(embyConfig(), {
    clients: {
      emby: { fetch: async () => { throw new Error("temporary library timeout"); } },
    },
    markWatched: async () => {
      markCount += 1;
      return { status: "success" };
    },
  });

  assert.equal(markCount, 0);
  assert.equal(result.marked, 0);
  assert.match(result.providers.emby.error, /temporary library timeout/);
});
