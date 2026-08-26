import { db } from "../db.js";
import {
  deletePlaybackProgressSync,
  deleteWatchRecordByIdSync,
  deleteWatchRecordSync,
  findWatchedByAnyMediaKey,
  getPlaystateForMedia,
  getWatchRecordByIdLight,
  getWatchRecordByMediaKey,
  insertWatchRecordSync,
  mediaKeyFor,
  mediaToWatchRecord,
  prefetchWatchRecordAssets,
  updateWatchRecord,
  updateWatchTelemetry,
  upsertPlaystateForMediaSync,
} from "./dataRepo.js";
import { syncMediaPlaystate, syncMediaUnplayedPlaystate } from "./syncOrchestrator.js";

// Cross-platform mass-false-unwatch circuit breaker. applyUnwatchedTransition
// below is the single choke point every *automatic* (non-manual) unwatch path
// already funnels through - Plex/Emby/Jellyfin webhooks, the Plex real-time
// notification listener and adaptive poller, the Emby/Jellyfin unwatched-
// fallback polls, and the Trakt poller. Any one of those source servers having
// its own bad moment (a library rescan, a metadata refresh, a database
// hiccup, a rate-limited/truncated API response) can make it report a burst
// of items as suddenly unplayed that were never genuinely unwatched - and
// each one individually looks like a normal single unwatch, so nothing
// distinguishes it from real activity until you look at the volume. Real
// incident (2026-08-21): a ~7-minute window, 264+ episodes across dozens of
// completely unrelated shows, all sourced from one Jellyfin poll/webhook
// burst - each one propagated to Plex and Emby before anyone noticed.
//
// This is deliberately coarser than the per-show/per-batch guard Trakt's own
// poller already has (partitionSuspiciousUnwatches in trackerSync.js, which
// only trips when *one show* loses a large share of its episodes at once):
// it catches the case that guard misses, a burst spread thin across many
// different shows/movies rather than concentrated in one. It is backed by
// the shared loop_keys table (not in-memory) so it works correctly across
// a split web/worker deployment, where webhooks and scheduled polls can land
// on different processes.
//
// Manual/explicit sources (a user marking something unwatched in Plembfin
// itself, Force Sync, Set Plembfin as Source of Truth, Trakt import) are
// never subject to this - a person is allowed to unwatch as much as they
// want in one sitting; only automatic, inbound-from-a-server decisions are
// rate-limited.
const AUTOMATIC_UNWATCH_SOURCES = new Set(["plex", "emby", "jellyfin", "trakt"]);
const AUTOMATIC_UNWATCH_BURST_WINDOW_MS = 5 * 60 * 1000;
const AUTOMATIC_UNWATCH_BURST_THRESHOLD = 15;
const AUTOMATIC_UNWATCH_BURST_KEY_PREFIX = "auto-unwatch-burst:";

const countRecentAutomaticUnwatchesStmt = db.prepare(
  "SELECT COUNT(*) AS c FROM loop_keys WHERE key LIKE ? AND expire_at > ?",
);
const recordAutomaticUnwatchStmt = db.prepare(
  "INSERT INTO loop_keys (id, key, value, created_at, expire_at) VALUES (@id, @key, @value, @created_at, @expire_at)",
);
const hasWatchRecordIdStmt = db.prepare("SELECT 1 FROM watch_history WHERE id=?");

function isAutomaticUnwatchSource(source) {
  return AUTOMATIC_UNWATCH_SOURCES.has(String(source || "").toLowerCase());
}

// Returns true (and does not record anything) when this automatic unwatch
// should be held back as part of a suspected mass false-unwatch burst.
function automaticUnwatchBurstDetected(media) {
  if (!isAutomaticUnwatchSource(media?.source)) return false;
  const now = Date.now();
  const recentCount = countRecentAutomaticUnwatchesStmt.get(`${AUTOMATIC_UNWATCH_BURST_KEY_PREFIX}%`, now).c;
  if (recentCount >= AUTOMATIC_UNWATCH_BURST_THRESHOLD) {
    console.error(
      `applyUnwatchedTransition: held back automatic unwatch for "${media.title || "unknown title"}" ` +
      `(source: ${media.source}) - ${recentCount} automatic unwatches already recorded in the last ` +
      `${Math.round(AUTOMATIC_UNWATCH_BURST_WINDOW_MS / 60000)}m, which looks like a mass false-unwatch ` +
      `burst rather than genuine activity. Not propagating; check the source server and re-verify manually ` +
      `if this item really was unwatched.`,
    );
    return true;
  }
  recordAutomaticUnwatchStmt.run({
    id: crypto.randomUUID(),
    key: `${AUTOMATIC_UNWATCH_BURST_KEY_PREFIX}${media.source}:${media.title || ""}`,
    value: String(now),
    created_at: now,
    expire_at: now + AUTOMATIC_UNWATCH_BURST_WINDOW_MS,
  });
  return false;
}

