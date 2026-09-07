import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-manual-watch-review-");

const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/dataRepo.js");
const { AUTH } = await import("../server/src/appConfig.js");
const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
const { handleManualWatchReview } = await import("../server/src/routes/manualWatchReview.js");
const {
  countPendingManualWatchReviews,
  enqueueManualWatchReview,
  getManualWatchReview,
  listPendingManualWatchReviews,
  setManualWatchReviewStatus,
} = await import("../server/src/utils/manualWatchReview.js");

test.after(() => db.close());

const media = {
  title: "Ted - S02E01",
  showTitle: "Ted",
  type: "episode",
  season: 2,
  episode: 1,
  episodeTitle: "The New Frontier",
  source: "plex",
  itemId: "plex-episode-201",
  ids: { tvdb: "404604", tmdb: "123456" },
  releaseDate: "2024-08-22",
  runtimeMinutes: 24,
  isValid: true,
};

test("manual watch reviews are durable, deduplicated, and re-open on a changed provider snapshot", () => {
  const first = enqueueManualWatchReview(media, {
    releaseDate: "2024-08-22T00:00:00.000Z",
    sourceFingerprint: "plex|episode|plex-episode-201|1",
    reason: "manual flag",
  });
  assert.equal(first.queued, true);
  assert.equal(first.status, "pending");
  assert.equal(countPendingManualWatchReviews(), 1);
  assert.equal(listPendingManualWatchReviews()[0].media.episodeTitle, "The New Frontier");

  const duplicate = enqueueManualWatchReview(media, {
    releaseDate: "2024-08-22T00:00:00.000Z",
    sourceFingerprint: "plex|episode|plex-episode-201|1",
  });
  assert.equal(duplicate.queued, true, "a pending review can be refreshed without creating another row");
  assert.equal(duplicate.review.id, first.review.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM manual_watch_reviews").get().count, 1);

  setManualWatchReviewStatus(first.review.id, "dismissed");
  assert.equal(countPendingManualWatchReviews(), 0);
  const sameSnapshot = enqueueManualWatchReview(media, {
    sourceFingerprint: "plex|episode|plex-episode-201|1",
  });
  assert.equal(sameSnapshot.queued, false);
  assert.equal(sameSnapshot.status, "dismissed");

  const changedSnapshot = enqueueManualWatchReview(media, {
    sourceFingerprint: "plex|episode|plex-episode-201|2",
  });
  assert.equal(changedSnapshot.queued, true);
  assert.equal(changedSnapshot.status, "pending");
  assert.equal(countPendingManualWatchReviews(), 1);
  assert.equal(getManualWatchReview(first.review.id).status, "pending");
});

test("approved reviews stay closed when the same provider flag is seen again", () => {
  const review = listPendingManualWatchReviews()[0];
  setManualWatchReviewStatus(review.id, "approved", "now");
  const result = enqueueManualWatchReview(media, { sourceFingerprint: "plex|episode|plex-episode-201|2" });
  assert.equal(result.queued, false);
  assert.equal(result.status, "approved");
  assert.equal(countPendingManualWatchReviews(), 0);
});

test("pending reviews are hidden after the item becomes canonically watched", async () => {
  const reviewMedia = {
    title: "Stale Review Show - S04E02",
    showTitle: "Stale Review Show",
    type: "episode",
    season: 4,
    episode: 2,
    episodeTitle: "The Already Watched Episode",
    source: "plex",
    itemId: "plex-stale-review-402",
    ids: { tvdb: "stale-review-tvdb-402" },
    releaseDate: "2026-08-01",
    isValid: true,
  };
  const queued = enqueueManualWatchReview(reviewMedia, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "plex|stale-review-402|1",
  });
  assert.equal(queued.status, "pending");
  assert.equal(listPendingManualWatchReviews().some((review) => review.id === queued.review.id), true);

  await repo.upsertPlaystateForMedia(reviewMedia, "watched", "2026-09-07T12:00:00.000Z", { skipInvalidate: true });

  assert.equal(listPendingManualWatchReviews().some((review) => review.id === queued.review.id), false);
  assert.equal(countPendingManualWatchReviews(), 0);
  setManualWatchReviewStatus(queued.review.id, "dismissed");
});

