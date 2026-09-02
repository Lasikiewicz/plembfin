import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-show-cache-concurrency-");

const repo = await import("../server/src/utils/dataRepo.js");
const { db } = await import("../server/src/db.js");

const insertEpisode = db.prepare(`
  INSERT INTO watch_history (
    id, title, title_lower, media_type, watched_at, source, season, episode,
    sync_action, sync_dispatch_telemetry, media_key, show_title, show_title_lower,
    created_at, updated_at
  ) VALUES (?, ?, ?, 'episode', ?, 'plex', 1, 1, 'unwatched', '', ?, ?, ?, ?, ?)
`);

const now = Date.now();
for (let index = 0; index < 30; index += 1) {
  const showTitle = `Cache Burst Show ${String(index).padStart(2, "0")}`;
  const title = `${showTitle} - S01E01 - Pilot`;
  const lowerTitle = title.toLowerCase();
  const lowerShowTitle = showTitle.toLowerCase();
  const mediaKey = `episode:1:1:title:${showTitle.toLowerCase().replaceAll(" ", "-")}`;
  insertEpisode.run(
    crypto.randomUUID(),
    title,
    lowerTitle,
    new Date(now + index).toISOString(),
    mediaKey,
    showTitle,
    lowerShowTitle,
    now + index,
    now + index,
  );
}

test("concurrent TV show reads share one in-flight rebuild", async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, () => repo.getCachedShows()),
  );

  assert.equal(results[0].length, 30);
  assert.ok(results.every((shows) => shows === results[0]), "all readers must receive the shared cached array");
});

test("an empty show-set variant remains cached", async () => {
  const first = await repo.getCachedShows({ includeScheduledLibraryHistory: true });
  const second = await repo.getCachedShows({ includeScheduledLibraryHistory: true });

  assert.deepEqual(first, []);
  assert.strictEqual(second, first);
});
