import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-manual-watch-review-");

const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/dataRepo.js");
const { AUTH } = await import("../server/src/appConfig.js");
const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
const { handleManualWatchReview } = await import("../server/src/routes/manualWatchReview.js");
const { applyManualUnwatch } = await import("../server/src/routes/sync.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");
const {
  countPendingManualWatchReviews,
  enqueueManualWatchReview,
  getManualWatchReview,
  listPendingManualWatchReviews,
  listPendingManualWatchReviewsCached,
  manualWatchReviewWatchContext,
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

test("a pending review is hidden when an older watched record already exists", async () => {
  const reviewMedia = {
    title: "Existing Date Review Movie",
    type: "movie",
    source: "emby",
    itemId: "emby-existing-date-review-movie",
    ids: { tmdb: "existing-date-review-movie" },
    releaseDate: "2026-08-01",
    isValid: true,
  };
  await repo.insertWatchRecord({
    title: reviewMedia.title,
    media_type: "movie",
    tmdb_id: reviewMedia.ids.tmdb,
    watched_at: "2026-08-01T12:00:00.000Z",
    source: "plex",
    sync_action: "watched",
  });

  const queued = enqueueManualWatchReview(reviewMedia, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "emby|existing-date-review-movie|1",
  });

  assert.equal(queued.status, "already_watched");
  assert.equal(listPendingManualWatchReviews().some((review) => review.id === queued.review.id), false);
  setManualWatchReviewStatus(queued.review.id, "dismissed");
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
  const repeat = enqueueManualWatchReview(reviewMedia, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "plex|stale-review-402|2",
  });
  assert.equal(repeat.queued, false);
  assert.equal(repeat.status, "already_watched");
  setManualWatchReviewStatus(queued.review.id, "dismissed");
});

test("a review is ignored when Plembfin already marked the whole show watched", () => {
  const before = db.prepare("SELECT COUNT(*) AS count FROM manual_watch_reviews").get().count;
  const result = enqueueManualWatchReview({
    title: "Already Complete Show - S02E04",
    showTitle: "Already Complete Show",
    type: "episode",
    season: 2,
    episode: 4,
    source: "plex",
    itemId: "plex-already-complete-s02e04",
    ids: { tvdb: "already-complete-episode" },
    showWatchedEpisodes: 8,
    showTotalEpisodes: 8,
    isValid: true,
  }, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "plex|already-complete-s02e04|1",
  });

  assert.equal(result.queued, false);
  assert.equal(result.status, "already_watched");
  assert.equal(result.suppressed, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM manual_watch_reviews").get().count, before);
});

test("episode reviews expose the watched state of the surrounding episodes", async () => {
  const previous = {
    title: "Review Context Show - S01E01",
    showTitle: "Review Context Show",
    type: "episode",
    source: "manual",
    ids: { tmdb: "review-context-show" },
    season: 1,
    episode: 1,
    watched_at: "2026-09-01T19:00:00.000Z",
    isValid: true,
  };
  const following = {
    ...previous,
    title: "Review Context Show - S01E03",
    season: 1,
    episode: 3,
    watched_at: "2026-09-01T20:00:00.000Z",
  };
  await repo.upsertPlaystateForMedia(previous, "watched", previous.watched_at, { skipInvalidate: true });
  await repo.upsertPlaystateForMedia(following, "watched", following.watched_at, { skipInvalidate: true });

  const queued = enqueueManualWatchReview({
    title: "Review Context Show - S01E02",
    showTitle: "Review Context Show",
    type: "episode",
    source: "plex",
    itemId: "plex-review-context-s01e02",
    ids: { tvdb: "review-context-episode-2" },
    season: 1,
    episode: 2,
    isValid: true,
  }, {
    releaseDate: "2026-09-01T00:00:00.000Z",
    sourceFingerprint: "plex|review-context-s01e02|1",
  });

  assert.equal(queued.status, "pending");
  assert.deepEqual({
    before: queued.review.watch_context.before.watched,
    after: queued.review.watch_context.after.watched,
  }, { before: true, after: true });
  assert.deepEqual(manualWatchReviewWatchContext(queued.review).before, queued.review.watch_context.before);
  setManualWatchReviewStatus(queued.review.id, "dismissed");
});

