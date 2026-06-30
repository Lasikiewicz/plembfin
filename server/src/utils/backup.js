import { bumpDataVersion, db, parseJson, toJson } from "../db.js";

export const BACKUP_FORMAT = "plembfin-backup";
export const BACKUP_VERSION = 1;
export const BACKUP_COLLECTIONS = [
  "watchHistory",
  "playstate",
  "playbackProgress",
  "activeSessions",
  "liveTrackingCache",
  "syncHistory",
  "settings",
  "runtimeState",
  "loopKeys",
];

function portableValue(value) {
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Date) return { __plembfinType: "timestamp", value: value.getTime() };
  if (Array.isArray(value)) return value.map(portableValue);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portableValue(item)]));
}

function reviveValue(value) {
  if (value == null || typeof value !== "object") return value;
  if (value.__plembfinType === "timestamp") return Number(value.value);
  if (Array.isArray(value)) return value.map(reviveValue);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviveValue(item)]));
}

function toMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object") {
    if (value.__plembfinType === "timestamp") return toMs(value.value);
    if (typeof value._seconds === "number") return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1e6);
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function ids(row) {
  return {
    imdb: row.imdb_id || null,
    tmdb: row.tmdb_id || null,
    tvdb: row.tvdb_id || null,
  };
}

const collections = {
  watchHistory: {
    table: "watch_history",
    key: "id",
    rowToData: (row) => ({
      title: row.title || "",
      titleLower: row.title_lower || "",
      mediaType: row.media_type || "",
      watchedAt: row.watched_at || "",
      source: row.source || "",
      ids: ids(row),
      season: row.season,
      episode: row.episode,
      posterUrl: row.poster_url,
      logoUrl: row.logo_url,
      backdropUrl: row.backdrop_url,
      youtubeUrl: row.youtube_url,
      syncAction: row.sync_action,
      syncDispatchTelemetry: row.sync_dispatch_telemetry,
      mediaKey: row.media_key,
      showTitle: row.show_title,
      showTitleLower: row.show_title_lower,
      episodeTitle: row.episode_title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
    insert: db.prepare(`INSERT OR REPLACE INTO watch_history
      (id,title,title_lower,media_type,watched_at,source,imdb_id,tmdb_id,tvdb_id,season,episode,poster_url,logo_url,backdrop_url,youtube_url,sync_action,sync_dispatch_telemetry,media_key,show_title,show_title_lower,episode_title,created_at,updated_at)
      VALUES (@id,@title,@title_lower,@media_type,@watched_at,@source,@imdb_id,@tmdb_id,@tvdb_id,@season,@episode,@poster_url,@logo_url,@backdrop_url,@youtube_url,@sync_action,@sync_dispatch_telemetry,@media_key,@show_title,@show_title_lower,@episode_title,@created_at,@updated_at)`),
    dataToRow: (id, d) => ({
      id, title: d.title || "", title_lower: d.titleLower || String(d.title || "").toLowerCase(),
      media_type: d.mediaType || "", watched_at: d.watchedAt || "", source: d.source || "",
      imdb_id: d.ids?.imdb || null, tmdb_id: d.ids?.tmdb || d.tmdbId || null, tvdb_id: d.ids?.tvdb || null,
      season: d.season ?? null, episode: d.episode ?? null, poster_url: d.posterUrl || null, logo_url: d.logoUrl || null, backdrop_url: d.backdropUrl || null, youtube_url: d.youtubeUrl || null,
      sync_action: d.syncAction || "watched", sync_dispatch_telemetry: d.syncDispatchTelemetry || null,
      media_key: d.mediaKey || null, show_title: d.showTitle || null, show_title_lower: d.showTitleLower || null,
      episode_title: d.episodeTitle || null, created_at: toMs(d.createdAt), updated_at: toMs(d.updatedAt),
    }),
  },
  playstate: {
    table: "playstate", key: "media_key",
    rowToData: (r) => ({ mediaKey: r.media_key, title: r.title || "", titleLower: r.title_lower || "", mediaType: r.media_type || "", state: r.state || "watched", watchedAt: r.watched_at || "", lastSource: r.last_source || "", sources: parseJson(r.sources, []), ids: ids(r), season: r.season, episode: r.episode, posterUrl: r.poster_url, updatedAt: r.updated_at }),
    insert: db.prepare("INSERT OR REPLACE INTO playstate (media_key,title,title_lower,media_type,state,watched_at,last_source,sources,imdb_id,tmdb_id,tvdb_id,season,episode,poster_url,updated_at) VALUES (@media_key,@title,@title_lower,@media_type,@state,@watched_at,@last_source,@sources,@imdb_id,@tmdb_id,@tvdb_id,@season,@episode,@poster_url,@updated_at)"),
    dataToRow: (id, d) => ({ media_key: d.mediaKey || id, title: d.title || "", title_lower: d.titleLower || String(d.title || "").toLowerCase(), media_type: d.mediaType || "", state: d.state || "watched", watched_at: d.watchedAt || "", last_source: d.lastSource || d.source || "", sources: toJson(Array.isArray(d.sources) ? d.sources : []), imdb_id: d.ids?.imdb || null, tmdb_id: d.ids?.tmdb || null, tvdb_id: d.ids?.tvdb || null, season: d.season ?? null, episode: d.episode ?? null, poster_url: d.posterUrl || null, updated_at: toMs(d.updatedAt) }),
  },
  playbackProgress: {
    table: "playback_progress", key: "media_key",
    rowToData: (r) => ({ mediaKey: r.media_key, title: r.title || "", mediaType: r.media_type || "", source: r.source || "", ids: ids(r), season: r.season, episode: r.episode, positionMs: r.position_ms, durationMs: r.duration_ms, progress: r.progress, updatedAt: r.updated_at, syncDispatchTelemetry: r.sync_dispatch_telemetry }),
    insert: db.prepare("INSERT OR REPLACE INTO playback_progress (media_key,title,media_type,source,imdb_id,tmdb_id,tvdb_id,season,episode,position_ms,duration_ms,progress,updated_at,sync_dispatch_telemetry) VALUES (@media_key,@title,@media_type,@source,@imdb_id,@tmdb_id,@tvdb_id,@season,@episode,@position_ms,@duration_ms,@progress,@updated_at,@sync_dispatch_telemetry)"),
    dataToRow: (id, d) => ({ media_key: d.mediaKey || id, title: d.title || "", media_type: d.mediaType || "", source: d.source || "", imdb_id: d.ids?.imdb || null, tmdb_id: d.ids?.tmdb || null, tvdb_id: d.ids?.tvdb || null, season: d.season ?? null, episode: d.episode ?? null, position_ms: d.positionMs ?? 0, duration_ms: d.durationMs ?? null, progress: d.progress ?? 0, updated_at: toMs(d.updatedAt) ?? Date.now(), sync_dispatch_telemetry: d.syncDispatchTelemetry || null }),
  },
  activeSessions: {
    table: "active_sessions", key: "id",
    rowToData: (r) => ({ title: r.title || "", mediaType: r.media_type || "", source: r.source || "", progress: r.progress, offsetMs: r.offset_ms, durationMs: r.duration_ms, season: r.season, episode: r.episode, posterUrl: r.poster_url, ids: parseJson(r.ids, {}), event: r.event, client: parseJson(r.client, {}), updatedAt: r.updated_at, expireAt: r.expire_at }),
    insert: db.prepare("INSERT OR REPLACE INTO active_sessions (id,title,media_type,source,progress,offset_ms,duration_ms,season,episode,poster_url,ids,event,client,updated_at,expire_at) VALUES (@id,@title,@media_type,@source,@progress,@offset_ms,@duration_ms,@season,@episode,@poster_url,@ids,@event,@client,@updated_at,@expire_at)"),
    dataToRow: (id, d) => ({ id, title: d.title || "", media_type: d.mediaType || "", source: d.source || "", progress: d.progress ?? 0, offset_ms: d.offsetMs ?? 0, duration_ms: d.durationMs ?? null, season: d.season ?? null, episode: d.episode ?? null, poster_url: d.posterUrl || null, ids: toJson(d.ids || {}), event: d.event || null, client: toJson(d.client || {}), updated_at: toMs(d.updatedAt) ?? Date.now(), expire_at: toMs(d.expireAt) }),
  },
  liveTrackingCache: {
    table: "live_tracking_cache", key: "session_id",
    rowToData: (r) => ({ title: r.title || "", sourcePlatform: r.source_platform || "", lastProgress: r.last_progress, updatedAt: r.updated_at, completedAt: r.completed_at, payload: parseJson(r.payload, {}), expireAt: r.expire_at }),
    insert: db.prepare("INSERT OR REPLACE INTO live_tracking_cache (session_id,title,source_platform,last_progress,updated_at,completed_at,payload,expire_at) VALUES (@session_id,@title,@source_platform,@last_progress,@updated_at,@completed_at,@payload,@expire_at)"),
    dataToRow: (id, d) => ({ session_id: id, title: d.title || "", source_platform: d.sourcePlatform || "", last_progress: d.lastProgress ?? 0, updated_at: toMs(d.updatedAt) ?? Date.now(), completed_at: toMs(d.completedAt), payload: toJson(d.payload || {}), expire_at: toMs(d.expireAt) }),
  },
  syncHistory: {
    table: "sync_history", key: "id", numericKey: true,
    rowToData: (r) => ({ timestamp: r.timestamp, mediaType: r.media_type || "unknown", title: r.title || "", source: r.source || "unknown", status: r.status || "unknown", details: r.details || "", action: r.action || "watched", targetStates: parseJson(r.target_states, []), rawPayloadDebug: parseJson(r.raw_payload_debug, {}), createdAt: r.created_at }),
    insert: db.prepare("INSERT INTO sync_history (timestamp,media_type,title,source,status,details,action,target_states,raw_payload_debug,created_at) VALUES (@timestamp,@media_type,@title,@source,@status,@details,@action,@target_states,@raw_payload_debug,@created_at)"),
    dataToRow: (_id, d) => ({ timestamp: toMs(d.timestamp) ?? Date.now(), media_type: d.mediaType || "unknown", title: d.title || "", source: d.source || "unknown", status: d.status || "unknown", details: d.details || "", action: d.action || "watched", target_states: toJson(Array.isArray(d.targetStates) ? d.targetStates : []), raw_payload_debug: toJson(d.rawPayloadDebug || {}), created_at: toMs(d.createdAt) ?? Date.now() }),
  },
  settings: jsonCollection("settings"),
  runtimeState: jsonCollection("runtime_state"),
  loopKeys: simpleCollection("loop_keys", "id", (r) => ({ key: r.key || "", value: r.value || "", createdAt: r.created_at, expireAt: r.expire_at }), "INSERT OR REPLACE INTO loop_keys (id,key,value,created_at,expire_at) VALUES (@id,@key,@value,@created_at,@expire_at)", (id, d) => ({ id, key: d.key || "", value: d.value || "", created_at: toMs(d.createdAt), expire_at: toMs(d.expireAt) })),
  posterCache: simpleCollection("poster_cache", "id", (r) => ({ mediaKey: r.media_key, variant: r.variant, status: r.status, source: r.source, detail: r.detail, originalUrl: r.original_url, storagePath: r.storage_path, contentType: r.content_type, sizeBytes: r.size_bytes, url: r.url, updatedAtMs: r.updated_at_ms }), "INSERT OR REPLACE INTO poster_cache (id,media_key,variant,status,source,detail,original_url,storage_path,content_type,size_bytes,url,updated_at_ms) VALUES (@id,@media_key,@variant,@status,@source,@detail,@original_url,@storage_path,@content_type,@size_bytes,@url,@updated_at_ms)", (id, d) => ({ id, media_key: d.mediaKey || null, variant: d.variant || "poster", status: d.status || "missing", source: d.source || "unknown", detail: d.detail || null, original_url: d.originalUrl || null, storage_path: d.storagePath || null, content_type: d.contentType || null, size_bytes: d.sizeBytes ?? null, url: d.url || null, updated_at_ms: d.updatedAtMs ?? toMs(d.updatedAt) })),
  tmdbMetadataCache: simpleCollection("tmdb_metadata_cache", "id", (r) => ({ tmdbId: r.tmdb_id, mediaType: r.media_type, title: r.title, details: parseJson(r.details), schemaVersion: r.schema_version, updatedAtMs: r.updated_at_ms }), "INSERT OR REPLACE INTO tmdb_metadata_cache (id,tmdb_id,media_type,title,details,schema_version,updated_at_ms) VALUES (@id,@tmdb_id,@media_type,@title,@details,@schema_version,@updated_at_ms)", (id, d) => ({ id, tmdb_id: d.tmdbId != null ? String(d.tmdbId) : null, media_type: d.mediaType || null, title: d.title || null, details: d.details == null ? null : toJson(d.details), schema_version: d.schemaVersion ?? null, updated_at_ms: d.updatedAtMs ?? toMs(d.updatedAt) })),
  tmdbSearchCache: simpleCollection("tmdb_search_cache", "id", (r) => ({ query: r.query, mediaType: r.media_type, page: r.page, response: parseJson(r.response), missing: Boolean(r.missing), updatedAtMs: r.updated_at_ms }), "INSERT OR REPLACE INTO tmdb_search_cache (id,query,media_type,page,response,missing,updated_at_ms) VALUES (@id,@query,@media_type,@page,@response,@missing,@updated_at_ms)", (id, d) => ({ id, query: d.query || "", media_type: d.mediaType || null, page: d.page ?? 1, response: toJson(d.response), missing: d.missing ? 1 : 0, updated_at_ms: d.updatedAtMs ?? toMs(d.updatedAt) })),
  tmdbSeasonCache: simpleCollection("tmdb_season_cache", "id", (r) => ({ tmdbId: r.tmdb_id, seasonNumber: r.season_number, showStatus: r.show_status, details: parseJson(r.details), updatedAtMs: r.updated_at_ms }), "INSERT OR REPLACE INTO tmdb_season_cache (id,tmdb_id,season_number,show_status,details,updated_at_ms) VALUES (@id,@tmdb_id,@season_number,@show_status,@details,@updated_at_ms)", (id, d) => ({ id, tmdb_id: d.tmdbId != null ? String(d.tmdbId) : null, season_number: d.seasonNumber ?? null, show_status: d.showStatus || null, details: toJson(d.details), updated_at_ms: d.updatedAtMs ?? toMs(d.updatedAt) })),
  tmdbPersonCache: simpleCollection("tmdb_person_cache", "id", (r) => ({ personId: r.person_id, details: parseJson(r.details), schemaVersion: r.schema_version, updatedAtMs: r.updated_at_ms }), "INSERT OR REPLACE INTO tmdb_person_cache (id,person_id,details,schema_version,updated_at_ms) VALUES (@id,@person_id,@details,@schema_version,@updated_at_ms)", (id, d) => ({ id, person_id: d.personId != null ? String(d.personId) : null, details: toJson(d.details), schema_version: d.schemaVersion ?? null, updated_at_ms: d.updatedAtMs ?? toMs(d.updatedAt) })),
};

function simpleCollection(table, key, rowToData, sql, dataToRow) {
  return { table, key, rowToData, insert: db.prepare(sql), dataToRow };
}

function jsonCollection(table) {
  return {
    table, key: "id",
    rowToData: (row) => parseJson(row.data, {}),
    insert: db.prepare(`INSERT OR REPLACE INTO ${table} (id,data,updated_at) VALUES (@id,@data,@updated_at)`),
    dataToRow: (id, data) => ({ id, data: toJson(data), updated_at: Date.now() }),
  };
}

export function backupManifest(origin = "") {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    source: { app: "plembfin", storage: "sqlite", origin },
    collections: BACKUP_COLLECTIONS,
    notes: [
      "This backup can contain media-server URLs, usernames, tokens, and API keys.",
      "Artwork binaries, poster cache rows, and TMDB metadata cache rows are not included.",
    ],
  };
}

export function getFullBackup(origin = "") {
  const backup = backupManifest(origin);
  backup.collections = {};
  for (const name of BACKUP_COLLECTIONS) {
    const config = collections[name];
    if (!config) continue;
    const rows = db.prepare(`SELECT * FROM ${config.table} ORDER BY ${config.key}`).all();
    backup.collections[name] = rows.map((row) => ({
      id: String(row[config.key]),
      data: portableValue(config.rowToData(row)),
    }));
  }
  return backup;
}

export function exportCollectionPage(name, { cursor = "", limit = 250 } = {}) {
  const config = collections[name];
  if (!config) throw new Error(`Unknown backup collection: ${name}`);
  const pageLimit = Math.max(1, Math.min(Number(limit) || 250, 500));
  const comparator = config.numericKey ? Number(cursor) || 0 : String(cursor || "");
  const rows = cursor
    ? db.prepare(`SELECT * FROM ${config.table} WHERE ${config.key} > ? ORDER BY ${config.key} LIMIT ?`).all(comparator, pageLimit)
    : db.prepare(`SELECT * FROM ${config.table} ORDER BY ${config.key} LIMIT ?`).all(pageLimit);
  const documents = rows.map((row) => ({ id: String(row[config.key]), data: portableValue(config.rowToData(row)) }));
  return {
    collection: name,
    documents,
    nextCursor: rows.length === pageLimit ? String(rows.at(-1)[config.key]) : "",
    hasMore: rows.length === pageLimit,
  };
}

export function importCollectionBatch(name, documents, { reset = false } = {}) {
  const config = collections[name];
  if (!config) throw new Error(`Unknown backup collection: ${name}`);
  if (!Array.isArray(documents)) throw new Error("Backup documents must be an array");
  if (documents.length > 250) throw new Error("Backup import batches are limited to 250 documents");

  const run = db.transaction(() => {
    if (reset) db.prepare(`DELETE FROM ${config.table}`).run();
    for (const document of documents) {
      const id = String(document?.id || "").trim();
      if (!id) throw new Error(`A ${name} document is missing its id`);
      const data = reviveValue(document.data || {});
      config.insert.run(config.dataToRow(id, data));
    }
  });
  run();

  if (["watchHistory", "playstate", "playbackProgress"].includes(name)) bumpDataVersion();
  return { collection: name, imported: documents.length, reset: Boolean(reset) };
}