function runGuardedLocalTransaction(shouldDefer, mutate) {
  let deferred = false;
  let result;
  // The guard and every local mutation are synchronous while an IMMEDIATE
  // transaction owns the cross-process write lock. A web action can therefore
  // land before this transaction (and be seen by shouldDefer) or after it (and
  // win), never in the middle of a stale tracker mutation. A thrown mutation
  // error reaches better-sqlite3 directly, so all earlier writes roll back.
  db.transaction(() => {
    if (shouldDefer?.()) {
      deferred = true;
      return;
    }
    result = mutate();
  }).immediate();
  return { deferred, result };
}

function deferredWatchedResult() {
  return { inserted: false, deferred: true, summary: { skipped: true, status: "skipped", details: "Deferred because a newer local/outbound state appeared during the tracker poll", targetStates: [] } };
}

function deferredUnwatchedResult(existingRecord = null) {
  return {
    wasDeleted: false,
    id: existingRecord?.id || "",
    alreadyUnwatched: false,
    deferred: true,
    summary: { skipped: true, status: "skipped", details: "Deferred because a newer local/outbound state appeared during the tracker poll", targetStates: [] },
  };
}

// Trakt is the only automatic source whose reported watched date can change
// after the fact - a user editing a play's date on trakt.tv reports back
// through the same poll as any other "watched" transition, for an item
// Plembfin already has watched. The generic already-watched short-circuit
// below would otherwise silently discard that correction forever, since it
// only distinguishes unwatched->watched, not "watched but the date moved".
// Plex/Emby/Jellyfin have no equivalent editable date to catch here - their
// watched flag is binary - so this stays scoped to source === "trakt".
async function applyTraktWatchedDateCorrection(media, config, loopStore, { lane, shouldDefer }) {
  const existingRow = await findWatchedByAnyMediaKey(media).catch(() => null);
  if (!existingRow) return null;
  // updateWatchRecord does its own DB writes (and awaits an invalidation at
  // the end), so it does not fit runGuardedLocalTransaction's synchronous
  // IMMEDIATE-transaction pattern above - a single shouldDefer check right
  // before starting is the same race-safety every other low-frequency
  // correction path in this app relies on.
  if (shouldDefer?.()) return deferredWatchedResult();
  const updateResult = await updateWatchRecord(existingRow.id, { watched_at: media.watched_at });
  if (!updateResult.ok) return null;
  upsertPlaystateForMediaSync(media, "watched", media.watched_at);
  const id = existingRow.id;
  if (shouldDefer?.()) return { ...deferredWatchedResult(), id };
  const summary = await syncMediaPlaystate(media, config, loopStore, { trackDispatch: false, lane, shouldDefer }).catch((error) => ({
    skipped: false, status: "error", details: `Watched-date correction propagation failed: ${error.message || String(error)}`, targetStates: [],
  }));
  if (summary.deferred) return { ...deferredWatchedResult(), id, summary };
  await updateWatchTelemetry(id, [
    `Origin: ${media.source || "unknown"}`, "Action: Watched date corrected on Trakt", `Media: ${media.title || "unknown"}`,
    `Dispatch status: ${summary.status || "unknown"}`, `Details: ${summary.details || "Watched date correction processed."}`,
    ...(summary.targetStates || []).map((state) => `Target ${state.target} status: ${state.status}${state.detail ? ` - ${state.detail}` : ""}`),
  ].join("\n"), { skipInvalidate: true });
  return { inserted: false, dateCorrected: true, id, alreadyWatched: false, summary };
}

