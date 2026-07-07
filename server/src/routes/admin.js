import fs from "node:fs";
import nodePath from "node:path";
import { requireAdmin, resolveAdminPrincipal } from "../utils/auth.js";
import { readFormData, readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { fetchWithTimeout, assertSafeOutboundUrl } from "../utils/outbound.js";
import { AUTH, verifyWebhookToken } from "../appConfig.js";
import { db, parseJson, toJson, writeAuditLog } from "../db.js";
import { createLoopStore } from "../utils/loopStore.js";
import { listActiveSessions, deleteActiveSession, upsertActiveSession } from "../utils/activeSessions.js";
import { hydrateCachedSession, loadLiveTrackingCache } from "../utils/liveSessions.js";
import { runForceSync, runScheduledSync } from "../scheduled.js";
import { getLogs as getDiagnosticLogs, clearLogs as clearDiagnosticLogs } from "../utils/diagnosticLogger.js";
import { appendSyncHistory, loadMediaConfig, mergeIncomingConfig, publicMediaConfig, saveMediaConfig, validateConfig, getSyncHistory, loadRuntimeState, setRuntimeState, appendRuntimeLog } from "../utils/configStore.js";
import { findPlexItem, markPlexPlayed, setPlexProgress, markPlexUnplayedByRatingKey, fetchPlexWatchedItems, fetchPlexMetadataItem, fetchPlexSeriesEpisodes } from "../utils/plexClient.js";
import { probePlexNotificationSocket } from "../utils/plexNotificationListener.js";
import { markEmbyPlayed, setEmbyProgress, markEmbyUnplayedById, fetchEmbyWatchedItems, findEmbyItems, fetchEmbySeriesEpisodes } from "../utils/embyClient.js";
import { markJellyfinPlayed, setJellyfinProgress, markJellyfinUnplayedById, fetchJellyfinWatchedItems, findJellyfinItems, fetchJellyfinSeriesEpisodes } from "../utils/jellyfinClient.js";
import { normalizeProviderIds, parseCustomWebhook, parseEmbyWebhook, parseJellyfinWebhook, parsePlexWebhook } from "../utils/parsers.js";
import { getTargetsForSource, shouldSyncResumeProgress, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "../utils/syncOrchestrator.js";
import { watchedPlayedSyncEnabled } from "../utils/syncFlags.js";
import { fetchPosterFromTmdb } from "../utils/tmdbClient.js";
import { cacheBackdropFromUrl, cachePosterFromUrl, cacheProfileFromUrl, getPosterCache, markPosterMissing, usableCachedPoster } from "../utils/posterCache.js";
import { getTmdbDetails, getTmdbImages, getTmdbPerson, getTmdbSeason, searchTmdb, getCachedTvdbId } from "../utils/tmdbGateway.js";
import { searchTvdbSeriesList, resolveTvdbSeriesId, getTvdbSeriesArtwork } from "../utils/tvdbGateway.js";
import { getFanartMovieArt, getFanartTvArt, getAllFanartMovieImages, getAllFanartTvImages } from "../utils/fanartGateway.js";
import { getOmdbRating } from "../utils/omdbGateway.js";
import { POSTERS_DIR, BACKDROPS_DIR, PROFILES_DIR, PUBLIC_DIR } from "../paths.js";
import {
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
} from "../utils/dataRepo.js";

import { restartPlexNotificationListener } from "../scheduler.js";

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

const APPEARANCE_SETTINGS_ID = "appearanceConfig";
const APPEARANCE_DEFAULTS = {
  showLogoArt: true,
  showCast: true,
  showTrailers: true,
  showReviews: true,
  showImages: true,
  showRelated: true,
};

export async function handleAppearance(req, res) {
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

export async function handleConfig(req, res) {
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
    // field blank â€” because the browser never receives stored secrets â€” still
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

export async function handleSeerrStatus(req, res) {
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

export async function handleSeerrRequest(req, res) {
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
      // numbers or the string "all" â€” anything else (including a missing field)
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

export async function handleMediaAppLinks(req, res) {
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

export async function handleSeerrMediaStatus(req, res) {
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

export async function handleTestConnection(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const body = await readJson(req);
  const started = Date.now();
  const type = String(body.type || "").toLowerCase();
  const baseUrl = String(body.url || body.baseUrl || "").replace(/\/+$/, "");
  let token = String(body.token || body.apiKey || "");
  // The browser never receives stored secrets, so the settings form may submit a
  // blank token for an already-configured server â€” fall back to the saved credential.
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

// Probes the Plex realtime notification WebSocket â€” the channel that powers event-driven
// unwatch detection. Accepts URL/token in the body (so the integrity check can test the
// values currently entered in Settings), falling back to the saved Plex config.
export async function handleTestPlexNotifications(req, res) {
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
// yet â€” it only lives in the live-tracking cache / active sessions. Resolve it by
// media_key here so /api/poster can fetch and cache its artwork (the raw Plex/Emby
// thumb path can't be loaded directly from a browser on an https page when the
// media server is http). Returns a synthesized row carrying poster_url, or null.
