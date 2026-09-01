import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-media-force-sync-tracker-phases-");

const repo = await import("../server/src/utils/dataRepo.js");
const { getSyncHistory } = await import("../server/src/utils/configStore.js");
const trackerConnectionRepo = await import("../server/src/utils/trackerConnectionRepo.js");
const { forceSyncMediaState } = await import("../server/src/utils/mediaForceSync.js");
const { pollConnectedTrackers } = await import("../server/src/utils/trackerSync.js");
const { trackerMediaKey } = await import("../server/src/utils/traktClient.js");
const { primeTrackerWatchStateIntents } = await import("../server/src/utils/trackerDispatcher.js");

const database = repo.requireDb();
const insertEpisode = database.prepare(`INSERT INTO watch_history
  (id, title, title_lower, media_type, watched_at, source, imdb_id, tmdb_id, tvdb_id, season, episode,
   sync_action, media_key, show_title, show_title_lower, created_at, updated_at)
  VALUES (@id, @title, @title_lower, 'episode', @watched_at, 'manual', @imdb_id, @tmdb_id, @tvdb_id, 1, @episode,
          @sync_action, @media_key, @show_title, @show_title_lower, @created_at, @updated_at)`);

function connectTrakt() {
  trackerConnectionRepo.saveTrackerConnection({
    provider: "trakt",
    status: "connected",
    remoteUserId: "user-1",
    remoteUsername: "tester",
    clientId: "client",
    clientSecret: "secret",
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: Date.now() + 3_600_000,
    initialSyncMode: "baseline",
    baselineComplete: true,
    lastValidatedAt: Date.now(),
  });
}

function embyOnlyConfig() {
  return {
    plex: { disabled: true },
    emby: {
      disabled: false,
      baseUrl: "https://emby.example.test",
      apiKey: "test-key",
      userId: "test-user",
    },
    jellyfin: { disabled: true },
  };
}

async function insertShow({ prefix, title, tmdbId, count = 8, unwatchedEpisodes = [], titleOnly = false }) {
  const showTitleLower = title.toLowerCase();
  for (let episode = 1; episode <= count; episode += 1) {
    const episodeTitle = `${title} - S01E${String(episode).padStart(2, "0")}`;
    const mediaKey = `episode:1:${episode}:tmdb:${tmdbId}`;
    insertEpisode.run({
      id: `${prefix}-watched-${episode}`,
      title: episodeTitle,
      title_lower: episodeTitle.toLowerCase(),
      watched_at: `2026-08-${String(episode).padStart(2, "0")}T20:00:00.000Z`,
      imdb_id: titleOnly ? null : `imdb-${tmdbId}`,
      tmdb_id: titleOnly ? null : tmdbId,
      tvdb_id: titleOnly ? null : `tvdb-${tmdbId}`,
      episode,
      sync_action: "watched",
      media_key: mediaKey,
      show_title: title,
      show_title_lower: showTitleLower,
      created_at: 1_000 + episode,
      updated_at: 1_000 + episode,
    });
    if (unwatchedEpisodes.includes(episode)) {
      insertEpisode.run({
        id: `${prefix}-unwatched-${episode}`,
        title: episodeTitle,
        title_lower: episodeTitle.toLowerCase(),
        watched_at: `2026-09-${String(episode).padStart(2, "0")}T20:00:00.000Z`,
        imdb_id: titleOnly ? null : `imdb-${tmdbId}`,
        tmdb_id: titleOnly ? null : tmdbId,
        tvdb_id: titleOnly ? null : `tvdb-${tmdbId}`,
        episode,
        sync_action: "unwatched",
        media_key: mediaKey,
        show_title: title,
        show_title_lower: showTitleLower,
        created_at: 10_000 + episode,
        updated_at: 10_000 + episode,
      });
    }
  }
  await repo.invalidateHistoryDerivedCaches();
}

