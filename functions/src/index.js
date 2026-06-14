import { setGlobalDispatcher, Agent } from "undici";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { setGlobalOptions } from "firebase-functions/v2";
import { normalizeProviderIds, parseCustomWebhook, parseEmbyWebhook, parseJellyfinWebhook, parsePlexWebhook } from "./utils/parsers.js";
import { findPlexItem, markPlexPlayed, setPlexProgress } from "./utils/plexClient.js";
import { markEmbyPlayed, setEmbyProgress } from "./utils/embyClient.js";
import { markJellyfinPlayed, setJellyfinProgress } from "./utils/jellyfinClient.js";
import { isLocalAdminToken, requireAdmin } from "./utils/auth.js";
import { readFormData, readJson } from "./utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed, notFound } from "./utils/http.js";
import { appendSyncHistory, loadMediaConfig, saveMediaConfig, validateConfig, getSyncHistory, loadRuntimeState, setRuntimeState } from "./utils/configStore.js";
import { createLoopStore } from "./utils/loopStore.js";
import { listActiveSessions, deleteActiveSession, upsertActiveSession } from "./utils/activeSessions.js";
import { hydrateCachedSession, loadLiveTrackingCache } from "./utils/liveSessions.js";
import { runForceSync, runScheduledSync } from "./scheduled.js";
import {
  batchInsertWatchRecords,
  countPlaybackProgressRows,
  countWatchedPlaystateRows,
  deletePlaybackProgress,
  deleteWatchRecord,
  updateWatchRecord,
  mergeShows,
  getWatchRecordById,
  getWatchRecordByIdLight,
  getHistoryCacheVersion,
  getWatchStats,
  invalidateHistoryDerivedCaches,
  insertWatchRecord,
  listPlaybackProgressRowsForReplay,
  listWatchedPlaystateRowsForReplay,
  mediaToPlaybackProgressRecord,
  mediaToWatchRecord,
  mediaKeyFor,
  progressRowToMedia,
  querySyncJobs,
  queryMovies,
  queryShowDetail,
  queryShows,
  queryWatchHistory,
  queryWatchHistoryPreview,
  requireDb,
  updateWatchPosterUrl,
  updatePlaybackProgressTelemetry,
  updateWatchTelemetry,
  upsertPlaybackProgress,
  upsertPlaystateForMedia,
  watchRecordToFirestoreData,
  watchRowToMedia,
  getCachedShows,
  getCachedMovies,
  canonicalTitleKey,
  tmdbCacheTtlMs,
  mergeTmdbDetails,
  computeTvNextAiringDate,
} from "./utils/firestoreRepo.js";
import { shouldSyncResumeProgress, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "./utils/syncOrchestrator.js";
import { watchedPlayedSyncEnabled } from "./utils/syncFlags.js";
import { fetchPosterFromTmdb } from "./utils/tmdbClient.js";
import { cachePosterFromUrl, getPosterCache, markPosterMissing, usableCachedPoster } from "./utils/posterCache.js";
import { db, FieldValue } from "./firebase.js";

const region = process.env.FUNCTIONS_REGION || "europe-west2";
setGlobalOptions({ region, maxInstances: 10 });

setGlobalDispatcher(new Agent({
  keepAliveTimeout: 15000,
  connections: 64,
}));

function routePath(req) {
  const path = req.path || new URL(req.originalUrl || req.url, "https://local").pathname;
  return path.replace(/^\/api\/?/, "").replace(/^\/+/, "") || "";
}

// Streaming-safe auth check: headers have already been sent, so failures are
// communicated via the response body rather than HTTP status codes.
async function requireAdminStreaming(req, res) {
  const header = req.get("authorization") || req.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim() || String(req.query?.token || req.query?.admin_token || "").trim();
  if (!token) {
    res.write("ERROR: Unauthorized\n");
    res.end();
    return null;
  }
  if (isLocalAdminToken(token)) {
    return { uid: "local-admin", email: "admin", local: true };
  }
  try {
    const { auth } = await import("./firebase.js");
    const decoded = await auth.verifyIdToken(token);
    const allowedEmails = String(process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    const allowedUids = String(process.env.ADMIN_UIDS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    const email = String(decoded.email || "").toLowerCase();
    const uid = String(decoded.uid || "").toLowerCase();
    if (!allowedEmails.length && !allowedUids.length) {
      res.write("ERROR: Admin allowlist not configured\n");
      res.end();
      return null;
    }
    if ((allowedEmails.length && allowedEmails.includes(email)) || (allowedUids.length && allowedUids.includes(uid))) {
      return decoded;
    }
    res.write("ERROR: Forbidden\n");
    res.end();
    return null;
  } catch (error) {
    res.write("ERROR: Invalid token\n");
    res.end();
    return null;
  }
}

function imagePath(path, params = {}) {
  const cleanPath = String(path || "").trim();
  if (!cleanPath) return "";
  try {
    const url = new URL(cleanPath, "https://media.local");
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    return `${url.pathname}${url.search}`;
  } catch (error) {
    return "";
  }
}

function posterPathFromMedia(media = {}) {
  if (media.posterUrl) return media.posterUrl;
  if (media.source === "plex" && media.poster?.path) return imagePath(media.poster.path);
  if ((media.source === "emby" || media.source === "jellyfin") && media.poster?.itemId) {
    return imagePath(`/Items/${encodeURIComponent(media.poster.itemId)}/Images/Primary`, { tag: media.poster.tag });
  }
  return "";
}

function configForPosterSource(config = {}, source = "") {
  const key = String(source || "").toLowerCase();
  if (key.includes("plex")) return { ...config.plex, source: "plex" };
  if (key.includes("emby")) return { ...config.emby, source: "emby" };
  if (key.includes("jellyfin")) return { ...config.jellyfin, source: "jellyfin" };
  return {};
}

function configuredPosterUrl(path = "", source = "", config = {}) {
  const raw = String(path || "").trim();
  const server = configForPosterSource(config, source);
  const baseUrl = String(server.baseUrl || server.url || "").trim().replace(/\/+$/, "");
  if (!raw || !baseUrl) return "";

  try {
    const url = new URL(raw, `${baseUrl}/`);
    if (server.source === "plex" && (server.token || server.apiKey)) {
      url.searchParams.set("X-Plex-Token", server.token || server.apiKey);
    }
    if ((server.source === "emby" || server.source === "jellyfin") && (server.apiKey || server.api_key)) {
      url.searchParams.set("api_key", server.apiKey || server.api_key);
    }
    return url.toString();
  } catch (error) {
    return "";
  }
}

function isHttpsUrl(value = "") {
  return /^https:\/\//i.test(String(value || "").trim());
}

function isHttpUrl(value = "") {
  return /^http:\/\//i.test(String(value || "").trim());
}

function isCachedStorageUrl(value = "") {
  const raw = String(value || "").trim();
  return raw.includes("firebasestorage.googleapis.com/") || raw.includes("/v0/b/") || raw.includes("127.0.0.1:9199/");
}

async function normalizeWebhook(req) {
  const contentType = req.get("content-type") || "";
  if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
    return parsePlexWebhook(await readFormData(req));
  }
  if (contentType.includes("application/json")) {
    const json = await readJson(req);
    const customPayload = parseCustomWebhook(json);
    if (customPayload.isValid) return customPayload;
    const embyPayload = parseEmbyWebhook(json);
    if (embyPayload.isValid || json?.Event) return embyPayload;
    return parseJellyfinWebhook(json);
  }
  return {
    isValid: false,
    source: "unknown",
    ids: {},
    title: "Unsupported webhook content type",
    rawPayloadDebug: { contentType },
  };
}

function formatDispatchTelemetry(summary, media, action = "watched") {
  const actionLabel = action === "unwatched" || action === "unplayed" ? "Marked Unwatched" : "Marked Watched";
  const lines = [
    `Origin: ${media.source || "unknown"}`,
    `Action: ${actionLabel}`,
    `Media: ${media.title || "unknown"}`,
    `Loop-check: ${summary.skipped ? "Skipped propagation" : "Passed"}`,
    `Dispatch status: ${summary.status || "unknown"}`,
    `Details: ${summary.details || "No details"}`,
  ];
  for (const state of summary.targetStates || []) {
    lines.push(`${platformLabel(state.target)} status: ${state.status}${state.detail ? ` - ${state.detail}` : ""}`);
  }
  return lines.join("\n");
}

function formatProgressTelemetry(summary, media) {
  const positionMs = Number(media.positionMs ?? media.offsetMs ?? 0);
  const lines = [
    `Origin: ${media.source || "unknown"}`,
    `Media: ${media.title || "unknown"}`,
    `Resume position: ${Math.round(positionMs / 1000)}s`,
    `Progress: ${Number(media.progress || 0).toFixed(1)}%`,
    `Loop-check: ${summary.skipped ? "Skipped propagation" : "Passed"}`,
    `Dispatch status: ${summary.status || "unknown"}`,
    `Details: ${summary.details || "No details"}`,
  ];
  for (const state of summary.targetStates || []) {
    lines.push(`${platformLabel(state.target)} progress status: ${state.status}${state.detail ? ` - ${state.detail}` : ""}`);
  }
  return lines.join("\n");
}

async function recordSyncHistory(media = {}, summary = {}, action = "watched") {
  await appendSyncHistory({
    mediaType: media.type || media.mediaType || "unknown",
    title: media.title || "Unknown media",
    source: media.source || "unknown",
    status: summary.status || "unknown",
    details: summary.details || "",
    action,
    targetStates: summary.targetStates || [],
    rawPayloadDebug: {
      event: media.event || "",
      phase: media.phase || "",
      ids: media.ids || {},
      season: media.season ?? null,
      episode: media.episode ?? null,
      progress: media.progress ?? null,
      offsetMs: media.offsetMs ?? media.positionMs ?? null,
    },
  }).catch((error) => console.error("Failed to append sync history", error));
}

function platformLabel(value) {
  const text = String(value || "unknown");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizedIdentity(value = "") {
  return String(value || "").trim().toLowerCase();
}

function looksLikeServerUserId(value = "") {
  const text = normalizedIdentity(value);
  return /^[0-9a-f-]{16,}$/i.test(text) || /^[a-z0-9_-]{20,}$/i.test(text);
}

function shouldIgnoreWebhookUser(mediaUser = "", configuredUser = "", { strictName = false } = {}) {
  const incoming = normalizedIdentity(mediaUser);
  const configured = normalizedIdentity(configuredUser);
  if (!configured || !incoming) return false;
  if (incoming === configured) return false;
  if (strictName) return true;
  return looksLikeServerUserId(incoming);
}

async function handleConfig(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;

  if (req.method === "GET") {
    const runtime = await loadRuntimeState();
    return sendJson(res, {
      config: await loadMediaConfig(),
      history: await getSyncHistory(),
      lastCron: runtime.lastCronExecution || null,
      lastWebhook: runtime.lastWebhookReceived || null,
    });
  }

  if (req.method === "POST") {
    const config = await readJson(req);
    const errors = validateConfig(config);
    if (errors.length) return sendJson(res, { error: "Invalid configuration", details: errors }, 400);
    await saveMediaConfig(config);
    return sendJson(res, { ok: true });
  }

  return methodNotAllowed(res);
}

async function handleHistory(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const id = String(req.query.id || "");
  if (id) return sendJson(res, { row: await getWatchRecordById(id) });

  const statsMode = String(req.query.stats || "").toLowerCase();
  if (statsMode === "only") {
    return sendJson(res, { stats: await getWatchStats(requireDb()) });
  }

  const previewMode = String(req.query.preview || "").toLowerCase();
  if (["1", "true", "dashboard"].includes(previewMode)) {
    const [history, historyVersion] = await Promise.all([
      queryWatchHistoryPreview({ limit: req.query.limit || 120 }),
      getHistoryCacheVersion(),
    ]);
    return sendJson(res, { history, historyVersion }, 200, { "Cache-Control": "private, max-age=30, stale-while-revalidate=120", Vary: "Authorization" });
  }

  const includeStats = !["0", "false", "no"].includes(statsMode);
  const historyPromise = queryWatchHistory(requireDb(), { search: req.query.search || "", limit: req.query.limit || 50, offset: req.query.offset || 0 });
  const historyVersionPromise = getHistoryCacheVersion();

  if (!includeStats) {
    const [history, historyVersion] = await Promise.all([historyPromise, historyVersionPromise]);
    return sendJson(res, { history, historyVersion });
  }

  const [history, stats, historyVersion] = await Promise.all([
    historyPromise,
    getWatchStats(requireDb()),
    historyVersionPromise,
  ]);
  return sendJson(res, { history, stats, historyVersion });
}

async function handleSyncJobs(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const jobs = await querySyncJobs({
    limit: req.query.limit || 100,
    offset: req.query.offset || 0,
    status: req.query.status || "outstanding",
  });
  return sendJson(res, { jobs }, 200, { "Cache-Control": "private, max-age=15, stale-while-revalidate=60", Vary: "Authorization" });
}

async function handleSyncHistory(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const history = await getSyncHistory(req.query.limit || 100);
  return sendJson(res, { history }, 200, { "Cache-Control": "private, max-age=15, stale-while-revalidate=60", Vary: "Authorization" });
}

async function handleMovies(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const movies = await queryMovies({ search: req.query.search || "", sort: req.query.sort || "title_asc", limit: req.query.limit || 100, offset: req.query.offset || 0 });
  return sendJson(res, { movies }, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=300", Vary: "Authorization" });
}

async function handleShows(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const shows = await queryShows({ search: req.query.search || "", sort: req.query.sort || "title_asc", limit: req.query.limit || 6, offset: req.query.offset || 0 });
  return sendJson(res, { shows }, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=300", Vary: "Authorization" });
}

async function handleShow(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const id = String(req.query.id || "").trim();
  const title = String(req.query.title || "").trim();
  if (!id && !title) return sendJson(res, { error: "id or title is required" }, 400);
  const show = await queryShowDetail({ id, title });
  if (!show) return sendJson(res, { error: "not found" }, 404);
  return sendJson(res, { show }, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=300", Vary: "Authorization" });
}

function configuredRestoreTargets(config = {}) {
  const targets = [];
  if (!config.plex?.disabled && config.plex?.baseUrl && config.plex?.token) targets.push("plex");
  if (!config.emby?.disabled && config.emby?.baseUrl && config.emby?.apiKey && config.emby?.userId) targets.push("emby");
  if (!config.jellyfin?.disabled && config.jellyfin?.baseUrl && config.jellyfin?.apiKey && config.jellyfin?.userId) targets.push("jellyfin");
  return targets;
}

function emptyRestoreSummary(targets = []) {
  const summary = {};
  for (const target of targets) {
    summary[target] = { success: 0, skipped: 0, notFound: 0, error: 0 };
  }
  return summary;
}

function restoreClientFor(target, phase, config, media) {
  if (phase === "progress") {
    if (target === "plex") return () => setPlexProgress(config.plex, media);
    if (target === "emby") return () => setEmbyProgress(config.emby, media);
    if (target === "jellyfin") return () => setJellyfinProgress(config.jellyfin, media);
  }
  if (target === "plex") return () => markPlexPlayed(config.plex, media);
  if (target === "emby") return () => markEmbyPlayed(config.emby, media);
  if (target === "jellyfin") return () => markJellyfinPlayed(config.jellyfin, media);
  throw new Error(`Unknown restore target: ${target}`);
}

function applyRestoreResult(summary, target, result) {
  if (!summary[target]) summary[target] = { success: 0, skipped: 0, notFound: 0, error: 0 };
  if (result?.status === "not_found") {
    summary[target].notFound += 1;
  } else if (result?.status === "skipped") {
    summary[target].skipped += 1;
  } else {
    summary[target].success += 1;
  }
}

async function handleFullSyncWatchstates(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  const phase = String(body.phase || "watched") === "progress" ? "progress" : "watched";
  if (phase === "watched" && !watchedPlayedSyncEnabled()) {
    return sendJson(res, {
      ok: true,
      skipped: true,
      phase,
      processed: 0,
      hasMore: false,
      note: "Watched/played syncing is disabled.",
    });
  }
  const offset = Math.max(Number(body.offset || 0), 0);
  const limit = Math.min(Math.max(Number(body.limit || 25), 1), 100);
  const config = await loadMediaConfig();
  const targets = configuredRestoreTargets(config);
  const summary = emptyRestoreSummary(targets);
  const errors = [];

  if (!targets.length) {
    return sendJson(res, { ok: true, phase, offset, limit, processed: 0, nextOffset: offset, hasMore: false, targets, summary, errors, note: "No configured restore targets." });
  }

  const total = phase === "progress" ? await countPlaybackProgressRows() : await countWatchedPlaystateRows();
  const rows = phase === "progress"
    ? await listPlaybackProgressRowsForReplay({ limit, offset })
    : await listWatchedPlaystateRowsForReplay({ limit, offset });

  for (const row of rows) {
    for (const target of targets) {
      const media = phase === "progress" ? progressRowToMedia(row, target) : watchRowToMedia(row, target);
      if (!media.isValid) {
        summary[target].skipped += 1;
        continue;
      }
      try {
        const result = await restoreClientFor(target, phase, config, media)();
        applyRestoreResult(summary, target, result);
      } catch (error) {
        summary[target].error += 1;
        errors.push({
          target,
          rowId: row.id || row.media_key || "",
          title: row.title || "",
          detail: error?.message || String(error),
        });
      }
    }
  }

  const nextOffset = offset + rows.length;
  return sendJson(res, {
    ok: true,
    phase,
    offset,
    limit,
    total,
    processed: rows.length,
    nextOffset,
    hasMore: nextOffset < total,
    targets,
    summary,
    errors,
    note: total ? "" : "No Plembfin archive rows are available to restore.",
  });
}

async function handleImport(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const body = await readJson(req);
  const records = Array.isArray(body) ? body : body.records;
  if (!Array.isArray(records)) return sendJson(res, { error: "Expected an array of records" }, 400);
  if (records.length > 100) return sendJson(res, { error: "Batch size must be 100 records or fewer" }, 413);
  return sendJson(res, { ok: true, ...(await batchInsertWatchRecords(requireDb(), records)) });
}

function manualWatchMediaFromRecord(record = {}) {
  return {
    title: record.title,
    type: record.media_type,
    source: "manual",
    ids: {
      imdb: record.imdb_id || undefined,
      tmdb: record.tmdb_id || undefined,
      tvdb: record.tvdb_id || undefined,
    },
    season: record.season == null ? undefined : Number(record.season),
    episode: record.episode == null ? undefined : Number(record.episode),
    posterUrl: record.poster_url || undefined,
    isValid: Boolean(record.title && ["movie", "episode"].includes(record.media_type)),
  };
}

function mediaFromWatchRecord(record) {
  return {
    title: record.title,
    type: record.media_type,
    source: record.source || "manual",
    ids: {
      imdb: record.imdb_id || undefined,
      tmdb: record.tmdb_id || undefined,
      tvdb: record.tvdb_id || undefined,
    },
    season: record.season == null ? undefined : Number(record.season),
    episode: record.episode == null ? undefined : Number(record.episode),
    posterUrl: record.poster_url || undefined,
    isValid: Boolean(record.title && ["movie", "episode"].includes(record.media_type)),
  };
}

// Core of "mark unwatched": delete the watched record, write a superseding
// unwatched record, flip the playstate cache, and propagate unplayed to the other
// platforms. Shared by the webhook `unplayed` phase and the manual-unwatch handler.
async function applyManualUnwatch(media, config, loopStore) {
  const wasDeleted = await deleteWatchRecord(requireDb(), media, { skipInvalidate: true }).catch((error) => {
    console.error("Failed to delete watch record from Firestore", error);
    return false;
  });
  await deletePlaybackProgress(requireDb(), media).catch(() => null);

  const pendingSummary = { skipped: false, status: "pending", details: "Unwatched propagation queued", targetStates: [] };
  const unplayedRecord = mediaToWatchRecord({ ...media, syncAction: "unwatched" }, media.source);
  unplayedRecord.sync_action = "unwatched";
  unplayedRecord.sync_dispatch_telemetry = formatDispatchTelemetry(pendingSummary, media, "unwatched");
  const result = await insertWatchRecord(requireDb(), unplayedRecord, { skipInvalidate: true });
  await upsertPlaystateForMedia(requireDb(), media, "unwatched", result.record.watched_at, { skipInvalidate: true });

  const summary = await syncMediaUnplayedPlaystate(media, config, loopStore).catch((error) => ({
    skipped: false,
    status: "error",
    details: `Unwatched propagation failed: ${error.message || String(error)}`,
    targetStates: [],
  }));
  await updateWatchTelemetry(requireDb(), result.id, formatDispatchTelemetry(summary, media, "unwatched"), { skipInvalidate: true });
  await recordSyncHistory(media, summary, "unwatched");
  return { wasDeleted, id: result.id, summary };
}

async function handleManualUnwatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const id = String(body.id || "").trim();
  if (!id) return sendJson(res, { error: "id is required" }, 400);

  const record = await getWatchRecordById(id);
  if (!record) return sendJson(res, { error: "Watch record not found" }, 404);

  const media = mediaFromWatchRecord(record);
  const config = await loadMediaConfig();
  const loopStore = createLoopStore();

  try {
    const { id: unwatchedId, summary } = await applyManualUnwatch(media, config, loopStore);
    return sendJson(res, { ok: true, id: unwatchedId, status: summary.status, targetStates: summary.targetStates || [] });
  } catch (error) {
    console.error("Manual unwatch failed", error);
    return sendJson(res, { error: "Manual unwatch failed", details: error.message }, 500);
  } finally {
    await invalidateHistoryDerivedCaches().catch(() => null);
  }
}

async function handleManualWatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const records = Array.isArray(body) ? body : body.records;
  if (!Array.isArray(records)) return sendJson(res, { error: "Expected an array of records" }, 400);
  if (records.length > 100) return sendJson(res, { error: "Batch size must be 100 records or fewer" }, 413);

  const config = await loadMediaConfig();
  const loopStore = createLoopStore();
  const results = [];
  let inserted = 0;
  let skipped = 0;
  let rejected = 0;
  let propagated = 0;

  for (const [index, rawRecord] of records.entries()) {
    try {
      const pending = {
        ...rawRecord,
        source: rawRecord.source || "manual",
        sync_action: "watched",
        sync_dispatch_telemetry: "Origin: manual\nLoop-check: Passed\nDispatch status: pending\nDetails: Manual watch propagation queued.",
      };
      const { data, record } = watchRecordToFirestoreData(pending, "manual");
      const existing = await db
        .collection("watchHistory")
        .where("mediaKey", "==", data.mediaKey || mediaKeyFor(record))
        .where("watchedAt", "==", data.watchedAt)
        .limit(1)
        .get();

      const media = manualWatchMediaFromRecord(record);
      let id = "";
      if (existing.empty) {
        const insertResult = await insertWatchRecord(requireDb(), record, { skipInvalidate: true });
        id = insertResult.id;
        inserted += 1;
      } else {
        id = existing.docs[0].id;
        skipped += 1;
      }

      await upsertPlaystateForMedia(requireDb(), media, "watched", record.watched_at, { skipInvalidate: true });
      const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
        skipped: false,
        status: "error",
        details: `Manual watch propagation failed: ${error.message || String(error)}`,
        targetStates: [],
      }));

      await updateWatchTelemetry(requireDb(), id, formatDispatchTelemetry(summary, media, "watched"), { skipInvalidate: true });
      await recordSyncHistory(media, summary, "watched");
      if (summary.status === "success" || summary.status === "partial") propagated += 1;
      results.push({ index, id, title: record.title, inserted: existing.empty, status: summary.status, targetStates: summary.targetStates || [] });
    } catch (error) {
      rejected += 1;
      results.push({ index, rejected: true, error: error.message || String(error) });
    }
  }

  await invalidateHistoryDerivedCaches().catch(() => null);

  return sendJson(res, { ok: true, inserted, skipped, rejected, propagated, results });
}

async function handleRetrySync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const id = body.id;
  if (!id) return sendJson(res, { error: "Missing required field: id" }, 400);

  const record = await getWatchRecordById(id);
  if (!record) return sendJson(res, { error: "Watch record not found" }, 404);

  const config = await loadMediaConfig();
  const loopStore = createLoopStore();

  const media = mediaFromWatchRecord(record);

  const action = record.sync_action || "watched";
  let summary;
  try {
    if (action === "unwatched" || action === "unplayed") {
      summary = await syncMediaUnplayedPlaystate(media, config, loopStore);
    } else {
      summary = await syncMediaPlaystate(media, config, loopStore);
    }
  } catch (error) {
    console.error("Retry sync failed", error);
    summary = {
      skipped: false,
      status: "error",
      details: `Retry sync failed: ${error.message || String(error)}`,
      targetStates: [],
    };
  }

  await updateWatchTelemetry(requireDb(), id, formatDispatchTelemetry(summary, media, action));
  await recordSyncHistory(media, summary, action);

  return sendJson(res, { ok: true, status: summary.status, targetStates: summary.targetStates || [] });
}