export async function applyWatchedTransition(media, config, loopStore, { trackDispatch = true, lane = "sync", shouldDefer = null } = {}) {
  const existing = await getPlaystateForMedia(media).catch(() => null);
  if (existing?.state === "watched") {
    if (String(media.source || "").toLowerCase() === "trakt") {
      const incomingIso = media.watched_at ? new Date(media.watched_at).toISOString() : "";
      const currentIso = existing.watched_at ? new Date(existing.watched_at).toISOString() : "";
      if (incomingIso && incomingIso !== currentIso) {
        const corrected = await applyTraktWatchedDateCorrection(media, config, loopStore, { lane, shouldDefer });
        if (corrected) return corrected;
      }
    }
    return { inserted: false, alreadyWatched: true, summary: { skipped: true, status: "skipped", details: "Already watched; no change to propagate", targetStates: [] } };
  }
  if (shouldDefer?.()) {
    return deferredWatchedResult();
  }
  // getPlaystateForMedia can still miss an already-recorded watch stored
  // under a media_key from a different source (e.g. a Trakt-sourced entry
  // keyed by imdb vs a media-server entry keyed by title fallback for the
  // same episode) - findWatchedByAnyMediaKey has the broader coordinate/
  // provider-id fallback matching every other ingest path relies on for
  // this; a hit there is conclusive too, not just an exact playstate match.
  const existingByAnyKey = await findWatchedByAnyMediaKey(media).catch(() => null);
  // A watched row under an alias is only a no-op when the current canonical
  // pointer is not explicitly unwatched. After a Fix Match/provider-id change
  // it is possible to have an older watched row under identity A and a newer
  // unwatched row/playstate under identity B for the same episode. Treating
  // the older row as conclusive here merely flips the playstate cache while
  // leaving the newer unwatched history transition canonical; the next cache
  // rebuild (notably at the end of a Trakt poll) then makes the episode appear
  // unwatched again. A new inbound watched fact must record a fresh watched
  // transition so both history and playstate agree.
  if (existingByAnyKey && existing?.state !== "unwatched") {
    const local = runGuardedLocalTransaction(shouldDefer, () => (
      upsertPlaystateForMediaSync(media, "watched", existingByAnyKey.watched_at)
    ));
    if (local.deferred) return deferredWatchedResult();
    return { inserted: false, alreadyWatched: true, summary: { skipped: true, status: "skipped", details: "Already recorded under a different media key; no change to propagate", targetStates: [] } };
  }
  const record = mediaToWatchRecord({ ...media, syncAction: "watched" }, media.source);
  record.sync_action = "watched";
  const local = runGuardedLocalTransaction(shouldDefer, () => {
    const inserted = insertWatchRecordSync(record);
    deletePlaybackProgressSync(media);
    upsertPlaystateForMediaSync(media, "watched", record.watched_at);
    return inserted;
  });
  if (local.deferred) return deferredWatchedResult();
  const result = local.result;
  void prefetchWatchRecordAssets(result);
  // A newer action can legitimately commit after our atomic local section.
  // Re-check before any network work so the later action owns outbound order.
  if (shouldDefer?.()) return { ...deferredWatchedResult(), id: result.id };
  const summary = await syncMediaPlaystate(media, config, loopStore, { trackDispatch, lane, shouldDefer }).catch((error) => ({
    skipped: false, status: "error", details: `Watched propagation failed: ${error.message || String(error)}`, targetStates: [],
  }));
  if (summary.deferred) return { ...deferredWatchedResult(), id: result.id, summary };
  await updateWatchTelemetry(result.id, [
    `Origin: ${media.source || "unknown"}`, "Action: Marked Watched", `Media: ${media.title || "unknown"}`,
    `Dispatch status: ${summary.status || "unknown"}`, `Details: ${summary.details || "Watched state processed."}`,
    ...(summary.targetStates || []).map((state) => `Target ${state.target} status: ${state.status}${state.detail ? ` - ${state.detail}` : ""}`),
  ].join("\n"), { skipInvalidate: true });
  return { inserted: true, id: result.id, alreadyWatched: false, summary };
}

function unwatchedTelemetry(summary, media) {
  return [
    `Origin: ${media.source || "unknown"}`,
    "Action: Marked Unwatched",
    `Media: ${media.title || "unknown"}`,
    `Loop-check: ${summary.skipped ? "Skipped propagation" : "Passed"}`,
    `Dispatch status: ${summary.status || "unknown"}`,
    `Details: ${summary.details || "Unwatched state processed."}`,
    ...(summary.targetStates || []).map((state) => `Target ${state.target} status: ${state.status}${state.detail ? ` - ${state.detail}` : ""}`),
  ].join("\n");
}

