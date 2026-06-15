import { db, parseJson, toJson } from "../db.js";

const SETTINGS_ID = "mediaConfig";
const RUNTIME_ID = "main";

function trimTrailingSlash(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function normalizeStoredConfig(stored = {}) {
  return {
    plex: {
      baseUrl: trimTrailingSlash(stored.plex?.baseUrl || stored.plex?.url || ""),
      token: String(stored.plex?.token || stored.plex?.apiKey || "").trim(),
      username: String(stored.plex?.username || "").trim(),
      disabled: Boolean(stored.plex?.disabled),
    },
    emby: {
      baseUrl: trimTrailingSlash(stored.emby?.baseUrl || stored.emby?.url || ""),
      apiKey: String(stored.emby?.apiKey || stored.emby?.api_key || "").trim(),
      userId: String(stored.emby?.userId || "").trim(),
      disabled: Boolean(stored.emby?.disabled),
    },
    jellyfin: {
      baseUrl: trimTrailingSlash(stored.jellyfin?.baseUrl || stored.jellyfin?.url || ""),
      apiKey: String(stored.jellyfin?.apiKey || stored.jellyfin?.api_key || "").trim(),
      userId: String(stored.jellyfin?.userId || "").trim(),
      disabled: Boolean(stored.jellyfin?.disabled),
    },
    tmdb: {
      apiKey: String(stored.tmdb?.apiKey || stored.tmdbApiKey || "").trim(),
    },
    youtube: {
      apiKey: String(stored.youtube?.apiKey || "").trim(),
    },
  };
}

const selectSettingsStmt = db.prepare("SELECT data FROM settings WHERE id = ?");
const upsertSettingsStmt = db.prepare(
  `INSERT INTO settings (id, data, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
);

export async function loadMediaConfig() {
  const row = selectSettingsStmt.get(SETTINGS_ID);
  return normalizeStoredConfig(parseJson(row?.data, {}) || {});
}

export function publicMediaConfig(config = {}) {
  const normalized = normalizeStoredConfig(config);
  return {
    ...normalized,
    tmdb: { configured: Boolean(normalized.tmdb.apiKey) },
  };
}

export async function saveMediaConfig(config) {
  const existing = await loadMediaConfig().catch(() => normalizeStoredConfig({}));
  const normalized = normalizeStoredConfig(config);
  if (!normalized.tmdb.apiKey) normalized.tmdb.apiKey = existing.tmdb.apiKey;
  // Merge with existing so partial saves preserve untouched sections.
  const merged = { ...existing, ...normalized };
  upsertSettingsStmt.run(SETTINGS_ID, toJson(merged), Date.now());
}

export function validateConfig(config = {}) {
  const errors = [];
  let enabledCount = 0;

  const plexEnabled = !config?.plex?.disabled;
  const embyEnabled = !config?.emby?.disabled;
  const jellyfinEnabled = !config?.jellyfin?.disabled;

  if (plexEnabled) {
    enabledCount++;
    if (!config?.plex?.baseUrl) errors.push("plex.baseUrl is required when Plex is enabled");
    if (!config?.plex?.token) errors.push("plex.token is required when Plex is enabled");
    if (!config?.plex?.username) errors.push("plex.username is required when Plex is enabled");
  }

  if (embyEnabled) {
    enabledCount++;
    if (!config?.emby?.baseUrl) errors.push("emby.baseUrl is required when Emby is enabled");
    if (!config?.emby?.apiKey) errors.push("emby.apiKey is required when Emby is enabled");
    if (!config?.emby?.userId) errors.push("emby.userId is required when Emby is enabled");
  }

  if (jellyfinEnabled) {
    enabledCount++;
    if (!config?.jellyfin?.baseUrl) errors.push("jellyfin.baseUrl is required when Jellyfin is enabled");
    if (!config?.jellyfin?.apiKey) errors.push("jellyfin.apiKey is required when Jellyfin is enabled");
    if (!config?.jellyfin?.userId) errors.push("jellyfin.userId is required when Jellyfin is enabled");
  }

  if (enabledCount < 2) {
    errors.push("At least two media platforms must be enabled to sync watch states.");
  }

  return errors;
}

const selectRuntimeStmt = db.prepare("SELECT data FROM runtime_state WHERE id = ?");
const upsertRuntimeStmt = db.prepare(
  `INSERT INTO runtime_state (id, data, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
);

export async function setRuntimeState(values = {}) {
  const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
  const merged = { ...current, ...values, updatedAt: Date.now() };
  upsertRuntimeStmt.run(RUNTIME_ID, toJson(merged), Date.now());
}

export async function loadRuntimeState() {
  return parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
}

// Append items onto an array field in runtime_state (replaces FieldValue.arrayUnion).
export async function appendRuntimeLog(field, items = []) {
  const list = Array.isArray(items) ? items : [items];
  if (!list.length) return;
  const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
  const existing = Array.isArray(current[field]) ? current[field] : [];
  const merged = { ...current, [field]: [...existing, ...list], updatedAt: Date.now() };
  upsertRuntimeStmt.run(RUNTIME_ID, toJson(merged), Date.now());
}

const insertSyncHistoryStmt = db.prepare(
  `INSERT INTO sync_history (timestamp, media_type, title, source, status, details, action, target_states, raw_payload_debug, created_at)
   VALUES (@timestamp, @media_type, @title, @source, @status, @details, @action, @target_states, @raw_payload_debug, @created_at)`,
);
const selectSyncHistoryStmt = db.prepare("SELECT * FROM sync_history ORDER BY timestamp DESC LIMIT ?");

export async function appendSyncHistory(record) {
  insertSyncHistoryStmt.run({
    timestamp: Date.now(),
    media_type: record.mediaType || "unknown",
    title: record.title || "Unknown media",
    source: record.source || "unknown",
    status: record.status || "unknown",
    details: record.details || "",
    action: record.action || "watched",
    target_states: toJson(Array.isArray(record.targetStates) ? record.targetStates : []),
    raw_payload_debug: toJson(record.rawPayloadDebug || {}),
    created_at: Date.now(),
  });
}

export async function getSyncHistory(limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return selectSyncHistoryStmt.all(safeLimit).map((row) => ({
    id: String(row.id),
    timestamp: row.timestamp,
    mediaType: row.media_type,
    title: row.title,
    source: row.source,
    status: row.status,
    details: row.details,
    action: row.action,
    targetStates: parseJson(row.target_states, []),
    rawPayloadDebug: parseJson(row.raw_payload_debug, {}),
    createdAt: row.created_at,
  }));
}
