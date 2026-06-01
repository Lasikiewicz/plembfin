import { db, FieldValue, Timestamp } from "../firebase.js";
import { loadMediaConfig } from "./configStore.js";
import { fetchPosterFromTmdb } from "./tmdbClient.js";

const MAX_HISTORY_LIMIT = 25000;

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

function normalizeWatchedAt(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function normalizeKeyPart(value) {
  return String(value ?? "none").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
}

function showTitleFrom(title = "") {
  const text = cleanString(title) || "Unknown Show";
  const seasonMatch = text.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  if (seasonMatch?.[1]) return seasonMatch[1].trim() || "Unknown Show";
  const alternateMatch = text.match(/^(.*?)(?:\s+-\s+Season\s+\d+.*)$/i);
  if (alternateMatch?.[1]) return alternateMatch[1].trim() || "Unknown Show";
  return text.split(" - ")[0].trim() || "Unknown Show";
}

function mediaKeyFor(record = {}) {
  const type = normalizeMediaType(record.media_type || record.mediaType || record.type);
  const coordinates = [normalizeKeyPart(type), normalizeKeyPart(record.season), normalizeKeyPart(record.episode)].join(":");
  if (record.imdb_id || record.imdb) return `${coordinates}:imdb:${normalizeKeyPart(record.imdb_id || record.imdb)}`;
  if (record.tmdb_id || record.tmdb) return `${coordinates}:tmdb:${normalizeKeyPart(record.tmdb_id || record.tmdb)}`;
  if (record.tvdb_id || record.tvdb) return `${coordinates}:tvdb:${normalizeKeyPart(record.tvdb_id || record.tvdb)}`;
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

  return cleanString(
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
  );
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
    syncDispatchTelemetry: record.sync_dispatch_telemetry || null,
    mediaKey,
    showTitle,
    showTitleLower: showTitle ? showTitle.toLowerCase() : null,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function fromFirestoreWatch(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    title: data.title || "",
    media_type: data.mediaType || "",
    watched_at: data.watchedAt || "",
    source: data.source || "",
    imdb_id: data.ids?.imdb || null,
    tmdb_id: data.ids?.tmdb || null,
    tvdb_id: data.ids?.tvdb || null,
    season: data.season ?? null,
    episode: data.episode ?? null,
    poster_url: data.posterUrl || null,
    sync_dispatch_telemetry: data.syncDispatchTelemetry || null,
    media_key: data.mediaKey || null,
    show_title: data.showTitle || null,
  };
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
  const snapshot = await db.collection("watchHistory").orderBy("watchedAt", "desc").offset(safeOffset).limit(safeLimit).get();
  return snapshot.docs.map(fromFirestoreWatch);
}

function matchesSearch(row, search) {
  if (!search) return true;
  const haystack = [row.title, row.source, row.imdb_id, row.tmdb_id, row.tvdb_id, row.sync_dispatch_telemetry].join(" ").toLowerCase();
  return haystack.includes(search.toLowerCase());
}

function dedupeHistory(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.media_type === "episode"
      ? `episode|${row.imdb_id || row.tmdb_id || row.tvdb_id || row.title}|${row.season ?? -1}|${row.episode ?? -1}`
      : `movie|${row.imdb_id || row.tmdb_id || row.tvdb_id || row.title}`;
    
    if (map.has(key)) {
      const existing = map.get(key);
      if (!existing.playHistory) {
        existing.playHistory = [existing.watched_at];
      }
      existing.playHistory.push(row.watched_at);
      if (row.watched_at < existing.watched_at) {
        existing.watched_at = row.watched_at;
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

export async function queryWatchHistory(_unusedDb, { search = "", limit = 50, offset = 0 } = {}) {
  const rows = await loadHistoryRows({ limit: search ? MAX_HISTORY_LIMIT : limit, offset: search ? 0 : offset });
  const filtered = rows.filter((row) => matchesSearch(row, cleanString(search)));
  return dedupeHistory(filtered).slice(0, Math.min(Number(limit) || 50, MAX_HISTORY_LIMIT));
}

export async function getWatchStats() {
  const rows = await loadHistoryRows({ limit: MAX_HISTORY_LIMIT, offset: 0 });
  const movieKeys = new Set();
  let episodes = 0;
  const bySource = new Map();
  const byShow = new Map();
  const byMonth = new Map();

  for (const row of rows) {
    bySource.set(row.source || "unknown", (bySource.get(row.source || "unknown") || 0) + 1);
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

  return {
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
}

export async function getWatchRecordById(id) {
  const doc = await db.collection("watchHistory").doc(String(id)).get();
  if (!doc.exists) return null;
  const row = fromFirestoreWatch(doc);
  if (row.media_key) {
    const snapshot = await db.collection("watchHistory")
      .where("mediaKey", "==", row.media_key)
      .orderBy("watchedAt", "asc")
      .get();
    row.playHistory = snapshot.docs.map(d => d.data().watchedAt).filter(Boolean);
  } else {
    row.playHistory = [row.watched_at];
  }
  return row;
}

export async function deleteWatchRecordById(id) {
  if (!id) return false;
  await db.collection("watchHistory").doc(String(id)).delete();
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
  return true;
}

export function requireDb() {
  return db;
}

export async function queryMovies({ search = "", sort = "watched_desc", limit = 100, offset = 0 } = {}) {
  const rows = (await loadHistoryRows({ limit: MAX_HISTORY_LIMIT })).filter((row) => row.media_type === "movie" && matchesSearch(row, search));
  const deduped = dedupeHistory(rows);
  return sortRows(deduped, sort).slice(Number(offset) || 0, (Number(offset) || 0) + Math.min(Number(limit) || 100, 5000));
}

export async function queryShows({ search = "", sort = "watched_desc", limit = 6, offset = 0 } = {}) {
  const rows = (await loadHistoryRows({ limit: MAX_HISTORY_LIMIT })).filter((row) => row.media_type === "episode" && matchesSearch(row, search));
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
  const sorted = sortShowRows([...groups.values()], sort).map((group) => ({
    ...group,
    season_count: group.seasons.size,
    seasons: undefined,
    episodes: group.episodes.sort((a, b) => Number(a.season || 0) - Number(b.season || 0) || Number(a.episode || 0) - Number(b.episode || 0)),
  }));
  return sorted.slice(Number(offset) || 0, (Number(offset) || 0) + Math.min(Number(limit) || 6, 60));
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
