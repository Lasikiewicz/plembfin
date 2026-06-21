import crypto from "node:crypto";
import { db, getDataVersion, bumpDataVersion, parseJson, toJson, transaction } from "../db.js";
import { loadMediaConfig } from "./configStore.js";
import { fetchPosterFromTmdb } from "./tmdbClient.js";
import { getTmdbDetails, getTmdbSeason } from "./tmdbGateway.js";
import {
  initShowProgressCache,
  getCachedShowProgress,
  queueShowProgressUpdate,
  flushShowProgressUpdates,
} from "./showProgressCache.js";

// Initialize TV show progress cache on startup
initShowProgressCache().catch((err) => {
  console.error("[firestoreRepo] Failed to initialize show progress cache", err);
});


const MAX_HISTORY_LIMIT = 25000;
const HISTORY_VISIBILITY_CACHE_VERSION = 4;
const HISTORY_PREVIEW_SCAN_LIMIT = 600;

let historyCache = { version: null, rows: [] };
let showCache = { version: null, shows: [] };
let movieCache = { version: null, rows: null };
let statsCache = { version: null, stats: null };

export async function getHistoryCacheVersion() {
  return getDataVersion();
}

// --- Watch history row mapping --------------------------------------------
const WATCH_COLUMNS = [
  "id", "title", "title_lower", "media_type", "watched_at", "source",
  "imdb_id", "tmdb_id", "tvdb_id", "season", "episode", "poster_url", "logo_url",
  "youtube_url", "sync_action", "sync_dispatch_telemetry", "media_key",
  "show_title", "show_title_lower", "episode_title", "created_at", "updated_at",
];

const insertWatchStmt = db.prepare(
  `INSERT INTO watch_history (${WATCH_COLUMNS.join(", ")})
   VALUES (${WATCH_COLUMNS.map((c) => "@" + c).join(", ")})`,
);
const selectAllHistoryStmt = db.prepare(`SELECT * FROM watch_history ORDER BY watched_at DESC LIMIT ${MAX_HISTORY_LIMIT}`);
const selectMoviesStmt = db.prepare("SELECT * FROM watch_history WHERE media_type = 'movie'");
const selectRecentStmt = db.prepare("SELECT * FROM watch_history ORDER BY watched_at DESC LIMIT ?");
const selectByIdStmt = db.prepare("SELECT * FROM watch_history WHERE id = ?");
const selectByMediaKeyStmt = db.prepare("SELECT * FROM watch_history WHERE media_key = ?");
const selectEpisodesByShowLowerStmt = db.prepare("SELECT * FROM watch_history WHERE media_type = 'episode' AND show_title_lower = ?");
const selectAllEpisodesStmt = db.prepare("SELECT * FROM watch_history WHERE media_type = 'episode'");
const deleteByIdStmt = db.prepare("DELETE FROM watch_history WHERE id = ?");
const deleteByMediaKeyStmt = db.prepare("DELETE FROM watch_history WHERE media_key = ?");
const findExistingStmt = db.prepare("SELECT * FROM watch_history WHERE media_key = ? AND watched_at = ? LIMIT 1");
const findWatchedByKeyStmt = db.prepare("SELECT * FROM watch_history WHERE media_key = ? AND sync_action = 'watched' LIMIT 1");
const getTmdbShowDetailsStmt = db.prepare("SELECT details FROM tmdb_metadata_cache WHERE id = ?");

function cachedTmdbShowDetails(tmdbId) {
  const id = cleanString(tmdbId);
  if (!id) return null;
  const row = getTmdbShowDetailsStmt.get(`tv_${id}`);
  return row?.details ? parseJson(row.details) : null;
}

function cachedShowTmdbId(...candidates) {
  for (const candidate of candidates) {
    const id = cleanString(candidate);
    if (id && cachedTmdbShowDetails(id)) return id;
  }
  return "";
}

function cleanString(value) {
  return String(value || "").trim();
}

function emptyToNull(value) {
  const text = cleanString(value);
  return text || null;
}

function numberOrNull(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeMediaType(value) {
  const type = cleanString(value).toLowerCase();
  if (["movie", "movies", "film"].includes(type)) return "movie";
  if (["episode", "episodes", "show", "tv", "series"].includes(type)) return "episode";
  return type;
}

export function normalizePlatformSource(value) {
  const source = cleanString(value).toLowerCase();
  if (source.startsWith("emby")) return "emby";
  if (source.startsWith("jellyfin")) return "jellyfin";
  return "plex";
}

function normalizeWatchedAt(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function normalizeKeyPart(value) {
  return String(value ?? "none").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
}

function decodeBasicHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&");
}

export function canonicalTitleKey(value) {
  return decodeBasicHtmlEntities(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function stablePosterKey(value) {
  const poster = cleanString(value);
  if (!poster) return "";
  const lowered = poster.toLowerCase();
  if (lowered.includes("favicon") || lowered.includes("placeholder") || lowered.includes("no-poster")) return "";
  try {
    const url = new URL(poster);
    if (url.hostname.toLowerCase().includes("image.tmdb.org")) {
      return `tmdb-poster:${url.pathname.split("/").filter(Boolean).pop() || poster}`;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Non-URL poster references are still useful when the exact value matches.
  }
  return poster;
}

function preferredShowTitle(current, candidate) {
  const existing = cleanString(current);
  const next = cleanString(candidate);
  if (!existing) return next || "Unknown Show";
  if (!next) return existing;
  const existingIsAllCaps = existing === existing.toUpperCase() && /[A-Z]/.test(existing);
  const nextIsAllCaps = next === next.toUpperCase() && /[A-Z]/.test(next);
  if (existingIsAllCaps && !nextIsAllCaps) return next;
  return existing;
}

function showTitleFrom(title = "") {
  const text = cleanString(decodeBasicHtmlEntities(title)) || "Unknown Show";
  const seasonMatch = text.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  if (seasonMatch?.[1]) return seasonMatch[1].trim() || "Unknown Show";
  const alternateMatch = text.match(/^(.*?)(?:\s+-\s+Season\s+\d+.*)$/i);
  if (alternateMatch?.[1]) return alternateMatch[1].trim() || "Unknown Show";
  return text.split(" - ")[0].trim() || "Unknown Show";
}

export function mediaKeyFor(record = {}) {
  const type = normalizeMediaType(record.media_type || record.mediaType || record.type);
  const coordinates = [normalizeKeyPart(type), normalizeKeyPart(record.season), normalizeKeyPart(record.episode)].join(":");
  const ids = record.ids || {};
  if (record.imdb_id || record.imdb || ids.imdb) return `${coordinates}:imdb:${normalizeKeyPart(record.imdb_id || record.imdb || ids.imdb)}`;
  if (record.tmdb_id || record.tmdb || ids.tmdb) return `${coordinates}:tmdb:${normalizeKeyPart(record.tmdb_id || record.tmdb || ids.tmdb)}`;
  if (record.tvdb_id || record.tvdb || ids.tvdb) return `${coordinates}:tvdb:${normalizeKeyPart(record.tvdb_id || record.tvdb || ids.tvdb)}`;
  return `${coordinates}:title:${normalizeKeyPart(record.title)}`;
}

function playbackProgressKey(record = {}) {
  return mediaKeyFor(record);
}

function normalizeImportedTitle(record = {}, mediaType = "") {
  const movie = record.movie || {};
  const show = record.show || {};
  const episode = record.episode || {};

  if (mediaType === "episode") {
    const showTitle = record.show_title || show.title || (typeof record.show === "string" ? record.show : "");
    const season = record.season || episode.season || "";
    const episodeNumber = record.episode_number || episode.number || "";
    if (showTitle && (season || episodeNumber)) {
      return `${showTitle} - S${String(season || "?").padStart(2, "0")}E${String(episodeNumber || "?").padStart(2, "0")}`;
    }
  }

  return cleanString(decodeBasicHtmlEntities(
    record.title ||
      record.name ||
      record.movie_title ||
      record.show_title ||
      movie.title ||
      show.title ||
      episode.title ||
      (typeof record.show === "string" ? record.show : "") ||
      (typeof record.movie === "string" ? record.movie : "") ||
      record.Title ||
      "",
  ));
}

export function normalizeWatchRecord(record = {}, fallbackSource = "trakt_import") {
  const mediaType = normalizeMediaType(record.media_type || record.mediaType || record.type);
  const ids = record.ids || record.movie?.ids || record.show?.ids || record.episode?.ids || {};
  const normalized = {
    title: normalizeImportedTitle(record, mediaType),
    media_type: mediaType,
    watched_at: normalizeWatchedAt(
      record.watched_at ||
        record.watchedAt ||
        record.watched_at_utc ||
        record.last_watched_at ||
        record.lastWatchedAt ||
        record.scrobbled_at ||
        record.collected_at ||
        record.date ||
        record.Date,
    ),
    source: cleanString(record.source || fallbackSource) || fallbackSource,
    imdb_id: emptyToNull(record.imdb_id || record.imdbId || record.imdb || ids.imdb),
    tmdb_id: emptyToNull(record.tmdb_id || record.tmdbId || record.tmdb || ids.tmdb),
    tvdb_id: emptyToNull(record.tvdb_id || record.tvdbId || record.tvdb || ids.tvdb),
    season: numberOrNull(record.season || record.episode?.season),
    episode: numberOrNull(record.episode_number || record.episode?.number || (typeof record.episode === "object" ? "" : record.episode)),
    poster_url: emptyToNull(record.poster_url || record.posterUrl),
    sync_action: cleanString(record.sync_action || record.syncAction || record.action) || "watched",
    sync_dispatch_telemetry: emptyToNull(record.sync_dispatch_telemetry || record.syncDispatchTelemetry),
    episode_title: emptyToNull(record.episode_title || record.episodeTitle || record.episode?.title),
  };
  return normalized;
}

export function mediaToWatchRecord(media, source = media?.source || "webhook") {
  return normalizeWatchRecord(
    {
      title: media?.title,
      media_type: media?.type,
      watched_at: media?.watched_at || new Date().toISOString(),
      source,
      imdb_id: media?.ids?.imdb,
      tmdb_id: media?.ids?.tmdb,
      tvdb_id: media?.ids?.tvdb,
      season: media?.season,
      episode: media?.episode,
      poster_url: media?.posterUrl || media?.poster_url,
      sync_action: media?.syncAction || media?.sync_action || "watched",
      sync_dispatch_telemetry: media?.syncDispatchTelemetry,
      episode_title: media?.episodeTitle || media?.episode_title,
    },
    source,
  );
}

function validateWatchRecord(record) {
  const errors = [];
  if (!record.title) errors.push("title is required");
  if (!["movie", "episode"].includes(record.media_type)) errors.push("media_type must be movie or episode");
  if (!record.watched_at) errors.push("watched_at is required");
  if (!record.source) errors.push("source is required");
  return errors;
}

// Build the column params for a watch_history row (excludes id/created_at).
function watchRowParams(record) {
  const showTitle = record.media_type === "episode" ? showTitleFrom(record.title) : null;
  return {
    title: record.title,
    title_lower: record.title.toLowerCase(),
    media_type: record.media_type,
    watched_at: record.watched_at,
    source: record.source,
    imdb_id: record.imdb_id || null,
    tmdb_id: record.tmdb_id || null,
    tvdb_id: record.tvdb_id || null,
    season: record.season,
    episode: record.episode,
    poster_url: record.poster_url || null,
    logo_url: record.logo_url || null,
    youtube_url: null,
    sync_action: record.sync_action || "watched",
    sync_dispatch_telemetry: record.sync_dispatch_telemetry || null,
    media_key: mediaKeyFor(record),
    show_title: showTitle,
    show_title_lower: showTitle ? showTitle.toLowerCase() : null,
    episode_title: record.episode_title || null,
  };
}

export function watchRecordToFirestoreData(record, fallbackSource = record?.source || "import") {
  const normalized = normalizeWatchRecord(record, fallbackSource);
  const errors = validateWatchRecord(normalized);
  if (errors.length) throw new Error(errors.join(", "));
  const data = watchRowParams(normalized);
  // Preserve the historical field names a couple of callers still read.
  data.mediaKey = data.media_key;
  data.watchedAt = data.watched_at;
  return { data, record: normalized };
}

function rowToWatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: decodeBasicHtmlEntities(row.title || ""),
    media_type: row.media_type || "",
    watched_at: row.watched_at || "",
    source: row.source || "",
    imdb_id: row.imdb_id || null,
    tmdb_id: row.tmdb_id || null,
    tvdb_id: row.tvdb_id || null,
    season: row.season ?? null,
    episode: row.episode ?? null,
    poster_url: row.poster_url || null,
    logo_url: row.logo_url || null,
    youtube_url: row.youtube_url || null,
    sync_action: row.sync_action || "watched",
    sync_dispatch_telemetry: row.sync_dispatch_telemetry || null,
    media_key: row.media_key || null,
    show_title: row.show_title ? decodeBasicHtmlEntities(row.show_title) : null,
    episode_title: row.episode_title ? decodeBasicHtmlEntities(row.episode_title) : null,
  };
}

function isWatchedAction(row = {}) {
  return !["unwatched", "unplayed"].includes(String(row.sync_action || row.syncAction || "watched").toLowerCase());
}

function isScheduledLibraryHistoryRow(row = {}) {
  const telemetry = String(row.sync_dispatch_telemetry || row.syncDispatchTelemetry || "");
  return /Watch event fetched from (Plex|Emby|Jellyfin) library history/i.test(telemetry);
}

function isPlembfinTrackedWatchRow(row = {}) {
  return isWatchedAction(row) && !isScheduledLibraryHistoryRow(row);
}

function createStatsPeriod(period, label) {
  return {
    period,
    label,
    total: 0,
    movies: 0,
    episodes: 0,
    firstPlay: null,
    lastPlay: null,
    movieKeys: new Set(),
    showKeys: new Set(),
    sourceMap: new Map(),
    movieMap: new Map(),
    showMap: new Map(),
    mediaMap: new Map(),
  };
}

function statsMovieKey(row = {}) {
  return row.imdb_id || row.tmdb_id || row.tvdb_id || canonicalTitleKey(row.title) || row.title || "unknown-movie";
}

function statsShowKey(row = {}) {
  return canonicalTitleKey(row.show_title || showTitleFrom(row.title)) || row.show_title || showTitleFrom(row.title) || "unknown-show";
}

function compactStatsMedia(row = {}, { key, type, title } = {}) {
  return {
    id: row.id,
    key,
    type,
    title,
    poster_url: row.poster_url || null,
    media_key: row.media_key || null,
    imdb_id: row.imdb_id || null,
    tmdb_id: row.tmdb_id || null,
    tvdb_id: row.tvdb_id || null,
    latestWatch: row.watched_at || null,
  };
}

function bumpStatsMedia(map, key, item) {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, { ...item, count: 1 });
    return;
  }
  existing.count += 1;
  if (!existing.poster_url && item.poster_url) existing.poster_url = item.poster_url;
  if (!existing.id && item.id) existing.id = item.id;
  if (item.latestWatch && (!existing.latestWatch || item.latestWatch > existing.latestWatch)) {
    existing.latestWatch = item.latestWatch;
    if (item.id) existing.id = item.id;
    if (item.poster_url) existing.poster_url = item.poster_url;
    if (item.media_key) existing.media_key = item.media_key;
  }
}

