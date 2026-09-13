import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-trakt-dismissal-persistence-");

const { appendSyncHistory, getSyncActivityGroupEvents, getSyncHistoryById } = await import("../server/src/utils/configStore.js");
const { insertWatchRecord, getWatchRecordById } = await import("../server/src/utils/dataRepo.js");
const { activityGroupKeyFor } = await import("../server/src/utils/syncActivityIdentity.js");
const trackerConnectionRepo = await import("../server/src/utils/trackerConnectionRepo.js");
const { dismissSyncActivityEntry } = await import("../server/src/routes/sync.js");
const { dispatchTrackerWatchState, dispatchTraktWatchStateBatch } = await import("../server/src/utils/trackerDispatcher.js");

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

function episodeMedia(episode, showTitle = "Risky Rewards") {
  const code = `S01E${String(episode).padStart(2, "0")}`;
  return {
    type: "episode",
    title: `${showTitle} - ${code}`,
    showTitle,
    source: "plex",
    ids: { tmdb: "risky-rewards" },
    season: 1,
    episode,
  };
}

async function appendTraktNotFound(media, rawPayloadDebug = {}) {
  await appendSyncHistory({
    mediaType: "episode",
    title: media.title,
    source: "plex",
    status: "error",
    details: "Trakt could not match this item (not_found)",
    action: "watched",
    targetStates: [{ target: "trakt", status: "error", detail: "Trakt could not match this item (not_found)" }],
    rawPayloadDebug: {
      ids: media.ids,
      showTitle: media.showTitle,
      season: media.season,
      episode: media.episode,
      ...rawPayloadDebug,
    },
  });
  const detail = await getSyncActivityGroupEvents({
    groupKey: activityGroupKeyFor(media),
    latestOnly: true,
    limit: 10,
  });
  return detail.events.find((entry) => entry.title === media.title);
}

test("a dismissed Trakt show not_found is retried but stays skipped", async () => {
  connectTrakt();
  const media = episodeMedia(1);
  const telemetry = [
    "Origin: plex",
    "Loop-check: Passed",
    "Dispatch status: partial",
    "Details: Synced to Plex; failed Trakt",
    "Plex status: success - Marked watched",
    "Trakt status: error - Trakt could not match this item (not_found)",
  ].join("\n");
  await insertWatchRecord({
    title: media.title,
    type: media.type,
    source: media.source,
    ids: media.ids,
    season: media.season,
    episode: media.episode,
    watched_at: "2026-09-13T12:00:00.000Z",
    sync_dispatch_telemetry: telemetry,
  }, { id: "risky-rewards-watch-record", prefetch: false });
  const entry = await appendTraktNotFound(media);
  assert.ok(entry?.id);

  const dismissed = await dismissSyncActivityEntry(entry.id, { scope: "show" });
  assert.equal(dismissed.dismissedTarget, "trakt");
  const stored = await getSyncHistoryById(entry.id);
  assert.equal(stored.rawPayloadDebug.dismissalHistory.at(-1).scope, "show");
  const updatedRecord = await getWatchRecordById("risky-rewards-watch-record");
  assert.match(updatedRecord.sync_dispatch_telemetry, /Dispatch status: success/);
  assert.match(updatedRecord.sync_dispatch_telemetry, /Trakt status: skipped/);
  assert.doesNotMatch(updatedRecord.sync_dispatch_telemetry, /Trakt status: error/);

  const originalFetch = globalThis.fetch;
  let historyWrites = 0;
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.hostname, "api.trakt.tv");
    assert.equal(requestUrl.pathname, "/sync/history");
    historyWrites += 1;
    return Response.json({ added: { movies: 0, episodes: 0 }, not_found: { episodes: [{ ids: media.ids }] } });
  };

  try {
    const result = await dispatchTrackerWatchState(media, "watched");
    assert.equal(historyWrites, 1, "the retry must still reach Trakt");
    assert.equal(result[0]?.status, "skipped");
    assert.equal(result[0]?.dismissed, true);
    assert.match(result[0]?.detail || "", /retry still returned not_found/);
  } finally {
    globalThis.fetch = originalFetch;
    trackerConnectionRepo.deleteTrackerConnection("trakt");
  }
});

test("legacy Trakt dismissals without a scope still apply to the show", async () => {
  connectTrakt();
  const firstEpisode = episodeMedia(1, "Legacy Dismissed Show");
  await appendTraktNotFound(firstEpisode, {
    dismissalHistory: [{ timestamp: Date.now(), target: "trakt", reason: "not_found" }],
  });

  const originalFetch = globalThis.fetch;
  let historyWrites = 0;
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.pathname, "/sync/history");
    historyWrites += 1;
    return Response.json({ added: { movies: 0, episodes: 0 }, not_found: { episodes: [{ ids: firstEpisode.ids }] } });
  };

  try {
    const result = await dispatchTrackerWatchState(episodeMedia(2, "Legacy Dismissed Show"), "watched");
    assert.equal(historyWrites, 1, "the retry must still reach Trakt");
    assert.equal(result[0]?.status, "skipped");
    assert.equal(result[0]?.dismissed, true);
  } finally {
    globalThis.fetch = originalFetch;
    trackerConnectionRepo.deleteTrackerConnection("trakt");
  }
});

test("grouped Trakt retries also preserve a prior show dismissal", async () => {
  connectTrakt();
  const firstEpisode = episodeMedia(1, "Batched Dismissed Show");
  const secondEpisode = episodeMedia(2, "Batched Dismissed Show");
  await appendTraktNotFound(firstEpisode, {
    dismissalHistory: [{ timestamp: Date.now(), target: "trakt", reason: "not_found" }],
  });

  const originalFetch = globalThis.fetch;
  let historyWrites = 0;
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.pathname, "/sync/history");
    historyWrites += 1;
    return Response.json({
      added: { movies: 0, episodes: 0 },
      not_found: { episodes: [{ ids: firstEpisode.ids }, { ids: secondEpisode.ids }] },
    });
  };

  try {
    const result = await dispatchTraktWatchStateBatch([firstEpisode, secondEpisode], "watched", { canonicalReplay: false });
    assert.equal(historyWrites, 1, "the grouped retry must still reach Trakt");
    assert.deepEqual(result.results.map((entry) => [entry.status, entry.dismissed]), [["skipped", true], ["skipped", true]]);
  } finally {
    globalThis.fetch = originalFetch;
    trackerConnectionRepo.deleteTrackerConnection("trakt");
  }
});
