import crypto from "node:crypto";
import { db, getDataVersion, bumpDataVersion, parseJson, toJson, transaction } from "../db.js";
import { loadMediaConfig } from "./configStore.js";
import { fetchPosterFromTmdb } from "./tmdbClient.js";
import { getTmdbDetails, getTmdbSeason } from "./tmdbGateway.js";
import { cachedNextAiringFor, readNextAiringCache } from "./nextAiringCache.js";
import { buildWatchProvenance, normalizeWatchProvenance } from "./watchProvenance.js";
import { recordWatchAuditEvent, recordWatchAuditEvents } from "./watchAudit.js";
import {
  initShowProgressCache,
  getCachedShowProgress,
  clearCachedShowProgress,
  queueShowProgressUpdate,
  flushShowProgressUpdates,
} from "./showProgressCache.js";

// Initialize TV show progress cache on startup
initShowProgressCache().catch((err) => {
  console.error("[dataRepo] Failed to initialize show progress cache", err);
});


const MAX_HISTORY_LIMIT = 25000;
const HISTORY_VISIBILITY_CACHE_VERSION = 4;
const HISTORY_PREVIEW_SCAN_LIMIT = 600;

let historyCache = { version: null, rows: [] };
let showCache = { version: null, shows: [] };
// The includeScheduledLibraryHistory variant returns a different show set, so it
// needs its own slot. Without one it was recomputed from the full watch history
// on every call - the Upcoming calendar asks for it once per month requested.
let scheduledShowCache = { version: null, shows: [] };
let movieCache = { version: null, rows: null };
let statsCache = { version: null, stats: null };

export async function getHistoryCacheVersion() {
  return getDataVersion();
}

// Advance the browser-facing change contract without flushing expensive
// derived show metadata. Batch importers use this after each committed item so
// open pages can update immediately, then perform one full derived-cache flush
// when the batch is complete.
export function signalHistoryDataChanged() {
  return bumpDataVersion();
}

