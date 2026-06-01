import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { setGlobalOptions } from "firebase-functions/v2";
import { parseCustomWebhook, parseEmbyWebhook, parseJellyfinWebhook, parsePlexWebhook } from "./utils/parsers.js";
import { findPlexItem } from "./utils/plexClient.js";
import { requireAdmin } from "./utils/auth.js";
import { readFormData, readJson } from "./utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed, notFound } from "./utils/http.js";
import { loadMediaConfig, saveMediaConfig, validateConfig, getSyncHistory, loadRuntimeState, setRuntimeState } from "./utils/configStore.js";
import { createLoopStore } from "./utils/loopStore.js";
import { listActiveSessions, deleteActiveSession, upsertActiveSession } from "./utils/activeSessions.js";
import { hydrateCachedSession, loadLiveTrackingCache } from "./utils/liveSessions.js";
import { runScheduledSync } from "./scheduled.js";
import {
  batchInsertWatchRecords,
  deletePlaybackProgress,
  deleteWatchRecord,
  getWatchRecordById,
  getWatchStats,
  insertWatchRecord,
  mediaToPlaybackProgressRecord,
  mediaToWatchRecord,
  queryMovies,
  queryShows,
  queryWatchHistory,
  requireDb,
  updatePlaybackProgressTelemetry,
  updateWatchTelemetry,
  upsertPlaybackProgress,
} from "./utils/firestoreRepo.js";
import { shouldSyncResumeProgress, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "./utils/syncOrchestrator.js";
import { fetchPosterFromTmdb } from "./utils/tmdbClient.js";
import { db, FieldValue } from "./firebase.js";

const region = process.env.FUNCTIONS_REGION || "europe-west2";
setGlobalOptions({ region, maxInstances: 10 });

function routePath(req) {
  const path = req.path || new URL(req.originalUrl || req.url, "https://local").pathname;
  return path.replace(/^\/api\/?/, "").replace(/^\/+/, "") || "";
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

function formatDispatchTelemetry(summary, media) {
  const lines = [
    `Origin: ${media.source || "unknown"}`,
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

function platformLabel(value) {
  const text = String(value || "unknown");
  return text.charAt(0).toUpperCase() + text.slice(1);
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

  const [history, stats] = await Promise.all([
    queryWatchHistory(requireDb(), { search: req.query.search || "", limit: req.query.limit || 50, offset: req.query.offset || 0 }),
    getWatchStats(requireDb()),
  ]);
  return sendJson(res, { history, stats });
}

async function handleMovies(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const movies = await queryMovies({ search: req.query.search || "", sort: req.query.sort || "watched_desc", limit: req.query.limit || 100, offset: req.query.offset || 0 });
  return sendJson(res, { movies }, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=300", Vary: "Authorization" });
}

async function handleShows(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const shows = await queryShows({ search: req.query.search || "", sort: req.query.sort || "watched_desc", limit: req.query.limit || 6, offset: req.query.offset || 0 });
  return sendJson(res, { shows }, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=300", Vary: "Authorization" });
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

async function handleNowPlaying(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const rows = await loadLiveTrackingCache(requireDb(), { includeCompleted: false }).catch(() => []);
  const runtime = await loadRuntimeState();
  const sessions = rows.map(hydrateCachedSession).filter((session) => !session.completedAt);
  return sendJson(res, sessions, 200, runtime.nowPlayingRefresh ? { "X-Now-Playing-Refresh": String(runtime.nowPlayingRefresh) } : {});
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
  if (!(await requireAdmin(req, res))) return;
  return sendJson(res, { ok: true, result: await runScheduledSync() });
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
    if (media.source === "plex" && config.plex?.username && String(media.user || "").toLowerCase() !== String(config.plex.username).toLowerCase()) {
      return sendJson(res, { ok: true, ignored: true, reason: "User mismatch" });
    }
    if (media.source === "emby" && config.emby?.userId && String(media.user || "").toLowerCase() !== String(config.emby.userId).toLowerCase()) {
      return sendJson(res, { ok: true, ignored: true, reason: "User mismatch" });
    }
    if (media.source === "jellyfin" && config.jellyfin?.userId && String(media.user || "").toLowerCase() !== String(config.jellyfin.userId).toLowerCase()) {
      return sendJson(res, { ok: true, ignored: true, reason: "User mismatch" });
    }
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
    await deleteActiveSession(null, media);
    const wasDeleted = await deleteWatchRecord(requireDb(), media).catch((error) => {
      console.error("Failed to delete watch record from Firestore", error);
      return false;
    });
    await deletePlaybackProgress(requireDb(), media).catch(() => null);
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    if (wasDeleted) await syncMediaUnplayedPlaystate(media, config, loopStore).catch((error) => console.error("Webhook unplayed propagation failed", error));
    return sendJson(res, { ok: true, deleted: wasDeleted, unplayed: true, ...(wasDeleted ? {} : { reason: "No watch record found to delete" }) });
  }

  try {
    await deleteActiveSession(null, media);
    const watchRecord = mediaToWatchRecord(media, media.source);
    watchRecord.sync_dispatch_telemetry = formatDispatchTelemetry({ skipped: false, status: "pending", details: "Propagation queued", targetStates: [] }, media);
    const result = await insertWatchRecord(requireDb(), watchRecord);
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
      skipped: false,
      status: "error",
      details: `Propagation failed: ${error.message || String(error)}`,
      targetStates: [],
    }));
    await updateWatchTelemetry(requireDb(), result.id, formatDispatchTelemetry(summary, media));
    await deletePlaybackProgress(requireDb(), media).catch(() => null);
    return sendJson(res, { ok: true, inserted: true, id: result.id, record: result.record });
  } catch (error) {
    console.error("Webhook Firestore insert failed", error);
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
  const row = await getWatchRecordById(String(req.query.id || ""));
  if (!row) return sendJson(res, { error: "not found" }, 404);
  if (row.poster_url && /^https?:\/\//i.test(row.poster_url)) return sendJson(res, { url: row.poster_url }, 200, { "Cache-Control": "private, max-age=3600, stale-while-revalidate=86400" });

  const config = await loadMediaConfig();
  if (String(row.source || "").toLowerCase().includes("plex") && config.plex?.baseUrl && config.plex?.token) {
    const item = await findPlexItem(config.plex, {
      title: row.title,
      type: row.media_type,
      ids: { imdb: row.imdb_id || null, tmdb: row.tmdb_id || null, tvdb: row.tvdb_id || null },
      season: row.season || null,
      episode: row.episode || null,
    }).catch(() => null);
    const path = item?.thumb || item?.parentThumb || item?.grandparentThumb || item?.art || item?.parentArt || item?.grandparentArt || "";
    if (path) {
      const base = config.plex.baseUrl.replace(/\/+$/, "");
      const joined = path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
      const sep = joined.includes("?") ? "&" : "?";
      return sendJson(res, { url: `${joined}${sep}X-Plex-Token=${encodeURIComponent(config.plex.token)}` });
    }
  }
  return sendJson(res, { url: null });
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

    return sendJson(res, { ok: true, tried, backfilled });
  } catch (error) {
    console.error("Trakt backfill execution failed", error);
    return sendJson(res, { error: "Trakt backfill execution failed", details: error.message }, 500);
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

async function dispatch(req, res) {
  try {
    const path = routePath(req);
    if (path === "config") return handleConfig(req, res);
    if (path === "history") return handleHistory(req, res);
    if (path === "movies") return handleMovies(req, res);
    if (path === "shows") return handleShows(req, res);
    if (path === "import") return handleImport(req, res);
    if (path === "now-playing") return handleNowPlaying(req, res);
    if (path === "active-sessions") return handleActiveSessions(req, res);
    if (path === "cron-sync") return handleCronSync(req, res);
    if (path === "webhook") return handleWebhook(req, res);
    if (path === "test-connection") return handleTestConnection(req, res);
    if (path === "poster") return handlePoster(req, res);
    if (path === "admin-backfill-status") return handleBackfillStatus(req, res);
    if (path === "admin-backfill-trakt") return handleBackfillTrakt(req, res);
    if (["admin-fix-history", "admin-ensure-columns", "admin-clear-mock"].includes(path)) {
      return handleMaintenanceStub(req, res, path);
    }
    return notFound(res);
  } catch (error) {
    console.error("API route failed", error);
    return sendJson(res, { error: "API route failed", details: error.message }, 500);
  }
}

export const api = onRequest({ region, cors: true, timeoutSeconds: 540, memory: "512MiB" }, dispatch);

export const scheduledSync = onSchedule({ schedule: "every 1 minutes", region, timeoutSeconds: 540, memory: "512MiB" }, async () => {
  await runScheduledSync();
});
