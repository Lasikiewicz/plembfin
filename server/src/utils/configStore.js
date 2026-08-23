import { db, parseJson, toJson } from "../db.js";
import { assertSafeOutboundUrl, normalizeHttpUrl, configureOutboundGovernor } from "./outbound.js";
import { applyTuningConfig, normalizeTuningSection, tuningClamps, tuningEnvDefaults } from "./tuning.js";
import { normalizeSyncRoles, validateSyncRolesSection, normalizeAuthority } from "./syncRoles.js";
import { getMediaConnection, resolveConnectedProviderConfig } from "./mediaConnectionRepo.js";
import { getValidPlexServerToken, getValidPlexToken } from "./plexTokenManager.js";

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

export function mediaAccountAuthEnabled() {
  return !new Set(["false", "0", "off", "no"]).has(String(process.env.PLEMBFIN_MEDIA_AUTH_ENABLED || "").trim().toLowerCase());
}

function envEnabled(name) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") return undefined;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

export function normalizeSyncScope(scope = {}) {
  const allowedServers = ["plex", "emby", "jellyfin"];
  const servers = Array.isArray(scope.servers) ? scope.servers.map((value) => String(value).toLowerCase()).filter((value) => allowedServers.includes(value)) : [];
  const libraries = Array.isArray(scope.libraries) ? scope.libraries.filter((value) => value && allowedServers.includes(String(value.server).toLowerCase()) && String(value.id || "").trim()).map((value) => ({ server: String(value.server).toLowerCase(), id: String(value.id).trim(), name: String(value.name || "").trim() })) : [];
  const mediaTypes = Array.isArray(scope.mediaTypes) ? scope.mediaTypes.map((value) => String(value).toLowerCase()).filter((value) => ["movie", "episode"].includes(value)) : [];
  return { servers, libraries, mediaTypes, watchedAfter: String(scope.watchedAfter || ""), watchedBefore: String(scope.watchedBefore || ""), maxChanges: Math.max(0, Math.round(Number(scope.maxChanges) || 0)) };
}

export function normalizePacing(section = {}) {
  const profile = ["gentle", "standard", "fast"].includes(String(section.profile || "")) ? String(section.profile) : "standard";
  return { profile };
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
    fanart: {
      apiKey: envValue("FANART_API_KEY"),
    },
    tvdb: {
      apiKey: envValue("TVDB_API_KEY"),
    },
    youtube: {
      apiKey: envValue("YOUTUBE_API_KEY", "YOUTUBE_DATA_API_KEY"),
    },
    omdb: {
      apiKey: envValue("OMDB_API_KEY"),
    },
    tuning: tuningEnvDefaults(),
    syncScope: normalizeSyncScope({}),
    authority: normalizeAuthority({}),
    pacing: normalizePacing({ profile: envValue("OUTBOUND_PACING_PROFILE") }),
  });
}

export function normalizePublicBaseUrl(value = "") {
  const input = String(value || "").trim();
  if (!input) return "";
  const url = new URL(input);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("publicBaseUrl must use http or https");
  if (url.username || url.password) throw new Error("publicBaseUrl must not contain embedded credentials");
  if (url.search || url.hash) throw new Error("publicBaseUrl must not contain a query or fragment");
  if (url.pathname && url.pathname !== "/") throw new Error("publicBaseUrl must be an origin without a path");
  return url.origin;
}

function hasConfiguredFields(section = {}) {
  return Object.entries(section).some(([key, value]) => !["disabled", "sync"].includes(key) && String(value || "").trim() !== "");
}