test("mark watched now updates an existing cross-key watch instead of keeping its old date", async () => {
  const title = "Existing Review Show - S01E01 - Pilot";
  const showTitle = "Existing Review Show";
  const oldDate = "2026-08-01T10:00:00.000Z";
  const existing = await repo.insertWatchRecord({
    title,
    show_title: showTitle,
    media_type: "episode",
    season: 1,
    episode: 1,
    imdb_id: "review-existing-imdb",
    watched_at: oldDate,
    source: "trakt_import",
    sync_action: "watched",
  });
  const queued = enqueueManualWatchReview({
    title,
    showTitle,
    type: "episode",
    season: 1,
    episode: 1,
    source: "plex",
    itemId: "plex-review-existing",
    releaseDate: "2026-07-01",
    ids: {},
    isValid: true,
  }, {
    releaseDate: "2026-07-01T00:00:00.000Z",
    sourceFingerprint: "plex|review-existing|1",
  });
  assert.equal(queued.status, "pending");

  const request = {
    method: "POST",
    body: { mode: "now" },
    headers: { "x-api-key": AUTH.apiKey },
    cookies: {},
    get(name) { return this.headers[String(name).toLowerCase()] || ""; },
  };
  let statusCode = 200;
  let responseBody = null;
  const response = {
    status(code) { statusCode = code; return this; },
    set() { return this; },
    send(payload) { responseBody = JSON.parse(payload); return this; },
  };
  const before = Date.now();
  await handleManualWatchReview(
    request,
    response,
    `manual-watch-review/${encodeURIComponent(queued.review.id)}/approve`,
  );
  const after = Date.now();

  assert.equal(statusCode, 200);
  assert.equal(responseBody.ok, true);
  assert.equal(responseBody.mode, "now");
  assert.equal(responseBody.existing, true);
  assert.equal(responseBody.watchRecordId, existing.id);
  assert.notEqual(responseBody.watchedAt, oldDate);
  assert.ok(Date.parse(responseBody.watchedAt) >= before - 1_000);
  assert.ok(Date.parse(responseBody.watchedAt) <= after + 1_000);

  const stored = db.prepare("SELECT watched_at FROM watch_history WHERE id = ?").get(existing.id);
  assert.equal(stored.watched_at, responseBody.watchedAt);
  assert.equal(getManualWatchReview(queued.review.id).decision_mode, "now");
  assert.equal(countPendingManualWatchReviews(), 0);
});

test("manual watch review accepts an explicit date and time", async () => {
  const queued = enqueueManualWatchReview({
    title: "Manual Date Movie",
    type: "movie",
    source: "emby",
    itemId: "emby-manual-date-movie",
    ids: { tmdb: "manual-date-movie" },
    releaseDate: "2026-07-01",
    isValid: true,
  }, {
    releaseDate: "2026-07-01T00:00:00.000Z",
    sourceFingerprint: "emby|manual-date-movie|1",
  });
  assert.equal(queued.status, "pending");

  const request = {
    method: "POST",
    body: { mode: "custom", watched_at: "2026-08-15T18:45:00.000Z" },
    headers: { "x-api-key": AUTH.apiKey },
    cookies: {},
    get(name) { return this.headers[String(name).toLowerCase()] || ""; },
  };
  let statusCode = 200;
  let responseBody = null;
  const response = {
    status(code) { statusCode = code; return this; },
    set() { return this; },
    send(payload) { responseBody = JSON.parse(payload); return this; },
  };

  await handleManualWatchReview(
    request,
    response,
    `manual-watch-review/${encodeURIComponent(queued.review.id)}/approve`,
  );

  assert.equal(statusCode, 200);
  assert.equal(responseBody.ok, true);
  assert.equal(responseBody.mode, "custom");
  assert.equal(responseBody.watchedAt, "2026-08-15T18:45:00.000Z");
  assert.equal(getManualWatchReview(queued.review.id).decision_mode, "custom");
  assert.equal(countPendingManualWatchReviews(), 0);
});

