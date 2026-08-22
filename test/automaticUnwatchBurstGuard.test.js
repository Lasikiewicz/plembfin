import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-unwatch-burst-guard-");

const { applyUnwatchedTransition, applyWatchedTransition } = await import("../server/src/utils/watchStateTransitions.js");
const { getPlaystateForMedia } = await import("../server/src/utils/dataRepo.js");
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

test("automatic unwatch burst guard never holds back an explicit manual unwatch", async () => {
  const loopStore = createLoopStore();
  const seeded = [];
  for (let i = 100; i < 125; i++) {
    seeded.push(await seedWatched(i, "manual"));
  }

  for (const media of seeded) {
    const result = await applyUnwatchedTransition(media, config, loopStore);
    assert.notEqual(result.heldBackSuspiciousBurst, true, `manual unwatch for ${media.title} must never be held back`);
  }

  for (const media of seeded) {
    const state = await getPlaystateForMedia(media);
    assert.equal(state?.state, "unwatched");
  }
});
