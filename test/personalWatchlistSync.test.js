import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-personal-watchlist-sync-");

const { db } = await import("../server/src/db.js");
const { applyWatchlistMutation, getWatchlistRestoreState, listWatchlistProviderItems, listWatchlistQueue, markWatchlistRestorePending, clearWatchlistRestorePending, upsertProviderWatchlistItem, watchlistProviderScope } = await import("../server/src/utils/personalWatchlistRepository.js");
const { normalizePersonalWatchlistMedia } = await import("../server/src/utils/personalWatchlistIdentity.js");
const { processWatchlistQueue, runWatchlistSync } = await import("../server/src/utils/personalWatchlistSync.js");

const originalFetch = globalThis.fetch;
const config = {
  plex: { baseUrl: "https://plex.example", accountToken: "account-secret" },
  watchlistSync: {
    enabled: true,
    providers: { plex: { enabled: true, representation: "native", writeEnabled: true, publishConfirmedAt: 1 }, emby: { enabled: false, representation: "playlist", publishConfirmedAt: 0 }, jellyfin: { enabled: false, representation: "playlist", publishConfirmedAt: 0 } },
  },
};

test.after(() => {
  globalThis.fetch = originalFetch;
  db.close();
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("watchlist queue resolves an unambiguous provider target and records outbound success", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/hubs/search")) {
      return jsonResponse({ MediaContainer: { Metadata: [{ type: "movie", ratingKey: "plex-601", title: "Queue Target", guid: "tmdb://601", year: 2025 }] } });
    }
    return new Response(null, { status: 204 });
  };

  const media = normalizePersonalWatchlistMedia({ type: "movie", title: "Queue Target", tmdb_id: "601", year: 2025 });
  applyWatchlistMutation(media, "present", { config, origin: "local", eventId: "queue-601", timestamp: 1000 });
  const result = await processWatchlistQueue({ config, provider: "plex", limit: 5, budgetMs: 5000 });
  assert.equal(result.counts.succeeded, 1);
  assert.equal(listWatchlistQueue({ provider: "plex" })[0].status, "succeeded");
  const ledger = listWatchlistProviderItems({ provider: "plex", mediaKey: media.media_key });
  assert.equal(ledger[0].remote_state, "present");
  assert.equal(ledger[0].last_outbound_state, "present");
  assert.equal(calls.every((call) => !call.url.includes("account-secret")), true);
});

test("restored watchlist work is held until an explicit publish", async () => {
  markWatchlistRestorePending({ restoreId: "restore-sync", timestamp: 2000 });
  assert.equal(getWatchlistRestoreState().pending, true);
  const result = await runWatchlistSync({ mode: "reconcile", config });
  assert.equal(result.requiresPublish, true);
  assert.deepEqual(result.results, []);
  const queueResult = await processWatchlistQueue({ config, provider: "plex" });
  assert.equal(queueResult.skipped, "restore-publish-required");
  clearWatchlistRestorePending({ timestamp: 2100 });
});

test("a confirmed provider presence satisfies an add without duplicating the remote item", async () => {
  const media = normalizePersonalWatchlistMedia({ type: "movie", title: "Already Present", tmdb_id: "602" });
  const scope = watchlistProviderScope("plex", config, config.watchlistSync.providers.plex);
  upsertProviderWatchlistItem({
    ...scope,
    media,
    providerItemId: "plex-602",
    remoteState: "present",
    managedByPlembfin: true,
    timestamp: 3000,
  });
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(null, { status: 204 });
  };
  applyWatchlistMutation(media, "present", { config, origin: "local", eventId: "queue-602", timestamp: 3100 });
  const result = await processWatchlistQueue({ config, provider: "plex", limit: 5, budgetMs: 5000 });
  assert.equal(result.counts.succeeded, 1);
  assert.equal(calls.length, 0);
  assert.equal(listWatchlistQueue({ provider: "plex" }).find((row) => row.media_key === media.media_key).status, "succeeded");
});
