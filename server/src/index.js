import crypto from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { normalizeProviderIds, parseCustomWebhook, parseEmbyWebhook, parseJellyfinWebhook, parsePlexWebhook, buildPlexMediaFromMetadata } from "./utils/parsers.js";
import { findPlexItem, markPlexPlayed, setPlexProgress, markPlexUnplayedByRatingKey, fetchPlexWatchedItems, fetchPlexMetadataItem, fetchPlexSeriesEpisodes } from "./utils/plexClient.js";
import { createPlexNotificationListener, probePlexNotificationSocket } from "./utils/plexNotificationListener.js";
import { markEmbyPlayed, setEmbyProgress, markEmbyUnplayedById, fetchEmbyWatchedItems, findEmbyItems, fetchEmbySeriesEpisodes } from "./utils/embyClient.js";
import { markJellyfinPlayed, setJellyfinProgress, markJellyfinUnplayedById, fetchJellyfinWatchedItems, findJellyfinItems, fetchJellyfinSeriesEpisodes } from "./utils/jellyfinClient.js";
import { requireAdmin, resolveAdminPrincipal, handleLogin, handleLogout, handleAuthStatus, handleAuthApiKey, handleAuthWebhookSecret, handleAuthCredentials, handleRevokeAllSessions } from "./utils/auth.js";
import { AUTH, verifyWebhookToken } from "./appConfig.js";
import { getLogs as getDiagnosticLogs, clearLogs as clearDiagnosticLogs } from "./utils/diagnosticLogger.js";
import { readFormData, readJson } from "./utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed, notFound } from "./utils/http.js";
import { fetchWithTimeout, assertSafeOutboundUrl } from "./utils/outbound.js";
import { appendSyncHistory, loadMediaConfig, mergeIncomingConfig, publicMediaConfig, saveMediaConfig, validateConfig, getSyncHistory, loadRuntimeState, setRuntimeState, appendRuntimeLog } from "./utils/configStore.js";
import { db, parseJson, toJson, writeAuditLog } from "./db.js";
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
  deleteWatchRecordById,
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
  relatedPosterRows,
  setWatchPosterUrls,
  setWatchBackdropUrl,
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
  normalizeWatchRecordForInsert,
  watchRowToMedia,
  getCachedShows,
  getCachedMovies,
  getCachedHistory,
  findExistingWatch,
  findWatchedByAnyMediaKey,
  getPlaystateForMedia,
  countMissingPosterTraktRows,
  listMissingPosterTraktRows,
  stampWatchPoster,
  setWatchMediaType,
  loadWatchKeyGroupsForDedup,
  deleteWatchRecordsByIds,
  deleteMovieByWatchId,
  deletePosterCacheByMediaKey,
  backfillUnknownShowTitles,
  clearWatchArtworkUrls,
} from "./utils/firestoreRepo.js";
import { getTargetsForSource, shouldSyncResumeProgress, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "./utils/syncOrchestrator.js";
import { watchedPlayedSyncEnabled } from "./utils/syncFlags.js";
import { fetchPosterFromTmdb } from "./utils/tmdbClient.js";
import { cacheBackdropFromUrl, cachePosterFromUrl, cacheProfileFromUrl, getPosterCache, markPosterMissing, usableCachedPoster } from "./utils/posterCache.js";
import { getTmdbDetails, getTmdbImages, getTmdbPerson, getTmdbSeason, prewarmTmdbLibrary, searchTmdb, getCachedTvdbId } from "./utils/tmdbGateway.js";
import { searchTvdbSeriesList, resolveTvdbSeriesId, getTvdbSeriesArtwork } from "./utils/tvdbGateway.js";
import {
  cachedNextAiringFor,
  mergeNextAiringCacheEntries,
  nextAiringCacheEntryStale,
  nextAiringCacheKey,
  readNextAiringCache,
} from "./utils/nextAiringCache.js";
import { getFanartMovieArt, getFanartTvArt, getAllFanartMovieImages, getAllFanartTvImages } from "./utils/fanartGateway.js";
import { getOmdbRating } from "./utils/omdbGateway.js";
import { BACKUP_FORMAT, BACKUP_VERSION, backupManifest, exportCollectionPage, importCollectionBatch } from "./utils/backup.js";
import {
  createWatchHistoryBackup,
  getBackupDestination,
  importWatchHistoryBackupFile,
  listRemoteBackups,
  pullRemoteBackupToLocal,
  readWatchBackupFile,
  removeBackupDestination,
  clearRestoreStatus,
  pauseCronSync,
  resumeCronSync,
  setLastRestoreAt,
  loadWatchBackupRuntime,
  restoreWatchHistoryBackup,
  runScheduledWatchBackup,
  saveWatchBackupConfig,
  saveBackupDestination,
  testBackupDestination,
  updateDestinationSecrets,
  watchBackupStatus,
} from "./utils/watchHistoryBackups.js";
import {
  createPlembfinBackup,
  deletePlembfinBackup,
  loadPlembfinBackupConfig,
  loadPlembfinBackupRuntime,
  listPlembfinBackups,
  plembfinBackupStatus,
  readPlembfinBackupFile,
  runScheduledPlembfinBackup,
  savePlembfinBackupConfig,
} from "./utils/plembfinBackups.js";
import { deviceCodeEndpoint, tokenEndpoint, ONEDRIVE_SCOPE } from "./utils/backupDestinations/onedrive.js";
import { POSTERS_DIR, BACKDROPS_DIR, PROFILES_DIR, PUBLIC_DIR } from "./paths.js";

const NEXT_AIRING_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const NEXT_AIRING_REFRESH_LIMIT = 40;
let lastNextAiringRefreshAt = 0;
let nextAiringInitialBuildPending = true;

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

function trimTrailingSlash(value = "") {
  return String(value || "").replace(/\/+$/, "");
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

const APPEARANCE_SETTINGS_ID = "appearanceConfig";
const APPEARANCE_DEFAULTS = {
  showLogoArt: true,
  showCast: true,
  showTrailers: true,
  showReviews: true,
  showImages: true,
  showRelated: true,
};

async function handleAppearance(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;

  if (req.method === "GET") {
    const row = db.prepare("SELECT data FROM settings WHERE id = ?").get(APPEARANCE_SETTINGS_ID);
    const stored = parseJson(row?.data, {}) || {};
    return sendJson(res, { appearance: { ...APPEARANCE_DEFAULTS, ...stored } });
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    const merged = { ...APPEARANCE_DEFAULTS };
    for (const key of Object.keys(APPEARANCE_DEFAULTS)) {
      if (typeof body[key] === "boolean") merged[key] = body[key];
    }
    db.prepare(
      `INSERT INTO settings (id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).run(APPEARANCE_SETTINGS_ID, toJson(merged), Date.now());
    return sendJson(res, { ok: true, appearance: merged });
  }

  return methodNotAllowed(res);
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
    // Validate the merged result (stored + incoming) so a save that leaves a key
    // field blank — because the browser never receives stored secrets — still
    // satisfies required-credential checks. Only sections present in the request
    // are validated, matching the previous per-section semantics.
    const merged = await mergeIncomingConfig(config);
    const toValidate = {};
    for (const section of ["plex", "emby", "jellyfin", "seerr"]) {
      if (config[section]) toValidate[section] = merged[section];
    }
    const errors = validateConfig(toValidate);
    if (errors.length) return sendJson(res, { error: "Invalid configuration", details: errors }, 400);
    await saveMediaConfig(config);
    writeAuditLog("settings.saved", { ip: req.ip || req.socket?.remoteAddress });
    const storedConfig = await loadMediaConfig();
    // Reconnect the Plex notification listener so a newly added/changed server or token
    // takes effect immediately (event-driven unwatch detection).
    restartPlexNotificationListener();
    return sendJson(res, { ok: true, config: publicMediaConfig(storedConfig) });
  }

  return methodNotAllowed(res);
}

const SEERR_MEDIA_STATUS_TTL_MS = 3 * 60 * 1000;
const seerrMediaStatusCache = new Map();
function seerrMediaStatusCacheKey(mediaType, mediaId) {
  return `${mediaType}:${mediaId}`;
}
function invalidateSeerrMediaStatus(mediaType, mediaId) {
  seerrMediaStatusCache.delete(seerrMediaStatusCacheKey(mediaType, mediaId));
}
// Sweep expired entries on every write so the map can't grow without bound on a
// long-lived instance (entries were previously only overwritten, never removed).
function setSeerrMediaStatusCache(key, entry) {
  const cutoff = Date.now() - SEERR_MEDIA_STATUS_TTL_MS;
  for (const [existingKey, existing] of seerrMediaStatusCache) {
    if (Number(existing?.cachedAtMs || 0) < cutoff) seerrMediaStatusCache.delete(existingKey);
  }
  seerrMediaStatusCache.set(key, entry);
}

async function handleSeerrStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const config = await loadMediaConfig();
  const { baseUrl, apiKey, disabled } = config.seerr || {};

  if (disabled || !baseUrl || !apiKey) {
    return sendJson(res, { ok: false, configured: false, error: "Seerr is not configured or disabled." }, 503);
  }

  try {
    assertSafeOutboundUrl(baseUrl, { label: "Seerr baseUrl" });
  } catch (error) {
    return sendJson(res, { ok: false, configured: true, error: error.message || "Invalid Seerr baseUrl" }, 400);
  }

  try {
    const seerrHeaders = { "X-Api-Key": apiKey, Accept: "application/json" };
    const seerrRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: seerrHeaders,
      signal: AbortSignal.timeout(8000),
    });
    if (!seerrRes.ok) {
      const text = await seerrRes.text().catch(() => "");
      return sendJson(res, { ok: false, configured: true, error: `Seerr returned ${seerrRes.status}: ${text.slice(0, 200)}` }, 502);
    }
    const data = await seerrRes.json().catch(() => ({}));
    const [radarrSettings, sonarrSettings] = await Promise.all([
      fetch(`${baseUrl}/api/v1/settings/radarr`, {
        headers: seerrHeaders,
        signal: AbortSignal.timeout(8000),
      }).then((response) => response.ok ? response.json() : []).catch(() => []),
      fetch(`${baseUrl}/api/v1/settings/sonarr`, {
        headers: seerrHeaders,
        signal: AbortSignal.timeout(8000),
      }).then((response) => response.ok ? response.json() : []).catch(() => []),
    ]);
    const radarrServers = Array.isArray(radarrSettings) ? radarrSettings : (radarrSettings?.radarrServers || radarrSettings?.servers || []);
    const sonarrServers = Array.isArray(sonarrSettings) ? sonarrSettings : (sonarrSettings?.sonarrServers || sonarrSettings?.servers || []);
    const capabilities = {
      movie4k: Array.isArray(radarrServers) && radarrServers.some((server) => Boolean(server?.is4k)),
      tv4k: Array.isArray(sonarrServers) && sonarrServers.some((server) => Boolean(server?.is4k)),
    };
    return sendJson(res, { ok: true, configured: true, applicationTitle: data.displayName || data.username || "Seerr", capabilities });
  } catch (err) {
    return sendJson(res, { ok: false, configured: true, error: err.message || "Connection failed" }, 502);
  }
}

async function handleSeerrRequest(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const config = await loadMediaConfig();
  const { baseUrl, apiKey, disabled } = config.seerr || {};

  if (disabled || !baseUrl || !apiKey) {
    return sendJson(res, { ok: false, error: "Seerr is not configured or disabled." }, 503);
  }

  const body = await readJson(req);
  const mediaType = String(body.mediaType || "").trim();
  const mediaId = Number(body.mediaId);

  if (!mediaType || !mediaId) {
    return sendJson(res, { ok: false, error: "mediaType and mediaId are required." }, 400);
  }

  try {
    assertSafeOutboundUrl(baseUrl, { label: "Seerr baseUrl" });
  } catch (error) {
    return sendJson(res, { ok: false, error: error.message || "Invalid Seerr baseUrl" }, 400);
  }

  try {
    const payload = { mediaType, mediaId };
    if (body.is4k) payload.is4k = true;
    if (mediaType === "tv") {
      const seasons = Array.isArray(body.seasons)
        ? body.seasons
            .map((season) => Number(typeof season === "object" ? season?.seasonNumber : season))
            .filter((season) => Number.isInteger(season) && season > 0)
        : [];
      // Seerr's request handler expects `seasons` to be either an array of season
      // numbers or the string "all" — anything else (including a missing field)
      // throws server-side, so always send one of those two shapes.
      payload.seasons = seasons.length ? [...new Set(seasons)] : "all";
    }

    const seerrRes = await fetch(`${baseUrl}/api/v1/request`, {
      method: "POST",
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    const responseBody = await seerrRes.json().catch(() => ({}));

    if (!seerrRes.ok) {
      const errMsg = responseBody?.message || responseBody?.error || `Seerr returned ${seerrRes.status}`;
      return sendJson(res, { ok: false, error: errMsg }, 502);
    }

    invalidateSeerrMediaStatus(mediaType, mediaId);
    return sendJson(res, { ok: true, requestId: responseBody?.id || null });
  } catch (err) {
    return sendJson(res, { ok: false, error: err.message || "Connection to Seerr failed" }, 502);
  }
}

function activeMediaTargets(config = {}) {
  const targets = [];
  if (!config.plex?.disabled && config.plex?.baseUrl && config.plex?.token) targets.push("plex");
  if (!config.emby?.disabled && config.emby?.baseUrl && config.emby?.apiKey && config.emby?.userId) targets.push("emby");
  if (!config.jellyfin?.disabled && config.jellyfin?.baseUrl && config.jellyfin?.apiKey && config.jellyfin?.userId) targets.push("jellyfin");
  return targets;
}

function valueLooks4k(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return false;
  return text.includes("4k") || text.includes("2160") || text.includes("uhd");
}

function mediaItemLooks4k(item = {}) {
  const stack = [item];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const width = Number(current.width || current.Width || current.videoWidth || current.VideoWidth || 0);
    const height = Number(current.height || current.Height || current.videoHeight || current.VideoHeight || 0);
    if (width >= 3800 || height >= 2000) return true;
    for (const key of ["videoResolution", "VideoResolution", "resolution", "Resolution", "displayTitle", "DisplayTitle", "Name", "name"]) {
      if (valueLooks4k(current[key])) return true;
    }
    for (const key of ["Media", "media", "MediaSources", "mediaSources", "MediaStreams", "mediaStreams", "Streams", "streams"]) {
      const next = current[key];
      if (Array.isArray(next)) stack.push(...next);
      else if (next && typeof next === "object") stack.push(next);
    }
  }
  return false;
}

const RESOLUTION_RANK = { SD: 0, "480p": 1, "576p": 1, "720p": 2, "1080p": 3, "4K": 4 };

function resolutionLabelFromDimensions(width, height) {
  const long = Math.max(Number(width) || 0, Number(height) || 0);
  if (long >= 3800) return "4K";
  if (long >= 1900) return "1080p";
  if (long >= 1200) return "720p";
  if (long >= 960) return "576p";
  if (long >= 700) return "480p";
  return long > 0 ? "SD" : null;
}

function resolutionLabelFromText(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return null;
  if (text.includes("4k") || text.includes("2160") || text.includes("uhd")) return "4K";
  if (text.includes("1080")) return "1080p";
  if (text.includes("720")) return "720p";
  if (text.includes("576")) return "576p";
  if (text.includes("480")) return "480p";
  if (/\bsd\b/.test(text)) return "SD";
  return null;
}

// Walks the same server-specific shapes as mediaItemLooks4k, but keeps the highest-ranked
// resolution label found instead of just a 4K boolean, so episode rows can show 720p/1080p/4K.
function mediaItemResolutionLabel(item = {}) {
  const stack = [item];
  const seen = new Set();
  let best = null;
  const consider = (label) => {
    if (label && (!best || RESOLUTION_RANK[label] > RESOLUTION_RANK[best])) best = label;
  };
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const width = current.width || current.Width || current.videoWidth || current.VideoWidth;
    const height = current.height || current.Height || current.videoHeight || current.VideoHeight;
    if (width || height) consider(resolutionLabelFromDimensions(width, height));
    for (const key of ["videoResolution", "VideoResolution", "resolution", "Resolution", "displayTitle", "DisplayTitle"]) {
      consider(resolutionLabelFromText(current[key]));
    }
    for (const key of ["Media", "media", "MediaSources", "mediaSources", "MediaStreams", "mediaStreams", "Streams", "streams"]) {
      const next = current[key];
      if (Array.isArray(next)) stack.push(...next);
      else if (next && typeof next === "object") stack.push(next);
    }
  }
  return best;
}

function episodeCoordinate(item = {}) {
  const season = Number(item.parentIndex ?? item.ParentIndexNumber ?? item.SeasonNumber ?? item.seasonNumber ?? item.ParentIndex ?? 0);
  const episode = Number(item.index ?? item.IndexNumber ?? item.EpisodeNumber ?? item.episodeNumber ?? item.Index ?? 0);
  if (!Number.isFinite(season) || !Number.isFinite(episode) || season <= 0 || episode <= 0) return null;
  return { season, episode, key: `${season}|${episode}` };
}

function tmdbSeasonEpisodeIndex(details = {}) {
  const seasons = [];
  const releasedKeys = new Set();
  for (const season of details.seasons || []) {
    const seasonNumber = Number(season.season_number);
    if (!Number.isFinite(seasonNumber) || seasonNumber <= 0) continue;
    const total = Math.max(0, Number(season.episode_count || 0));
    seasons.push({
      seasonNumber,
      total,
      released: total,
      available: 0,
      available4k: 0,
      missingEpisodes: [],
      missing4kEpisodes: [],
    });
    for (let episode = 1; episode <= total; episode += 1) {
      releasedKeys.add(`${seasonNumber}|${episode}`);
    }
  }
  return { seasons, releasedKeys };
}

function summarizeTvAvailability(details = {}, sources = []) {
  const { seasons, releasedKeys } = tmdbSeasonEpisodeIndex(details);
  const availableKeys = new Set();
  const available4kKeys = new Set();
  const resolutionByKey = new Map();

  for (const source of sources) {
    for (const episode of source.episodes || []) {
      const coordinate = episodeCoordinate(episode);
      if (!coordinate) continue;
      availableKeys.add(coordinate.key);
      if (mediaItemLooks4k(episode)) available4kKeys.add(coordinate.key);
      const resolutionLabel = mediaItemResolutionLabel(episode);
      if (resolutionLabel) {
        const existing = resolutionByKey.get(coordinate.key);
        if (!existing || RESOLUTION_RANK[resolutionLabel] > RESOLUTION_RANK[existing]) {
          resolutionByKey.set(coordinate.key, resolutionLabel);
        }
      }
    }
  }

  const seasonSummaries = seasons.map((season) => {
    const missingEpisodes = [];
    const missing4kEpisodes = [];
    let available = 0;
    let available4k = 0;
    for (let episode = 1; episode <= season.released; episode += 1) {
      const key = `${season.seasonNumber}|${episode}`;
      if (availableKeys.has(key)) available += 1;
      else missingEpisodes.push(episode);
      if (available4kKeys.has(key)) available4k += 1;
      else missing4kEpisodes.push(episode);
    }
    return { ...season, available, available4k, missingEpisodes, missing4kEpisodes };
  });

  const totalEpisodes = seasonSummaries.reduce((sum, season) => sum + season.released, 0);
  const availableEpisodes = [...availableKeys].filter((key) => releasedKeys.has(key)).length;
  const available4kEpisodes = [...available4kKeys].filter((key) => releasedKeys.has(key)).length;

  return {
    checked: true,
    available: totalEpisodes > 0 && availableEpisodes >= totalEpisodes,
    partial: availableEpisodes > 0 && availableEpisodes < totalEpisodes,
    available4k: totalEpisodes > 0 && available4kEpisodes >= totalEpisodes,
    partial4k: available4kEpisodes > 0 && available4kEpisodes < totalEpisodes,
    totalEpisodes,
    availableEpisodes,
    available4kEpisodes,
    seasons: seasonSummaries,
    episodeResolutions: Object.fromEntries(resolutionByKey),
    sources: sources.map((source) => ({
      target: source.target,
      availableEpisodes: source.episodes?.length || 0,
      error: source.error,
    })),
  };
}

async function mediaFromTmdbStatusRequest(mediaType, mediaId) {
  const type = mediaType === "movie" ? "movie" : "series";
  let details = {};
  try {
    details = await getTmdbDetails({ mediaType: mediaType === "movie" ? "movie" : "tv", tmdbId: mediaId });
  } catch (error) {
    details = {};
  }
  const externalIds = details.external_ids || {};
  return {
    type,
    title: details.title || details.name || "",
    ids: {
      imdb: details.imdb_id || externalIds.imdb_id || undefined,
      tmdb: String(mediaId),
      tvdb: externalIds.tvdb_id ? String(externalIds.tvdb_id) : undefined,
    },
    details,
  };
}

async function mediaFromAppLinksRequest(req) {
  const mediaType = String(req.query.mediaType || "").trim().toLowerCase() === "tv" ? "tv" : "movie";
  const tmdbId = String(req.query.tmdbId || req.query.mediaId || "").trim();
  const requestedIds = {
    imdb: String(req.query.imdbId || "").trim() || undefined,
    tmdb: tmdbId || undefined,
    tvdb: String(req.query.tvdbId || "").trim() || undefined,
  };
  const requestedTitle = String(req.query.title || "").trim();

  let media = {
    type: mediaType === "tv" ? "series" : "movie",
    title: requestedTitle,
    ids: requestedIds,
  };

  if (tmdbId) {
    const tmdbMedia = await mediaFromTmdbStatusRequest(mediaType, tmdbId);
    media = {
      ...tmdbMedia,
      title: requestedTitle || tmdbMedia.title,
      ids: {
        ...tmdbMedia.ids,
        ...Object.fromEntries(Object.entries(requestedIds).filter(([, value]) => value)),
      },
    };
  }

  return media;
}

async function plexMachineIdentifier(config = {}) {
  if (!config.baseUrl || !config.token) return "";
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/identity`);
  try {
    const response = await fetchWithTimeout(url, { headers: { Accept: "application/json", "X-Plex-Token": config.token } });
    if (!response.ok) return "";
    const body = await response.json().catch(() => ({}));
    return String(body?.MediaContainer?.machineIdentifier || body?.machineIdentifier || "").trim();
  } catch {
    return "";
  }
}

async function plexWebUrl(config = {}, item = {}) {
  const ratingKey = item?.ratingKey || item?.key;
  if (!config.baseUrl || !ratingKey) return "";
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const key = `/library/metadata/${ratingKey}`;
  const machineId = await plexMachineIdentifier(config);
  const route = machineId
    ? `#!/server/${encodeURIComponent(machineId)}/details?key=${encodeURIComponent(key)}`
    : `#!/details?key=${encodeURIComponent(key)}`;
  return `${baseUrl}/web/index.html${route}`;
}

async function embyServerId(config = {}) {
  if (!config.baseUrl) return "";
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/System/Info/Public`);
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: "application/json",
        ...(config.apiKey ? { "X-Emby-Token": config.apiKey } : {}),
      },
    }, 8000);
    if (!response.ok) return "";
    const body = await response.json().catch(() => ({}));
    return String(body?.Id || body?.ServerId || "").trim();
  } catch {
    return "";
  }
}

function embyItemContext(item = {}, media = {}) {
  const type = String(item.Type || item.type || media.type || "").toLowerCase();
  if (type === "series" || type === "episode" || type === "show") return "tvshows";
  if (type === "movie") return "movies";
  return "";
}

async function embyWebUrl(config = {}, item = {}, media = {}) {
  if (!config.baseUrl || !item?.Id) return "";
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/web/index.html`);
  const routeParams = new URLSearchParams({ id: String(item.Id) });
  const serverId = await embyServerId(config);
  const context = embyItemContext(item, media);
  if (serverId) routeParams.set("serverId", serverId);
  if (context) routeParams.set("context", context);
  return `${url.toString()}#!/item?${routeParams.toString()}`;
}

function jellyfinWebUrl(config = {}, item = {}) {
  if (!config.baseUrl || !item?.Id) return "";
  return `${trimTrailingSlash(config.baseUrl)}/web/#/details?id=${encodeURIComponent(item.Id)}`;
}

// Bundled locally rather than hotlinked from the media server: favicon.ico isn't
// reliably served at that path across Plex/Emby/Jellyfin versions and self-hosted
// TLS setups, which left the "Open in" pills showing text only, with no icon.
function appIconUrl(config = {}, target = "") {
  if (!config.baseUrl) return "";
  if (target === "plex" || target === "emby" || target === "jellyfin") return `/icons/${target}.svg`;
  return "";
}

async function fetchConfiguredAppLinks(config = {}, media = {}) {
  const targets = activeMediaTargets(config);
  const jobs = targets.map(async (target) => {
    try {
      if (target === "plex") {
        const item = await findPlexItem(config.plex, media);
        const url = await plexWebUrl(config.plex, item);
        return url ? { target, label: "Plex", url, iconUrl: appIconUrl(config.plex, target) } : null;
      }
      if (target === "emby") {
        const items = await findEmbyItems(config.emby, media);
        const url = await embyWebUrl(config.emby, items?.[0], media);
        return url ? { target, label: "Emby", url, iconUrl: appIconUrl(config.emby, target) } : null;
      }
      if (target === "jellyfin") {
        const items = await findJellyfinItems(config.jellyfin, media);
        const url = jellyfinWebUrl(config.jellyfin, items?.[0]);
        return url ? { target, label: "Jellyfin", url, iconUrl: appIconUrl(config.jellyfin, target) } : null;
      }
    } catch (error) {
      console.warn(`App link lookup failed for ${target}: ${error.message || error}`);
    }
    return null;
  });
  return (await Promise.all(jobs)).filter(Boolean);
}

async function handleMediaAppLinks(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const media = await mediaFromAppLinksRequest(req);
  if (!media.title && !media.ids?.imdb && !media.ids?.tmdb && !media.ids?.tvdb) {
    return sendJson(res, { ok: false, error: "A title or external ID is required." }, 400);
  }

  const config = await loadMediaConfig();
  const links = await fetchConfiguredAppLinks(config, media);
  return sendJson(res, { ok: true, links }, 200, { "Cache-Control": "no-store" });
}

async function fetchConfiguredAppAvailability(config = {}, media = {}) {
  const targets = activeMediaTargets(config);
  if (!targets.length) {
    return { checked: false, available: false, available4k: false, sources: [] };
  }

  if (media.type === "series" || media.type === "show") {
    const sources = await Promise.all(targets.map(async (target) => {
      try {
        if (target === "plex") return { target, episodes: await fetchPlexSeriesEpisodes(config.plex, media) };
        if (target === "emby") return { target, episodes: await fetchEmbySeriesEpisodes(config.emby, media) };
        if (target === "jellyfin") return { target, episodes: await fetchJellyfinSeriesEpisodes(config.jellyfin, media) };
      } catch (error) {
        return { target, episodes: [], error: error.message || "Lookup failed" };
      }
      return { target, episodes: [] };
    }));
    return summarizeTvAvailability(media.details || {}, sources);
  }

  const jobs = targets.map(async (target) => {
    try {
      if (target === "plex") {
        const item = await findPlexItem(config.plex, media);
        return { target, available: Boolean(item?.ratingKey), available4k: mediaItemLooks4k(item) };
      }
      if (target === "emby") {
        const items = await findEmbyItems(config.emby, media);
        return { target, available: items.length > 0, available4k: items.some(mediaItemLooks4k) };
      }
      if (target === "jellyfin") {
        const items = await findJellyfinItems(config.jellyfin, media);
        return { target, available: items.length > 0, available4k: items.some(mediaItemLooks4k) };
      }
    } catch (error) {
      return { target, available: false, available4k: false, error: error.message || "Lookup failed" };
    }
    return { target, available: false, available4k: false };
  });

  const sources = await Promise.all(jobs);
  return {
    checked: true,
    available: sources.some((source) => source.available),
    available4k: sources.some((source) => source.available4k),
    sources,
  };
}

async function handleSeerrMediaStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const config = await loadMediaConfig();
  const { baseUrl, apiKey, disabled } = config.seerr || {};

  if (disabled || !baseUrl || !apiKey) {
    return sendJson(res, { ok: false, error: "Seerr is not configured or disabled." }, 503);
  }

  const mediaType = String(req.query.mediaType || "").trim();
  const mediaId = Number(req.query.mediaId);
  if (!mediaType || !mediaId) {
    return sendJson(res, { ok: false, error: "mediaType and mediaId are required." }, 400);
  }

  const cacheKey = seerrMediaStatusCacheKey(mediaType, mediaId);
  const cached = seerrMediaStatusCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAtMs < SEERR_MEDIA_STATUS_TTL_MS && !req.query.forceRefresh) {
    return sendJson(res, cached.body);
  }

  try {
    assertSafeOutboundUrl(baseUrl, { label: "Seerr baseUrl" });
  } catch (error) {
    return sendJson(res, { ok: false, error: error.message || "Invalid Seerr baseUrl" }, 400);
  }

  const localMedia = await mediaFromTmdbStatusRequest(mediaType, mediaId);
  const configuredAppStatus = await fetchConfiguredAppAvailability(config, localMedia);
  const headers = { "X-Api-Key": apiKey, Accept: "application/json" };
  const paths = [
    `/api/v1/media/${mediaType}/${mediaId}`,
    `/api/v1/${mediaType}/${mediaId}`,
  ];

  try {
    let media = null;
    let lastErrorMsg = "";
    for (const path of paths) {
      try {
        const seerrRes = await fetch(`${baseUrl}${path}`, {
          headers,
          signal: AbortSignal.timeout(8000),
        });
        if (!seerrRes.ok) {
          const body = await seerrRes.json().catch(() => ({}));
          lastErrorMsg = body?.message || body?.error || `Seerr returned ${seerrRes.status}`;
          continue;
        }
        const body = await seerrRes.json().catch(() => ({}));
        media = body?.mediaInfo || body;
        break;
      } catch (err) {
        lastErrorMsg = err.message || "Connection failed";
        continue;
      }
    }

    if (!media) {
      if (configuredAppStatus.checked) {
        const body = {
          ok: true,
          found: false,
          ...configuredAppStatus,
          available: configuredAppStatus.available,
          available4k: configuredAppStatus.available4k,
          pending: false,
          pending4k: false,
          status: 0,
          status4k: 0,
          availabilitySource: "configured_apps",
          configuredAppStatus,
          seerrError: lastErrorMsg || "Media not found on Seerr",
        };
        setSeerrMediaStatusCache(cacheKey, { cachedAtMs: Date.now(), body });
        return sendJson(res, body);
      }
      return sendJson(res, { ok: false, error: lastErrorMsg || "Media not found on Seerr" }, 502);
    }

    const status = Number(media?.status ?? media?.mediaStatus ?? 0);
    const status4k = Number(media?.status4k ?? media?.mediaStatus4k ?? 0);
    const requested = Boolean(media?.requests?.some?.((request) => !request?.is4k) || media?.request || media?.requested);
    const requested4k = Boolean(media?.requests?.some?.((request) => request?.is4k) || media?.request4k || media?.requested4k);
    const seerrAvailable = Boolean(media?.available || status === 5);
    const seerrAvailable4k = Boolean(media?.available4k || status4k === 5);
    const available = configuredAppStatus.checked ? configuredAppStatus.available : false;
    const available4k = configuredAppStatus.checked ? configuredAppStatus.available4k : false;
    const pending = !available && Boolean(requested || [2, 3, 4].includes(status));
    const pending4k = !available4k && Boolean(requested4k || [2, 3, 4].includes(status4k));

    const body = {
      ok: true,
      found: Boolean(media),
      ...configuredAppStatus,
      available,
      available4k,
      pending,
      pending4k,
      status,
      status4k,
      availabilitySource: configuredAppStatus.checked ? "configured_apps" : "none",
      configuredAppStatus,
      seerrAvailable,
      seerrAvailable4k,
    };
    setSeerrMediaStatusCache(cacheKey, { cachedAtMs: Date.now(), body });
    return sendJson(res, body);
  } catch (err) {
    return sendJson(res, { ok: false, error: err.message || "Connection to Seerr failed" }, 502);
  }
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

  const dedupe = !["0", "false", "no"].includes(String(req.query.dedupe || "").toLowerCase());
  const includeStats = !["0", "false", "no"].includes(statsMode);
  const requestedLimit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const historyPromise = queryWatchHistory(requireDb(), { search: req.query.search || "", mediaType: req.query.mediaType || "", limit: requestedLimit + 1, offset: req.query.offset || 0, dedupe });
  const historyVersionPromise = getHistoryCacheVersion();

  if (!includeStats) {
    const [historyRows, historyVersion] = await Promise.all([historyPromise, historyVersionPromise]);
    const hasMore = historyRows.length > requestedLimit;
    return sendJson(res, { history: historyRows.slice(0, requestedLimit), hasMore, historyVersion });
  }

  const [historyRows, stats, historyVersion] = await Promise.all([
    historyPromise,
    getWatchStats(requireDb()),
    historyVersionPromise,
  ]);
  const hasMore = historyRows.length > requestedLimit;
  return sendJson(res, { history: historyRows.slice(0, requestedLimit), hasMore, stats, historyVersion });
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

async function handleClearMissingTelemetry(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const db = requireDb();
    const clearStmt = db.prepare(`
      UPDATE watch_history
      SET sync_dispatch_telemetry = 'Dispatch Status: success'
      WHERE sync_dispatch_telemetry IS NULL OR sync_dispatch_telemetry = ''
    `);
    const result = clearStmt.run();
    await invalidateHistoryDerivedCaches();
    return sendJson(res, { cleared: result.changes });
  } catch (err) {
    console.error("[clearMissingTelemetry] Error:", err);
    return sendJson(res, { error: "Failed to clear telemetry" }, 500);
  }
}