function seedTrackerShowMetadata({ title, tmdbId, tvdbId, imdbId }) {
  const canonicalTitle = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const searchHash = crypto.createHash("sha256").update(canonicalTitle).digest("hex");
  database.prepare(`INSERT OR REPLACE INTO tvdb_metadata_cache
    (id,tvdb_id,title,details,updated_at_ms) VALUES (?,?,?,?,?)`)
    .run(`search_${searchHash}`, tvdbId, title, JSON.stringify({ tvdb_id: tvdbId }), Date.now());
  database.prepare(`INSERT OR REPLACE INTO tmdb_metadata_cache
    (id,tmdb_id,media_type,title,details,schema_version,updated_at_ms) VALUES (?,?,?,?,?,?,?)`)
    .run(`tv_tvdb_${tvdbId}`, tmdbId, "tv", title, JSON.stringify({
      id: tmdbId,
      name: title,
      status: "Ended",
      external_ids: { imdb_id: imdbId, tmdb_id: tmdbId, tvdb_id: tvdbId },
    }), 9999, Date.now());
}

function seedTrackerMovieMetadata({ title, tmdbId, imdbId }) {
  const canonicalTitle = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const titleHash = crypto.createHash("sha1").update(`${canonicalTitle}|`).digest("hex");
  const insert = database.prepare(`INSERT OR REPLACE INTO tmdb_metadata_cache
    (id,tmdb_id,media_type,title,details,schema_version,updated_at_ms) VALUES (?,?,?,?,?,?,?)`);
  insert.run(`title_movie_${titleHash}`, tmdbId, "movie", title, JSON.stringify({}), 9999, Date.now());
  insert.run(`movie_${tmdbId}`, tmdbId, "movie", title, JSON.stringify({
    id: tmdbId,
    title,
    status: "Released",
    external_ids: { imdb_id: imdbId, tmdb_id: tmdbId },
  }), 9999, Date.now());
}

