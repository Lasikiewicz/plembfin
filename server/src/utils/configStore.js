import { db, parseJson, toJson } from "../db.js";

const SETTINGS_ID = "mediaConfig";
const RUNTIME_ID = "main";

function trimTrailingSlash(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function envEnabled(name) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") return undefined;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function envMediaConfig() {
  const plexEnabled = envEnabled("PLEX_ENABLED");
  const embyEnabled = envEnabled("EMBY_ENABLED");
  const jellyfinEnabled = envEnabled("JELLYFIN_ENABLED");

  return normalizeStoredConfig({
    plex: {
      baseUrl: envValue("PLEX_SERVER_URL", "PLEX_BASE_URL", "PLEX_URL"),
      token: envValue("PLEX_TOKEN", "PLEX_API_KEY"),
      username: envValue("PLEX_USERNAME"),
      disabled: plexEnabled === undefined ? false : !plexEnabled,
    },
    emby: {
      baseUrl: envValue("EMBY_SERVER_URL", "EMBY_BASE_URL", "EMBY_URL"),
      apiKey: envValue("EMBY_API_KEY"),
      userId: envValue("EMBY_USER_ID"),
      disabled: embyEnabled === undefined ? false : !embyEnabled,
    },
    jellyfin: {
      baseUrl: envValue("JELLYFIN_SERVER_URL", "JELLYFIN_BASE_URL", "JELLYFIN_URL"),
      apiKey: envValue("JELLYFIN_API_KEY"),
      userId: envValue("JELLYFIN_USER_ID"),
      disabled: jellyfinEnabled === undefined ? false : !jellyfinEnabled,
    },
    tmdb: {
      apiKey: envValue("TMDB_API_KEY", "TMDB_KEY"),
    },
    youtube: {
      apiKey: envValue("YOUTUBE_API_KEY", "YOUTUBE_DATA_API_KEY"),
    },
  });
}

function hasConfiguredFields(section = {}) {
  return Object.entries(section).some(([key, value]) => key !== "disabled" && String(value || "").trim() !== "");
}

function mergeEnvDefaults(stored = {}) {
  const normalized = normalizeStoredConfig(stored);
  const defaults = envMediaConfig();
  const merged = {};

  for (const section of ["plex", "emby", "jellyfin", "tmdb", "youtube"]) {
    merged[section] = { ...defaults[section], ...normalized[section] };
    for (const [key, value] of Object.entries(defaults[section])) {
      if (key === "disabled") continue;
      if (!String(merged[section][key] || "").trim() && String(value || "").trim()) {
        merged[section][key] = value;
      }
    }
  }

  for (const section of ["plex", "emby", "jellyfin"]) {
    if (hasConfiguredFields(normalized[section])) {
      merged[section].disabled = normalized[section].disabled;
    } else {
      merged[section].disabled = defaults[section].disabled;
    }
  }

  return normalizeStoredConfig(merged);
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
  return mergeEnvDefaults(parseJson(row?.data, {}) || {});
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
  
  // Merge incoming sections with existing sections
  const merged = {
    plex: config.plex ? { ...existing.plex, ...config.plex } : existing.plex,
    emby: config.emby ? { ...existing.emby, ...config.emby } : existing.emby,
    jellyfin: config.jellyfin ? { ...existing.jellyfin, ...config.jellyfin } : existing.jellyfin,
    tmdb: config.tmdb ? { ...existing.tmdb, ...config.tmdb } : existing.tmdb,
    youtube: config.youtube ? { ...existing.youtube, ...config.youtube } : existing.youtube,
  };
  
  const normalized = normalizeStoredConfig(merged);
  upsertSettingsStmt.run(SETTINGS_ID, toJson(normalized), Date.now());
}

export function validateConfig(config = {}) {
  const errors = [];

  if (config.plex) {
    const plexEnabled = !config.plex.disabled;
    if (plexEnabled) {
      if (!config.plex.baseUrl) errors.push("plex.baseUrl is required when Plex is enabled");
      if (!config.plex.token) errors.push("plex.token is required when Plex is enabled");
      if (!config.plex.username) errors.push("plex.username is required when Plex is enabled");
    }
  }

  if (config.emby) {
    const embyEnabled = !config.emby.disabled;
    if (embyEnabled) {
      if (!config.emby.baseUrl) errors.push("emby.baseUrl is required when Emby is enabled");
      if (!config.emby.apiKey) errors.push("emby.apiKey is required when Emby is enabled");
      if (!config.emby.userId) errors.push("emby.userId is required when Emby is enabled");
    }
  }

  if (config.jellyfin) {
    const jellyfinEnabled = !config.jellyfin.disabled;
    if (jellyfinEnabled) {
      if (!config.jellyfin.baseUrl) errors.push("jellyfin.baseUrl is required when Jellyfin is enabled");
      if (!config.jellyfin.apiKey) errors.push("jellyfin.apiKey is required when Jellyfin is enabled");
      if (!config.jellyfin.userId) errors.push("jellyfin.userId is required when Jellyfin is enabled");
    }
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