async function handleMovies(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const movies = await queryMovies({ search: req.query.search || "", sort: req.query.sort || "title_asc", limit: req.query.limit || 100, offset: req.query.offset || 0 });
  return sendJson(res, { movies }, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=300", Vary: "Authorization" });
}

// Permanently delete a library item (all its plays + playstate + progress).
// Destructive and irreversible — the client must send confirm: "DELETE".
async function handleDeleteMedia(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST" && req.method !== "DELETE") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const id = String(body.id || "").trim();
  if (!id) return sendJson(res, { error: "id is required" }, 400);
  if (String(body.confirm || "") !== "DELETE") {
    return sendJson(res, { error: "Confirmation required" }, 400);
  }

  try {
    const result = await deleteMovieByWatchId(id);
    if (!result.found) return sendJson(res, { error: "Media item not found" }, 404);
    writeAuditLog("media.deleted", { ip: req.ip || req.socket?.remoteAddress, detail: { id, title: result.title } });
    return sendJson(res, { ok: true, deleted: result.deleted, title: result.title }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Failed to delete media item", error);
    return sendJson(res, { error: error.message || "Failed to delete media item" }, 500);
  }
}

async function handleShows(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const shows = await queryShows({
    search: req.query.search || "",
    sort: req.query.sort || "title_asc",
    limit: req.query.limit || 6,
    offset: req.query.offset || 0,
    hideWatched: req.query.hideWatched === "true",
    hideEnded: req.query.hideEnded === "true",
  });
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
  const response = await fetchWithTimeout(deviceCodeEndpoint(tenant), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  }, 15_000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || `Device code request failed (${response.status})`);

  // Drop expired sessions (otherwise they only leave the map when polled).
  for (const [id, session] of deviceCodeSessions) {
    if (session.expiresAt < Date.now()) deviceCodeSessions.delete(id);
  }
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
  const response = await fetchWithTimeout(tokenEndpoint(session.tenant), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  }, 15_000);
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
  const response = await fetchWithTimeout("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  }, 15_000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.refresh_token) {
    throw new Error(data.error_description || data.error || "Dropbox authorization failed");
  }
  updateDestinationSecrets(destination.id, { refreshToken: data.refresh_token });
  return { status: "authorized" };
}