function showFetch({ title, tmdbId, count, localWrites, onTrakt, onLocalWrite = null }) {
  return async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    if (requestUrl.hostname === "api.trakt.tv") return onTrakt(requestUrl, options);
    if (requestUrl.hostname !== "emby.example.test") {
      throw new Error(`Unexpected outbound request: ${options.method || "GET"} ${requestUrl}`);
    }
    if (requestUrl.pathname === "/Users/test-user/Items") {
      if (requestUrl.searchParams.get("IncludeItemTypes") === "Series") {
        return Response.json({ Items: [{
          Id: `${tmdbId}-series`,
          Name: title,
          ProviderIds: { Imdb: `imdb-${tmdbId}`, Tmdb: tmdbId, Tvdb: `tvdb-${tmdbId}` },
        }] });
      }
      if (requestUrl.searchParams.get("IncludeItemTypes") === "Episode") {
        return Response.json({
          Items: Array.from({ length: count }, (_, index) => ({
            Id: `${tmdbId}-episode-${index + 1}`,
            ParentIndexNumber: 1,
            IndexNumber: index + 1,
          })),
        });
      }
    }
    const itemMatch = requestUrl.pathname.match(new RegExp(`^/Users/test-user/PlayedItems/${tmdbId}-episode-(\\d+)$`));
    if (itemMatch && ["POST", "DELETE"].includes(options.method)) {
      localWrites.add(Number(itemMatch[1]));
      await onLocalWrite?.({ episode: Number(itemMatch[1]), method: options.method });
      return new Response(null, { status: 200 });
    }
    if (requestUrl.pathname.match(new RegExp(`^/Users/test-user/Items/${tmdbId}-episode-\\d+/UserData$`)) && options.method === "POST") {
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected Emby request: ${options.method || "GET"} ${requestUrl}`);
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function successfulTraktResponse(requestUrl) {
  return requestUrl.pathname.endsWith("/remove")
    ? Response.json({ deleted: { movies: 0, episodes: 1 }, not_found: {} })
    : Response.json({ added: { movies: 0, episodes: 1 }, not_found: {} });
}

test("Force preflight resolves title metadata once for many sparse items", async () => {
  connectTrakt();
  const episodeCount = 24;
  const movieCount = 12;
  const sparseTitle = "Legacy Sparse Show";
  const titleOnlyTitle = "Legacy Title Only Show";
  const wrongMovieTitle = "Legacy Wrong ID Movie";
  const resolvedByTitle = new Map([
    [sparseTitle, {
      id: "610001",
      external_ids: { imdb_id: "tt610001", tmdb_id: "610001", tvdb_id: "710001" },
    }],
    [titleOnlyTitle, {
      id: "610002",
      external_ids: { imdb_id: "tt610002", tmdb_id: "610002", tvdb_id: "710002" },
    }],
    [wrongMovieTitle, {
      id: "610003",
      external_ids: { imdb_id: "tt610003", tmdb_id: "610003" },
    }],
  ]);
  const metadataQueries = [];
  const detailsResolver = async ({ title }) => {
    metadataQueries.push(title);
    return resolvedByTitle.get(title) || null;
  };
  const episodesFor = (title, ids) => Array.from({ length: episodeCount }, (_, index) => ({
    state: "watched",
    media: {
      isValid: true,
      source: "manual",
      type: "episode",
      mediaType: "episode",
      title: `${title} - S01E${String(index + 1).padStart(2, "0")}`,
      showTitle: title,
      season: 1,
      episode: index + 1,
      ids: { ...ids },
    },
  }));

  try {
    const sparse = episodesFor(sparseTitle, { tmdb: "legacy-series-id" });
    const titleOnly = episodesFor(titleOnlyTitle, {});
    const wrongMovies = Array.from({ length: movieCount }, (_, index) => ({
      state: "watched",
      media: {
        isValid: true,
        source: "manual",
        type: "movie",
        mediaType: "movie",
        title: wrongMovieTitle,
        ids: { tmdb: `wrong-movie-${index + 1}` },
      },
    }));
    const primed = await primeTrackerWatchStateIntents([...sparse, ...titleOnly, ...wrongMovies], { detailsResolver });

    assert.equal(metadataQueries.filter((title) => title === sparseTitle).length, 0,
      "an episode with an existing id must not trigger a title-derived series guess");
    assert.equal(metadataQueries.filter((title) => title === titleOnlyTitle).length, 1,
      "a title-only show's primary hydration should resolve once for the whole batch");
    assert.equal(metadataQueries.filter((title) => title === wrongMovieTitle).length, 1,
      "wrong-ID movies sharing a title should resolve one retry candidate for the whole batch");
    assert.equal(primed, (episodeCount * 2) + movieCount + 1,
      "episode identities remain distinct without speculative title fallbacks while movie fallbacks stay deduplicated");

    for (const entry of sparse) {
      assert.equal(
        trackerConnectionRepo.getTrackerItemState("trakt", trackerMediaKey(entry.media))?.lastOutboundState,
        "watched",
        "the sparse raw identity remains the dispatch primary",
      );
      assert.equal(
        trackerConnectionRepo.getTrackerItemState("trakt", trackerMediaKey({
          ...entry.media,
          ids: { imdb: "tt610001", tmdb: "610001", tvdb: "710001" },
        })),
        null,
        "a sparse episode must not prime a guessed title-derived retry identity",
      );
    }
    for (const entry of titleOnly) {
      const hydrated = { ...entry.media, ids: { imdb: "tt610002", tmdb: "610002", tvdb: "710002" } };
      assert.equal(
        trackerConnectionRepo.getTrackerItemState("trakt", trackerMediaKey(hydrated))?.lastOutboundState,
        "watched",
        "title-only episodes retain their hydrated dispatch identity",
      );
    }
    for (const entry of wrongMovies) {
      assert.equal(
        trackerConnectionRepo.getTrackerItemState("trakt", trackerMediaKey(entry.media))?.lastOutboundState,
        "watched",
        "each wrong movie identity remains a dispatch primary",
      );
    }
    const movieFallback = { ...wrongMovies[0].media, ids: { imdb: "tt610003", tmdb: "610003" } };
    assert.equal(
      trackerConnectionRepo.getTrackerItemState("trakt", trackerMediaKey(movieFallback))?.lastOutboundState,
      "watched",
      "the shared title-derived movie retry identity is primed",
    );
  } finally {
    trackerConnectionRepo.deleteTrackerConnection("trakt");
  }
});

test("a wrong-ID Force episode reports the Trakt mismatch without a title fallback", async () => {
  const title = "Phase Gap Wrong ID Show";
  const serverKey = "phase-gap-wrong-id";
  const tmdbId = "765432";
  const tvdbId = "876543";
  const imdbId = "tt7654321";
  const wrongIds = {
    imdb: "imdb-111111",
    tmdb: "111111",
    tvdb: "tvdb-111111",
  };
  seedTrackerShowMetadata({ title, tmdbId, tvdbId, imdbId });
  await insertShow({ prefix: "phase-gap", title, tmdbId: wrongIds.tmdb, count: 1 });
  connectTrakt();

  const media = {
    isValid: true,
    source: "manual",
    type: "episode",
    mediaType: "episode",
    title: `${title} - S01E01`,
    showTitle: title,
    season: 1,
    episode: 1,
    ids: { imdb: imdbId, tmdb: tmdbId, tvdb: tvdbId },
  };
  const mediaKey = trackerMediaKey(media);
  trackerConnectionRepo.replaceTrackerSnapshot("trakt", [{
    mediaKey,
    media,
    watchedAt: Date.parse("2026-08-01T20:00:00.000Z"),
  }]);

  const localWrites = new Set();
  const localMediaKey = trackerMediaKey({ ...media, ids: wrongIds });
  let pollResult = null;
  let markerSeenBeforePoll = false;
  let pollStarted = false;
  let wrongPrimaryRejected = false;
  let titleFallbackAccepted = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = showFetch({
    title,
    tmdbId: serverKey,
    count: 1,
    localWrites,
    onLocalWrite: async ({ method }) => {
      if (pollStarted || method !== "POST") return;
      pollStarted = true;
      const marker = trackerConnectionRepo.getTrackerItemState("trakt", localMediaKey);
      markerSeenBeforePoll = marker?.lastOutboundState === "watched" && Number(marker.lastOutboundAt) > 0;
      // The LAN server has accepted the watched write, but Force Sync has not
      // yet entered its deferred Trakt phase. Reproduce a stale, empty Trakt
      // snapshot at precisely that boundary.
      pollResult = await pollConnectedTrackers();
    },
    onTrakt: async (requestUrl, options = {}) => {
      if ((options.method || "GET") === "GET") {
        if (
          requestUrl.pathname.startsWith("/sync/watched/")
          || requestUrl.pathname.startsWith("/sync/history/")
        ) return Response.json([]);
      }
      const payload = options.body ? JSON.parse(options.body) : {};
      if (payload.shows?.[0]?.ids?.tmdb === wrongIds.tmdb && requestUrl.pathname === "/sync/history") {
        wrongPrimaryRejected = true;
        return Response.json({ added: { movies: 0, episodes: 0 }, not_found: { shows: [payload.shows[0]] } });
      }
      if (payload.shows?.[0]?.ids?.tmdb === tmdbId && requestUrl.pathname === "/sync/history") {
        titleFallbackAccepted = true;
      }
      return successfulTraktResponse(requestUrl);
    },
  });

  try {
    const result = await forceSyncMediaState(
      { type: "show", title, mode: "push" },
      { config: embyOnlyConfig() },
    );

    assert.equal(markerSeenBeforePoll, true, "the canonical Trakt intent must exist throughout the local phase");
    assert.equal(pollResult?.unwatched, 0);
    assert.equal(pollResult?.deferredUnwatched, 1);
    assert.equal((await repo.getPlaystateForMedia(media))?.state, "watched");
    assert.equal(result.results[0]?.canonicalState, "watched");
    assert.equal(result.results[0]?.status, "partial");
    assert.equal(result.results[0]?.targetStates.find((target) => target.target === "trakt")?.status, "error");
    assert.equal(wrongPrimaryRejected, true, "the stored episode IDs should reach Trakt and be rejected");
    assert.equal(titleFallbackAccepted, false, "an existing episode identity must never be replaced by a title-derived series guess");
  } finally {
    globalThis.fetch = originalFetch;
    trackerConnectionRepo.deleteTrackerConnection("trakt");
  }
});

test("a wrong-TMDB movie primes and retries its title-derived Trakt identity", async () => {
  const title = "Wrong ID Movie";
  const wrongTmdbId = "810001";
  const correctTmdbId = "810002";
  const correctImdbId = "tt810002";
  seedTrackerMovieMetadata({ title, tmdbId: correctTmdbId, imdbId: correctImdbId });
  database.prepare(`INSERT INTO watch_history
    (id, title, title_lower, media_type, watched_at, source, tmdb_id, sync_action,
     media_key, created_at, updated_at)
    VALUES (?, ?, ?, 'movie', ?, 'manual', ?, 'watched', ?, ?, ?)`).run(
    "wrong-id-movie",
    title,
    title.toLowerCase(),
    "2026-08-21T20:00:00.000Z",
    wrongTmdbId,
    `movie:tmdb:${wrongTmdbId}`,
    21_000,
    21_000,
  );
  await repo.invalidateHistoryDerivedCaches();
  connectTrakt();

  const fallbackMedia = {
    isValid: true,
    source: "manual",
    type: "movie",
    mediaType: "movie",
    title,
    ids: { imdb: correctImdbId, tmdb: correctTmdbId },
  };
  const fallbackKey = trackerMediaKey(fallbackMedia);
  let fallbackMarkerSeenBeforeLanWrite = false;
  let wrongPrimaryRejected = false;
  let titleFallbackAccepted = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    if (requestUrl.hostname === "api.trakt.tv") {
      const payload = options.body ? JSON.parse(options.body) : {};
      const sentTmdbId = String(payload.movies?.[0]?.ids?.tmdb || "");
      if (requestUrl.pathname === "/sync/history" && sentTmdbId === wrongTmdbId) {
        wrongPrimaryRejected = true;
        return Response.json({ added: { movies: 0, episodes: 0 }, not_found: { movies: [payload.movies[0]] } });
      }
      if (requestUrl.pathname === "/sync/history" && sentTmdbId === correctTmdbId) {
        titleFallbackAccepted = true;
      }
      return successfulTraktResponse(requestUrl);
    }
    if (requestUrl.hostname === "emby.example.test" && requestUrl.pathname === "/Users/test-user/Items") {
      return Response.json({ Items: [{ Id: "wrong-id-movie-emby", Name: title, ProviderIds: { Tmdb: wrongTmdbId } }] });
    }
    if (requestUrl.pathname === "/Users/test-user/PlayedItems/wrong-id-movie-emby" && options.method === "POST") {
      const marker = trackerConnectionRepo.getTrackerItemState("trakt", fallbackKey);
      fallbackMarkerSeenBeforeLanWrite = marker?.lastOutboundState === "watched" && Number(marker.lastOutboundAt) > 0;
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${requestUrl}`);
  };

  try {
    const result = await forceSyncMediaState(
      { type: "movie", title, mode: "push" },
      { config: embyOnlyConfig() },
    );

    assert.equal(fallbackMarkerSeenBeforeLanWrite, true,
      "the title-derived movie marker must exist before the LAN write");
    assert.equal(wrongPrimaryRejected, true, "Trakt should reject the sparse wrong TMDB primary");
    assert.equal(titleFallbackAccepted, true, "Trakt should accept the title-derived movie retry");
    assert.equal(result.results[0]?.status, "success");
    assert.equal(result.results[0]?.targetStates.find((target) => target.target === "trakt")?.status, "success");
  } finally {
    globalThis.fetch = originalFetch;
    trackerConnectionRepo.deleteTrackerConnection("trakt");
  }
});