test("pending reviews are hidden and retired after an explicit unwatch", async () => {
  const reviewMedia = {
    title: "Unwatched Review Movie",
    type: "movie",
    source: "plex",
    itemId: "plex-unwatched-review-movie",
    ids: { tmdb: "unwatched-review-movie" },
    releaseDate: "2026-08-01",
    isValid: true,
  };
  const queued = enqueueManualWatchReview(reviewMedia, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "plex|unwatched-review-movie|1",
  });
  assert.equal(queued.status, "pending");

  const unwatch = await applyManualUnwatch(
    reviewMedia,
    {
      plex: { disabled: true },
      emby: { disabled: true },
      jellyfin: { disabled: true },
    },
    createLoopStore(),
    "",
    { includeSourcePlatform: true, trackDispatch: false, force: true, lane: "interactive" },
  );
  assert.equal(unwatch.alreadyUnwatched, false);
  assert.equal(listPendingManualWatchReviews().some((review) => review.id === queued.review.id), false);

  assert.equal(getManualWatchReview(queued.review.id).status, "dismissed");
  assert.equal(getManualWatchReview(queued.review.id).decision_mode, "unwatched");
});

test("manual movie unwatch clears a provider-id alias when part numbers use words and roman numerals", async () => {
  const reviewMedia = {
    title: "Alias Guard Movie: Part One",
    type: "movie",
    source: "plex",
    isValid: true,
  };
  const importedMedia = {
    title: "Alias Guard Movie: Part I",
    media_type: "movie",
    imdb_id: "tt99123451",
    tmdb_id: "9912345",
    tvdb_id: "299123",
    watched_at: "2026-08-01T10:00:00.000Z",
    source: "trakt_import",
    sync_action: "watched",
  };
  await repo.insertWatchRecord(importedMedia);

  const queued = enqueueManualWatchReview(reviewMedia, {
    releaseDate: "2026-08-01",
    sourceFingerprint: "plex|alias-guard-movie-part-one|1",
  });
  assert.equal(queued.status, "pending");

  await applyManualUnwatch(
    reviewMedia,
    {
      plex: { disabled: true },
      emby: { disabled: true },
      jellyfin: { disabled: true },
    },
    createLoopStore(),
    "",
    { includeSourcePlatform: true, trackDispatch: false, force: true, lane: "interactive" },
  );

  const importedKey = repo.mediaKeyFor({
    type: "movie",
    title: reviewMedia.title,
    ids: {
      imdb: importedMedia.imdb_id,
      tmdb: importedMedia.tmdb_id,
      tvdb: importedMedia.tvdb_id,
    },
  });
  const watchedAlias = db.prepare(
    "SELECT id FROM watch_history WHERE media_key = ? AND sync_action = 'watched' LIMIT 1",
  ).get(importedKey);
  assert.equal(watchedAlias, undefined);

  const tombstone = db.prepare(
    "SELECT sync_action FROM watch_history WHERE media_key = ? ORDER BY id DESC LIMIT 1",
  ).get(importedKey);
  assert.equal(tombstone?.sync_action, "unwatched");

  const playstate = db.prepare(
    "SELECT state FROM playstate WHERE media_key = ? LIMIT 1",
  ).get(importedKey);
  assert.equal(playstate?.state, "unwatched");

  const review = getManualWatchReview(queued.review.id);
  assert.equal(review.status, "dismissed");
  assert.equal(review.decision_mode, "unwatched");
});

