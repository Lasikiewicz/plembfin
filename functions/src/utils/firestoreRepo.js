import { db, FieldValue, Timestamp } from "../firebase.js";
import { loadMediaConfig } from "./configStore.js";
import { fetchPosterFromTmdb } from "./tmdbClient.js";

const MAX_HISTORY_LIMIT = 25000;
const DERIVED_CACHE_COLLECTION = "derivedCache";
const PLAYSTATE_COLLECTION = db.collection("playstate");
const SHOW_SUMMARY_CACHE = db.collection("derivedShowSummaries");
const HISTORY_CACHE_DOC = db.collection(DERIVED_CACHE_COLLECTION).doc("history");
const STATS_CACHE_DOC = db.collection(DERIVED_CACHE_COLLECTION).doc("stats");
const SHOWS_CACHE_META_DOC = db.collection(DERIVED_CACHE_COLLECTION).doc("showSummaries");
const HISTORY_VISIBILITY_CACHE_VERSION = 3;

let historyCache = {
  version: null,
  rows: [],
};

let showCache = {
  version: null,
  shows: [],
};

async function getCachedHistory() {
  const marker = await HISTORY_CACHE_DOC.get().catch(() => null);
  const version = marker?.data()?.version || 0;
  if (historyCache.version === version && historyCache.rows.length > 0) {
    return historyCache.rows;
  }
  const snapshot = await db.collection("watchHistory")
    .orderBy("watchedAt", "desc")
    .limit(MAX_HISTORY_LIMIT)
    .get();
  const rows = snapshot.docs.map(fromFirestoreWatch);
  historyCache = { version, rows };
  return rows;
}

