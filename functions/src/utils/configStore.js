import { db, FieldValue } from "../firebase.js";

const SETTINGS_DOC = db.collection("settings").doc("mediaConfig");
const RUNTIME_DOC = db.collection("runtimeState").doc("main");
const HISTORY_COLLECTION = db.collection("syncHistory");

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

export async function loadMediaConfig() {
  const doc = await SETTINGS_DOC.get();
  return normalizeStoredConfig(doc.exists ? doc.data() : {});
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
  await SETTINGS_DOC.set(
    {
      ...normalized,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
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

export async function setRuntimeState(values = {}) {
  await RUNTIME_DOC.set({ ...values, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

export async function loadRuntimeState() {
  const doc = await RUNTIME_DOC.get();
  return doc.exists ? doc.data() : {};
}

export async function appendSyncHistory(record) {
  await HISTORY_COLLECTION.add({
    timestamp: Date.now(),
    mediaType: record.mediaType || "unknown",
    title: record.title || "Unknown media",
    source: record.source || "unknown",
    status: record.status || "unknown",
    details: record.details || "",
    action: record.action || "watched",
    targetStates: Array.isArray(record.targetStates) ? record.targetStates : [],
    rawPayloadDebug: record.rawPayloadDebug || {},
    createdAt: FieldValue.serverTimestamp(),
  });
}

export async function getSyncHistory(limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const snapshot = await HISTORY_COLLECTION.orderBy("timestamp", "desc").limit(safeLimit).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}
