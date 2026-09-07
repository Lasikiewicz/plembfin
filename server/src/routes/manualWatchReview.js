import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { methodNotAllowed, sendJson, sendOptions } from "../utils/http.js";
import {
  appendSyncHistory,
  isAuthoritativeRestoreActive,
  loadMediaConfig,
} from "../utils/configStore.js";
import {
  deletePlaybackProgress,
  findWatchedByAnyMediaKey,
  getCachedHistory,
  insertWatchRecord,
  invalidateHistoryDerivedCaches,
  mediaKeyFor,
  mediaToWatchRecord,
  updateWatchRecord,
  updateWatchTelemetry,
  upsertPlaystateForMedia,
} from "../utils/dataRepo.js";
import { createLoopStore } from "../utils/loopStore.js";
import { syncMediaPlaystate } from "../utils/syncOrchestrator.js";
import { applyUnwatchedTransition } from "../utils/watchStateTransitions.js";
import { watchImportMode } from "../utils/tuning.js";
import { buildWatchProvenance, provenanceTelemetryLines } from "../utils/watchProvenance.js";
import { isoDateTime, resolveWatchImportDate } from "../utils/watchDates.js";
import {
  countPendingManualWatchReviews,
  getManualWatchReview,
  listPendingManualWatchReviews,
  manualWatchReviewMedia,
  setManualWatchReviewStatus,
} from "../utils/manualWatchReview.js";
import { recordWatchAuditEvent } from "../utils/watchAudit.js";

const REVIEW_MODES = new Set(["now", "release_day", "episode_timing", "custom"]);
const REVIEW_SOURCES = new Set(["plex", "emby", "jellyfin"]);

function reviewPath(req) {
  const path = req.path || new URL(req.originalUrl || req.url || "/", "https://local").pathname;
  return String(path).replace(/^\/api\/?/, "").replace(/^\/+|\/+$/g, "");
}

function reviewTelemetry(summary = {}, media = {}, mode = "now") {
  return [
    `Origin: ${media.source || "unknown"}`,
    "Action: Marked Watched",
    `Media: ${media.title || "unknown"}`,
    `Review decision: ${mode}`,
    `Loop-check: ${summary.skipped ? "Skipped propagation" : "Passed"}`,
    `Dispatch status: ${summary.status || "unknown"}`,
    `Details: ${summary.details || "No details"}`,
    ...provenanceTelemetryLines(media.watchProvenance || media.watch_provenance),
    ...(summary.targetStates || []).map((target) => (
      `${String(target.target || "unknown").replace(/^./, (value) => value.toUpperCase())} status: ${target.status}${target.detail ? ` - ${target.detail}` : ""}`
    )),
  ].join("\n");
}

function reviewMediaSummary(media = {}) {
  return {
    mediaKey: mediaKeyFor(media),
    mediaType: media.type || media.media_type || "unknown",
    title: media.title || "Unknown media",
    showTitle: media.showTitle || media.show_title,
    source: media.source || "unknown",
    ids: media.ids || {},
    season: media.season,
    episode: media.episode,
  };
}