// Small forward cushion so an app-recorded "viewedAt" stamped a moment after our push
// can't land just past lastRestoreAt and get re-imported. See setLastRestoreAt().
const RESTORE_SKEW_BUFFER_MS = 5000;
const POST_RESTORE_WEBHOOK_GUARD_MS = 24 * 60 * 60 * 1000;
// How many items the restore push/clear processes at once, and the per-item timeout so a single
// hung app call can't stall the whole job.
const RESTORE_PUSH_CONCURRENCY = Math.min(Math.max(Number(process.env.PLEMBFIN_RESTORE_CONCURRENCY || 24), 1), 64);
const RESTORE_ITEM_TIMEOUT_MS = 30000;

function normalizedTitlePart(value = "") {
  return String(value || "").trim().toLowerCase();
}

function mediaIdsOverlap(a = {}, b = {}) {
  const idsA = a.ids || {};
  const idsB = b.ids || {};
  return Boolean(
    (idsA.imdb && idsB.imdb && String(idsA.imdb) === String(idsB.imdb)) ||
      (idsA.tmdb && idsB.tmdb && String(idsA.tmdb) === String(idsB.tmdb)) ||
      (idsA.tvdb && idsB.tvdb && String(idsA.tvdb) === String(idsB.tvdb)),
  );
}

function sameMediaCoordinates(a = {}, b = {}) {
  if (String(a.source || "") !== String(b.source || "")) return false;
  if (String(a.type || a.mediaType || "") !== String(b.type || b.mediaType || "")) return false;
  if (String(a.type || a.mediaType || "") === "episode") {
    if (Number(a.season ?? -1) !== Number(b.season ?? -1)) return false;
    if (Number(a.episode ?? -1) !== Number(b.episode ?? -1)) return false;
  }
  return mediaIdsOverlap(a, b) || normalizedTitlePart(a.title) === normalizedTitlePart(b.title);
}

async function shouldSkipPostRestoreCompletedWebhook(media) {
  if (media?.phase !== "completed") return false;
  const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
  if (!lastRestoreAt || Date.now() - lastRestoreAt > POST_RESTORE_WEBHOOK_GUARD_MS) return false;

  const activeSessions = await listActiveSessions().catch(() => []);
  const matchingActiveSession = activeSessions.find((session) => (
    sameMediaCoordinates(media, {
      title: session.title,
      type: session.mediaType,
      source: session.source,
      ids: session.ids,
      season: session.season,
      episode: session.episode,
    }) && Number(session.updatedAt || 0) > lastRestoreAt
  ));

  return !matchingActiveSession;
}

function withTimeout(promise, ms, label) {
  const p = Promise.resolve(promise);
  // If the timeout wins the race, the underlying promise may still reject later with nobody
  // awaiting it — absorb that so it doesn't surface as an unhandledRejection.
  p.catch(() => {});
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms${label ? `: ${label}` : ""}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Run `worker(item)` over `items` with at most `limit` in flight. The worker is expected to handle
// (count) its own errors; this resolves once every item has been processed.
async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  const runnerCount = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: runnerCount }, async () => {
    while (index < items.length) {
      const current = index++;
      await worker(items[current], current);
    }
  });
  await Promise.all(runners);
}

// Batched runtime-log writer (mirrors the Force-Sync pattern): collect lines in memory and
// flush to runtime_state every `intervalMs` so we don't write per line.
function createBatchedRuntimeLogger(field, { intervalMs = 2000 } = {}) {
  const buffer = [];
  let timer = null;
  const flush = async () => {
    if (!buffer.length) return;
    const batch = buffer.splice(0, buffer.length);
    await appendRuntimeLog(field, batch).catch(() => null);
  };
  const log = (msg) => {
    console.log(msg);
    buffer.push(msg);
    if (!timer) {
      timer = setTimeout(async () => {
        timer = null;
        await flush();
      }, intervalMs);
    }
  };
  const stop = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    await flush();
  };
  return { log, stop };
}

function mediaFromPlaystateRow(row) {
  const media = {
    title: row.title,
    type: row.media_type,
    source: "restore",
    isValid: true,
    ids: {
      imdb: row.imdb_id || undefined,
      tmdb: row.tmdb_id || undefined,
      tvdb: row.tvdb_id || undefined,
    },
  };
  if (String(row.media_type) === "episode") {
    media.season = row.season != null ? Number(row.season) : undefined;
    media.episode = row.episode != null ? Number(row.episode) : undefined;
  }
  return media;
}

// Push the just-restored playstate to every connected app. `source: "restore"` makes
// getTargetsForSource fan out to all three platforms.
async function pushRestoredStateToApps(config, logLine) {
  const loopStore = createLoopStore();
  const rows = requireDb().prepare("SELECT * FROM playstate").all();
  logLine(`Pushing ${rows.length} restored item(s) to connected apps (concurrency ${RESTORE_PUSH_CONCURRENCY})...`);
  let done = 0;
  let watched = 0;
  let unwatched = 0;
  let failed = 0;
  await runWithConcurrency(rows, RESTORE_PUSH_CONCURRENCY, async (row) => {
    const media = mediaFromPlaystateRow(row);
    const isWatched = String(row.state || "watched").toLowerCase() !== "unwatched";
    try {
      if (isWatched) {
        await withTimeout(syncMediaPlaystate(media, config, loopStore), RESTORE_ITEM_TIMEOUT_MS, media.title);
        watched++;
      } else {
        await withTimeout(syncMediaUnplayedPlaystate(media, config, loopStore), RESTORE_ITEM_TIMEOUT_MS, media.title);
        unwatched++;
      }
    } catch (error) {
      failed++;
      logLine(`  ! Failed to push "${media.title}": ${error.message}`);
    }
    done++;
    if (done % 25 === 0 || done === rows.length) {
      logLine(`  Pushed ${done}/${rows.length} (watched ${watched}, unwatched ${unwatched}, failed ${failed})`);
    }
  });
  return { total: rows.length, watched, unwatched, failed };
}