async function handleNowPlaying(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const [cacheRows, activeRows, runtime] = await Promise.all([
    loadLiveTrackingCache(requireDb(), { includeCompleted: false }).catch(() => []),
    listActiveSessions().catch(() => []),
    loadRuntimeState(),
  ]);

  const sessions = cacheRows.map(hydrateCachedSession).filter((session) => !session.completedAt);
  const merged = [...sessions];
  for (const active of activeRows) {
    const isDuplicate = merged.some(
      (s) =>
        s.source === active.source &&
        s.title === active.title &&
        s.season === active.season &&
        s.episode === active.episode
    );
    if (!isDuplicate) {
      merged.push({
        sessionId: active.key,
        source: active.source,
        title: active.title,
        mediaType: active.mediaType,
        progress: active.progress,
        offsetMs: active.offsetMs || 0,
        durationMs: active.durationMs || 0,
        season: active.season,
        episode: active.episode,
        posterUrl: active.posterUrl,
        ids: active.ids,
        client: active.client,
        updatedAt: active.updatedAt,
        completedAt: null,
      });
    }
  }
  merged.sort((a, b) => b.updatedAt - a.updatedAt);

  return sendJson(res, merged, 200, runtime.nowPlayingRefresh ? { "X-Now-Playing-Refresh": String(runtime.nowPlayingRefresh) } : {});
}