// Applies one explicit inbound/manual unwatched transition. Callers are
// responsible for rejecting provider-user mismatches and outbound echoes before
// reaching this function. Once admitted, the newest user action wins everywhere.
//
// `force` skips the "already unwatched, nothing to propagate" short-circuit
// below and always dispatches to every target instead. Automated/inbound
// callers (webhooks, the scheduler, tracker sync) must leave it off - the
// short-circuit is their loop protection, since an echo of their own prior
// unwatch would otherwise re-dispatch forever. It exists for explicit manual
// unwatch actions, where plembfin's own canonical state can already say
// "unwatched" while a media server has silently drifted back to watched (e.g.
// after a library rescan) - the user clicking "Mark unwatched" again should
// still force a live re-push rather than silently no-op.
export async function applyUnwatchedTransition(media, config, loopStore, {
  recordId = "",
  includeSourcePlatform = false,
  trackDispatch = true,
  force = false,
  lane = "sync",
  shouldDefer = null,
} = {}) {
  const existingWatched = await findWatchedByAnyMediaKey(media).catch(() => null);
  const existingRecord = recordId
    ? await getWatchRecordByIdLight(recordId).catch(() => null)
    : await getWatchRecordByMediaKey(mediaKeyFor(media)).catch(() => null);
  const canonicalState = await getPlaystateForMedia(media).catch(() => null);
  const alreadyUnwatchedLocally = !existingWatched && (canonicalState?.state === "unwatched" || existingRecord?.sync_action === "unwatched");

  if (alreadyUnwatchedLocally && force) {
    // Nothing to insert/delete - plembfin already has this as unwatched - but
    // still clear progress and push "unplayed" live to every connected target.
    const local = runGuardedLocalTransaction(shouldDefer, () => deletePlaybackProgressSync(media));
    if (local.deferred) return deferredUnwatchedResult(existingRecord);
    const syncMedia = { ...(includeSourcePlatform ? { ...media, source: "manual" } : media), lane };
    const summary = await syncMediaUnplayedPlaystate(syncMedia, config, loopStore, { trackDispatch, lane, shouldDefer }).catch((error) => ({
      skipped: false, status: "error", details: `Unwatched propagation failed: ${error.message || String(error)}`, targetStates: [],
    }));
    if (summary.deferred) return { ...deferredUnwatchedResult(existingRecord), summary };
    if (existingRecord?.id) {
      await updateWatchTelemetry(existingRecord.id, unwatchedTelemetry(summary, syncMedia), { skipInvalidate: true }).catch(() => null);
    }
    return { wasDeleted: false, id: existingRecord?.id || "", alreadyUnwatched: true, summary };
  }

  if (alreadyUnwatchedLocally) {
    // Canonical state is already unwatched, but a partial-progress row can still
    // exist (e.g. a re-watch in progress after an earlier unwatch) - always clear
    // it so "Clear Progress" removes the item from the Part Watched list.
    const local = runGuardedLocalTransaction(shouldDefer, () => deletePlaybackProgressSync(media));
    if (local.deferred) return deferredUnwatchedResult(existingRecord);
    return {
      wasDeleted: false,
      id: existingRecord?.id || "",
      alreadyUnwatched: true,
      summary: { skipped: true, status: "skipped", details: "Already unwatched; no change to propagate", targetStates: [] },
    };
  }

  const supersededId = existingWatched?.id || existingRecord?.id || "";
  const pendingSummary = { skipped: false, status: "pending", details: "Unwatched propagation queued", targetStates: [] };
  const unplayedRecord = mediaToWatchRecord({ ...media, syncAction: "unwatched" }, media.source);
  unplayedRecord.sync_action = "unwatched";
  unplayedRecord.sync_dispatch_telemetry = unwatchedTelemetry(pendingSummary, media);

  let heldBackSuspiciousBurst = false;
  let deletedById = false;
  let deletedByKey = false;
  const local = runGuardedLocalTransaction(shouldDefer, () => {
    if (automaticUnwatchBurstDetected(media)) {
      heldBackSuspiciousBurst = true;
      return null;
    }
    if (recordId) {
      deletedById = deleteWatchRecordByIdSync(recordId);
    }
    deletedByKey = deleteWatchRecordSync(media);
    const reusableId = supersededId && !hasWatchRecordIdStmt.get(supersededId) ? supersededId : "";
    const inserted = insertWatchRecordSync(unplayedRecord, { id: reusableId });
    deletePlaybackProgressSync(media);
    upsertPlaystateForMediaSync(media, "unwatched", unplayedRecord.watched_at);
    return inserted;
  });

  if (local.deferred) return deferredUnwatchedResult(existingRecord);
  if (heldBackSuspiciousBurst) {
    return {
      wasDeleted: false,
      id: existingRecord?.id || "",
      alreadyUnwatched: false,
      heldBackSuspiciousBurst: true,
      summary: { skipped: true, status: "skipped", details: "Held back: looks like a mass false-unwatch burst (see server logs).", targetStates: [] },
    };
  }
  const result = local.result;
  void prefetchWatchRecordAssets(result);
  const wasDeleted = Boolean(deletedById || deletedByKey);

  if (shouldDefer?.()) return { ...deferredUnwatchedResult(existingRecord), wasDeleted, id: result.id };

  const syncMedia = { ...(includeSourcePlatform ? { ...media, source: "manual" } : media), lane };
  const summary = await syncMediaUnplayedPlaystate(syncMedia, config, loopStore, { trackDispatch, lane, shouldDefer }).catch((error) => ({
    skipped: false,
    status: "error",
    details: `Unwatched propagation failed: ${error.message || String(error)}`,
    targetStates: [],
  }));
  if (summary.deferred) {
    return { ...deferredUnwatchedResult(existingRecord), wasDeleted, id: result.id, summary };
  }
  await updateWatchTelemetry(result.id, unwatchedTelemetry(summary, syncMedia), { skipInvalidate: true });
  return { wasDeleted, id: result.id, alreadyUnwatched: false, summary };
}