// Full-wipe clear pass: mark every item each app currently reports as watched as unwatched,
// so that the subsequent push re-marks only the backup's watched set and the apps end up
// matching the backup exactly. Operates on native item ids (no re-resolution).
async function clearAppWatchstates(config, logLine) {
  const summary = { plex: 0, emby: 0, jellyfin: 0, failed: 0 };
  const plexActive = !config?.plex?.disabled && Boolean(config?.plex?.baseUrl && config?.plex?.token);
  const embyActive = !config?.emby?.disabled && Boolean(config?.emby?.baseUrl && config?.emby?.apiKey && config?.emby?.userId);
  const jellyfinActive = !config?.jellyfin?.disabled && Boolean(config?.jellyfin?.baseUrl && config?.jellyfin?.apiKey && config?.jellyfin?.userId);

  // Mark one platform's watched items unplayed, in parallel with a per-item timeout.
  const clearPlatform = async (items, getId, unmark) => {
    let cleared = 0;
    let failed = 0;
    await runWithConcurrency(items, RESTORE_PUSH_CONCURRENCY, async (item) => {
      try {
        await withTimeout(unmark(getId(item)), RESTORE_ITEM_TIMEOUT_MS);
        cleared++;
      } catch (error) {
        failed++;
      }
    });
    return { cleared, failed };
  };

  if (plexActive) {
    try {
      const items = await fetchPlexWatchedItems(config.plex);
      logLine(`Clearing ${items.length} watched item(s) on Plex...`);
      const r = await clearPlatform(items, (i) => i.ratingKey || i.key, (id) => markPlexUnplayedByRatingKey(config.plex, id));
      summary.plex = r.cleared;
      summary.failed += r.failed;
    } catch (error) {
      logLine(`  ! Plex clear failed: ${error.message}`);
    }
  }
  if (embyActive) {
    try {
      const items = await fetchEmbyWatchedItems(config.emby);
      logLine(`Clearing ${items.length} watched item(s) on Emby...`);
      const r = await clearPlatform(items, (i) => i.Id, (id) => markEmbyUnplayedById(config.emby, id));
      summary.emby = r.cleared;
      summary.failed += r.failed;
    } catch (error) {
      logLine(`  ! Emby clear failed: ${error.message}`);
    }
  }
  if (jellyfinActive) {
    try {
      const items = await fetchJellyfinWatchedItems(config.jellyfin);
      logLine(`Clearing ${items.length} watched item(s) on Jellyfin...`);
      const r = await clearPlatform(items, (i) => i.Id, (id) => markJellyfinUnplayedById(config.jellyfin, id));
      summary.jellyfin = r.cleared;
      summary.failed += r.failed;
    } catch (error) {
      logLine(`  ! Jellyfin clear failed: ${error.message}`);
    }
  }
  return summary;
}

