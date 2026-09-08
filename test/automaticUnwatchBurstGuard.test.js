import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-unwatch-burst-guard-");

const { applyUnwatchedTransition, applyWatchedTransition } = await import("../server/src/utils/watchStateTransitions.js");
const { getPlaystateForMedia } = await import("../server/src/utils/dataRepo.js");
const repo = await import("../server/src/utils/dataRepo.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");

const config = {
  plex: { disabled: true },
  emby: { disabled: true },
  jellyfin: { disabled: true },
};

function episodeMedia(index, source) {
  return {
    title: `Burst Show ${index} - S01E01`,
    show_title: `Burst Show ${index}`,
    type: "episode",
    mediaType: "episode",
    ids: { tmdb: `burst-${index}` },
    season: 1,
    episode: 1,
    isValid: true,
    source,
  };
}

async function seedWatched(index, source) {
  const media = episodeMedia(index, source);
  await applyWatchedTransition({ ...media, watched_at: "2026-01-01T00:00:00.000Z" }, config, createLoopStore());
  return media;
}

// Reproduces the real incident (2026-08-21): one media server having a bad
// moment (a library rescan, a metadata refresh, a rate-limited response) can
// report a burst of items as suddenly unplayed across many unrelated shows.
// Each one individually looks like a normal single unwatch, so only the
// volume distinguishes it - this is the cross-show, cross-platform circuit
// breaker that catches that.
test("automatic unwatch burst guard holds back automatic unwatches once the threshold is exceeded", async () => {
  const loopStore = createLoopStore();
  const seeded = [];
  for (let i = 0; i < 20; i++) {
    seeded.push(await seedWatched(i, "jellyfin"));
  }

  const results = [];
  for (let i = 0; i < 20; i++) {
    results.push(await applyUnwatchedTransition(seeded[i], config, loopStore));
  }

  const heldBack = results.filter((r) => r.heldBackSuspiciousBurst === true);
  const applied = results.filter((r) => r.heldBackSuspiciousBurst !== true);
  assert.ok(heldBack.length > 0, "expected at least one automatic unwatch to be held back once the burst threshold was crossed");
  assert.ok(applied.length > 0, "expected the first several automatic unwatches, before the threshold trips, to go through normally");

  // A held-back item must genuinely be left alone - still watched, nothing changed.
  const heldBackIndex = results.findIndex((r) => r.heldBackSuspiciousBurst === true);
  const state = await getPlaystateForMedia(seeded[heldBackIndex]);
  assert.equal(state?.state, "watched");
});

test("automatic unwatch burst guard never holds back an explicit manual unwatch from a provider-sourced record", async () => {
  const loopStore = createLoopStore();
  const seeded = [];
  for (let i = 100; i < 125; i++) {
    // Manual UI actions commonly target history rows that were originally
    // imported from Plex/Emby/Jellyfin. This is the regression case: the
    // action itself must be exempt even when the stored row's source is not
    // "manual".
    seeded.push(await seedWatched(i, "plex"));
  }

  for (const media of seeded) {
    const result = await applyUnwatchedTransition(media, config, loopStore, {
      includeSourcePlatform: true,
      force: true,
    });
    assert.notEqual(result.heldBackSuspiciousBurst, true, `manual unwatch for ${media.title} must never be held back`);
  }

  for (const media of seeded) {
    const state = await getPlaystateForMedia(media);
    assert.equal(state?.state, "unwatched");
  }
});