test("generic provider watched flags are suppressed while the canonical state is unwatched", async () => {
  const media = {
    title: "Suppressed Stale Flag Movie",
    type: "movie",
    source: "emby",
    itemId: "emby-suppressed-stale-flag-movie",
    ids: { tmdb: "suppressed-stale-flag-movie" },
    releaseDate: "2026-08-01",
    isValid: true,
  };
  await repo.upsertPlaystateForMedia(media, "unwatched", "2026-09-08T16:48:00.000Z", { skipInvalidate: true });

  const result = enqueueManualWatchReview(media, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "emby|suppressed-stale-flag-movie|1",
  });
  assert.equal(result.queued, false);
  assert.equal(result.status, "unwatched");
  assert.equal(result.suppressed, true);
  assert.equal(result.review, null);
});

test("review-required provider flags can be held for a decision while locally unwatched", async () => {
  const media = {
    title: "Held Provider Flag Movie",
    type: "movie",
    source: "jellyfin",
    itemId: "jellyfin-held-provider-flag-movie",
    ids: { tmdb: "held-provider-flag-movie" },
    releaseDate: "2026-08-01",
    isValid: true,
  };
  await repo.upsertPlaystateForMedia(media, "unwatched", "2026-09-08T16:48:00.000Z", { skipInvalidate: true });

  const result = enqueueManualWatchReview(media, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "jellyfin|held-provider-flag-movie|1",
    allowWhenUnwatched: true,
  });
  assert.equal(result.queued, true);
  assert.equal(result.status, "pending");
  assert.equal(listPendingManualWatchReviews().some((review) => review.id === result.review.id), true);
  setManualWatchReviewStatus(result.review.id, "dismissed");
});

test("a manual unwatch tombstone suppresses a provider alias with a title-normalization mismatch", async () => {
  const localMedia = {
    title: "Alias Guard Movie:\u00a0Part II",
    type: "movie",
    source: "plex",
    itemId: "plex-alias-guard-movie",
    ids: { tmdb: "alias-guard-local" },
    isValid: true,
  };
  await applyManualUnwatch(
    localMedia,
    {
      plex: { disabled: true },
      emby: { disabled: true },
      jellyfin: { disabled: true },
    },
    createLoopStore(),
    "",
    { includeSourcePlatform: true, trackDispatch: false, force: true, lane: "interactive" },
  );

  const providerAlias = {
    ...localMedia,
    title: "Alias Guard Movie: Part II",
    source: "emby",
    itemId: "emby-alias-guard-movie",
    ids: { tmdb: "alias-guard-provider" },
  };
  const result = enqueueManualWatchReview(providerAlias, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "emby|alias-guard-movie|1",
  });
  assert.equal(result.queued, false);
  assert.equal(result.status, "unwatched");
  assert.equal(result.suppressed, true);
});

test("explicit provider Mark played events can still open a review after an unwatch", async () => {
  const media = {
    title: "Explicit Provider Rewatch Movie",
    type: "movie",
    source: "emby",
    event: "item.markplayed",
    itemId: "emby-explicit-provider-rewatch-movie",
    ids: { tmdb: "explicit-provider-rewatch-movie" },
    releaseDate: "2026-08-01",
    watchProvenance: { source: "emby", event: "item.markplayed" },
    isValid: true,
  };
  await repo.upsertPlaystateForMedia(media, "unwatched", "2026-09-08T16:48:00.000Z", { skipInvalidate: true });

  const result = enqueueManualWatchReview(media, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "emby|explicit-provider-rewatch-movie|1",
  });
  assert.equal(result.queued, true);
  assert.equal(result.status, "pending");
  assert.equal(listPendingManualWatchReviews().some((review) => review.id === result.review.id), true);
  setManualWatchReviewStatus(result.review.id, "dismissed");
});