async function handleActiveSessions(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  return sendJson(res, { sessions: await listActiveSessions() });
}

async function handleCronSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res);

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.write("Cron Sync started...\n");

  const admin = await requireAdminStreaming(req, res);
  if (!admin) return;

  const logger = (msg) => {
    res.write(`${msg}\n`);
    console.log(msg);
  };

  try {
    const result = await runScheduledSync(logger);
    res.write(`RESULT: ${JSON.stringify(result)}\n`);
    res.end();
  } catch (error) {
    logger(`ERROR: Cron Sync failed: ${error.message}`);
    res.end();
  }
}

async function handleForceSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res);

  // GET: poll for current status and log lines stored in Firestore runtimeState
  if (req.method === "GET") {
    if (!(await requireAdmin(req, res))) return;
    const runtime = await loadRuntimeState();
    return sendJson(res, {
      active: runtime.forceSyncActive === true,
      log: Array.isArray(runtime.forceSyncLog) ? runtime.forceSyncLog : [],
      result: runtime.forceSyncResult || null,
      startedAt: runtime.forceSyncStartedAt || null,
    });
  }

  // POST: fire-and-forget — return 202 immediately, run in background
  if (!(await requireAdmin(req, res))) return;

  const runtime = await loadRuntimeState();
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  if (runtime.forceSyncActive === true && runtime.forceSyncStartedAt && runtime.forceSyncStartedAt > tenMinutesAgo) {
    return sendJson(res, { ok: false, error: "Another force sync job is already running." }, 409);
  }

  // Clear the previous log and mark as active before returning
  await setRuntimeState({
    forceSyncLog: ["Force Sync started..."],
    forceSyncResult: null,
    forceSyncActive: true,
    forceSyncStartedAt: Date.now(),
    forceSyncCancelRequested: false,
  });

  // Batch log writes: collect lines in memory, flush to Firestore every 3s.
  // This avoids per-line Firestore writes (Firestore sustains ~1 write/sec per doc).
  const logBuffer = [];
  let flushTimer = null;

  const flushLog = async () => {
    if (!logBuffer.length) return;
    const batch = logBuffer.splice(0, logBuffer.length);
    await setRuntimeState({ forceSyncLog: FieldValue.arrayUnion(...batch) }).catch(() => null);
  };

  const logLine = (msg) => {
    console.log(msg);
    logBuffer.push(msg);
    if (!flushTimer) {
      flushTimer = setTimeout(async () => {
        flushTimer = null;
        await flushLog();
      }, 3000);
    }
  };

  // Kick off in background — HTTP response returned below without awaiting this
  Promise.resolve().then(async () => {
    try {
      const result = await runForceSync(logLine, { lockAlreadyClaimed: true });
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      await flushLog(); // flush any remaining lines
      await setRuntimeState({
        forceSyncActive: false,
        forceSyncResult: result,
        forceSyncLog: FieldValue.arrayUnion(`RESULT: ${JSON.stringify(result)}`),
      }).catch(() => null);
    } catch (error) {
      const msg = `ERROR: Force Sync failed: ${error.message}`;
      console.error(msg);
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      await flushLog();
      await setRuntimeState({
        forceSyncActive: false,
        forceSyncResult: { success: false, error: error.message },
        forceSyncLog: FieldValue.arrayUnion(msg),
      }).catch(() => null);
    }
  });

  return sendJson(res, { ok: true, started: true, message: "Force Sync started. Poll GET /api/force-sync for status." }, 202);
}