// --- Watch history row mapping --------------------------------------------
const WATCH_COLUMNS = [
  "id", "title", "title_lower", "media_type", "watched_at", "source",
  "imdb_id", "tmdb_id", "tvdb_id", "season", "episode", "poster_url", "logo_url",
  "backdrop_url", "youtube_url", "sync_action", "sync_dispatch_telemetry", "media_key",
  "watch_provenance", "show_title", "show_title_lower", "episode_title", "created_at", "updated_at",
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
const findWatchedBySeasonEpisodeStmt = db.prepare("SELECT * FROM watch_history WHERE media_type = 'episode' AND season = ? AND episode = ? AND sync_action = 'watched'");
const findWatchedByKeyStmt = db.prepare("SELECT * FROM watch_history WHERE media_key = ? AND sync_action = 'watched' LIMIT 1");
const findWatchedByCoordinatesStmt = db.prepare("SELECT * FROM watch_history WHERE media_type = ? AND (season IS ? OR season = ?) AND (episode IS ? OR episode = ?) AND title_lower = ? AND sync_action = 'watched' LIMIT 1");
const findWatchedByShowCoordinatesStmt = db.prepare("SELECT * FROM watch_history WHERE media_type = 'episode' AND season = ? AND episode = ? AND show_title_lower = ? AND sync_action = 'watched' LIMIT 1");
const getTmdbShowDetailsStmt = db.prepare("SELECT details FROM tmdb_metadata_cache WHERE id = ?");
const recoverShowTitleByTmdbStmt = db.prepare("SELECT show_title FROM watch_history WHERE media_type = 'episode' AND tmdb_id = ? AND show_title IS NOT NULL AND show_title_lower != 'unknown show' LIMIT 1");
const recoverShowTitleByTvdbStmt = db.prepare("SELECT show_title FROM watch_history WHERE media_type = 'episode' AND tvdb_id = ? AND show_title IS NOT NULL AND show_title_lower != 'unknown show' LIMIT 1");
const selectUnknownShowRowsStmt = db.prepare("SELECT id, title, tmdb_id, tvdb_id, sync_dispatch_telemetry FROM watch_history WHERE media_type = 'episode' AND show_title_lower = 'unknown show'");
// Fix Match asserts these episodes belong to a different series, so every
// provider id carried over from the old match is wrong - imdb included, not just
// tmdb. Leaving imdb behind would also keep mediaKeyFor deriving the key from it.
const rematchShowEpisodeStmt = db.prepare(`
  UPDATE watch_history
  SET tvdb_id = ?, tmdb_id = '', imdb_id = '', poster_url = NULL, logo_url = NULL,
      backdrop_url = NULL, sync_dispatch_telemetry = 'Identity updated via Fix Match. Pending outbound sync.',
      sync_retry_count = 0, sync_next_retry_at = 0, updated_at = ?
  WHERE id = ?
`);
const updateWatchMediaKeyStmt = db.prepare("UPDATE watch_history SET media_key = ?, updated_at = ? WHERE id = ?");
const selectPlaystateKeyStmt = db.prepare("SELECT media_key FROM playstate WHERE media_key = ?");
const movePlaystateKeyStmt = db.prepare(
  `UPDATE playstate SET media_key = ?, tvdb_id = ?, tmdb_id = '', imdb_id = '', title = ?, title_lower = ?, updated_at = ?
   WHERE media_key = ?`,
);
const deleteTmdbMetadataStmt = db.prepare("DELETE FROM tmdb_metadata_cache WHERE id = ?");
const deleteTvdbMetadataStmt = db.prepare("DELETE FROM tvdb_metadata_cache WHERE id = ?");

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

const getTvdbSeriesDetailsStmt = db.prepare("SELECT details FROM tvdb_metadata_cache WHERE id = ?");

function cachedTvdbSeriesDetails(tvdbId) {
  const id = cleanString(tvdbId);
  if (!id) return null;
  const row = getTvdbSeriesDetailsStmt.get(`series_${id}`);
  return row?.details ? parseJson(row.details) : null;
}

// A watch_history row's tvdb_id is whatever the ingest source tagged it with -
// for Plex/Emby/Jellyfin webhook rows that's the EPISODE's own TVDB id (TVDB
// assigns episodes their own numeric ids, separate from the series id), not
// the show's. Treating that as the show's series id and feeding it straight
// into a TVDB series lookup can land on a completely unrelated show whenever
// the numbers happen to collide. Only trust a candidate once it has already
// been resolved as a real series via getTvdbSeriesExtended (cached here) -
// from a search result, Fix Match, or a prior correct visit to this show -
// same tradeoff cachedShowTmdbId already makes for TMDB ids.
function cachedShowTvdbId(...candidates) {
  for (const candidate of candidates) {
    const id = cleanString(candidate);
    if (id && cachedTvdbSeriesDetails(id)) return id;
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

function firstPresent(...values) {
  return values.find((value) => value != null && value !== "");
}

export function normalizeMediaType(value) {
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
    if (url.hostname.toLowerCase() === "image.tmdb.org") {
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
  if (/\(\d{4}\)\s*$/.test(existing) && !/\(\d{4}\)\s*$/.test(next)) return next;
  const existingIsAllCaps = existing === existing.toUpperCase() && /[A-Z]/.test(existing);
  const nextIsAllCaps = next === next.toUpperCase() && /[A-Z]/.test(next);
  if (existingIsAllCaps && !nextIsAllCaps) return next;
  return existing;
}

function removeTrailingYear(title) {
  return cleanString(title).replace(/\s*\(\d{4}\)\s*$/, "").trim();
}

// A show identity that survives a media-server metadata rematch (which
// swaps every episode's provider ids and can toggle a trailing "(YYYY)" on
// or off the show title) or an inconsistent import. Deliberately looser than
// canonicalTitleKey alone - "Ludwig" and "Ludwig (2024)" must resolve to the
// same show, or the same real show ends up split into two in the app.
export function canonicalShowTitleKey(value) {
  return canonicalTitleKey(removeTrailingYear(value || ""));
}

export function showTitleFrom(title = "") {
  const text = cleanString(decodeBasicHtmlEntities(title)) || "Unknown Show";
  const seasonMatch = text.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  if (seasonMatch?.[1]) return removeTrailingYear(seasonMatch[1]) || "Unknown Show";
  const alternateMatch = text.match(/^(.*?)(?:\s+-\s+Season\s+\d+.*)$/i);
  if (alternateMatch?.[1]) return removeTrailingYear(alternateMatch[1]) || "Unknown Show";
  return removeTrailingYear(text.split(" - ")[0]) || "Unknown Show";
}

function episodeCoordinatesFromTitle(title = "") {
  const text = cleanString(decodeBasicHtmlEntities(title));
  const match = text.match(/\bS(\d{1,3})E(\d{1,3})\b/i);
  if (!match) return {};
  return {
    season: Number(match[1]),
    episode: Number(match[2]),
  };
}

function repairedEpisodeTitle(title = "") {
  return cleanString(decodeBasicHtmlEntities(title)).replace(
    /\bS0\?E(\d{1,3})\b/gi,
    (_, episode) => `S00E${String(Number(episode)).padStart(2, "0")}`,
  );
}

function episodeCoordinatesFromTitleWithLegacyRepair(title = "") {
  const exact = episodeCoordinatesFromTitle(title);
  if (exact.season != null || exact.episode != null) return exact;
  const match = cleanString(decodeBasicHtmlEntities(title)).match(/\bS0\?E(\d{1,3})\b/i);
  if (!match) return {};
  return {
    season: 0,
    episode: Number(match[1]),
  };
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
    // Live webhook media objects carry the resolved "Show - SxxExx" string on
    // `record.title` and the episode number on `record.episode` (not the
    // `show_title`/`episode_number` fields that Trakt/import records use), so
    // include those as fallbacks. Only rebuild when we actually have a real show
    // name â€” otherwise fall through to `record.title` so the stored title keeps
    // the correct episode coordinates and id-based recovery can still fix it.
    const showTitle = showTitleFrom(
      record.show_title ||
        show.title ||
        (typeof record.show === "string" ? record.show : "") ||
        record.title,
    );
    const season = firstPresent(record.season, episode.season);
    const episodeNumber =
      firstPresent(
        record.episode_number,
        episode.number,
        typeof record.episode === "object" ? "" : record.episode,
      );
    if (showTitle && showTitle !== "Unknown Show" && (season != null || episodeNumber != null)) {
      const seasonText = season == null ? "?" : season;
      const episodeText = episodeNumber == null ? "?" : episodeNumber;
      return `${showTitle} - S${String(seasonText).padStart(2, "0")}E${String(episodeText).padStart(2, "0")}`;
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
  const titleCoordinates = episodeCoordinatesFromTitleWithLegacyRepair(record.title);
  const title = normalizeImportedTitle(record, mediaType);
  const normalized = {
    title: mediaType === "episode" ? repairedEpisodeTitle(title) : title,
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
    season: numberOrNull(firstPresent(record.season, record.episode?.season, titleCoordinates.season)),
    episode: numberOrNull(firstPresent(
      record.episode_number,
      record.episode?.number,
      typeof record.episode === "object" ? "" : record.episode,
      titleCoordinates.episode,
    )),
    poster_url: emptyToNull(record.poster_url || record.posterUrl),
    sync_action: cleanString(record.sync_action || record.syncAction || record.action) || "watched",
    sync_dispatch_telemetry: emptyToNull(record.sync_dispatch_telemetry || record.syncDispatchTelemetry),
    watch_provenance: normalizeWatchProvenance(
      record.watch_provenance || record.watchProvenance || record.provenance,
    ) || buildWatchProvenance({
      source: cleanString(record.source || fallbackSource) || fallbackSource,
      event: record.event,
      phase: record.phase,
      itemId: record.itemId,
      sessionId: record.sessionId,
      user: record.user,
      device: record.device || record.deviceName,
      deviceId: record.deviceId || record.device_id,
      client: record.client,
      clientVersion: record.clientVersion || record.client_version,
      playedAt: record.playedAt,
    }),
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
      watch_provenance: media?.watchProvenance || media?.watch_provenance || media?.provenance,
      event: media?.event,
      phase: media?.phase,
      itemId: media?.itemId || media?.item_id,
      sessionId: media?.sessionId || media?.session_id,
      user: media?.user,
      device: media?.device || media?.deviceName,
      deviceId: media?.deviceId || media?.device_id,
      client: media?.client,
      clientVersion: media?.clientVersion || media?.client_version,
      playedAt: media?.playedAt,
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

function recoverShowTitle(tmdbId, tvdbId) {
  if (tmdbId) {
    const row = recoverShowTitleByTmdbStmt.get(String(tmdbId));
    if (row?.show_title) return row.show_title;
  }
  if (tvdbId) {
    const row = recoverShowTitleByTvdbStmt.get(String(tvdbId));
    if (row?.show_title) return row.show_title;
  }
  return null;
}

// Last-resort recovery for episodes stored as "Unknown Show": the dispatch
// telemetry's `Media:` line holds the title that was resolved at sync time
// (e.g. "Aussie Gold Hunters - S10E12"), which is often correct even when the
// stored row lost the show name. Returns the resolved show title and the full
// "Show - SxxExx" string, or null when telemetry is absent/still unknown.
function recoverTitleFromTelemetry(telemetry) {
  if (!telemetry) return null;
  const line = String(telemetry).split("\n").find((l) => /^Media:/i.test(l));
  if (!line) return null;
  const fullTitle = line.replace(/^Media:\s*/i, "").trim();
  if (!fullTitle || /^unknown/i.test(fullTitle)) return null;
  const showTitle = showTitleFrom(fullTitle);
  if (!showTitle || showTitle === "Unknown Show") return null;
  return { showTitle, fullTitle };
}

// Build the column params for a watch_history row (excludes id/created_at).
function watchRowParams(record) {
  let showTitle = record.media_type === "episode" ? showTitleFrom(record.show_title || record.title) : null;
  if (record.media_type === "episode" && (!showTitle || showTitle === "Unknown Show")) {
    const recovered = recoverShowTitle(record.tmdb_id, record.tvdb_id);
    if (recovered) showTitle = recovered;
  }
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
    backdrop_url: record.backdrop_url || null,
    youtube_url: null,
    sync_action: record.sync_action || "watched",
    sync_dispatch_telemetry: record.sync_dispatch_telemetry || null,
    watch_provenance: toJson(record.watch_provenance || buildWatchProvenance({ source: record.source })),
    media_key: mediaKeyFor(record),
    show_title: showTitle,
    show_title_lower: showTitle ? showTitle.toLowerCase() : null,
    episode_title: record.episode_title || null,
  };
}

export function normalizeWatchRecordForInsert(record, fallbackSource = record?.source || "import") {
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
  let tmdbId = row.tmdb_id || null;
  // An explicit TVDB match is authoritative. Do not resurrect an old TMDB id
  // from the progress cache while the new match is refreshing in background.
  if (row.media_type === "episode" && !tmdbId && !row.tvdb_id) {
    const showTitle = row.show_title || showTitleFrom(row.title);
    if (showTitle) {
      const showKey = canonicalTitleKey(showTitle) || normalizeKeyPart(showTitle);
      const cachedProgress = getCachedShowProgress(showKey);
      if (cachedProgress?.tmdb_id) {
        tmdbId = String(cachedProgress.tmdb_id);
      }
    }
  }
  const titleCoordinates = episodeCoordinatesFromTitleWithLegacyRepair(row.title);
  const title = row.media_type === "episode"
    ? repairedEpisodeTitle(row.title || "")
    : decodeBasicHtmlEntities(row.title || "");
  return {
    id: row.id,
    title,
    media_type: row.media_type || "",
    watched_at: row.watched_at || "",
    source: row.source || "",
    imdb_id: row.imdb_id || null,
    tmdb_id: tmdbId,
    tvdb_id: row.tvdb_id || null,
    season: row.season ?? titleCoordinates.season ?? null,
    episode: row.episode ?? titleCoordinates.episode ?? null,
    poster_url: row.poster_url || null,
    logo_url: row.logo_url || null,
    backdrop_url: row.backdrop_url || null,
    youtube_url: row.youtube_url || null,
    sync_action: row.sync_action || "watched",
    sync_dispatch_telemetry: row.sync_dispatch_telemetry || null,
    watch_provenance: normalizeWatchProvenance(row.watch_provenance),
    sync_retry_count: Number(row.sync_retry_count || 0),
    sync_next_retry_at: Number(row.sync_next_retry_at || 0),
    media_key: row.media_key || null,
    show_title: row.show_title ? decodeBasicHtmlEntities(row.show_title) : null,
    episode_title: row.episode_title ? decodeBasicHtmlEntities(row.episode_title) : null,
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  };
}

function isWatchedAction(row = {}) {
  return !["unwatched", "unplayed"].includes(String(row.sync_action || row.syncAction || "watched").toLowerCase());
}

function isScheduledLibraryHistoryRow(row = {}) {
  const telemetry = String(row.sync_dispatch_telemetry || row.syncDispatchTelemetry || "");
  return /Watch event fetched from (Plex|Emby|Jellyfin) library history/i.test(telemetry);
}

function isTrustedScheduledLibraryHistoryRow(row = {}) {
  if (!isScheduledLibraryHistoryRow(row)) return false;
  const provenance = normalizeWatchProvenance(row.watch_provenance || row.watchProvenance);
  return provenance?.event === "library_history"
    && Boolean(String(provenance.user || "").trim())
    && Boolean(String(provenance.source_timestamp || "").trim());
}

export function isPlembfinTrackedWatchRow(row = {}) {
  return isWatchedAction(row)
    && (!isScheduledLibraryHistoryRow(row) || isTrustedScheduledLibraryHistoryRow(row));
}

// Same trust check as isPlembfinTrackedWatchRow (an unscoped library scan row
// still isn't evidence of anything, watched or not) but without requiring the
// row's current state to be "watched" - used for grouping a show's episodes
// so a show doesn't disappear once every episode has been marked unwatched.
export function isPlembfinTrackedEpisodeRow(row = {}) {
  return !isScheduledLibraryHistoryRow(row) || isTrustedScheduledLibraryHistoryRow(row);
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
  return row._statsMovieKey || row.imdb_id || row.tmdb_id || row.tvdb_id || canonicalTitleKey(row.title) || row.title || "unknown-movie";
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

// Stats must use the same identity rule as the movie list: rows with any shared
// provider ID belong to one film, and title-only rows join that film only when
// the title has exactly one provider-ID cluster. This prevents imported plays
// and initial-sync plays for the same film from becoming separate leaderboard
// entries, while keeping same-title remakes separate when their IDs differ.
function buildStatsMovieKeys(rows = []) {
  const movieRows = rows.filter((row) => row.media_type === "movie");
  const parent = new Map();
  const find = (value) => {
    while (parent.get(value) !== value) {
      parent.set(value, parent.get(parent.get(value)));
      value = parent.get(value);
    }
    return value;
  };
  const ensure = (value) => { if (!parent.has(value)) parent.set(value, value); };
  const union = (a, b) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent.set(left, right);
  };
  const idNodesFor = (row) => [
    cleanString(row.imdb_id) ? `imdb:${cleanString(row.imdb_id)}` : "",
    cleanString(row.tmdb_id) ? `tmdb:${cleanString(row.tmdb_id)}` : "",
    cleanString(row.tvdb_id) ? `tvdb:${cleanString(row.tvdb_id)}` : "",
  ].filter(Boolean);

  for (const row of movieRows) {
    const nodes = idNodesFor(row);
    nodes.forEach(ensure);
    for (let index = 1; index < nodes.length; index += 1) union(nodes[0], nodes[index]);
  }

  const titleClusters = new Map();
  for (const row of movieRows) {
    const nodes = idNodesFor(row);
    if (!nodes.length) continue;
    const clusterKey = find(nodes[0]);
    const titleKey = canonicalTitleKey(row.title);
    if (!titleClusters.has(titleKey)) titleClusters.set(titleKey, new Set());
    titleClusters.get(titleKey).add(clusterKey);
  }

  const keys = new Map();
  for (const row of movieRows) {
    const nodes = idNodesFor(row);
    if (nodes.length) {
      keys.set(row, find(nodes[0]));
      continue;
    }
    const titleKey = canonicalTitleKey(row.title);
    const matches = titleClusters.get(titleKey);
    const clusterKey = matches?.size === 1 ? [...matches][0] : `title:${titleKey || "unknown-movie"}`;
    keys.set(row, clusterKey);
  }
  return keys;
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
// These derived caches intentionally trade memory for simple, fast reads in the
// single-process app. They load full history-derived result sets after each
// invalidation; before adding any more full-table caches, move hot paths that need
// pagination or large installations to indexed SQL with LIMIT/OFFSET.
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

export async function getCachedShows({ includeScheduledLibraryHistory = false } = {}) {
  const version = getDataVersion();
  const memo = includeScheduledLibraryHistory ? scheduledShowCache : showCache;
  if (memo.version === version && memo.shows.length > 0) return memo.shows;
  // The default (non-scheduled) branch is not watched-state filtered: a show
  // whose every episode has been marked unwatched still needs its own group
  // here (with 0 watched) so it stays visible in the TV Shows grid/dashboard
  // instead of disappearing entirely.
  const episodeRows = (await getCachedHistory()).filter((r) => r.media_type === "episode"
    && (includeScheduledLibraryHistory ? isWatchedAction(r) : isPlembfinTrackedEpisodeRow(r)));
  const groups = groupShowRows(dedupeHistory(episodeRows));
  // Each show needs its own SQLite lookup + JSON parse for cached TMDB details;
  // at library scale that's enough synchronous work in one pass to block the
  // event loop for a second or more, which is long enough (especially when
  // this rebuild fires repeatedly in a short window - it isn't debounced) to
  // fail the container's health check and get restarted. Yielding every 25
  // shows keeps any single burst small without slowing the overall rebuild.
  const YIELD_EVERY = 25;
  const shows = [];
  for (let i = 0; i < groups.length; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
    const group = groups[i];
    const showKey = canonicalTitleKey(group.title) || normalizeKeyPart(group.title);
    const rawShowKey = canonicalTitleKey(group.raw_title) || normalizeKeyPart(group.raw_title);
    const cachedProgress = getCachedShowProgress(showKey) || (rawShowKey !== showKey ? getCachedShowProgress(rawShowKey) : null);
    // group.tmdb_id, trusted unconditionally, comes from an actual recorded
    // watch_history row - Plembfin's own ground truth. cachedShowTmdbId's
    // gate (only return a candidate that already has cached metadata) exists
    // to protect the *weaker* fallback candidates below: the progress cache
    // can hold an id resolved from an earlier ambiguous title search that was
    // never written back onto any row (see the matching comment in
    // rematchShowWatchRecords below), and that gate is precisely what let a
    // bad cached resolution keep winning even after group.tmdb_id was put
    // first here - a real, correct id with no cache entry yet still lost to
    // a wrong id that happened to have one.
    const tmdbId = cleanString(group.tmdb_id) || cachedShowTmdbId(cachedProgress?.tmdb_id, group.representative_episode?.tmdb_id);
    // group.tvdb_id is already resolved through cachedShowTvdbId inside
    // groupShowRows - do not fall back to an ungated representative_episode
    // tvdb_id here, that's exactly the unverified episode-level id it exists
    // to filter out.
    const tvdbId = group.tvdb_id || "";
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
    shows.push({
      id: showKey,
      title: group.title,
      tmdb_id: tmdbId,
      tvdb_id: tvdbId,
      status,
      poster_url: posterUrl || null,
      episode_count: group.episode_count,
      season_count: group.season_count,
      total_watches: group.total_watches,
      rewatched_episode_count: group.rewatched_episode_count,
      latest_watched_at: group.latest_watched_at,
      earliest_watched_at: group.earliest_watched_at,
      representative_episode: compactEpisode(group.representative_episode),
      total_episodes: cachedProgress?.total_episodes || 0,
    });
  }
  if (includeScheduledLibraryHistory) scheduledShowCache = { version, shows };
  else showCache = { version, shows };
  return shows;
}


// --- Playstate -------------------------------------------------------------
const selectPlaystateStmt = db.prepare("SELECT * FROM playstate WHERE media_key = ?");
const selectPlaystateByTitleStmt = db.prepare("SELECT * FROM playstate WHERE media_type = ? AND title_lower = ?");
const selectPlaystateByImdbStmt = db.prepare("SELECT * FROM playstate WHERE media_type = ? AND imdb_id = ?");
const selectPlaystateByTmdbStmt = db.prepare("SELECT * FROM playstate WHERE media_type = ? AND tmdb_id = ?");
const selectPlaystateByTvdbStmt = db.prepare("SELECT * FROM playstate WHERE media_type = ? AND tvdb_id = ?");
const selectPlaystateBySeasonEpisodeStmt = db.prepare("SELECT * FROM playstate WHERE media_type = 'episode' AND season = ? AND episode = ?");
const upsertPlaystateStmt = db.prepare(
  `INSERT INTO playstate (media_key, title, title_lower, media_type, state, watched_at, last_source, sources, imdb_id, tmdb_id, tvdb_id, season, episode, poster_url, updated_at)
   VALUES (@media_key, @title, @title_lower, @media_type, @state, @watched_at, @last_source, @sources, @imdb_id, @tmdb_id, @tvdb_id, @season, @episode, @poster_url, @updated_at)
   ON CONFLICT(media_key) DO UPDATE SET title=excluded.title, title_lower=excluded.title_lower, media_type=excluded.media_type,
     state=excluded.state, watched_at=excluded.watched_at, last_source=excluded.last_source, sources=excluded.sources,
     imdb_id=excluded.imdb_id, tmdb_id=excluded.tmdb_id, tvdb_id=excluded.tvdb_id, season=excluded.season, episode=excluded.episode,
     poster_url=excluded.poster_url, updated_at=excluded.updated_at`,
);
const selectWatchedPlaystateStmt = db.prepare(
  "SELECT * FROM playstate WHERE state = 'watched' ORDER BY COALESCE(updated_at, 0) DESC, media_key DESC LIMIT ? OFFSET ?",
);
const selectWatchedPlaystateSnapshotStmt = db.prepare(
  "SELECT * FROM playstate WHERE state = 'watched' AND COALESCE(updated_at, 0) <= ? ORDER BY COALESCE(updated_at, 0) DESC, media_key DESC LIMIT ? OFFSET ?",
);
const countWatchedPlaystateStmt = db.prepare("SELECT COUNT(*) AS c FROM playstate WHERE state = 'watched'");
const countWatchedPlaystateSnapshotStmt = db.prepare(
  "SELECT COUNT(*) AS c FROM playstate WHERE state = 'watched' AND COALESCE(updated_at, 0) <= ?",
);

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

export async function upsertPlaystate(record, stateOverride = undefined, { skipInvalidate = false } = {}) {
  const normalized = normalizeWatchRecord(record, record.source || "webhook");
  const errors = validateWatchRecord(normalized);
  if (errors.length) throw new Error(errors.join(", "));

  const state = normalizePlaystateState(stateOverride || normalized.sync_action);
  const identityMatches = playstateRowsForIdentity(normalized);
  const mediaKey = identityMatches[0]?.media_key || mediaKeyFor(normalized);
  const existing = selectPlaystateStmt.get(mediaKey) || identityMatches[0];
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
    imdb_id: normalized.imdb_id || existing?.imdb_id || null,
    tmdb_id: normalized.tmdb_id || existing?.tmdb_id || null,
    tvdb_id: normalized.tvdb_id || existing?.tvdb_id || null,
    season: normalized.season,
    episode: normalized.episode,
    poster_url: normalized.poster_url || existing?.poster_url || null,
    updated_at: Date.now(),
  });

  recordWatchAuditEvent({
    eventType: "playstate_updated",
    timestamp: Date.now(),
    action: state,
    mediaKey,
    mediaType: normalized.media_type,
    title: normalized.title,
    source: normalized.source,
    ids: { imdb: normalized.imdb_id, tmdb: normalized.tmdb_id, tvdb: normalized.tvdb_id },
    season: normalized.season,
    episode: normalized.episode,
    details: `Plembfin playstate set to ${state}.`,
    payload: { state, watchedAt: normalized.watched_at, sources: [...sources].sort() },
  });

  if (!skipInvalidate) await invalidateHistoryDerivedCaches();
  return { mediaKey, state, record: normalized };
}

export async function upsertPlaystateForMedia(media, state = "watched", watchedAt = undefined, options = {}) {
  return upsertPlaystate(playstateRecordFromMedia(media, state, watchedAt), state, options);
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

function identityRows(record = {}, selectors = {}) {
  const type = normalizeMediaType(record.media_type || record.mediaType || record.type);
  const rows = [];
  const add = (row) => {
    if (row && sameEpisodeCoordinates(record, row) && !rows.some((item) => item.media_key === row.media_key)) rows.push(row);
  };
  if (record.imdb_id) selectors.imdb?.all(type, record.imdb_id).forEach(add);
  if (record.tmdb_id) selectors.tmdb?.all(type, record.tmdb_id).forEach(add);
  if (record.tvdb_id) selectors.tvdb?.all(type, record.tvdb_id).forEach(add);
  return rows.sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
}

function playstateRowsForIdentity(record = {}) {
  return identityRows(record, {
    imdb: selectPlaystateByImdbStmt,
    tmdb: selectPlaystateByTmdbStmt,
    tvdb: selectPlaystateByTvdbStmt,
  });
}

export async function getPlaystateForMedia(media) {
  const record = playstateRecordFromMedia(media, media?.syncAction || "watched");
  const exact = selectPlaystateStmt.get(mediaKeyFor(record));
  if (exact) return playstateFromRow(exact);
  const related = selectPlaystateByTitleStmt
    .all(record.media_type, record.title.toLowerCase())
    .filter((row) => sameEpisodeCoordinates(record, row));
  // Same rematch/legacy-normalization gap as findWatchedByAnyMediaKey: none
  // of the exact matches above catch a show whose title changed (a trailing
  // "(YYYY)" only one side carries) alongside a provider-id rematch. Compare
  // every playstate row at this season+episode by normalized show title
  // before concluding there's no existing state for this episode.
  const byShowTitle = record.media_type === "episode" && record.season != null && record.episode != null
    ? selectPlaystateBySeasonEpisodeStmt.all(record.season, record.episode)
      .filter((row) => canonicalShowTitleKey(showTitleFrom(row.title)) === canonicalShowTitleKey(showTitleFrom(record.title)))
    : [];
  const row = newestByUpdatedAt([...playstateRowsForIdentity(record), ...related, ...byShowTitle]);
  return row ? playstateFromRow(row) : null;
}

// The playstate table is the current canonical pointer.  The history fallback
// keeps older databases (including imports created before playstate rows were
// written) authoritative until their next dispatch repairs that pointer.
export async function getCanonicalWatchState(media) {
  const playstate = await getPlaystateForMedia(media);
  if (playstate?.state === "watched" || playstate?.state === "unwatched") return playstate.state;
  const watched = await findWatchedByAnyMediaKey(media).catch(() => null);
  return watched ? "watched" : null;
}

export async function listWatchedPlaystateRowsForReplay({ limit = 25, offset = 0, snapshotAt = undefined } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeSnapshotAt = Number(snapshotAt);
  const rows = Number.isFinite(safeSnapshotAt) && safeSnapshotAt > 0
    ? selectWatchedPlaystateSnapshotStmt.all(safeSnapshotAt, safeLimit, safeOffset)
    : selectWatchedPlaystateStmt.all(safeLimit, safeOffset);
  return rows.map(playstateFromRow);
}

export async function countWatchedPlaystateRows({ snapshotAt = undefined } = {}) {
  const safeSnapshotAt = Number(snapshotAt);
  const row = Number.isFinite(safeSnapshotAt) && safeSnapshotAt > 0
    ? countWatchedPlaystateSnapshotStmt.get(safeSnapshotAt)
    : countWatchedPlaystateStmt.get();
  return row.c || 0;
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
    console.error("[dataRepo] Failed to flush show progress updates", err);
  });
  bumpDataVersion();
}

function patchCachedRow(rows, freshRow) {
  if (!Array.isArray(rows) || !freshRow?.id) return null;
  const index = rows.findIndex((row) => row.id === freshRow.id);
  if (index < 0) return null;
  const patched = rows.slice();
  patched[index] = rowToWatch(freshRow);
  return patched;
}

// Row-scoped metadata writes still advance the global history version (the SPA
// uses it as a refresh contract), but can carry forward derived caches whose
// result is provably unchanged. Leaving a cache at its old version is the safe
// fallback: its next reader performs the existing full rebuild.
async function invalidateAfterRowMetaWrite(id, oldRow, changed) {
  const previousVersion = getDataVersion();
  await flushShowProgressUpdates().catch((err) => {
    console.error("[dataRepo] Failed to flush show progress updates", err);
  });
  const version = bumpDataVersion();
  const freshRow = id ? selectByIdStmt.get(String(id)) : null;
  if (!oldRow || !freshRow || version !== previousVersion + 1) return;

  if (historyCache.version === previousVersion) {
    const rows = patchCachedRow(historyCache.rows, freshRow);
    if (rows) historyCache = { version, rows };
  }

  const trackedFlipped = isPlembfinTrackedWatchRow(oldRow) !== isPlembfinTrackedWatchRow(freshRow);
  if (movieCache.version === previousVersion && Array.isArray(movieCache.rows) && !trackedFlipped) {
    if (freshRow.media_type === "movie") {
      const rows = patchCachedRow(movieCache.rows, freshRow);
      if (rows) movieCache = { version, rows };
    } else {
      movieCache = { version, rows: movieCache.rows };
    }
  }

  if (trackedFlipped || changed === "artwork") return;

  if (statsCache.version === previousVersion && statsCache.stats) {
    statsCache = { version, stats: statsCache.stats };
  }

  const showCacheUnaffected = changed === "retry" || freshRow.media_type === "movie";
  if (showCacheUnaffected && showCache.version === previousVersion) {
    showCache = { version, shows: showCache.shows };
  }
  // Same reasoning for the scheduled-history show set: a retry counter or a
  // movie row cannot change which shows it contains.
  if (showCacheUnaffected && scheduledShowCache.version === previousVersion) {
    scheduledShowCache = { version, shows: scheduledShowCache.shows };
  }
}

// --- Watch history writes --------------------------------------------------
// `id` lets a caller that is replacing a row keep that row's identity - see
// applyManualUnwatch, where a superseding unwatched record stands in for the
// watched one it replaced. It must name a row that no longer exists.
export async function insertWatchRecord(record, { skipInvalidate = false, id: presetId = "" } = {}) {
  const normalized = normalizeWatchRecord(record, record.source);
  const errors = validateWatchRecord(normalized);
  if (errors.length) throw new Error(errors.join(", "));

  // Queue show progress update
  queueProgressUpdateForRecord(normalized);

  const id = String(presetId || "").trim() || crypto.randomUUID();
  const params = watchRowParams(normalized);
  const storedAt = Date.now();
  insertWatchStmt.run({ id, ...params, created_at: storedAt, updated_at: storedAt });
  recordWatchAuditEvent({
    eventType: isWatchedAction(normalized) ? "history_added" : "history_state_recorded",
    timestamp: storedAt,
    action: normalized.sync_action,
    watchRecordId: id,
    mediaKey: params.media_key,
    mediaType: normalized.media_type,
    title: normalized.title,
    showTitle: params.show_title,
    source: normalized.source,
    sourceEvent: normalized.watch_provenance?.event,
    phase: normalized.watch_provenance?.phase,
    watchProvenance: normalized.watch_provenance,
    ids: { imdb: normalized.imdb_id, tmdb: normalized.tmdb_id, tvdb: normalized.tvdb_id },
    season: normalized.season,
    episode: normalized.episode,
    itemId: normalized.watch_provenance?.item_id,
    sessionId: normalized.watch_provenance?.session_id,
    user: normalized.watch_provenance?.user,
    device: normalized.watch_provenance?.device,
    deviceId: normalized.watch_provenance?.device_id,
    client: normalized.watch_provenance?.client,
    clientVersion: normalized.watch_provenance?.client_version,
    details: isWatchedAction(normalized)
      ? "Watch record added to Plembfin history; outbound sync is tracked separately."
      : `Watch history state recorded as ${normalized.sync_action}.`,
    payload: {
      record: normalized,
      provenance: normalized.watch_provenance,
      storedAt,
    },
  });
  if (!String(normalized.source || "").toLowerCase().includes("import")) {
    recordWatchAuditEvent({
      eventType: "sync_queued",
      timestamp: storedAt,
      action: normalized.sync_action,
      watchRecordId: id,
      mediaKey: params.media_key,
      mediaType: normalized.media_type,
      title: normalized.title,
      showTitle: params.show_title,
      source: normalized.source,
      sourceEvent: normalized.watch_provenance?.event,
      phase: normalized.watch_provenance?.phase,
      watchProvenance: normalized.watch_provenance,
      ids: { imdb: normalized.imdb_id, tmdb: normalized.tmdb_id, tvdb: normalized.tvdb_id },
      season: normalized.season,
      episode: normalized.episode,
      itemId: normalized.watch_provenance?.item_id,
      sessionId: normalized.watch_provenance?.session_id,
      user: normalized.watch_provenance?.user,
      device: normalized.watch_provenance?.device,
      deviceId: normalized.watch_provenance?.device_id,
      client: normalized.watch_provenance?.client,
      clientVersion: normalized.watch_provenance?.client_version,
      status: "queued",
      details: "Outbound synchronization queued after the Plembfin history write.",
    });
  }
  if (!skipInvalidate) await invalidateHistoryDerivedCaches();

  // Eagerly pull + store TMDB metadata/artwork at ingest (fire-and-forget;
  // returned so the webhook can await it before responding if it wants to).
  let assetPrefetch = Promise.resolve(null);
  if (isWatchedAction(normalized) && (normalized.tmdb_id || normalized.title)) {
    assetPrefetch = prefetchTmdbMetadataBackground(normalized.media_type, normalized.tmdb_id, normalized.title, id).catch(() => null);
  }
  return { id, record: normalized, assetPrefetch };
}

function defaultTelemetry(record) {
  const source = record?.source || "unknown";
  if (String(source).includes("import")) {
    return [
      `Origin: ${source}`,
      `Loop-check: Pending`,
      `Dispatch status: pending`,
      `Details: Historical import stored in Plembfin and queued for canonical outbound sync`,
    ].join("\n");
  }
  return [`Origin: ${source}`, `Loop-check: Pending`, `Dispatch status: pending`, `Details: Awaiting outbound sync telemetry`].join("\n");
}

export async function batchInsertWatchRecords(records) {
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
    const insertedAuditEvents = [];
    const insertedRecords = [];
    transaction(() => {
      for (const normalized of toInsert) {
        // Queue show progress update
        queueProgressUpdateForRecord(normalized);
        const id = crypto.randomUUID();
        const params = watchRowParams({
          ...normalized,
          sync_dispatch_telemetry: normalized.sync_dispatch_telemetry || defaultTelemetry(normalized),
        });
        const storedAt = Date.now();
        insertWatchStmt.run({ id, ...params, created_at: storedAt, updated_at: storedAt });
        insertedRecords.push({ id, ...normalized, watched_at: params.watched_at, media_key: params.media_key });
        insertedAuditEvents.push({
          eventType: isWatchedAction(normalized) ? "history_added" : "history_state_recorded",
          timestamp: storedAt,
          action: normalized.sync_action,
          watchRecordId: id,
          mediaKey: params.media_key,
          mediaType: normalized.media_type,
          title: normalized.title,
          showTitle: params.show_title,
          source: normalized.source,
          sourceEvent: normalized.watch_provenance?.event,
          phase: normalized.watch_provenance?.phase,
          watchProvenance: normalized.watch_provenance,
          ids: { imdb: normalized.imdb_id, tmdb: normalized.tmdb_id, tvdb: normalized.tvdb_id },
          season: normalized.season,
          episode: normalized.episode,
          itemId: normalized.watch_provenance?.item_id,
          sessionId: normalized.watch_provenance?.session_id,
          user: normalized.watch_provenance?.user,
          device: normalized.watch_provenance?.device,
          deviceId: normalized.watch_provenance?.device_id,
          client: normalized.watch_provenance?.client,
          clientVersion: normalized.watch_provenance?.client_version,
          details: "Watch record imported into Plembfin history and queued for canonical outbound sync.",
          payload: { record: normalized, import: true, storedAt },
        });
      }
    });
    recordWatchAuditEvents(insertedAuditEvents);
    for (const normalized of insertedRecords) {
      if (isWatchedAction(normalized)) {
        await upsertPlaystateForMedia({
          title: normalized.title,
          type: normalized.media_type,
          source: normalized.source,
          ids: {
            imdb: normalized.imdb_id || undefined,
            tmdb: normalized.tmdb_id || undefined,
            tvdb: normalized.tvdb_id || undefined,
          },
          season: normalized.season,
          episode: normalized.episode,
          posterUrl: normalized.poster_url || undefined,
          isValid: true,
        }, "watched", normalized.watched_at, { skipInvalidate: true });
      }
    }
    for (const normalized of toInsert) {
      if (isWatchedAction(normalized) && (normalized.tmdb_id || normalized.title)) {
        prefetchTmdbMetadataBackground(normalized.media_type, normalized.tmdb_id, normalized.title).catch(() => null);
      }
    }
    await invalidateHistoryDerivedCaches();
    return { inserted, updated: 0, skipped, rejected };
  }
  return { inserted, updated: 0, skipped, rejected };
}

const updateTelemetryStmt = db.prepare("UPDATE watch_history SET sync_dispatch_telemetry = ?, updated_at = ? WHERE id = ?");
const updatePlaystateWatchedAtStmt = db.prepare("UPDATE playstate SET watched_at = ?, updated_at = ? WHERE media_key = ?");
const updateWatchRowWatchedAtStmt = db.prepare("UPDATE watch_history SET watched_at = ?, updated_at = ? WHERE id = ?");

// All other tracked watch_history rows describing the same movie (by media_key)
// or the same episode (by show+season+episode), regardless of date. Used both
// to list every watch date for the edit-date dialog and, filtered further by
// relatedTrackedWatchRowsForDateEdit, to keep same-day duplicate rows in sync.
function siblingWatchRowsFor(existing = {}) {
  if (!existing.id) return [];
  if (existing.media_type !== "episode") {
    const allMovies = selectMoviesStmt.all().filter(isPlembfinTrackedWatchRow);
    const ids = [existing.imdb_id, existing.tmdb_id, existing.tvdb_id]
      .map(cleanString)
      .filter(Boolean);
    const titleKey = canonicalTitleKey(existing.title);
    const sameTitle = allMovies.filter((row) => canonicalTitleKey(row.title) === titleKey);
    const parent = new Map();
    const find = (key) => {
      while (parent.get(key) !== key) {
        parent.set(key, parent.get(parent.get(key)));
        key = parent.get(key);
      }
      return key;
    };
    const union = (left, right) => {
      if (left && right) parent.set(find(left), find(right));
    };
    for (const row of sameTitle) {
      const rowIds = [row.imdb_id, row.tmdb_id, row.tvdb_id]
        .map(cleanString)
        .filter(Boolean);
      rowIds.forEach((key) => { if (!parent.has(key)) parent.set(key, key); });
      for (let index = 1; index < rowIds.length; index += 1) union(rowIds[0], rowIds[index]);
    }
    const providerClusters = new Set([...parent.keys()].map(find));
    return allMovies.filter((row) => {
      if (row.id === existing.id) return false;
      const sharesMediaKey = existing.media_key && row.media_key === existing.media_key;
      const sharesProviderId = ids.some((id) => [row.imdb_id, row.tmdb_id, row.tvdb_id]
        .map(cleanString)
        .includes(id));
      const isUnambiguousTitleMatch = titleKey && canonicalTitleKey(row.title) === titleKey && providerClusters.size === 1;
      return sharesMediaKey || sharesProviderId || isUnambiguousTitleMatch;
    });
  }

  // showTitleFrom must wrap the whole show_title-or-title expression, not
  // just the title fallback - the same show's episode rows can carry
  // different exact show_title text over time (a trailing year present on
  // some inserts, absent on others; see the matching comment in
  // queryShowDetail), so normalizing only when show_title happens to be
  // missing silently split an episode's own watch dates into two groups
  // here whenever a duplicate play used a differently-formatted title.
  const showKey = canonicalTitleKey(showTitleFrom(existing.show_title || existing.title));
  const season = existing.season == null ? null : Number(existing.season);
  const episode = existing.episode == null ? null : Number(existing.episode);
  if (!showKey || season == null || episode == null) return [];

  // isPlembfinTrackedEpisodeRow, not isPlembfinTrackedWatchRow: a play later
  // marked unwatched (sync_action flips to "unwatched"/"unplayed") is still a
  // real past watch event and must stay listed here - the same trust check
  // queryShowDetail's dedupeHistory uses to build the "N actual watches"
  // count and playHistory list this dialog is meant to match. Requiring the
  // row's *current* action to be "watched" silently dropped that play from
  // the editor while the episode card's own history badge still counted it.
  return selectAllEpisodesStmt.all().filter((row) => {
    if (row.id === existing.id || !isPlembfinTrackedEpisodeRow(row)) return false;
    if (Number(row.season) !== season || Number(row.episode) !== episode) return false;
    return canonicalTitleKey(showTitleFrom(row.show_title || row.title)) === showKey;
  });
}

// Same-UTC-day siblings are treated as duplicate rows describing the *same*
// watch event (e.g. echoed across sources) and are kept in sync when the date
// is edited. Siblings on a different day are independent rewatches and are
// left alone, so editing one watch date can't silently overwrite another.
function relatedTrackedWatchRowsForDateEdit(existing = {}) {
  // Movie history rows are independent rewatches. Updating one movie row
  // must not stamp every same-day sibling with the same time, otherwise the
  // per-watch editor can never preserve distinct watch times.
  if (existing.media_type !== "episode") return [];
  const day = String(existing.watched_at || "").slice(0, 10);
  if (!day) return [];
  return siblingWatchRowsFor(existing).filter((row) => String(row.watched_at || "").slice(0, 10) === day);
}

// Every watch date recorded for the same movie/episode as `id`, oldest first -
// powers the "Edit Watch Date" dialog's per-date list.
export async function getWatchDatesForRecord(id) {
  const existing = selectByIdStmt.get(String(id));
  if (!existing) return null;
  const rows = filterSameEventDuplicateRows([existing, ...siblingWatchRowsFor(existing)])
    .map((row) => ({ id: row.id, watched_at: row.watched_at }))
    .sort((a, b) => String(a.watched_at || "").localeCompare(String(b.watched_at || "")));
  return {
    title: existing.title,
    media_type: existing.media_type,
    show_title: existing.show_title || null,
    season: existing.season,
    episode: existing.episode,
    rows,
  };
}

// Records an additional watch of the same movie/episode as `id` on a new date
// (e.g. from the "Add another watch date" control), cloning that row's
// identity fields rather than requiring the caller to resupply them.
export async function addWatchDate(id, watchedAtInput) {
  const existing = selectByIdStmt.get(String(id));
  if (!existing) return { ok: false, error: "Watch record not found" };
  const watchedAt = normalizeWatchedAt(watchedAtInput);
  if (!watchedAt) return { ok: false, error: "Invalid watched_at value" };

  const mediaKey = existing.media_key;
  const siblings = mediaKey ? selectByMediaKeyStmt.all(mediaKey) : [existing];
  if (siblings.some((row) => row.watched_at === watchedAt)) {
    return { ok: false, error: "A watch on that date already exists" };
  }

  const newId = crypto.randomUUID();
  const params = {};
  for (const column of WATCH_COLUMNS) {
    if (column === "id" || column === "watched_at" || column === "sync_dispatch_telemetry") continue;
    params[column] = existing[column];
  }
  params.watched_at = watchedAt;
  params.sync_dispatch_telemetry = "Origin: manual\nLoop-check: Skipped propagation\nDispatch status: skipped\nDetails: Additional watch date added manually.";
  const storedAt = Date.now();
  insertWatchStmt.run({ id: newId, ...params, created_at: storedAt, updated_at: storedAt });
  recordWatchAuditEvent({
    eventType: "history_added",
    timestamp: storedAt,
    action: "watched",
    watchRecordId: newId,
    mediaKey,
    mediaType: existing.media_type,
    title: existing.title,
    showTitle: existing.show_title,
    source: "manual",
    ids: { imdb: existing.imdb_id, tmdb: existing.tmdb_id, tvdb: existing.tvdb_id },
    season: existing.season,
    episode: existing.episode,
    details: "Additional watch date added manually to Plembfin history.",
    payload: { copiedFromRecordId: existing.id, watchedAt },
  });

  if (mediaKey) {
    const currentPlaystate = selectPlaystateStmt.get(mediaKey);
    if (!currentPlaystate || String(watchedAt) > String(currentPlaystate.watched_at || "")) {
      updatePlaystateWatchedAtStmt.run(watchedAt, Date.now(), mediaKey);
    }
  }

  await invalidateHistoryDerivedCaches();
  return { ok: true, id: newId };
}

// Removes a single watch date (one row) added via addWatchDate/the edit-date
// dialog, without touching any other watch of the same movie/episode. If the
// deleted row was the current playstate pointer, playstate is rolled back to
// whichever recorded watch is now the most recent one; if none remain, the
// item goes back to unwatched.
export async function deleteWatchDate(id) {
  const existing = selectByIdStmt.get(String(id));
  if (!existing) return { ok: false, error: "Watch record not found" };

  const candidateRows = [existing, ...siblingWatchRowsFor(existing)];
  const chainIds = sameEventChainIdsFor([existing.id], candidateRows);
  const rowsToDelete = chainIds
    .map((chainId) => (chainId === existing.id ? existing : candidateRows.find((row) => row.id === chainId)))
    .filter(Boolean);

  for (const row of rowsToDelete) {
    queueProgressUpdateForRecord(row);
    deleteByIdStmt.run(String(row.id));
    recordWatchAuditEvent({
      eventType: "history_deleted",
      timestamp: Date.now(),
      action: row.sync_action || "watched",
      watchRecordId: row.id,
      mediaKey: row.media_key,
      mediaType: row.media_type,
      title: row.title,
      showTitle: row.show_title,
      source: row.source,
      ids: { imdb: row.imdb_id, tmdb: row.tmdb_id, tvdb: row.tvdb_id },
      season: row.season,
      episode: row.episode,
      status: "deleted",
      details: row.id === existing.id
        ? "A single watch date was deleted from Plembfin history."
        : "An echoed duplicate row chained to the deleted watch date was removed with it.",
      payload: { record: row, operation: "delete_watch_date" },
    });
  }
  const mediaKey = existing.media_key;
  let remainingRow = null;
  if (mediaKey) {
    const remaining = selectByMediaKeyStmt.all(mediaKey).filter(isPlembfinTrackedWatchRow);
    if (remaining.length) {
      remainingRow = remaining.reduce((best, row) => (String(row.watched_at || "") > String(best.watched_at || "") ? row : best));
      updatePlaystateWatchedAtStmt.run(remainingRow.watched_at, Date.now(), mediaKey);
    } else {
      deletePlaystateByKeyStmt.run(mediaKey);
    }
  }

  await invalidateHistoryDerivedCaches();
  return { ok: true, remainingRow, deletedRow: existing };
}

// Bulk form of deleteWatchDate - used by the season/show "remove duplicate
// watches" cleanup, which can delete dozens of rows across many episodes in
// one action. Recomputes each affected media_key's playstate once at the end
// instead of once per deleted row.
export async function deleteWatchDates(ids = []) {
  const uniqueIds = [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))];
  const deleted = [];
  const notFound = [];
  const affectedMediaKeys = new Set();
  const representativeRowByMediaKey = new Map();
  const handled = new Set();

  for (const id of uniqueIds) {
    if (handled.has(id)) continue;
    const existing = selectByIdStmt.get(id);
    if (!existing) {
      notFound.push(id);
      continue;
    }

    const candidateRows = [existing, ...siblingWatchRowsFor(existing)];
    const chainIds = sameEventChainIdsFor([id], candidateRows).filter((chainId) => !handled.has(chainId));
    const rowsToDelete = chainIds
      .map((chainId) => (chainId === existing.id ? existing : candidateRows.find((row) => row.id === chainId)))
      .filter(Boolean);

    for (const row of rowsToDelete) {
      handled.add(row.id);
      queueProgressUpdateForRecord(row);
      deleteByIdStmt.run(row.id);
      recordWatchAuditEvent({
        eventType: "history_deleted",
        timestamp: Date.now(),
        action: row.sync_action || "watched",
        watchRecordId: row.id,
        mediaKey: row.media_key,
        mediaType: row.media_type,
        title: row.title,
        showTitle: row.show_title,
        source: row.source,
        ids: { imdb: row.imdb_id, tmdb: row.tmdb_id, tvdb: row.tvdb_id },
        season: row.season,
        episode: row.episode,
        status: "deleted",
        details: row.id === existing.id
          ? "A watch date was removed as part of a bulk duplicate-watch cleanup."
          : "An echoed duplicate row chained to a bulk-cleanup watch date was removed with it.",
        payload: { record: row, operation: "bulk_delete_watch_dates" },
      });
      deleted.push(row.id);
      if (row.media_key) {
        affectedMediaKeys.add(row.media_key);
        if (!representativeRowByMediaKey.has(row.media_key)) representativeRowByMediaKey.set(row.media_key, row);
      }
    }
  }

  const affectedMedia = [];
  for (const mediaKey of affectedMediaKeys) {
    const remaining = selectByMediaKeyStmt.all(mediaKey).filter(isPlembfinTrackedWatchRow);
    let remainingRow = null;
    if (remaining.length) {
      remainingRow = remaining.reduce((best, row) => (String(row.watched_at || "") > String(best.watched_at || "") ? row : best));
      updatePlaystateWatchedAtStmt.run(remainingRow.watched_at, Date.now(), mediaKey);
    } else {
      deletePlaystateByKeyStmt.run(mediaKey);
    }
    affectedMedia.push({ mediaKey, remainingRow, deletedRow: representativeRowByMediaKey.get(mediaKey) });
  }

  if (deleted.length) await invalidateHistoryDerivedCaches();
  return { ok: true, deleted, notFound, affectedMedia };
}

export async function updateWatchTelemetry(id, telemetry, { skipInvalidate = false } = {}) {
  if (!id) return;
  const oldRow = selectByIdStmt.get(String(id));
  updateTelemetryStmt.run(String(telemetry || ""), Date.now(), String(id));
  if (!skipInvalidate) await invalidateAfterRowMetaWrite(id, oldRow, "telemetry");
}

const updateSyncRetryStmt = db.prepare("UPDATE watch_history SET sync_retry_count = ?, sync_next_retry_at = ? WHERE id = ?");

// Tracks the automatic-dispatch backoff state for a watch record. Deliberately
// does not touch updated_at: backoff bookkeeping is not a content change.
export async function updateWatchSyncRetry(id, retryCount, nextRetryAt, { skipInvalidate = false } = {}) {
  if (!id) return;
  const oldRow = selectByIdStmt.get(String(id));
  updateSyncRetryStmt.run(Math.max(0, Number(retryCount) || 0), Math.max(0, Number(nextRetryAt) || 0), String(id));
  if (!skipInvalidate) await invalidateAfterRowMetaWrite(id, oldRow, "retry");
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
const selectProgressByImdbStmt = db.prepare("SELECT * FROM playback_progress WHERE media_type = ? AND imdb_id = ?");
const selectProgressByTmdbStmt = db.prepare("SELECT * FROM playback_progress WHERE media_type = ? AND tmdb_id = ?");
const selectProgressByTvdbStmt = db.prepare("SELECT * FROM playback_progress WHERE media_type = ? AND tvdb_id = ?");
const selectProgressReplayStmt = db.prepare("SELECT * FROM playback_progress ORDER BY COALESCE(updated_at, 0) DESC, media_key DESC LIMIT ? OFFSET ?");
const selectProgressSnapshotStmt = db.prepare(
  "SELECT * FROM playback_progress WHERE COALESCE(updated_at, 0) <= ? ORDER BY COALESCE(updated_at, 0) DESC, media_key DESC LIMIT ? OFFSET ?",
);
const countProgressStmt = db.prepare("SELECT COUNT(*) AS c FROM playback_progress");
const countProgressSnapshotStmt = db.prepare(
  "SELECT COUNT(*) AS c FROM playback_progress WHERE COALESCE(updated_at, 0) <= ?",
);

function playbackProgressFromRow(row) {
  const positionMs = Number(row.position_ms || 0);
  const durationMs = row.duration_ms == null ? null : Number(row.duration_ms);
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
    position_ms: positionMs,
    duration_ms: durationMs,
    progress: playbackProgressPercent(positionMs, durationMs, row.progress),
    updated_at: Number(row.updated_at || 0),
    sync_dispatch_telemetry: row.sync_dispatch_telemetry || null,
  };
}

function playbackProgressPercent(positionMs = 0, durationMs = 0, fallback = 0) {
  const position = Number(positionMs);
  const duration = Number(durationMs);
  if (Number.isFinite(position) && position >= 0 && Number.isFinite(duration) && duration > 0) {
    return Math.max(0, Math.min(100, (position / duration) * 100));
  }
  const value = Number(fallback);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

export function normalizePlaybackProgressRecord(record = {}, fallbackSource = "webhook") {
  const title = cleanString(record.title || record.name || "");
  const mediaType = normalizeMediaType(record.media_type || record.mediaType || record.type);
  const source = cleanString(record.source || fallbackSource) || fallbackSource;
  const positionMs = Math.max(0, Math.round(Number(record.position_ms ?? record.positionMs ?? record.offsetMs ?? 0)));
  const durationMsValue = Number(record.duration_ms ?? record.durationMs ?? 0);
  const durationMs = Number.isFinite(durationMsValue) && durationMsValue > 0 ? Math.round(durationMsValue) : null;
  const progressValue = playbackProgressPercent(positionMs, durationMs, record.progress);
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
    progress: progressValue,
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

export async function upsertPlaybackProgress(record) {
  const normalized = normalizePlaybackProgressRecord(record, record.source);
  if (!normalized.title) throw new Error("title is required");
  if (!["movie", "episode"].includes(normalized.media_type)) throw new Error("media_type must be movie or episode");
  if (!normalized.position_ms) throw new Error("position_ms is required");

  const identityMatch = progressRowsForIdentity(normalized)[0];
  const mediaKey = identityMatch?.media_key || normalized.media_key;
  upsertProgressStmt.run({
    media_key: mediaKey,
    title: normalized.title,
    media_type: normalized.media_type,
    source: normalized.source,
    imdb_id: normalized.imdb_id || identityMatch?.imdb_id || null,
    tmdb_id: normalized.tmdb_id || identityMatch?.tmdb_id || null,
    tvdb_id: normalized.tvdb_id || identityMatch?.tvdb_id || null,
    season: normalized.season,
    episode: normalized.episode,
    position_ms: normalized.position_ms,
    duration_ms: normalized.duration_ms,
    progress: normalized.progress,
    updated_at: normalized.updated_at,
    sync_dispatch_telemetry: normalized.sync_dispatch_telemetry,
  });
  recordWatchAuditEvent({
    eventType: "resume_progress_stored",
    timestamp: normalized.updated_at || Date.now(),
    action: "progress",
    mediaKey,
    mediaType: normalized.media_type,
    title: normalized.title,
    source: normalized.source,
    ids: { imdb: normalized.imdb_id, tmdb: normalized.tmdb_id, tvdb: normalized.tvdb_id },
    season: normalized.season,
    episode: normalized.episode,
    details: "Resume progress stored in Plembfin.",
    payload: {
      positionMs: normalized.position_ms,
      durationMs: normalized.duration_ms,
      progress: normalized.progress,
    },
  });
  if (normalized.tmdb_id || normalized.title) {
    prefetchTmdbMetadataBackground(normalized.media_type, normalized.tmdb_id, normalized.title).catch(() => null);
  }
  return { ...normalized, media_key: mediaKey };
}

function progressRowsForIdentity(record = {}) {
  return identityRows(record, {
    imdb: selectProgressByImdbStmt,
    tmdb: selectProgressByTmdbStmt,
    tvdb: selectProgressByTvdbStmt,
  });
}

export async function updatePlaybackProgressTelemetry(mediaOrRecord, telemetry) {
  const normalized = normalizePlaybackProgressRecord(mediaOrRecord, mediaOrRecord?.source);
  const mediaKey = progressRowsForIdentity(normalized)[0]?.media_key || normalized.media_key;
  updateProgressTelemetryStmt.run(mediaKey, String(telemetry || ""), Date.now());
}

export async function getPlaybackProgressForMedia(mediaOrRecord) {
  const normalized = normalizePlaybackProgressRecord(mediaOrRecord, mediaOrRecord?.source);
  const exact = selectProgressStmt.get(normalized.media_key);
  const related = selectProgressByTitleStmt
    .all(normalized.media_type, normalized.title.toLowerCase())
    .filter((row) => sameEpisodeCoordinates(normalized, row));
  const row = newestByUpdatedAt([exact, ...progressRowsForIdentity(normalized), ...related]);
  return row ? playbackProgressFromRow(row) : null;
}

export async function deletePlaybackProgress(mediaOrRecord) {
  const normalized = normalizePlaybackProgressRecord(mediaOrRecord, mediaOrRecord?.source);
  if (!normalized.media_key) return false;
  const related = normalized.title
    ? selectProgressByTitleStmt
        .all(normalized.media_type, normalized.title.toLowerCase())
        .filter((row) => sameEpisodeCoordinates(normalized, row))
    : [];
  const keys = new Set([
    normalized.media_key,
    ...progressRowsForIdentity(normalized).map((row) => row.media_key).filter(Boolean),
    ...related.map((row) => row.media_key).filter(Boolean),
  ]);
  for (const key of keys) {
    deleteProgressStmt.run(key);
    recordWatchAuditEvent({
      eventType: "resume_progress_cleared",
      timestamp: Date.now(),
      action: "progress",
      mediaKey: key,
      mediaType: normalized.media_type,
      title: normalized.title,
      source: normalized.source,
      ids: { imdb: normalized.imdb_id, tmdb: normalized.tmdb_id, tvdb: normalized.tvdb_id },
      season: normalized.season,
      episode: normalized.episode,
      details: "Resume progress cleared from Plembfin.",
    });
  }
  return keys.size > 0;
}

export async function listPlaybackProgressRowsForReplay({ limit = 25, offset = 0, snapshotAt = undefined } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeSnapshotAt = Number(snapshotAt);
  const rows = Number.isFinite(safeSnapshotAt) && safeSnapshotAt > 0
    ? selectProgressSnapshotStmt.all(safeSnapshotAt, safeLimit, safeOffset)
    : selectProgressReplayStmt.all(safeLimit, safeOffset);
  return rows.map(playbackProgressFromRow);
}

export async function countPlaybackProgressRows({ snapshotAt = undefined } = {}) {
  const safeSnapshotAt = Number(snapshotAt);
  const row = Number.isFinite(safeSnapshotAt) && safeSnapshotAt > 0
    ? countProgressSnapshotStmt.get(safeSnapshotAt)
    : countProgressStmt.get();
  return row.c || 0;
}

// Data-quality counters for the Sync Health panel. These conditions were
// previously only observable by reading the server log.
// Two plays of the same item recorded within this window are one viewing written
// down twice: nobody finishes an episode and starts it again inside ten minutes.
// Matching on an identical timestamp is not enough - a watch propagated between
// media servers lands milliseconds to minutes apart, never on the same instant,
// so an exact-match test reports almost none of the duplicates that exist.
export const SAME_EVENT_WINDOW_MS = 10 * 60 * 1000;

const selectWatchedStampsStmt = db.prepare(
  `SELECT id, title, title_lower, media_type, watched_at, sync_action,
          sync_dispatch_telemetry, imdb_id, tmdb_id, tvdb_id, season, episode, media_key, show_title
     FROM watch_history
    WHERE watched_at IS NOT NULL
      AND (sync_action IS NULL OR LOWER(sync_action) NOT IN ('unwatched', 'unplayed'))`,
);

export function backfillWatchRecordIdsAndKeys() {
  const allRows = db.prepare(
    "SELECT id, title, title_lower, media_type, watched_at, sync_action, imdb_id, tmdb_id, tvdb_id, season, episode, media_key FROM watch_history"
  ).all();

  const idMap = new Map();
  for (const r of allRows) {
    if (r.imdb_id || r.tmdb_id || r.tvdb_id) {
      const type = (r.media_type || "").toLowerCase() === "series" ? "show" : (r.media_type || "").toLowerCase() || "movie";
      const key = `${r.title_lower}|${type}|${r.season || ""}|${r.episode || ""}`;
      if (!idMap.has(key)) {
        idMap.set(key, { imdb_id: r.imdb_id, tmdb_id: r.tmdb_id, tvdb_id: r.tvdb_id });
      }
    }
  }

  const updateStmt = db.prepare(
    "UPDATE watch_history SET imdb_id = ?, tmdb_id = ?, tvdb_id = ?, media_key = ?, updated_at = ? WHERE id = ?"
  );

  let updatedCount = 0;
  const now = Date.now();

  db.transaction(() => {
    for (const r of allRows) {
      if (!r.imdb_id && !r.tmdb_id && !r.tvdb_id) {
        const type = (r.media_type || "").toLowerCase() === "series" ? "show" : (r.media_type || "").toLowerCase() || "movie";
        const lookupKey = `${r.title_lower}|${type}|${r.season || ""}|${r.episode || ""}`;
        const match = idMap.get(lookupKey);
        if (match) {
          const updatedRow = { ...r, imdb_id: match.imdb_id, tmdb_id: match.tmdb_id, tvdb_id: match.tvdb_id };
          const canonicalKey = mediaKeyFor(updatedRow);
          updateStmt.run(match.imdb_id || null, match.tmdb_id || null, match.tvdb_id || null, canonicalKey, now, r.id);
          updatedCount++;
        }
      }
    }
  })();

  return updatedCount;
}

// Ids of rows that restate a viewing already recorded by an earlier row. Plays
// chain into one viewing while each is within the window of the one before it,
// and the earliest row of each chain is the one kept.
export function sameEventDuplicateIds(windowMs = SAME_EVENT_WINDOW_MS) {
  return sameEventDuplicateIdsForRows(selectWatchedStampsStmt.all().filter(isPlembfinTrackedWatchRow), windowMs);
}

function sameEventKey(row = {}) {
  const type = normalizeMediaType(row.media_type);
  // Episodes are the important cross-key case: Plex, Emby, Jellyfin, and
  // imports can use different provider IDs for the same show episode. The
  // show/season/episode identity is stable, while provider IDs are not.
  // Movies intentionally remain provider-ID-first so two films with the
  // same title are never collapsed merely because their titles match.
  if (type === "episode") {
    const show = canonicalTitleKey(row.show_title || showTitleFrom(row.title));
    const season = row.season ?? "unknown";
    const episode = row.episode ?? "unknown";
    return show && season !== "unknown" && episode !== "unknown"
      ? `episode|show:${show}|s:${season}|e:${episode}`
      : mediaKeyFor(row);
  }
  if (type === "movie") {
    return row.imdb_id
      ? `movie|imdb:${normalizeKeyPart(row.imdb_id)}`
      : row.tmdb_id
        ? `movie|tmdb:${normalizeKeyPart(row.tmdb_id)}`
        : row.tvdb_id
          ? `movie|tvdb:${normalizeKeyPart(row.tvdb_id)}`
          : `movie|title:${canonicalTitleKey(row.title)}`;
  }
  return mediaKeyFor(row);
}

function sameEventDuplicateIdsForRows(rows = [], windowMs = SAME_EVENT_WINDOW_MS) {
  const allWatched = rows.filter((row) => row?.watched_at && isWatchedAction(row));
  const byKey = new Map();
  for (const row of allWatched) {
    const key = sameEventKey(row);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  const duplicates = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (Date.parse(a.watched_at) || 0) - (Date.parse(b.watched_at) || 0));
    let previous = Date.parse(group[0].watched_at) || 0;
    for (let index = 1; index < group.length; index++) {
      const current = Date.parse(group[index].watched_at) || 0;
      if (current - previous <= windowMs) duplicates.push(group[index].id);
      previous = current;
    }
  }
  return duplicates;
}

// The Edit Watch Date dialog shows one row per real viewing event and hides
// any echoed duplicate chained to it within SAME_EVENT_WINDOW_MS (see
// filterSameEventDuplicateRows above). Deleting only the visible row leaves
// its hidden echo behind, and that echo resurfaces as a "new" watch date the
// next time the list is rebuilt. Expand each requested id to every id in its
// same-event chain so the whole event - visible row and hidden echoes alike -
// is removed together.
function sameEventChainIdsFor(targetIds, rows = [], windowMs = SAME_EVENT_WINDOW_MS) {
  const targets = new Set(targetIds);
  const allWatched = rows.filter((row) => row?.id && row.watched_at && isWatchedAction(row));
  const byKey = new Map();
  for (const row of allWatched) {
    const key = sameEventKey(row);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  const result = new Set(targetIds);
  for (const group of byKey.values()) {
    group.sort((a, b) => (Date.parse(a.watched_at) || 0) - (Date.parse(b.watched_at) || 0));
    let chain = [];
    let previous = null;
    const flushChain = () => {
      if (chain.length > 1 && chain.some((rowId) => targets.has(rowId))) {
        chain.forEach((rowId) => result.add(rowId));
      }
      chain = [];
    };
    for (const row of group) {
      const time = Date.parse(row.watched_at) || 0;
      if (chain.length && time - previous > windowMs) flushChain();
      chain.push(row.id);
      previous = time;
    }
    flushChain();
  }
  return [...result];
}

// Return only rows representing real viewing events. A webhook echo or a
// server-to-server propagation can produce several rows within the same
// viewing window; those rows must not become phantom rewatches in cards,
// details, or playHistory.
function filterSameEventDuplicateRows(rows = []) {
  const duplicateIds = new Set(sameEventDuplicateIdsForRows(rows));
  return rows.filter((row) => !row?.id || !duplicateIds.has(row.id));
}
const countNullSeasonEpisodesStmt = db.prepare(
  "SELECT COUNT(*) AS c FROM watch_history WHERE media_type = 'episode' AND season IS NULL"
);
const countOpaqueShowTitlesStmt = db.prepare(
  "SELECT COUNT(*) AS c FROM watch_history WHERE show_title LIKE '%://%'"
);

export function countRewatchedItems() {
  const rows = selectWatchedStampsStmt.all().filter(isPlembfinTrackedWatchRow);
  return dedupeHistory(rows).filter((row) => Array.isArray(row.playHistory) && row.playHistory.length > 1).length;
}

export function watchHistoryQualityCounts() {
  return {
    sameEventDuplicateRows: sameEventDuplicateIds().length,
    rewatchedItems: countRewatchedItems(),
    nullSeasonEpisodeRows: countNullSeasonEpisodesStmt.get().c || 0,
    opaqueShowTitleRows: countOpaqueShowTitlesStmt.get().c || 0,
  };
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

export async function loadLiveTrackingCache({ includeCompleted = false } = {}) {
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

export async function upsertLiveTrackingCache(rows = []) {
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

export async function markLiveTrackingComplete(sessionId, completedAt = Date.now()) {
  if (!sessionId) return;
  markLiveCompleteStmt.run(String(sessionId), Number(completedAt), Number(completedAt));
}

export async function deleteLiveTrackingCacheRows(sessionIds = []) {
  const ids = sessionIds.map((sessionId) => cleanString(sessionId)).filter(Boolean);
  if (!ids.length) return;
  transaction(() => {
    for (const id of ids) deleteLiveStmt.run(id);
  });
}

export async function purgeCompletedLiveTrackingCache(olderThan = Date.now() - 24 * 60 * 60 * 1000) {
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

function normalizeForSearch(value) {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function titleContainsSearch(title, search) {
  const needle = normalizeForSearch(search);
  if (!needle) return true;
  return normalizeForSearch(title).includes(needle);
}

function playHistoryEntry(row = {}) {
  return { id: row.id, watched_at: row.watched_at, source: row.source };
}

export function dedupeHistory(rows) {
  const map = new Map();
  for (const row of filterSameEventDuplicateRows(rows)) {
    const key = historyDedupeKey(row);
    if (map.has(key)) {
      const existing = map.get(key);
      if (!existing.playHistory) existing.playHistory = [playHistoryEntry(existing)];
      existing.playHistory.push(playHistoryEntry(row));
      if (!existing.poster_url && row.poster_url) existing.poster_url = row.poster_url;

      const existingWatched = isWatchedAction(existing);
      const rowWatched = isWatchedAction(row);

      // If one row is watched and the other is an unwatched bookkeeping row, the
      // more recently created/updated transition represents the user's latest intent
      // (a historical watch date like 'Day of release' shouldn't lose to an older unwatch).
      let useRow = false;
      if (existingWatched !== rowWatched) {
        const existingTime = Math.max(Number(existing.updated_at || 0), Number(existing.created_at || 0));
        const rowTime = Math.max(Number(row.updated_at || 0), Number(row.created_at || 0));
        useRow = rowTime >= existingTime ? rowWatched : !existingWatched;
      } else {
        useRow = String(row.watched_at || "") > String(existing.watched_at || "");
      }

      if (useRow) {
        const playHistory = existing.playHistory;
        map.set(key, { ...row, playHistory });
      }
    } else {
      map.set(key, { ...row, playHistory: [playHistoryEntry(row)] });
    }
  }
  const result = [...map.values()];
  for (const row of result) {
    if (row.playHistory) row.playHistory.sort((a, b) => String(a.watched_at).localeCompare(String(b.watched_at)));
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

export async function listRecentTrackedWatchRows({ limit = 100, scanLimit = 400, includeScheduled = false } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeScanLimit = Math.min(Math.max(Number(scanLimit) || safeLimit * 4, safeLimit), 2000);
  const rows = selectRecentStmt
    .all(safeScanLimit)
    .map(rowToWatch)
    .filter((row) => isWatchedAction(row) && (includeScheduled || isPlembfinTrackedWatchRow(row)));
  return dedupeHistory(rows).slice(0, safeLimit);
}

export async function queryWatchHistory({ search = "", mediaType = "", limit = 50, offset = 0, dedupe = true } = {}) {
  const safeLimit = Math.min(Number(limit) || 50, MAX_HISTORY_LIMIT);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const normalizedMediaType = ["movie", "episode"].includes(String(mediaType || "").toLowerCase()) ? String(mediaType).toLowerCase() : "";

  if (!dedupe) {
    const titleKeySql = (column) => `
      CASE
        WHEN COALESCE(${column}, '') GLOB '* ([0-9][0-9][0-9][0-9])'
          THEN LOWER(TRIM(SUBSTR(COALESCE(${column}, ''), 1, LENGTH(COALESCE(${column}, '')) - 7)))
        ELSE LOWER(TRIM(COALESCE(${column}, '')))
      END
    `;
    const showTitleKey = titleKeySql("COALESCE(show_title_lower, show_title)");
    const titleKey = titleKeySql("COALESCE(title_lower, title)");
    const where = [
      "(sync_action IS NULL OR LOWER(sync_action) NOT IN ('unwatched', 'unplayed'))",
      `(
        sync_dispatch_telemetry IS NULL
        OR (
          sync_dispatch_telemetry NOT LIKE '%Watch event fetched from Plex library history%'
          AND sync_dispatch_telemetry NOT LIKE '%Watch event fetched from Emby library history%'
          AND sync_dispatch_telemetry NOT LIKE '%Watch event fetched from Jellyfin library history%'
        )
        OR CASE
          WHEN json_valid(COALESCE(watch_provenance, '')) THEN
            NULLIF(json_extract(watch_provenance, '$.event'), '') = 'library_history'
            AND NULLIF(json_extract(watch_provenance, '$.user'), '') IS NOT NULL
            AND NULLIF(json_extract(watch_provenance, '$.source_timestamp'), '') IS NOT NULL
          ELSE 0
        END
      )`,
    ];
    const params = {};

    if (normalizedMediaType) {
      where.push("media_type = @mediaType");
      params.mediaType = normalizedMediaType;
    }

    const searchText = cleanString(search).toLowerCase();
    if (searchText) {
      where.push("(LOWER(COALESCE(title, '') || ' ' || COALESCE(source, '') || ' ' || COALESCE(imdb_id, '') || ' ' || COALESCE(tmdb_id, '') || ' ' || COALESCE(tvdb_id, '') || ' ' || COALESCE(sync_dispatch_telemetry, '')) LIKE @search)");
      params.search = `%${searchText}%`;
    }

    return db.prepare(`
      WITH ranked_history AS (
        SELECT
          watch_history.*,
          ROW_NUMBER() OVER (
            PARTITION BY
              SUBSTR(COALESCE(watched_at, ''), 1, 10),
              CASE
                WHEN media_type = 'episode' THEN
                  'episode|show:' || COALESCE(NULLIF(${showTitleKey}, ''), NULLIF(${titleKey}, ''), 'unknown')
                    || '|s:' || COALESCE(CAST(season AS TEXT), 'unknown')
                    || '|e:' || COALESCE(CAST(episode AS TEXT), 'unknown')
                WHEN media_type = 'movie' THEN
                  'movie|' || COALESCE(
                    NULLIF('imdb:' || COALESCE(imdb_id, ''), 'imdb:'),
                    NULLIF('tmdb:' || COALESCE(tmdb_id, ''), 'tmdb:'),
                    NULLIF('tvdb:' || COALESCE(tvdb_id, ''), 'tvdb:'),
                    NULLIF('title:' || ${titleKey}, 'title:'),
                    'unknown'
                  )
                ELSE
                  COALESCE(media_type, 'unknown') || '|' || COALESCE(NULLIF(${titleKey}, ''), 'unknown')
              END
            ORDER BY watched_at DESC, updated_at DESC
          ) AS daily_rank
        FROM watch_history
        WHERE ${where.join(" AND ")}
      )
      SELECT * FROM ranked_history
      WHERE daily_rank = 1
      ORDER BY watched_at DESC
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit: safeLimit, offset: safeOffset }).map(rowToWatch);
  }

  const rows = await loadHistoryRows({ limit: MAX_HISTORY_LIMIT, offset: 0 });
  const filtered = rows.filter((row) => {
    if (!isPlembfinTrackedWatchRow(row)) return false;
    if (normalizedMediaType && row.media_type !== normalizedMediaType) return false;
    return matchesSearch(row, cleanString(search));
  });
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
    watch_provenance: row.watch_provenance,
    watch_count: Array.isArray(row.playHistory) && row.playHistory.length ? row.playHistory.length : 1,
    media_key: row.media_key,
    show_title: row.show_title,
    episode_title: row.episode_title,
    tmdb_id: row.tmdb_id,
    tvdb_id: row.tvdb_id,
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

// Returns true when every non-successful target says "No matching item found" â€” meaning
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

  // Same-event echoes (e.g. a media server firing its "played" webhook several
  // times for one viewing) must not inflate play counts here - every other
  // consumer of watch_history already collapses these via
  // filterSameEventDuplicateRows, so Stats needs to match or it overcounts
  // titles the dedup tool correctly sees as having nothing left to remove.
  const rows = filterSameEventDuplicateRows(
    (await loadHistoryRows({ limit: MAX_HISTORY_LIMIT, offset: 0 })).filter(isPlembfinTrackedWatchRow),
  );
  const statsMovieKeys = buildStatsMovieKeys(rows);
  const movieKeys = new Set();
  let episodes = 0;
  const bySource = new Map();
  const byShow = new Map();
  const byMonth = new Map();
  const byYear = new Map();
  const statsMonthPeriods = new Map();
  const allPeriod = createStatsPeriod("all", "All time");

  for (const sourceRow of rows) {
    const row = sourceRow.media_type === "movie"
      ? { ...sourceRow, _statsMovieKey: statsMovieKeys.get(sourceRow) }
      : sourceRow;
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
  const row = selectByIdStmt.get(String(id)) || selectByMediaKeyStmt.all(String(id))[0];
  return rowToWatch(row);
}

const updatePosterStmt = db.prepare("UPDATE watch_history SET poster_url = ?, updated_at = ? WHERE id = ?");
const updateBackdropStmt = db.prepare("UPDATE watch_history SET backdrop_url = ?, updated_at = ? WHERE id = ?");
const clearArtworkStmt = db.prepare("UPDATE watch_history SET poster_url = NULL, logo_url = NULL, backdrop_url = NULL, updated_at = ? WHERE id = ?");

// Fix Match rematches a record to a new TMDB/TVDB id but leaves any previously
// stored poster/backdrop URL in place. /api/poster serves a row's stored URL
// directly when it already points at cached storage, so without clearing it
// here the old show/movie's artwork would keep being served forever instead
// of being re-resolved against the new match.
export async function clearWatchArtworkUrls(id) {
  if (!id) return false;
  const oldRow = selectByIdStmt.get(String(id));
  clearArtworkStmt.run(Date.now(), String(id));
  await invalidateAfterRowMetaWrite(id, oldRow, "artwork");
  return true;
}

// A movie can have several watch-history rows for the same media key. A
// rematch changes the identity used by the library query, so leaving artwork
// on a sibling row lets the old poster win when the library chooses its
// representative row.
export async function clearRelatedWatchArtworkUrls(id) {
  if (!id) return false;
  const rows = relatedPosterRows(id);
  if (!rows.length) return false;
  const now = Date.now();
  transaction(() => {
    for (const row of rows) clearArtworkStmt.run(now, String(row.id));
  });
  await invalidateHistoryDerivedCaches();
  return true;
}

export async function updateWatchPosterUrl(id, posterUrl) {
  const cleanUrl = cleanString(posterUrl);
  if (!id || !cleanUrl) return false;
  const row = selectByIdStmt.get(String(id));
  if (!row) return false;
  if ((row.poster_url || "") === cleanUrl) return false;
  updatePosterStmt.run(cleanUrl, Date.now(), String(id));
  await invalidateAfterRowMetaWrite(id, row, "artwork");
  return true;
}

// Returns the sibling watch records that should share a custom poster with `id`:
// every other play of the same movie, or every episode of the same show. Each
// entry carries its `id` (for stamping `poster_url`) and `media_key` (which
// /api/poster reads from the poster cache before falling back to `poster_url`).
export function relatedPosterRows(id) {
  const existing = selectByIdStmt.get(String(id));
  if (!existing) return [];
  let rows;
  if (existing.media_type === "episode") {
    const showLower = existing.show_title_lower || showTitleFrom(existing.title || "").toLowerCase();
    rows = showLower ? selectEpisodesByShowLowerStmt.all(showLower) : [];
    if (!rows.length) {
      const showKey = canonicalTitleKey(existing.show_title || showTitleFrom(existing.title));
      rows = selectAllEpisodesStmt.all().filter((row) => canonicalTitleKey(row.show_title || showTitleFrom(row.title)) === showKey);
    }
  } else {
    rows = existing.media_key ? selectByMediaKeyStmt.all(existing.media_key) : [existing];
  }
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    result.push({ id: row.id, media_key: row.media_key || mediaKeyFor(row) });
  }
  return result;
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

export async function setWatchBackdropUrl(id, backdropUrl) {
  const url = cleanString(backdropUrl);
  if (!id || !url) return false;
  const oldRow = selectByIdStmt.get(String(id));
  updateBackdropStmt.run(url, Date.now(), String(id));
  await invalidateAfterRowMetaWrite(id, oldRow, "artwork");
  return true;
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
  let dbRow = selectByIdStmt.get(String(id));
  if (!dbRow && id) {
    const byKey = selectByMediaKeyStmt.all(String(id));
    if (byKey.length) dbRow = byKey[0];
  }
  const row = rowToWatch(dbRow);
  if (!row) return null;
  if (row.media_key) {
    const allRows = await getCachedHistory();
    const matches = filterSameEventDuplicateRows(allRows.filter((r) => r.media_key === row.media_key && isPlembfinTrackedWatchRow(r)));
    row.playHistory = matches.map(playHistoryEntry).filter((entry) => entry.watched_at);
    row.playHistory.sort((a, b) => a.watched_at.localeCompare(b.watched_at));
  } else {
    row.playHistory = [playHistoryEntry(row)].filter((entry) => entry.watched_at);
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
  const existing = selectByIdStmt.get(String(id)) || selectByMediaKeyStmt.all(String(id))[0];
  if (!existing) return { ok: false, error: "Watch record not found" };
  const targetId = existing.id;

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
  if (fields.backdrop_url != null) { sets.push("backdrop_url = ?"); params.push(String(fields.backdrop_url).trim()); }
  if (fields.imdb_id != null) { sets.push("imdb_id = ?"); params.push(String(fields.imdb_id).trim()); }
  if (fields.tmdb_id != null) { sets.push("tmdb_id = ?"); params.push(String(fields.tmdb_id).trim()); }
  if (fields.tvdb_id != null) { sets.push("tvdb_id = ?"); params.push(String(fields.tvdb_id).trim()); }
  const identityChanged = fields.imdb_id != null || fields.tmdb_id != null || fields.tvdb_id != null;
  if (identityChanged) {
    sets.push("sync_dispatch_telemetry = ?", "sync_retry_count = ?", "sync_next_retry_at = ?");
    params.push("Identity updated via Fix Match. Pending outbound sync.", 0, 0);
  }
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

  // Fix Match corrects a row's identity in place, and that must also move it
  // onto the media_key its new identity computes to - otherwise it stays
  // grouped under its old (often title-only) key forever, permanently split
  // from any other row for the same item, with the edit-date list, playstate,
  // and history-audit trail all still keyed by the stale identity.
  const oldMediaKey = existing.media_key;
  let newMediaKey = oldMediaKey;
  if (identityChanged) {
    newMediaKey = mediaKeyFor({
      ...existing,
      imdb_id: fields.imdb_id != null ? String(fields.imdb_id).trim() : existing.imdb_id,
      tmdb_id: fields.tmdb_id != null ? String(fields.tmdb_id).trim() : existing.tmdb_id,
      tvdb_id: fields.tvdb_id != null ? String(fields.tvdb_id).trim() : existing.tvdb_id,
    });
    if (newMediaKey !== oldMediaKey) { sets.push("media_key = ?"); params.push(newMediaKey); }
  }

  const updatedAt = Date.now();
  sets.push("updated_at = ?"); params.push(updatedAt);
  params.push(String(targetId));
  db.prepare(`UPDATE watch_history SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  recordWatchAuditEvent({
    eventType: "history_record_updated",
    timestamp: updatedAt,
    action: existing.sync_action || "watched",
    watchRecordId: targetId,
    mediaKey: existing.media_key,
    mediaType: existing.media_type,
    title: fields.title != null ? String(fields.title).trim() : existing.title,
    showTitle: existing.show_title,
    source: "manual",
    ids: {
      imdb: existing.imdb_id,
      tmdb: fields.tmdb_id != null ? String(fields.tmdb_id).trim() : existing.tmdb_id,
      tvdb: fields.tvdb_id != null ? String(fields.tvdb_id).trim() : existing.tvdb_id,
    },
    season: existing.season,
    episode: existing.episode,
    status: "updated",
    details: "Stored watch history record updated in Plembfin.",
    payload: { fields, previousRecord: existing, updatedAt },
  });
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

  // The row just moved to newMediaKey - roll the old key's playstate back to
  // whatever else still lives there (or drop it if nothing does), and fold
  // this row into whatever the new key's playstate already reflects, the same
  // reconciliation deleteWatchDate does when a row leaves a media_key.
  if (identityChanged && newMediaKey !== oldMediaKey) {
    if (oldMediaKey) {
      const oldRemaining = selectByMediaKeyStmt.all(oldMediaKey).filter(isPlembfinTrackedWatchRow);
      if (oldRemaining.length) {
        const oldLatest = oldRemaining.reduce((best, row) => (String(row.watched_at || "") > String(best.watched_at || "") ? row : best));
        updatePlaystateWatchedAtStmt.run(oldLatest.watched_at, Date.now(), oldMediaKey);
      } else {
        deletePlaystateByKeyStmt.run(oldMediaKey);
      }
    }
    const newSiblings = selectByMediaKeyStmt.all(newMediaKey).filter(isPlembfinTrackedWatchRow);
    if (newSiblings.length) {
      const newLatest = newSiblings.reduce((best, row) => (String(row.watched_at || "") > String(best.watched_at || "") ? row : best));
      const existingNewPlaystate = selectPlaystateStmt.get(newMediaKey);
      const sources = new Set(parseJson(existingNewPlaystate?.sources, []) || []);
      if (newLatest.source) sources.add(newLatest.source);
      upsertPlaystateStmt.run({
        media_key: newMediaKey,
        title: newLatest.title,
        title_lower: (newLatest.title || "").toLowerCase(),
        media_type: newLatest.media_type,
        state: "watched",
        watched_at: newLatest.watched_at,
        last_source: newLatest.source || existingNewPlaystate?.last_source || "manual",
        sources: toJson([...sources].sort()),
        imdb_id: newLatest.imdb_id || existingNewPlaystate?.imdb_id || null,
        tmdb_id: newLatest.tmdb_id || existingNewPlaystate?.tmdb_id || null,
        tvdb_id: newLatest.tvdb_id || existingNewPlaystate?.tvdb_id || null,
        season: newLatest.season,
        episode: newLatest.episode,
        poster_url: newLatest.poster_url || existingNewPlaystate?.poster_url || null,
        updated_at: Date.now(),
      });
    }
  }

  await invalidateHistoryDerivedCaches();
  return { ok: true };
}

// Update a set of existing watch rows in one transaction. This is deliberately
// separate from updateWatchRecord: the single-row editor keeps same-day episode
// echo rows synchronized, while a season/show edit must stamp exactly the rows
// the caller selected. In particular, a release-date season edit can assign a
// different date to every episode without rewriting another genuine watch or
// creating a new history row.
export async function updateWatchDates(updates = []) {
  if (!Array.isArray(updates) || !updates.length) {
    return { ok: false, error: "updates is required" };
  }
  if (updates.length > 500) {
    return { ok: false, error: "Too many watch dates in one update" };
  }

  const resolved = [];
  const seenIds = new Set();
  for (const update of updates) {
    const requestedId = String(update?.id || "").trim();
    const requestedMediaKey = String(update?.media_key || "").trim();
    const existing = requestedId
      ? selectByIdStmt.get(requestedId)
      : requestedMediaKey
        ? selectByMediaKeyStmt.all(requestedMediaKey)
          .filter(isPlembfinTrackedWatchRow)
          .sort((a, b) => String(b.watched_at || "").localeCompare(String(a.watched_at || "")))[0]
        : null;
    if (!existing) return { ok: false, error: `Watch record not found${requestedId ? `: ${requestedId}` : ""}` };
    if (!isPlembfinTrackedWatchRow(existing)) return { ok: false, error: "Only watched records can be date-edited" };
    if (seenIds.has(existing.id)) return { ok: false, error: `Duplicate watch record: ${existing.id}` };

    const date = new Date(update?.watched_at);
    if (!update?.watched_at || Number.isNaN(date.getTime())) {
      return { ok: false, error: `Invalid watched_at value for ${existing.id}` };
    }

    seenIds.add(existing.id);
    resolved.push({ existing, watchedAt: date.toISOString() });
  }

  const updatedAt = Date.now();
  const mediaKeys = new Set(resolved.map(({ existing }) => existing.media_key).filter(Boolean));
  for (const { existing } of resolved) queueProgressUpdateForRecord(existing);

  transaction(() => {
    for (const { existing, watchedAt } of resolved) {
      updateWatchRowWatchedAtStmt.run(watchedAt, updatedAt, existing.id);
      recordWatchAuditEvent({
        eventType: "history_record_updated",
        timestamp: updatedAt,
        action: existing.sync_action || "watched",
        watchRecordId: existing.id,
        mediaKey: existing.media_key,
        mediaType: existing.media_type,
        title: existing.title,
        showTitle: existing.show_title,
        source: "manual",
        ids: { imdb: existing.imdb_id, tmdb: existing.tmdb_id, tvdb: existing.tvdb_id },
        season: existing.season,
        episode: existing.episode,
        status: "updated",
        details: "Stored watch history date updated by a season/show date edit.",
        payload: { previousWatchedAt: existing.watched_at, watchedAt, operation: "bulk_watch_date_update" },
      });
    }

    // Keep the canonical playstate pointer at the latest remaining real watch
    // for each media key, even when the edit moves the representative row
    // earlier than an older or repeated viewing.
    for (const mediaKey of mediaKeys) {
      const remaining = selectByMediaKeyStmt.all(mediaKey).filter(isPlembfinTrackedWatchRow);
      const latest = remaining.reduce((best, row) => (
        String(row.watched_at || "") > String(best?.watched_at || "") ? row : best
      ), null);
      if (latest) updatePlaystateWatchedAtStmt.run(latest.watched_at, updatedAt, mediaKey);
    }
  });

  await invalidateHistoryDerivedCaches();
  return { ok: true, updated_ids: resolved.map(({ existing }) => existing.id) };
}

// Fix Match operates at show scope. Performing one update-watch request per
// episode is especially expensive over a deployed connection because each
// request also invalidates derived caches. Stamp every episode in one SQLite
// transaction, invalidate once, then rebuild remote-derived progress metadata
// after the response path has completed.
// Swaps the show-name segment of an episode title, keeping the SxxEyy
// coordinates and any episode-name suffix. Replacing everything ahead of the
// coordinates also drops a stale trailing year from the old name.
function retitledEpisode(existingTitle = "", newShowTitle = "", season = null, episode = null) {
  const text = cleanString(decodeBasicHtmlEntities(existingTitle));
  const coordinateMatch = text.match(/^(.*?)(\s+-\s+S\d{1,3}E\d{1,3}\b.*)$/i);
  if (coordinateMatch) return `${newShowTitle}${coordinateMatch[2]}`;
  if (season != null && episode != null) {
    return `${newShowTitle} - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  }
  return newShowTitle;
}

export async function rematchShowWatchRecords({ id = "", showTitle = "", tvdbId = "", newShowTitle = "" } = {}) {
  const cleanTvdbId = cleanString(tvdbId);
  if (!cleanTvdbId) return { ok: false, error: "tvdb_id is required" };

  const anchor = id ? selectByIdStmt.get(String(id)) : null;
  if (id && !anchor) return { ok: false, error: "Watch record not found" };
  if (anchor && anchor.media_type !== "episode") return { ok: false, error: "Watch record is not a TV episode" };

  const resolvedTitle = cleanString(anchor?.show_title || (anchor?.title ? showTitleFrom(anchor.title) : showTitle));
  if (!resolvedTitle) return { ok: false, error: "show_title is required" };

  // The show the user picked. Fix Match corrects which series these episodes
  // belong to, so the stored name has to follow the new match - otherwise a
  // mismatched or "Unknown Show" group keeps its old name and stays parked on
  // the old route even though the ids now point somewhere else.
  const cleanNewShowTitle = cleanString(newShowTitle);
  const renameTo =
    cleanNewShowTitle && canonicalTitleKey(cleanNewShowTitle) !== canonicalTitleKey(resolvedTitle)
      ? cleanNewShowTitle
      : "";

  // Not just an exact show_title_lower match, and not only as a fallback
  // when that finds nothing: this show's own episode rows can carry
  // different exact show_title text over time (a trailing "(YYYY)" present
  // on some inserts, absent on others - see the matching comment in
  // queryShowDetail), so an exact match alone can silently repair only a
  // subset of the show's real episodes while leaving the rest - including,
  // confusingly, rows that still look wrong afterward - on their old,
  // mismatched identity. Scan by the same normalized key every row is
  // grouped by everywhere else instead, so Fix Match always repairs every
  // episode of the show in one pass.
  const showKey = canonicalTitleKey(showTitleFrom(resolvedTitle));
  const rows = selectAllEpisodesStmt.all().filter((row) => (
    canonicalTitleKey(showTitleFrom(row.show_title || row.title)) === showKey
  ));
  if (!rows.length) return { ok: false, error: "No episodes found for show" };

  const oldTmdbIds = new Set(rows.map((row) => cleanString(row.tmdb_id)).filter(Boolean));
  // The progress cache can hold a resolved tmdb_id that was never written back
  // onto any row (e.g. resolved from an earlier ambiguous title search), so it
  // wouldn't be caught by oldTmdbIds above - drop it too or queryShowDetail's
  // cachedShowTmdbId() keeps serving it as the "cached" candidate.
  const cachedProgressTmdbId = cleanString(getCachedShowProgress(showKey)?.tmdb_id);
  if (cachedProgressTmdbId) oldTmdbIds.add(cachedProgressTmdbId);
  const mediaKeys = new Set(rows.map((row) => cleanString(row.media_key)).filter(Boolean));
  const updatedAt = Date.now();

  // Old media_key -> new media_key, collected while the rows are rewritten so the
  // playstate rows keyed by the old value can follow in the same transaction.
  const keyMigrations = new Map();

  transaction(() => {
    for (const row of rows) {
      rematchShowEpisodeStmt.run(cleanTvdbId, updatedAt, row.id);

      const nextTitle = renameTo ? retitledEpisode(row.title, renameTo, row.season, row.episode) : row.title;
      if (renameTo) {
        updateShowTitleStmt.run(
          nextTitle,
          nextTitle.toLowerCase(),
          renameTo,
          renameTo.toLowerCase(),
          updatedAt,
          row.id,
        );
      }

      // The key encodes the identity that just changed, so it has to be rebuilt
      // from what the row now holds - otherwise it keeps pointing at the old
      // show and playstate lookups miss.
      const previousKey = cleanString(row.media_key);
      const nextKey = mediaKeyFor({
        media_type: "episode",
        season: row.season,
        episode: row.episode,
        tvdb_id: cleanTvdbId,
        title: nextTitle,
      });
      if (nextKey && nextKey !== previousKey) {
        updateWatchMediaKeyStmt.run(nextKey, updatedAt, row.id);
        if (previousKey) keyMigrations.set(previousKey, { nextKey, title: nextTitle });
      }
    }

    for (const [previousKey, { nextKey, title }] of keyMigrations) {
      // A playstate row may already sit at the destination when only some of the
      // episodes were mis-keyed. The row already at the correct key is the
      // authoritative one, so drop the stale source rather than collide with it.
      if (selectPlaystateKeyStmt.get(nextKey)) deletePlaystateByKeyStmt.run(previousKey);
      else movePlaystateKeyStmt.run(nextKey, cleanTvdbId, title, title.toLowerCase(), updatedAt, previousKey);
    }

    for (const mediaKey of mediaKeys) deletePosterByMediaKeyStmt.run(mediaKey);
    for (const tmdbId of oldTmdbIds) deleteTmdbMetadataStmt.run(`tv_${tmdbId}`);
    deleteTvdbMetadataStmt.run(`series_${cleanTvdbId}`);
  });

  // Drop the stale cached progress entry (and its cached tmdb_id) synchronously
  // so a request for this show between now and the background refresh below
  // can't have the old show's id served back to it via queryShowDetail(). After
  // a rename both names have to be cleared: the old entry would otherwise leave
  // a ghost of the previous show behind.
  clearCachedShowProgress(resolvedTitle);
  if (renameTo) clearCachedShowProgress(renameTo);

  queueShowProgressUpdate(renameTo || resolvedTitle);
  bumpDataVersion();
  await invalidateHistoryDerivedCaches();
  setImmediate(() => {
    flushShowProgressUpdates().catch((error) => {
      console.error("[dataRepo] Background show progress refresh failed after Fix Match", error);
    });
  });

  return {
    ok: true,
    updatedRows: rows.length,
    showTitle: renameTo || resolvedTitle,
    previousShowTitle: resolvedTitle,
    renamed: Boolean(renameTo),
    tvdbId: cleanTvdbId,
  };
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

const selectNullSeasonEpisodeRowsStmt = db.prepare(
  "SELECT id, title, media_key, season, episode, imdb_id, tmdb_id, tvdb_id FROM watch_history WHERE media_type = 'episode' AND season IS NULL",
);
const updateWatchSeasonStmt = db.prepare("UPDATE watch_history SET season = ?, updated_at = ? WHERE id = ?");
const movePlaystateSeasonKeyStmt = db.prepare(
  "UPDATE playstate SET media_key = ?, season = ?, updated_at = ? WHERE media_key = ?",
);

// Episode rows with no season number cannot match reliably for sync and do not
// count toward show progress, but the season is still written in the title
// ("Show - S00E13"). Recovering it also changes what mediaKeyFor produces, so the
// key is rebuilt and the playstate row keyed by the old value follows in the same
// transaction - leaving those out of step would strand the watched state.
export async function backfillMissingEpisodeSeasons() {
  const rows = selectNullSeasonEpisodeRowsStmt.all();
  if (!rows.length) return 0;

  const updatedAt = Date.now();
  const keyMigrations = new Map();
  let fixed = 0;

  transaction(() => {
    for (const row of rows) {
      const { season } = episodeCoordinatesFromTitle(row.title);
      if (season == null || !Number.isFinite(Number(season))) continue;

      updateWatchSeasonStmt.run(Number(season), updatedAt, row.id);
      fixed++;

      const previousKey = cleanString(row.media_key);
      const nextKey = mediaKeyFor({
        media_type: "episode",
        season: Number(season),
        episode: row.episode,
        imdb_id: row.imdb_id,
        tmdb_id: row.tmdb_id,
        tvdb_id: row.tvdb_id,
        title: row.title,
      });
      if (nextKey && nextKey !== previousKey) {
        updateWatchMediaKeyStmt.run(nextKey, updatedAt, row.id);
        if (previousKey) keyMigrations.set(previousKey, { nextKey, season: Number(season) });
      }
    }

    for (const [previousKey, { nextKey, season }] of keyMigrations) {
      if (selectPlaystateKeyStmt.get(nextKey)) deletePlaystateByKeyStmt.run(previousKey);
      else movePlaystateSeasonKeyStmt.run(nextKey, season, updatedAt, previousKey);
    }
  });

  if (fixed) {
    await invalidateHistoryDerivedCaches();
    console.log(`[dataRepo] backfillMissingEpisodeSeasons: recovered ${fixed} of ${rows.length} season numbers`);
  }
  return fixed;
}

export async function backfillUnknownShowTitles() {
  const rows = selectUnknownShowRowsStmt.all();
  if (!rows.length) return 0;
  let fixed = 0;
  transaction(() => {
    for (const row of rows) {
      let recovered = recoverShowTitle(row.tmdb_id, row.tvdb_id);
      let newTitle = null;
      if (recovered) {
        const oldTitle = row.title || "";
        newTitle = oldTitle.replace(/^Unknown Show(\s+-\s+S\d)/i, `${recovered}$1`);
      } else {
        // No sibling record shares this episode's ids (e.g. Plex supplies only
        // episode-unique TMDB/IMDb ids). Fall back to the resolved title recorded
        // in the dispatch telemetry, which also restores the episode coordinate.
        const fromTelemetry = recoverTitleFromTelemetry(row.sync_dispatch_telemetry);
        if (fromTelemetry) {
          recovered = fromTelemetry.showTitle;
          newTitle = fromTelemetry.fullTitle;
        }
      }
      if (!recovered || !newTitle) continue;
      updateShowTitleStmt.run(newTitle, newTitle.toLowerCase(), recovered, recovered.toLowerCase(), Date.now(), row.id);
      fixed++;
    }
  });
  if (fixed) {
    await invalidateHistoryDerivedCaches();
    console.log(`[dataRepo] backfillUnknownShowTitles: fixed ${fixed} of ${rows.length} records`);
  }
  return fixed;
}

export async function deleteWatchRecordById(id, { skipInvalidate = false } = {}) {
  if (!id) return false;
  const row = selectByIdStmt.get(String(id));
  if (row) {
    queueProgressUpdateForRecord(row);
    recordWatchAuditEvent({
      eventType: "history_deleted",
      timestamp: Date.now(),
      action: row.sync_action || "watched",
      watchRecordId: row.id,
      mediaKey: row.media_key,
      mediaType: row.media_type,
      title: row.title,
      showTitle: row.show_title,
      source: row.source,
      ids: { imdb: row.imdb_id, tmdb: row.tmdb_id, tvdb: row.tvdb_id },
      season: row.season,
      episode: row.episode,
      status: "deleted",
      details: "Watch history row deleted from Plembfin.",
      payload: { record: row },
    });
  }
  deleteByIdStmt.run(String(id));
  // playstate is a separate cached snapshot of "is this watched" and must be
  // reconciled here, not left for the caller to remember - a caller that
  // deletes the last remaining watch_history row for a media_key and skips
  // this leaves playstate stuck reporting "watched" for an item Plembfin no
  // longer has any record of, which is exactly the drift that let Force Sync
  // and the Movies/TV Shows/History pages disagree with each other.
  if (row?.media_key) {
    const remaining = selectByMediaKeyStmt.all(row.media_key).filter(isPlembfinTrackedWatchRow);
    if (remaining.length) {
      const remainingRow = remaining.reduce((best, r) => (String(r.watched_at || "") > String(best.watched_at || "") ? r : best));
      updatePlaystateWatchedAtStmt.run(remainingRow.watched_at, Date.now(), row.media_key);
    } else {
      deletePlaystateByKeyStmt.run(row.media_key);
    }
  }
  if (!skipInvalidate) await invalidateHistoryDerivedCaches();
  return true;
}

export async function deleteWatchRecord(media, { skipInvalidate = false } = {}) {
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
    for (const row of rows) {
      deleteByIdStmt.run(row.id);
      recordWatchAuditEvent({
        eventType: "history_deleted",
        timestamp: Date.now(),
        action: row.sync_action || "watched",
        watchRecordId: row.id,
        mediaKey: row.media_key,
        mediaType: row.media_type,
        title: row.title,
        showTitle: row.show_title,
        source: row.source,
        ids: { imdb: row.imdb_id, tmdb: row.tmdb_id, tvdb: row.tvdb_id },
        season: row.season,
        episode: row.episode,
        status: "deleted",
        details: "Watch history row deleted from Plembfin.",
        payload: { record: row },
      });
    }
  });
  if (!skipInvalidate) await invalidateHistoryDerivedCaches();
  return true;
}

export function requireDb() {
  return db;
}

// One-time repair for the Trakt play-history import incident (2026-08-19): the
// feature originally inserted "trakt_import" watch rows with no
// sync_dispatch_telemetry, so the scheduler's manual-dispatch retry sweep
// treated every one of them as pending work and kept re-sending them to
// every connected target, including back out to Trakt. The fix stops new
// rows from being created this way (they now always carry settled
// telemetry), but rows already inserted before the fix was deployed are
// still sitting there with telemetry = NULL and still get swept up on every
// scheduler tick. NULL telemetry on a "trakt_import" row uniquely identifies
// this: the CSV/JSON bulk importer always writes telemetry via
// defaultTelemetry(), and the play-history importer has written explicit
// "skipped" telemetry since the fix, so nothing legitimate should ever have
// a NULL value here.
const STALE_TRAKT_IMPORT_TELEMETRY = [
  "Origin: trakt_import",
  "Loop-check: Skipped propagation",
  "Dispatch status: skipped",
  "Details: Historical play imported before dispatch telemetry was recorded on import; repaired to stop repeated re-dispatch.",
  "Target plex status: skipped - Historical import; not re-propagated",
  "Target emby status: skipped - Historical import; not re-propagated",
  "Target jellyfin status: skipped - Historical import; not re-propagated",
].join("\n");
const selectStaleTraktImportRowsStmt = db.prepare(
  "SELECT id, title, watched_at, created_at FROM watch_history WHERE source = 'trakt_import' AND sync_action = 'watched' AND sync_dispatch_telemetry IS NULL ORDER BY created_at ASC",
);
const repairStaleTraktImportRowsStmt = db.prepare(
  "UPDATE watch_history SET sync_dispatch_telemetry = ?, sync_retry_count = 0, sync_next_retry_at = 0, updated_at = ? WHERE source = 'trakt_import' AND sync_action = 'watched' AND sync_dispatch_telemetry IS NULL",
);

export function auditStaleTraktImportRows({ sampleSize = 25 } = {}) {
  const rows = selectStaleTraktImportRowsStmt.all();
  return {
    count: rows.length,
    sample: rows.slice(0, sampleSize).map((row) => ({ id: row.id, title: row.title, watchedAt: row.watched_at, createdAt: row.created_at })),
  };
}

export function repairStaleTraktImportRows() {
  const result = repairStaleTraktImportRowsStmt.run(STALE_TRAKT_IMPORT_TELEMETRY, Date.now());
  return { repaired: result.changes };
}

// --- Maintenance helpers (used by index.js admin endpoints) ----------------
export async function findExistingWatch(mediaKey, watchedAt) {
  return rowToWatch(findExistingStmt.get(mediaKey, watchedAt));
}

export async function findWatchedByMediaKey(mediaKey) {
  return rowToWatch(findWatchedByKeyStmt.get(mediaKey));
}

// Checks all possible key formats for the same media item (IMDB, TMDB, TVDB, title),
// then falls back to coordinate-based lookup (type+season+episode+title/show_title)
// to match records that were imported with a different ID type (e.g. Trakt IMDB keys
// vs Emby TVDB keys) or keyed by title.
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

  // Coordinate fallback: match by season+episode+show_title or title when no ID matched.
  // Handles Trakt-imported records (IMDB-keyed) being looked up via Emby/Jellyfin (TVDB-keyed).
  const type = String(media.media_type || media.type || "").toLowerCase();
  const season = media.season ?? null;
  const episode = media.episode ?? null;
  if (type === "episode" && season != null && episode != null) {
    const rawShowTitle = media.show_title || media.showTitle || media.title?.split(" - S")[0] || "";
    const showTitleLower = rawShowTitle.trim().toLowerCase();
    if (showTitleLower) {
      const row = findWatchedByShowCoordinatesStmt.get(season, episode, showTitleLower);
      if (row) return rowToWatch(row);
    }
    const titleLower = (media.title || "").trim().toLowerCase();
    if (titleLower) {
      const row = findWatchedByCoordinatesStmt.get("episode", season, season, episode, episode, titleLower);
      if (row) return rowToWatch(row);
    }
    // Last resort: the exact-string matches above found nothing, but this
    // could still be the same real episode after a media-server metadata
    // rematch (every provider id changed) or a trailing "(YYYY)" that only
    // one side carries - e.g. "Ludwig" vs "Ludwig (2024)". Without this, a
    // rematch makes every affected episode look brand new and gets
    // duplicated instead of recognized on the next sync.
    if (rawShowTitle) {
      const targetKey = canonicalShowTitleKey(rawShowTitle);
      if (targetKey) {
        const match = findWatchedBySeasonEpisodeStmt.all(season, episode)
          .find((row) => canonicalShowTitleKey(row.show_title) === targetKey);
        if (match) return rowToWatch(match);
      }
    }
  } else if (type === "movie") {
    const titleLower = (media.title || "").trim().toLowerCase();
    if (titleLower) {
      const row = findWatchedByCoordinatesStmt.get("movie", null, null, null, null, titleLower);
      if (row) return rowToWatch(row);
    }
    // Last resort: an exact title_lower match can miss two rows for the same
    // movie that only differ by whitespace variant - e.g. Trakt imports often
    // carry a non-breaking space after a colon ("Title: Subtitle") where
    // Plex/Emby/Jellyfin report a plain space for the identical title. Without
    // this, that already-watched movie looks brand new on the next scheduled
    // sync and gets duplicated under a second, title-only media_key. Mirrors
    // the episode fallback above, using the same canonicalTitleKey normalizer
    // siblingWatchRowsFor already relies on to merge these rows for display.
    const targetKey = canonicalTitleKey(media.title || "");
    if (targetKey) {
      const match = selectMoviesStmt.all()
        .find((row) => row.sync_action === "watched" && canonicalTitleKey(row.title) === targetKey);
      if (match) return rowToWatch(match);
    }
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
  const viewingRows = filterSameEventDuplicateRows(clusterRows);
  const playHistoryByDate = new Map();
  for (const row of viewingRows) {
    if (row.watched_at && !playHistoryByDate.has(row.watched_at)) {
      playHistoryByDate.set(row.watched_at, playHistoryEntry(row));
    }
  }
  const playHistory = [...playHistoryByDate.values()].sort((a, b) => String(a.watched_at).localeCompare(String(b.watched_at)));
  const newest = viewingRows
    .slice()
    .sort((a, b) => String(a.watched_at || "").localeCompare(String(b.watched_at || "")))
    .pop();
  const base = { ...(newest || clusterRows[0] || {}), playHistory };
  for (const row of clusterRows) {
    if (!base.imdb_id && row.imdb_id) base.imdb_id = row.imdb_id;
    if (!base.tmdb_id && row.tmdb_id) base.tmdb_id = row.tmdb_id;
    if (!base.tvdb_id && row.tvdb_id) base.tvdb_id = row.tvdb_id;
    if (!base.poster_url && row.poster_url) base.poster_url = row.poster_url;
  }
  return base;
}

// Dedupe movies by clustering rows that refer to the same film. Rows are linked
// (union-find) when they share ANY external id (imdb/tmdb/tvdb) â€” this collapses
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

// Rows are linked (union-find) when they share ANY external id (imdb/tmdb/tvdb) -
// while single-use episode-level provider ids merge into the shared show series.
// When an established multi-episode show cluster exists, conflicting outlier rows
// (a single-row Trakt mismatch) and distinct multi-episode reboots keep their own
// cluster instead of being silently blended.
function showGroupKeys(rows = []) {
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
    const imdb = cleanString(row.show_imdb_id || row.imdb_id); if (imdb) nodes.push(`imdb:${imdb}`);
    const tmdb = cleanString(row.show_tmdb_id || row.tmdb_id); if (tmdb) nodes.push(`tmdb:${tmdb}`);
    const tvdb = cleanString(row.show_tvdb_id || row.tvdb_id); if (tvdb) nodes.push(`tvdb:${tvdb}`);
    return nodes;
  };

  for (const row of rows) {
    const nodes = idNodesFor(row);
    nodes.forEach(ensure);
    for (let i = 1; i < nodes.length; i += 1) union(nodes[0], nodes[i]);
  }

  const titleRoots = new Map();
  for (const row of rows) {
    const nodes = idNodesFor(row);
    if (!nodes.length) continue;
    const title = showTitleFrom(row.show_title || row.title);
    const titleKey = canonicalTitleKey(title) || normalizeKeyPart(title);
    if (!titleRoots.has(titleKey)) titleRoots.set(titleKey, new Map());
    const counts = titleRoots.get(titleKey);
    const root = find(nodes[0]);
    counts.set(root, (counts.get(root) || 0) + 1);
  }

  for (const [, counts] of titleRoots) {
    const roots = [...counts.keys()];
    const multiEpisodeRoots = roots.filter((r) => (counts.get(r) || 0) >= 2);
    if (multiEpisodeRoots.length <= 1 && roots.length > 1) {
      for (let i = 1; i < roots.length; i += 1) {
        union(roots[0], roots[i]);
      }
    }
  }

  const titleClusterKeys = new Map();
  for (const row of rows) {
    const nodes = idNodesFor(row);
    if (!nodes.length) continue;
    const title = showTitleFrom(row.show_title || row.title);
    const titleKey = canonicalTitleKey(title) || normalizeKeyPart(title);
    if (!titleClusterKeys.has(titleKey)) titleClusterKeys.set(titleKey, new Set());
    titleClusterKeys.get(titleKey).add(find(nodes[0]));
  }

  const keys = new Map();
  for (const row of rows) {
    const nodes = idNodesFor(row);
    if (nodes.length) {
      keys.set(row, find(nodes[0]));
      continue;
    }
    const title = showTitleFrom(row.show_title || row.title);
    const titleKey = canonicalTitleKey(title) || normalizeKeyPart(title);
    const matches = titleClusterKeys.get(titleKey);
    keys.set(row, matches?.size === 1 ? [...matches][0] : `title:${titleKey || "unknown-show"}`);
  }
  return keys;
}

// Deterministic tie-break for callers that need a single show out of
// groupShowRows's results (queryShowDetail's title-only lookups have no
// provider id to disambiguate by) - most recently active first, rather than
// whichever cluster happened to form first.
function mostRecentShowFirst(shows = []) {
  return [...shows].sort((a, b) => {
    // A cluster with only a handful of watched episodes racing ahead of a far
    // larger, well-established one purely on recency is far more likely to be
    // a stray mismatched import (e.g. Trakt resolving an ambiguous title to
    // an unrelated show for one play) than a genuine distinct show sharing
    // the same title - prefer the substantially larger cluster in that case
    // rather than picking whichever was touched most recently.
    const aCount = Number(a.episode_count || 0);
    const bCount = Number(b.episode_count || 0);
    const larger = Math.max(aCount, bCount);
    const smaller = Math.min(aCount, bCount);
    const substantiallyLarger = larger >= 5 && larger >= smaller * 5;
    if (substantiallyLarger && aCount !== bCount) return bCount - aCount;
    return String(b.latest_watched_at || "").localeCompare(String(a.latest_watched_at || ""));
  });
}

function groupShowRows(rows = []) {
  const groupKeys = showGroupKeys(rows);
  const groups = new Map();
  rows.forEach((row) => {
    const rawTitle = cleanString(row.show_title || showTitleFrom(row.title));
    const title = showTitleFrom(row.show_title || row.title);
    const key = groupKeys.get(row);
    const group = groups.get(key) || {
      title,
      raw_title: rawTitle,
      episode_count: 0,
      season_count: 0,
      latest_watched_at: "",
      earliest_watched_at: "",
      episodes: [],
      seasons: new Set(),
      representative_episode: null,
      poster_url: null,
      logo_url: null,
      backdrop_url: null,
      tmdb_id: null,
      tvdb_id: null,
      tmdbIdCounts: new Map(),
      imdbIdCounts: new Map(),
      tvdbIdCandidates: new Set(),
    };
    group.title = preferredShowTitle(group.title, title);
    group.episodes.push({ ...row, show_title: group.title });
    // Identity/artwork are watched-state agnostic - pull from any row so a
    // fully-unwatched show still has a poster and provider id.
    if (row.poster_url && !group.poster_url) {
      group.poster_url = row.poster_url;
    }
    if (row.logo_url && !group.logo_url) {
      group.logo_url = row.logo_url;
    }
    if (row.backdrop_url && !group.backdrop_url) {
      group.backdrop_url = row.backdrop_url;
    }
    if (row.tmdb_id) {
      const tmdb = String(row.tmdb_id);
      group.tmdbIdCounts.set(tmdb, (group.tmdbIdCounts.get(tmdb) || 0) + 1);
    }
    if (row.imdb_id) {
      const imdb = String(row.imdb_id);
      group.imdbIdCounts.set(imdb, (group.imdbIdCounts.get(imdb) || 0) + 1);
    }
    // Every distinct tvdb_id seen is only a *candidate* show identity here -
    // resolved for real (cachedShowTvdbId) below, since a row's tvdb_id is
    // often an episode-level id, not the show's.
    if (row.tvdb_id) group.tvdbIdCandidates.add(String(row.tvdb_id));
    // Watched-progress aggregates (count, seasons, recency, representative
    // episode) only consider rows currently marked watched. Marking an
    // episode unwatched inserts a fresh row timestamped now - if that row
    // counted here, the show would look "just watched" (jumping to the top
    // of a Watched Newest sort) and its watched count would be inflated by
    // the very episode that was just removed from it.
    if (isWatchedAction(row)) {
      group.episode_count += 1;
      if (row.season != null) group.seasons.add(row.season);
      if (!group.latest_watched_at || row.watched_at > group.latest_watched_at) group.latest_watched_at = row.watched_at;
      if (!group.earliest_watched_at || row.watched_at < group.earliest_watched_at) group.earliest_watched_at = row.watched_at;
      if (!group.representative_episode || row.watched_at > group.representative_episode.watched_at) {
        group.representative_episode = { ...row, show_title: group.title };
      }
    }
    groups.set(key, group);
  });
  return [...groups.values()].map((group) => {
    const watchedEpisodes = group.episodes.filter(isWatchedAction);
    const totalWatches = watchedEpisodes.reduce((total, episode) => (
      total + (Array.isArray(episode.playHistory) && episode.playHistory.length ? episode.playHistory.length : 1)
    ), 0);
    const rewatchedEpisodeCount = watchedEpisodes.filter((episode) => (
      Array.isArray(episode.playHistory) && episode.playHistory.length > 1
    )).length;
    const topTmdbId = [...group.tmdbIdCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const topImdbId = [...group.imdbIdCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return {
      ...group,
      season_count: group.seasons.size,
      seasons: undefined,
      total_watches: totalWatches,
      rewatched_episode_count: rewatchedEpisodeCount,
      poster_url: group.poster_url || group.representative_episode?.poster_url || null,
      logo_url: group.logo_url || group.representative_episode?.logo_url || null,
      backdrop_url: group.backdrop_url || group.representative_episode?.backdrop_url || null,
      tmdb_id: topTmdbId || group.representative_episode?.tmdb_id || null,
      imdb_id: topImdbId || group.representative_episode?.imdb_id || null,
      tvdb_id: cachedShowTvdbId(...group.tvdbIdCandidates) || null,
      tvdbIdCandidates: undefined,
      tmdbIdCounts: undefined,
      imdbIdCounts: undefined,
      representative_episode: group.representative_episode ? { ...group.representative_episode, show_title: group.title } : null,
      episodes: group.episodes
        .map((episode) => ({ ...episode, show_title: group.title }))
        .sort((a, b) => Number(a.season || 0) - Number(b.season || 0) || Number(a.episode || 0) - Number(b.episode || 0)),
    };
  });
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
        total_watches: Math.max(Number(existing.total_watches || 0), Number(show.total_watches || 0)),
        rewatched_episode_count: Math.max(Number(existing.rewatched_episode_count || 0), Number(show.rewatched_episode_count || 0)),
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
  const nextAiringCache = await readNextAiringCache();
  const showsWithNextAiring = allShows.map((show) => {
    const cached = cachedNextAiringFor(nextAiringCache.entries, show.tmdb_id, show.title);
    if (!cached) return show;
    return {
      ...show,
      status: show.status || cached.status || "",
      next_airing_date: cached.nextAiringDate || "",
      next_airing_updated_at: cached.updatedAt || 0,
    };
  });
  const needle = cleanString(search).toLowerCase();
  const filtered = dedupeShowSummaries(showsWithNextAiring).filter((show) => {
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
  // Some legacy episode rows have no usable show_title; fall back to the
  // derived title even when the caller supplied a title.
  if (!resolvedTitle && id) resolvedTitle = String(id).replace(/-/g, " ");

  // A show's own episode rows can carry different exact show_title text over
  // time - Plex/Emby/Jellyfin's own title for a show is rarely year-suffixed
  // even when Plembfin's preferred display title is (or a Fix Match rename
  // only touched rows matching whichever text the anchor row happened to
  // have) - an exact show_title_lower match only ever sees whichever single
  // variant matches the query, silently missing the rest of the same show's
  // episodes (and, worse, can resolve a *different* variant to an entirely
  // unrelated show that happens to share that exact text). Normalize both
  // the query and every row's title the same way (showTitleFrom strips the
  // year) and scan by that canonical key instead, so every row for this show
  // is found regardless of which exact text it happens to carry.
  const key = canonicalTitleKey(showTitleFrom(resolvedTitle));
  // Not loadHistoryRowsByType/isPlembfinTrackedWatchRow: a show whose every
  // episode is currently unwatched (e.g. right after "Mark unwatched" on its
  // last watched episode) still needs to resolve here with its real episode
  // rows (each carrying its own sync_action) - otherwise the show disappears
  // from lookup entirely instead of rendering as 0 watched. Untrusted scan
  // rows stay excluded via isPlembfinTrackedEpisodeRow.
  const rows = dedupeHistory((await getCachedHistory()).filter((row) => row.media_type === "episode" && isPlembfinTrackedEpisodeRow(row)))
    .filter((row) => canonicalTitleKey(showTitleFrom(row.show_title || row.title)) === key);
  // A canonical-title match can still span two distinct real shows sharing a
  // title (a reboot/revival) now that groupShowRows splits them by provider
  // id instead of blending them - the most substantial (or, failing that,
  // most recently active) cluster is the more likely match for a lookup with
  // no id to disambiguate by.
  const [show] = mostRecentShowFirst(groupShowRows(rows));
  if (show) {
    const showKey = canonicalTitleKey(show.title) || normalizeKeyPart(show.title);
    const rawShowKey = canonicalTitleKey(show.raw_title) || normalizeKeyPart(show.raw_title);
    const cachedProgress = getCachedShowProgress(showKey) || (rawShowKey !== showKey ? getCachedShowProgress(rawShowKey) : null);
    // show.tmdb_id trusted unconditionally - see the matching comment in
    // getCachedShows above.
    show.tmdb_id = cleanString(show.tmdb_id) || cachedShowTmdbId(cachedProgress?.tmdb_id, show.representative_episode?.tmdb_id) || null;
    show.total_episodes = cachedProgress?.total_episodes || 0;
  }
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
    if (sort === "next_air_asc") {
      const dateA = a.next_airing_date || "";
      const dateB = b.next_airing_date || "";
      if (dateA && dateB) return dateA.localeCompare(dateB) || a.title.localeCompare(b.title);
      if (dateA) return -1;
      if (dateB) return 1;
      return a.title.localeCompare(b.title) || b.latest_watched_at.localeCompare(a.latest_watched_at);
    }
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
    progress: playbackProgressPercent(row.position_ms, row.duration_ms, row.progress),
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

    let earliest = null;
    const seasonNums = [...candidates].filter((n) => n > 0).sort((a, b) => a - b);
    for (const n of seasonNums) {
      const season = await getTmdbSeason({ tmdbId, seasonNumber: n, showStatus: details.status }).catch(() => null);
      if (!season) continue;
      for (const ep of season.episodes || []) {
        const d = ep.air_date;
        if (d && d >= today && (!earliest || d < earliest)) earliest = d;
      }
    }
    return earliest;
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