test("mark watched now updates an existing cross-key watch instead of keeping its old date", async () => {
  const title = "Existing Review Show - S01E01 - Pilot";
  const showTitle = "Existing Review Show";
  const oldDate = "2026-08-01T10:00:00.000Z";
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

test("dismissing a review marks it unwatched across connected media apps", async (t) => {
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
    assert.deepEqual(
      responseBody.targetStates.map((target) => target.target).sort(),
      ["emby", "jellyfin", "plex"],
    );
    assert.ok(responseBody.targetStates.every((target) => (
      target.status === "success"
      || (target.status === "skipped" && /no matching item found/i.test(target.detail || ""))
    )));
    assert.equal(getManualWatchReview(queued.review.id).status, "dismissed");

    const sourceCalls = calls.slice(beforeCalls);
    assert.ok(sourceCalls.length > 0);
    assert.ok(sourceCalls.some(({ url }) => url.startsWith("http://plex-review.test/")));
    assert.ok(sourceCalls.some(({ url }) => url.startsWith("http://emby-review.test/")));
    assert.ok(sourceCalls.some(({ url }) => url.startsWith("http://jellyfin-review.test/")));
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
  assert.match(failedResponseBody.error, /Could not complete the unwatched correction/);
  assert.match(failedResponseBody.error, /Failed on (Plex|Emby|Jellyfin)/);
  assert.ok(Array.isArray(failedResponseBody.failureTargets));
  assert.ok(failedResponseBody.failureTargets.some((target) => target.provider === "Plex"));
  assert.ok(failedResponseBody.failureTargets.every((target) => target.target && target.status && target.detail));
  assert.match(failedResponseBody.error, /remains pending/i);
  assert.equal(getManualWatchReview(failed.review.id).status, "pending");
});

test("the cached pending listing is reused until a review changes or its ceiling passes", () => {
  const queued = enqueueManualWatchReview({
    title: "Cached Listing Movie",
    type: "movie",
    source: "plex",
    itemId: "plex-cached-listing-movie",
    ids: { tmdb: "cached-listing-movie" },
    isValid: true,
  }, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "plex|cached-listing-movie|1",
  });
  assert.equal(queued.status, "pending");

  const now = Date.now();
  const first = listPendingManualWatchReviewsCached({ now });
  assert.ok(first.some((review) => review.id === queued.review.id));
  assert.equal(listPendingManualWatchReviewsCached({ now: now + 1000 }), first, "an unchanged listing is served from the cache");
  assert.notEqual(listPendingManualWatchReviewsCached({ now: now + 16_000 }), first, "the ceiling forces a rebuild");

  // Deciding a review changes the pending set; the next read must not show it.
  const beforeDecision = listPendingManualWatchReviewsCached({ now: now + 16_500 });
  setManualWatchReviewStatus(queued.review.id, "dismissed");
  const afterDecision = listPendingManualWatchReviewsCached({ now: now + 17_000 });
  assert.notEqual(afterDecision, beforeDecision);
  assert.ok(!afterDecision.some((review) => review.id === queued.review.id));
});

test("the cached summary listing skips episode watch context while the full listing keeps it", () => {
  const queued = enqueueManualWatchReview({
    title: "Cached Listing Episode - S01E01",
    showTitle: "Cached Listing Episode",
    type: "episode",
    season: 1,
    episode: 1,
    source: "plex",
    itemId: "plex-cached-listing-episode",
    ids: { tmdb: "cached-listing-episode" },
    isValid: true,
  }, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "plex|cached-listing-episode|1",
  });
  assert.equal(queued.status, "pending");

  const now = Date.now() + 30_000;
  const summary = listPendingManualWatchReviewsCached({ now, includeWatchContext: false });
  const full = listPendingManualWatchReviewsCached({ now: now + 1000, includeWatchContext: true });
  assert.equal(summary.find((review) => review.id === queued.review.id)?.watch_context, undefined);
  assert.ok(full.find((review) => review.id === queued.review.id)?.watch_context);

  setManualWatchReviewStatus(queued.review.id, "dismissed");
});