async function handleStopForceSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  try {
    await setRuntimeState({ forceSyncCancelRequested: true });
    return sendJson(res, { ok: true, message: "Cancellation request received." });
  } catch (error) {
    return sendJson(res, { ok: false, error: error.message }, 500);
  }
}




async function handleWebhook(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);

  let media;
  try {
    media = await normalizeWebhook(req);
  } catch (error) {
    console.error("Webhook body parsing failed", error);
    return sendJson(res, { error: "Invalid webhook body", details: error.message }, 400);
  }

  await setRuntimeState({
    lastWebhookReceived: {
      timestamp: Date.now(),
      source: media.source || "unknown",
      title: media.title || "unknown",
      event: media.event || "unknown",
      phase: media.phase || "unknown",
      isValid: Boolean(media.isValid),
    },
  }).catch(() => null);

  if (!media.isValid) {
    return sendJson(res, {
      ok: true,
      inserted: false,
      skipped: true,
      reason: "Unsupported event or missing provider IDs",
      debug: media.rawPayloadDebug,
    });
  }

  const config = await loadMediaConfig();
  const loopStore = createLoopStore();
  media.posterUrl = posterPathFromMedia(media);

  if (config) {
    if (config[media.source]?.disabled) {
      return sendJson(res, { ok: true, ignored: true, reason: "Source platform is disabled" });
    }
    if (media.source === "plex" && shouldIgnoreWebhookUser(media.user, config.plex?.username, { strictName: true })) {
      return sendJson(res, { ok: true, ignored: true, reason: "User mismatch" });
    }
    if (media.source === "emby" && shouldIgnoreWebhookUser(media.user, config.emby?.userId)) {
      return sendJson(res, { ok: true, ignored: true, reason: "User mismatch" });
    }
    if (media.source === "jellyfin" && shouldIgnoreWebhookUser(media.user, config.jellyfin?.userId)) {
      return sendJson(res, { ok: true, ignored: true, reason: "User mismatch" });
    }
  }

  if (media.type === "season" || media.type === "series") {
    console.log(`Processing ${media.type} webhook sync from ${media.source}`, {
      title: media.title,
      itemId: media.itemId,
      phase: media.phase,
    });

    let episodes = [];
    try {
      if (media.source === "jellyfin") {
        const { fetchJellyfinEpisodes } = await import("./utils/jellyfinClient.js");
        episodes = await fetchJellyfinEpisodes(config.jellyfin, media.itemId);
      } else if (media.source === "emby") {
        const { fetchEmbyEpisodes } = await import("./utils/embyClient.js");
        episodes = await fetchEmbyEpisodes(config.emby, media.itemId);
      }
    } catch (error) {
      console.error(`Failed to fetch child episodes for ${media.type} ${media.itemId}`, error);
      return sendJson(res, { error: `Failed to fetch episodes for ${media.type}`, details: error.message }, 500);
    }

    console.log(`Found ${episodes.length} episodes under ${media.type} ${media.itemId}`);

    const results = [];
    const targetPlayed = media.phase === "completed";

    const filteredEpisodes = episodes.filter((ep) => {
      const isPlayed = ep.UserData?.Played === true;
      return targetPlayed ? isPlayed : !isPlayed;
    });

    console.log(`Syncing ${filteredEpisodes.length} episodes with target played state: ${targetPlayed}`);

    await Promise.all(
      filteredEpisodes.map(async (ep) => {
        try {
          const episodeMedia = {
            title: `${ep.SeriesName || media.title || "Unknown Show"} - S${String(ep.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(ep.IndexNumber ?? "?").padStart(2, "0")}`,
            type: "episode",
            source: media.source,
            ids: normalizeProviderIds(ep.ProviderIds),
            season: ep.ParentIndexNumber,
            episode: ep.IndexNumber,
            event: media.event,
            phase: media.phase,
            user: media.user,
            isValid: true,
          };
          episodeMedia.posterUrl = posterPathFromMedia(episodeMedia);

          if (media.phase === "unplayed") {
            await deleteActiveSession(null, episodeMedia).catch(() => null);
            const wasDeleted = await deleteWatchRecord(requireDb(), episodeMedia, { skipInvalidate: true }).catch((error) => {
              console.error("Failed to delete watch record from Firestore", error);
              return false;
            });
            await deletePlaybackProgress(requireDb(), episodeMedia).catch(() => null);
            const pendingSummary = { skipped: false, status: "pending", details: "Unwatched propagation queued", targetStates: [] };
            const unplayedRecord = mediaToWatchRecord({ ...episodeMedia, syncAction: "unwatched" }, episodeMedia.source);
            unplayedRecord.sync_action = "unwatched";
            unplayedRecord.sync_dispatch_telemetry = formatDispatchTelemetry(pendingSummary, episodeMedia, "unwatched");
            const dbResult = await insertWatchRecord(requireDb(), unplayedRecord, { skipInvalidate: true });
            await upsertPlaystateForMedia(requireDb(), episodeMedia, "unwatched", dbResult.record.watched_at, { skipInvalidate: true });
            const summary = await syncMediaUnplayedPlaystate(episodeMedia, config, loopStore).catch((error) => ({
              skipped: false,
              status: "error",
              details: `Unwatched propagation failed: ${error.message || String(error)}`,
              targetStates: [],
            }));
            await updateWatchTelemetry(requireDb(), dbResult.id, formatDispatchTelemetry(summary, episodeMedia, "unwatched"), { skipInvalidate: true });
            await recordSyncHistory(episodeMedia, summary, "unwatched");
            results.push({ episodeId: ep.Id, title: episodeMedia.title, success: summary.status === "success" || summary.status === "partial" });
          } else {
            await deleteActiveSession(null, episodeMedia).catch(() => null);
            const watchRecord = mediaToWatchRecord(episodeMedia, episodeMedia.source);
            watchRecord.sync_action = "watched";
            watchRecord.sync_dispatch_telemetry = formatDispatchTelemetry({ skipped: false, status: "pending", details: "Propagation queued", targetStates: [] }, episodeMedia, "watched");
            const dbResult = await insertWatchRecord(requireDb(), watchRecord, { skipInvalidate: true });
            await upsertPlaystateForMedia(requireDb(), episodeMedia, "watched", dbResult.record.watched_at, { skipInvalidate: true });
            const summary = await syncMediaPlaystate(episodeMedia, config, loopStore).catch((error) => ({
              skipped: false,
              status: "error",
              details: `Propagation failed: ${error.message || String(error)}`,
              targetStates: [],
            }));
            await updateWatchTelemetry(requireDb(), dbResult.id, formatDispatchTelemetry(summary, episodeMedia, "watched"), { skipInvalidate: true });
            await recordSyncHistory(episodeMedia, summary, "watched");
            await deletePlaybackProgress(requireDb(), episodeMedia).catch(() => null);
            results.push({ episodeId: ep.Id, title: episodeMedia.title, success: summary.status === "success" || summary.status === "partial" });
          }
        } catch (err) {
          console.error(`Failed to sync episode ${ep.Id} / ${ep.Name}`, err);
          results.push({ episodeId: ep.Id, success: false, error: err.message });
        }
      })
    );

    await invalidateHistoryDerivedCaches().catch(() => null);

    return sendJson(res, {
      ok: true,
      batch: true,
      total: filteredEpisodes.length,
      results,
    });
  }

  if (media.phase === "active") {
    await upsertActiveSession(null, media);
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    return sendJson(res, { ok: true, active: true, inserted: false, propagated: false, title: media.title, source: media.source });
  }

  if (media.phase === "ended") {
    await deleteActiveSession(null, media);
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    let progressSummary = { skipped: true, status: "skipped", details: "Resume progress is not actionable", targetStates: [] };
    if (shouldSyncResumeProgress(media)) {
      const progressRecord = mediaToPlaybackProgressRecord(media, media.source);
      await upsertPlaybackProgress(requireDb(), {
        ...progressRecord,
        sync_dispatch_telemetry: formatProgressTelemetry({ skipped: false, status: "pending", details: "Resume propagation queued", targetStates: [] }, media),
      }).catch((error) => console.error("Failed to store resume progress in Firestore", error));
      progressSummary = await syncMediaProgress(media, config, loopStore).catch((error) => ({
        skipped: false,
        status: "error",
        details: `Resume propagation failed: ${error.message || String(error)}`,
        targetStates: [],
      }));
      await updatePlaybackProgressTelemetry(requireDb(), progressRecord, formatProgressTelemetry(progressSummary, media)).catch(() => null);
      await recordSyncHistory(media, progressSummary, "progress");
    }
    return sendJson(res, {
      ok: true,
      active: false,
      inserted: false,
      propagated: progressSummary.status === "success" || progressSummary.status === "partial",
      reason: "Playback ended below watched threshold",
      resumeProgress: { status: progressSummary.status, details: progressSummary.details },
    });
  }

  if (media.phase === "unplayed") {
    try {
      await deleteActiveSession(null, media);
      await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
      const { wasDeleted, id } = await applyManualUnwatch(media, config, loopStore);
      return sendJson(res, { ok: true, deleted: wasDeleted, unplayed: true, inserted: true, id, ...(wasDeleted ? {} : { reason: "No previous watched record found to delete" }) });
    } finally {
      await invalidateHistoryDerivedCaches().catch(() => null);
    }
  }

  try {
    await deleteActiveSession(null, media);
    const watchRecord = mediaToWatchRecord(media, media.source);
    watchRecord.sync_action = "watched";
    watchRecord.sync_dispatch_telemetry = formatDispatchTelemetry({ skipped: false, status: "pending", details: "Propagation queued", targetStates: [] }, media, "watched");
    const result = await insertWatchRecord(requireDb(), watchRecord, { skipInvalidate: true });
    await upsertPlaystateForMedia(requireDb(), media, "watched", result.record.watched_at, { skipInvalidate: true });
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
      skipped: false,
      status: "error",
      details: `Propagation failed: ${error.message || String(error)}`,
      targetStates: [],
    }));
    await updateWatchTelemetry(requireDb(), result.id, formatDispatchTelemetry(summary, media, "watched"), { skipInvalidate: true });
    await recordSyncHistory(media, summary, "watched");
    await deletePlaybackProgress(requireDb(), media).catch(() => null);
    await invalidateHistoryDerivedCaches().catch(() => null);
    return sendJson(res, { ok: true, inserted: true, id: result.id, record: result.record });
  } catch (error) {
    console.error("Webhook Firestore insert failed", error);
    await invalidateHistoryDerivedCaches().catch(() => null);
    return sendJson(res, { error: "Webhook insert failed", details: error.message }, 500);
  }
}