test("dismissing a review marks it unwatched only on the reporting app", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  t.after(() => { globalThis.fetch = originalFetch; });

  await saveMediaConfig({
    plex: { baseUrl: "http://plex-review.test", token: "plex-token", disabled: false },
    emby: { baseUrl: "http://emby-review.test", apiKey: "emby-key", userId: "emby-user", disabled: false },
    jellyfin: { baseUrl: "http://jellyfin-review.test", apiKey: "jellyfin-key", userId: "jellyfin-user", disabled: false },
  });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    return { ok: true, status: 200, headers: { get: () => "" }, json: async () => ({}) };
  };

  for (const source of ["plex", "emby", "jellyfin"]) {
    const queued = enqueueManualWatchReview({
      title: `Dismiss ${source} Movie`,
      type: "movie",
      source,
      itemId: `${source}-dismiss-item`,
      ids: { tmdb: `dismiss-${source}` },
      releaseDate: "2026-07-01",
      isValid: true,
    }, {
      releaseDate: "2026-07-01T00:00:00.000Z",
      sourceFingerprint: `${source}|dismiss|1`,
    });
    assert.equal(queued.status, "pending");

    const request = {
      method: "POST",
      headers: { "x-api-key": AUTH.apiKey },
      cookies: {},
      get(name) { return this.headers[String(name).toLowerCase()] || ""; },
    };
    let statusCode = 200;
    let responseBody = null;
    const response = {
      status(code) { statusCode = code; return this; },
      set() { return this; },
      send(payload) { responseBody = JSON.parse(payload); return this; },
    };

    const beforeCalls = calls.length;
    await handleManualWatchReview(
      request,
      response,
      `manual-watch-review/${encodeURIComponent(queued.review.id)}/dismiss`,
    );

    assert.equal(statusCode, 200);
    assert.equal(responseBody.ok, true);
    assert.equal(responseBody.action, "unwatched");
    assert.equal(responseBody.source, source);
    assert.equal(responseBody.targetStates.length, 1);
    assert.deepEqual(responseBody.targetStates[0].target, source);
    assert.equal(responseBody.targetStates[0].status, "success");
    assert.equal(getManualWatchReview(queued.review.id).status, "dismissed");

    const sourceCalls = calls.slice(beforeCalls);
    assert.ok(sourceCalls.length > 0);
    assert.ok(sourceCalls.every(({ url }) => url.startsWith(`http://${source}-review.test/`)));
  }

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    return { ok: false, status: 503, headers: { get: () => "" }, json: async () => ({}) };
  };
  const failed = enqueueManualWatchReview({
    title: "Provider Failure Movie",
    type: "movie",
    source: "plex",
    itemId: "plex-failure-item",
    ids: { tmdb: "dismiss-failure" },
    releaseDate: "2026-07-01",
    isValid: true,
  }, {
    releaseDate: "2026-07-01T00:00:00.000Z",
    sourceFingerprint: "plex|failure|1",
  });
  const failedRequest = {
    method: "POST",
    headers: { "x-api-key": AUTH.apiKey },
    cookies: {},
    get(name) { return this.headers[String(name).toLowerCase()] || ""; },
  };
  let failedStatusCode = 200;
  let failedResponseBody = null;
  const failedResponse = {
    status(code) { failedStatusCode = code; return this; },
    set() { return this; },
    send(payload) { failedResponseBody = JSON.parse(payload); return this; },
  };
  await handleManualWatchReview(
    failedRequest,
    failedResponse,
    `manual-watch-review/${encodeURIComponent(failed.review.id)}/dismiss`,
  );
  assert.equal(failedStatusCode, 409);
  assert.match(failedResponseBody.error, /remains pending/i);
  assert.equal(getManualWatchReview(failed.review.id).status, "pending");
});
