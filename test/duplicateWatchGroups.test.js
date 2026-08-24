import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-duplicate-watch-groups-");

const repo = await import("../server/src/utils/dataRepo.js");

// handleDuplicateWatchScan/handleDuplicateWatchCleanup (server/src/routes/media.js)
// find removable duplicates by calling queryWatchHistory(mediaType, dedupe: true)
// and treating every entry in a row's playHistory after the first as removable.
// These tests pin down that queryWatchHistory contract for both media types so
// a change to dedupeHistory's sort or grouping can't silently break the
// library-wide cleanup without a test failing here.

test("queryWatchHistory groups an episode's repeat watches with the oldest first", async () => {
  const title = "Repeat Show - S01E01";
  await repo.insertWatchRecord({ title, media_type: "episode", season: 1, episode: 1, tmdb_id: "dupgroup-ep", watched_at: "2022-01-01T00:00:00.000Z", source: "trakt_import" });
  await repo.insertWatchRecord({ title, media_type: "episode", season: 1, episode: 1, tmdb_id: "dupgroup-ep", watched_at: "2020-01-01T00:00:00.000Z", source: "trakt_import" });
  await repo.insertWatchRecord({ title, media_type: "episode", season: 1, episode: 1, tmdb_id: "dupgroup-ep", watched_at: "2021-01-01T00:00:00.000Z", source: "trakt_import" });

  const rows = await repo.queryWatchHistory({ mediaType: "episode", limit: 25000, offset: 0, dedupe: true });
  const row = rows.find((r) => r.title === title);
  assert.ok(row, "expected the deduped episode row to be present");
  assert.equal(row.playHistory.length, 3);
  assert.deepEqual(row.playHistory.map((entry) => entry.watched_at), [
    "2020-01-01T00:00:00.000Z",
    "2021-01-01T00:00:00.000Z",
    "2022-01-01T00:00:00.000Z",
  ]);

  // Removable = everything after the oldest, matching findDuplicateWatchGroups.
  const removableIds = row.playHistory.slice(1).map((entry) => entry.id);
  assert.equal(removableIds.length, 2);
  assert.ok(!removableIds.includes(row.playHistory[0].id));
});

test("queryWatchHistory groups a movie's repeat watches with the oldest first", async () => {
  const title = "Repeat Movie (2020)";
  await repo.insertWatchRecord({ title, media_type: "movie", tmdb_id: "dupgroup-movie", watched_at: "2023-06-01T00:00:00.000Z", source: "trakt_import" });
  await repo.insertWatchRecord({ title, media_type: "movie", tmdb_id: "dupgroup-movie", watched_at: "2021-06-01T00:00:00.000Z", source: "trakt_import" });

  const rows = await repo.queryWatchHistory({ mediaType: "movie", limit: 25000, offset: 0, dedupe: true });
  const row = rows.find((r) => r.title === title);
  assert.ok(row, "expected the deduped movie row to be present");
  assert.equal(row.playHistory.length, 2);
  assert.equal(row.playHistory[0].watched_at, "2021-06-01T00:00:00.000Z");

  const removableIds = row.playHistory.slice(1).map((entry) => entry.id);
  assert.equal(removableIds.length, 1);
  assert.equal(removableIds[0], row.playHistory[1].id);
});

test("queryWatchHistory does not report a single watch as a duplicate group", async () => {
  const title = "Once Watched Movie (2019)";
  await repo.insertWatchRecord({ title, media_type: "movie", tmdb_id: "dupgroup-once", watched_at: "2019-01-01T00:00:00.000Z", source: "plex" });

  const rows = await repo.queryWatchHistory({ mediaType: "movie", limit: 25000, offset: 0, dedupe: true });
  const row = rows.find((r) => r.title === title);
  assert.ok(row);
  assert.equal(row.playHistory.length, 1);
});