async function handleTestConnection(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const body = await readJson(req);
  const started = Date.now();
  const type = String(body.type || "").toLowerCase();
  const baseUrl = String(body.url || body.baseUrl || "").replace(/\/+$/, "");
  const token = String(body.token || body.apiKey || "");
  if (!type || !baseUrl || !token) return sendJson(res, { ok: false, error: "type, url, and token are required" }, 400);

  try {
    let response;
    if (type === "plex") {
      const url = new URL(`${baseUrl}/identity`);
      url.searchParams.set("X-Plex-Token", token);
      response = await fetch(url, { headers: { Accept: "application/json, application/xml, text/xml" } });
    } else if (type === "emby" || type === "jellyfin") {
      const url = new URL(`${baseUrl}/System/Info/Public`);
      response = await fetch(url, { headers: { Accept: "application/json", "X-Emby-Token": token, "X-MediaBrowser-Token": token } });
    } else {
      return sendJson(res, { ok: false, error: "Unsupported connection type" }, 400);
    }
    if (!response.ok) return sendJson(res, { ok: false, error: `Connection failed with HTTP ${response.status}`, elapsedMs: Date.now() - started }, 502);
    return sendJson(res, { ok: true, detail: "Server identity verified", elapsedMs: Date.now() - started });
  } catch (error) {
    return sendJson(res, { ok: false, error: error.message, elapsedMs: Date.now() - started }, 502);
  }
}