async function getCachedShows() {
  const version = await ensureShowSummaryCache();
  if (showCache.version === version && showCache.shows.length > 0) {
    return showCache.shows;
  }
  const snapshot = await SHOW_SUMMARY_CACHE.get();
  const shows = snapshot.docs.map(showSummaryFromCache);
  showCache = { version, shows };
  return shows;
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

function canonicalTitleKey(value) {
  return decodeBasicHtmlEntities(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
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
  };
  return normalized;
}

export function mediaToWatchRecord(media, source = media?.source || "webhook") {
  return normalizeWatchRecord(
    {
      title: media?.title,
      media_type: media?.type,
      watched_at: new Date().toISOString(),
      source,
      imdb_id: media?.ids?.imdb,
      tmdb_id: media?.ids?.tmdb,
      tvdb_id: media?.ids?.tvdb,
      season: media?.season,
      episode: media?.episode,
      poster_url: media?.posterUrl || media?.poster_url,
      sync_action: media?.syncAction || media?.sync_action || "watched",
      sync_dispatch_telemetry: media?.syncDispatchTelemetry,
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

function toFirestoreWatch(record) {
  const mediaKey = mediaKeyFor(record);
  const showTitle = record.media_type === "episode" ? showTitleFrom(record.title) : null;
  return {
    title: record.title,
    titleLower: record.title.toLowerCase(),
    mediaType: record.media_type,
    watchedAt: record.watched_at,
    source: record.source,
    ids: {
      imdb: record.imdb_id || null,
      tmdb: record.tmdb_id || null,
      tvdb: record.tvdb_id || null,
    },
    season: record.season,
    episode: record.episode,
    posterUrl: record.poster_url || null,
    syncAction: record.sync_action || "watched",
    syncDispatchTelemetry: record.sync_dispatch_telemetry || null,
    mediaKey,
    showTitle,
    showTitleLower: showTitle ? showTitle.toLowerCase() : null,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export function watchRecordToFirestoreData(record, fallbackSource = record?.source || "import") {
  const normalized = normalizeWatchRecord(record, fallbackSource);
  const errors = validateWatchRecord(normalized);
  if (errors.length) throw new Error(errors.join(", "));
  return { data: toFirestoreWatch(normalized), record: normalized };
}

function fromFirestoreWatch(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    title: decodeBasicHtmlEntities(data.title || ""),
    media_type: data.mediaType || "",
    watched_at: data.watchedAt || "",
    source: data.source || "",
    imdb_id: data.ids?.imdb || null,
    tmdb_id: data.ids?.tmdb || null,
    tvdb_id: data.ids?.tvdb || null,
    season: data.season ?? null,
    episode: data.episode ?? null,
    poster_url: data.posterUrl || null,
    sync_action: data.syncAction || "watched",
    sync_dispatch_telemetry: data.syncDispatchTelemetry || null,
    media_key: data.mediaKey || null,
    show_title: data.showTitle ? decodeBasicHtmlEntities(data.showTitle) : null,
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

function playbackProgressFromFirestore(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    media_key: data.mediaKey || doc.id,
    title: decodeBasicHtmlEntities(data.title || ""),
    media_type: data.mediaType || "",
    source: data.source || "",
    imdb_id: data.ids?.imdb || null,
    tmdb_id: data.ids?.tmdb || null,
    tvdb_id: data.ids?.tvdb || null,
    season: data.season ?? null,
    episode: data.episode ?? null,
    position_ms: Number(data.positionMs || 0),
    duration_ms: data.durationMs ?? null,
    progress: Number(data.progress || 0),
    updated_at: Number(data.updatedAt || 0),
    sync_dispatch_telemetry: data.syncDispatchTelemetry || null,
  };
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

function normalizePlaystateState(value = "watched") {
  const state = cleanString(value).toLowerCase();
  return ["unwatched", "unplayed"].includes(state) ? "unwatched" : "watched";
}

function playstateFromFirestore(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    media_key: data.mediaKey || doc.id,
    title: decodeBasicHtmlEntities(data.title || ""),
    media_type: data.mediaType || "",
    watched_at: data.watchedAt || "",
    state: data.state || "watched",
    source: data.lastSource || data.source || "",
    sources: Array.isArray(data.sources) ? data.sources : [],
    imdb_id: data.ids?.imdb || null,
    tmdb_id: data.ids?.tmdb || null,
    tvdb_id: data.ids?.tvdb || null,
    season: data.season ?? null,
    episode: data.episode ?? null,
    poster_url: data.posterUrl || null,
  };
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

export async function upsertPlaystate(_unusedDb, record, stateOverride = undefined) {
  const normalized = normalizeWatchRecord(record, record.source || "webhook");
  const errors = validateWatchRecord(normalized);
  if (errors.length) throw new Error(errors.join(", "));

  const state = normalizePlaystateState(stateOverride || normalized.sync_action);
  const mediaKey = mediaKeyFor(normalized);
  const ref = PLAYSTATE_COLLECTION.doc(mediaKey);
  const existing = await ref.get().catch(() => null);
  const sources = new Set(Array.isArray(existing?.data()?.sources) ? existing.data().sources : []);
  if (normalized.source) sources.add(normalized.source);

  await ref.set(
    {
      mediaKey,
      title: normalized.title,
      titleLower: normalized.title.toLowerCase(),
      mediaType: normalized.media_type,
      state,
      watchedAt: normalized.watched_at,
      lastSource: normalized.source,
      sources: [...sources].sort(),
      ids: {
        imdb: normalized.imdb_id || null,
        tmdb: normalized.tmdb_id || null,
        tvdb: normalized.tvdb_id || null,
      },
      season: normalized.season,
      episode: normalized.episode,
      posterUrl: normalized.poster_url || existing?.data()?.posterUrl || null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await invalidateHistoryDerivedCaches().catch(() => null);
  return { mediaKey, state, record: normalized };
}

export async function upsertPlaystateForMedia(_unusedDb, media, state = "watched", watchedAt = undefined) {
  return upsertPlaystate(_unusedDb, playstateRecordFromMedia(media, state, watchedAt), state);
}

export async function listWatchedPlaystateRowsForReplay({ limit = 25, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const snapshot = await PLAYSTATE_COLLECTION
    .where("state", "==", "watched")
    .offset(safeOffset)
    .limit(safeLimit)
    .get();
  return snapshot.docs.map(playstateFromFirestore);
}

export async function countWatchedPlaystateRows() {
  const snapshot = await PLAYSTATE_COLLECTION.where("state", "==", "watched").count().get();
  return snapshot.data().count || 0;
}

export async function invalidateHistoryDerivedCaches() {
  await Promise.allSettled([
    HISTORY_CACHE_DOC.set({ version: Date.now(), updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
    STATS_CACHE_DOC.delete(),
    SHOWS_CACHE_META_DOC.set({ stale: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
  ]);
}

export async function insertWatchRecord(_unusedDb, record) {
  const normalized = normalizeWatchRecord(record, record.source);
  const errors = validateWatchRecord(normalized);
  if (errors.length) throw new Error(errors.join(", "));

  const ref = db.collection("watchHistory").doc();
  await ref.set({
    ...toFirestoreWatch(normalized),
    createdAt: FieldValue.serverTimestamp(),
  });
  await invalidateHistoryDerivedCaches();
  return { id: ref.id, record: normalized };
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
  const batch = db.batch();

  const config = await loadMediaConfig().catch(() => ({}));
  const tmdbApiKey = config.tmdb?.apiKey;

  for (const [index, record] of records.entries()) {
    const normalized = normalizeWatchRecord(record, "trakt_import");
    const errors = validateWatchRecord(normalized);
    if (errors.length) {
      rejected.push({ index, errors });
      continue;
    }

    const existing = await db
      .collection("watchHistory")
      .where("mediaKey", "==", mediaKeyFor(normalized))
      .where("watchedAt", "==", normalized.watched_at)
      .limit(1)
      .get();
    if (!existing.empty) {
      skipped += 1;
      continue;
    }

    if (tmdbApiKey && !normalized.poster_url) {
      normalized.poster_url = await fetchPosterFromTmdb(normalized, tmdbApiKey);
    }

    const ref = db.collection("watchHistory").doc();
    batch.set(ref, {
      ...toFirestoreWatch({
        ...normalized,
        sync_dispatch_telemetry: normalized.sync_dispatch_telemetry || defaultTelemetry(normalized),
      }),
      createdAt: FieldValue.serverTimestamp(),
    });
    inserted += 1;
  }

  if (inserted) await batch.commit();
  if (inserted) await invalidateHistoryDerivedCaches();
  return { inserted, updated: 0, skipped, rejected };
}

export async function updateWatchTelemetry(_unusedDb, id, telemetry) {
  if (!id) return;
  await db.collection("watchHistory").doc(String(id)).set(
    {
      syncDispatchTelemetry: String(telemetry || ""),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await invalidateHistoryDerivedCaches();
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

  await db.collection("playbackProgress").doc(normalized.media_key).set(
    {
      mediaKey: normalized.media_key,
      title: normalized.title,
      mediaType: normalized.media_type,
      source: normalized.source,
      ids: {
        imdb: normalized.imdb_id || null,
        tmdb: normalized.tmdb_id || null,
        tvdb: normalized.tvdb_id || null,
      },
      season: normalized.season,
      episode: normalized.episode,
      positionMs: normalized.position_ms,
      durationMs: normalized.duration_ms,
      progress: normalized.progress,
      updatedAt: normalized.updated_at,
      syncDispatchTelemetry: normalized.sync_dispatch_telemetry,
    },
    { merge: true },
  );
  return normalized;
}

export async function updatePlaybackProgressTelemetry(_unusedDb, mediaOrRecord, telemetry) {
  const normalized = normalizePlaybackProgressRecord(mediaOrRecord, mediaOrRecord?.source);
  await db.collection("playbackProgress").doc(normalized.media_key).set(
    {
      syncDispatchTelemetry: String(telemetry || ""),
      updatedAt: Date.now(),
    },
    { merge: true },
  );
}

export async function deletePlaybackProgress(_unusedDb, mediaOrRecord) {
  const normalized = normalizePlaybackProgressRecord(mediaOrRecord, mediaOrRecord?.source);
  if (!normalized.media_key) return false;
  await db.collection("playbackProgress").doc(normalized.media_key).delete();
  return true;
}

export async function loadLiveTrackingCache(_unusedDb, { includeCompleted = false } = {}) {
  let query = db.collection("liveTrackingCache").orderBy("updatedAt", "desc");
  const snapshot = await query.get();
  return snapshot.docs
    .map((doc) => {
      const data = doc.data() || {};
      return {
        session_id: doc.id,
        title: data.title || "",
        source_platform: data.sourcePlatform || "",
        last_progress: Number(data.lastProgress || 0),
        updated_at: Number(data.updatedAt || 0),
        completed_at: data.completedAt ?? null,
        payload_json: JSON.stringify(data.payload || {}),
      };
    })
    .filter((row) => includeCompleted || row.completed_at == null);
}

export async function upsertLiveTrackingCache(_unusedDb, rows = []) {
  if (!rows.length) return;
  const batch = db.batch();
  for (const row of rows) {
    const ref = db.collection("liveTrackingCache").doc(String(row.session_id));
    batch.set(
      ref,
      {
        title: row.title,
        sourcePlatform: row.source_platform,
        lastProgress: Number(row.last_progress || 0),
        updatedAt: Number(row.updated_at || Date.now()),
        completedAt: row.completed_at == null ? null : Number(row.completed_at),
        payload: JSON.parse(row.payload_json || "{}"),
        expireAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
      },
      { merge: true },
    );
  }
  await batch.commit();
}

export async function markLiveTrackingComplete(_unusedDb, sessionId, completedAt = Date.now()) {
  if (!sessionId) return;
  await db.collection("liveTrackingCache").doc(String(sessionId)).set(
    {
      completedAt: Number(completedAt),
      updatedAt: Number(completedAt),
    },
    { merge: true },
  );
}

export async function deleteLiveTrackingCacheRows(_unusedDb, sessionIds = []) {
  const ids = sessionIds.map((sessionId) => cleanString(sessionId)).filter(Boolean);
  if (!ids.length) return;
  const batch = db.batch();
  ids.forEach((id) => batch.delete(db.collection("liveTrackingCache").doc(id)));
  await batch.commit();
}

export async function purgeCompletedLiveTrackingCache(_unusedDb, olderThan = Date.now() - 24 * 60 * 60 * 1000) {
  const snapshot = await db.collection("liveTrackingCache").get();
  const batch = db.batch();
  let count = 0;
  snapshot.docs.forEach((doc) => {
    const data = doc.data() || {};
    if (data.completedAt != null && Number(data.updatedAt || 0) < olderThan) {
      batch.delete(doc.ref);
      count += 1;
    }
  });
  if (count) await batch.commit();
}

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

function dedupeHistory(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = historyDedupeKey(row);
    
    if (map.has(key)) {
      const existing = map.get(key);
      if (!existing.playHistory) {
        existing.playHistory = [existing.watched_at];
      }
      existing.playHistory.push(row.watched_at);
      if (!existing.poster_url && row.poster_url) existing.poster_url = row.poster_url;
      if (row.watched_at > existing.watched_at) {
        const playHistory = existing.playHistory;
        map.set(key, { ...row, playHistory });
      }
    } else {
      map.set(key, {
        ...row,
        playHistory: [row.watched_at]
      });
    }
  }

  const result = [...map.values()];
  for (const row of result) {
    if (row.playHistory) {
      row.playHistory.sort((a, b) => a.localeCompare(b));
    }
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
    return `movie|${title ? `title:${title}` : imdb ? `imdb:${imdb}` : tmdb ? `tmdb:${tmdb}` : `tvdb:${tvdb}`}`;
  }

  return `${mediaType || "unknown"}|${canonicalTitleKey(row.title)}|${row.watched_at || ""}`;
}

export async function queryWatchHistory(_unusedDb, { search = "", limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.min(Number(limit) || 50, MAX_HISTORY_LIMIT);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const rows = await loadHistoryRows({ limit: MAX_HISTORY_LIMIT, offset: 0 });
  const filtered = rows.filter((row) => isPlembfinTrackedWatchRow(row) && matchesSearch(row, cleanString(search)));
  return dedupeHistory(filtered).slice(safeOffset, safeOffset + safeLimit);
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
    return dispatchStatus !== "success" && dispatchStatus !== "skipped";
  });

  return filtered.slice(0, safeLimit);
}

export async function getWatchStats() {
  const marker = await HISTORY_CACHE_DOC.get().catch(() => null);
  const version = marker?.data()?.version || 0;
  const cached = await STATS_CACHE_DOC.get().catch(() => null);
  if (
    cached?.exists &&
    cached.data()?.version === version &&
    cached.data()?.visibilityVersion === HISTORY_VISIBILITY_CACHE_VERSION &&
    cached.data()?.stats
  ) {
    return cached.data().stats;
  }

  const rows = (await loadHistoryRows({ limit: MAX_HISTORY_LIMIT, offset: 0 })).filter(isPlembfinTrackedWatchRow);
  const movieKeys = new Set();
  let episodes = 0;
  const bySource = new Map();
  const byShow = new Map();
  const byMonth = new Map();

  for (const row of rows) {
    const source = normalizePlatformSource(row.source);
    bySource.set(source, (bySource.get(source) || 0) + 1);
    const month = String(row.watched_at || "").slice(0, 7) || "unknown";
    byMonth.set(month, (byMonth.get(month) || 0) + 1);
    if (row.media_type === "movie") {
      movieKeys.add(row.imdb_id || row.tmdb_id || row.tvdb_id || row.title);
    } else if (row.media_type === "episode") {
      episodes += 1;
      const show = showTitleFrom(row.title);
      byShow.set(show, (byShow.get(show) || 0) + 1);
    }
  }

  const sourceBreakdown = [...bySource.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count);
  const monthlyActivity = [...byMonth.entries()].map(([month, count]) => ({ month, count })).sort((a, b) => a.month.localeCompare(b.month));
  const topShows = [...byShow.entries()].map(([title, count]) => ({ title, count })).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)).slice(0, 5);

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
    monthlyActivity: monthlyActivity.slice(-12),
  };
  await STATS_CACHE_DOC.set({ version, visibilityVersion: HISTORY_VISIBILITY_CACHE_VERSION, stats, updatedAt: FieldValue.serverTimestamp() }).catch(() => null);
  return stats;
}

export async function getWatchRecordByIdLight(id) {
  const doc = await db.collection("watchHistory").doc(String(id)).get();
  if (!doc.exists) return null;
  return fromFirestoreWatch(doc);
}

export async function getWatchRecordById(id) {
  const doc = await db.collection("watchHistory").doc(String(id)).get();
  if (!doc.exists) return null;
  const row = fromFirestoreWatch(doc);
  if (row.media_key) {
    const allRows = await getCachedHistory();
    const matches = allRows.filter(r => r.media_key === row.media_key && isPlembfinTrackedWatchRow(r));
    row.playHistory = matches.map(r => r.watched_at).filter(Boolean);
    row.playHistory.sort((a, b) => a.localeCompare(b));
  } else {
    row.playHistory = [row.watched_at];
  }
  return row;
}

export async function deleteWatchRecordById(id) {
  if (!id) return false;
  await db.collection("watchHistory").doc(String(id)).delete();
  await invalidateHistoryDerivedCaches();
  return true;
}

export async function deleteWatchRecord(_unusedDb, media) {
  const key = mediaKeyFor({
    title: media.title,
    type: media.type,
    imdb: media.ids?.imdb,
    tmdb: media.ids?.tmdb,
    tvdb: media.ids?.tvdb,
    season: media.season,
    episode: media.episode,
  });
  const snapshot = await db.collection("watchHistory").where("mediaKey", "==", key).get();
  if (snapshot.empty) return false;
  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  await invalidateHistoryDerivedCaches();
  return true;
}

export function requireDb() {
  return db;
}

export async function queryMovies({ search = "", sort = "watched_desc", limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.min(Number(limit) || 100, 5000);
  const safeOffset = Number(offset) || 0;
  
  const allRows = await getCachedHistory();
  const movies = allRows.filter((row) => row.media_type === "movie" && isPlembfinTrackedWatchRow(row));
  
  const filtered = movies.filter((row) => matchesSearch(row, search));
  const deduped = dedupeHistory(filtered);
  const sorted = sortRows(deduped, sort);
  return sorted.slice(safeOffset, safeOffset + safeLimit);
}

async function buildShowGroups(search = "") {
  const rows = dedupeHistory((await loadHistoryRowsByType({ mediaType: "episode", limit: MAX_HISTORY_LIMIT })).filter((row) => matchesSearch(row, search)));
  const groups = new Map();
  rows.forEach((row) => {
    const title = showTitleFrom(row.title);
    const group = groups.get(title) || {
      title,
      episode_count: 0,
      season_count: 0,
      latest_watched_at: row.watched_at,
      earliest_watched_at: row.watched_at,
      episodes: [],
      seasons: new Set(),
    };
    group.episode_count += 1;
    if (row.season != null) group.seasons.add(row.season);
    if (row.watched_at > group.latest_watched_at) group.latest_watched_at = row.watched_at;
    if (row.watched_at < group.earliest_watched_at) group.earliest_watched_at = row.watched_at;
    group.episodes.push({ ...row, show_title: title });
    groups.set(title, group);
  });
  return [...groups.values()].map((group) => ({
    ...group,
    season_count: group.seasons.size,
    seasons: undefined,
    episodes: group.episodes.sort((a, b) => Number(a.season || 0) - Number(b.season || 0) || Number(a.episode || 0) - Number(b.episode || 0)),
  }));
}

async function rebuildShowSummaryCache(version) {
  const groups = await buildShowGroups("");
  let staleSnapshot = await SHOW_SUMMARY_CACHE.limit(500).get();
  while (!staleSnapshot.empty) {
    const deleteBatch = db.batch();
    staleSnapshot.docs.forEach((doc) => deleteBatch.delete(doc.ref));
    await deleteBatch.commit();
    staleSnapshot = await SHOW_SUMMARY_CACHE.limit(500).get();
  }

  let batch = db.batch();
  let writes = 0;
  for (const group of groups) {
    const ref = SHOW_SUMMARY_CACHE.doc(canonicalTitleKey(group.title) || normalizeKeyPart(group.title));
    batch.set(ref, {
      version,
      title: group.title,
      titleLower: group.title.toLowerCase(),
      episodeCount: group.episode_count,
      seasonCount: group.season_count,
      latestWatchedAt: group.latest_watched_at,
      earliestWatchedAt: group.earliest_watched_at,
      episodes: group.episodes,
      updatedAt: FieldValue.serverTimestamp(),
    });
    writes += 1;
    if (writes % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (writes % 400 !== 0) await batch.commit();
  await SHOWS_CACHE_META_DOC.set({ version, visibilityVersion: HISTORY_VISIBILITY_CACHE_VERSION, stale: false, count: groups.length, updatedAt: FieldValue.serverTimestamp() });
  return groups.length;
}

async function ensureShowSummaryCache() {
  const marker = await HISTORY_CACHE_DOC.get().catch(() => null);
  const version = marker?.data()?.version || 0;
  const meta = await SHOWS_CACHE_META_DOC.get().catch(() => null);
  if (
    !meta?.exists ||
    meta.data()?.stale ||
    meta.data()?.version !== version ||
    meta.data()?.visibilityVersion !== HISTORY_VISIBILITY_CACHE_VERSION
  ) {
    await rebuildShowSummaryCache(version);
  }
  return `${version}:${HISTORY_VISIBILITY_CACHE_VERSION}`;
}

function showSummaryFromCache(doc) {
  const data = doc.data() || {};
  return {
    title: data.title || "",
    episode_count: Number(data.episodeCount || 0),
    season_count: Number(data.seasonCount || 0),
    latest_watched_at: data.latestWatchedAt || "",
    earliest_watched_at: data.earliestWatchedAt || "",
    episodes: Array.isArray(data.episodes) ? data.episodes : [],
  };
}

export async function queryShows({ search = "", sort = "watched_desc", limit = 6, offset = 0 } = {}) {
  const safeLimit = Math.min(Number(limit) || 6, 60);
  const safeOffset = Number(offset) || 0;
  
  const allShows = await getCachedShows();
  const needle = cleanString(search).toLowerCase();
  
  const filtered = allShows.filter((show) => {
    if (!needle) return true;
    if (show.title.toLowerCase().includes(needle)) return true;
    return show.episodes.some((ep) => {
      const haystack = [ep.title, ep.source, ep.imdb_id, ep.tmdb_id, ep.tvdb_id, ep.sync_dispatch_telemetry].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  });
  
  const sorted = sortShowRows(filtered, sort);
  return sorted.slice(safeOffset, safeOffset + safeLimit);
}

export async function listWatchRowsForReplay({ limit = 25, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return loadHistoryRows({ limit: safeLimit, offset: Math.max(Number(offset) || 0, 0) });
}

export async function listPlaybackProgressRowsForReplay({ limit = 25, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const snapshot = await db.collection("playbackProgress").orderBy("updatedAt", "desc").offset(safeOffset).limit(safeLimit).get();
  return snapshot.docs.map(playbackProgressFromFirestore);
}

export async function countPlaybackProgressRows() {
  const snapshot = await db.collection("playbackProgress").count().get();
  return snapshot.data().count || 0;
}

export async function countWatchHistoryRows() {
  const snapshot = await db.collection("watchHistory").count().get();
  return snapshot.data().count || 0;
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