test("deduped dashboard history retains every app that recorded one episode", () => {
  const [row] = repo.dedupeHistory([
    {
      id: "cross-app-plex",
      title: "Cross App Show - S03E04 - Episode",
      show_title: "Cross App Show",
      media_type: "episode",
      season: 3,
      episode: 4,
      tmdb_id: "cross-app-show",
      watched_at: "2026-08-23T22:50:00.000Z",
      source: "plex",
      sync_action: "watched",
    },
    {
      id: "cross-app-jellyfin",
      title: "Cross App Show - S03E04 - Episode",
      show_title: "Cross App Show",
      media_type: "episode",
      season: 3,
      episode: 4,
      tmdb_id: "cross-app-show",
      watched_at: "2026-08-23T22:50:02.000Z",
      source: "jellyfin",
      sync_action: "watched",
    },
  ]);

  assert.deepEqual(new Set(row.sources), new Set(["plex", "jellyfin"]));
});

test("handleDuplicateWatchScan detects TV episode duplicates and normalizes mediaType aliases", async () => {
  const { handleDuplicateWatchScan, handleDuplicateWatchCleanup } = await import("../server/src/routes/media.js");
  const { AUTH } = await import("../server/src/appConfig.js");

  const showTitle = "Multi Watch Show";
  const epTitle = "Multi Watch Show - S01E01 - Pilot";
  const oldest = await repo.insertWatchRecord({ title: epTitle, show_title: showTitle, media_type: "episode", season: 1, episode: 1, tmdb_id: "multi-ep-1", watched_at: "2024-01-01T20:00:00.000Z", source: "plex" });
  const middle = await repo.insertWatchRecord({ title: epTitle, show_title: showTitle, media_type: "episode", season: 1, episode: 1, tmdb_id: "multi-ep-1", watched_at: "2024-06-01T20:00:00.000Z", source: "emby" });
  const newest = await repo.insertWatchRecord({ title: epTitle, show_title: showTitle, media_type: "episode", season: 1, episode: 1, tmdb_id: "multi-ep-1", watched_at: "2024-08-01T20:00:00.000Z", source: "jellyfin" });

  const createReq = (options = {}) => {
    const headers = { "x-api-key": AUTH.apiKey, ...options.headers };
    return {
      headers,
      get: (name) => headers[name.toLowerCase()] || "",
      ...options,
    };
  };

  const createRes = (onEnd) => {
    let statusCode = 200;
    const resObj = {
      status(code) { statusCode = code; return resObj; },
      set() { return resObj; },
      setHeader() { return resObj; },
      send(body) { onEnd(typeof body === "string" ? JSON.parse(body) : body, statusCode); },
      json(body) { onEnd(body, statusCode); },
      end(body) { onEnd(typeof body === "string" ? JSON.parse(body) : body, statusCode); },
    };
    return resObj;
  };

  // Test scan with "tv" alias
  let scanResult;
  await handleDuplicateWatchScan(createReq({
    method: "GET",
    query: { mediaType: "tv" },
  }), createRes((body) => { scanResult = body; }));

  assert.ok(scanResult?.ok);
  assert.equal(scanResult.mediaType, "episode");
  assert.ok(scanResult.removable >= 2);
  assert.ok(scanResult.itemsWithDuplicates >= 1);

  // Test cleanup with "episode"
  let cleanupResult;
  await handleDuplicateWatchCleanup(createReq({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ mediaType: "episode" })),
  }), createRes((body) => { cleanupResult = body; }));

  assert.ok(cleanupResult?.ok);
  assert.ok(cleanupResult.removed >= 2);

  // Post-cleanup scan should find 0 duplicates for this show
  let postScanResult;
  await handleDuplicateWatchScan(createReq({
    method: "GET",
    query: { mediaType: "episode" },
  }), createRes((body) => { postScanResult = body; }));

  const matchingSample = postScanResult.samples.find((s) => s.showTitle === showTitle);
  assert.equal(matchingSample, undefined);
});