function addRowToStatsPeriod(period, row = {}) {
  period.total += 1;
  if (!period.firstPlay || (row.watched_at && row.watched_at < period.firstPlay.latestWatch)) {
    period.firstPlay = compactStatsMedia(row, {
      key: row.media_type === "movie" ? `movie:${statsMovieKey(row)}` : `show:${statsShowKey(row)}`,
      type: row.media_type === "movie" ? "movie" : "episode",
      title: row.media_type === "movie" ? row.title || "Unknown movie" : row.show_title || showTitleFrom(row.title),
    });
  }
  if (!period.lastPlay || (row.watched_at && row.watched_at > period.lastPlay.latestWatch)) {
    period.lastPlay = compactStatsMedia(row, {
      key: row.media_type === "movie" ? `movie:${statsMovieKey(row)}` : `show:${statsShowKey(row)}`,
      type: row.media_type === "movie" ? "movie" : "episode",
      title: row.media_type === "movie" ? row.title || "Unknown movie" : row.show_title || showTitleFrom(row.title),
    });
  }
  const source = normalizePlatformSource(row.source);
  period.sourceMap.set(source, (period.sourceMap.get(source) || 0) + 1);
  if (row.media_type === "movie") {
    const key = `movie:${statsMovieKey(row)}`;
    const item = compactStatsMedia(row, { key, type: "movie", title: row.title || "Unknown movie" });
    period.movies += 1;
    period.movieKeys.add(key);
    bumpStatsMedia(period.movieMap, key, item);
    bumpStatsMedia(period.mediaMap, key, item);
    return;
  }

  if (row.media_type === "episode") {
    const showTitle = row.show_title || showTitleFrom(row.title);
    const key = `show:${statsShowKey(row)}`;
    const item = compactStatsMedia(row, { key, type: "episode", title: showTitle || "Unknown show" });
    period.episodes += 1;
    period.showKeys.add(key);
    bumpStatsMedia(period.showMap, key, item);
    bumpStatsMedia(period.mediaMap, key, item);
  }
}

function rankStatsItems(map, limit = 10) {
  return [...map.values()]
    .sort((a, b) => b.count - a.count || String(a.title || "").localeCompare(String(b.title || "")))
    .slice(0, limit);
}