test("automatic unwatch echo does not create another alias when canonical state is already unwatched", async () => {
  // The earlier burst-guard cases deliberately fill this shared safety
  // ledger. Start this focused identity test with a clean ledger so its first
  // unwatch exercises the normal transition rather than the circuit breaker.
  repo.requireDb().prepare("DELETE FROM loop_keys WHERE key LIKE 'auto-unwatch-burst:%'").run();
  const loopStore = createLoopStore();
  const media = episodeMedia(200, "jellyfin");
  const watchedAt = "2026-01-01T00:00:00.000Z";
  repo.insertWatchRecordSync({
    title: media.title,
    show_title: media.show_title,
    media_type: "episode",
    tmdb_id: media.ids.tmdb,
    season: media.season,
    episode: media.episode,
    watched_at: watchedAt,
    source: media.source,
    sync_action: "watched",
  });
  repo.upsertPlaystateForMediaSync(media, "watched", watchedAt);
  const providerAliasKey = repo.mediaKeyFor({ ...media, ids: { tvdb: "burst-alias-200" } });
  repo.upsertPlaystateForMediaSync({
    ...media,
    source: "emby",
    ids: { tvdb: "burst-alias-200" },
  }, "watched", watchedAt);
  const first = await applyUnwatchedTransition(media, config, loopStore);
  assert.equal(first.alreadyUnwatched, false);
  assert.equal((await getPlaystateForMedia(media))?.state, "unwatched");
  assert.equal(repo.requireDb().prepare("SELECT state FROM playstate WHERE media_key=?").get(providerAliasKey)?.state, "unwatched", "all provider aliases must follow the canonical unwatch");

  // A stale watched row under a rematched provider id is the shape that made
  // the old guard re-enter the unwatch path on every provider echo: the
  // playstate said unwatched, but findWatchedByAnyMediaKey still found this
  // older sibling and forced another tombstone/alias into watch_history.
  repo.insertWatchRecordSync({
    title: media.title,
    show_title: media.show_title,
    media_type: "episode",
    tmdb_id: "burst-stale-200",
    season: 1,
    episode: 1,
    watched_at: "2026-01-01T00:00:00.000Z",
    source: "plex",
    sync_action: "watched",
  });
  const countBeforeEcho = repo.requireDb()
    .prepare("SELECT COUNT(*) AS c FROM watch_history WHERE show_title = ? AND season = 1 AND episode = 1")
    .get(media.show_title).c;

  const providerAlias = {
    ...media,
    source: "emby",
    ids: { tvdb: "burst-alias-200" },
  };
  const echo = await applyUnwatchedTransition(providerAlias, config, loopStore);

  assert.equal(echo.alreadyUnwatched, true);
  assert.equal(echo.heldBackSuspiciousBurst, undefined);
  const countAfterEcho = repo.requireDb()
    .prepare("SELECT COUNT(*) AS c FROM watch_history WHERE show_title = ? AND season = 1 AND episode = 1")
    .get(media.show_title).c;
  assert.equal(countAfterEcho, 1, "an unwatch keeps only its single canonical tombstone after old watched rows are cleared");
  assert.ok(countAfterEcho < countBeforeEcho, "the stale watched alias must be removed rather than retained as repeat history");
  assert.equal((await getPlaystateForMedia(providerAlias))?.state, "unwatched");
});

test("unwatch removes every watched history alias before a later rewatch", async () => {
  repo.requireDb().prepare("DELETE FROM loop_keys WHERE key LIKE 'auto-unwatch-burst:%'").run();
  const loopStore = createLoopStore();
  const media = episodeMedia(201, "jellyfin");
  const watchedAt = "2026-01-01T00:00:00.000Z";
  await applyWatchedTransition({ ...media, watched_at: watchedAt }, config, loopStore);
  repo.insertWatchRecordSync({
    title: media.title,
    show_title: media.show_title,
    media_type: "episode",
    tvdb_id: "burst-alias-201",
    season: 1,
    episode: 1,
    watched_at: "2026-01-02T00:00:00.000Z",
    source: "plex",
    sync_action: "watched",
  });

  const firstUnwatch = await applyUnwatchedTransition(media, config, loopStore);
  assert.equal(firstUnwatch.alreadyUnwatched, false);
  const afterUnwatch = repo.requireDb()
    .prepare("SELECT sync_action, media_key FROM watch_history WHERE show_title = ? AND season = 1 AND episode = 1")
    .all(media.show_title);
  assert.deepEqual(afterUnwatch.map((row) => row.sync_action), ["unwatched"]);

  await applyWatchedTransition({ ...media, watched_at: "2026-01-03T00:00:00.000Z" }, config, loopStore);
  const afterRewatch = repo.requireDb()
    .prepare("SELECT sync_action, watched_at FROM watch_history WHERE show_title = ? AND season = 1 AND episode = 1 ORDER BY created_at")
    .all(media.show_title);
  assert.deepEqual(afterRewatch.map((row) => row.sync_action), ["watched"]);
  assert.deepEqual(afterRewatch.map((row) => row.watched_at), ["2026-01-03T00:00:00.000Z"]);
});