test("all local writes finish before gated Trakt work can occupy the detail Force Sync pool", async () => {
  const title = "Local First Show";
  const tmdbId = "local-first-show";
  seedTrackerShowMetadata({ title, tmdbId, tvdbId: `tvdb-${tmdbId}`, imdbId: `imdb-${tmdbId}` });
  await insertShow({ prefix: "local-first", title, tmdbId, unwatchedEpisodes: [1] });
  connectTrakt();

  const localWrites = new Set();
  const gate = deferred();
  let gateReleased = false;
  let traktCalls = 0;
  let localCountAtFirstTraktCall = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = showFetch({
    title,
    tmdbId,
    count: 8,
    localWrites,
    onTrakt: async (requestUrl) => {
      traktCalls += 1;
      if (localCountAtFirstTraktCall == null) localCountAtFirstTraktCall = localWrites.size;
      await gate.promise;
      return successfulTraktResponse(requestUrl);
    },
  });

  let operation;
  let settled = false;
  try {
    operation = forceSyncMediaState({ type: "show", title, tmdb_id: tmdbId, mode: "push" }, { config: embyOnlyConfig() });
    operation.then(() => { settled = true; }, () => { settled = true; });
    await waitFor(() => traktCalls >= 2, "Trakt phase did not start");

    assert.equal(localWrites.size, 8);
    assert.equal(localCountAtFirstTraktCall, 8, "Trakt must not start before item 7+ finish locally");
    assert.equal(settled, false, "the combined operation must remain open while Trakt is pending");

    gateReleased = true;
    gate.resolve();
    const result = await operation;
    assert.equal(result.found, 8);
    assert.equal(result.results.length, 8);
    assert.ok(result.results.every((item) => item.status === "success"));
    assert.ok(result.results.every((item) => item.targetStates.some((target) => target.target === "emby" && target.status === "success")));
    assert.ok(result.results.every((item) => item.targetStates.some((target) => target.target === "trakt" && target.status === "success")));
    assert.equal(result.results.find((item) => item.episode === 1)?.canonicalState, "unwatched");
  } finally {
    if (!gateReleased) gate.resolve();
    await operation?.catch(() => null);
    globalThis.fetch = originalFetch;
    trackerConnectionRepo.deleteTrackerConnection("trakt");
  }
});