// Background reconcile job, kicked off after the synchronous DB restore. Optionally wipes app
// watchstates, pushes the restored state to all apps, then stamps lastRestoreAt (AFTER the push
// so the pushes themselves fall under the cron's pre-restore filter) and clears the active flag.
async function runRestoreReconcileJob(clearMode) {
  const { log, stop } = createBatchedRuntimeLogger("restoreSyncLog");
  // Keep the restore guard's heartbeat fresh for the entire job so the cron never treats a
  // long-but-alive restore as stale and un-blocks itself mid-push. Fires independently of where
  // the job is (even inside a long library fetch).
  await setRuntimeState({ restoreSyncHeartbeat: Date.now() }).catch(() => null);
  const heartbeat = setInterval(() => {
    setRuntimeState({ restoreSyncHeartbeat: Date.now() }).catch(() => null);
  }, 30000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();
  let result;
  try {
    const config = await loadMediaConfig();
    if (clearMode === "wipe") {
      log("Clear mode: full wipe — marking every watched item on each app as unwatched.");
      const cleared = await clearAppWatchstates(config, log);
      log(`Clear complete: Plex ${cleared.plex}, Emby ${cleared.emby}, Jellyfin ${cleared.jellyfin}, failed ${cleared.failed}.`);
    } else {
      log("Clear mode: reconcile — pushing only items tracked by the backup.");
    }
    const pushed = await pushRestoredStateToApps(config, log);
    log(`Push complete: ${pushed.watched} watched, ${pushed.unwatched} unwatched, ${pushed.failed} failed.`);
    result = { success: true, clearMode, pushed };
  } catch (error) {
    log(`ERROR: Restore reconcile failed: ${error.message}`);
    result = { success: false, error: error.message };
  } finally {
    clearInterval(heartbeat);
    // Always advance the watermark: after a successful DB restore the local DB IS the backup,
    // so the cron should ignore any app history at/before now regardless of push outcome.
    const stampedAt = Date.now() + RESTORE_SKEW_BUFFER_MS;
    setLastRestoreAt(stampedAt);
    log(`Stamped lastRestoreAt = ${new Date(stampedAt).toISOString()}; cron will skip app history up to this point.`);
    log("✓ Authoritative restore complete.");
    await stop();
    // Clear the active flag LAST (after lastRestoreAt is stamped) so the first allowed cron tick
    // already sees the watermark.
    await setRuntimeState({ restoreSyncActive: false, restoreSyncResult: result || { success: false } }).catch(() => null);
  }
  return result;
}

// Run the synchronous DB restore, then kick off the background clear/push job. Shared by the
// local "restore" and remote "restore-remote-backup" actions. Returns the response payload.
async function startAuthoritativeRestore(filename, clearMode) {
  const runtime = await loadRuntimeState();
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  if (runtime.restoreSyncActive === true && runtime.restoreSyncStartedAt && runtime.restoreSyncStartedAt > tenMinutesAgo) {
    return { status: 409, body: { ok: false, error: "An authoritative restore is already running." } };
  }

  // Mark active BEFORE touching the DB so the cron + webhook stop importing immediately.
  await setRuntimeState({
    restoreSyncActive: true,
    restoreSyncStartedAt: Date.now(),
    restoreSyncHeartbeat: Date.now(),
    restoreSyncResult: null,
    restoreSyncLog: [`Authoritative restore started (${clearMode}) from ${filename}...`],
  });

  let restore;
  try {
    restore = restoreWatchHistoryBackup(filename, { mode: "replace", dryRun: false });
    writeAuditLog("backup.restored", { detail: { filename, clearMode, records: restore?.imported } });
  } catch (error) {
    await setRuntimeState({ restoreSyncActive: false, restoreSyncResult: { success: false, error: error.message } }).catch(() => null);
    return { status: 400, body: { error: error.message } };
  }

  // Fire-and-forget — the job stamps lastRestoreAt and clears the flag when it finishes.
  runRestoreReconcileJob(clearMode);

  return { status: 202, body: { ok: true, restore, clearMode, jobStarted: true } };
}

async function handleWatchBackups(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;

  if (req.method === "GET") {
    const filename = String(req.query?.download || "").trim();
    if (!filename) {
      const runtime = await loadRuntimeState();
      return sendJson(res, {
        ...watchBackupStatus(),
        restoreSync: {
          active: runtime.restoreSyncActive === true,
          log: Array.isArray(runtime.restoreSyncLog) ? runtime.restoreSyncLog : [],
          result: runtime.restoreSyncResult || null,
          startedAt: runtime.restoreSyncStartedAt || null,
        },
      });
    }
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
  if (String(req.query?.upload || "") === "1") {
    try {
      const uploaded = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
      const filename = String(req.query?.filename || "");
      return sendJson(res, { ok: true, file: importWatchHistoryBackupFile({ filename, buffer: uploaded }) });
    } catch (error) {
      return sendJson(res, { error: error.message }, 400);
    }
  }

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

      const dryRun = body.dryRun === true;
      if (dryRun) {
        // Replace-only: restore is always authoritative; merge is no longer offered.
        return sendJson(res, {
          ok: true,
          restore: restoreWatchHistoryBackup(filename, { mode: "replace", dryRun: true }),
        });
      }

      const clearMode = body.clearMode === "wipe" ? "wipe" : "reconcile";
      const { status, body: payload } = await startAuthoritativeRestore(filename, clearMode);
      return sendJson(res, payload, status);
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
      const remoteDryRun = body.dryRun === true;
      if (!id || !filename) return sendJson(res, { error: "destinationId and filename are required" }, 400);
      const pulled = await pullRemoteBackupToLocal(id, filename);
      if (remoteDryRun) {
        return sendJson(res, {
          ok: true,
          pulled,
          restore: restoreWatchHistoryBackup(pulled.name, { mode: "replace", dryRun: true }),
        });
      }
      const clearMode = body.clearMode === "wipe" ? "wipe" : "reconcile";
      const { status, body: payload } = await startAuthoritativeRestore(pulled.name, clearMode);
      return sendJson(res, { ...payload, pulled }, status);
    }
    if (action === "clear-restore-status") {
      return sendJson(res, { ok: true, ...clearRestoreStatus() });
    }
    if (action === "pause-cron") {
      const hours = Math.max(1, Math.min(48, Number(body.hours) || 12));
      return sendJson(res, { ok: true, ...pauseCronSync(hours * 3600000) });
    }
    if (action === "resume-cron") {
      return sendJson(res, { ok: true, ...resumeCronSync() });
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

async function handlePlembfinBackups(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;

  if (req.method === "GET") {
    const filename = String(req.query?.download || "").trim();
    if (!filename) {
      return sendJson(res, plembfinBackupStatus());
    }
    try {
      const file = readPlembfinBackupFile(filename);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      const buffer = Buffer.from(file.content, "utf8");
      res.setHeader("Content-Length", String(buffer.length));
      return res.end(buffer);
    } catch (error) {
      return sendJson(res, { error: error.message }, 404);
    }
  }

  if (req.method !== "POST") return methodNotAllowed(res);
  const body = await readJson(req);
  const action = String(body.action || "").trim();
  try {
    if (action === "configure") {
      return sendJson(res, { ok: true, config: savePlembfinBackupConfig(body.config || {}) });
    }
    if (action === "create") {
      const passphrase = String(body.passphrase || "").trim();
      return sendJson(res, { ok: true, backup: await createPlembfinBackup({ reason: "manual", passphrase }) });
    }
    if (action === "delete") {
      const filename = String(body.filename || "").trim();
      if (!filename) return sendJson(res, { error: "filename is required" }, 400);
      return sendJson(res, { ok: true, ...deletePlembfinBackup(filename) });
    }
    return sendJson(res, { error: `Unsupported action: ${action}` }, 400);
  } catch (error) {
    return sendJson(res, { error: error.message }, 500);
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

function showTitleFromProgressTitle(title = "") {
  const text = String(title || "").trim() || "Unknown Show";
  const seasonMatch = text.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  if (seasonMatch?.[1]) return seasonMatch[1].trim() || "Unknown Show";
  return text.split(" - ")[0].trim() || "Unknown Show";
}

async function enrichProgressWatchRecordWithTmdb(record = {}, body = {}) {
  const mediaType = record.media_type === "episode" ? "tv" : record.media_type;
  if (!["movie", "tv"].includes(mediaType)) return record;

  const ids = {
    imdbId: body.imdb_id || body.imdbId || body.imdb || record.imdb_id,
    tvdbId: body.tvdb_id || body.tvdbId || body.tvdb || record.tvdb_id,
  };
  const title = mediaType === "tv" ? showTitleFromProgressTitle(record.title) : record.title;
  const tmdbId = body.tmdb_id || body.tmdbId || body.tmdb || record.tmdb_id;

  if (tmdbId && record.tmdb_id) return record;

  try {
    const details = await getTmdbDetails({ mediaType, tmdbId, title, ids });
    if (details?.id && !record.tmdb_id) record.tmdb_id = String(details.id);
    const externalIds = details?.external_ids || {};
    if (!record.imdb_id && externalIds.imdb_id) record.imdb_id = externalIds.imdb_id;
    if (!record.tvdb_id && externalIds.tvdb_id) record.tvdb_id = String(externalIds.tvdb_id);
  } catch (error) {
    console.warn("Progress watch TMDB enrichment skipped", {
      title: record.title,
      mediaType: record.media_type,
      reason: error.message || String(error),
    });
  }

  return record;
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
async function applyManualUnwatch(media, config, loopStore, recordId = "", { includeSourcePlatform = false } = {}) {
  let wasDeleted = false;
  if (recordId) {
    wasDeleted = await deleteWatchRecordById(recordId, { skipInvalidate: true }).catch((error) => {
      console.error("Failed to delete watch record by id", error);
      return false;
    });
  }
  const wasDeletedByMediaKey = await deleteWatchRecord(requireDb(), media, { skipInvalidate: true }).catch((error) => {
    console.error("Failed to delete watch record", error);
    return false;
  });
  wasDeleted = wasDeleted || wasDeletedByMediaKey;
  await deletePlaybackProgress(requireDb(), media).catch(() => null);

  const pendingSummary = { skipped: false, status: "pending", details: "Unwatched propagation queued", targetStates: [] };
  const unplayedRecord = mediaToWatchRecord({ ...media, syncAction: "unwatched" }, media.source);
  unplayedRecord.sync_action = "unwatched";
  unplayedRecord.sync_dispatch_telemetry = formatDispatchTelemetry(pendingSummary, media, "unwatched");
  const result = await insertWatchRecord(requireDb(), unplayedRecord, { skipInvalidate: true });
  await upsertPlaystateForMedia(requireDb(), media, "unwatched", result.record.watched_at, { skipInvalidate: true });

  // Clear resume progress on all target platforms to prevent re-import on next sync
  // Use direct platform calls since shouldSyncResumeProgress blocks position 0
  const syncMedia = includeSourcePlatform ? { ...media, source: "manual" } : media;
  const targets = getTargetsForSource(syncMedia.source, config);
  for (const target of targets) {
    try {
      if (target === "plex") await setPlexProgress(config.plex, { ...media, positionMs: 0 });
      if (target === "emby") await setEmbyProgress(config.emby, { ...media, positionMs: 0 });
      if (target === "jellyfin") await setJellyfinProgress(config.jellyfin, { ...media, positionMs: 0 });
    } catch (error) {
      console.log(`Resume progress clear on ${target} during unwatch failed (non-fatal)`, error.message);
    }
  }

  const summary = await syncMediaUnplayedPlaystate(syncMedia, config, loopStore).catch((error) => ({
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
    const { id: unwatchedId, summary } = await applyManualUnwatch(media, config, loopStore, id, { includeSourcePlatform: true });
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
      const { data, record } = normalizeWatchRecordForInsert(pending, "manual");
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

async function handlePlaybackProgressList(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const rows = await listPlaybackProgressRowsForReplay({ limit, offset });
    const total = await countPlaybackProgressRows();

    const decoratedRows = await Promise.all(rows.map(async (row) => {
      const mediaKey = row.media_key;
      let posterUrl = null;
      try {
        const cached = await getPosterCache(mediaKey);
        if (cached && (cached.url || cached.cached)) {
          posterUrl = cached.url || "/favicon.svg";
        }
      } catch (err) {
        // ignore
      }
      return { ...row, poster_url: posterUrl };
    }));

    return sendJson(res, { progress: decoratedRows, total });
  } catch (error) {
    console.error("Failed to list playback progress", error);
    return sendJson(res, { error: "Failed to list playback progress", details: error.message }, 500);
  }
}

async function handlePlaybackProgressWatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const mediaKey = String(body.media_key || "").trim();
  if (!mediaKey) return sendJson(res, { error: "media_key is required" }, 400);

  try {
    const progressRow = db.prepare("SELECT * FROM playback_progress WHERE media_key = ?").get(mediaKey);
    if (!progressRow) return sendJson(res, { error: "Playback progress item not found" }, 404);

    const config = await loadMediaConfig();
    const loopStore = createLoopStore();

    const record = {
      title: progressRow.title,
      media_type: progressRow.media_type,
      source: progressRow.source || "manual",
      imdb_id: body.imdb_id || body.imdbId || body.imdb || progressRow.imdb_id || null,
      tmdb_id: body.tmdb_id || body.tmdbId || body.tmdb || progressRow.tmdb_id || null,
      tvdb_id: body.tvdb_id || body.tvdbId || body.tvdb || progressRow.tvdb_id || null,
      season: progressRow.season ?? null,
      episode: progressRow.episode ?? null,
      watched_at: body.watched_at || Date.now(),
      sync_action: "watched",
      sync_dispatch_telemetry: "Origin: progress_resolve\nLoop-check: Passed\nDispatch status: pending\nDetails: Manual watch propagation queued.",
    };
    await enrichProgressWatchRecordWithTmdb(record, body);

    const { data, record: normalizedRecord } = normalizeWatchRecordForInsert(record, "manual");
    const existing = await findExistingWatch(data.mediaKey || mediaKeyFor(normalizedRecord), data.watchedAt);

    const media = manualWatchMediaFromRecord(normalizedRecord);
    let id = "";
    if (!existing) {
      const insertResult = await insertWatchRecord(requireDb(), normalizedRecord, { skipInvalidate: true });
      id = insertResult.id;
      await insertResult.assetPrefetch?.catch(() => null);
    } else {
      id = existing.id;
    }

    await upsertPlaystateForMedia(requireDb(), media, "watched", record.watched_at, { skipInvalidate: true });

    await deletePlaybackProgress(requireDb(), { ...progressRow, media_key: mediaKey }).catch(() => null);
    await deletePlaybackProgress(requireDb(), media).catch(() => null);

    (async () => {
      try {
        const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
          skipped: false,
          status: "error",
          details: `Watch propagation failed: ${error.message || String(error)}`,
          targetStates: [],
        }));
        await updateWatchTelemetry(requireDb(), id, formatDispatchTelemetry(summary, media, "watched"), { skipInvalidate: true });
        await recordSyncHistory(media, summary, "watched");
      } catch (err) {
        console.error("Background sync for progress watch failed:", err);
      } finally {
        await invalidateHistoryDerivedCaches().catch(() => null);
      }
    })().catch((error) => console.error("Background sync loop crashed:", error));

    await invalidateHistoryDerivedCaches().catch(() => null);
    return sendJson(res, { ok: true, id });
  } catch (error) {
    console.error("Mark watch from progress failed", error);
    return sendJson(res, { error: "Mark watch from progress failed", details: error.message }, 500);
  }
}

async function handlePlaybackProgressUnwatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const mediaKey = String(body.media_key || "").trim();
  if (!mediaKey) return sendJson(res, { error: "media_key is required" }, 400);

  try {
    const progressRow = db.prepare("SELECT * FROM playback_progress WHERE media_key = ?").get(mediaKey);
    if (!progressRow) return sendJson(res, { error: "Playback progress item not found" }, 404);

    const media = {
      title: progressRow.title,
      type: progressRow.media_type,
      source: progressRow.source || "manual",
      ids: {
        imdb: progressRow.imdb_id || undefined,
        tmdb: progressRow.tmdb_id || undefined,
        tvdb: progressRow.tvdb_id || undefined,
      },
      season: progressRow.season == null ? undefined : Number(progressRow.season),
      episode: progressRow.episode == null ? undefined : Number(progressRow.episode),
      isValid: Boolean(progressRow.title && ["movie", "episode"].includes(progressRow.media_type)),
    };

    const config = await loadMediaConfig();
    const loopStore = createLoopStore();

    const { id: unwatchedId, summary } = await applyManualUnwatch(media, config, loopStore, "", { includeSourcePlatform: true });
    return sendJson(res, { ok: true, id: unwatchedId, status: summary.status, targetStates: summary.targetStates || [] });
  } catch (error) {
    console.error("Playback progress unwatch failed", error);
    return sendJson(res, { error: "Playback progress unwatch failed", details: error.message }, 500);
  } finally {
    await invalidateHistoryDerivedCaches().catch(() => null);
  }
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

  const withMediaKey = (session = {}) => {
    const mediaKey = session.media_key || session.mediaKey || mediaKeyFor(session);
    return { ...session, media_key: mediaKey, mediaKey };
  };

  const sessions = cacheRows.map(hydrateCachedSession).filter((session) => !session.completedAt).map(withMediaKey);
  const merged = [...sessions];
  for (const active of activeRows) {
    const isDuplicate = merged.some(
      (s) =>
        s.source === active.source &&
        s.title.toLowerCase().trim() === active.title.toLowerCase().trim() &&
        (s.season == null ? null : Number(s.season)) === (active.season == null ? null : Number(active.season)) &&
        (s.episode == null ? null : Number(s.episode)) === (active.episode == null ? null : Number(active.episode))
    );
    if (!isDuplicate) {
      merged.push(withMediaKey({
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
      }));
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
  if (!(await requireAdmin(req, res))) return;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.write("Cron Sync started...\n");

  const logger = (msg) => {
    res.write(`${msg}\n`);
    console.log(msg);
  };

  try {
    const result = await runScheduledSync(logger);
    await setRuntimeState({ lastCronResult: { ok: true, result, finishedAt: Date.now() } }).catch(() => null);
    res.write(`RESULT: ${JSON.stringify(result)}\n`);
    res.end();
  } catch (error) {
    logger(`ERROR: Cron Sync failed: ${error.message}`);
    await setRuntimeState({ lastCronResult: { ok: false, error: error.message, finishedAt: Date.now() } }).catch(() => null);
    res.write(`RESULT: ${JSON.stringify({ success: false, error: error.message })}\n`);
    res.end();
  }
}

async function handleCronSyncStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const runtime = await loadRuntimeState();
  return sendJson(res, {
    lastCron: runtime.lastCronExecution || null,
    lastResult: runtime.lastCronResult || null,
  }, 200, { "Cache-Control": "no-store" });
}

let forceSyncRunning = false;

async function handleForceSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res);

  // GET: poll for current status and log lines stored in runtimeState
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
  const FORCE_SYNC_HEARTBEAT_STALE_MS = 3 * 60 * 1000;
  const heartbeat = Number(runtime.forceSyncHeartbeat || runtime.forceSyncStartedAt || 0);
  const stale = !heartbeat || heartbeat < Date.now() - FORCE_SYNC_HEARTBEAT_STALE_MS;
  if (forceSyncRunning || (runtime.forceSyncActive === true && !stale)) {
    return sendJson(res, { ok: false, error: "Another force sync job is already running." }, 409);
  }
  if (runtime.forceSyncActive === true && stale) {
    await setRuntimeState({ forceSyncActive: false, forceSyncCancelRequested: false }).catch(() => null);
  }

  // Clear the previous log and mark as active before returning
  await setRuntimeState({
    forceSyncLog: ["Force Sync started..."],
    forceSyncResult: null,
    forceSyncActive: true,
    forceSyncStartedAt: Date.now(),
    forceSyncHeartbeat: Date.now(),
    forceSyncCancelRequested: false,
  });
  forceSyncRunning = true;

  // Batch log writes: collect lines in memory, flush every 3s.
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
    const heartbeatTimer = setInterval(() => {
      setRuntimeState({ forceSyncHeartbeat: Date.now() }).catch(() => null);
    }, 30_000);
    heartbeatTimer.unref?.();
    try {
      const result = await runForceSync(logLine, { lockAlreadyClaimed: true });
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      await flushLog(); // flush any remaining lines
      await appendRuntimeLog("forceSyncLog", [`RESULT: ${JSON.stringify(result)}`]).catch(() => null);
      await setRuntimeState({
        forceSyncActive: false,
        forceSyncResult: result,
        forceSyncHeartbeat: Date.now(),
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
        forceSyncHeartbeat: Date.now(),
      }).catch(() => null);
    } finally {
      clearInterval(heartbeatTimer);
      forceSyncRunning = false;
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
  const headerToken = String(req.get("x-plembfin-webhook-secret") || "").trim();
  const authToken = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const queryToken = String(req.query?.token || "").trim();
  if (![headerToken, authToken, queryToken].some((token) => verifyWebhookToken(token))) {
    return sendJson(res, { error: "Unauthorized" }, 401);
  }

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
    });
  }

  // While an authoritative restore is pushing fresh state to the apps, ignore inbound
  // webhooks — they are the apps echoing our own marks back and would re-record as
  // watched-today. Real user plays resume the moment the restore job finishes.
  const restoreRuntime = await loadRuntimeState();
  if (restoreRuntime.restoreSyncActive === true) {
    console.log("Webhook ignored: authoritative restore in progress (suppressing app echo)", {
      source: media.source,
      title: media.title,
      phase: media.phase,
    });
    await recordSyncHistory(media, {
      status: "skipped",
      details: "Webhook ignored: authoritative restore in progress",
      targetStates: [],
    }, media.phase || "webhook").catch(() => null);
    return sendJson(res, { ok: true, inserted: false, skipped: true, reason: "Authoritative restore in progress" });
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
      console.error("Failed to fetch child episodes for %s %s", media.type, media.itemId, error);
      return sendJson(res, { error: `Failed to fetch episodes for ${media.type}`, details: error.message }, 500);
    }

    console.log("Found %d episodes under %s %s", episodes.length, media.type, media.itemId);

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
              console.error("Failed to delete watch record", error);
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
            const existingPlaystate = await getPlaystateForMedia(requireDb(), episodeMedia).catch(() => null);
            if (existingPlaystate?.state === "watched") {
              results.push({ episodeId: ep.Id, title: episodeMedia.title, success: true, skipped: true, reason: "Already marked watched" });
              return;
            }
            if (await shouldSkipPostRestoreCompletedWebhook(episodeMedia)) {
              results.push({ episodeId: ep.Id, title: episodeMedia.title, success: true, skipped: true, reason: "Post-restore completed webhook without active playback evidence" });
              return;
            }
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
      }).catch((error) => console.error("Failed to store resume progress", error));
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

    const existingPlaystate = await getPlaystateForMedia(requireDb(), media).catch(() => null);
    if (existingPlaystate?.state === "watched") {
      console.log("Webhook: skipped watched echo because playstate is already watched", {
        source: media.source,
        title: media.title,
        playstateUpdatedAt: existingPlaystate.updated_at,
      });
      await deletePlaybackProgress(requireDb(), media).catch(() => null);
      await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
      return sendJson(res, { ok: true, inserted: false, id: existingPlaystate.id, reason: "Already marked watched" });
    }

    if (await shouldSkipPostRestoreCompletedWebhook(media)) {
      console.log("Webhook: skipped post-restore completed event without active playback evidence", {
        source: media.source,
        title: media.title,
        type: media.type,
      });
      await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
      return sendJson(res, {
        ok: true,
        inserted: false,
        skipped: true,
        reason: "Post-restore completed webhook without active playback evidence",
      });
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
    console.error("Webhook insert failed", error);
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
  let token = String(body.token || body.apiKey || "");
  // The browser never receives stored secrets, so the settings form may submit a
  // blank token for an already-configured server — fall back to the saved credential.
  if (!token && ["plex", "emby", "jellyfin"].includes(type)) {
    const config = await loadMediaConfig().catch(() => null);
    token = type === "plex" ? String(config?.plex?.token || "") : String(config?.[type]?.apiKey || "");
  }
  if (!type || !baseUrl || !token) return sendJson(res, { ok: false, error: "type, url, and token are required" }, 400);

  try {
    const parsedBase = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsedBase.protocol)) {
      return sendJson(res, { ok: false, error: "Only http and https URLs are allowed" }, 400);
    }
    assertSafeOutboundUrl(baseUrl, { label: "Server URL" });
  } catch (error) {
    return sendJson(res, { ok: false, error: error.message || "Invalid URL" }, 400);
  }

  try {
    let response;
    if (type === "plex") {
      const url = assertSafeOutboundUrl(`${baseUrl}/identity`);
      response = await fetchWithTimeout(url, { headers: { Accept: "application/json, application/xml, text/xml", "X-Plex-Token": token } }, 8000);
    } else if (type === "emby" || type === "jellyfin") {
      const url = assertSafeOutboundUrl(`${baseUrl}/System/Info/Public`);
      response = await fetchWithTimeout(url, { headers: { Accept: "application/json", "X-Emby-Token": token, "X-MediaBrowser-Token": token } }, 8000);
    } else {
      return sendJson(res, { ok: false, error: "Unsupported connection type" }, 400);
    }
    if (!response.ok) return sendJson(res, { ok: false, error: `Connection failed with HTTP ${response.status}`, elapsedMs: Date.now() - started }, 502);
    return sendJson(res, { ok: true, detail: "Server identity verified", elapsedMs: Date.now() - started });
  } catch (error) {
    return sendJson(res, { ok: false, error: error.message, elapsedMs: Date.now() - started }, 502);
  }
}

