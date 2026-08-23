import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-media-force-sync-tracker-phases-");

const repo = await import("../server/src/utils/dataRepo.js");
const { getSyncHistory } = await import("../server/src/utils/configStore.js");
const trackerConnectionRepo = await import("../server/src/utils/trackerConnectionRepo.js");
const { forceSyncMediaState } = await import("../server/src/utils/mediaForceSync.js");

const database = repo.requireDb();
const insertEpisode = database.prepare(`INSERT INTO watch_history
  (id, title, title_lower, media_type, watched_at, source, tmdb_id, season, episode,
   sync_action, media_key, show_title, show_title_lower, created_at, updated_at)
  VALUES (@id, @title, @title_lower, 'episode', @watched_at, 'manual', @tmdb_id, 1, @episode,
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

async function insertShow({ prefix, title, tmdbId, count = 8, unwatchedEpisodes = [] }) {
  const showTitleLower = title.toLowerCase();
  for (let episode = 1; episode <= count; episode += 1) {
    const episodeTitle = `${title} - S01E${String(episode).padStart(2, "0")}`;
    const mediaKey = `episode:1:${episode}:tmdb:${tmdbId}`;
    insertEpisode.run({
      id: `${prefix}-watched-${episode}`,
      title: episodeTitle,
      title_lower: episodeTitle.toLowerCase(),
      watched_at: `2026-08-${String(episode).padStart(2, "0")}T20:00:00.000Z`,
      tmdb_id: tmdbId,
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
        tmdb_id: tmdbId,
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

function showFetch({ title, tmdbId, count, localWrites, onTrakt }) {
  return async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    if (requestUrl.hostname === "api.trakt.tv") return onTrakt(requestUrl, options);
    if (requestUrl.hostname !== "emby.example.test") {
      throw new Error(`Unexpected outbound request: ${options.method || "GET"} ${requestUrl}`);
    }
    if (requestUrl.pathname === "/Users/test-user/Items") {
      if (requestUrl.searchParams.get("IncludeItemTypes") === "Series") {
        return Response.json({ Items: [{ Id: `${tmdbId}-series`, Name: title, ProviderIds: { Tmdb: tmdbId } }] });
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

test("all local writes finish before gated Trakt work can occupy the detail Force Sync pool", async () => {
  const title = "Local First Show";
  const tmdbId = "local-first-show";
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
    (id, title, title_lower, media_type, watched_at, source, tmdb_id, sync_action,
     media_key, created_at, updated_at)
    VALUES ('tracker-partial-movie', 'Tracker Partial Movie', 'tracker partial movie', 'movie',
            '2026-08-20T20:00:00.000Z', 'manual', 'tracker-partial', 'watched',
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
