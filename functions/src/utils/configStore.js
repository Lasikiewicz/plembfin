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
    },
    emby: {
      baseUrl: trimTrailingSlash(stored.emby?.baseUrl || stored.emby?.url || ""),
      apiKey: String(stored.emby?.apiKey || stored.emby?.api_key || "").trim(),
      userId: String(stored.emby?.userId || "").trim(),
    },
    jellyfin: {
      baseUrl: trimTrailingSlash(stored.jellyfin?.baseUrl || stored.jellyfin?.url || ""),
      apiKey: String(stored.jellyfin?.apiKey || stored.jellyfin?.api_key || "").trim(),
      userId: String(stored.jellyfin?.userId || "").trim(),
    },
    tmdb: {
      apiKey: String(stored.tmdb?.apiKey || stored.tmdbApiKey || "").trim(),
    },
  };
}

export async function loadMediaConfig() {
  const doc = await SETTINGS_DOC.get();
  return normalizeStoredConfig(doc.exists ? doc.data() : {});
}

export async function saveMediaConfig(config) {
  await SETTINGS_DOC.set(
    {
      ...normalizeStoredConfig(config),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

export function validateConfig(config = {}) {
  const errors = [];
  for (const platform of ["plex", "emby", "jellyfin"]) {
    if (!config?.[platform]?.baseUrl) errors.push(`${platform}.baseUrl is required`);
  }
  if (!config?.plex?.token) errors.push("plex.token is required");
  if (!config?.plex?.username) errors.push("plex.username is required");
  if (!config?.emby?.apiKey) errors.push("emby.apiKey is required");
  if (!config?.emby?.userId) errors.push("emby.userId is required");
  if (!config?.jellyfin?.apiKey) errors.push("jellyfin.apiKey is required");
  if (!config?.jellyfin?.userId) errors.push("jellyfin.userId is required");
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
    targetStates: Array.isArray(record.targetStates) ? record.targetStates : [],
    rawPayloadDebug: record.rawPayloadDebug || {},
    createdAt: FieldValue.serverTimestamp(),
  });
}

export async function getSyncHistory(limit = 50) {
  const snapshot = await HISTORY_COLLECTION.orderBy("timestamp", "desc").limit(limit).get();
  return snapshot.docs.map((doc) => doc.data());
}