function finalizeStatsPeriod(period) {
  return {
    period: period.period,
    label: period.label,
    total: period.total,
    movieWatches: period.movies,
    tvWatches: period.episodes,
    uniqueMovies: period.movieKeys.size,
    uniqueShows: period.showKeys.size,
    firstPlay: period.firstPlay,
    lastPlay: period.lastPlay,
    sourceBreakdown: [...period.sourceMap.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count),
    topSource: [...period.sourceMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "none",
    topMovies: rankStatsItems(period.movieMap),
    topShows: rankStatsItems(period.showMap),
    topMedia: rankStatsItems(period.mediaMap),
  };
}

// --- History caches --------------------------------------------------------
export async function getCachedHistory() {
  const version = getDataVersion();
  if (historyCache.version === version) return historyCache.rows;
  const rows = selectAllHistoryStmt.all().map(rowToWatch);
  historyCache = { version, rows };
  return rows;
}

export async function getCachedMovies() {
  const version = getDataVersion();
  if (movieCache.version === version && Array.isArray(movieCache.rows)) return movieCache.rows;
  const rows = selectMoviesStmt.all().map(rowToWatch).filter(isPlembfinTrackedWatchRow);
  movieCache = { version, rows };
  return rows;
}

export async function getCachedShows() {
  const version = getDataVersion();
  if (showCache.version === version && showCache.shows.length > 0) return showCache.shows;
  const episodeRows = (await getCachedHistory()).filter((r) => r.media_type === "episode" && isPlembfinTrackedWatchRow(r));
  const groups = groupShowRows(dedupeHistory(episodeRows));
  const shows = groups.map((group) => {
    const showKey = canonicalTitleKey(group.title) || normalizeKeyPart(group.title);
    const cachedProgress = getCachedShowProgress(showKey);
    const tmdbId = cachedShowTmdbId(cachedProgress?.tmdb_id, group.tmdb_id, group.representative_episode?.tmdb_id);
    let posterUrl = group.poster_url || group.representative_episode?.poster_url || "";
    let status = "";
    if (tmdbId) {
      try {
        const details = cachedTmdbShowDetails(tmdbId);
        if (details) {
          status = details.status || "";
          if (!posterUrl && details.poster_path) posterUrl = `/api/tmdb-poster?path=${encodeURIComponent(details.poster_path)}`;
        }
      } catch (err) {
        console.error(`Failed to get TV show details for tv_${tmdbId}`, err);
      }
    }
    return {
      id: showKey,
      title: group.title,
      tmdb_id: tmdbId,
      status,
      poster_url: posterUrl || null,
      episode_count: group.episode_count,
      season_count: group.season_count,
      latest_watched_at: group.latest_watched_at,
      earliest_watched_at: group.earliest_watched_at,
      representative_episode: compactEpisode(group.representative_episode),
      total_episodes: cachedProgress?.total_episodes || 0,
    };
  });
  showCache = { version, shows };
  return shows;
}


// --- Playstate -------------------------------------------------------------
const selectPlaystateStmt = db.prepare("SELECT * FROM playstate WHERE media_key = ?");
const selectPlaystateByTitleStmt = db.prepare("SELECT * FROM playstate WHERE media_type = ? AND title_lower = ?");
const upsertPlaystateStmt = db.prepare(
  `INSERT INTO playstate (media_key, title, title_lower, media_type, state, watched_at, last_source, sources, imdb_id, tmdb_id, tvdb_id, season, episode, poster_url, updated_at)
   VALUES (@media_key, @title, @title_lower, @media_type, @state, @watched_at, @last_source, @sources, @imdb_id, @tmdb_id, @tvdb_id, @season, @episode, @poster_url, @updated_at)
   ON CONFLICT(media_key) DO UPDATE SET title=excluded.title, title_lower=excluded.title_lower, media_type=excluded.media_type,
     state=excluded.state, watched_at=excluded.watched_at, last_source=excluded.last_source, sources=excluded.sources,
     imdb_id=excluded.imdb_id, tmdb_id=excluded.tmdb_id, tvdb_id=excluded.tvdb_id, season=excluded.season, episode=excluded.episode,
     poster_url=excluded.poster_url, updated_at=excluded.updated_at`,
);
const selectWatchedPlaystateStmt = db.prepare("SELECT * FROM playstate WHERE state = 'watched' LIMIT ? OFFSET ?");
const countWatchedPlaystateStmt = db.prepare("SELECT COUNT(*) AS c FROM playstate WHERE state = 'watched'");

function playstateFromRow(row) {
  return {
    id: row.media_key,
    media_key: row.media_key,
    title: decodeBasicHtmlEntities(row.title || ""),
    media_type: row.media_type || "",
    watched_at: row.watched_at || "",
    state: row.state || "watched",
    source: row.last_source || "",
    sources: parseJson(row.sources, []) || [],
    imdb_id: row.imdb_id || null,
    tmdb_id: row.tmdb_id || null,
    tvdb_id: row.tvdb_id || null,
    season: row.season ?? null,
    episode: row.episode ?? null,
    poster_url: row.poster_url || null,
    updated_at: Number(row.updated_at || 0),
  };
}

function normalizePlaystateState(value = "watched") {
  const state = cleanString(value).toLowerCase();
  return ["unwatched", "unplayed"].includes(state) ? "unwatched" : "watched";
}

export function playstateRecordFromMedia(media = {}, state = media?.syncAction || "watched", watchedAt = undefined) {
  const record = mediaToWatchRecord(
    {
      ...media,
      syncAction: normalizePlaystateState(state) === "unwatched" ? "unwatched" : "watched",
    },
    media?.source || "webhook",
  );
  if (watchedAt) record.watched_at = normalizeWatchedAt(watchedAt);
  return record;
}

export async function upsertPlaystate(_unusedDb, record, stateOverride = undefined, { skipInvalidate = false } = {}) {
  const normalized = normalizeWatchRecord(record, record.source || "webhook");
  const errors = validateWatchRecord(normalized);
  if (errors.length) throw new Error(errors.join(", "));

  const state = normalizePlaystateState(stateOverride || normalized.sync_action);
  const mediaKey = mediaKeyFor(normalized);
  const existing = selectPlaystateStmt.get(mediaKey);
  const sources = new Set(parseJson(existing?.sources, []) || []);
  if (normalized.source) sources.add(normalized.source);

  upsertPlaystateStmt.run({
    media_key: mediaKey,
    title: normalized.title,
    title_lower: normalized.title.toLowerCase(),
    media_type: normalized.media_type,
    state,
    watched_at: normalized.watched_at,
    last_source: normalized.source,
    sources: toJson([...sources].sort()),
    imdb_id: normalized.imdb_id || null,
    tmdb_id: normalized.tmdb_id || null,
    tvdb_id: normalized.tvdb_id || null,
    season: normalized.season,
    episode: normalized.episode,
    poster_url: normalized.poster_url || existing?.poster_url || null,
    updated_at: Date.now(),
  });

  if (!skipInvalidate) await invalidateHistoryDerivedCaches();
  return { mediaKey, state, record: normalized };
}

export async function upsertPlaystateForMedia(_unusedDb, media, state = "watched", watchedAt = undefined, options = {}) {
  return upsertPlaystate(_unusedDb, playstateRecordFromMedia(media, state, watchedAt), state, options);
}

function sameEpisodeCoordinates(a = {}, b = {}) {
  if (normalizeMediaType(a.media_type || a.mediaType) !== "episode") return true;
  return Number(a.season ?? -1) === Number(b.season ?? -1) && Number(a.episode ?? -1) === Number(b.episode ?? -1);
}

function newestByUpdatedAt(rows = []) {
  return rows
    .filter(Boolean)
    .sort((a, b) => Number(b.updated_at || b.updatedAt || 0) - Number(a.updated_at || a.updatedAt || 0))[0] || null;
}

export async function getPlaystateForMedia(_unusedDb, media) {
  const record = playstateRecordFromMedia(media, media?.syncAction || "watched");
  const exact = selectPlaystateStmt.get(mediaKeyFor(record));
  const related = selectPlaystateByTitleStmt
    .all(record.media_type, record.title.toLowerCase())
    .filter((row) => sameEpisodeCoordinates(record, row));
  const row = newestByUpdatedAt([exact, ...related]);
  return row ? playstateFromRow(row) : null;
}

export async function listWatchedPlaystateRowsForReplay({ limit = 25, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  return selectWatchedPlaystateStmt.all(safeLimit, safeOffset).map(playstateFromRow);
}

export async function countWatchedPlaystateRows() {
  return countWatchedPlaystateStmt.get().c || 0;
}

function queueProgressUpdateForRecord(record) {
  if (record && (record.media_type === "episode" || record.mediaType === "episode")) {
    const showTitle = record.show_title || record.showTitle || showTitleFrom(record.title);
    if (showTitle) {
      queueShowProgressUpdate(showTitle);
    }
  }
}

export async function invalidateHistoryDerivedCaches() {
  await flushShowProgressUpdates().catch((err) => {
    console.error("[firestoreRepo] Failed to flush show progress updates", err);
  });
  bumpDataVersion();
}

// --- Watch history writes --------------------------------------------------
export async function insertWatchRecord(_unusedDb, record, { skipInvalidate = false } = {}) {
  const normalized = normalizeWatchRecord(record, record.source);
  const errors = validateWatchRecord(normalized);
  if (errors.length) throw new Error(errors.join(", "));

  // Queue show progress update
  queueProgressUpdateForRecord(normalized);

  const id = crypto.randomUUID();
  const params = watchRowParams(normalized);
  insertWatchStmt.run({ id, ...params, created_at: Date.now(), updated_at: Date.now() });
  if (!skipInvalidate) await invalidateHistoryDerivedCaches();

  // Eagerly pull + store TMDB metadata/artwork at ingest (fire-and-forget;
  // returned so the webhook can await it before responding if it wants to).
  let assetPrefetch = Promise.resolve(null);
  if (normalized.tmdb_id || normalized.title) {
    assetPrefetch = prefetchTmdbMetadataBackground(normalized.media_type, normalized.tmdb_id, normalized.title, id).catch(() => null);
  }
  return { id, record: normalized, assetPrefetch };
}

function defaultTelemetry(record) {
  const source = record?.source || "unknown";
  if (String(source).includes("import")) {
    return [
      `Origin: ${source}`,
      `Loop-check: Skipped propagation`,
      `Dispatch status: skipped`,
      `Details: Historical import stored locally without outbound sync`,
      `Target plex status: not attempted`,
      `Target emby status: not attempted`,
      `Target jellyfin status: not attempted`,
    ].join("\n");
  }
  return [`Origin: ${source}`, `Loop-check: Pending`, `Dispatch status: pending`, `Details: Awaiting outbound sync telemetry`].join("\n");
}

export async function batchInsertWatchRecords(_unusedDb, records) {
  let inserted = 0;
  let skipped = 0;
  const rejected = [];
  const toInsert = [];

  const config = await loadMediaConfig().catch(() => ({}));
  const tmdbApiKey = config.tmdb?.apiKey;

  const prepareRecord = async (record, index) => {
    const normalized = normalizeWatchRecord(record, "trakt_import");
    const errors = validateWatchRecord(normalized);
    if (errors.length) return { action: "reject", index, errors };

    if (findExistingStmt.get(mediaKeyFor(normalized), normalized.watched_at)) return { action: "skip" };

    if (tmdbApiKey && !normalized.poster_url) {
      normalized.poster_url = await fetchPosterFromTmdb(normalized, tmdbApiKey);
    }
    return { action: "insert", normalized };
  };

  const CHUNK_SIZE = 10;
  for (let start = 0; start < records.length; start += CHUNK_SIZE) {
    const chunk = records.slice(start, start + CHUNK_SIZE);
    const outcomes = await Promise.all(chunk.map((record, offset) => prepareRecord(record, start + offset)));
    for (const outcome of outcomes) {
      if (outcome.action === "reject") {
        rejected.push({ index: outcome.index, errors: outcome.errors });
      } else if (outcome.action === "skip") {
        skipped += 1;
      } else {
        toInsert.push(outcome.normalized);
        inserted += 1;
      }
    }
  }

  if (toInsert.length) {
    transaction(() => {
      for (const normalized of toInsert) {
        // Queue show progress update
        queueProgressUpdateForRecord(normalized);
        const params = watchRowParams({
          ...normalized,
          sync_dispatch_telemetry: normalized.sync_dispatch_telemetry || defaultTelemetry(normalized),
        });
        insertWatchStmt.run({ id: crypto.randomUUID(), ...params, created_at: Date.now(), updated_at: Date.now() });
      }
    });
    for (const normalized of toInsert) {
      if (normalized.tmdb_id || normalized.title) {
        prefetchTmdbMetadataBackground(normalized.media_type, normalized.tmdb_id, normalized.title).catch(() => null);
      }
    }
    await invalidateHistoryDerivedCaches();
  }
  return { inserted, updated: 0, skipped, rejected };
}

const updateTelemetryStmt = db.prepare("UPDATE watch_history SET sync_dispatch_telemetry = ?, updated_at = ? WHERE id = ?");
const updatePlaystateWatchedAtStmt = db.prepare("UPDATE playstate SET watched_at = ?, updated_at = ? WHERE media_key = ?");
const updateWatchRowWatchedAtStmt = db.prepare("UPDATE watch_history SET watched_at = ?, updated_at = ? WHERE id = ?");

function relatedTrackedWatchRowsForDateEdit(existing = {}) {
  if (!existing.id) return [];
  if (existing.media_type !== "episode") {
    return existing.media_key
      ? selectByMediaKeyStmt.all(existing.media_key).filter((row) => row.id !== existing.id && isPlembfinTrackedWatchRow(row))
      : [];
  }

  const showKey = canonicalTitleKey(existing.show_title || showTitleFrom(existing.title));
  const season = existing.season == null ? null : Number(existing.season);
  const episode = existing.episode == null ? null : Number(existing.episode);
  if (!showKey || season == null || episode == null) return [];

  return selectAllEpisodesStmt.all().filter((row) => {
    if (row.id === existing.id || !isPlembfinTrackedWatchRow(row)) return false;
    if (Number(row.season) !== season || Number(row.episode) !== episode) return false;
    return canonicalTitleKey(row.show_title || showTitleFrom(row.title)) === showKey;
  });
}

export async function updateWatchTelemetry(_unusedDb, id, telemetry, { skipInvalidate = false } = {}) {
  if (!id) return;
  updateTelemetryStmt.run(String(telemetry || ""), Date.now(), String(id));
  if (!skipInvalidate) await invalidateHistoryDerivedCaches();
}

// --- Playback progress -----------------------------------------------------
const upsertProgressStmt = db.prepare(
  `INSERT INTO playback_progress (media_key, title, media_type, source, imdb_id, tmdb_id, tvdb_id, season, episode, position_ms, duration_ms, progress, updated_at, sync_dispatch_telemetry)
   VALUES (@media_key, @title, @media_type, @source, @imdb_id, @tmdb_id, @tvdb_id, @season, @episode, @position_ms, @duration_ms, @progress, @updated_at, @sync_dispatch_telemetry)
   ON CONFLICT(media_key) DO UPDATE SET title=excluded.title, media_type=excluded.media_type, source=excluded.source,
     imdb_id=excluded.imdb_id, tmdb_id=excluded.tmdb_id, tvdb_id=excluded.tvdb_id, season=excluded.season, episode=excluded.episode,
     position_ms=excluded.position_ms, duration_ms=excluded.duration_ms, progress=excluded.progress, updated_at=excluded.updated_at,
     sync_dispatch_telemetry=excluded.sync_dispatch_telemetry`,
);
const updateProgressTelemetryStmt = db.prepare(
  `INSERT INTO playback_progress (media_key, sync_dispatch_telemetry, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(media_key) DO UPDATE SET sync_dispatch_telemetry=excluded.sync_dispatch_telemetry, updated_at=excluded.updated_at`,
);
const deleteProgressStmt = db.prepare("DELETE FROM playback_progress WHERE media_key = ?");
const selectProgressStmt = db.prepare("SELECT * FROM playback_progress WHERE media_key = ?");
const selectProgressByTitleStmt = db.prepare("SELECT * FROM playback_progress WHERE media_type = ? AND LOWER(title) = ?");
const selectProgressReplayStmt = db.prepare("SELECT * FROM playback_progress ORDER BY updated_at DESC LIMIT ? OFFSET ?");
const countProgressStmt = db.prepare("SELECT COUNT(*) AS c FROM playback_progress");

function playbackProgressFromRow(row) {
  return {
    id: row.media_key,
    media_key: row.media_key,
    title: decodeBasicHtmlEntities(row.title || ""),
    media_type: row.media_type || "",
    source: row.source || "",
    imdb_id: row.imdb_id || null,
    tmdb_id: row.tmdb_id || null,
    tvdb_id: row.tvdb_id || null,
    season: row.season ?? null,
    episode: row.episode ?? null,
    position_ms: Number(row.position_ms || 0),
    duration_ms: row.duration_ms ?? null,
    progress: Number(row.progress || 0),
    updated_at: Number(row.updated_at || 0),
    sync_dispatch_telemetry: row.sync_dispatch_telemetry || null,
  };
}

export function normalizePlaybackProgressRecord(record = {}, fallbackSource = "webhook") {
  const title = cleanString(record.title || record.name || "");
  const mediaType = normalizeMediaType(record.media_type || record.mediaType || record.type);
  const source = cleanString(record.source || fallbackSource) || fallbackSource;
  const positionMs = Math.max(0, Math.round(Number(record.position_ms ?? record.positionMs ?? record.offsetMs ?? 0)));
  const durationMsValue = Number(record.duration_ms ?? record.durationMs ?? 0);
  const durationMs = Number.isFinite(durationMsValue) && durationMsValue > 0 ? Math.round(durationMsValue) : null;
  const progressValue = Number(record.progress ?? (durationMs ? (positionMs / durationMs) * 100 : 0));
  const normalized = {
    title,
    media_type: mediaType,
    source,
    imdb_id: emptyToNull(record.imdb_id || record.imdbId || record.imdb || record.ids?.imdb),
    tmdb_id: emptyToNull(record.tmdb_id || record.tmdbId || record.tmdb || record.ids?.tmdb),
    tvdb_id: emptyToNull(record.tvdb_id || record.tvdbId || record.tvdb || record.ids?.tvdb),
    season: numberOrNull(record.season),
    episode: numberOrNull(record.episode),
    position_ms: positionMs,
    duration_ms: durationMs,
    progress: Number.isFinite(progressValue) ? Math.max(0, Math.min(100, progressValue)) : 0,
    updated_at: Number(record.updated_at || record.updatedAt || Date.now()),
    sync_dispatch_telemetry: emptyToNull(record.sync_dispatch_telemetry || record.syncDispatchTelemetry),
  };
  return { ...normalized, media_key: record.media_key || record.mediaKey || playbackProgressKey(normalized) };
}

export function mediaToPlaybackProgressRecord(media, source = media?.source || "webhook") {
  return normalizePlaybackProgressRecord(
    {
      title: media?.title,
      media_type: media?.type || media?.mediaType,
      source,
      imdb_id: media?.ids?.imdb,
      tmdb_id: media?.ids?.tmdb,
      tvdb_id: media?.ids?.tvdb,
      season: media?.season,
      episode: media?.episode,
      position_ms: media?.positionMs ?? media?.offsetMs,
      duration_ms: media?.durationMs,
      progress: media?.progress,
      updated_at: media?.updatedAt,
      sync_dispatch_telemetry: media?.syncDispatchTelemetry,
    },
    source,
  );
}

export async function upsertPlaybackProgress(_unusedDb, record) {
  const normalized = normalizePlaybackProgressRecord(record, record.source);
  if (!normalized.title) throw new Error("title is required");
  if (!["movie", "episode"].includes(normalized.media_type)) throw new Error("media_type must be movie or episode");
  if (!normalized.position_ms) throw new Error("position_ms is required");

  upsertProgressStmt.run({
    media_key: normalized.media_key,
    title: normalized.title,
    media_type: normalized.media_type,
    source: normalized.source,
    imdb_id: normalized.imdb_id || null,
    tmdb_id: normalized.tmdb_id || null,
    tvdb_id: normalized.tvdb_id || null,
    season: normalized.season,
    episode: normalized.episode,
    position_ms: normalized.position_ms,
    duration_ms: normalized.duration_ms,
    progress: normalized.progress,
    updated_at: normalized.updated_at,
    sync_dispatch_telemetry: normalized.sync_dispatch_telemetry,
  });
  if (normalized.tmdb_id || normalized.title) {
    prefetchTmdbMetadataBackground(normalized.media_type, normalized.tmdb_id, normalized.title).catch(() => null);
  }
  return normalized;
}

export async function updatePlaybackProgressTelemetry(_unusedDb, mediaOrRecord, telemetry) {
  const normalized = normalizePlaybackProgressRecord(mediaOrRecord, mediaOrRecord?.source);
  updateProgressTelemetryStmt.run(normalized.media_key, String(telemetry || ""), Date.now());
}

export async function getPlaybackProgressForMedia(_unusedDb, mediaOrRecord) {
  const normalized = normalizePlaybackProgressRecord(mediaOrRecord, mediaOrRecord?.source);
  const exact = selectProgressStmt.get(normalized.media_key);
  const related = selectProgressByTitleStmt
    .all(normalized.media_type, normalized.title.toLowerCase())
    .filter((row) => sameEpisodeCoordinates(normalized, row));
  const row = newestByUpdatedAt([exact, ...related]);
  return row ? playbackProgressFromRow(row) : null;
}

export async function deletePlaybackProgress(_unusedDb, mediaOrRecord) {
  const normalized = normalizePlaybackProgressRecord(mediaOrRecord, mediaOrRecord?.source);
  if (!normalized.media_key) return false;
  const related = normalized.title
    ? selectProgressByTitleStmt
        .all(normalized.media_type, normalized.title.toLowerCase())
        .filter((row) => sameEpisodeCoordinates(normalized, row))
    : [];
  const keys = new Set([normalized.media_key, ...related.map((row) => row.media_key).filter(Boolean)]);
  for (const key of keys) {
    deleteProgressStmt.run(key);
  }
  return keys.size > 0;
}

export async function listPlaybackProgressRowsForReplay({ limit = 25, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  return selectProgressReplayStmt.all(safeLimit, safeOffset).map(playbackProgressFromRow);
}

export async function countPlaybackProgressRows() {
  return countProgressStmt.get().c || 0;
}

// --- Live tracking cache ---------------------------------------------------
const selectLiveStmt = db.prepare("SELECT * FROM live_tracking_cache ORDER BY updated_at DESC");
const upsertLiveStmt = db.prepare(
  `INSERT INTO live_tracking_cache (session_id, title, source_platform, last_progress, updated_at, completed_at, payload, expire_at)
   VALUES (@session_id, @title, @source_platform, @last_progress, @updated_at, @completed_at, @payload, @expire_at)
   ON CONFLICT(session_id) DO UPDATE SET title=excluded.title, source_platform=excluded.source_platform,
     last_progress=excluded.last_progress, updated_at=excluded.updated_at, completed_at=excluded.completed_at,
     payload=excluded.payload, expire_at=excluded.expire_at`,
);
const markLiveCompleteStmt = db.prepare(
  `INSERT INTO live_tracking_cache (session_id, completed_at, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(session_id) DO UPDATE SET completed_at=excluded.completed_at, updated_at=excluded.updated_at`,
);
const deleteLiveStmt = db.prepare("DELETE FROM live_tracking_cache WHERE session_id = ?");
const selectAllLiveStmt = db.prepare("SELECT * FROM live_tracking_cache");
const deleteLiveByIdStmt = db.prepare("DELETE FROM live_tracking_cache WHERE session_id = ?");

export async function loadLiveTrackingCache(_unusedDb, { includeCompleted = false } = {}) {
  return selectLiveStmt.all()
    .map((row) => ({
      session_id: row.session_id,
      title: row.title || "",
      source_platform: row.source_platform || "",
      last_progress: Number(row.last_progress || 0),
      updated_at: Number(row.updated_at || 0),
      completed_at: row.completed_at ?? null,
      payload_json: row.payload || "{}",
    }))
    .filter((row) => includeCompleted || row.completed_at == null);
}

export async function upsertLiveTrackingCache(_unusedDb, rows = []) {
  if (!rows.length) return;
  transaction(() => {
    for (const row of rows) {
      upsertLiveStmt.run({
        session_id: String(row.session_id),
        title: row.title,
        source_platform: row.source_platform,
        last_progress: Number(row.last_progress || 0),
        updated_at: Number(row.updated_at || Date.now()),
        completed_at: row.completed_at == null ? null : Number(row.completed_at),
        payload: row.payload_json || "{}",
        expire_at: Date.now() + 24 * 60 * 60 * 1000,
      });
    }
  });
}

export async function markLiveTrackingComplete(_unusedDb, sessionId, completedAt = Date.now()) {
  if (!sessionId) return;
  markLiveCompleteStmt.run(String(sessionId), Number(completedAt), Number(completedAt));
}

export async function deleteLiveTrackingCacheRows(_unusedDb, sessionIds = []) {
  const ids = sessionIds.map((sessionId) => cleanString(sessionId)).filter(Boolean);
  if (!ids.length) return;
  transaction(() => {
    for (const id of ids) deleteLiveStmt.run(id);
  });
}

export async function purgeCompletedLiveTrackingCache(_unusedDb, olderThan = Date.now() - 24 * 60 * 60 * 1000) {
  const rows = selectAllLiveStmt.all();
  transaction(() => {
    for (const row of rows) {
      if (row.completed_at != null && Number(row.updated_at || 0) < olderThan) deleteLiveByIdStmt.run(row.session_id);
    }
  });
}

// --- History queries -------------------------------------------------------
async function loadHistoryRows({ limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), MAX_HISTORY_LIMIT);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const allRows = await getCachedHistory();
  return allRows.slice(safeOffset, safeOffset + safeLimit);
}

async function loadHistoryRowsByType({ mediaType, limit = 50, offset = 0, sort = "watched_desc" } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), MAX_HISTORY_LIMIT);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const allRows = await getCachedHistory();
  const filtered = allRows.filter((row) => row.media_type === mediaType && isPlembfinTrackedWatchRow(row));
  const sorted = [...filtered];
  if (sort === "watched_asc") {
    sorted.sort((a, b) => a.watched_at.localeCompare(b.watched_at));
  } else {
    sorted.sort((a, b) => b.watched_at.localeCompare(a.watched_at));
  }
  return sorted.slice(safeOffset, safeOffset + safeLimit);
}