// Probes the Plex realtime notification WebSocket — the channel that powers event-driven
// unwatch detection. Accepts URL/token in the body (so the integrity check can test the
// values currently entered in Settings), falling back to the saved Plex config.
async function handleTestPlexNotifications(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  let baseUrl = String(body.url || body.baseUrl || "").replace(/\/+$/, "");
  let token = String(body.token || body.apiKey || "");

  if (!baseUrl || !token) {
    const config = await loadMediaConfig().catch(() => null);
    baseUrl = baseUrl || config?.plex?.baseUrl || "";
    token = token || config?.plex?.token || "";
  }

  if (!baseUrl || !token) {
    return sendJson(res, { ok: false, error: "Plex URL and token are required" }, 400);
  }

  const result = await probePlexNotificationSocket({ baseUrl, token });
  return sendJson(res, result, result.ok ? 200 : 502);
}

// Deduplicate concurrent poster requests by mediaKey to prevent race conditions.
// Maps mediaKey -> Promise that resolves when poster processing is complete.
const inflight = new Map();

// A currently-playing item often has no watch_history or playback_progress row
// yet — it only lives in the live-tracking cache / active sessions. Resolve it by
// media_key here so /api/poster can fetch and cache its artwork (the raw Plex/Emby
// thumb path can't be loaded directly from a browser on an https page when the
// media server is http). Returns a synthesized row carrying poster_url, or null.
async function findLiveSessionPosterRow(mediaKey) {
  if (!mediaKey) return null;
  const [cacheRows, activeRows] = await Promise.all([
    loadLiveTrackingCache(requireDb(), { includeCompleted: false }).catch(() => []),
    listActiveSessions().catch(() => []),
  ]);
  const sessions = [...cacheRows.map(hydrateCachedSession), ...activeRows];
  for (const session of sessions) {
    if (mediaKeyFor(session) !== mediaKey) continue;
    const ids = session.ids || {};
    return {
      id: mediaKey,
      media_key: mediaKey,
      title: session.title,
      media_type: session.mediaType || session.media_type,
      source: session.source,
      imdb_id: ids.imdb || null,
      tmdb_id: ids.tmdb || null,
      tvdb_id: ids.tvdb || null,
      season: session.season ?? null,
      episode: session.episode ?? null,
      poster_url: session.posterUrl || session.poster_url || null,
    };
  }
  return null;
}

async function handlePoster(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const cacheHeaders = { "Cache-Control": "private, max-age=3600, stale-while-revalidate=86400" };

  try {
    const rowId = String(req.query.id || "");
    let row = await getWatchRecordByIdLight(rowId);
    if (!row) {
      row = await getWatchRecordByMediaKey(rowId).catch(() => null);
    }
    if (!row) {
      const progressRow = db.prepare("SELECT * FROM playback_progress WHERE media_key = ?").get(rowId);
      if (progressRow) {
        row = {
          id: progressRow.media_key,
          media_key: progressRow.media_key,
          title: progressRow.title,
          media_type: progressRow.media_type,
          source: progressRow.source,
          imdb_id: progressRow.imdb_id,
          tmdb_id: progressRow.tmdb_id,
          tvdb_id: progressRow.tvdb_id,
          season: progressRow.season,
          episode: progressRow.episode,
          poster_url: null,
        };
      }
    }
    if (!row) {
      row = await findLiveSessionPosterRow(rowId).catch(() => null);
    }
    if (!row) return sendJson(res, { error: "not found" }, 404);

    const fallbackRequested = ["1", "true", "yes"].includes(String(req.query.fallback || "").toLowerCase());
    const config = await loadMediaConfig().catch(() => ({}));
    const mediaKey = row.media_key || mediaKeyFor(row);
    const posterUpdateId = row.id || rowId;

    // Check for fresh cached result first (before deduplication check).
    // However, ignore negative cache for items without poster_url - these should retry TMDB fallback.
    const cached = usableCachedPoster(await getPosterCache(mediaKey));
    if (cached?.url) return sendJson(res, cached, 200, cacheHeaders);
    if (cached?.cached && row.poster_url) return sendJson(res, cached, 200, cacheHeaders);

    // If another request is already processing this mediaKey, wait for it to complete.
    if (inflight.has(mediaKey)) {
      await inflight.get(mediaKey);
      const recheck = usableCachedPoster(await getPosterCache(mediaKey));
      if (recheck?.url || recheck?.cached) return sendJson(res, recheck, 200, cacheHeaders);
      return sendJson(res, { url: null, cached: true, source: "missing" }, 200, cacheHeaders);
    }

    // Mark this mediaKey as inflight and process it.
    // Other concurrent requests will wait for this to complete.
    const processingPromise = (async () => {
      try {
        if (row.poster_url && !fallbackRequested && isCachedStorageUrl(row.poster_url)) {
          return { url: row.poster_url, cached: true, source: "storage" };
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

          // If the URL is already a cached storage image, return it directly
          if (isCachedStorageUrl(candidate.url)) {
            await updateWatchPosterUrl(posterUpdateId, candidate.url).catch((error) => {
              console.error("Failed to persist poster URL", { id: row.id, title: row.title, error: error.message || String(error) });
            });
            return { url: candidate.url, cached: true, source: candidate.source };
          }

          const cachedPoster = await cachePosterFromUrl(mediaKey, candidate.url, candidate.source);
          if (cachedPoster?.url) {
            await updateWatchPosterUrl(posterUpdateId, cachedPoster.url).catch((error) => {
              console.error("Failed to persist cached poster URL", { id: row.id, title: row.title, error: error.message || String(error) });
            });
            return cachedPoster;
          }
        }
        await markPosterMissing(mediaKey, "poster", "No usable poster candidate").catch(() => null);
        return { url: null, cached: true, source: "missing" };
      } catch (error) {
        console.error("Poster processing failed", { id: rowId, mediaKey, error: error.message || String(error) });
        return null;
      }
    })();

    inflight.set(mediaKey, processingPromise);
    const result = await processingPromise;
    inflight.delete(mediaKey);

    if (result) {
      return sendJson(res, result, 200, cacheHeaders);
    }

    // If result is null (error occurred), try to return cached result or error response.
    const fallback = usableCachedPoster(await getPosterCache(mediaKey));
    if (fallback?.url || fallback?.cached) {
      return sendJson(res, fallback, 200, cacheHeaders);
    }
    return sendJson(res, { url: null, cached: false, source: "error" }, 200, cacheHeaders);
  } catch (error) {
    inflight.delete(String(req.query.id || ""));
    console.error("Poster lookup failed", { id: String(req.query.id || ""), error: error.message || String(error) });
    return sendJson(res, { url: null, cached: false, source: "error" }, 200, cacheHeaders);
  }
}

// Concurrency limiter for TMDB image downloads to avoid hitting rate limits.
// At most 8 downloads run simultaneously; extras queue until a slot frees.
const TMDB_POSTER_CONCURRENCY = 8;
let _tmdbPosterActive = 0;
const _tmdbPosterQueue = [];
const _tmdbPosterInflight = new Map();

function _acquireTmdbPosterSlot() {
  return new Promise((resolve) => {
    if (_tmdbPosterActive < TMDB_POSTER_CONCURRENCY) {
      _tmdbPosterActive++;
      resolve();
    } else {
      _tmdbPosterQueue.push(resolve);
    }
  });
}

function _releaseTmdbPosterSlot() {
  const next = _tmdbPosterQueue.shift();
  if (next) {
    next();
  } else {
    _tmdbPosterActive--;
  }
}

async function handleTmdbPoster(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const posterPath = String(req.query.path || "").trim();
  if (!/^\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(posterPath)) {
    return sendJson(res, { error: "Invalid TMDB poster path" }, 400);
  }

  const tmdbId = String(req.query.tmdbId || "").trim();
  const mediaType = String(req.query.mediaType || "movie").toLowerCase() === "tv" ? "tv" : "movie";

  const mediaKey = `tmdb:poster:${posterPath}`;
  const cached = usableCachedPoster(await getPosterCache(mediaKey));
  if (cached?.url) {
    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    return res.redirect(302, cached.url);
  }
  if (cached?.cached) return res.redirect(302, "/favicon.svg");

  // Deduplicate concurrent requests for the same path.
  if (_tmdbPosterInflight.has(posterPath)) {
    await _tmdbPosterInflight.get(posterPath);
    const recheck = usableCachedPoster(await getPosterCache(mediaKey));
    if (recheck?.url) {
      res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
      return res.redirect(302, recheck.url);
    }
    return res.redirect(302, "/favicon.svg");
  }

  const remoteUrl = `https://image.tmdb.org/t/p/w500${posterPath}`;
  const downloadPromise = (async () => {
    await _acquireTmdbPosterSlot();
    try {
      const tmdbResult = await cachePosterFromUrl(mediaKey, remoteUrl, "tmdb");
      if (tmdbResult) return tmdbResult;
      if (!tmdbId) return null;
      const tvdbId = mediaType === "tv" ? getCachedTvdbId(tmdbId) : "";
      const fanartArt = await (mediaType === "tv"
        ? getFanartTvArt(tvdbId)
        : getFanartMovieArt(tmdbId)).catch(() => null);
      if (fanartArt?.poster) {
        return cachePosterFromUrl(mediaKey, fanartArt.poster, "fanart");
      }
      return null;
    } finally {
      _releaseTmdbPosterSlot();
    }
  })();

  _tmdbPosterInflight.set(posterPath, downloadPromise);
  const stored = await downloadPromise;
  _tmdbPosterInflight.delete(posterPath);

  if (!stored?.url) {
    return res.redirect(302, "/favicon.svg");
  }

  res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  return res.redirect(302, stored.url);
}

async function handleTmdbProfile(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

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
    note: "Cloudflare-era maintenance repair jobs are not included.",
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
  const ids = {
    imdbId: String(req.query.imdbId || req.query.imdb_id || req.query.imdb || "").trim(),
    tvdbId: String(req.query.tvdbId || req.query.tvdb_id || req.query.tvdb || "").trim(),
  };

  if (!mediaType || (!tmdbId && !title && !ids.imdbId && !ids.tvdbId)) {
    return sendJson(res, { error: "mediaType and a TMDB ID, title, IMDb ID, or TVDB ID are required" }, 400);
  }

  try {
    const details = await getTmdbDetails({ mediaType, tmdbId, title, ids });
    return sendJson(res, details, 200, { "Cache-Control": "private, max-age=300, stale-while-revalidate=86400", Vary: "Authorization" });
  } catch (error) {
    console.error("Failed handling TMDB details API", error);
    return sendJson(res, { error: error.message || "Failed to fetch TMDB details" }, error.status || 500);
  }
}

// Ultra-cheap, no-auth endpoint that returns immediately — client calls this on
// page load so the server is warm by the time the user clicks into anything.
function handlePing(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res);
  return sendJson(res, { ok: true, ts: Date.now() }, 200, { "Cache-Control": "no-store" });
}

async function handleDiagnosticLogs(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method === "DELETE") {
    if (!(await requireAdmin(req, res))) return;
    clearDiagnosticLogs();
    return sendJson(res, { ok: true }, 200, { "Cache-Control": "no-store" });
  }
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const limit = Math.min(Number(req.query?.limit || 500), 1000);
  const data = getDiagnosticLogs({ limit });
  return sendJson(res, data, 200, { "Cache-Control": "no-store" });
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

  // TV items are slow (deriveNextAiring fetches multiple seasons). Time-box each
  // page so it always returns promptly; the client just resumes from nextOffset.
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
      const details = await getTmdbDetails({ mediaType: item.mediaType, tmdbId: item.tmdbId, title: item.title, force: true, forceTvdb: false });
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
  // full watchHistory re-scan on every subsequent page's list build.
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