async function handlePoster(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const cacheHeaders = { "Cache-Control": "private, max-age=3600, stale-while-revalidate=86400" };

  try {
    const rowId = String(req.query.id || "");
    const row = await getWatchRecordByIdLight(rowId);
    if (!row) return sendJson(res, { error: "not found" }, 404);

    const fallbackRequested = ["1", "true", "yes"].includes(String(req.query.fallback || "").toLowerCase());
    const config = await loadMediaConfig().catch(() => ({}));
    const mediaKey = row.media_key || mediaKeyFor(row);
    const cached = usableCachedPoster(await getPosterCache(mediaKey));
    if (cached?.url || cached?.cached) return sendJson(res, cached, 200, cacheHeaders);

    if (row.poster_url && !fallbackRequested && isCachedStorageUrl(row.poster_url)) {
      return sendJson(res, { url: row.poster_url, cached: true, source: "storage" }, 200, cacheHeaders);
    }

    const candidates = [];
    if (row.poster_url && !fallbackRequested) {
      if (/^https?:\/\//i.test(row.poster_url)) candidates.push({ url: row.poster_url, source: "stored" });
      const configuredUrl = configuredPosterUrl(row.poster_url, row.source, config);
      if (configuredUrl) candidates.push({ url: configuredUrl, source: configForPosterSource(config, row.source).source || "configured" });
    }

    if (String(row.source || "").toLowerCase().includes("plex") && config.plex?.baseUrl && config.plex?.token) {
      const item = await findPlexItem(config.plex, {
        title: row.title,
        type: row.media_type,
        ids: { imdb: row.imdb_id || null, tmdb: row.tmdb_id || null, tvdb: row.tvdb_id || null },
        season: row.season || null,
        episode: row.episode || null,
      }).catch((error) => {
        console.error("Poster Plex lookup failed", { id: row.id, title: row.title, error: error.message || String(error) });
        return null;
      });
      const path = row.media_type === "episode"
        ? item?.grandparentThumb || item?.parentThumb || item?.thumb || item?.grandparentArt || item?.parentArt || item?.art || ""
        : item?.thumb || item?.parentThumb || item?.grandparentThumb || item?.art || item?.parentArt || item?.grandparentArt || "";
      if (path) {
        const configuredUrl = configuredPosterUrl(path, "plex", config);
        if (configuredUrl) candidates.push({ url: configuredUrl, source: "plex" });
      }
    }

    if (row.poster_url) {
      const configuredUrl = configuredPosterUrl(row.poster_url, row.source, config);
      if (configuredUrl && !fallbackRequested) candidates.push({ url: configuredUrl, source: configForPosterSource(config, row.source).source || "configured" });
    }

    if (config.tmdb?.apiKey && (fallbackRequested || !row.poster_url || isHttpUrl(row.poster_url) || !/^https?:\/\//i.test(row.poster_url))) {
      const tmdbPoster = await fetchPosterFromTmdb(row, config.tmdb.apiKey).catch((error) => {
        console.error("Poster TMDB fallback failed", { id: row.id, title: row.title, error: error.message || String(error) });
        return null;
      });
      if (tmdbPoster) {
        candidates.push({ url: tmdbPoster, source: "tmdb" });
      }
    }

    const seen = new Set();
    for (const candidate of candidates) {
      if (!candidate.url || seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      const cachedPoster = await cachePosterFromUrl(mediaKey, candidate.url, candidate.source);
      if (cachedPoster?.url) {
        await updateWatchPosterUrl(rowId, cachedPoster.url).catch((error) => {
          console.error("Failed to persist cached poster URL", { id: row.id, title: row.title, error: error.message || String(error) });
        });
        return sendJson(res, cachedPoster, 200, cacheHeaders);
      }
    }

    await markPosterMissing(mediaKey, "poster", "No usable poster candidate").catch(() => null);
    return sendJson(res, { url: null, cached: true, source: "missing" }, 200, cacheHeaders);
  } catch (error) {
    console.error("Poster lookup failed", { id: String(req.query.id || ""), error: error.message || String(error) });
    return sendJson(res, { url: null, cached: false, source: "error" }, 200, cacheHeaders);
  }
}

async function handleBackfillStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  if (req.method !== "GET") return methodNotAllowed(res);

  try {
    const snapshot = await db.collection("watchHistory")
      .where("source", "==", "trakt_import")
      .where("posterUrl", "==", null)
      .count()
      .get();
    const count = snapshot.data().count;
    return sendJson(res, { remaining: count, missing: count });
  } catch (error) {
    console.error("Failed to get backfill status", error);
    return sendJson(res, { error: "Failed to get backfill status", details: error.message }, 500);
  }
}

async function handleBackfillTrakt(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  if (req.method !== "POST") return methodNotAllowed(res);

  try {
    const config = await loadMediaConfig();
    const tmdbApiKey = config.tmdb?.apiKey;
    if (!tmdbApiKey) {
      return sendJson(res, { error: "TMDB API Key is not configured in Settings" }, 400);
    }

    const body = await readJson(req).catch(() => ({}));
    const limit = Math.min(Math.max(Number(body.limit || 50), 1), 100);

    const snapshot = await db.collection("watchHistory")
      .where("source", "==", "trakt_import")
      .where("posterUrl", "==", null)
      .limit(limit)
      .get();

    if (snapshot.empty) {
      return sendJson(res, { ok: true, tried: 0, backfilled: 0, msg: "No missing poster rows remaining." });
    }

    let tried = 0;
    let backfilled = 0;

    for (const doc of snapshot.docs) {
      tried++;
      const data = doc.data() || {};
      const rowMapped = {
        title: data.title,
        media_type: data.mediaType,
        imdb_id: data.ids?.imdb,
        tmdb_id: data.ids?.tmdb,
        tvdb_id: data.ids?.tvdb,
        season: data.season,
        episode: data.episode,
      };

      const posterUrl = await fetchPosterFromTmdb(rowMapped, tmdbApiKey);
      if (posterUrl) {
        await doc.ref.update({
          posterUrl: posterUrl,
          updatedAt: FieldValue.serverTimestamp(),
        });
        backfilled++;
      } else {
        await doc.ref.update({
          posterUrl: "none",
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    if (tried) await invalidateHistoryDerivedCaches().catch(() => null);
    return sendJson(res, { ok: true, tried, backfilled });
  } catch (error) {
    console.error("Trakt backfill execution failed", error);
    return sendJson(res, { error: "Trakt backfill execution failed", details: error.message }, 500);
  }
}

async function handleAdminFixHistory(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  try {
    const config = await loadMediaConfig().catch(() => ({}));
    const limit = 10;
    let converted = 0;
    let backfilled = 0;
    let retyped = 0;

    // Get recently watched items (we can fetch up to 300 to find ones needing processing)
    const snapshot = await db.collection("watchHistory")
      .orderBy("watchedAt", "desc")
      .limit(300)
      .get();

    const candidates = [];
    for (const doc of snapshot.docs) {
      const data = doc.data() || {};
      const posterUrl = data.posterUrl || "";
      const isOptimized = isCachedStorageUrl(posterUrl);
      const needsRetype = !data.mediaType;

      if (!isOptimized || needsRetype) {
        candidates.push({ id: doc.id, data });
      }
      if (candidates.length >= limit) break;
    }

    if (candidates.length === 0) {
      return sendJson(res, {
        ok: true,
        retyped: 0,
        converted: 0,
        backfilled: 0,
        note: "All checked history rows already have optimized posters.",
      });
    }

    for (const candidate of candidates) {
      const { id, data } = candidate;
      const row = await getWatchRecordByIdLight(id);
      if (!row) continue;

      const mediaKey = row.media_key || mediaKeyFor(row);

      // 1. If needs retype:
      if (!row.media_type) {
        const isEpisode = /s\d+e\d+/i.test(row.title || "");
        const newType = isEpisode ? "episode" : "movie";
        await db.collection("watchHistory").doc(id).update({
          mediaType: newType,
          updatedAt: FieldValue.serverTimestamp(),
        });
        retyped++;
        row.media_type = newType;
      }

      // 2. Fetch/optimize poster:
      const cached = usableCachedPoster(await getPosterCache(mediaKey));
      if (cached?.url) {
        const updated = await updateWatchPosterUrl(id, cached.url);
        if (updated) converted++;
        continue;
      }

      const urlsToTry = [];
      if (row.poster_url && !isCachedStorageUrl(row.poster_url)) {
        if (/^https?:\/\//i.test(row.poster_url)) urlsToTry.push({ url: row.poster_url, source: "stored" });
        const configuredUrl = configuredPosterUrl(row.poster_url, row.source, config);
        if (configuredUrl) urlsToTry.push({ url: configuredUrl, source: "configured" });
      }

      if (String(row.source || "").toLowerCase().includes("plex") && config.plex?.baseUrl && config.plex?.token) {
        const item = await findPlexItem(config.plex, {
          title: row.title,
          type: row.media_type,
          ids: { imdb: row.imdb_id || null, tmdb: row.tmdb_id || null, tvdb: row.tvdb_id || null },
          season: row.season || null,
          episode: row.episode || null,
        }).catch(() => null);
        const path = row.media_type === "episode"
          ? item?.grandparentThumb || item?.parentThumb || item?.thumb
          : item?.thumb || item?.parentThumb;
        if (path) {
          const configuredUrl = configuredPosterUrl(path, "plex", config);
          if (configuredUrl) urlsToTry.push({ url: configuredUrl, source: "plex" });
        }
      }

      if (config.tmdb?.apiKey && (!row.poster_url || isHttpUrl(row.poster_url) || !/^https?:\/\//i.test(row.poster_url))) {
        const tmdbPoster = await fetchPosterFromTmdb(row, config.tmdb.apiKey).catch(() => null);
        if (tmdbPoster) {
          urlsToTry.push({ url: tmdbPoster, source: "tmdb" });
        }
      }

      const seen = new Set();
      let succeeded = false;
      for (const candidateUrl of urlsToTry) {
        if (!candidateUrl.url || seen.has(candidateUrl.url)) continue;
        seen.add(candidateUrl.url);
        const cachedPoster = await cachePosterFromUrl(mediaKey, candidateUrl.url, candidateUrl.source);
        if (cachedPoster?.url) {
          await updateWatchPosterUrl(id, cachedPoster.url);
          backfilled++;
          succeeded = true;
          break;
        }
      }

      if (!succeeded) {
        await markPosterMissing(mediaKey, "repair", "Failed to resolve poster on repair pass").catch(() => null);
      }
    }

    await invalidateHistoryDerivedCaches().catch(() => null);

    return sendJson(res, {
      ok: true,
      retyped,
      converted,
      backfilled,
      note: `Processed ${candidates.length} candidate rows.`,
    });
  } catch (error) {
    console.error("History repair pass failed", error);
    return sendJson(res, { error: "Repair failed", details: error.message }, 500);
  }
}

async function handleMaintenanceStub(req, res, name) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res);
  if (name === "admin-backfill-status") return sendJson(res, { remaining: 0, missing: 0 });
  return sendJson(res, {
    ok: true,
    retyped: 0,
    converted: 0,
    backfilled: 0,
    tried: 0,
    note: "This Firebase fresh-start repo does not include Cloudflare-era maintenance repair jobs.",
  });
}

async function handleDedupHistory(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.write("Dedup started...\n");

  const log = (msg) => { res.write(`${msg}\n`); console.log(msg); };

  try {
    log("Loading all watchHistory records...");
    const snapshot = await db.collection("watchHistory").get();
    log(`Loaded ${snapshot.size} total records.`);

    // Group docs by mediaKey
    const groups = new Map();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const key = data.mediaKey || doc.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ id: doc.id, ref: doc.ref, watchedAt: data.watchedAt || data.watched_at || "" });
    }

    log(`Found ${groups.size} unique media keys.`);

    let deleted = 0;
    let checked = 0;
    const batch_size = 400;
    let batch = db.batch();
    let batchCount = 0;

    for (const [key, docs] of groups.entries()) {
      if (docs.length <= 1) continue;

      // Sort newest first
      docs.sort((a, b) => (b.watchedAt > a.watchedAt ? 1 : b.watchedAt < a.watchedAt ? -1 : 0));
      const [keep, ...remove] = docs;

      for (const dup of remove) {
        batch.delete(dup.ref);
        batchCount++;
        deleted++;

        if (batchCount >= batch_size) {
          await batch.commit();
          batch = db.batch();
          batchCount = 0;
        }
      }

      checked++;
      if (checked % 50 === 0) {
        log(`Processed ${checked} duplicate groups, ${deleted} deletions queued so far...`);
      }
    }

    if (batchCount > 0) await batch.commit();

    const summary = { scanned: snapshot.size, uniqueKeys: groups.size, deleted };
    log(`Done! Scanned ${summary.scanned} records, found ${summary.uniqueKeys} unique items, deleted ${summary.deleted} duplicates.`);
    res.write(`RESULT: ${JSON.stringify(summary)}\n`);
    res.end();
  } catch (error) {
    log(`ERROR: Dedup failed: ${error.message}`);
    res.end();
  }
}

async function handleTmdbDetails(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const mediaType = String(req.query.mediaType || req.query.type || "").trim().toLowerCase();
  let tmdbId = String(req.query.tmdbId || req.query.id || "").trim();
  const title = String(req.query.title || "").trim();

  if (!mediaType || (!tmdbId && !title)) {
    return sendJson(res, { error: "mediaType and either tmdbId or title are required" }, 400);
  }

  const config = await loadMediaConfig();
  const apiKey = config.tmdb?.apiKey;
  if (!apiKey) {
    return sendJson(res, { error: "TMDB API key is not configured" }, 400);
  }

  try {
    // 1. Resolve tmdbId if not provided
    if (!tmdbId && title) {
      const titleKey = `title_${mediaType}_${canonicalTitleKey(title)}`;
      const titleDoc = await db.collection("tmdbMetadataCache").doc(titleKey).get();
      if (titleDoc.exists) {
        tmdbId = titleDoc.data()?.tmdbId;
      }

      if (!tmdbId) {
        const searchType = mediaType === "movie" ? "movie" : "tv";
        const searchRes = await fetch(`https://api.themoviedb.org/3/search/${searchType}?api_key=${apiKey}&query=${encodeURIComponent(title)}`);
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          tmdbId = String(searchData.results?.[0]?.id || "");
          if (tmdbId) {
            await db.collection("tmdbMetadataCache").doc(titleKey).set({
              tmdbId,
              title,
              mediaType,
              updatedAt: Date.now()
            });
          }
        }
      }
    }

    if (!tmdbId) {
      return sendJson(res, { error: "Could not resolve TMDB ID" }, 404);
    }

    // 2. Fetch or load from cache
    const docKey = `${mediaType}_${tmdbId}`;
    const docRef = db.collection("tmdbMetadataCache").doc(docKey);
    const cachedDoc = await docRef.get();
    const existingDetails = cachedDoc.exists ? cachedDoc.data().details : null;

    if (cachedDoc.exists) {
      const data = cachedDoc.data();
      if (data.updatedAt && (Date.now() - data.updatedAt < tmdbCacheTtlMs(existingDetails))) {
        return sendJson(res, data.details, 200, { "Cache-Control": "private, max-age=86400" });
      }
    }

    // Fetch fresh details
    const detailsType = mediaType === "movie" ? "movie" : "tv";
    const detailsUrl = `https://api.themoviedb.org/3/${detailsType}/${tmdbId}?api_key=${apiKey}&append_to_response=credits,videos,reviews,similar`;
    const detailsRes = await fetch(detailsUrl);
    if (!detailsRes.ok) {
      if (cachedDoc.exists) {
        return sendJson(res, cachedDoc.data().details, 200);
      }
      return sendJson(res, { error: `TMDB details fetch failed: ${detailsRes.statusText}` }, detailsRes.status);
    }

    // Merge fresh data into the cached object rather than overwriting, so volatile
    // fields (next_episode_to_air, status, episode counts) update while any
    // sub-resources this fetch didn't request are preserved.
    const merged = mergeTmdbDetails(existingDetails, await detailsRes.json());
    // TMDB's next_episode_to_air is unreliable; derive a dependable next-airing
    // date from the season episode list so the list view matches the detail page.
    if (mediaType === "tv") {
      const nextAiring = await computeTvNextAiringDate(merged, tmdbId, apiKey);
      if (nextAiring) merged.next_airing_date = nextAiring;
      else delete merged.next_airing_date;
    }
    await docRef.set({
      tmdbId,
      mediaType,
      details: merged,
      updatedAt: Date.now()
    });

    return sendJson(res, merged, 200, { "Cache-Control": "private, max-age=86400" });
  } catch (error) {
    console.error("Failed handling TMDB details API", error);
    return sendJson(res, { error: "Failed to fetch TMDB details", details: error.message }, 500);
  }
}

async function handleTmdbPerson(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const personId = String(req.query.id || "").trim();
  if (!personId) {
    return sendJson(res, { error: "Person ID is required" }, 400);
  }

  const config = await loadMediaConfig();
  const apiKey = config.tmdb?.apiKey;
  if (!apiKey) {
    return sendJson(res, { error: "TMDB API key is not configured" }, 400);
  }

  try {
    const docKey = `person_${personId}`;
    const docRef = db.collection("tmdbPersonCache").doc(docKey);
    const cachedDoc = await docRef.get();

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    // Bumped when the fetched shape changes (added tagged_images for the photo
    // gallery). Entries cached under an older schema are refetched immediately
    // rather than waiting out the 7-day TTL.
    const PERSON_SCHEMA_VERSION = 2;
    if (cachedDoc.exists) {
      const data = cachedDoc.data();
      const fresh = data.updatedAt && (Date.now() - data.updatedAt < sevenDaysMs);
      if (fresh && data.schemaVersion >= PERSON_SCHEMA_VERSION) {
        return sendJson(res, data.details, 200, { "Cache-Control": "private, max-age=86400" });
      }
    }

    const personRes = await fetch(`https://api.themoviedb.org/3/person/${personId}?api_key=${apiKey}&append_to_response=combined_credits,images,tagged_images`);
    if (!personRes.ok) {
      if (cachedDoc.exists) {
        return sendJson(res, cachedDoc.data().details, 200);
      }
      return sendJson(res, { error: `TMDB person fetch failed: ${personRes.statusText}` }, personRes.status);
    }

    const personData = await personRes.json();

    await docRef.set({
      personId,
      details: personData,
      schemaVersion: PERSON_SCHEMA_VERSION,
      updatedAt: Date.now()
    });

    return sendJson(res, personData, 200, { "Cache-Control": "private, max-age=86400" });
  } catch (error) {
    console.error("Failed handling TMDB person API", error);
    return sendJson(res, { error: "Failed to fetch TMDB person details", details: error.message }, 500);
  }
}


async function handleUpdateWatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "PATCH" && req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const id = String(body.id || "").trim();
  if (!id) return sendJson(res, { error: "id is required" }, 400);

  const fields = {};
  if (body.watched_at !== undefined) fields.watched_at = body.watched_at;
  if (body.poster_url !== undefined) fields.poster_url = body.poster_url;
  if (body.tmdb_id !== undefined) fields.tmdb_id = body.tmdb_id;
  if (body.title !== undefined) fields.title = body.title;
  if (body.youtube_url !== undefined) fields.youtube_url = body.youtube_url;

  const result = await updateWatchRecord(id, fields);
  if (!result.ok) return sendJson(res, { error: result.error }, 400);

  // If TMDB ID changed, clear any cached TMDB data for this record
  if (body.tmdb_id !== undefined) {
    const row = await getWatchRecordByIdLight(id).catch(() => null);
    if (row) {
      const mediaType = row.media_type === "movie" ? "movie" : "tv";
      const docKey = `${mediaType}_${body.tmdb_id}`;
      // Don't delete the TMDB cache - the new ID may already be cached
      // But do clear the poster cache so it re-fetches with the new TMDB ID
      const mediaKey = row.media_key;
      if (mediaKey) {
        await db.collection("posterCache").doc(mediaKey).delete().catch(() => null);
      }
    }
  }

  return sendJson(res, { ok: true });
}

function extractYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("?")[0] || null;
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v") || null;
  } catch { /* invalid URL */ }
  return null;
}