function matchesSearch(row, search) {
  if (!search) return true;
  const haystack = [row.title, row.source, row.imdb_id, row.tmdb_id, row.tvdb_id, row.sync_dispatch_telemetry].join(" ").toLowerCase();
  return haystack.includes(search.toLowerCase());
}

function titleContainsSearch(title, search) {
  const needle = cleanString(search).toLowerCase();
  if (!needle) return true;
  return cleanString(title).toLowerCase().includes(needle);
}

function dedupeHistory(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = historyDedupeKey(row);
    if (map.has(key)) {
      const existing = map.get(key);
      if (!existing.playHistory) existing.playHistory = [existing.watched_at];
      existing.playHistory.push(row.watched_at);
      if (!existing.poster_url && row.poster_url) existing.poster_url = row.poster_url;
      if (row.watched_at > existing.watched_at) {
        const playHistory = existing.playHistory;
        map.set(key, { ...row, playHistory });
      }
    } else {
      map.set(key, { ...row, playHistory: [row.watched_at] });
    }
  }
  const result = [...map.values()];
  for (const row of result) {
    if (row.playHistory) row.playHistory.sort((a, b) => a.localeCompare(b));
  }
  return result;
}

function historyDedupeKey(row = {}) {
  const mediaType = normalizeMediaType(row.media_type);
  const imdb = cleanString(row.imdb_id);
  const tmdb = cleanString(row.tmdb_id);
  const tvdb = cleanString(row.tvdb_id);

  if (mediaType === "episode") {
    const season = row.season ?? "unknown";
    const episode = row.episode ?? "unknown";
    const showTitle = canonicalTitleKey(row.show_title || showTitleFrom(row.title));
    if (showTitle && season !== "unknown" && episode !== "unknown") {
      return `episode|show:${showTitle}|s:${season}|e:${episode}`;
    }
    return `episode|id:${imdb || tmdb || tvdb || canonicalTitleKey(row.title)}|s:${season}|e:${episode}`;
  }

  if (mediaType === "movie") {
    const title = canonicalTitleKey(row.title);
    const poster = stablePosterKey(row.poster_url);
    // Prefer a stable content identifier so the same movie watched more than once
    // (and re-fetched with a different poster URL each time) collapses to one entry.
    // Poster/title are only a fallback when no external ID is present.
    return `movie|${imdb ? `imdb:${imdb}` : tmdb ? `tmdb:${tmdb}` : tvdb ? `tvdb:${tvdb}` : poster ? `poster:${poster}` : `title:${title}`}`;
  }

  return `${mediaType || "unknown"}|${canonicalTitleKey(row.title)}|${row.watched_at || ""}`;
}