function mergeEnvDefaults(stored = {}) {
  const normalized = normalizeStoredConfig(stored);
  const defaults = envMediaConfig();
  const merged = { publicBaseUrl: normalized.publicBaseUrl };

  for (const section of ["plex", "emby", "jellyfin", "tmdb", "fanart", "tvdb", "youtube", "omdb"]) {
    merged[section] = { ...defaults[section], ...normalized[section] };
    for (const [key, value] of Object.entries(defaults[section])) {
      if (key === "disabled") continue;
      const credentialField = (section === "plex" && key === "token") || (["emby", "jellyfin"].includes(section) && key === "apiKey");
      if (!String(merged[section][key] || "").trim() && String(value || "").trim() && !(credentialField && normalized[section].legacyFallbackDisabled)) {
        merged[section][key] = value;
      }
    }
  }

  // Seerr has no env-var defaults - carry stored values through as-is.
  merged.seerr = normalized.seerr;

  // Tuning uses numbers-or-null (null = fall back to env/default) rather than
  // the blank-string check above, so it's carried through as-is; the
  // env/default fallback happens in applyTuningConfig()'s effective getters.
  merged.tuning = normalized.tuning;

  // syncScope and authority have no env-var defaults; pacing's
  // OUTBOUND_PACING_PROFILE env default only applies before anything has ever
  // been saved (see defaultMediaConfig()). All three are carried through
  // as-is here. Omitting any of them would make normalizeStoredConfig() below
  // see them as absent and silently reset them to their hardcoded defaults on
  // every load, wiping a saved value the moment anything reads config again.
  merged.syncScope = normalized.syncScope;
  merged.authority = normalized.authority;
  merged.pacing = normalized.pacing;

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
    publicBaseUrl: normalizePublicBaseUrl(stored.publicBaseUrl || ""),
    plex: {
      baseUrl: trimTrailingSlash(stored.plex?.baseUrl || stored.plex?.url || ""),
      token: String(stored.plex?.token || stored.plex?.apiKey || "").trim(),
      username: String(stored.plex?.username || "").trim(),
      legacyFallbackDisabled: Boolean(stored.plex?.legacyFallbackDisabled),
      authMode: stored.plex?.authMode === "manual" ? "manual" : "account",
      disabled: Boolean(stored.plex?.disabled),
      sync: normalizeSyncRoles(stored.plex?.sync || {}),
    },
    emby: {
      baseUrl: trimTrailingSlash(stored.emby?.baseUrl || stored.emby?.url || ""),
      apiKey: String(stored.emby?.apiKey || stored.emby?.api_key || "").trim(),
      userId: String(stored.emby?.userId || "").trim(),
      legacyFallbackDisabled: Boolean(stored.emby?.legacyFallbackDisabled),
      authMode: stored.emby?.authMode === "manual" || (!stored.emby?.authMode && Boolean(stored.emby?.apiKey || stored.emby?.api_key)) ? "manual" : "account",
      disabled: Boolean(stored.emby?.disabled),
      sync: normalizeSyncRoles(stored.emby?.sync || {}),
    },
    jellyfin: {
      baseUrl: trimTrailingSlash(stored.jellyfin?.baseUrl || stored.jellyfin?.url || ""),
      apiKey: String(stored.jellyfin?.apiKey || stored.jellyfin?.api_key || "").trim(),
      userId: String(stored.jellyfin?.userId || "").trim(),
      legacyFallbackDisabled: Boolean(stored.jellyfin?.legacyFallbackDisabled),
      authMode: stored.jellyfin?.authMode === "manual" || (!stored.jellyfin?.authMode && Boolean(stored.jellyfin?.apiKey || stored.jellyfin?.api_key)) ? "manual" : "account",
      disabled: Boolean(stored.jellyfin?.disabled),
      sync: normalizeSyncRoles(stored.jellyfin?.sync || {}),
    },
    seerr: {
      baseUrl: trimTrailingSlash(stored.seerr?.baseUrl || ""),
      apiKey: String(stored.seerr?.apiKey || "").trim(),
      disabled: Boolean(stored.seerr?.disabled),
    },
    tmdb: {
      apiKey: String(stored.tmdb?.apiKey || stored.tmdbApiKey || "").trim(),
    },
    fanart: {
      apiKey: String(stored.fanart?.apiKey || "").trim(),
    },
    tvdb: {
      apiKey: String(stored.tvdb?.apiKey || "").trim(),
    },
    youtube: {
      apiKey: String(stored.youtube?.apiKey || "").trim(),
    },
    omdb: {
      apiKey: String(stored.omdb?.apiKey || "").trim(),
    },
    // Numbers-or-null (null = not overridden, fall back to env/default) rather
    // than the string-based normalization the other sections use above.
    tuning: normalizeTuningSection(stored.tuning || {}),
    syncScope: normalizeSyncScope(stored.syncScope || {}),
    authority: normalizeAuthority(stored.authority || {}),
    pacing: normalizePacing(stored.pacing || {}),
  };
}

