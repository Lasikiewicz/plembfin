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
