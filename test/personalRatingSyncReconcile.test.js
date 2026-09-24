import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-personal-rating-reconcile-");

const { db } = await import("../server/src/db.js");
const { normalizePersonalRatingMedia } = await import("../server/src/utils/personalRatingIdentity.js");
const {
  findCanonicalPersonalRating,
  getRatingSourceRow,
  listPersonalRatingQueue,
  markRatingSourceOutbound,
  upsertCanonicalPersonalRating,
  upsertRatingSourceObservation,
} = await import("../server/src/utils/personalRatingRepository.js");
const { queuePersonalRatingMutation, runRatingSync } = await import("../server/src/utils/personalRatingSync.js");
const { clearJellyfinPersonalRating } = await import("../server/src/utils/jellyfinClient.js");

test.after(() => db.close());

const config = {
  ratingSync: {
    enabled: true,
    conflictPolicy: "local_wins",
    providers: { plex: "bidirectional", emby: "bidirectional", jellyfin: "bidirectional", trakt: "bidirectional" },
  },
  emby: { baseUrl: "https://emby.example.test", apiKey: "emby-key", userId: "emby-user" },
  jellyfin: { baseUrl: "https://jellyfin.example.test", apiKey: "jellyfin-key", userId: "jellyfin-user" },
};

function movie(tmdbId, title) {
  return normalizePersonalRatingMedia({ media_type: "movie", type: "movie", title, tmdb_id: String(tmdbId) });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Emby and Jellyfin share the rating API shape: the item list (used by both the
// snapshot and the provider-id lookup), a UserData POST, and a single-item read.
function stubServer(provider, { itemId, tmdbId, title, rating = null, readBackRating = null }) {
  const base = config[provider].baseUrl;
  const user = config[provider].userId;
  const writes = [];
  const item = () => ({
    Id: itemId,
    Name: title,
    Type: "Movie",
    ProviderIds: { Tmdb: String(tmdbId) },
    UserData: rating == null ? {} : { Rating: rating },
  });
  const handler = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    if (requestUrl.origin !== new URL(base).origin) return null;
    const method = options.method || "GET";
    if (method === "POST" && requestUrl.pathname === `/Users/${user}/Items/${itemId}/UserData`) {
      writes.push(JSON.parse(options.body));
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && requestUrl.pathname === `/Users/${user}/Items/${itemId}`) {
      return json({ Id: itemId, UserData: readBackRating == null ? {} : { Rating: readBackRating } });
    }
    if (method === "GET" && (requestUrl.pathname === `/Users/${user}/Items` || requestUrl.pathname === "/Items")) {
      return json({ Items: [item()], TotalRecordCount: 1 });
    }
    throw new Error(`Unexpected ${provider} request: ${method} ${requestUrl}`);
  };
  return { handler, writes };
}

async function withServers(servers, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    for (const server of servers) {
      const response = await server.handler(url, options);
      if (response) return response;
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function queueRows(mediaKey) {
  return listPersonalRatingQueue({ statuses: ["pending", "processing", "failed", "succeeded", "not_found", "reauth_required"], limit: 500 })
    .filter((row) => row.media_key === mediaKey);
}

test("an Emby write that the server does not store leaves the queue row failed", async () => {
  const media = movie(7101, "Unstored Rating");
  queuePersonalRatingMutation(media, 7, { config, providers: ["emby"] });
  const emby = stubServer("emby", { itemId: "emby-7101", tmdbId: 7101, title: "Unstored Rating", readBackRating: null });

  const result = await withServers([emby], () => runRatingSync({ providers: ["emby"], snapshot: false, drain: true, config }));

  assert.deepEqual(emby.writes, [{ Rating: 7 }]);
  assert.equal(result.status, "partial");
  assert.equal(result.queue.failed, 1);
  const [row] = queueRows(media.media_key);
  assert.equal(row.status, "failed");
  assert.match(String(row.last_error || row.lastError || ""), /did not store it/);
  const source = getRatingSourceRow("emby", media.media_key);
  assert.equal(source.sync_status, "failed");
  assert.equal(source.last_outbound_rating, null);
});

test("an Emby write that reads back the sent rating is acknowledged", async () => {
  const media = movie(7102, "Stored Rating");
  queuePersonalRatingMutation(media, 8, { config, providers: ["emby"] });
  const emby = stubServer("emby", { itemId: "emby-7102", tmdbId: 7102, title: "Stored Rating", readBackRating: 8 });

  const result = await withServers([emby], () => runRatingSync({ providers: ["emby"], snapshot: false, drain: true, config }));

  assert.equal(result.queue.succeeded, 1);
  assert.equal(queueRows(media.media_key)[0].status, "succeeded");
  assert.equal(getRatingSourceRow("emby", media.media_key).last_outbound_rating, 8);
});

test("a provider reporting the value Plembfin last delivered is an echo, not a new remote change", async () => {
  const media = movie(7201, "Echo Rating");
  upsertCanonicalPersonalRating(media, 6, { origin: "manual", timestamp: 1_000 });
  upsertRatingSourceObservation({ provider: "emby", media, remoteRating: 5, remoteState: "rated", lastSeenAt: 2_000, lastInboundAt: 2_000 });
  markRatingSourceOutbound({ provider: "emby", mediaKey: media.media_key, desiredState: "rated", desiredRating: 8, intentId: "delivered", timestamp: 3_000 });
  const emby = stubServer("emby", { itemId: "emby-7201", tmdbId: 7201, title: "Echo Rating", rating: 8 });

  const result = await withServers([emby], () => runRatingSync({ providers: ["emby"], mode: "import", snapshot: true, drain: false, config }));

  const [snapshot] = result.providers;
  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.changed, 0);
  assert.equal(snapshot.queued, 0);
  assert.equal(Number(findCanonicalPersonalRating(media).rating), 6);
  assert.deepEqual(queueRows(media.media_key), []);
});

for (const [provider, other] of [["emby", "jellyfin"], ["jellyfin", "emby"]]) {
  test(`${provider}: an older remote value does not overwrite an undelivered local rating`, async () => {
    const tmdbId = provider === "emby" ? 7301 : 7302;
    const title = `Conflict ${provider}`;
    const media = movie(tmdbId, title);
    upsertCanonicalPersonalRating(media, 6, { origin: "manual", timestamp: 1_000 });
    upsertRatingSourceObservation({ provider, media, remoteRating: 5, remoteState: "rated", lastSeenAt: 500, lastInboundAt: 500 });
    queuePersonalRatingMutation(media, 6, { config, providers: [provider], timestamp: 1_000 });
    const server = stubServer(provider, { itemId: `${provider}-${tmdbId}`, tmdbId, title, rating: 9 });

    await withServers([server], () => runRatingSync({ providers: [provider], mode: "import", snapshot: true, drain: false, config }));

    assert.equal(Number(findCanonicalPersonalRating(media).rating), 6);
    const rows = queueRows(media.media_key);
    assert.deepEqual(rows.map((row) => [row.provider, row.status, row.desired_rating]), [[provider, "pending", 6]]);
    assert.equal(rows.some((row) => row.provider === other), false);
    assert.equal(getRatingSourceRow(provider, media.media_key).sync_status, "conflict");
  });

  test(`${provider}: a changed remote value with no undelivered local rating becomes canonical and fans out`, async () => {
    const tmdbId = provider === "emby" ? 7401 : 7402;
    const title = `Remote change ${provider}`;
    const media = movie(tmdbId, title);
    upsertCanonicalPersonalRating(media, 6, { origin: "manual", timestamp: 1_000 });
    upsertRatingSourceObservation({ provider, media, remoteRating: 6, remoteState: "rated", lastSeenAt: 500, lastInboundAt: 500 });
    const server = stubServer(provider, { itemId: `${provider}-${tmdbId}`, tmdbId, title, rating: 9 });

    await withServers([server], () => runRatingSync({ providers: [provider], mode: "import", snapshot: true, drain: false, config }));

    assert.equal(Number(findCanonicalPersonalRating(media).rating), 9);
    const rows = queueRows(media.media_key);
    assert.deepEqual(rows.map((row) => [row.provider, row.desired_rating]), [[other, 9]]);
  });
}

test("a Jellyfin rating clear sends Rating 0, because Jellyfin ignores a null Rating", async () => {
  const media = movie(7501, "Cleared Rating");
  const jellyfin = stubServer("jellyfin", { itemId: "jellyfin-7501", tmdbId: 7501, title: "Cleared Rating", rating: 7 });

  const result = await withServers([jellyfin], () => clearJellyfinPersonalRating(config.jellyfin, media));

  assert.equal(result.status, "fulfilled");
  assert.deepEqual(jellyfin.writes, [{ Rating: 0 }]);
});
