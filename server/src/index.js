import crypto from "node:crypto";
import { normalizeProviderIds, parseCustomWebhook, parseEmbyWebhook, parseJellyfinWebhook, parsePlexWebhook } from "./utils/parsers.js";
import { findPlexItem, markPlexPlayed, setPlexProgress } from "./utils/plexClient.js";
import { markEmbyPlayed, setEmbyProgress } from "./utils/embyClient.js";
import { markJellyfinPlayed, setJellyfinProgress } from "./utils/jellyfinClient.js";
import { requireAdmin, requireAdminStreaming, handleLogin, handleLogout, handleAuthStatus, handleAuthCredentials } from "./utils/auth.js";
import { AUTH } from "./appConfig.js";
import { getLogs as getDiagnosticLogs, clearLogs as clearDiagnosticLogs } from "./utils/diagnosticLogger.js";
import { readFormData, readJson } from "./utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed, notFound } from "./utils/http.js";
import { appendSyncHistory, loadMediaConfig, publicMediaConfig, saveMediaConfig, validateConfig, getSyncHistory, loadRuntimeState, setRuntimeState, appendRuntimeLog } from "./utils/configStore.js";
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
  getWatchRecordByMediaKey,
  getHistoryCacheVersion,
  getWatchStats,
  invalidateHistoryDerivedCaches,
  insertWatchRecord,
  listLibraryItemsForRefresh,
  setWatchPosterUrls,
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
  getCachedHistory,
  findExistingWatch,
  countMissingPosterTraktRows,
  listMissingPosterTraktRows,
  stampWatchPoster,
  setWatchMediaType,
  loadWatchKeyGroupsForDedup,
  deleteWatchRecordsByIds,
  deletePosterCacheByMediaKey,
} from "./utils/firestoreRepo.js";
import { getTargetsForSource, shouldSyncResumeProgress, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "./utils/syncOrchestrator.js";
import { watchedPlayedSyncEnabled } from "./utils/syncFlags.js";
import { fetchPosterFromTmdb } from "./utils/tmdbClient.js";
import { cachePosterFromUrl, cacheProfileFromUrl, getPosterCache, markPosterMissing, usableCachedPoster } from "./utils/posterCache.js";
import { getTmdbDetails, getTmdbImages, getTmdbPerson, getTmdbSeason, prewarmTmdbLibrary, searchTmdb } from "./utils/tmdbGateway.js";
import { BACKUP_FORMAT, BACKUP_VERSION, backupManifest, exportCollectionPage, importCollectionBatch } from "./utils/backup.js";
import {
  createWatchHistoryBackup,
  getBackupDestination,
  listRemoteBackups,
  pullRemoteBackupToLocal,
  readWatchBackupFile,
  removeBackupDestination,
  clearRestoreStatus,
  pauseCronSync,
  restoreWatchHistoryBackup,
  runScheduledWatchBackup,
  saveWatchBackupConfig,
  saveBackupDestination,
  testBackupDestination,
  updateDestinationSecrets,
  watchBackupStatus,
} from "./utils/watchHistoryBackups.js";
import { deviceCodeEndpoint, tokenEndpoint, ONEDRIVE_SCOPE } from "./utils/backupDestinations/onedrive.js";

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
  // Locally cached artwork is served from /media/posters or /media/backdrops.
  return raw.startsWith("/media/posters/") || raw.startsWith("/media/backdrops/");
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
    const storedConfig = await loadMediaConfig();
    return sendJson(res, {
      config: publicMediaConfig(storedConfig),
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

async function handleBackupExport(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const collection = String(req.query?.collection || "").trim();
  if (!collection) return sendJson(res, backupManifest(req.headers.origin || ""));

  try {
    return sendJson(res, exportCollectionPage(collection, {
      cursor: req.query?.cursor,
      limit: req.query?.limit,
    }));
  } catch (error) {
    return sendJson(res, { error: error.message }, 400);
  }
}

async function handleBackupImport(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  if (body.format !== BACKUP_FORMAT || Number(body.version) !== BACKUP_VERSION) {
    return sendJson(res, { error: "Unsupported Plembfin backup format or version" }, 400);
  }

  try {
    return sendJson(res, {
      ok: true,
      ...importCollectionBatch(String(body.collection || ""), body.documents, { reset: body.reset === true }),
    });
  } catch (error) {
    return sendJson(res, { error: error.message }, 400);
  }
}

// In-memory pending OneDrive device-code sessions (pendingId -> session). Short-lived
// and intentionally not persisted; a server restart simply cancels an in-flight login.
const deviceCodeSessions = new Map();

async function startOneDriveDeviceAuth(destination) {
  const clientId = destination.settings?.clientId;
  if (!clientId) throw new Error("Enter and save the OneDrive client ID first");
  const tenant = destination.settings?.tenant;
  const params = new URLSearchParams({ client_id: clientId, scope: ONEDRIVE_SCOPE });
  const response = await fetch(deviceCodeEndpoint(tenant), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || `Device code request failed (${response.status})`);

  const pendingId = crypto.randomUUID();
  deviceCodeSessions.set(pendingId, {
    destinationId: destination.id,
    clientId,
    tenant,
    deviceCode: data.device_code,
    expiresAt: Date.now() + (Number(data.expires_in) || 900) * 1000,
  });
  return {
    pendingId,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: Number(data.interval) || 5,
    expiresIn: Number(data.expires_in) || 900,
    message: data.message,
  };
}

async function pollOneDriveDeviceAuth(pendingId) {
  const session = deviceCodeSessions.get(pendingId);
  if (!session) return { status: "error", error: "Login session expired — start again" };
  if (session.expiresAt < Date.now()) {
    deviceCodeSessions.delete(pendingId);
    return { status: "error", error: "Login code expired — start again" };
  }
  const params = new URLSearchParams({
    client_id: session.clientId,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: session.deviceCode,
  });
  const response = await fetch(tokenEndpoint(session.tenant), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (response.ok && data.refresh_token) {
    updateDestinationSecrets(session.destinationId, { refreshToken: data.refresh_token });
    deviceCodeSessions.delete(pendingId);
    return { status: "authorized" };
  }
  if (data.error === "authorization_pending" || data.error === "slow_down") return { status: "pending" };
  deviceCodeSessions.delete(pendingId);
  return { status: "error", error: data.error_description || data.error || "Authorization failed" };
}

// Dropbox manual (no-redirect) OAuth: the authorize page shows a code the user pastes
// back, so no public callback URL is required for self-hosted installs.
function dropboxAuthorizeUrl(destination) {
  const appKey = destination.settings?.appKey;
  if (!appKey) throw new Error("Enter and save the Dropbox app key first");
  const params = new URLSearchParams({
    client_id: appKey,
    response_type: "code",
    token_access_type: "offline",
  });
  return `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeDropboxCode(destination, code) {
  const appKey = destination.settings?.appKey;
  const appSecret = destination.secrets?.appSecret;
  if (!appKey || !appSecret) throw new Error("Save the Dropbox app key and secret first");
  if (!code) throw new Error("Authorization code is required");
  const basic = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
  const params = new URLSearchParams({ grant_type: "authorization_code", code: String(code).trim() });
  const response = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.refresh_token) {
    throw new Error(data.error_description || data.error || "Dropbox authorization failed");
  }
  updateDestinationSecrets(destination.id, { refreshToken: data.refresh_token });
  return { status: "authorized" };
}

async function handleWatchBackups(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;

  if (req.method === "GET") {
    const filename = String(req.query?.download || "").trim();
    if (!filename) return sendJson(res, watchBackupStatus());
    try {
      const file = readWatchBackupFile(filename);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", String(file.compressed.length));
      res.setHeader("X-Content-SHA256", file.checksum);
      return res.end(file.compressed);
    } catch (error) {
      return sendJson(res, { error: error.message }, 404);
    }
  }

  if (req.method !== "POST") return methodNotAllowed(res);
  const body = await readJson(req);
  const action = String(body.action || "").trim();
  try {
    if (action === "configure") {
      return sendJson(res, { ok: true, config: saveWatchBackupConfig(body.config || {}) });
    }
    if (action === "create") {
      return sendJson(res, { ok: true, backup: await createWatchHistoryBackup({ reason: "manual" }) });
    }
    if (action === "restore") {
      const filename = String(body.filename || "").trim();
      if (!filename) return sendJson(res, { error: "filename is required" }, 400);

      const mode = body.mode === "replace" ? "replace" : "merge";
      const dryRun = body.dryRun === true;

      if (dryRun) {
        return sendJson(res, {
          ok: true,
          restore: restoreWatchHistoryBackup(filename, { mode, dryRun: true }),
        });
      }

      // For Replace restores: pause cron sync to prevent re-importing stale data from platforms.
      // We do NOT sync to connected apps here because that would trigger webhooks back to Plembfin,
      // creating new watch records dated today and undoing the restore.
      // Platform state is assumed to already reflect the backup (or will naturally reconcile).
      if (mode === "replace") {
        pauseCronSync(3600000); // Pause for 1 hour
        const result = restoreWatchHistoryBackup(filename, { mode, dryRun: false });

        return sendJson(res, {
          ok: true,
          restore: result,
          note: "Cron sync paused for 1 hour to prevent re-importing from connected apps.",
        });
      }

      // For Merge restores, just restore without pausing cron
      return sendJson(res, {
        ok: true,
        restore: restoreWatchHistoryBackup(filename, { mode, dryRun: false }),
      });
    }
    if (action === "save-destination") {
      return sendJson(res, { ok: true, destination: saveBackupDestination(body.destination || {}) });
    }
    if (action === "remove-destination") {
      const id = String(body.destinationId || "").trim();
      if (!id) return sendJson(res, { error: "destinationId is required" }, 400);
      return sendJson(res, { ok: true, ...removeBackupDestination(id) });
    }
    if (action === "list-remote-backups") {
      const id = String(body.destinationId || "").trim();
      if (!id) return sendJson(res, { error: "destinationId is required" }, 400);
      return sendJson(res, { ok: true, files: await listRemoteBackups(id) });
    }
    if (action === "restore-remote-backup") {
      const id = String(body.destinationId || "").trim();
      const filename = String(body.filename || "").trim();
      if (!id || !filename) return sendJson(res, { error: "destinationId and filename are required" }, 400);
      const pulled = await pullRemoteBackupToLocal(id, filename);
      return sendJson(res, {
        ok: true,
        pulled,
        restore: restoreWatchHistoryBackup(pulled.name, {
          mode: body.mode === "replace" ? "replace" : "merge",
          dryRun: body.dryRun === true,
        }),
      });
    }
    if (action === "clear-restore-status") {
      return sendJson(res, { ok: true, ...clearRestoreStatus() });
    }
    if (["test-destination", "device-start", "device-poll", "oauth-url", "oauth-exchange"].includes(action)) {
      if (action === "device-poll") {
        return sendJson(res, { ok: true, ...(await pollOneDriveDeviceAuth(String(body.pendingId || ""))) });
      }
      const destination = getBackupDestination(String(body.destinationId || "").trim());
      if (!destination) return sendJson(res, { error: "Destination not found" }, 404);
      if (action === "test-destination") {
        return sendJson(res, { ok: true, result: await testBackupDestination(destination) });
      }
      if (action === "device-start") {
        return sendJson(res, { ok: true, ...(await startOneDriveDeviceAuth(destination)) });
      }
      if (action === "oauth-url") {
        return sendJson(res, { ok: true, url: dropboxAuthorizeUrl(destination) });
      }
      if (action === "oauth-exchange") {
        return sendJson(res, { ok: true, ...(await exchangeDropboxCode(destination, body.code)) });
      }
    }
    return sendJson(res, { error: "Unknown watch backup action" }, 400);
  } catch (error) {
    return sendJson(res, { error: error.message }, 400);
  }
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

  // Clear resume progress on all target platforms to prevent re-import on next sync
  // Use direct platform calls since shouldSyncResumeProgress blocks position 0
  const targets = getTargetsForSource(media.source, config);
  for (const target of targets) {
    try {
      if (target === "plex") await setPlexProgress(config.plex, { ...media, positionMs: 0 });
      if (target === "emby") await setEmbyProgress(config.emby, { ...media, positionMs: 0 });
      if (target === "jellyfin") await setJellyfinProgress(config.jellyfin, { ...media, positionMs: 0 });
    } catch (error) {
      console.log(`Resume progress clear on ${target} during unwatch failed (non-fatal)`, error.message);
    }
  }

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
  const syncTasks = [];
  let inserted = 0;
  let skipped = 0;
  let rejected = 0;

  for (const [index, rawRecord] of records.entries()) {
    try {
      const pending = {
        ...rawRecord,
        source: rawRecord.source || "manual",
        sync_action: "watched",
        sync_dispatch_telemetry: "Origin: manual\nLoop-check: Passed\nDispatch status: pending\nDetails: Manual watch propagation queued.",
      };
      const { data, record } = watchRecordToFirestoreData(pending, "manual");
      const existing = await findExistingWatch(data.mediaKey || mediaKeyFor(record), data.watchedAt);

      const media = manualWatchMediaFromRecord(record);
      let id = "";
      if (!existing) {
        const insertResult = await insertWatchRecord(requireDb(), record, { skipInvalidate: true });
        id = insertResult.id;
        await insertResult.assetPrefetch?.catch(() => null);
        inserted += 1;
      } else {
        id = existing.id;
        skipped += 1;
      }

      await upsertPlaystateForMedia(requireDb(), media, "watched", record.watched_at, { skipInvalidate: true });
      syncTasks.push({ media, id, record });

      results.push({ index, id, title: record.title, inserted: !existing, status: "pending", targetStates: [] });
    } catch (error) {
      rejected += 1;
      results.push({ index, rejected: true, error: error.message || String(error) });
    }
  }

  await invalidateHistoryDerivedCaches().catch(() => null);

  // Sync in the background to prevent client timeouts
  if (syncTasks.length > 0) {
    (async () => {
      for (const task of syncTasks) {
        try {
          const summary = await syncMediaPlaystate(task.media, config, loopStore).catch((error) => ({
            skipped: false,
            status: "error",
            details: `Manual watch propagation failed: ${error.message || String(error)}`,
            targetStates: [],
          }));

          await updateWatchTelemetry(requireDb(), task.id, formatDispatchTelemetry(summary, task.media, "watched"), { skipInvalidate: true });
          await recordSyncHistory(task.media, summary, "watched");
        } catch (error) {
          console.error("Background manual watch sync failed:", error);
        }
      }
      await invalidateHistoryDerivedCaches().catch(() => null);
    })().catch((error) => console.error("Background manual watch sync loop crashed:", error));
  }

  return sendJson(res, { ok: true, inserted, skipped, rejected, propagated: 0, syncQueued: syncTasks.length, results });
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
    await appendRuntimeLog("forceSyncLog", batch).catch(() => null);
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
      await appendRuntimeLog("forceSyncLog", [`RESULT: ${JSON.stringify(result)}`]).catch(() => null);
      await setRuntimeState({
        forceSyncActive: false,
        forceSyncResult: result,
      }).catch(() => null);
    } catch (error) {
      const msg = `ERROR: Force Sync failed: ${error.message}`;
      console.error(msg);
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      await flushLog();
      await appendRuntimeLog("forceSyncLog", [msg]).catch(() => null);
      await setRuntimeState({
        forceSyncActive: false,
        forceSyncResult: { success: false, error: error.message },
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
    console.log("Webhook received", {
      source: media.source,
      title: media.title,
      phase: media.phase,
      type: media.type,
      isValid: media.isValid,
      ids: media.ids,
    });
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
    console.log("Webhook skipped: invalid media", {
      source: media.source,
      title: media.title,
      phase: media.phase,
      reason: media.phase === "ignored" ? "unsupported event" : "missing required media fields",
    });
    await recordSyncHistory(media, {
      status: "skipped",
      details: `Webhook ignored: ${media.phase === "ignored" ? "unsupported event" : "missing required media fields"}`,
      targetStates: [],
    }, media.phase || "webhook").catch(() => null);
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
      await recordSyncHistory(media, {
        status: "skipped",
        details: "Webhook ignored because source platform is disabled",
        targetStates: [],
      }, media.phase || "webhook").catch(() => null);
      return sendJson(res, { ok: true, ignored: true, reason: "Source platform is disabled" });
    }
    if (media.source === "plex" && shouldIgnoreWebhookUser(media.user, config.plex?.username, { strictName: true })) {
      await recordSyncHistory(media, {
        status: "skipped",
        details: "Webhook ignored because Plex user did not match configured user",
        targetStates: [],
      }, media.phase || "webhook").catch(() => null);
      return sendJson(res, { ok: true, ignored: true, reason: "User mismatch" });
    }
    if (media.source === "emby" && shouldIgnoreWebhookUser(media.user, config.emby?.userId)) {
      await recordSyncHistory(media, {
        status: "skipped",
        details: "Webhook ignored because Emby user did not match configured user",
        targetStates: [],
      }, media.phase || "webhook").catch(() => null);
      return sendJson(res, { ok: true, ignored: true, reason: "User mismatch" });
    }
    if (media.source === "jellyfin" && shouldIgnoreWebhookUser(media.user, config.jellyfin?.userId)) {
      await recordSyncHistory(media, {
        status: "skipped",
        details: "Webhook ignored because Jellyfin user did not match configured user",
        targetStates: [],
      }, media.phase || "webhook").catch(() => null);
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

            // Clear resume progress on target platforms to prevent re-import on next sync
            // Use direct platform calls since shouldSyncResumeProgress blocks position 0
            const episodeTargets = getTargetsForSource(episodeMedia.source, config);
            for (const target of episodeTargets) {
              try {
                if (target === "plex") await setPlexProgress(config.plex, { ...episodeMedia, positionMs: 0 });
                if (target === "emby") await setEmbyProgress(config.emby, { ...episodeMedia, positionMs: 0 });
                if (target === "jellyfin") await setJellyfinProgress(config.jellyfin, { ...episodeMedia, positionMs: 0 });
              } catch (error) {
                console.log(`Resume progress clear on ${target} during webhook unwatch failed (non-fatal)`, error.message);
              }
            }

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
            await dbResult.assetPrefetch?.catch(() => null);
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
      console.log("Webhook: marking as unwatched", {
        source: media.source,
        title: media.title,
        type: media.type,
      });
      await deleteActiveSession(null, media);
      await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
      const { wasDeleted, id } = await applyManualUnwatch(media, config, loopStore);
      console.log("Webhook: unwatched sync completed", {
        source: media.source,
        title: media.title,
        wasDeleted,
        id,
      });
      return sendJson(res, { ok: true, deleted: wasDeleted, unplayed: true, inserted: true, id, ...(wasDeleted ? {} : { reason: "No previous watched record found to delete" }) });
    } finally {
      await invalidateHistoryDerivedCaches().catch(() => null);
    }
  }

  try {
    console.log("Webhook: marking as watched", {
      source: media.source,
      title: media.title,
      type: media.type,
      progress: media.progress,
      positionMs: media.positionMs,
    });
    await deleteActiveSession(null, media);

    // Check if a recent watch record already exists (e.g., from full sync)
    // to avoid creating duplicates. Look for records watched in the last hour.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const existingRecord = await getWatchRecordByMediaKey(mediaKeyFor(media), oneHourAgo).catch(() => null);
    if (existingRecord) {
      console.log("Webhook: skipped duplicate watch record", {
        source: media.source,
        title: media.title,
        existingWatchedAt: existingRecord.watched_at,
      });
      return sendJson(res, { ok: true, inserted: false, id: existingRecord.id, reason: "Watch record already exists from recent full sync" });
    }

    const watchRecord = mediaToWatchRecord(media, media.source);
    watchRecord.sync_action = "watched";
    watchRecord.sync_dispatch_telemetry = formatDispatchTelemetry({ skipped: false, status: "pending", details: "Propagation queued", targetStates: [] }, media, "watched");
    const result = await insertWatchRecord(requireDb(), watchRecord, { skipInvalidate: true });
    console.log("Webhook: inserted watch record", {
      source: media.source,
      title: media.title,
      recordId: result.id,
      watchedAt: result.record.watched_at,
    });
    await upsertPlaystateForMedia(requireDb(), media, "watched", result.record.watched_at, { skipInvalidate: true });
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
      skipped: false,
      status: "error",
      details: `Propagation failed: ${error.message || String(error)}`,
      targetStates: [],
    }));
    console.log("Webhook: sync result", {
      source: media.source,
      title: media.title,
      status: summary.status,
      details: summary.details,
      targetStates: summary.targetStates,
    });
    await updateWatchTelemetry(requireDb(), result.id, formatDispatchTelemetry(summary, media, "watched"), { skipInvalidate: true });
    await recordSyncHistory(media, summary, "watched");
    await deletePlaybackProgress(requireDb(), media).catch(() => null);
    // Ensure TMDB metadata + artwork finish caching before the instance freezes,
    // so the detail page is instant on first click. Overlaps with the sync above.
    await result.assetPrefetch?.catch(() => null);
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

async function handleTmdbPoster(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);

  const posterPath = String(req.query.path || "").trim();
  if (!/^\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(posterPath)) {
    return sendJson(res, { error: "Invalid TMDB poster path" }, 400);
  }

  const mediaKey = `tmdb:poster:${posterPath}`;
  const cached = usableCachedPoster(await getPosterCache(mediaKey));
  if (cached?.url) {
    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    return res.redirect(302, cached.url);
  }
  if (cached?.cached) return res.redirect(302, "/favicon.svg");

  const remoteUrl = `https://image.tmdb.org/t/p/w500${posterPath}`;
  const stored = await cachePosterFromUrl(mediaKey, remoteUrl, "tmdb");
  if (!stored?.url) {
    await markPosterMissing(mediaKey, "tmdb", "TMDB poster download failed").catch(() => null);
    return res.redirect(302, "/favicon.svg");
  }

  res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  return res.redirect(302, stored.url);
}

async function handleTmdbProfile(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);

  const profilePath = String(req.query.path || "").trim();
  if (!/^\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(profilePath)) {
    return sendJson(res, { error: "Invalid TMDB profile path" }, 400);
  }

  const mediaKey = `tmdb:profile:${profilePath}`;
  const cached = usableCachedPoster(await getPosterCache(mediaKey, "profile"));
  if (cached?.url) {
    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    return res.redirect(302, cached.url);
  }
  if (cached?.cached) return res.redirect(302, "/favicon.svg");

  const remoteUrl = `https://image.tmdb.org/t/p/original${profilePath}`;
  const stored = await cacheProfileFromUrl(mediaKey, remoteUrl, "tmdb");
  if (!stored?.url) {
    await markPosterMissing(mediaKey, "tmdb", "TMDB profile download failed", "profile").catch(() => null);
    return res.redirect(302, "/favicon.svg");
  }

  res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  return res.redirect(302, stored.url);
}

async function handleBackfillStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  if (req.method !== "GET") return methodNotAllowed(res);

  try {
    const count = await countMissingPosterTraktRows();
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

    const rows = await listMissingPosterTraktRows(limit);

    if (!rows.length) {
      return sendJson(res, { ok: true, tried: 0, backfilled: 0, msg: "No missing poster rows remaining." });
    }

    let tried = 0;
    let backfilled = 0;

    for (const row of rows) {
      tried++;
      const rowMapped = {
        title: row.title,
        media_type: row.media_type,
        imdb_id: row.imdb_id,
        tmdb_id: row.tmdb_id,
        tvdb_id: row.tvdb_id,
        season: row.season,
        episode: row.episode,
      };

      const posterUrl = await fetchPosterFromTmdb(rowMapped, tmdbApiKey);
      if (posterUrl) {
        await stampWatchPoster(row.id, posterUrl);
        backfilled++;
      } else {
        await stampWatchPoster(row.id, "none");
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
    const recentRows = (await getCachedHistory()).slice(0, 300);

    const candidates = [];
    for (const data of recentRows) {
      const posterUrl = data.poster_url || "";
      const isOptimized = isCachedStorageUrl(posterUrl);
      const needsRetype = !data.media_type;

      if (!isOptimized || needsRetype) {
        candidates.push({ id: data.id, data });
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
        await setWatchMediaType(id, newType);
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
    const groups = loadWatchKeyGroupsForDedup();
    let scanned = 0;
    for (const docs of groups.values()) scanned += docs.length;
    log(`Loaded ${scanned} total records.`);
    log(`Found ${groups.size} unique media keys.`);

    let deleted = 0;
    let checked = 0;
    const removeIds = [];

    for (const [key, docs] of groups.entries()) {
      if (docs.length <= 1) continue;

      // Sort newest first; keep the first, remove the rest.
      docs.sort((a, b) => (b.watchedAt > a.watchedAt ? 1 : b.watchedAt < a.watchedAt ? -1 : 0));
      const [keep, ...remove] = docs;

      for (const dup of remove) {
        removeIds.push(dup.id);
        deleted++;
      }

      checked++;
      if (checked % 50 === 0) {
        log(`Processed ${checked} duplicate groups, ${deleted} deletions queued so far...`);
      }
    }

    if (removeIds.length) {
      deleteWatchRecordsByIds(removeIds);
      await invalidateHistoryDerivedCaches().catch(() => null);
    }

    const summary = { scanned, uniqueKeys: groups.size, deleted };
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

  try {
    const details = await getTmdbDetails({ mediaType, tmdbId, title });
    return sendJson(res, details, 200, { "Cache-Control": "private, max-age=300, stale-while-revalidate=86400", Vary: "Authorization" });
  } catch (error) {
    console.error("Failed handling TMDB details API", error);
    return sendJson(res, { error: error.message || "Failed to fetch TMDB details" }, error.status || 500);
  }
}

// Ultra-cheap, no-auth, no-Firestore endpoint whose only job is to boot a warm
// instance. The client calls this on page load so the function is hot by the time
// the user clicks into anything — gives the latency benefit of a warm instance
// without the 24/7 cost of minInstances.
function handlePing(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  return sendJson(res, { ok: true, ts: Date.now() }, 200, { "Cache-Control": "no-store" });
}

function handleDiagnosticLogs(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method === "DELETE") {
    if (!(requireAdminSync(req))) return sendJson(res, { error: "Unauthorized" }, 401);
    clearDiagnosticLogs();
    return sendJson(res, { ok: true }, 200, { "Cache-Control": "no-store" });
  }
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!requireAdminSync(req)) return sendJson(res, { error: "Unauthorized" }, 401);

  const limit = Math.min(Number(req.query?.limit || 500), 1000);
  const data = getDiagnosticLogs({ limit });
  return sendJson(res, data, 200, { "Cache-Control": "no-store" });
}

function verifyApiKey(token) {
  if (!token || !AUTH?.apiKey) return false;
  const a = Buffer.from(String(token));
  const b = Buffer.from(AUTH.apiKey);
  try {
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function requireAdminSync(req) {
  // Check query parameter first (easiest to debug)
  if (verifyApiKey(String(req.query?.api_key || ""))) return true;

  // Check X-Api-Key header (case-insensitive)
  const xApiKey = Object.entries(req.headers || {}).find(([key]) => key.toLowerCase() === "x-api-key");
  if (xApiKey && verifyApiKey(xApiKey[1])) return true;

  // Check Bearer token in Authorization header
  const authHeader = Object.entries(req.headers || {}).find(([key]) => key.toLowerCase() === "authorization");
  if (authHeader) {
    const bearerToken = String(authHeader[1]).replace(/^Bearer\s+/i, "").trim();
    if (verifyApiKey(bearerToken)) return true;
  }

  return false;
}

// Paginated bulk refresh of the whole library's TMDB metadata + artwork. Mirrors
// the ingest prefetch (full details cached to tmdbMetadataCache + poster/backdrop
// to Storage) AND stamps the canonical poster back onto every watch record, so
// EXISTING media reaches full parity with newly-added media. Paginated so a large
// library never hits the request timeout; the client loops until hasMore is false.
async function handleRefreshTmdbMetadata(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  const offset = Math.max(Number(body.offset || 0), 0);
  const limit = Math.min(Math.max(Number(body.limit || 12), 1), 30);

  // Firebase Hosting cuts off rewritten requests at ~60s, and TV items are slow
  // (deriveNextAiring fetches multiple seasons). Time-box each page so it always
  // returns well under that limit; the client just resumes from nextOffset.
  const PAGE_BUDGET_MS = 25000;
  const startedAt = Date.now();

  const items = await listLibraryItemsForRefresh();
  const total = items.length;

  let success = 0;
  let failed = 0;
  let processed = 0;
  const posterUpdates = [];
  const log = [];

  for (let i = offset; i < items.length && processed < limit; i++) {
    if (processed > 0 && Date.now() - startedAt > PAGE_BUDGET_MS) break;
    const item = items[i];
    const label = `${item.mediaType === "movie" ? "Movie" : "Show"}: ${item.title}`;
    try {
      const details = await getTmdbDetails({ mediaType: item.mediaType, tmdbId: item.tmdbId, title: item.title, force: true });
      const posterUrl = details?.cached_poster_url || "";
      if (posterUrl) {
        for (const rec of item.records) {
          if (rec.poster !== posterUrl) posterUpdates.push({ id: rec.id, posterUrl });
        }
      }
      success += 1;
      log.push(`OK - ${label}`);
    } catch (error) {
      failed += 1;
      log.push(`FAILED - ${label} (${error.message || "error"})`);
    }
    processed += 1;
  }

  let postersWritten = 0;
  if (posterUpdates.length) {
    postersWritten = await setWatchPosterUrls(posterUpdates).catch(() => 0);
  }

  const nextOffset = offset + processed;
  const hasMore = nextOffset < total;
  // Invalidate derived caches ONCE, on the final page. Doing it per page forced a
  // full watchHistory re-scan on every subsequent page's list build, which pushed
  // pages past the Firebase Hosting ~60s timeout (503s).
  if (!hasMore) await invalidateHistoryDerivedCaches().catch(() => null);

  return sendJson(res, {
    ok: true,
    total,
    processed,
    nextOffset,
    hasMore,
    success,
    failed,
    postersWritten,
    log,
  });
}

async function handleTmdbDetailsBatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items.slice(0, 240) : [];
  if (!items.length) return sendJson(res, { results: [] });

  const results = await Promise.all(items.map(async (item) => {
    const mediaType = String(item?.mediaType || item?.type || "").trim().toLowerCase();
    const tmdbId = String(item?.tmdbId || item?.id || "").trim();
    const title = String(item?.title || "").trim();
    if (!mediaType || (!tmdbId && !title)) return { error: "invalid" };
    try {
      const details = await getTmdbDetails({ mediaType, tmdbId, title });
      return { details };
    } catch (error) {
      return { error: error.message || "failed", status: error.status || 500 };
    }
  }));

  return sendJson(res, { results }, 200, { "Cache-Control": "private, max-age=300, stale-while-revalidate=86400", Vary: "Authorization" });
}

async function handleTmdbSearch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const query = String(req.query.query || req.query.q || "").trim();
  if (query.length < 2) return sendJson(res, { error: "A search query of at least two characters is required" }, 400);
  try {
    const result = await searchTmdb({ query, page: req.query.page, mediaType: req.query.mediaType || req.query.type || "multi" });
    return sendJson(res, result, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=900", Vary: "Authorization" });
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

async function handleMediaSearch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const query = String(req.query.query || req.query.q || "").trim();
  if (query.length < 2) return sendJson(res, { error: "A search query of at least two characters is required" }, 400);
  try {
    const [movies, shows, discovery] = await Promise.all([
      queryMovies({ search: query, limit: 8 }),
      queryShows({ search: query, limit: 8 }),
      searchTmdb({ query, page: req.query.page, mediaType: req.query.mediaType || "multi" }),
    ]);
    return sendJson(res, { local: { movies, shows }, discovery });
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

async function handleTmdbSeason(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const details = await getTmdbSeason({ tmdbId: req.query.tmdbId || req.query.id, seasonNumber: req.query.seasonNumber || req.query.season });
    return sendJson(res, details, 200, { "Cache-Control": "private, max-age=3600, stale-while-revalidate=86400", Vary: "Authorization" });
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

async function handleTmdbImages(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const details = await getTmdbImages({ mediaType: req.query.mediaType || req.query.type, tmdbId: req.query.tmdbId || req.query.id });
    return sendJson(res, details);
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
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

  try {
    const personData = await getTmdbPerson(personId);
    
    // Deep clone the credits cast so we can enrich them without mutating the cached details
    const responseData = {
      ...personData,
      combined_credits: personData.combined_credits ? {
        ...personData.combined_credits,
        cast: (personData.combined_credits.cast || []).map(credit => ({ ...credit }))
      } : personData.combined_credits
    };

    if (responseData.combined_credits && Array.isArray(responseData.combined_credits.cast)) {
      const cast = responseData.combined_credits.cast;
      const creditTmdbIds = [];
      const creditTitles = [];
      for (const credit of cast) {
        if (credit.id) creditTmdbIds.push(String(credit.id));
        const title = credit.title || credit.name;
        if (title) creditTitles.push(title.toLowerCase());
      }

      if (creditTmdbIds.length > 0) {
        const dbInstance = requireDb();
        const placeholdersTmdb = creditTmdbIds.map(() => "?").join(",");
        const placeholdersTitle = creditTitles.map(() => "?").join(",");
        
        // Fetch all matching rows from watch_history
        const query = `
          SELECT id, tmdb_id, title, media_type, season, episode, show_title, title_lower, show_title_lower, source
          FROM watch_history
          WHERE (tmdb_id IS NOT NULL AND tmdb_id IN (${placeholdersTmdb}))
             OR (title_lower IN (${placeholdersTitle}))
             OR (show_title_lower IN (${placeholdersTitle}))
        `;
        const params = [...creditTmdbIds, ...creditTitles, ...creditTitles];
        const rows = dbInstance.prepare(query).all(params);

        // Sources that mean the item is physically on a connected media server.
        const isMediaServerSource = (src) => {
          const s = String(src || "").toLowerCase();
          return s.startsWith("plex") || s.startsWith("emby") || s.startsWith("jellyfin") || s.startsWith("webhook");
        };

        // Group rows by tmdb_id and show_title_lower for easy lookup
        const rowsByTmdbId = new Map();
        const rowsByTitleLower = new Map();
        
        for (const row of rows) {
          if (row.tmdb_id) {
            const key = String(row.tmdb_id);
            if (!rowsByTmdbId.has(key)) rowsByTmdbId.set(key, []);
            rowsByTmdbId.get(key).push(row);
          }
          if (row.title_lower) {
            const key = row.title_lower;
            if (!rowsByTitleLower.has(key)) rowsByTitleLower.set(key, []);
            rowsByTitleLower.get(key).push(row);
          }
          if (row.show_title_lower) {
            const key = row.show_title_lower;
            if (!rowsByTitleLower.has(key)) rowsByTitleLower.set(key, []);
            rowsByTitleLower.get(key).push(row);
          }
        }

        // Helper to slugify title
        const slug = (str) => String(str || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

        // Map over each credit to check watched status
        for (const credit of cast) {
          const tmdbIdStr = String(credit.id);
          const titleLower = (credit.title || credit.name || "").toLowerCase();
          
          let matchingRows = [];
          if (rowsByTmdbId.has(tmdbIdStr)) {
            matchingRows = rowsByTmdbId.get(tmdbIdStr);
          } else if (rowsByTitleLower.has(titleLower)) {
            matchingRows = rowsByTitleLower.get(titleLower);
          }

          if (matchingRows.length > 0) {
            // "In Library" = physically on a connected media server (Plex/Emby/Jellyfin).
            // Manually-watched or imported items are tracked but not "in library".
            const serverRows = matchingRows.filter(r => isMediaServerSource(r.source));
            
            if (credit.media_type === "tv") {
              const tvRows = matchingRows.filter(r => r.media_type === "episode");
              if (tvRows.length > 0) {
                // Count unique episodes
                const watchedKeys = new Set(tvRows.map(r => `${r.season}_${r.episode}`));
                credit.watched_count = watchedKeys.size;
                const representative = tvRows[0];
                const showTitle = representative.show_title || representative.title || credit.name || credit.title;
                credit.show_title = showTitle;
                credit.library_key = slug(showTitle);
                credit.library_id = representative.id;
                // Only mark in_library if there's a media-server source row
                const serverTvRows = serverRows.filter(r => r.media_type === "episode");
                credit.in_library = serverTvRows.length > 0;
                credit.in_watch_history = true;
              }
            } else {
              const movieRows = matchingRows.filter(r => r.media_type === "movie");
              if (movieRows.length > 0) {
                credit.library_id = movieRows[0].id;
                const serverMovieRows = serverRows.filter(r => r.media_type === "movie");
                credit.in_library = serverMovieRows.length > 0;
                credit.in_watch_history = true;
              }
            }
          }
        }
      }
    }

    return sendJson(res, responseData, 200, { "Cache-Control": "private, max-age=86400" });
  } catch (error) {
    console.error("Failed handling TMDB person API", error);
    return sendJson(res, { error: error.message || "Failed to fetch TMDB person details" }, error.status || 500);
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
        await deletePosterCacheByMediaKey(mediaKey).catch(() => null);
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
    if (path === "ping") return handlePing(req, res);
    if (path === "diagnostic-logs") return handleDiagnosticLogs(req, res);
    if (path === "login") return handleLogin(req, res);
    if (path === "logout") return handleLogout(req, res);
    if (path === "auth/status" || path === "auth-status") return handleAuthStatus(req, res);
    if (path === "auth/credentials") return handleAuthCredentials(req, res);
    if (path === "config") return handleConfig(req, res);
    if (path === "history") return handleHistory(req, res);
    if (path === "sync-jobs") return handleSyncJobs(req, res);
    if (path === "sync-history") return handleSyncHistory(req, res);
    if (path === "movies") return handleMovies(req, res);
    if (path === "shows") return handleShows(req, res);
    if (path === "show") return handleShow(req, res);
    if (path === "full-sync-watchstates") return handleFullSyncWatchstates(req, res);
    if (path === "import") return handleImport(req, res);
    if (path === "backup/export") return handleBackupExport(req, res);
    if (path === "backup/import") return handleBackupImport(req, res);
    if (path === "watch-backups") return handleWatchBackups(req, res);
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
    if (path === "tmdb-details-batch") return handleTmdbDetailsBatch(req, res);
    if (path === "refresh-tmdb-metadata") return handleRefreshTmdbMetadata(req, res);
    if (path === "media-details") return handleTmdbDetails(req, res);
    if (path === "tmdb-search") return handleTmdbSearch(req, res);
    if (path === "media-search") return handleMediaSearch(req, res);
    if (path === "tmdb-season") return handleTmdbSeason(req, res);
    if (path === "tmdb-images") return handleTmdbImages(req, res);
    if (path === "tmdb-person") return handleTmdbPerson(req, res);
    if (path === "youtube-meta") return handleYoutubeMeta(req, res);
    if (path === "webhook") return handleWebhook(req, res);
    if (path === "test-connection") return handleTestConnection(req, res);
    if (path === "tmdb-poster") return handleTmdbPoster(req, res);
    if (path === "tmdb-profile") return handleTmdbProfile(req, res);
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

export { dispatch };

// Invoked once per minute by the in-process scheduler in server.js
// (replacing the scheduledSync Cloud Function).
export async function runScheduledTick() {
  await runScheduledSync();
  await Promise.resolve(runScheduledWatchBackup()).catch((error) => console.error("Scheduled watch-history backup failed", error));
  await prewarmTmdbLibrary({ limit: 4 }).catch((error) => console.error("TMDB prewarm failed", error));
}