// Real incident: an episode with exactly one genuine watch, plus an older,
// stale sync_action='unwatched' row for the same episode (the aftermath of
// an earlier unrelated unwatch event) must never be treated as "2 duplicate
// watches to consolidate" - the unwatched row isn't a countable watch at
// all. Before this fix, findDuplicateWatchGroups used the looser
// isPlembfinTrackedEpisodeRow filter (which intentionally keeps a later-
// unwatched play visible for history-count display purposes elsewhere), so
// it could sort ahead of the real watched row and get "kept" as the
// supposed oldest duplicate - deleting the actual watch and leaving only
// the unwatched marker, wrongly unwatching an item that was never a
// duplicate in the first place.
test("handleDuplicateWatchScan never treats a stale unwatched row as a duplicate watch", async () => {
  const { handleDuplicateWatchScan, handleDuplicateWatchCleanup } = await import("../server/src/routes/media.js");
  const { AUTH } = await import("../server/src/appConfig.js");

  const showTitle = "Shadowed Watch Show";
  const epTitle = "Shadowed Watch Show - S01E01";
  const watched = await repo.insertWatchRecord({
    title: epTitle, show_title: showTitle, media_type: "episode", season: 1, episode: 1,
    tmdb_id: "shadowed-ep-1", watched_at: "2024-01-01T20:00:00.000Z", source: "manual", sync_action: "watched",
  });
  await repo.upsertPlaystateForMedia(
    { title: epTitle, type: "episode", show_title: showTitle, season: 1, episode: 1, ids: { tmdb: "shadowed-ep-1" }, isValid: true },
    "watched", watched.record.watched_at,
  );
  const unwatchedMarker = await repo.insertWatchRecord({
    title: epTitle, show_title: showTitle, media_type: "episode", season: 1, episode: 1,
    imdb_id: "tt-shadowed-1", watched_at: "2023-01-01T20:00:00.000Z", source: "jellyfin", sync_action: "unwatched",
  });

  const createReq = (options = {}) => {
    const headers = { "x-api-key": AUTH.apiKey, ...options.headers };
    return { headers, get: (name) => headers[name.toLowerCase()] || "", ...options };
  };
  const createRes = (onEnd) => {
    let statusCode = 200;
    const resObj = {
      status(code) { statusCode = code; return resObj; },
      set() { return resObj; },
      setHeader() { return resObj; },
      send(body) { onEnd(typeof body === "string" ? JSON.parse(body) : body, statusCode); },
      json(body) { onEnd(body, statusCode); },
      end(body) { onEnd(typeof body === "string" ? JSON.parse(body) : body, statusCode); },
    };
    return resObj;
  };

  let scanResult;
  await handleDuplicateWatchScan(createReq({ method: "GET", query: { mediaType: "episode" } }), createRes((body) => { scanResult = body; }));
  assert.ok(!scanResult.samples.some((s) => s.showTitle === showTitle), "the shadowed episode must not be reported as having duplicates");

  let cleanupResult;
  await handleDuplicateWatchCleanup(createReq({
    method: "POST", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ mediaType: "episode" })),
  }), createRes((body) => { cleanupResult = body; }));
  assert.ok(cleanupResult?.ok);

  // The real watch must survive cleanup untouched; only the stale unwatched
  // marker (never a candidate in the first place) may still exist alongside it.
  assert.ok(await repo.getWatchRecordByIdLight(watched.id), "the genuine watched row must not be deleted");
  assert.ok(await repo.getWatchRecordByIdLight(unwatchedMarker.id), "the pre-existing unwatched marker was never a cleanup candidate and is left alone");
  const state = await repo.getPlaystateForMedia({ title: epTitle, type: "episode", show_title: showTitle, season: 1, episode: 1, ids: { tmdb: "shadowed-ep-1" }, isValid: true });
  assert.equal(state?.state, "watched");
});