export async function listRecentTrackedWatchRows({ limit = 100, scanLimit = 400 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeScanLimit = Math.min(Math.max(Number(scanLimit) || safeLimit * 4, safeLimit), 2000);
  const rows = selectRecentStmt.all(safeScanLimit).map(rowToWatch).filter(isPlembfinTrackedWatchRow);
  return dedupeHistory(rows).slice(0, safeLimit);
}

export async function queryWatchHistory(_unusedDb, { search = "", limit = 50, offset = 0, dedupe = true } = {}) {
  const safeLimit = Math.min(Number(limit) || 50, MAX_HISTORY_LIMIT);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const rows = await loadHistoryRows({ limit: MAX_HISTORY_LIMIT, offset: 0 });
  const filtered = rows.filter((row) => isPlembfinTrackedWatchRow(row) && matchesSearch(row, cleanString(search)));
  const processed = dedupe ? dedupeHistory(filtered) : filtered;
  return processed.slice(safeOffset, safeOffset + safeLimit);
}

function compactHistoryPreviewRow(row = {}) {
  return {
    id: row.id,
    title: row.title,
    media_type: row.media_type,
    watched_at: row.watched_at,
    source: row.source,
    season: row.season,
    episode: row.episode,
    poster_url: row.poster_url,
    sync_action: row.sync_action,
    sync_dispatch_telemetry: row.sync_dispatch_telemetry,
    media_key: row.media_key,
    show_title: row.show_title,
  };
}

export async function queryWatchHistoryPreview({ limit = 120 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 120, 1), 300);
  const all = await getCachedHistory();
  const tvRows = all.filter((row) => row.media_type === "episode" && isPlembfinTrackedWatchRow(row)).slice(0, HISTORY_PREVIEW_SCAN_LIMIT);
  const movieRows = all.filter((row) => row.media_type === "movie" && isPlembfinTrackedWatchRow(row)).slice(0, HISTORY_PREVIEW_SCAN_LIMIT);

  const tvDeduped = dedupeHistory(tvRows).slice(0, safeLimit).map(compactHistoryPreviewRow);
  const movieDeduped = dedupeHistory(movieRows).slice(0, safeLimit).map(compactHistoryPreviewRow);

  const combined = [...tvDeduped, ...movieDeduped];
  combined.sort((a, b) => b.watched_at.localeCompare(a.watched_at));
  return combined;
}

function dispatchStatusFromTelemetry(value = "") {
  const text = String(value || "");
  if (text.includes("Force Sync resolved status to")) return "success";
  const line = text.split(/\r?\n/).find((item) => item.toLowerCase().startsWith("dispatch status:"));
  return line ? line.slice("dispatch status:".length).trim().toLowerCase() : "";
}

function telemetryLineValue(value = "", label = "") {
  const prefix = `${label}:`;
  const line = String(value || "").split(/\r?\n/).find((item) => item.toLowerCase().startsWith(prefix.toLowerCase()));
  return line ? line.slice(prefix.length).trim() : "";
}

function telemetryHasTargetStatus(value = "") {
  return String(value || "")
    .split(/\r?\n/)
    .some((line) => /^(plex|emby|jellyfin)\s+(?:progress\s+)?status:/i.test(line.trim()));
}

function isLegacyInitialSyncPlaceholder(row = {}) {
  const telemetry = row.sync_dispatch_telemetry || "";
  const origin = telemetryLineValue(telemetry, "Origin").toLowerCase();
  const details = telemetryLineValue(telemetry, "Details").toLowerCase();
  return origin.endsWith("_initial_sync") && !telemetryHasTargetStatus(telemetry) && details.includes("awaiting outbound sync telemetry");
}

// Returns true when every non-successful target says "No matching item found" — meaning
// the content simply isn't in those libraries, not a fixable sync error.
function allNonSuccessTargetsNotFound(telemetry) {
  const lines = String(telemetry || "").split(/\r?\n/);
  const targetLines = lines.filter((l) => /^(plex|emby|jellyfin)\s+(?:progress\s+)?status:/i.test(l.trim()));
  if (!targetLines.length) return false;
  const nonSuccessLines = targetLines.filter((l) => !l.toLowerCase().includes("success"));
  if (!nonSuccessLines.length) return false;
  return nonSuccessLines.every((l) => l.toLowerCase().includes("no matching item found"));
}

export async function querySyncJobs({ limit = 100, offset = 0, status = "outstanding" } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const rows = await loadHistoryRows({
    limit: Math.min(Math.max(safeLimit * 5, safeLimit), MAX_HISTORY_LIMIT),
    offset: safeOffset,
  });

  const filtered = rows.filter((row) => {
    const dispatchStatus = dispatchStatusFromTelemetry(row.sync_dispatch_telemetry);
    if (status === "all") return true;
    if (status === "success") return dispatchStatus === "success";
    if (isLegacyInitialSyncPlaceholder(row)) return false;
    if (allNonSuccessTargetsNotFound(row.sync_dispatch_telemetry)) return false;
    if (dispatchStatus === "skipped") {
      const telemetry = row.sync_dispatch_telemetry || "";
      const hasTargetStatus = telemetryHasTargetStatus(telemetry);
      const isLoopOrImport = telemetry.includes("Echo loop caught") || telemetry.includes("Historical import");
      if (hasTargetStatus && !isLoopOrImport) return true;
      return false;
    }
    return dispatchStatus !== "success";
  });

  return filtered.slice(0, safeLimit);
}

