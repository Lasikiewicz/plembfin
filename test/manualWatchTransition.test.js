import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-manual-watch-transition-");
process.env.WATCHED_PLAYED_SYNC_ENABLED = "false";

const repo = await import("../server/src/utils/dataRepo.js");
const { AUTH } = await import("../server/src/appConfig.js");
const { handleManualWatch } = await import("../server/src/routes/sync.js");

function requestResponse(body) {
  const headers = { "x-api-key": AUTH.apiKey };
  const req = {
    method: "POST",
    body,
    headers,
    cookies: {},
    get(name) { return headers[String(name).toLowerCase()] || ""; },
  };
  let statusCode = 200;
  let responseBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    set() { return this; },
    send(payload) { responseBody = JSON.parse(payload); return this; },
  };
  return { req, res, status: () => statusCode, body: () => responseBody };
}

test("manual release-day watch records a fresh transition over a newer rematched unwatch", async () => {
  const db = repo.requireDb();
  const title = "Manual Alias Show - S03E03 - A Dark Web";
  const showTitle = "Manual Alias Show";
  const watchedAt = "2026-07-17T12:00:00.000Z";
  const currentMedia = {
    title,
    showTitle,
    type: "episode",
    season: 3,
    episode: 3,
    ids: { tmdb: "manual-alias-current" },
    isValid: true,
  };
  const aliasMedia = { ...currentMedia, ids: { tvdb: "manual-alias-rematch" } };
  const currentKey = repo.mediaKeyFor(currentMedia);
  const aliasKey = repo.mediaKeyFor(aliasMedia);

  db.prepare(`INSERT INTO watch_history
    (id, title, title_lower, media_type, watched_at, source, tmdb_id, season, episode,
     sync_action, media_key, show_title, show_title_lower, created_at, updated_at)
    VALUES ('older-watch', ?, ?, 'episode', ?, 'manual', ?, 3, 3,
      'watched', ?, ?, ?, 1000, 1000)`).run(
        title,
        title.toLowerCase(),
        watchedAt,
        currentMedia.ids.tmdb,
        currentKey,
        showTitle,
        showTitle.toLowerCase(),
      );
  db.prepare(`INSERT INTO watch_history
    (id, title, title_lower, media_type, watched_at, source, tvdb_id, season, episode,
     sync_action, media_key, show_title, show_title_lower, created_at, updated_at)
    VALUES ('newer-unwatch', ?, ?, 'episode', '2026-07-18T12:00:00.000Z', 'trakt', ?, 3, 3,
      'unwatched', ?, ?, ?, 2000, 2000)`).run(
        title,
        title.toLowerCase(),
        aliasMedia.ids.tvdb,
        aliasKey,
        showTitle,
        showTitle.toLowerCase(),
      );
  db.prepare(`INSERT INTO playstate
    (media_key, title, title_lower, media_type, state, watched_at, last_source, sources, tmdb_id, season, episode, updated_at)
    VALUES (?, ?, ?, 'episode', 'watched', ?, 'manual', '["manual"]', ?, 3, 3, 1000)`).run(
      currentKey,
      title,
      title.toLowerCase(),
      watchedAt,
      currentMedia.ids.tmdb,
    );
  db.prepare(`INSERT INTO playstate
    (media_key, title, title_lower, media_type, state, watched_at, last_source, sources, tvdb_id, season, episode, updated_at)
    VALUES (?, ?, ?, 'episode', 'unwatched', '2026-07-18T12:00:00.000Z', 'trakt', '["trakt"]', ?, 3, 3, 2000)`).run(
      aliasKey,
      title,
      title.toLowerCase(),
      aliasMedia.ids.tvdb,
    );

  // Reproduce the upgrade state left by Build 19: its optimistic/manual
  // playstate write was newer than the rematched unwatch pointer, but it
  // skipped the corresponding history transition.  A fresh show-detail read
  // therefore still resolves unwatched even though playstate says watched.
  db.prepare("UPDATE playstate SET state='watched', updated_at=3000 WHERE media_key=?")
    .run(currentKey);
  assert.equal((await repo.getPlaystateForMedia(currentMedia))?.state, "watched");
  const before = await repo.queryShowDetail({ title: showTitle });
  assert.equal(before?.episodes?.[0]?.sync_action, "unwatched");

  const http = requestResponse({ records: [{
    media_type: "episode",
    title,
    watched_at: watchedAt,
    source: "manual",
    tmdb_id: currentMedia.ids.tmdb,
    season: 3,
    episode: 3,
  }] });
  await handleManualWatch(http.req, http.res);

  assert.equal(http.status(), 200);
  assert.equal(http.body().inserted, 1);
  assert.equal(http.body().skipped, 0);
  assert.equal(http.body().results[0].inserted, true);
  assert.equal((await repo.getPlaystateForMedia(currentMedia))?.state, "watched");

  await repo.invalidateHistoryDerivedCaches();
  const show = await repo.queryShowDetail({ title: showTitle });
  assert.equal(show?.episode_count, 1);
  assert.equal(show?.episodes?.[0]?.sync_action, "watched");
  assert.equal(show?.episodes?.[0]?.watched_at, watchedAt);

  const transitions = db.prepare(
    "SELECT sync_action, created_at FROM watch_history WHERE season=3 AND episode=3 ORDER BY created_at",
  ).all();
  assert.deepEqual(transitions.map((row) => row.sync_action), ["watched", "unwatched", "watched"]);

  const resyncHttp = requestResponse({ records: [{
    media_type: "episode",
    title,
    watched_at: watchedAt,
    source: "manual",
    tmdb_id: currentMedia.ids.tmdb,
    season: 3,
    episode: 3,
    resync_only: true,
  }] });
  await handleManualWatch(resyncHttp.req, resyncHttp.res);

  assert.equal(resyncHttp.status(), 200);
  assert.equal(resyncHttp.body().inserted, 0);
  assert.equal(resyncHttp.body().skipped, 1);
  const transitionsAfterResync = db.prepare(
    "SELECT sync_action FROM watch_history WHERE season=3 AND episode=3 ORDER BY created_at",
  ).all();
  assert.deepEqual(transitionsAfterResync.map((row) => row.sync_action), ["watched", "unwatched", "watched"]);
});