function reviewSourceLabel(source = "") {
  const value = String(source || "unknown");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function reviewSourceConfigured(config = {}, source = "") {
  const section = config?.[source] || {};
  if (section.disabled) return false;
  if (source === "plex") return Boolean(section.baseUrl && section.token);
  return Boolean(section.baseUrl && section.apiKey && section.userId);
}

function sourceTargetState(summary = {}, source = "") {
  return (summary.targetStates || []).find((target) => String(target.target || "").toLowerCase() === source);
}

async function dismissReview(review) {
  if (isAuthoritativeRestoreActive()) {
    throw Object.assign(new Error("An authoritative watch-history restore is active; manual watch-state changes are paused until it completes."), { status: 409 });
  }

  const config = await loadMediaConfig();
  const media = manualWatchReviewMedia(review);
  const source = String(review.source || media.source || "").trim().toLowerCase();
  if (!REVIEW_SOURCES.has(source)) {
    throw Object.assign(new Error("This review has no supported reporting app, so it remains pending."), { status: 400 });
  }
  if (!reviewSourceConfigured(config, source)) {
    throw Object.assign(new Error(`${reviewSourceLabel(source)} is not configured or is disabled; the review remains pending.`), { status: 409 });
  }

  const sourceItemId = String(review.source_item_id || media.itemId || media.providerItemId || "").trim();
  const providerItems = {
    ...(media.providerItems || media.provider_items || {}),
  };
  const sourceProviderItems = Array.isArray(providerItems[source])
    ? providerItems[source].map((value) => String(value || "").trim()).filter(Boolean)
    : providerItems[source]
      ? [String(providerItems[source]).trim()]
      : [];
  if (sourceItemId && !sourceProviderItems.length) providerItems[source] = [sourceItemId];
  const dispatchMedia = {
    ...media,
    // This is an explicit Plembfin action, so keep it out of the automatic
    // inbound-unwatch burst guard. The reporting app is carried separately by
    // the authoritative target list below.
    source: "manual",
    ...(sourceItemId && !media.itemId ? { itemId: sourceItemId } : {}),
    providerItems,
    provider_items: providerItems,
    // This is an explicit correction of the provider that produced the review.
    // Keep the target list authoritative so dismissing a Plex review cannot
    // unexpectedly change Emby, Jellyfin, or a tracker as a side effect.
    syncTargets: [source],
  };
  if (!dispatchMedia.isValid || !["movie", "episode"].includes(dispatchMedia.type)) {
    throw Object.assign(new Error("This review does not contain a valid movie or episode identity; the review remains pending."), { status: 400 });
  }

  const result = await applyUnwatchedTransition(
    dispatchMedia,
    config,
    createLoopStore(),
    {
      includeSourcePlatform: true,
      force: true,
      lane: "interactive",
    },
  );
  // The local canonical state is updated before the outbound request. Refresh
  // derived history even when the provider rejects the correction so the UI
  // does not retain a stale watched item while the review stays pending for a
  // retry.
  await invalidateHistoryDerivedCaches("dismissManualWatchReview").catch(() => null);

  const target = sourceTargetState(result.summary, source);
  if (target?.status !== "success") {
    const detail = target?.detail || result.summary?.details || "The reporting app did not confirm the unwatched change.";
    throw Object.assign(
      new Error(`${reviewSourceLabel(source)} did not accept the unwatched correction (${detail}). The review remains pending.`),
      // This is an actionable provider-state conflict rather than an
      // unhandled server fault. Keep the user-safe reason visible to the UI;
      // the review remains pending so it can be retried after the app is
      // reachable or the match is corrected.
      { status: 409 },
    );
  }

  await appendSyncHistory({
    mediaType: dispatchMedia.type || "unknown",
    title: dispatchMedia.title || "Unknown media",
    source: "manual",
    status: result.summary?.status || "unknown",
    details: result.summary?.details || "",
    action: "unwatched",
    targetStates: result.summary?.targetStates || [],
    rawPayloadDebug: {
      event: "manual_watch_review_dismiss",
      reviewId: review.id,
      sourcePlatform: source,
      mediaKey: mediaKeyFor(dispatchMedia),
      watchRecordId: result.id || null,
    },
  }).catch((error) => console.error("Failed to append manual review unwatch history", error));
  recordWatchAuditEvent({
    eventType: "manual_watch_review_decided",
    timestamp: Date.now(),
    action: "unwatched",
    watchRecordId: result.id || "",
    mediaKey: mediaKeyFor(dispatchMedia),
    mediaType: dispatchMedia.type,
    title: dispatchMedia.title,
    showTitle: dispatchMedia.showTitle,
    source,
    season: dispatchMedia.season,
    episode: dispatchMedia.episode,
    status: "dismissed",
    details: `Manual watch review dismissed; marked unwatched on ${reviewSourceLabel(source)}.`,
    payload: {
      reviewId: review.id,
      sourcePlatform: source,
      targetStates: result.summary?.targetStates || [],
    },
  });

  const updated = setManualWatchReviewStatus(review.id, "dismissed");
  await invalidateHistoryDerivedCaches("dismissManualWatchReview").catch(() => null);
  return {
    id: review.id,
    status: "dismissed",
    action: "unwatched",
    source,
    syncStatus: result.summary?.status || "unknown",
    targetStates: result.summary?.targetStates || [],
    review: updated,
  };
}

async function approveReview(review, requestedMode = "", requestedWatchedAt = "") {
  if (isAuthoritativeRestoreActive()) {
    throw Object.assign(new Error("An authoritative watch-history restore is active; manual watch-state changes are paused until it completes."), { status: 409 });
  }

  const config = await loadMediaConfig();
  const requested = String(requestedMode || "").toLowerCase();
  const mode = REVIEW_MODES.has(requested)
    ? requested
    : (watchImportMode() === "review" ? "now" : watchImportMode());
  const media = manualWatchReviewMedia(review);
  let dateChoice;
  if (mode === "custom") {
    const watchedAt = isoDateTime(requestedWatchedAt);
    if (!watchedAt) {
      throw Object.assign(new Error("A valid manual watch date and time is required."), { status: 400 });
    }
    if (Date.parse(watchedAt) > Date.now() + 60_000) {
      throw Object.assign(new Error("The manual watch date and time cannot be in the future."), { status: 400 });
    }
    dateChoice = {
      watchedAt,
      previewWatchedAt: watchedAt,
      requiresReview: false,
      reason: "manual date and time",
    };
  } else {
    const historyRows = mode === "episode_timing" ? await getCachedHistory().catch(() => []) : [];
    dateChoice = resolveWatchImportDate({
      mode,
      manualMark: true,
      releaseDate: review.release_date || media.releaseDate,
      fallbackDate: review.observed_watched_at || media.watched_at,
      media,
      historyRows,
    });
  }
  media.watched_at = dateChoice.watchedAt;
  media.watchProvenance = buildWatchProvenance(
    {
      source: media.source,
      event: "manual_watch_review",
      phase: "completed",
      itemId: review.source_item_id || media.itemId,
    },
    {
      ingestPath: "manual_watch_review",
      sourceTimestamp: review.observed_watched_at || "",
      note: `Manual watch review approved with the ${mode.replaceAll("_", " ")} policy.`,
    },
  );

  const existing = await findWatchedByAnyMediaKey(media).catch(() => null);
  if (existing) {
    // A review is an explicit user decision. An existing watched row is only
    // an identity match, not a reason to discard the date the user selected.
    // This is especially important when the provider flag matches an older
    // Trakt/import row under a different media key: the old implementation
    // closed the review while silently keeping that row's historical date.
    const updatedRecord = await updateWatchRecord(
      existing.id,
      { watched_at: media.watched_at },
      { auditSource: "manual_watch_review" },
    );
    if (!updatedRecord?.ok) throw new Error(updatedRecord?.error || "Stored watch record could not be updated");
    media.watchRecordId = existing.id;
    await deletePlaybackProgress(media).catch(() => null);
    await upsertPlaystateForMedia(media, "watched", media.watched_at, { skipInvalidate: true });

    const loopStore = createLoopStore();
    const summary = await syncMediaPlaystate(media, config, loopStore, { lane: "interactive" }).catch((error) => ({
      skipped: false,
      status: "error",
      details: `Manual watch review propagation failed: ${error.message || String(error)}`,
      targetStates: [],
    }));
    await updateWatchTelemetry(existing.id, reviewTelemetry(summary, media, mode), { skipInvalidate: true });
    await appendSyncHistory({
      mediaType: media.type || "unknown",
      title: media.title || "Unknown media",
      source: media.source || "unknown",
      status: summary.status || "unknown",
      details: summary.details || "",
      action: "watched",
      targetStates: summary.targetStates || [],
      rawPayloadDebug: {
        event: "manual_watch_review",
        reviewId: review.id,
        decisionMode: mode,
        watchedAt: media.watched_at,
        mediaKey: mediaKeyFor(media),
        existingWatchRecordId: existing.id,
      },
    }).catch((error) => console.error("Failed to append manual review sync history", error));
    recordWatchAuditEvent({
      eventType: "manual_watch_review_decided",
      timestamp: Date.now(),
      action: "watched",
      mediaKey: mediaKeyFor(media),
      mediaType: media.type,
      title: media.title,
      showTitle: media.showTitle,
      source: media.source,
      season: media.season,
      episode: media.episode,
      status: "approved",
      details: `Manual watch review approved with the ${mode.replaceAll("_", " ")} policy; existing history updated.`,
      payload: { reviewId: review.id, mode, watchedAt: media.watched_at, existingWatchRecordId: existing.id },
    });
    const updated = setManualWatchReviewStatus(review.id, "approved", mode);
    await invalidateHistoryDerivedCaches("approveManualWatchReview").catch(() => null);
    return {
      id: review.id,
      status: "approved",
      mode,
      watchedAt: media.watched_at,
      watchRecordId: existing.id,
      existing: true,
      syncStatus: summary.status || "unknown",
      targetStates: summary.targetStates || [],
      review: updated,
    };
  }

  const watchRecord = mediaToWatchRecord(media, media.source || "manual");
  watchRecord.sync_action = "watched";
  watchRecord.sync_dispatch_telemetry = [
    `Origin: ${media.source || "manual"}`,
    "Loop-check: Passed",
    "Dispatch status: pending",
    `Details: Manual watch review approved with the ${mode.replaceAll("_", " ")} policy; queueing sync.`,
  ].join("\n");
  const inserted = await insertWatchRecord(watchRecord, { skipInvalidate: true, watchlistConfig: config });
  media.watchRecordId = inserted.id;
  await deletePlaybackProgress(media).catch(() => null);
  await upsertPlaystateForMedia(media, "watched", inserted.record.watched_at, { skipInvalidate: true });

  const loopStore = createLoopStore();
  const summary = await syncMediaPlaystate(media, config, loopStore, { lane: "interactive" }).catch((error) => ({
    skipped: false,
    status: "error",
    details: `Manual watch review propagation failed: ${error.message || String(error)}`,
    targetStates: [],
  }));
  await updateWatchTelemetry(inserted.id, reviewTelemetry(summary, media, mode), { skipInvalidate: true });
  await appendSyncHistory({
    mediaType: media.type || "unknown",
    title: media.title || "Unknown media",
    source: media.source || "unknown",
    status: summary.status || "unknown",
    details: summary.details || "",
    action: "watched",
    targetStates: summary.targetStates || [],
    rawPayloadDebug: {
      event: "manual_watch_review",
      reviewId: review.id,
      decisionMode: mode,
      watchedAt: inserted.record.watched_at,
      mediaKey: mediaKeyFor(media),
    },
  }).catch((error) => console.error("Failed to append manual review sync history", error));
  recordWatchAuditEvent({
    eventType: "manual_watch_review_decided",
    timestamp: Date.now(),
    action: "watched",
    mediaKey: mediaKeyFor(media),
    mediaType: media.type,
    title: media.title,
    showTitle: media.showTitle,
    source: media.source,
    season: media.season,
    episode: media.episode,
    status: "approved",
    details: `Manual watch review approved with the ${mode.replaceAll("_", " ")} policy.`,
    payload: { reviewId: review.id, mode, watchedAt: inserted.record.watched_at },
  });
  const updated = setManualWatchReviewStatus(review.id, "approved", mode);
  await invalidateHistoryDerivedCaches("approveManualWatchReview").catch(() => null);
  return {
    id: review.id,
    status: "approved",
    mode,
    watchedAt: inserted.record.watched_at,
    watchRecordId: inserted.id,
    syncStatus: summary.status || "unknown",
    targetStates: summary.targetStates || [],
    review: updated,
  };
}

export async function handleManualWatchReview(req, res, path) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;

  const normalizedPath = String(path || reviewPath(req)).replace(/^\/|\/$/g, "");
  const parts = normalizedPath.split("/");
  const action = parts.length >= 3 ? parts[2] : "";
  const id = parts.length >= 2 ? decodeURIComponent(parts[1]) : "";

  if (req.method === "GET" && !action) {
    const summaryOnly = String(req.query?.summary || "") === "1";
    return sendJson(res, {
      ok: true,
      count: countPendingManualWatchReviews(),
      reviews: summaryOnly ? [] : listPendingManualWatchReviews(),
    }, 200, { "Cache-Control": "no-store" });
  }
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!id || !["approve", "dismiss", "defer"].includes(action)) return sendJson(res, { error: "Review action is invalid" }, 400);

  const review = getManualWatchReview(id);
  if (!review) return sendJson(res, { error: "Manual watch review not found" }, 404);
  if (action === "dismiss") {
    try {
      const result = review.status === "pending"
        ? await dismissReview(review)
        : { id, status: review.status, action: "unwatched", source: review.source, review };
      return sendJson(res, { ok: true, ...result, count: countPendingManualWatchReviews() }, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      const status = Number(error?.status);
      return sendJson(res, { ok: false, error: error.message || "Manual watch review dismissal failed" }, Number.isInteger(status) ? status : 500);
    }
  }
  if (action === "defer") {
    return sendJson(res, { ok: true, review, count: countPendingManualWatchReviews() });
  }

  const body = await readJson(req);
  try {
    const result = review.status === "pending"
      ? await approveReview(review, body.mode || body.watchImportMode, body.watched_at || body.watchedAt)
      : { id, status: review.status, mode: review.decision_mode, watchedAt: review.media?.watched_at || "", review };
    return sendJson(res, { ok: true, ...result, count: countPendingManualWatchReviews() }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    const status = Number(error?.status);
    return sendJson(res, { ok: false, error: error.message || "Manual watch review approval failed" }, Number.isInteger(status) ? status : 500);
  }
}