export async function getWatchStats() {
  const version = getDataVersion();
  if (statsCache.version === version && statsCache.stats) return statsCache.stats;

  const rows = (await loadHistoryRows({ limit: MAX_HISTORY_LIMIT, offset: 0 })).filter(isPlembfinTrackedWatchRow);
  const movieKeys = new Set();
  let episodes = 0;
  const bySource = new Map();
  const byShow = new Map();
  const byMonth = new Map();
  const byYear = new Map();
  const statsMonthPeriods = new Map();
  const allPeriod = createStatsPeriod("all", "All time");

  for (const row of rows) {
    const source = normalizePlatformSource(row.source);
    bySource.set(source, (bySource.get(source) || 0) + 1);
    const month = String(row.watched_at || "").slice(0, 7) || "unknown";
    const year = month.slice(0, 4) || "unknown";
    byMonth.set(month, (byMonth.get(month) || 0) + 1);
    addRowToStatsPeriod(allPeriod, row);
    if (!byYear.has(year)) byYear.set(year, createStatsPeriod(year, year));
    addRowToStatsPeriod(byYear.get(year), row);
    if (row.media_type === "movie") {
      movieKeys.add(row.imdb_id || row.tmdb_id || row.tvdb_id || row.title);
    } else if (row.media_type === "episode") {
      episodes += 1;
      const show = showTitleFrom(row.title);
      byShow.set(show, (byShow.get(show) || 0) + 1);
    }
    const monthPeriod = statsMonthPeriods.get(month) || createStatsPeriod(month, month);
    addRowToStatsPeriod(monthPeriod, row);
    statsMonthPeriods.set(month, monthPeriod);
  }

  const sourceBreakdown = [...bySource.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count);
  const monthlyActivity = [...byMonth.entries()].map(([month, count]) => ({ month, count })).sort((a, b) => a.month.localeCompare(b.month));
  const topShows = [...byShow.entries()].map(([title, count]) => ({ title, count })).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)).slice(0, 5);
  const yearlyReports = [...byYear.values()].map(finalizeStatsPeriod).sort((a, b) => b.period.localeCompare(a.period));
  const monthlyReports = [...statsMonthPeriods.values()].map(finalizeStatsPeriod).sort((a, b) => b.period.localeCompare(a.period));

  const stats = {
    total: rows.length,
    totalWatches: rows.length,
    movies: movieKeys.size,
    uniqueMoviesLogged: movieKeys.size,
    episodes,
    totalTvEpisodesTracked: episodes,
    topSource: sourceBreakdown[0]?.source || "none",
    topSourceCount: sourceBreakdown[0]?.count || 0,
    dbSizeBytes: 0,
    firstWatch: rows.at(-1)?.watched_at || null,
    lastWatch: rows[0]?.watched_at || null,
    sourceBreakdown,
    topShows,
    monthlyActivity,
    reports: {
      all: finalizeStatsPeriod(allPeriod),
      years: yearlyReports,
      months: monthlyReports,
    },
  };
  statsCache = { version, stats };
  return stats;
}

export async function getWatchRecordByIdLight(id) {
  return rowToWatch(selectByIdStmt.get(String(id)));
}

const updatePosterStmt = db.prepare("UPDATE watch_history SET poster_url = ?, updated_at = ? WHERE id = ?");

export async function updateWatchPosterUrl(id, posterUrl) {
  const cleanUrl = cleanString(posterUrl);
  if (!id || !cleanUrl) return false;
  const row = selectByIdStmt.get(String(id));
  if (!row) return false;
  if ((row.poster_url || "") === cleanUrl) return false;
  updatePosterStmt.run(cleanUrl, Date.now(), String(id));
  await invalidateHistoryDerivedCaches();
  return true;
}

// Bulk-stamp poster URLs (caller invalidates derived caches once afterwards).
export async function setWatchPosterUrls(updates = []) {
  let changed = 0;
  transaction(() => {
    for (const { id, posterUrl } of updates) {
      const url = cleanString(posterUrl);
      if (!id || !url) continue;
      updatePosterStmt.run(url, Date.now(), String(id));
      changed += 1;
    }
  });
  return changed;
}

export async function listLibraryItemsForRefresh() {
  const movieMap = new Map();
  for (const row of (await getCachedMovies()).filter(isPlembfinTrackedWatchRow)) {
    const key = row.tmdb_id ? `tmdb:${row.tmdb_id}` : `title:${canonicalTitleKey(row.title)}`;
    let group = movieMap.get(key);
    if (!group) { group = { mediaType: "movie", tmdbId: row.tmdb_id || "", title: row.title, records: [] }; movieMap.set(key, group); }
    if (row.id) group.records.push({ id: row.id, poster: row.poster_url || "" });
    if (!group.tmdbId && row.tmdb_id) group.tmdbId = row.tmdb_id;
  }

  const showMap = new Map();
  for (const row of (await getCachedHistory()).filter((r) => r.media_type === "episode" && isPlembfinTrackedWatchRow(r))) {
    const title = showTitleFrom(row.title);
    const key = canonicalTitleKey(title) || title.toLowerCase();
    let group = showMap.get(key);
    if (!group) { group = { mediaType: "tv", tmdbId: cachedShowTmdbId(row.tmdb_id), title, records: [], _repAt: "" }; showMap.set(key, group); }
    if (row.id) group.records.push({ id: row.id, poster: row.poster_url || "" });
    if ((row.watched_at || "") >= group._repAt) {
      group._repAt = row.watched_at || "";
      group.tmdbId = cachedShowTmdbId(group.tmdbId, row.tmdb_id);
      group.title = title;
    }
  }

  return [
    ...movieMap.values(),
    ...[...showMap.values()].map(({ _repAt, ...rest }) => rest),
  ];
}

export async function getWatchRecordById(id) {
  const row = rowToWatch(selectByIdStmt.get(String(id)));
  if (!row) return null;
  if (row.media_key) {
    const allRows = await getCachedHistory();
    const matches = allRows.filter((r) => r.media_key === row.media_key && isPlembfinTrackedWatchRow(r));
    row.playHistory = matches.map((r) => r.watched_at).filter(Boolean);
    row.playHistory.sort((a, b) => a.localeCompare(b));
  } else {
    row.playHistory = [row.watched_at];
  }
  return row;
}

export async function getWatchRecordByMediaKey(mediaKey, minWatchedAt = null) {
  const rows = selectByMediaKeyStmt.all(mediaKey);
  if (!rows.length) return null;
  const sorted = rows.sort((a, b) => (b.watched_at || "").localeCompare(a.watched_at || ""));
  const recent = sorted[0];
  if (minWatchedAt && recent.watched_at < minWatchedAt) return null;
  return rowToWatch(recent);
}

