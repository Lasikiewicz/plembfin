import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-watch-transition-atomicity-");

const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/dataRepo.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");
const { applyWatchedTransition } = await import("../server/src/utils/watchStateTransitions.js");

const config = {
  plex: { disabled: true },
  emby: { disabled: true },
  jellyfin: { disabled: true },
};

test("a synchronous local mutation failure rolls back the entire watched transition", async () => {
  const media = {
    title: "Atomic Show - S01E01",
    showTitle: "Atomic Show",
    type: "episode",
    mediaType: "episode",
    ids: { tmdb: "atomic-transition" },
    season: 1,
    episode: 1,
    source: "trakt",
    watched_at: "2026-08-23T10:00:00.000Z",
  };
  const mediaKey = repo.mediaKeyFor(media);

  db.prepare(`
    INSERT INTO playback_progress (
      media_key, title, media_type, source, tmdb_id, season, episode,
      position_ms, duration_ms, progress, updated_at
    ) VALUES (?, ?, 'episode', 'plex', ?, 1, 1, 120000, 240000, 50, ?)
  `).run(mediaKey, media.title, media.ids.tmdb, Date.now());

  db.exec(`
    CREATE TRIGGER reject_atomic_transition_playstate
    BEFORE INSERT ON playstate
    WHEN NEW.tmdb_id = 'atomic-transition'
    BEGIN
      SELECT RAISE(ABORT, 'forced playstate failure');
    END
  `);

  try {
    await assert.rejects(
      applyWatchedTransition(media, config, createLoopStore(), { trackDispatch: false }),
      /forced playstate failure/,
    );

    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM watch_history WHERE tmdb_id = ?").get(media.ids.tmdb).c,
      0,
      "the history insert before the failure must roll back",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM playback_progress WHERE media_key = ?").get(mediaKey).c,
      1,
      "the progress delete before the failure must roll back",
    );
    assert.equal(await repo.getPlaystateForMedia(media), null);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM watch_audit_events WHERE tmdb_id = ?").get(media.ids.tmdb).c,
      0,
      "audit rows written by the failed transition must roll back with it",
    );
  } finally {
    db.exec("DROP TRIGGER IF EXISTS reject_atomic_transition_playstate");
  }
});