async function handleYoutubeMeta(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const url = String(req.query.url || "").trim();
  if (!url) return sendJson(res, { error: "url is required" }, 400);

  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return sendJson(res, { error: "Could not extract YouTube video ID from URL" }, 400);

  // oEmbed is free, no API key required
  let title = "";
  let channelName = "";
  try {
    const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (oembedRes.ok) {
      const oembed = await oembedRes.json();
      title = oembed.title || "";
      channelName = oembed.author_name || "";
    }
  } catch { /* non-fatal */ }

  // Optional: YouTube Data API for description, duration, publishedAt
  let description = "";
  let publishedAt = "";
  let duration = "";
  const config = await loadMediaConfig();
  const ytApiKey = config.youtube?.apiKey;
  if (ytApiKey) {
    try {
      const apiRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(ytApiKey)}`);
      if (apiRes.ok) {
        const apiData = await apiRes.json();
        const item = apiData.items?.[0];
        if (item) {
          title = title || item.snippet?.title || "";
          channelName = channelName || item.snippet?.channelTitle || "";
          description = item.snippet?.description || "";
          publishedAt = item.snippet?.publishedAt || "";
          duration = item.contentDetails?.duration || "";
        }
      }
    } catch { /* non-fatal */ }
  }

  // Thumbnail URLs from highest to lowest quality
  const thumbnails = [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
  ];

  return sendJson(res, { videoId, title, channelName, description, publishedAt, duration, thumbnails });
}

async function handleMergeShows(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const sourceTitle = String(body.source_title || "").trim();
  const targetTitle = String(body.target_title || "").trim();
  if (!sourceTitle || !targetTitle) return sendJson(res, { error: "source_title and target_title are required" }, 400);

  try {
    const result = await mergeShows(sourceTitle, targetTitle);
    return sendJson(res, { ok: true, merged: result.merged });
  } catch (err) {
    return sendJson(res, { error: err.message }, 400);
  }
}

async function dispatch(req, res) {
  try {
    const path = routePath(req);
    if (path === "config") return handleConfig(req, res);
    if (path === "history") return handleHistory(req, res);
    if (path === "sync-jobs") return handleSyncJobs(req, res);
    if (path === "sync-history") return handleSyncHistory(req, res);
    if (path === "movies") return handleMovies(req, res);
    if (path === "shows") return handleShows(req, res);
    if (path === "show") return handleShow(req, res);
    if (path === "full-sync-watchstates") return handleFullSyncWatchstates(req, res);
    if (path === "import") return handleImport(req, res);
    if (path === "manual-watch") return handleManualWatch(req, res);
    if (path === "manual-unwatch") return handleManualUnwatch(req, res);
    if (path === "retry-sync") return handleRetrySync(req, res);
    if (path === "update-watch") return handleUpdateWatch(req, res);
    if (path === "merge-shows") return handleMergeShows(req, res);
    if (path === "now-playing") return handleNowPlaying(req, res);
    if (path === "active-sessions") return handleActiveSessions(req, res);
    if (path === "cron-sync") return handleCronSync(req, res);
    if (path === "force-sync") return handleForceSync(req, res);
    if (path === "stop-force-sync") return handleStopForceSync(req, res);
    if (path === "dedup-history") return handleDedupHistory(req, res);
    if (path === "tmdb-details") return handleTmdbDetails(req, res);
    if (path === "tmdb-person") return handleTmdbPerson(req, res);
    if (path === "youtube-meta") return handleYoutubeMeta(req, res);
    if (path === "webhook") return handleWebhook(req, res);
    if (path === "test-connection") return handleTestConnection(req, res);
    if (path === "poster") return handlePoster(req, res);
    if (path === "admin-backfill-status") return handleBackfillStatus(req, res);
    if (path === "admin-backfill-trakt") return handleBackfillTrakt(req, res);
    if (path === "admin-fix-history") return handleAdminFixHistory(req, res);
    if (["admin-ensure-columns", "admin-clear-mock"].includes(path)) {
      return handleMaintenanceStub(req, res, path);
    }
    return notFound(res);
  } catch (error) {
    console.error("API route failed", error);
    return sendJson(res, { error: "API route failed", details: error.message }, 500);
  }
}

export const api = onRequest({ region, cors: true, timeoutSeconds: 540, memory: "512MiB" }, dispatch);

export const scheduledSync = onSchedule({ schedule: "every 1 minutes", region, timeoutSeconds: 60, memory: "512MiB" }, async () => {
  await runScheduledSync();
});