export async function updateWatchRecord(id, fields = {}) {
  if (!id) return { ok: false, error: "id is required" };
  const existing = selectByIdStmt.get(String(id));
  if (!existing) return { ok: false, error: "Watch record not found" };

  // Queue old show title
  queueProgressUpdateForRecord(existing);

  const sets = [];
  const params = [];
  let normalizedWatchedAt = "";
  if (fields.watched_at != null) {
    normalizedWatchedAt = normalizeWatchedAt(fields.watched_at);
    if (!normalizedWatchedAt) return { ok: false, error: "Invalid watched_at value" };
    sets.push("watched_at = ?"); params.push(normalizedWatchedAt);
  }
  if (fields.poster_url != null) { sets.push("poster_url = ?"); params.push(String(fields.poster_url).trim()); }
  if (fields.logo_url != null) { sets.push("logo_url = ?"); params.push(String(fields.logo_url).trim()); }
  if (fields.tmdb_id != null) { sets.push("tmdb_id = ?"); params.push(String(fields.tmdb_id).trim()); }
  if (fields.title != null) {
    const title = String(fields.title).trim();
    if (title) { sets.push("title = ?", "title_lower = ?"); params.push(title, title.toLowerCase()); }
    // Queue new show title
    if (existing.media_type === "episode") {
      queueShowProgressUpdate(showTitleFrom(title));
    }
  }
  if (fields.youtube_url != null) { sets.push("youtube_url = ?"); params.push(String(fields.youtube_url).trim()); }
  if (!sets.length) return { ok: false, error: "No valid fields to update" };
  sets.push("updated_at = ?"); params.push(Date.now());
  params.push(String(id));
  db.prepare(`UPDATE watch_history SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  if (normalizedWatchedAt && existing.media_key) {
    const relatedRows = relatedTrackedWatchRowsForDateEdit(existing);
    transaction(() => {
      for (const row of relatedRows) {
        updateWatchRowWatchedAtStmt.run(normalizedWatchedAt, Date.now(), row.id);
      }
    });
    for (const mediaKey of new Set(relatedRows.map((row) => row.media_key).filter(Boolean))) {
      updatePlaystateWatchedAtStmt.run(normalizedWatchedAt, Date.now(), mediaKey);
    }
  }
  if (normalizedWatchedAt && existing.media_key) {
    updatePlaystateWatchedAtStmt.run(normalizedWatchedAt, Date.now(), existing.media_key);
  }
  await invalidateHistoryDerivedCaches();
  return { ok: true };
}

const updateShowTitleStmt = db.prepare("UPDATE watch_history SET title = ?, title_lower = ?, show_title = ?, show_title_lower = ?, updated_at = ? WHERE id = ?");

export async function mergeShows(sourceTitle, targetTitle) {
  if (!sourceTitle || !targetTitle) throw new Error("source_title and target_title are required");
  const sourceKey = canonicalTitleKey(sourceTitle);
  const targetKey = canonicalTitleKey(targetTitle);
  if (sourceKey === targetKey) throw new Error("source and target are the same show");

  // Queue updates for both shows
  queueShowProgressUpdate(sourceTitle);
  queueShowProgressUpdate(targetTitle);

  let docs = selectEpisodesByShowLowerStmt.all(sourceTitle.toLowerCase());
  if (!docs.length) {
    docs = selectAllEpisodesStmt.all().filter((row) => {
      const raw = row.show_title || row.title || "";
      return canonicalTitleKey(showTitleFrom(raw)) === sourceKey;
    });
    if (!docs.length) throw new Error("No episodes found for source show");
  }

  const escaped = sourceTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  transaction(() => {
    for (const row of docs) {
      const oldTitle = row.title || "";
      const newTitle = oldTitle.replace(new RegExp(`^${escaped}`, "i"), targetTitle);
      updateShowTitleStmt.run(newTitle, newTitle.toLowerCase(), targetTitle, targetTitle.toLowerCase(), Date.now(), row.id);
    }
  });
  await invalidateHistoryDerivedCaches();
  return { merged: docs.length };
}

export async function deleteWatchRecordById(id, { skipInvalidate = false } = {}) {
  if (!id) return false;
  const row = selectByIdStmt.get(String(id));
  if (row) {
    queueProgressUpdateForRecord(row);
  }
  deleteByIdStmt.run(String(id));
  if (!skipInvalidate) await invalidateHistoryDerivedCaches();
  return true;
}

export async function deleteWatchRecord(_unusedDb, media, { skipInvalidate = false } = {}) {
  const key = mediaKeyFor({
    title: media.title,
    type: media.type,
    imdb: media.ids?.imdb,
    tmdb: media.ids?.tmdb,
    tvdb: media.ids?.tvdb,
    season: media.season,
    episode: media.episode,
  });
  const rows = selectByMediaKeyStmt.all(key);
  if (!rows.length) return false;
  for (const row of rows) {
    queueProgressUpdateForRecord(row);
  }
  transaction(() => {
    for (const row of rows) deleteByIdStmt.run(row.id);
  });
  if (!skipInvalidate) await invalidateHistoryDerivedCaches();
  return true;
}

export function requireDb() {
  return db;
}

// --- Maintenance helpers (used by index.js admin endpoints) ----------------
export async function findExistingWatch(mediaKey, watchedAt) {
  return rowToWatch(findExistingStmt.get(mediaKey, watchedAt));
}

export async function findWatchedByMediaKey(mediaKey) {
  return rowToWatch(findWatchedByKeyStmt.get(mediaKey));
}

// Checks all possible key formats for the same media item (IMDB, TMDB, TVDB, title).
// Prevents false "not found" results when backup records were keyed by a different ID type
// than the one returned by the platform API (e.g. Plex stored TMDB, Emby returns IMDB).
export async function findWatchedByAnyMediaKey(media) {
  const ids = media.ids || {};
  const seen = new Set();
  const candidates = [
    mediaKeyFor(media),
    ids.imdb ? mediaKeyFor({ ...media, ids: { imdb: ids.imdb } }) : null,
    ids.tmdb ? mediaKeyFor({ ...media, ids: { tmdb: ids.tmdb } }) : null,
    ids.tvdb ? mediaKeyFor({ ...media, ids: { tvdb: ids.tvdb } }) : null,
  ];
  for (const key of candidates) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const row = findWatchedByKeyStmt.get(key);
    if (row) return rowToWatch(row);
  }
  return null;
}

const countMissingPosterStmt = db.prepare("SELECT COUNT(*) AS c FROM watch_history WHERE source = 'trakt_import' AND (poster_url IS NULL OR poster_url = '')");
const listMissingPosterStmt = db.prepare("SELECT * FROM watch_history WHERE source = 'trakt_import' AND (poster_url IS NULL OR poster_url = '') LIMIT ?");

export async function countMissingPosterTraktRows() {
  return countMissingPosterStmt.get().c || 0;
}

export async function listMissingPosterTraktRows(limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return listMissingPosterStmt.all(safeLimit).map(rowToWatch);
}

export async function stampWatchPoster(id, posterUrl) {
  if (!id) return;
  updatePosterStmt.run(String(posterUrl || ""), Date.now(), String(id));
}

const updateMediaTypeStmt = db.prepare("UPDATE watch_history SET media_type = ?, updated_at = ? WHERE id = ?");
export async function setWatchMediaType(id, mediaType) {
  if (!id) return;
  updateMediaTypeStmt.run(mediaType, Date.now(), String(id));
}

const allKeyGroupsStmt = db.prepare("SELECT id, media_key, watched_at FROM watch_history");
export function loadWatchKeyGroupsForDedup() {
  const groups = new Map();
  for (const row of allKeyGroupsStmt.all()) {
    const key = row.media_key || row.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: row.id, watchedAt: row.watched_at || "" });
  }
  return groups;
}

const deletePlaystateByKeyStmt = db.prepare("DELETE FROM playstate WHERE media_key = ?");

// Permanently delete a single library item and every trace of its history:
// all watch_history plays that collapse into the same card, plus the matching
// playstate and playback_progress rows. Matching is by shared external ID
// (imdb/tmdb/tvdb); only when the anchor has no IDs do we fall back to title.
export async function deleteMovieByWatchId(id, { skipInvalidate = false } = {}) {
  const anchor = selectByIdStmt.get(String(id || ""));
  if (!anchor) return { found: false, deleted: 0 };

  const imdb = cleanString(anchor.imdb_id);
  const tmdb = cleanString(anchor.tmdb_id);
  const tvdb = cleanString(anchor.tvdb_id);
  const titleKey = canonicalTitleKey(anchor.title);
  const hasId = Boolean(imdb || tmdb || tvdb);

  const matches = selectMoviesStmt.all().filter((row) => {
    if (hasId) {
      return (imdb && cleanString(row.imdb_id) === imdb)
        || (tmdb && cleanString(row.tmdb_id) === tmdb)
        || (tvdb && cleanString(row.tvdb_id) === tvdb);
    }
    return canonicalTitleKey(row.title) === titleKey;
  });
  if (!matches.some((row) => row.id === anchor.id)) matches.push(anchor);

  const mediaKeys = new Set();
  transaction(() => {
    for (const row of matches) {
      deleteByIdStmt.run(row.id);
      if (row.media_key) mediaKeys.add(row.media_key);
    }
    for (const key of mediaKeys) {
      deletePlaystateByKeyStmt.run(key);
      deleteProgressStmt.run(key);
    }
  });

  if (!skipInvalidate) await invalidateHistoryDerivedCaches();
  return { found: true, deleted: matches.length, title: anchor.title };
}

export function deleteWatchRecordsByIds(ids = []) {
  let deleted = 0;
  transaction(() => {
    for (const id of ids) {
      if (!id) continue;
      const row = selectByIdStmt.get(String(id));
      if (row) {
        queueProgressUpdateForRecord(row);
      }
      deleteByIdStmt.run(String(id));
      deleted += 1;
    }
  });
  return deleted;
}

const deletePosterByMediaKeyStmt = db.prepare("DELETE FROM poster_cache WHERE media_key = ?");
export async function deletePosterCacheByMediaKey(mediaKey) {
  if (!mediaKey) return;
  deletePosterByMediaKeyStmt.run(mediaKey);
}

export async function countWatchHistoryRows() {
  return db.prepare("SELECT COUNT(*) AS c FROM watch_history").get().c || 0;
}

// --- Movies / shows queries ------------------------------------------------
export async function queryMovies({ search = "", sort = "title_asc", limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.min(Number(limit) || 100, 5000);
  const safeOffset = Number(offset) || 0;
  const movies = await getCachedMovies();
  const filtered = movies.filter((row) => titleContainsSearch(row.title, search));
  const deduped = dedupeMovies(filtered);
  const sorted = sortRows(deduped, sort);
  return sorted.slice(safeOffset, safeOffset + safeLimit);
}

// Collapse a cluster of watch_history rows for one film into a single card:
// newest watched record as the base, every play date gathered into playHistory,
// and any missing id/poster backfilled from a sibling row.
function collapseMovieCluster(clusterRows = []) {
  const playHistory = [...new Set(clusterRows.map((r) => r.watched_at).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
  const newest = clusterRows
    .slice()
    .sort((a, b) => String(a.watched_at || "").localeCompare(String(b.watched_at || "")))
    .pop();
  const base = { ...newest, playHistory };
  for (const row of clusterRows) {
    if (!base.imdb_id && row.imdb_id) base.imdb_id = row.imdb_id;
    if (!base.tmdb_id && row.tmdb_id) base.tmdb_id = row.tmdb_id;
    if (!base.tvdb_id && row.tvdb_id) base.tvdb_id = row.tvdb_id;
    if (!base.poster_url && row.poster_url) base.poster_url = row.poster_url;
  }
  return base;
}

// Dedupe movies by clustering rows that refer to the same film. Rows are linked
// (union-find) when they share ANY external id (imdb/tmdb/tvdb) — this collapses
// records that carry different id subsets, e.g. one row with only tmdb and
// another with imdb+tmdb. Rows with no ids at all (e.g. plex_initial_sync title-
// only imports) fold into the unique id cluster sharing their canonical title;
// when two distinct films share a title (remakes), there is no unique target so
// the id-less row keeps its own cluster rather than guessing.
function dedupeMovies(rows = []) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => { parent.set(find(a), find(b)); };
  const ensure = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const idNodesFor = (row) => {
    const nodes = [];
    const imdb = cleanString(row.imdb_id); if (imdb) nodes.push(`imdb:${imdb}`);
    const tmdb = cleanString(row.tmdb_id); if (tmdb) nodes.push(`tmdb:${tmdb}`);
    const tvdb = cleanString(row.tvdb_id); if (tvdb) nodes.push(`tvdb:${tvdb}`);
    return nodes;
  };

  for (const row of rows) {
    const nodes = idNodesFor(row);
    nodes.forEach(ensure);
    for (let i = 1; i < nodes.length; i += 1) union(nodes[0], nodes[i]);
  }

  const clusters = new Map();
  const titleClusterKeys = new Map();
  const idless = [];
  for (const row of rows) {
    const nodes = idNodesFor(row);
    if (!nodes.length) { idless.push(row); continue; }
    const clusterKey = find(nodes[0]);
    if (!clusters.has(clusterKey)) clusters.set(clusterKey, []);
    clusters.get(clusterKey).push(row);
    const titleKey = canonicalTitleKey(row.title);
    if (titleKey) {
      if (!titleClusterKeys.has(titleKey)) titleClusterKeys.set(titleKey, new Set());
      titleClusterKeys.get(titleKey).add(clusterKey);
    }
  }

  for (const row of idless) {
    const titleKey = canonicalTitleKey(row.title);
    const matches = titleClusterKeys.get(titleKey);
    if (matches && matches.size === 1) {
      clusters.get([...matches][0]).push(row);
    } else {
      const clusterKey = `title:${titleKey}`;
      if (!clusters.has(clusterKey)) clusters.set(clusterKey, []);
      clusters.get(clusterKey).push(row);
    }
  }

  return [...clusters.values()].map(collapseMovieCluster);
}

function groupShowRows(rows = []) {
  const groups = new Map();
  rows.forEach((row) => {
    const title = showTitleFrom(row.show_title || row.title);
    const key = canonicalTitleKey(title) || normalizeKeyPart(title);
    const group = groups.get(key) || {
      title,
      episode_count: 0,
      season_count: 0,
      latest_watched_at: row.watched_at,
      earliest_watched_at: row.watched_at,
      episodes: [],
      seasons: new Set(),
      representative_episode: null,
      poster_url: null,
      logo_url: null,
      tmdb_id: null,
    };
    group.title = preferredShowTitle(group.title, title);
    group.episode_count += 1;
    if (row.season != null) group.seasons.add(row.season);
    if (row.watched_at > group.latest_watched_at) group.latest_watched_at = row.watched_at;
    if (row.watched_at < group.earliest_watched_at) group.earliest_watched_at = row.watched_at;
    group.episodes.push({ ...row, show_title: group.title });
    if (!group.representative_episode || row.watched_at > group.representative_episode.watched_at) {
      group.representative_episode = { ...row, show_title: group.title };
    }
    if (row.poster_url && !group.poster_url) {
      group.poster_url = row.poster_url;
    }
    if (row.logo_url && !group.logo_url) {
      group.logo_url = row.logo_url;
    }
    if (row.tmdb_id && !group.tmdb_id) {
      group.tmdb_id = row.tmdb_id;
    }
    groups.set(key, group);
  });
  return [...groups.values()].map((group) => ({
    ...group,
    season_count: group.seasons.size,
    seasons: undefined,
    poster_url: group.poster_url || group.representative_episode?.poster_url || null,
    logo_url: group.logo_url || group.representative_episode?.logo_url || null,
    tmdb_id: group.tmdb_id || group.representative_episode?.tmdb_id || null,
    representative_episode: group.representative_episode ? { ...group.representative_episode, show_title: group.title } : null,
    episodes: group.episodes
      .map((episode) => ({ ...episode, show_title: group.title }))
      .sort((a, b) => Number(a.season || 0) - Number(b.season || 0) || Number(a.episode || 0) - Number(b.episode || 0)),
  }));
}

function dedupeShowSummaries(shows = []) {
  const map = new Map();
  for (const show of shows) {
    const key = canonicalTitleKey(show.title) || normalizeKeyPart(show.title);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, show);
      continue;
    }
    const latest = show.latest_watched_at || "";
    const existingLatest = existing.latest_watched_at || "";
    if (latest > existingLatest) {
      map.set(key, {
        ...existing,
        ...show,
        episode_count: Math.max(Number(existing.episode_count || 0), Number(show.episode_count || 0)),
        season_count: Math.max(Number(existing.season_count || 0), Number(show.season_count || 0)),
      });
    }
  }
  return [...map.values()];
}

async function buildShowGroups(search = "") {
  const rows = dedupeHistory((await loadHistoryRowsByType({ mediaType: "episode", limit: MAX_HISTORY_LIMIT })).filter((row) => matchesSearch(row, search)));
  return groupShowRows(rows);
}

function compactEpisode(row = {}) {
  if (!row?.id) return null;
  return {
    id: row.id,
    title: row.title,
    media_type: row.media_type,
    watched_at: row.watched_at,
    source: row.source,
    imdb_id: row.imdb_id,
    tmdb_id: row.tmdb_id,
    tvdb_id: row.tvdb_id,
    season: row.season,
    episode: row.episode,
    poster_url: row.poster_url,
    sync_action: row.sync_action,
    sync_dispatch_telemetry: row.sync_dispatch_telemetry,
    media_key: row.media_key,
    show_title: row.show_title,
  };
}

export async function queryShows({ search = "", sort = "title_asc", limit = 6, offset = 0, hideWatched = false, hideEnded = false } = {}) {
  const safeLimit = Math.min(Number(limit) || 6, 5000);
  const safeOffset = Number(offset) || 0;

  const allShows = await getCachedShows();
  const needle = cleanString(search).toLowerCase();
  const filtered = dedupeShowSummaries(allShows).filter((show) => {
    if (needle && !titleContainsSearch(show.title, needle)) return false;
    if (hideWatched) {
      const isWatched = show.total_episodes > 0 && show.episode_count >= show.total_episodes;
      if (isWatched) return false;
    }
    if (hideEnded) {
      const isEnded = ["Ended", "Canceled"].includes(show.status);
      if (isEnded) return false;
    }
    return true;
  });
  const sorted = sortShowRows(filtered, sort);
  return sorted.slice(safeOffset, safeOffset + safeLimit);
}

export async function queryShowDetail({ id = "", title = "" } = {}) {
  const requestedTitle = cleanString(title);
  let resolvedTitle = requestedTitle;
  if (!resolvedTitle && id) {
    const shows = await getCachedShows();
    resolvedTitle = shows.find((show) => show.id === String(id))?.title || "";
  }

  if (resolvedTitle) {
    const rows = dedupeHistory(selectEpisodesByShowLowerStmt.all(resolvedTitle.toLowerCase()).map(rowToWatch).filter(isPlembfinTrackedWatchRow));
    const [show] = groupShowRows(rows);
    if (show) {
      const showKey = canonicalTitleKey(show.title) || normalizeKeyPart(show.title);
      const cachedProgress = getCachedShowProgress(showKey);
      show.tmdb_id = cachedShowTmdbId(cachedProgress?.tmdb_id, show.tmdb_id, show.representative_episode?.tmdb_id) || null;
      show.total_episodes = cachedProgress?.total_episodes || 0;
      return show;
    }
  }

  if (!resolvedTitle && id) resolvedTitle = String(id).replace(/-/g, " ");
  const key = canonicalTitleKey(resolvedTitle);
  const rows = dedupeHistory(await loadHistoryRowsByType({ mediaType: "episode", limit: MAX_HISTORY_LIMIT }))
    .filter((row) => canonicalTitleKey(showTitleFrom(row.show_title || row.title)) === key);
  const [show] = groupShowRows(rows);
  if (show) show.tmdb_id = cachedShowTmdbId(show.tmdb_id, show.representative_episode?.tmdb_id) || null;
  return show || null;
}

export async function listWatchRowsForReplay({ limit = 25, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return loadHistoryRows({ limit: safeLimit, offset: Math.max(Number(offset) || 0, 0) });
}

function sortRows(rows, sort) {
  return [...rows].sort((a, b) => {
    if (sort === "title_asc") return a.title.localeCompare(b.title) || b.watched_at.localeCompare(a.watched_at);
    if (sort === "title_desc") return b.title.localeCompare(a.title) || b.watched_at.localeCompare(a.watched_at);
    if (sort === "watched_asc") return a.watched_at.localeCompare(b.watched_at) || a.title.localeCompare(b.title);
    return b.watched_at.localeCompare(a.watched_at) || a.title.localeCompare(b.title);
  });
}

function sortShowRows(rows, sort) {
  return [...rows].sort((a, b) => {
    if (sort === "title_asc") return a.title.localeCompare(b.title) || b.latest_watched_at.localeCompare(a.latest_watched_at);
    if (sort === "title_desc") return b.title.localeCompare(a.title) || b.latest_watched_at.localeCompare(a.latest_watched_at);
    if (sort === "watched_asc") return a.earliest_watched_at.localeCompare(b.earliest_watched_at) || a.title.localeCompare(b.title);
    return b.latest_watched_at.localeCompare(a.latest_watched_at) || a.title.localeCompare(b.title);
  });
}

export function watchRowToMedia(row = {}, source = "plex") {
  return {
    title: row.title,
    type: row.media_type,
    source,
    ids: {
      imdb: row.imdb_id || undefined,
      tmdb: row.tmdb_id || undefined,
      tvdb: row.tvdb_id || undefined,
    },
    season: row.season == null ? undefined : Number(row.season),
    episode: row.episode == null ? undefined : Number(row.episode),
    posterUrl: row.poster_url || undefined,
    watched_at: row.watched_at || undefined,
    isValid: Boolean(row.title && ["movie", "episode"].includes(row.media_type)),
  };
}

export function progressRowToMedia(row = {}, source = "plex") {
  return {
    ...watchRowToMedia(row, source),
    positionMs: Number(row.position_ms || 0),
    durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
    progress: Number(row.progress || 0),
  };
}

// --- TMDB helpers (pure; unchanged from the original) ----------------------
const TMDB_DAY_MS = 24 * 60 * 60 * 1000;
export const TMDB_DETAILS_SCHEMA_VERSION = 1;

export function tmdbCacheTtlMs(details) {
  switch (details?.status) {
    case "Returning Series":
    case "In Production":
    case "Post Production":
    case "Planned":
    case "Pilot":
      return TMDB_DAY_MS;
    case "Ended":
    case "Canceled":
    case "Released":
      return 30 * TMDB_DAY_MS;
    default:
      return 7 * TMDB_DAY_MS;
  }
}

export function mergeTmdbDetails(existing, fresh) {
  if (!existing || typeof existing !== "object") return fresh;
  if (!fresh || typeof fresh !== "object") return existing;
  return { ...existing, ...fresh };
}

export async function computeTvNextAiringDate(details, tmdbId) {
  try {
    if (!details || !tmdbId) return null;
    const today = new Date().toISOString().slice(0, 10);

    const direct = details.next_episode_to_air?.air_date;
    if (direct && direct >= today) return direct;

    const candidates = new Set();
    const lastSeason = details.last_episode_to_air?.season_number;
    if (Number.isInteger(lastSeason)) {
      candidates.add(lastSeason);
      candidates.add(lastSeason + 1);
    }
    const maxSeason = Math.max(0, ...(details.seasons || []).map((s) => Number(s.season_number) || 0));
    if (maxSeason > 0) candidates.add(maxSeason);

    const seasonNums = [...candidates].filter((n) => n > 0).sort((a, b) => a - b);
    for (const n of seasonNums) {
      const season = await getTmdbSeason({ tmdbId, seasonNumber: n, showStatus: details.status }).catch(() => null);
      if (!season) continue;
      let earliest = null;
      for (const ep of season.episodes || []) {
        const d = ep.air_date;
        if (d && d >= today && (!earliest || d < earliest)) earliest = d;
      }
      if (earliest) return earliest;
    }
    return null;
  } catch (e) {
    console.error("Failed computing TV next airing date", e);
    return null;
  }
}

async function prefetchTmdbMetadataBackground(mediaType, tmdbId, title, recordId = "") {
  try {
    const lookupTitle = String(mediaType).toLowerCase() === "movie" ? title : showTitleFrom(title);
    const details = await getTmdbDetails({ mediaType, tmdbId, title: lookupTitle });
    if (recordId && details?.cached_poster_url) {
      await updateWatchPosterUrl(recordId, details.cached_poster_url).catch(() => null);
    }
    return details;
  } catch (e) {
    console.error("Failed to prefetch TMDB metadata in background", e);
    return null;
  }
}
