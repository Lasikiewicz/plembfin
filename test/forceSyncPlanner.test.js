import test from "node:test";
import assert from "node:assert/strict";
import {
  buildForceSyncPlan,
  normalizeScope,
  planStaleness,
  summarizePlan,
} from "../server/src/utils/forceSyncPlanner.js";
import { mediaKeyFor } from "../server/src/utils/dataRepo.js";

function movie(title, source, timestamp = "2026-07-19T12:00:00.000Z") {
  return { title, type: "movie", source, imdb: null, tmdb: null, tvdb: null, timestamp: new Date(timestamp) };
}

test("force-sync planner produces typed actions and summary without writes", () => {
  const media = movie("Arrival", "plex");
  const key = mediaKeyFor({ title: media.title, type: media.type });
  const plan = buildForceSyncPlan({
    itemsByServer: { plex: [media], emby: [], jellyfin: [] },
    scannedServers: ["plex", "emby"],
    historyRows: [{ id: "history-1", media_key: key, title: "Arrival", media_type: "movie", sync_action: "watched", watched_at: "2026-07-18T12:00:00.000Z" }],
  });

  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].kind, "mark_played");
  assert.equal(plan.actions[0].target, "emby");
  assert.equal(plan.actions[0].risk, "additive");
  assert.equal(plan.actions[0].matchBasis, "title");
  assert.equal(plan.summary.additive, 1);
  assert.equal(plan.summary.destructive, 0);
  assert.equal(plan.summary.outboundWrites, 1);
});

test("scope filters media types and blocks plans over maxChanges", () => {
  const scope = normalizeScope({ mediaTypes: ["movie"], maxChanges: 1 });
  const arrival = movie("Arrival", "plex");
  const dune = movie("Dune", "plex");
  const rows = [arrival, dune].map((item, index) => ({
    id: `history-${index}`,
    media_key: mediaKeyFor({ title: item.title, type: item.type }),
    title: item.title,
    media_type: item.type,
    sync_action: "watched",
    watched_at: "2026-07-18T12:00:00.000Z",
  }));
  const plan = buildForceSyncPlan({
    scope,
    itemsByServer: { plex: [arrival, dune], emby: [], jellyfin: [] },
    scannedServers: ["plex", "emby"],
    historyRows: rows,
  });

  assert.equal(plan.summary.overLimit, true);
  assert.equal(plan.summary.maxChanges, 1);
  assert.equal(plan.actions.length, 2);
});

test("staleness detects TTL and changed watched counts", () => {
  const createdAt = 1_000_000;
  const plan = { createdAt, fingerprints: { plex: { rawCount: 4 } } };
  const changed = planStaleness(plan, { counts: { plex: 5 }, config: {}, now: createdAt + 1 });
  assert.equal(changed.stale, true);
  assert.deepEqual(changed.reasons, ["plex watched-item count changed (4 → 5)."]);
  assert.equal(planStaleness(plan, { counts: { plex: 4 }, config: {}, now: createdAt + 15 * 60 * 1000 + 1 }).stale, true);
});

test("summary classifies large destructive plans for strong confirmation", () => {
  const summary = summarizePlan({
    actions: Array.from({ length: 26 }, (_, index) => ({ mediaKey: String(index), kind: "mark_unplayed", target: "plex", risk: "destructive", matchBasis: "provider-id" })),
    historyRowCount: 26,
  });
  assert.equal(summary.requiresStrongConfirmation, true);
  assert.equal(summary.snapshotRequired, true);
});