test("a Trakt failure merges with local success as a persisted partial result", async () => {
  database.prepare(`INSERT INTO watch_history
    (id, title, title_lower, media_type, watched_at, source, imdb_id, tmdb_id, tvdb_id, sync_action,
     media_key, created_at, updated_at)
    VALUES ('tracker-partial-movie', 'Tracker Partial Movie', 'tracker partial movie', 'movie',
            '2026-08-20T20:00:00.000Z', 'manual', 'imdb-tracker-partial', 'tracker-partial', 'tvdb-tracker-partial', 'watched',
            'movie:tmdb:tracker-partial', 20_000, 20_000)`)
    .run();
  await repo.invalidateHistoryDerivedCaches();
  connectTrakt();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    if (requestUrl.hostname === "api.trakt.tv") {
      return Response.json({ error: "Trakt unavailable" }, { status: 503 });
    }
    if (requestUrl.hostname === "emby.example.test" && requestUrl.pathname === "/Users/test-user/Items") {
      return Response.json({ Items: [{ Id: "tracker-partial-emby", Name: "Tracker Partial Movie", ProviderIds: { Tmdb: "tracker-partial" } }] });
    }
    if (requestUrl.pathname === "/Users/test-user/PlayedItems/tracker-partial-emby" && options.method === "POST") {
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${requestUrl}`);
  };

  try {
    const result = await forceSyncMediaState({
      type: "movie",
      title: "Tracker Partial Movie",
      tmdb_id: "tracker-partial",
      mode: "push",
    }, { config: embyOnlyConfig() });

    assert.equal(result.results[0].status, "partial");
    assert.equal(result.results[0].targetStates.find((target) => target.target === "emby")?.status, "success");
    assert.equal(result.results[0].targetStates.find((target) => target.target === "trakt")?.status, "error");
    const row = await repo.getWatchRecordById("tracker-partial-movie");
    assert.match(row.sync_dispatch_telemetry, /Dispatch status: partial/);
    assert.match(row.sync_dispatch_telemetry, /Emby status: success/);
    assert.match(row.sync_dispatch_telemetry, /Trakt status: error/);
    const history = (await getSyncHistory(100)).find((entry) => entry.title === "Tracker Partial Movie");
    assert.equal(history?.status, "partial");
    assert.equal(history?.targetStates.find((target) => target.target === "trakt")?.status, "error");
  } finally {
    globalThis.fetch = originalFetch;
    trackerConnectionRepo.deleteTrackerConnection("trakt");
  }
});

test("cancellation lets in-flight Trakt items finish and prevents new ones from starting", async () => {
  const title = "Cancelled Tracker Show";
  const tmdbId = "cancelled-tracker-show";
  seedTrackerShowMetadata({ title, tmdbId, tvdbId: `tvdb-${tmdbId}`, imdbId: `imdb-${tmdbId}` });
  await insertShow({ prefix: "cancelled-tracker", title, tmdbId });
  connectTrakt();

  const localWrites = new Set();
  const gate = deferred();
  let gateReleased = false;
  let cancelRequested = false;
  let traktRemoveCalls = 0;
  let traktAddCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = showFetch({
    title,
    tmdbId,
    count: 8,
    localWrites,
    onTrakt: async (requestUrl) => {
      if (requestUrl.pathname.endsWith("/remove")) traktRemoveCalls += 1;
      else traktAddCalls += 1;
      await gate.promise;
      return successfulTraktResponse(requestUrl);
    },
  });

  let operation;
  try {
    operation = forceSyncMediaState(
      { type: "show", title, tmdb_id: tmdbId, mode: "push" },
      { config: embyOnlyConfig(), isCancelled: () => cancelRequested },
    );
    await waitFor(() => traktRemoveCalls === 2, "two-worker Trakt phase did not start");
    assert.equal(localWrites.size, 8);

    cancelRequested = true;
    gateReleased = true;
    gate.resolve();
    const result = await operation;

    assert.equal(result.cancelled, true);
    assert.equal(traktRemoveCalls, 2, "no new canonical Trakt item may start after cancellation");
    assert.equal(traktAddCalls, 2, "the two in-flight remove/add pairs must finish atomically");
    assert.equal(result.results.filter((item) => item.status === "success").length, 2);
    assert.equal(result.results.filter((item) => item.status === "cancelled").length, 6);
    assert.equal(result.synced, 2, "cancelled Tracker work must not be counted as fully synced");
    assert.ok(result.results.every((item) => item.targetStates.some((target) => target.target === "emby" && target.status === "success")));
    assert.ok(result.results.filter((item) => item.status === "cancelled").every(
      (item) => item.targetStates.some((target) => target.target === "trakt" && target.status === "cancelled"),
    ));
  } finally {
    if (!gateReleased) gate.resolve();
    await operation?.catch(() => null);
    globalThis.fetch = originalFetch;
    trackerConnectionRepo.deleteTrackerConnection("trakt");
  }
});