async function handleRematchTvShows(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  const offset = Math.max(Number(body.offset || 0), 0);
  const limit = Math.min(Math.max(Number(body.limit || 8), 1), 20);
  const items = (await listLibraryItemsForRefresh()).filter((item) => item.mediaType === "tv");
  const total = items.length;
  const startedAt = Date.now();
  const PAGE_BUDGET_MS = 25000;
  const getRowStmt = db.prepare("SELECT id, tmdb_id, tvdb_id, poster_url, media_key FROM watch_history WHERE id = ?");
  const updateIdsStmt = db.prepare("UPDATE watch_history SET tmdb_id = ?, tvdb_id = ?, updated_at = ? WHERE id = ?");
  const updateIdsPosterStmt = db.prepare("UPDATE watch_history SET tmdb_id = ?, tvdb_id = ?, poster_url = ?, updated_at = ? WHERE id = ?");
  const updateRows = db.transaction((updates) => {
    for (const update of updates) {
      if (update.posterUrl) updateIdsPosterStmt.run(update.tmdbId, update.tvdbId, update.posterUrl, update.updatedAt, update.id);
      else updateIdsStmt.run(update.tmdbId, update.tvdbId, update.updatedAt, update.id);
    }
  });

  let processed = 0;
  let matched = 0;
  let updatedShows = 0;
  let updatedRows = 0;
  let failed = 0;
  const log = [];
  const changedMediaKeys = new Set();

  for (let i = offset; i < items.length && processed < limit; i++) {
    if (processed > 0 && Date.now() - startedAt > PAGE_BUDGET_MS) break;
    const item = items[i];
    processed += 1;

    try {
      const details = await getTmdbDetails({ mediaType: "tv", title: item.title, force: true, forceTvdb: false });
      const tmdbId = details?.id ? String(details.id) : "";
      if (!tmdbId) throw new Error("No TMDB match returned");

      const tvdbId = details?.external_ids?.tvdb_id ? String(details.external_ids.tvdb_id) : "";
      const posterUrl = details?.cached_poster_url || "";
      const updates = [];

      for (const record of item.records || []) {
        const row = getRowStmt.get(String(record.id));
        if (!row) continue;
        const idChanged = String(row.tmdb_id || "") !== tmdbId || String(row.tvdb_id || "") !== tvdbId;
        const posterChanged = Boolean(posterUrl && String(row.poster_url || "") !== posterUrl);
        if (!idChanged && !posterChanged) continue;
        updates.push({ id: row.id, tmdbId, tvdbId, posterUrl: posterChanged ? posterUrl : "", updatedAt: Date.now() });
        if (row.media_key) changedMediaKeys.add(row.media_key);
      }

      if (updates.length) {
        updateRows(updates);
        updatedShows += 1;
        updatedRows += updates.length;
      }

      matched += 1;
      log.push(`${updates.length ? "UPDATED" : "OK"} - ${item.title} -> TMDB ${tmdbId}${tvdbId ? ` / TVDB ${tvdbId}` : ""} (${updates.length} row${updates.length === 1 ? "" : "s"})`);
    } catch (error) {
      failed += 1;
      log.push(`FAILED - ${item.title} (${error.message || "no match"})`);
    }
  }

  for (const mediaKey of changedMediaKeys) {
    await deletePosterCacheByMediaKey(mediaKey).catch(() => null);
  }
  if (updatedRows) await invalidateHistoryDerivedCaches().catch(() => null);

  const nextOffset = offset + processed;
  return sendJson(res, {
    ok: true,
    total,
    processed,
    nextOffset,
    hasMore: nextOffset < total,
    matched,
    updatedShows,
    updatedRows,
    failed,
    log,
  }, 200, { "Cache-Control": "no-store" });
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
    const ids = {
      imdbId: String(item?.imdbId || item?.imdb_id || item?.imdb || "").trim(),
      tvdbId: String(item?.tvdbId || item?.tvdb_id || item?.tvdb || "").trim(),
    };
    if (!mediaType || (!tmdbId && !title && !ids.imdbId && !ids.tvdbId)) return { error: "invalid" };
    try {
      const details = await getTmdbDetails({ mediaType, tmdbId, title, ids });
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

async function handleTvdbSearch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const query = String(req.query.query || req.query.q || "").trim();
  if (query.length < 2) return sendJson(res, { error: "A search query of at least two characters is required" }, 400);
  try {
    const results = await searchTvdbSeriesList(query);
    return sendJson(res, { results }, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=900", Vary: "Authorization" });
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
    const localLimit = Math.min(Math.max(Number(req.query.limit || req.query.localLimit || 50), 1), 250);
    const [movies, shows, discovery] = await Promise.all([
      queryMovies({ search: query, limit: localLimit }),
      queryShows({ search: query, limit: localLimit }),
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
    const details = await getTmdbImages({
      mediaType: req.query.mediaType || req.query.type,
      tmdbId: req.query.tmdbId || req.query.id,
      title: req.query.title,
      ids: { tvdbId: req.query.tvdbId || req.query.tvdb_id },
    });
    return sendJson(res, details);
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

async function handleTvdbImages(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const title = String(req.query.title || "").trim();
    let tvdbId = String(req.query.tvdbId || req.query.tvdb_id || "").trim();
    if (!tvdbId) tvdbId = await resolveTvdbSeriesId({ title }).catch(() => "");
    if (!tvdbId) {
      const tmdbId = String(req.query.tmdbId || req.query.id || "").trim();
      if (tmdbId) tvdbId = getCachedTvdbId(tmdbId);
    }
    if (!tvdbId) return sendJson(res, { posters: [], logos: [], backdrops: [] });
    const result = await getTvdbSeriesArtwork(tvdbId);
    return sendJson(res, result);
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

async function handleFanartImages(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const mediaType = req.query.mediaType || req.query.type;
    const tmdbId = String(req.query.tmdbId || req.query.id || "").trim();
    const tvdbIdParam = String(req.query.tvdbId || req.query.tvdb_id || "").trim();
    let result = null;
    if (mediaType === "movie") {
      result = await getAllFanartMovieImages(tmdbId);
    } else {
      const tvdbIds = [];
      const addTvdbId = (value) => {
        const id = String(value || "").trim();
        if (id && !tvdbIds.includes(id)) tvdbIds.push(id);
      };

      addTvdbId(tvdbIdParam);
      addTvdbId(getCachedTvdbId(tmdbId));
      if (tmdbId) {
        const details = await getTmdbDetails({ mediaType: "tv", tmdbId }).catch(() => null);
        addTvdbId(details?.external_ids?.tvdb_id);
      }

      for (const tvdbId of tvdbIds) {
        const candidate = await getAllFanartTvImages(tvdbId);
        const hasImages = Boolean(candidate?.posters?.length || candidate?.logos?.length || candidate?.backdrops?.length);
        if (hasImages) {
          result = candidate;
          break;
        }
        if (!result) result = candidate;
      }
    }
    return sendJson(res, result || { posters: [], logos: [], backdrops: [] });
  } catch (error) {
    return sendJson(res, { error: error.message }, 500);
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

    return sendJson(res, responseData, 200, { "Cache-Control": "private, max-age=300, stale-while-revalidate=86400", Vary: "Authorization" });
  } catch (error) {
    console.error("Failed handling TMDB person API", error);
    return sendJson(res, { error: error.message || "Failed to fetch TMDB person details" }, error.status || 500);
  }
}


// The poster picker hands us app-relative proxy URLs (/api/tmdb-poster?path=...)
// alongside absolute and already-cached /media/ storage URLs. cachePosterFromUrl
// needs an absolute URL (or a /media/ path), so resolve the proxy form back to
// its upstream TMDB image URL before caching.
function resolveCustomPosterFetchUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  if (value.startsWith("/api/tmdb-poster")) {
    try {
      const proxied = new URL(value, "http://localhost");
      const posterPath = proxied.searchParams.get("path") || "";
      return posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : "";
    } catch {
      return "";
    }
  }
  return value;
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
  if (body.logo_url !== undefined) fields.logo_url = body.logo_url;
  if (body.backdrop_url !== undefined) fields.backdrop_url = body.backdrop_url;
  if (body.tmdb_id !== undefined) fields.tmdb_id = body.tmdb_id;
  if (body.tvdb_id !== undefined) fields.tvdb_id = body.tvdb_id;
  if (body.title !== undefined) fields.title = body.title;
  if (body.youtube_url !== undefined) fields.youtube_url = body.youtube_url;

  // Captured before the update runs — needed below to invalidate the cache row
  // keyed by the *previous* tmdb_id when tvdb_id changes (Fix Match rematch).
  const preUpdateRow = body.tvdb_id !== undefined ? await getWatchRecordByIdLight(id).catch(() => null) : null;

  const result = await updateWatchRecord(id, fields);
  if (!result.ok) return sendJson(res, { error: result.error }, 400);

  // If a custom poster was chosen, make it authoritative across the site. The
  // poster pipeline serves /api/poster from the poster cache (keyed by
  // media_key) before it ever looks at a row's poster_url, so simply stamping
  // one row leaves the dashboard showing the old cached image. Cache the chosen
  // image and propagate it to every related record (other plays of the same
  // movie, or every episode of the same show) so each one resolves to it.
  let customPosterUrl;
  let customPosterIds;
  let customBackdropUrl;
  const chosenPoster = String(body.poster_url ?? "").trim();
  const chosenPosterFetchUrl = resolveCustomPosterFetchUrl(chosenPoster);
  if (chosenPosterFetchUrl) {
    const editedRow = await getWatchRecordByIdLight(id).catch(() => null);
    const editedKey = editedRow?.media_key || (editedRow ? mediaKeyFor(editedRow) : null);
    if (editedKey) {
      const cached = await cachePosterFromUrl(editedKey, chosenPosterFetchUrl, "custom").catch(() => null);
      if (cached?.url) {
        // The storage path is derived from media_key, so re-saving a poster
        // overwrites the same file at the same URL — browsers and the client
        // poster cache would keep serving the previous image. Append a version
        // token so each change yields a fresh URL that busts those caches.
        const versionedUrl = `${cached.url}${cached.url.includes("?") ? "&" : "?"}v=${Date.now()}`;
        customPosterUrl = versionedUrl;
        const related = relatedPosterRows(id);
        const seenKeys = new Set([editedKey]);
        for (const row of related) {
          if (row.media_key && !seenKeys.has(row.media_key)) {
            seenKeys.add(row.media_key);
            // Cheap upsert for an already-cached storage URL (no re-download).
            await cachePosterFromUrl(row.media_key, cached.url, "custom").catch(() => null);
          }
        }
        await setWatchPosterUrls(related.map((row) => ({ id: row.id, posterUrl: versionedUrl }))).catch(() => null);
        await invalidateHistoryDerivedCaches().catch(() => null);
        customPosterIds = related.map((row) => row.id);
      }
    }
  }

  const chosenBackdrop = String(body.backdrop_url ?? "").trim();
  const chosenBackdropFetchUrl = resolveCustomPosterFetchUrl(chosenBackdrop);
  if (chosenBackdropFetchUrl) {
    const editedRow = await getWatchRecordByIdLight(id).catch(() => null);
    const editedKey = editedRow?.media_key || (editedRow ? mediaKeyFor(editedRow) : null);
    if (editedKey) {
      const cached = await cacheBackdropFromUrl(editedKey, chosenBackdropFetchUrl, "custom").catch(() => null);
      if (cached?.url) {
        customBackdropUrl = `${cached.url}${cached.url.includes("?") ? "&" : "?"}v=${Date.now()}`;
        await setWatchBackdropUrl(id, customBackdropUrl).catch(() => null);
      }
    }
  }

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
      // The record's own poster_url/backdrop_url survive a rematch untouched, and
      // /api/poster serves a stored storage URL directly without consulting the
      // (now-cleared) poster cache — so the old show/movie's artwork would keep
      // being served forever unless this request is itself uploading new artwork.
      if (body.poster_url === undefined && body.backdrop_url === undefined) {
        await clearWatchArtworkUrls(id).catch(() => null);
      }
    }
  }

  // If TVDB ID changed (Fix Match rematch), the old cached tv_{tmdbId} details row
  // for this record's *previous* tmdb_id still points at the wrong show — force it
  // stale so the next detail fetch re-resolves via the new tvdb_id instead of
  // serving mismatched cached data until the TTL happens to expire.
  if (body.tvdb_id !== undefined && preUpdateRow) {
    if (preUpdateRow.tmdb_id) {
      db.prepare("DELETE FROM tmdb_metadata_cache WHERE id = ?").run(`tv_${preUpdateRow.tmdb_id}`);
    }
    if (preUpdateRow.media_key) {
      await deletePosterCacheByMediaKey(preUpdateRow.media_key).catch(() => null);
    }
  }

  return sendJson(res, { ok: true, poster_url: customPosterUrl, backdrop_url: customBackdropUrl, updated_ids: customPosterIds });
}

function extractYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("?")[0] || null;
    if (host === "youtube.com" || host === "m.youtube.com") return u.searchParams.get("v") || null;
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
    const oembedRes = await fetchWithTimeout(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {}, 8000);
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
      const apiRes = await fetchWithTimeout(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${encodeURIComponent(videoId)}`, { headers: { "X-goog-api-key": ytApiKey } }, 8000);
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

async function handleOmdbRating(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const imdbId = String(req.query.imdbId || "").trim();
  if (!imdbId) return sendJson(res, { error: "imdbId is required" }, 400);

  const config = await loadMediaConfig();
  if (!config.omdb?.apiKey) return sendJson(res, { error: "OMDb API key not configured" }, 503);

  try {
    const rating = await getOmdbRating(imdbId, config.omdb.apiKey);
    return sendJson(res, rating || {});
  } catch (err) {
    return sendJson(res, { error: err.message }, 500);
  }
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

async function handleCacheStats(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const dirs = [
    { key: "posters", dir: POSTERS_DIR },
    { key: "backdrops", dir: BACKDROPS_DIR },
    { key: "profiles", dir: PROFILES_DIR },
  ];
  const disk = {};
  for (const { key, dir } of dirs) {
    let count = 0;
    let size = 0;
    try {
      const files = await fs.promises.readdir(dir);
      for (const file of files) {
        try {
          const stat = await fs.promises.stat(nodePath.join(dir, file));
          if (stat.isFile()) { size += stat.size; count++; }
        } catch {}
      }
    } catch {}
    disk[key] = { count, size };
  }

  const dbRows = db.prepare(
    "SELECT variant, COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as size FROM poster_cache WHERE status = 'cached' GROUP BY variant"
  ).all();
  const dbByVariant = Object.fromEntries(dbRows.map((r) => [r.variant, { count: r.count, size: r.size }]));

  return sendJson(res, { disk, db: dbByVariant });
}

async function handleClearCache(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const type = body?.type || "all";

  const typeMap = {
    posters: { dir: POSTERS_DIR, variants: ["poster", "logo"] },
    backdrops: { dir: BACKDROPS_DIR, variants: ["backdrop"] },
    profiles: { dir: PROFILES_DIR, variants: ["profile"] },
  };
  const targets = type === "all" ? Object.values(typeMap) : typeMap[type] ? [typeMap[type]] : [];

  let deleted = 0;
  let freed = 0;
  for (const { dir } of targets) {
    try {
      const files = await fs.promises.readdir(dir);
      for (const file of files) {
        const filePath = nodePath.join(dir, file);
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.isFile()) { freed += stat.size; await fs.promises.unlink(filePath); deleted++; }
        } catch {}
      }
    } catch {}
  }

  if (type === "all") {
    db.prepare("DELETE FROM poster_cache").run();
  } else {
    for (const variant of (typeMap[type]?.variants || [])) {
      db.prepare("DELETE FROM poster_cache WHERE variant = ?").run(variant);
    }
  }

  return sendJson(res, { ok: true, deleted, freed });
}

// ---------------------------------------------------------------------------
// Changelog
//
// Each build ships with a bundled changelog.json (served at /changelog.json) that
// records the version this instance was built from. A running instance also polls
// the changelog.json published on GitHub so the Settings → Changelog screen can
// show the user their current version alongside any newer releases. The browser
// can't reach GitHub directly (CSP connect-src 'self'), so we proxy + cache it here.
// ---------------------------------------------------------------------------

const REMOTE_CHANGELOG_URL =
  "https://raw.githubusercontent.com/Lasikiewicz/plembfin/main/changelog.json";
const REMOTE_CHANGELOG_TTL_MS = 30 * 60 * 1000; // 30 minutes
let remoteChangelogCache = { fetchedAt: 0, data: null };

function readLocalChangelog() {
  try {
    const raw = fs.readFileSync(nodePath.resolve(PUBLIC_DIR, "..", "changelog.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fetchRemoteChangelog({ force = false } = {}) {
  const now = Date.now();
  if (!force && remoteChangelogCache.data && now - remoteChangelogCache.fetchedAt < REMOTE_CHANGELOG_TTL_MS) {
    return remoteChangelogCache.data;
  }
  const response = await fetchWithTimeout(REMOTE_CHANGELOG_URL, {
    headers: { Accept: "application/json" },
  }, 8000);
  if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
  const data = await response.json();
  remoteChangelogCache = { fetchedAt: now, data };
  return data;
}

function parseSemver(value) {
  const match = String(value || "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

async function handleChangelog(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);

  const local = readLocalChangelog();
  const currentVersion = local?.version || null;
  const localEntries = Array.isArray(local?.entries) ? local.entries : [];

  let remote = null;
  let remoteError = null;
  try {
    remote = await fetchRemoteChangelog({ force: req.query?.refresh === "1" && Boolean(resolveAdminPrincipal(req)) });
  } catch (error) {
    remoteError = error?.message || "Unable to reach GitHub";
  }

  const remoteAvailable = Boolean(remote && Array.isArray(remote.entries));
  const entries = remoteAvailable ? remote.entries : localEntries;
  const latestVersion = remoteAvailable ? remote.version || currentVersion : currentVersion;

  const newer = currentVersion
    ? entries.filter((entry) => compareSemver(entry.version, currentVersion) > 0)
    : [];

  return sendJson(
    res,
    {
      current: currentVersion,
      latest: latestVersion,
      updateAvailable: newer.length > 0,
      remoteAvailable,
      remoteError,
      newer,
      entries,
    },
    200,
    { "Cache-Control": "no-store" }
  );
}

async function dispatch(req, res) {
  try {
    const path = routePath(req);
    if (path === "ping") return handlePing(req, res);
    if (path === "changelog") return handleChangelog(req, res);
    if (path === "diagnostic-logs") return handleDiagnosticLogs(req, res);
    if (path === "login") return handleLogin(req, res);
    if (path === "logout") return handleLogout(req, res);
    if (path === "auth/status" || path === "auth-status") return handleAuthStatus(req, res);
    if (path === "auth/apikey") return handleAuthApiKey(req, res);
    if (path === "auth/webhook-secret") return handleAuthWebhookSecret(req, res);
    if (path === "auth/sessions/revoke-all") return handleRevokeAllSessions(req, res);
    if (path === "auth/credentials") return handleAuthCredentials(req, res);
    if (path === "config") return handleConfig(req, res);
    if (path === "appearance") return handleAppearance(req, res);
    if (path === "history") return handleHistory(req, res);
    if (path === "sync-jobs") return handleSyncJobs(req, res);
    if (path === "sync-history") return handleSyncHistory(req, res);
    if (path === "clear-missing-telemetry") return handleClearMissingTelemetry(req, res);
    if (path === "movies") return handleMovies(req, res);
    if (path === "delete-media") return handleDeleteMedia(req, res);
    if (path === "shows") return handleShows(req, res);
    if (path === "show") return handleShow(req, res);
    if (path === "full-sync-watchstates") return handleFullSyncWatchstates(req, res);
    if (path === "import") return handleImport(req, res);
    if (path === "backup/export") return handleBackupExport(req, res);
    if (path === "backup/import") return handleBackupImport(req, res);
    if (path === "watch-backups") return handleWatchBackups(req, res);
    if (path === "plembfin-backups") return handlePlembfinBackups(req, res);
    if (path === "manual-watch") return handleManualWatch(req, res);
    if (path === "manual-unwatch") return handleManualUnwatch(req, res);
    if (path === "playback-progress") return handlePlaybackProgressList(req, res);
    if (path === "playback-progress/watch") return handlePlaybackProgressWatch(req, res);
    if (path === "playback-progress/unwatch") return handlePlaybackProgressUnwatch(req, res);
    if (path === "retry-sync") return handleRetrySync(req, res);
    if (path === "update-watch") return handleUpdateWatch(req, res);
    if (path === "merge-shows") return handleMergeShows(req, res);
    if (path === "now-playing") return handleNowPlaying(req, res);
    if (path === "active-sessions") return handleActiveSessions(req, res);
    if (path === "cron-sync") return handleCronSync(req, res);
    if (path === "cron-sync/status") return handleCronSyncStatus(req, res);
    if (path === "force-sync") return handleForceSync(req, res);
    if (path === "stop-force-sync") return handleStopForceSync(req, res);
    if (path === "dedup-history") return handleDedupHistory(req, res);
    if (path === "tmdb-details") return handleTmdbDetails(req, res);
    if (path === "tmdb-details-batch") return handleTmdbDetailsBatch(req, res);
    if (path === "refresh-tmdb-metadata") return handleRefreshTmdbMetadata(req, res);
    if (path === "rematch-tv-shows") return handleRematchTvShows(req, res);
    if (path === "media-details") return handleTmdbDetails(req, res);
    if (path === "tmdb-search") return handleTmdbSearch(req, res);
    if (path === "tvdb-search") return handleTvdbSearch(req, res);
    if (path === "media-search") return handleMediaSearch(req, res);
    if (path === "tmdb-season") return handleTmdbSeason(req, res);
    if (path === "tmdb-images") return handleTmdbImages(req, res);
    if (path === "tvdb-images") return handleTvdbImages(req, res);
    if (path === "fanart-images") return handleFanartImages(req, res);
    if (path === "tmdb-person") return handleTmdbPerson(req, res);
    if (path === "youtube-meta") return handleYoutubeMeta(req, res);
    if (path === "omdb-rating") return handleOmdbRating(req, res);
    if (path === "webhook") return handleWebhook(req, res);
    if (path === "test-connection") return handleTestConnection(req, res);
    if (path === "test-plex-notifications") return handleTestPlexNotifications(req, res);
    if (path === "seerr/status") return handleSeerrStatus(req, res);
    if (path === "seerr/media-status") return handleSeerrMediaStatus(req, res);
    if (path === "seerr/request") return handleSeerrRequest(req, res);
    if (path === "media-app-links") return handleMediaAppLinks(req, res);
    if (path === "tmdb-poster") return handleTmdbPoster(req, res);
    if (path === "tmdb-profile") return handleTmdbProfile(req, res);
    if (path === "poster") return handlePoster(req, res);
    if (path === "cache-stats") return handleCacheStats(req, res);
    if (path === "clear-cache") return handleClearCache(req, res);
    if (path === "admin-backfill-status") return handleBackfillStatus(req, res);
    if (path === "admin-backfill-trakt") return handleBackfillTrakt(req, res);
    if (path === "admin-fix-history") return handleAdminFixHistory(req, res);
    if (["admin-ensure-columns", "admin-clear-mock"].includes(path)) {
      return handleMaintenanceStub(req, res, path);
    }
    return notFound(res);
  } catch (error) {
    console.error("API route failed", error);
    // Deliberate client errors (error.status set by a handler) keep their message;
    // unexpected errors return a generic 500 so internal details never reach the client.
    const status = Number(error?.status);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return sendJson(res, { error: error.message || "Request failed" }, status);
    }
    return sendJson(res, { error: "API route failed" }, 500);
  }
}

export { dispatch };

export { backfillUnknownShowTitles };

async function refreshNextAiringCache({ limit = NEXT_AIRING_REFRESH_LIMIT, forceAll = false } = {}) {
  const cache = await readNextAiringCache();
  const shows = await getCachedShows();
  const candidates = shows
    .map((show) => {
      const key = nextAiringCacheKey(show.tmdb_id, show.title);
      const cached = cachedNextAiringFor(cache.entries, show.tmdb_id, show.title);
      const status = show.status || cached?.status || "";
      return { ...show, key, cached, status };
    })
    .filter((show) => show.key && show.tmdb_id && (forceAll || nextAiringCacheEntryStale(show.cached, show.status)))
    .sort((a, b) => Number(a.cached?.updatedAt || 0) - Number(b.cached?.updatedAt || 0))
    .slice(0, Math.max(1, Number(limit) || NEXT_AIRING_REFRESH_LIMIT));

  if (!candidates.length) return { checked: 0, written: 0 };
  console.log(`Next airing cache refresh: checking ${candidates.length} show${candidates.length === 1 ? "" : "s"}${forceAll ? " (full build)" : ""}...`);

  const updates = [];
  for (const show of candidates) {
    try {
      const details = await getTmdbDetails({ mediaType: "tv", tmdbId: show.tmdb_id, title: show.title, force: true, forceTvdb: false });
      updates.push({
        key: show.key,
        title: show.title,
        tmdbId: show.tmdb_id,
        nextAiringDate: details?.next_airing_date || details?.next_episode_to_air?.air_date || "",
        status: details?.status || show.status || "",
      });
    } catch (error) {
      console.error(`Failed to refresh next airing for ${show.title}`, error);
      updates.push({
        key: show.key,
        title: show.title,
        tmdbId: show.tmdb_id,
        nextAiringDate: show.cached?.nextAiringDate || "",
        status: show.status || "",
      });
    }
  }

  const result = await mergeNextAiringCacheEntries(updates);
  console.log(`Next airing cache refresh complete: checked ${candidates.length}, wrote ${result.written || 0}.`);
  return { checked: candidates.length, written: result.written || 0 };
}

const scheduledTasksInFlight = new Map();

async function runWithTimeBudget(label, task, timeoutMs) {
  if (scheduledTasksInFlight.has(label)) {
    console.warn(`${label} is still running from a previous tick; skipping this tick.`);
    return;
  }
  let timeout;
  const taskPromise = Promise.resolve()
    .then(task)
    .finally(() => scheduledTasksInFlight.delete(label));
  scheduledTasksInFlight.set(label, taskPromise);
  try {
    await Promise.race([
      taskPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    console.error(`${label} failed`, error);
  } finally {
    clearTimeout(timeout);
  }
}

// Invoked once per minute by the in-process scheduler in server.js
// (replacing the scheduledSync Cloud Function).
export async function runScheduledTick() {
  await runWithTimeBudget("Scheduled sync", () => runScheduledSync(), 50_000);
  await runWithTimeBudget("Scheduled watch-history backup", () => runScheduledWatchBackup(), 30_000);
  await runWithTimeBudget("Scheduled Plembfin backup", () => runScheduledPlembfinBackup(), 30_000);
  await runWithTimeBudget("TMDB prewarm", () => prewarmTmdbLibrary({ limit: 4 }), 30_000);
  if (Date.now() - lastNextAiringRefreshAt > NEXT_AIRING_REFRESH_INTERVAL_MS) {
    lastNextAiringRefreshAt = Date.now();
    const forceAll = nextAiringInitialBuildPending;
    nextAiringInitialBuildPending = false;
    await runWithTimeBudget("Next airing cache refresh", () => refreshNextAiringCache({ forceAll }), 45_000);
  }
}

// ---------------------------------------------------------------------------
// Plex real-time unwatch detection
//
// Plex never sends a webhook when an item is marked unwatched, so we listen on its
// notification WebSocket. When a movie/episode timeline event arrives, we resolve the
// ratingKey to its current metadata, confirm it actually went to unwatched, and (if we
// previously tracked it as watched) run the same propagation as a manual unwatch — which
// fans out to Emby and Jellyfin via the configured ID/title matching.
// ---------------------------------------------------------------------------

let plexNotificationListener = null;

async function handlePlexLibraryItemChange(ratingKey) {
  if (!watchedPlayedSyncEnabled()) return;

  const config = await loadMediaConfig().catch(() => null);
  if (!config?.plex?.baseUrl || !config.plex.token || config.plex.disabled) return;

  const metadata = await fetchPlexMetadataItem(config.plex, ratingKey).catch((error) => {
    console.error(`Plex notification: metadata lookup failed for ratingKey ${ratingKey}: ${error.message}`);
    return null;
  });
  if (!metadata) return;

  // Only movies and episodes carry a watch state we sync.
  const media = buildPlexMediaFromMetadata(metadata);
  if (!media?.isValid || !["movie", "episode"].includes(media.type)) return;

  // Still watched or only partially watched → this isn't an unwatch event.
  const viewCount = Number(metadata.viewCount || 0);
  const viewOffset = Number(metadata.viewOffset || 0);
  if (viewCount > 0 || viewOffset > 0) return;

  // Only propagate if our store currently considers this item watched. This avoids
  // reacting to items we never tracked and short-circuits the echo when an unwatch that
  // originated on Emby/Jellyfin was just propagated *into* Plex (the originating flow has
  // already flipped our playstate to "unwatched").
  const playstate = await getPlaystateForMedia(requireDb(), media).catch(() => null);
  if (playstate?.state === "unwatched") return;
  if (playstate?.state !== "watched") {
    const watched = await findWatchedByAnyMediaKey({ ...media, syncAction: "watched" }).catch(() => null);
    if (!watched) return;
  }

  console.log("Plex notifications: item marked unwatched, propagating to Emby/Jellyfin", {
    title: media.title,
    ratingKey,
    type: media.type,
  });

  const loopStore = createLoopStore();
  try {
    await applyManualUnwatch(media, config, loopStore);
  } catch (error) {
    console.error(`Plex notification unwatch propagation failed for "${media.title}"`, error);
  } finally {
    await invalidateHistoryDerivedCaches().catch(() => null);
  }
}

export function startPlexNotificationListener() {
  if (!plexNotificationListener) {
    plexNotificationListener = createPlexNotificationListener({
      getPlexConfig: async () => {
        const config = await loadMediaConfig().catch(() => null);
        return config?.plex || null;
      },
      onLibraryItemChange: handlePlexLibraryItemChange,
      logger: console.log,
    });
  }
  plexNotificationListener.start();
}

export function restartPlexNotificationListener() {
  if (!plexNotificationListener) {
    startPlexNotificationListener();
    return;
  }
  plexNotificationListener.restart();
}

export function stopPlexNotificationListener() {
  plexNotificationListener?.stop();
}