const selectSettingsStmt = db.prepare("SELECT data FROM settings WHERE id = ?");
const upsertSettingsStmt = db.prepare(
  `INSERT INTO settings (id, data, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
);

export async function loadMediaConfig({ resolveConnections = true } = {}) {
  const row = selectSettingsStmt.get(SETTINGS_ID);
  const merged = mergeEnvDefaults(parseJson(row?.data, {}) || {});
  merged.publicBaseUrl = normalizePublicBaseUrl(envValue("PLEMBFIN_PUBLIC_URL") || merged.publicBaseUrl);
  if (resolveConnections) {
    const plexConnection = getMediaConnection("plex");
    if (merged.plex.authMode === "account" && ["plex_jwt", "plex_managed_jwt"].includes(plexConnection?.authKind)) {
      // Proactive refresh and expired-token cold-start recovery happen before
      // the first caller receives a Plex client configuration.
      await getValidPlexToken();
      await getValidPlexServerToken();
    }
    for (const provider of ["plex", "emby", "jellyfin"]) {
      if (merged[provider].authMode === "manual") continue;
      merged[provider] = resolveConnectedProviderConfig(provider, merged[provider]);
    }
  }
  applyTuningConfig(merged.tuning);
  configureOutboundGovernor(merged.pacing.profile);
  return merged;
}

// The browser-facing config shape. Secrets (tokens/API keys) are never included -
// each section carries a `configured` boolean instead, plus the non-secret fields
// the settings form needs for repopulation (baseUrl, username, userId, disabled).
export function publicMediaConfig(config = {}) {
  const normalized = normalizeStoredConfig(config);
  const plexConn = getMediaConnection("plex");
  const embyConn = getMediaConnection("emby");
  const jellyfinConn = getMediaConnection("jellyfin");
  return {
    mediaAuthEnabled: mediaAccountAuthEnabled(),
    publicBaseUrl: normalized.publicBaseUrl,
    plex: {
      configured: Boolean(normalized.plex.token || (plexConn && plexConn.status !== "disabled" && plexConn.baseUrl)),
      baseUrl: normalized.plex.baseUrl || plexConn?.baseUrl || "",
      username: normalized.plex.username || plexConn?.remoteUsername || "",
      authMode: normalized.plex.authMode || plexConn?.authKind || "manual",
      disabled: normalized.plex.disabled,
      sync: normalized.plex.sync,
      connection: plexConn,
    },
    emby: {
      configured: Boolean(normalized.emby.apiKey || (embyConn && embyConn.status !== "disabled" && embyConn.baseUrl)),
      baseUrl: normalized.emby.baseUrl || embyConn?.baseUrl || "",
      userId: normalized.emby.userId || embyConn?.remoteUserId || "",
      authMode: normalized.emby.authMode || embyConn?.authKind || "manual",
      disabled: normalized.emby.disabled,
      sync: normalized.emby.sync,
      connection: embyConn,
    },
    jellyfin: {
      configured: Boolean(normalized.jellyfin.apiKey || (jellyfinConn && jellyfinConn.status !== "disabled" && jellyfinConn.baseUrl)),
      baseUrl: normalized.jellyfin.baseUrl || jellyfinConn?.baseUrl || "",
      userId: normalized.jellyfin.userId || jellyfinConn?.remoteUserId || "",
      authMode: normalized.jellyfin.authMode || jellyfinConn?.authKind || "manual",
      disabled: normalized.jellyfin.disabled,
      sync: normalized.jellyfin.sync,
      connection: jellyfinConn,
    },
    seerr: {
      configured: Boolean(normalized.seerr.apiKey && normalized.seerr.baseUrl && !normalized.seerr.disabled),
      baseUrl: normalized.seerr.baseUrl,
      disabled: normalized.seerr.disabled,
    },
    tmdb: { configured: Boolean(normalized.tmdb.apiKey) },
    fanart: { configured: Boolean(normalized.fanart.apiKey) },
    tvdb: { configured: Boolean(normalized.tvdb.apiKey) },
    youtube: { configured: Boolean(normalized.youtube.apiKey) },
    omdb: { configured: Boolean(normalized.omdb.apiKey) },
    tuning: publicTuningConfig(normalized.tuning),
    syncScope: normalized.syncScope,
    authority: normalized.authority,
    pacing: normalized.pacing,
  };
}

// Effective value (stored override, else env/default) plus an `overridden`
// flag per field, so the settings UI can show the active value as a
// placeholder while leaving the input blank when nothing is stored.
function publicTuningConfig(storedTuning = {}) {
  const envDefaults = tuningEnvDefaults();
  const clamps = tuningClamps();
  const result = {};
  for (const key of Object.keys(envDefaults)) {
    const overrideValue = storedTuning[key];
    const overridden = overrideValue !== null && overrideValue !== undefined;
    result[key] = {
      value: overridden ? overrideValue : envDefaults[key],
      default: envDefaults[key],
      overridden,
      min: clamps[key][0],
      max: clamps[key][1],
    };
  }
  return result;
}

// Merge an incoming section over the stored one. Secret fields (tokens/API keys)
// are kept from the stored config when the incoming value is blank or missing -
// the browser never receives secrets (publicMediaConfig), so a settings save with
// an empty key field means "keep the saved credential", not "clear it".
function mergeSection(existing = {}, incoming, secretFields = []) {
  if (!incoming) return existing;
  const merged = { ...existing, ...incoming };
  for (const field of secretFields) {
    if (!String(incoming[field] ?? "").trim()) merged[field] = existing[field];
  }
  return merged;
}

// Returns the normalized result of merging `config` over the stored settings,
// without persisting. handleConfig validates this merged shape so a save that
// omits an already-stored credential still passes required-field checks.
export async function mergeIncomingConfig(config = {}) {
  // Never merge from the runtime adapter: it contains a decrypted connection
  // token and would copy that token back into the general settings JSON.
  const existing = await loadMediaConfig({ resolveConnections: false }).catch(() => normalizeStoredConfig({}));
  return normalizeStoredConfig({
    publicBaseUrl: config.publicBaseUrl ?? existing.publicBaseUrl,
    plex: { ...mergeSection(existing.plex, config.plex, ["token"]), ...(String(config.plex?.token || "").trim() ? { legacyFallbackDisabled: false } : {}) },
    emby: { ...mergeSection(existing.emby, config.emby, ["apiKey"]), ...(String(config.emby?.apiKey || "").trim() ? { legacyFallbackDisabled: false } : {}) },
    jellyfin: { ...mergeSection(existing.jellyfin, config.jellyfin, ["apiKey"]), ...(String(config.jellyfin?.apiKey || "").trim() ? { legacyFallbackDisabled: false } : {}) },
    seerr: mergeSection(existing.seerr, config.seerr, ["apiKey"]),
    tmdb: mergeSection(existing.tmdb, config.tmdb, ["apiKey"]),
    fanart: mergeSection(existing.fanart, config.fanart, ["apiKey"]),
    tvdb: mergeSection(existing.tvdb, config.tvdb, ["apiKey"]),
    youtube: mergeSection(existing.youtube, config.youtube, ["apiKey"]),
    omdb: mergeSection(existing.omdb, config.omdb, ["apiKey"]),
    tuning: mergeSection(existing.tuning, config.tuning, []),
    syncScope: mergeSection(existing.syncScope, config.syncScope, []),
    authority: mergeSection(existing.authority, config.authority, []),
    pacing: mergeSection(existing.pacing, config.pacing, []),
  });
}

export async function saveMediaConfig(config) {
  const normalized = await mergeIncomingConfig(config);
  upsertSettingsStmt.run(SETTINGS_ID, toJson(normalized), Date.now());
  applyTuningConfig(normalized.tuning);
}

export function disableStoredLegacyCredential(provider, connectionId = "", { authMode = "account", activate = false } = {}) {
  if (!["plex", "emby", "jellyfin"].includes(provider)) throw new Error("Unsupported media provider");
  db.transaction(() => {
    const stored = parseJson(selectSettingsStmt.get(SETTINGS_ID)?.data, {}) || {};
    const section = { ...(stored[provider] || {}), legacyFallbackDisabled: true, connectionId: String(connectionId || ""), authMode, ...(activate ? { disabled: false } : {}) };
    if (provider === "plex") {
      delete section.token;
      delete section.apiKey;
    } else {
      delete section.apiKey;
      delete section.api_key;
    }
    upsertSettingsStmt.run(SETTINGS_ID, toJson({ ...stored, [provider]: section }), Date.now());
  }).immediate();
}

export function validateConfig(config = {}) {
  const errors = [];
  const connected = (provider) => {
    const connection = getMediaConnection(provider);
    return connection?.status === "connected" ? connection : null;
  };
  try { normalizePublicBaseUrl(config.publicBaseUrl || ""); } catch (error) { errors.push(error.message); }
  const validateBaseUrl = (value, label) => {
    if (!value) return;
    try {
      // normalizeHttpUrl enforces http/https and rejects embedded credentials;
      // assertSafeOutboundUrl blocks cloud-metadata endpoints - every configured
      // server URL is later fetched with credentials attached, so both apply.
      assertSafeOutboundUrl(normalizeHttpUrl(value, { label }), { label });
    } catch (error) {
      errors.push(error.message);
    }
  };

  if (config.plex) {
    const plexEnabled = !config.plex.disabled;
    if (plexEnabled) {
      const connection = config.plex.authMode === "manual" ? null : connected("plex");
      const baseUrl = config.plex.baseUrl || connection?.baseUrl;
      if (!baseUrl) errors.push("plex.baseUrl is required when Plex is enabled");
      validateBaseUrl(baseUrl, "plex.baseUrl");
      if (!config.plex.token && !connection) errors.push("plex.token is required when Plex is enabled");
      if (!config.plex.username && !connection?.remoteUsername) errors.push("plex.username is required when Plex is enabled");
    }
  }

  if (config.emby) {
    const embyEnabled = !config.emby.disabled;
    if (embyEnabled) {
      const connection = config.emby.authMode === "manual" ? null : connected("emby");
      const baseUrl = config.emby.baseUrl || connection?.baseUrl;
      if (!baseUrl) errors.push("emby.baseUrl is required when Emby is enabled");
      validateBaseUrl(baseUrl, "emby.baseUrl");
      if (!config.emby.apiKey && !connection) errors.push("emby.apiKey is required when Emby is enabled");
      if (!config.emby.userId && !connection?.remoteUserId) errors.push("emby.userId is required when Emby is enabled");
    }
  }

  if (config.jellyfin) {
    const jellyfinEnabled = !config.jellyfin.disabled;
    if (jellyfinEnabled) {
      const connection = config.jellyfin.authMode === "manual" ? null : connected("jellyfin");
      const baseUrl = config.jellyfin.baseUrl || connection?.baseUrl;
      if (!baseUrl) errors.push("jellyfin.baseUrl is required when Jellyfin is enabled");
      validateBaseUrl(baseUrl, "jellyfin.baseUrl");
      if (!config.jellyfin.apiKey && !connection) errors.push("jellyfin.apiKey is required when Jellyfin is enabled");
      if (!config.jellyfin.userId && !connection?.remoteUserId) errors.push("jellyfin.userId is required when Jellyfin is enabled");
    }
  }

  if (config.seerr && !config.seerr.disabled && config.seerr.baseUrl) {
    validateBaseUrl(config.seerr.baseUrl, "seerr.baseUrl");
  }

  if (config.tuning) {
    const clamps = tuningClamps();
    for (const [key, value] of Object.entries(normalizeTuningSection(config.tuning))) {
      if (value === null) continue;
      const [min, max] = clamps[key];
      if (value < min || value > max) errors.push(`tuning.${key} must be between ${min} and ${max}`);
    }
  }

  for (const section of ["plex", "emby", "jellyfin"]) {
    errors.push(...validateSyncRolesSection(config[section]?.sync || {}, `${section}.sync`));
  }
  if (config.authority?.conflictPolicy === "server" && !["plex", "emby", "jellyfin"].includes(config.authority.server)) {
    errors.push("authority.server is required when conflictPolicy is server");
  }
  if (config.pacing && !["gentle", "standard", "fast"].includes(config.pacing.profile)) {
    errors.push("pacing.profile must be gentle, standard, or fast");
  }

  return errors;
}

const selectRuntimeStmt = db.prepare("SELECT data FROM runtime_state WHERE id = ?");
const upsertRuntimeStmt = db.prepare(
  `INSERT INTO runtime_state (id, data, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
);

export const RESTORE_KIND_FULL_SYNC = "full_sync_watchstates";
export const RESTORE_KIND_BACKUP = "backup_restore";
export const SYNC_OPERATION_FORCE = "force_sync";
export const SYNC_OPERATION_REBUILD = "rebuild";
export const SYNC_OPERATION_SCHEDULED = "scheduled_sync";

function operationMatches(runtime = {}) {
  const stored = runtime.syncOperation && typeof runtime.syncOperation === "object"
    ? runtime.syncOperation
    : null;
  if (stored?.kind && stored.active !== false) {
    return {
      kind: String(stored.kind),
      ownerId: String(stored.ownerId || ""),
      startedAt: Number(stored.startedAt || 0),
      heartbeat: Number(stored.heartbeat || 0),
    };
  }

  // Compatibility for locks written before the shared operation marker was
  // introduced. These fields remain in runtime_state because the UI and the
  // restore recovery path still expose them directly.
  if (runtime.restoreSyncActive === true) {
    return {
      kind: String(runtime.restoreSyncKind || "restore"),
      ownerId: String(runtime.restoreSyncRunId || ""),
      startedAt: Number(runtime.restoreSyncStartedAt || 0),
      heartbeat: Number(runtime.restoreSyncHeartbeat || runtime.restoreSyncStartedAt || 0),
    };
  }
  if (runtime.forceSyncActive === true) {
    return {
      kind: SYNC_OPERATION_FORCE,
      ownerId: String(runtime.forceSyncRunId || ""),
      startedAt: Number(runtime.forceSyncStartedAt || 0),
      heartbeat: Number(runtime.forceSyncHeartbeat || runtime.forceSyncStartedAt || 0),
    };
  }
  if (runtime.rebuildActive === true) {
    return {
      kind: SYNC_OPERATION_REBUILD,
      ownerId: String(runtime.rebuildRunId || ""),
      startedAt: Number(runtime.rebuildStartedAt || 0),
      heartbeat: Number(runtime.rebuildHeartbeat || runtime.rebuildStartedAt || 0),
    };
  }
  return null;
}

export function activeSyncOperation(runtime = {}) {
  return operationMatches(runtime);
}

export function syncOperationIsFresh(runtime = {}, now = Date.now(), staleMs = 3 * 60 * 1000) {
  const operation = operationMatches(runtime);
  return Boolean(operation?.heartbeat && operation.heartbeat >= now - staleMs);
}

function sameOperationOwner(active, kind, ownerId) {
  return Boolean(active)
    && active.kind === kind
    && String(active.ownerId || "") !== ""
    && String(ownerId || "") !== ""
    && active.ownerId === String(ownerId);
}

// Runtime state is stored in SQLite, so claiming the shared operation marker
// in the same immediate transaction as the legacy active flag gives all web
// and worker processes one compare-and-set boundary. The owner id makes batch
// requests re-entrant while preventing a second operation of the same kind
// from stealing the first one's lock.
export async function claimSyncOperation({ kind, ownerId = "", activeField, startedAt = Date.now(), values = {} } = {}) {
  if (!kind || !activeField) throw new Error("kind and activeField are required to claim a sync operation");
  let result;
  db.transaction(() => {
    const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const active = operationMatches(current);
    if (active && !sameOperationOwner(active, kind, ownerId)) {
      result = { ok: false, active };
      return;
    }
    const now = Date.now();
    const operation = {
      active: true,
      kind: String(kind),
      ownerId: String(ownerId || ""),
      startedAt: Number(startedAt || now),
      heartbeat: now,
    };
    const merged = {
      ...current,
      ...values,
      [activeField]: true,
      syncOperation: operation,
      updatedAt: now,
    };
    upsertRuntimeStmt.run(RUNTIME_ID, toJson(merged), now);
    result = { ok: true, operation };
  }).immediate();
  return result;
}

export async function touchSyncOperation({ kind, ownerId = "", values = {} } = {}) {
  if (!kind) return false;
  let touched = false;
  db.transaction(() => {
    const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const active = operationMatches(current);
    if (!sameOperationOwner(active, kind, ownerId)) return;
    const now = Date.now();
    const operation = { ...current.syncOperation, active: true, heartbeat: now };
    const merged = { ...current, ...values, syncOperation: operation, updatedAt: now };
    upsertRuntimeStmt.run(RUNTIME_ID, toJson(merged), now);
    touched = true;
  }).immediate();
  return touched;
}

export async function releaseSyncOperation({ kind, ownerId = "", values = {} } = {}) {
  if (!kind) return false;
  let released = false;
  db.transaction(() => {
    const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const active = operationMatches(current);
    if (active && !sameOperationOwner(active, kind, ownerId)) return;
    const now = Date.now();
    const merged = { ...current, ...values, syncOperation: null, updatedAt: now };
    upsertRuntimeStmt.run(RUNTIME_ID, toJson(merged), now);
    released = true;
  }).immediate();
  return released;
}

// Used only by an administrator/recovery path after a heartbeat has gone cold.
// It is deliberately kind-scoped so resetting a stale Force Sync cannot clear
// an unrelated restore or rebuild operation that started in the meantime.
export async function clearSyncOperation({ kind = "", values = {} } = {}) {
  let result = { ok: false, active: null };
  db.transaction(() => {
    const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const active = operationMatches(current);
    result = { ok: false, active };
    if (!active || (kind && active.kind !== kind)) return;
    const now = Date.now();
    const merged = { ...current, ...values, syncOperation: null, updatedAt: now };
    upsertRuntimeStmt.run(RUNTIME_ID, toJson(merged), now);
    result = { ok: true, active };
  }).immediate();
  return result;
}

export async function setRuntimeState(values = {}) {
  db.transaction(() => {
    const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const merged = { ...current, ...values, updatedAt: Date.now() };
    upsertRuntimeStmt.run(RUNTIME_ID, toJson(merged), Date.now());
  }).immediate();
}

export async function loadRuntimeState() {
  return parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
}

// Clear a restore guard after the owning process has stopped or an administrator
// has explicitly confirmed that the persisted lock is orphaned. The cancellation
// flag lets an in-flight full-sync request finish its current remote call without
// accepting another batch under the old run id.
export async function clearRestoreSyncState({ reason = "Restore lock cleared.", expectedKind = "" } = {}) {
  const runtime = await loadRuntimeState();
  const operation = operationMatches(runtime);
  const kind = String(runtime.restoreSyncKind || operation?.kind || "");
  if (expectedKind && kind !== expectedKind) return { reset: false, skipped: true, kind, runId: String(runtime.restoreSyncRunId || "") };

  const runId = String(runtime.restoreSyncRunId || "");
  const wasActive = runtime.restoreSyncActive === true
    || Boolean(runId)
    || runtime.restoreSyncCancelRequested === true
    || Boolean(operation && (!expectedKind || operation.kind === expectedKind));
  if (!wasActive) return { reset: false, skipped: false, kind, runId };

  const finishedAt = Date.now();
  await setRuntimeState({
    restoreSyncActive: false,
    restoreSyncRunId: "",
    restoreSyncKind: "",
    restoreSyncCancelRequested: true,
    restoreSyncHeartbeat: finishedAt,
    syncOperation: null,
    restoreSyncResult: {
      success: false,
      cancelled: true,
      reset: true,
      reason,
      finishedAt,
    },
  });
  return { reset: true, skipped: false, kind, runId };
}

// Append items onto an array field in runtime_state.
export async function appendRuntimeLog(field, items = []) {
  const list = Array.isArray(items) ? items : [items];
  if (!list.length) return;
  db.transaction(() => {
    const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const existing = Array.isArray(current[field]) ? current[field] : [];
    const merged = { ...current, [field]: [...existing, ...list], updatedAt: Date.now() };
    upsertRuntimeStmt.run(RUNTIME_ID, toJson(merged), Date.now());
  }).immediate();
}

const insertSyncHistoryStmt = db.prepare(
  `INSERT INTO sync_history (timestamp, media_type, title, source, status, details, action, target_states, raw_payload_debug, created_at)
   VALUES (@timestamp, @media_type, @title, @source, @status, @details, @action, @target_states, @raw_payload_debug, @created_at)`,
);
const selectSyncHistoryPageStmt = db.prepare("SELECT * FROM sync_history ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?");
const countSyncHistoryStmt = db.prepare("SELECT COUNT(*) AS count FROM sync_history");
const syncHistorySearchExpression = `LOWER(
  COALESCE(media_type, '') || ' ' ||
  COALESCE(title, '') || ' ' ||
  COALESCE(source, '') || ' ' ||
  CASE
    WHEN LOWER(COALESCE(source, '')) LIKE 'manual%' OR LOWER(COALESCE(source, '')) LIKE 'force_sync%' OR LOWER(COALESCE(source, '')) LIKE 'plembfin%' THEN 'plembfin '
    ELSE ''
  END ||
  COALESCE(status, '') || ' ' ||
  COALESCE(details, '') || ' ' ||
  COALESCE(action, '') || ' ' ||
  COALESCE(target_states, '') || ' ' ||
  COALESCE(raw_payload_debug, '')
) LIKE ? ESCAPE '\\'`;
const selectSyncHistorySearchPageStmt = db.prepare(`SELECT * FROM sync_history WHERE ${syncHistorySearchExpression} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`);
const countSyncHistorySearchStmt = db.prepare(`SELECT COUNT(*) AS count FROM sync_history WHERE ${syncHistorySearchExpression}`);

const SYNC_HISTORY_MAX_PAGE_SIZE = 200;

function safeSyncHistoryPageSize(value, fallback = 50) {
  return Math.min(Math.max(Number(value) || fallback, 1), SYNC_HISTORY_MAX_PAGE_SIZE);
}

function safeSyncHistoryOffset(value) {
  return Math.max(Math.floor(Number(value) || 0), 0);
}

function syncHistorySearchPattern(value) {
  const normalized = String(value || "").trim().toLowerCase().slice(0, 120);
  if (!normalized) return "";
  return `%${normalized.replace(/[\\%_]/g, "\\$&")}%`;
}

function syncHistoryRow(row) {
  return {
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
  };
}

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

// Sync activity is an audit trail. It intentionally has no age or row-count
// retention policy; pagination keeps the browser response bounded instead.
export function pruneSyncHistory() {
  return false;
}

export async function getSyncHistoryPage({ limit = 50, offset = 0, search = "" } = {}) {
  const safeLimit = safeSyncHistoryPageSize(limit);
  const safeOffset = safeSyncHistoryOffset(offset);
  const searchPattern = syncHistorySearchPattern(search);
  const total = Number(searchPattern ? countSyncHistorySearchStmt.get(searchPattern)?.count : countSyncHistoryStmt.get()?.count) || 0;
  const history = (searchPattern
    ? selectSyncHistorySearchPageStmt.all(searchPattern, safeLimit, safeOffset)
    : selectSyncHistoryPageStmt.all(safeLimit, safeOffset)
  ).map(syncHistoryRow);
  return { history, total, limit: safeLimit, offset: safeOffset };
}

export async function getSyncHistoryCount() {
  return Number(countSyncHistoryStmt.get()?.count) || 0;
}

export async function getSyncHistory(limit = 50) {
  const page = await getSyncHistoryPage({ limit, offset: 0 });
  return page.history;
}
