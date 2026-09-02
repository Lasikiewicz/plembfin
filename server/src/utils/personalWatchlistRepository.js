import crypto from "node:crypto";
import { db, bumpDataVersion, parseJson, toJson, transaction } from "../db.js";
import { getMediaConnection } from "./mediaConnectionRepo.js";
import {
  normalizePersonalWatchlistMedia,
  personalWatchlistMediaAliases,
  watchlistMediaForStorage,
} from "./personalWatchlistIdentity.js";

export const WATCHLIST_PROVIDERS = ["plex", "emby", "jellyfin"];
export const WATCHLIST_REPRESENTATIONS = ["native", "playlist", "favorites", "rss"];
export const WATCHLIST_DESIRED_STATES = ["present", "absent"];

function clean(value, max = 500) { return String(value ?? "").trim().slice(0, max); }
function positiveInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}
function timestampValue(value, fallback = Date.now()) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? fallback : value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (value != null && String(value).trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return Math.round(numeric);
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
function jsonObject(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  return parseJson(value, fallback) || fallback;
}
export function redactWatchlistError(error) {
  return clean(error?.message || error || "Unknown watchlist sync error", 1000)
    .replace(/([?&](?:token|api[_-]?key|apikey|password|secret|authorization)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/\b(?:bearer|token|api[_-]?key|apikey|password|secret)([=: ]+)[^\s,;]+/gi, "$1<redacted>");
}

const selectMetaStmt = db.prepare("SELECT * FROM personal_watchlist_meta WHERE id = 1");
const updateMetaStmt = db.prepare("UPDATE personal_watchlist_meta SET revision = ?, updated_at = ? WHERE id = 1");
const selectCanonicalRowsStmt = db.prepare("SELECT * FROM personal_watchlist ORDER BY updated_at DESC, media_key ASC");
const selectCanonicalByKeyStmt = db.prepare("SELECT * FROM personal_watchlist WHERE media_key = ?");
const selectLatestMutationStmt = db.prepare("SELECT * FROM personal_watchlist_mutations WHERE media_key = ? ORDER BY canonical_revision DESC, created_at DESC, id DESC LIMIT 1");
const selectMutationByFingerprintStmt = db.prepare("SELECT * FROM personal_watchlist_mutations WHERE event_fingerprint = ? LIMIT 1");
const supersedeMutationStmt = db.prepare("UPDATE personal_watchlist_mutations SET superseded_at = ? WHERE media_key = ? AND superseded_at IS NULL");
const selectLatestMutationsStmt = db.prepare(`
  SELECT mutation.* FROM personal_watchlist_mutations mutation
  INNER JOIN (SELECT media_key, MAX(canonical_revision) AS revision FROM personal_watchlist_mutations GROUP BY media_key) latest
    ON latest.media_key = mutation.media_key AND latest.revision = mutation.canonical_revision
  ORDER BY mutation.canonical_revision ASC, mutation.media_key ASC
`);
const insertMutationStmt = db.prepare(`
  INSERT INTO personal_watchlist_mutations
    (id, media_key, media_json, desired_state, origin, reason, canonical_revision, event_fingerprint, source_timestamp, created_at, tombstone, applied_at)
  VALUES (@id, @media_key, @media_json, @desired_state, @origin, @reason, @canonical_revision, @event_fingerprint, @source_timestamp, @created_at, @tombstone, @applied_at)
`);
const upsertCanonicalStmt = db.prepare(`
  INSERT INTO personal_watchlist
    (media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date, created_at, updated_at)
  VALUES (@media_key, @media_type, @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url, @overview, @release_date, @created_at, @updated_at)
  ON CONFLICT(media_key) DO UPDATE SET
    media_type=excluded.media_type, title=excluded.title, tmdb_id=excluded.tmdb_id, tvdb_id=excluded.tvdb_id,
    imdb_id=excluded.imdb_id, poster_url=excluded.poster_url, overview=excluded.overview,
    release_date=excluded.release_date, updated_at=excluded.updated_at
`);

const upsertProviderItemStmt = db.prepare(`
  INSERT INTO personal_watchlist_provider_items
    (provider, connection_id, remote_scope_key, representation, media_key, media_json, provider_item_id,
     provider_ids_json, remote_state, managed_by_plembfin, primary_target, container_id, container_name,
     last_confirmed_present_at, last_seen_at, last_complete_generation, last_outbound_state,
     last_outbound_intent_id, last_outbound_at, sync_status, last_error, updated_at)
  VALUES (@provider, @connection_id, @remote_scope_key, @representation, @media_key, @media_json, @provider_item_id,
     @provider_ids_json, @remote_state, @managed_by_plembfin, @primary_target, @container_id, @container_name,
     @last_confirmed_present_at, @last_seen_at, @last_complete_generation, @last_outbound_state,
     @last_outbound_intent_id, @last_outbound_at, @sync_status, @last_error, @updated_at)
  ON CONFLICT(provider, connection_id, remote_scope_key, representation, media_key, provider_item_id) DO UPDATE SET
    media_json=excluded.media_json, provider_ids_json=excluded.provider_ids_json, remote_state=excluded.remote_state,
    managed_by_plembfin=excluded.managed_by_plembfin, primary_target=excluded.primary_target,
    container_id=excluded.container_id, container_name=excluded.container_name,
    last_confirmed_present_at=excluded.last_confirmed_present_at, last_seen_at=excluded.last_seen_at,
    last_complete_generation=excluded.last_complete_generation,
    last_outbound_state=COALESCE(excluded.last_outbound_state, personal_watchlist_provider_items.last_outbound_state),
    last_outbound_intent_id=COALESCE(excluded.last_outbound_intent_id, personal_watchlist_provider_items.last_outbound_intent_id),
    last_outbound_at=COALESCE(excluded.last_outbound_at, personal_watchlist_provider_items.last_outbound_at),
    sync_status=excluded.sync_status, last_error=excluded.last_error, updated_at=excluded.updated_at
`);
const selectProviderItemsStmt = db.prepare(`
  SELECT * FROM personal_watchlist_provider_items
  WHERE provider = @provider AND (@connection_id = '' OR connection_id = @connection_id)
    AND (@remote_scope_key = '' OR remote_scope_key = @remote_scope_key)
    AND (@representation = '' OR representation = @representation)
    AND (@media_key = '' OR media_key = @media_key)
  ORDER BY media_key ASC, provider_item_id ASC
`);
const selectProviderItemStmt = db.prepare("SELECT * FROM personal_watchlist_provider_items WHERE provider = ? AND connection_id = ? AND remote_scope_key = ? AND representation = ? AND media_key = ? ORDER BY primary_target DESC, provider_item_id ASC");
const updateProviderOutboundStmt = db.prepare("UPDATE personal_watchlist_provider_items SET last_outbound_state = ?, last_outbound_intent_id = ?, last_outbound_at = ?, sync_status = ?, last_error = NULL, updated_at = ? WHERE provider = ? AND connection_id = ? AND remote_scope_key = ? AND representation = ? AND media_key = ?");

const upsertQueueStmt = db.prepare(`
  INSERT INTO personal_watchlist_sync_queue
    (provider, connection_id, remote_scope_key, representation, media_key, media_json, desired_state, operation,
     source_mutation_id, intent_id, canonical_revision, provider_item_id, status, attempt_count, next_attempt_at,
     lease_owner, lease_expires_at, last_error, created_at, updated_at, succeeded_at)
  VALUES (@provider, @connection_id, @remote_scope_key, @representation, @media_key, @media_json, @desired_state, @operation,
     @source_mutation_id, @intent_id, @canonical_revision, @provider_item_id, 'pending', 0, 0, NULL, NULL, NULL, @created_at, @updated_at, NULL)
  ON CONFLICT(provider, connection_id, remote_scope_key, representation, media_key) DO UPDATE SET
    media_json=excluded.media_json, desired_state=excluded.desired_state, operation=excluded.operation,
    source_mutation_id=excluded.source_mutation_id, intent_id=excluded.intent_id, canonical_revision=excluded.canonical_revision,
    provider_item_id=excluded.provider_item_id, status='pending', attempt_count=0, next_attempt_at=0,
    lease_owner=NULL, lease_expires_at=NULL, last_error=NULL, updated_at=excluded.updated_at, succeeded_at=NULL
`);
const selectQueueRowStmt = db.prepare("SELECT * FROM personal_watchlist_sync_queue WHERE provider = ? AND connection_id = ? AND remote_scope_key = ? AND representation = ? AND media_key = ?");
const selectQueueStmt = db.prepare("SELECT * FROM personal_watchlist_sync_queue WHERE (@provider = '' OR provider = @provider) AND (@status = '' OR status = @status) ORDER BY updated_at ASC, provider ASC, media_key ASC LIMIT @limit");
const queueCountsStmt = db.prepare("SELECT status, COUNT(*) AS count FROM personal_watchlist_sync_queue GROUP BY status");
const releaseExpiredQueueLeasesStmt = db.prepare("UPDATE personal_watchlist_sync_queue SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE status = 'processing' AND lease_expires_at < ?");
const selectDueQueueStmt = db.prepare("SELECT * FROM personal_watchlist_sync_queue WHERE (@provider = '' OR provider = @provider) AND status IN ('pending', 'failed', 'not_available') AND next_attempt_at <= @now ORDER BY updated_at ASC, provider ASC, media_key ASC LIMIT @limit");
const claimQueueStmt = db.prepare("UPDATE personal_watchlist_sync_queue SET status = 'processing', attempt_count = attempt_count + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE provider = ? AND connection_id = ? AND remote_scope_key = ? AND representation = ? AND media_key = ? AND status IN ('pending', 'failed', 'not_available') AND next_attempt_at <= ?");
const getQueueForIntentStmt = db.prepare("SELECT * FROM personal_watchlist_sync_queue WHERE provider = ? AND connection_id = ? AND remote_scope_key = ? AND representation = ? AND media_key = ? AND intent_id = ?");
const acknowledgeQueueStmt = db.prepare("UPDATE personal_watchlist_sync_queue SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, succeeded_at = ?, updated_at = ? WHERE provider = ? AND connection_id = ? AND remote_scope_key = ? AND representation = ? AND media_key = ? AND intent_id = ? AND status = 'processing'");
const releaseQueueStmt = db.prepare("UPDATE personal_watchlist_sync_queue SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE provider = ? AND connection_id = ? AND remote_scope_key = ? AND representation = ? AND media_key = ? AND status = 'processing'");
const deleteQueueRowStmt = db.prepare("DELETE FROM personal_watchlist_sync_queue WHERE provider = ? AND connection_id = ? AND remote_scope_key = ? AND representation = ? AND media_key = ?");
const failQueueStmt = db.prepare("UPDATE personal_watchlist_sync_queue SET status = ?, next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE provider = ? AND connection_id = ? AND remote_scope_key = ? AND representation = ? AND media_key = ? AND intent_id = ? AND status = 'processing'");
const retryQueueStmt = db.prepare("UPDATE personal_watchlist_sync_queue SET status = 'pending', next_attempt_at = 0, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE status IN ('failed', 'not_available', 'reauth_required') AND (@provider = '' OR provider = @provider)");

const selectRunStmt = db.prepare("SELECT * FROM personal_watchlist_sync_runs WHERE provider = ? AND connection_id = ? AND remote_scope_key = ? AND representation = ?");
const upsertRunStmt = db.prepare(`
  INSERT INTO personal_watchlist_sync_runs
    (provider, connection_id, remote_scope_key, representation, run_id, generation, mode, status, canonical_revision,
     scanned_count, present_count, removed_count, unavailable_count, started_at, completed_at, cursor_json,
     complete_snapshot, snapshot_hash, last_error, updated_at)
  VALUES (@provider, @connection_id, @remote_scope_key, @representation, @run_id, @generation, @mode, @status, @canonical_revision,
     @scanned_count, @present_count, @removed_count, @unavailable_count, @started_at, @completed_at, @cursor_json,
     @complete_snapshot, @snapshot_hash, @last_error, @updated_at)
  ON CONFLICT(provider, connection_id, remote_scope_key, representation) DO UPDATE SET
    run_id=excluded.run_id, generation=excluded.generation, mode=excluded.mode, status=excluded.status,
    canonical_revision=excluded.canonical_revision, scanned_count=excluded.scanned_count, present_count=excluded.present_count,
    removed_count=excluded.removed_count, unavailable_count=excluded.unavailable_count, started_at=excluded.started_at,
    completed_at=excluded.completed_at, cursor_json=excluded.cursor_json, complete_snapshot=excluded.complete_snapshot,
    snapshot_hash=excluded.snapshot_hash, last_error=excluded.last_error, updated_at=excluded.updated_at
`);
const insertActivityStmt = db.prepare("INSERT INTO personal_watchlist_activity (id, provider, connection_id, remote_scope_key, representation, media_key, media_json, action, origin, reason, status, details, created_at) VALUES (@id, @provider, @connection_id, @remote_scope_key, @representation, @media_key, @media_json, @action, @origin, @reason, @status, @details, @created_at)");
const selectActivityStmt = db.prepare("SELECT * FROM personal_watchlist_activity WHERE (@provider = '' OR provider = @provider) ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset");
const selectRestoreStateStmt = db.prepare("SELECT data FROM settings WHERE id = 'personalWatchlistRestore'");
const upsertRestoreStateStmt = db.prepare(`
  INSERT INTO settings (id, data, updated_at) VALUES ('personalWatchlistRestore', ?, ?)
  ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);

function normalizeProvider(provider) {
  const value = clean(provider, 30).toLowerCase();
  return WATCHLIST_PROVIDERS.includes(value) ? value : "";
}
export function normalizeWatchlistRepresentation(provider, value) {
  const normalizedProvider = normalizeProvider(provider);
  const representation = clean(value, 30).toLowerCase();
  if (normalizedProvider === "plex") return ["native", "rss"].includes(representation) ? representation : "native";
  return ["playlist", "favorites"].includes(representation) ? representation : "playlist";
}
function watchlistProviderSettings(config = {}, provider) {
  const raw = config?.watchlistSync?.providers?.[provider] ?? config?.watchlistSync?.[provider] ?? {};
  return raw && typeof raw === "object" ? raw : {};
}
export function watchlistProviderScope(provider, config = {}, setting = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const providerConfig = config?.[normalizedProvider] || {};
  const connection = normalizedProvider ? getMediaConnection(normalizedProvider) : null;
  const connectionId = clean(providerConfig.connectionId || providerConfig.connection_id || setting.connectionId || connection?.id || "legacy", 200) || "legacy";
  const remoteUser = clean(providerConfig.remoteUserId || providerConfig.userId || providerConfig.remote_user_id || providerConfig.username || setting.remoteUserId || connection?.remoteUserId || "default", 200) || "default";
  const server = clean(providerConfig.serverId || providerConfig.server_id || providerConfig.baseUrl || connection?.serverId || connection?.baseUrl || "default", 300) || "default";
  return { provider: normalizedProvider, connectionId, remoteScopeKey: clean(`${server}:${remoteUser}`, 500), representation: normalizeWatchlistRepresentation(normalizedProvider, setting.representation || providerConfig.watchlistRepresentation) };
}
export function watchlistProviderScopes(config = {}, { publishedOnly = false } = {}) {
  const section = config?.watchlistSync || {};
  if (section.enabled === false) return [];
  return WATCHLIST_PROVIDERS.map((provider) => {
    const setting = watchlistProviderSettings(config, provider);
    if (setting.enabled !== true) return null;
    if (publishedOnly && Number(setting.publishConfirmedAt || setting.publish_confirmed_at || 0) <= 0) return null;
    return { ...watchlistProviderScope(provider, config, setting), providerConfig: config?.[provider] || {}, setting };
  }).filter(Boolean);
}
export function enabledWatchlistProviderScopes(config = {}) { return watchlistProviderScopes(config); }

function mediaFromRow(row) {
  if (!row) return null;
  return { media_key: row.media_key, type: row.media_type, media_type: row.media_type, title: row.title, tmdb_id: row.tmdb_id || "", tvdb_id: row.tvdb_id || "", imdb_id: row.imdb_id || "", poster_url: row.poster_url || "", overview: row.overview || "", release_date: row.release_date || "", year: Number(String(row.release_date || "").slice(0, 4)) || undefined };
}
function mutationFromRow(row) {
  if (!row) return null;
  return { id: row.id, media_key: row.media_key, media: jsonObject(row.media_json), desired_state: row.desired_state, origin: row.origin, reason: row.reason, canonical_revision: Number(row.canonical_revision || 0), event_fingerprint: row.event_fingerprint || "", source_timestamp: row.source_timestamp == null ? null : Number(row.source_timestamp), created_at: Number(row.created_at || 0), superseded_at: row.superseded_at == null ? null : Number(row.superseded_at), applied_at: row.applied_at == null ? null : Number(row.applied_at), tombstone: Boolean(row.tombstone) };
}
function providerItemFromRow(row) {
  if (!row) return null;
  return { provider: row.provider, connection_id: row.connection_id, remote_scope_key: row.remote_scope_key, representation: row.representation, media_key: row.media_key, media: jsonObject(row.media_json), provider_item_id: row.provider_item_id || "", provider_ids: jsonObject(row.provider_ids_json), remote_state: row.remote_state, managed_by_plembfin: Boolean(row.managed_by_plembfin), primary_target: Boolean(row.primary_target), container_id: row.container_id || "", container_name: row.container_name || "", last_confirmed_present_at: row.last_confirmed_present_at == null ? null : Number(row.last_confirmed_present_at), last_seen_at: row.last_seen_at == null ? null : Number(row.last_seen_at), last_complete_generation: row.last_complete_generation == null ? null : Number(row.last_complete_generation), last_outbound_state: row.last_outbound_state || "", last_outbound_intent_id: row.last_outbound_intent_id || "", last_outbound_at: row.last_outbound_at == null ? null : Number(row.last_outbound_at), sync_status: row.sync_status, last_error: row.last_error || "", updated_at: Number(row.updated_at || 0) };
}
function queueFromRow(row) {
  if (!row) return null;
  return { provider: row.provider, connection_id: row.connection_id, remote_scope_key: row.remote_scope_key, representation: row.representation, media_key: row.media_key, media: jsonObject(row.media_json), desired_state: row.desired_state, operation: row.operation, source_mutation_id: row.source_mutation_id || "", intent_id: row.intent_id, canonical_revision: Number(row.canonical_revision || 0), provider_item_id: row.provider_item_id || "", status: row.status, attempt_count: Number(row.attempt_count || 0), next_attempt_at: Number(row.next_attempt_at || 0), lease_owner: row.lease_owner || "", lease_expires_at: row.lease_expires_at == null ? null : Number(row.lease_expires_at), last_error: row.last_error || "", created_at: Number(row.created_at || 0), updated_at: Number(row.updated_at || 0), succeeded_at: row.succeeded_at == null ? null : Number(row.succeeded_at) };
}
function runFromRow(row) {
  if (!row) return null;
  return { provider: row.provider, connection_id: row.connection_id, remote_scope_key: row.remote_scope_key, representation: row.representation, run_id: row.run_id || "", generation: Number(row.generation || 0), mode: row.mode, status: row.status, canonical_revision: Number(row.canonical_revision || 0), scanned_count: Number(row.scanned_count || 0), present_count: Number(row.present_count || 0), removed_count: Number(row.removed_count || 0), unavailable_count: Number(row.unavailable_count || 0), started_at: row.started_at == null ? null : Number(row.started_at), completed_at: row.completed_at == null ? null : Number(row.completed_at), cursor: jsonObject(row.cursor_json, null), complete_snapshot: Boolean(row.complete_snapshot), snapshot_hash: row.snapshot_hash || "", last_error: row.last_error || "", updated_at: Number(row.updated_at || 0) };
}
function activityFromRow(row) {
  if (!row) return null;
  return { id: row.id, provider: row.provider || "", connection_id: row.connection_id || "", remote_scope_key: row.remote_scope_key || "", representation: row.representation || "", media_key: row.media_key || "", media: jsonObject(row.media_json, null), action: row.action, origin: row.origin, reason: row.reason || "", status: row.status, details: row.details || "", created_at: Number(row.created_at || 0) };
}

function canonicalRowForMedia(media) {
  const normalized = normalizePersonalWatchlistMedia(media);
  const direct = selectCanonicalByKeyStmt.get(normalized.media_key);
  if (direct) return direct;
  const aliases = new Set(personalWatchlistMediaAliases(normalized));
  return selectCanonicalRowsStmt.all().find((row) => personalWatchlistMediaAliases(mediaFromRow(row)).some((alias) => aliases.has(alias))) || null;
}
function normalizedCanonicalMedia(media, existingRow = null) {
  const normalized = normalizePersonalWatchlistMedia({ ...(existingRow ? mediaFromRow(existingRow) : {}), ...media });
  if (existingRow?.media_key) normalized.media_key = existingRow.media_key;
  return normalized;
}
function nextRevision(timestamp) {
  const revision = Number(selectMetaStmt.get()?.revision || 0) + 1;
  updateMetaStmt.run(revision, timestamp);
  return revision;
}
function normalizeMutationOrigin(origin) {
  const value = clean(origin, 30).toLowerCase();
  return ["local", "plex", "emby", "jellyfin", "watched", "restore", "reconcile", "system"].includes(value) ? value : "system";
}
function eventFingerprintFor({ eventFingerprint = "", eventId = "", origin = "", mediaKey = "" } = {}) {
  const explicit = clean(eventFingerprint, 500);
  if (explicit) return explicit;
  const id = clean(eventId, 400);
  return id ? `${normalizeMutationOrigin(origin)}:${mediaKey}:${id}` : "";
}
function queueForScope({ scope, media, desiredState, mutationId, canonicalRevision, timestamp, providerItemId = "" }) {
  const existing = selectQueueRowStmt.get(scope.provider, scope.connectionId, scope.remoteScopeKey, scope.representation, media.media_key);
  if (existing
    && existing.desired_state === desiredState
    && Number(existing.canonical_revision || 0) >= Number(canonicalRevision || 0)
    && ["processing", "succeeded"].includes(existing.status)) {
    return { provider: scope.provider, intent_id: existing.intent_id, scope: scope.remoteScopeKey, representation: scope.representation, reused: true };
  }
  const intentId = crypto.randomUUID();
  upsertQueueStmt.run({ provider: scope.provider, connection_id: scope.connectionId, remote_scope_key: scope.remoteScopeKey, representation: scope.representation, media_key: media.media_key, media_json: toJson(watchlistMediaForStorage(media)), desired_state: desiredState, operation: desiredState === "present" ? "add" : "remove", source_mutation_id: mutationId, intent_id: intentId, canonical_revision: canonicalRevision, provider_item_id: clean(providerItemId, 300) || null, created_at: timestamp, updated_at: timestamp });
  return { provider: scope.provider, intent_id: intentId, scope: scope.remoteScopeKey, representation: scope.representation };
}
function upsertProviderIntentLedger({ scope, media, timestamp, syncStatus = "pending", lastError = null }) {
  const existing = selectProviderItemStmt.all(scope.provider, scope.connectionId, scope.remoteScopeKey, scope.representation, media.media_key)[0];
  upsertProviderItemStmt.run({ provider: scope.provider, connection_id: scope.connectionId, remote_scope_key: scope.remoteScopeKey, representation: scope.representation, media_key: media.media_key, media_json: toJson(watchlistMediaForStorage(media)), provider_item_id: existing?.provider_item_id || "", provider_ids_json: existing?.provider_ids_json || toJson(media.provider_item_ids || {}), remote_state: existing?.remote_state || "unknown", managed_by_plembfin: existing?.managed_by_plembfin ?? 0, primary_target: existing?.primary_target ?? 0, container_id: existing?.container_id || null, container_name: existing?.container_name || null, last_confirmed_present_at: existing?.last_confirmed_present_at || null, last_seen_at: existing?.last_seen_at || null, last_complete_generation: existing?.last_complete_generation || null, last_outbound_state: existing?.last_outbound_state || null, last_outbound_intent_id: existing?.last_outbound_intent_id || null, last_outbound_at: existing?.last_outbound_at || null, sync_status: syncStatus, last_error: lastError ? redactWatchlistError(lastError) : null, updated_at: timestamp });
}

export function recordWatchlistActivity({ provider = null, connectionId = "", remoteScopeKey = "", representation = "", mediaKey = "", media = null, action = "sync", origin = "system", reason = "", status = "info", details = "", timestamp = Date.now() } = {}) {
  insertActivityStmt.run({ id: crypto.randomUUID(), provider: normalizeProvider(provider) || null, connection_id: clean(connectionId, 200) || null, remote_scope_key: clean(remoteScopeKey, 500) || null, representation: clean(representation, 30) || null, media_key: clean(mediaKey, 400) || null, media_json: media ? toJson(watchlistMediaForStorage(media)) : null, action: clean(action, 80) || "sync", origin: normalizeMutationOrigin(origin), reason: clean(reason, 300) || null, status: clean(status, 40) || "info", details: redactWatchlistError(details || ""), created_at: timestampValue(timestamp) });
}

export function recordWatchlistMutation({ media, desiredState, origin = "local", reason = "manual", config = null, timestamp = Date.now(), eventAt = null, eventId = "", eventFingerprint = "", guardStale = false } = {}) {
  if (!WATCHLIST_DESIRED_STATES.includes(desiredState)) throw new Error("Watchlist desired state must be present or absent");
  const now = timestampValue(timestamp);
  const normalizedOrigin = normalizeMutationOrigin(origin);
  const initial = normalizePersonalWatchlistMedia(media);
  const existingRow = canonicalRowForMedia(initial);
  const normalized = normalizedCanonicalMedia(initial, existingRow);
  const fingerprint = eventFingerprintFor({ eventFingerprint, eventId, origin: normalizedOrigin, mediaKey: normalized.media_key });
  if (fingerprint) {
    const duplicate = selectMutationByFingerprintStmt.get(fingerprint);
    if (duplicate) return { mutation: mutationFromRow(duplicate), media: normalized, duplicate: true, stale: false, queued: [] };
  }
  const latest = selectLatestMutationStmt.get(normalized.media_key);
  const sourceTime = eventAt == null ? null : timestampValue(eventAt, now);
  if (guardStale && latest && sourceTime != null && sourceTime < Number(latest.created_at || 0)) return { mutation: mutationFromRow(latest), media: normalized, duplicate: false, stale: true, queued: [] };
  if (latest?.desired_state === desiredState && normalizedOrigin !== "local" && !fingerprint) return { mutation: mutationFromRow(latest), media: normalized, duplicate: true, stale: false, queued: [] };
  const revision = nextRevision(now);
  const mutation = { id: crypto.randomUUID(), media_key: normalized.media_key, media: normalized, desired_state: desiredState, origin: normalizedOrigin, reason: clean(reason, 300) || "unspecified", canonical_revision: revision, event_fingerprint: fingerprint, source_timestamp: sourceTime, created_at: now, superseded_at: null, applied_at: now, tombstone: desiredState === "absent" };
  if (latest) supersedeMutationStmt.run(now, normalized.media_key);
  insertMutationStmt.run({ id: mutation.id, media_key: mutation.media_key, media_json: toJson(watchlistMediaForStorage(normalized)), desired_state: desiredState, origin: normalizedOrigin, reason: mutation.reason, canonical_revision: revision, event_fingerprint: fingerprint || null, source_timestamp: sourceTime, created_at: now, tombstone: mutation.tombstone ? 1 : 0, applied_at: now });
  if (desiredState === "present") upsertCanonicalStmt.run({ ...watchlistMediaForStorage(normalized), created_at: existingRow?.created_at || now, updated_at: now });
  else db.prepare("DELETE FROM personal_watchlist WHERE media_key = ?").run(normalized.media_key);
  const scopes = enabledWatchlistProviderScopes(config || {});
  const queued = scopes.map((scope) => queueForScope({ scope, media: normalized, desiredState, mutationId: mutation.id, canonicalRevision: revision, timestamp: now }));
  for (const scope of scopes) upsertProviderIntentLedger({ scope, media: normalized, timestamp: now });
  recordWatchlistActivity({ media: normalized, mediaKey: normalized.media_key, action: desiredState === "present" ? "canonical_add" : "canonical_remove", origin: normalizedOrigin, reason: mutation.reason, status: "queued", details: queued.length ? `Canonical mutation queued for ${queued.length} provider${queued.length === 1 ? "" : "s"}.` : "Canonical mutation stored locally; no provider queue is enabled.", timestamp: now });
  return { mutation, media: normalized, duplicate: false, stale: false, queued };
}
export function applyWatchlistMutation(media, desiredState, options = {}) {
  let result;
  transaction(() => { result = recordWatchlistMutation({ media, desiredState, ...options }); });
  if (result && !result.duplicate && !result.stale) bumpDataVersion();
  return result;
}
export function enqueueWatchlistMutation(options = {}) { return applyWatchlistMutation(options.media, options.desiredState, options); }
export function upsertCanonicalWatchlist(media, options = {}) { return applyWatchlistMutation(media, "present", { ...options, origin: options.origin || "local", reason: options.reason || "manual" }); }
export function removeCanonicalWatchlist(media, options = {}) { return applyWatchlistMutation(media, "absent", { ...options, origin: options.origin || "local", reason: options.reason || "manual" }); }
export function getWatchlistRevision() { return Number(selectMetaStmt.get()?.revision || 0); }
export function listCanonicalWatchlist() { return selectCanonicalRowsStmt.all().map(mediaFromRow); }
export function getCanonicalWatchlist(media) { return mediaFromRow(canonicalRowForMedia(media)); }
export function getLatestWatchlistMutation(mediaKey) { return mutationFromRow(selectLatestMutationStmt.get(clean(mediaKey, 400))); }
export function listLatestWatchlistMutations() { return selectLatestMutationsStmt.all().map(mutationFromRow); }
export function listWatchlistMutations({ mediaKey = "", limit = 250 } = {}) {
  const safeLimit = Math.min(1000, Math.max(1, positiveInteger(limit, 250)));
  const rows = mediaKey ? db.prepare("SELECT * FROM personal_watchlist_mutations WHERE media_key = ? ORDER BY canonical_revision DESC LIMIT ?").all(clean(mediaKey, 400), safeLimit) : db.prepare("SELECT * FROM personal_watchlist_mutations ORDER BY canonical_revision DESC LIMIT ?").all(safeLimit);
  return rows.map(mutationFromRow);
}

export function upsertProviderWatchlistItem({ provider, connectionId = "", remoteScopeKey = "", representation, media, providerItemId = "", providerIds = {}, remoteState = "present", managedByPlembfin = true, primaryTarget = false, containerId = "", containerName = "", generation = null, syncStatus = "synced", lastError = null, timestamp = Date.now() } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) throw new Error("Invalid watchlist provider");
  const normalized = normalizePersonalWatchlistMedia(media);
  const scopeRepresentation = normalizeWatchlistRepresentation(normalizedProvider, representation);
  const now = timestampValue(timestamp);
  upsertProviderItemStmt.run({ provider: normalizedProvider, connection_id: clean(connectionId, 200), remote_scope_key: clean(remoteScopeKey, 500), representation: scopeRepresentation, media_key: normalized.media_key, media_json: toJson(watchlistMediaForStorage(normalized)), provider_item_id: clean(providerItemId, 300), provider_ids_json: toJson(providerIds || normalized.provider_item_ids || {}), remote_state: ["present", "absent", "unavailable", "unknown", "unmanaged"].includes(remoteState) ? remoteState : "unknown", managed_by_plembfin: managedByPlembfin ? 1 : 0, primary_target: primaryTarget ? 1 : 0, container_id: clean(containerId, 300) || null, container_name: clean(containerName, 300) || null, last_confirmed_present_at: remoteState === "present" ? now : null, last_seen_at: now, last_complete_generation: generation == null ? null : positiveInteger(generation), last_outbound_state: null, last_outbound_intent_id: null, last_outbound_at: null, sync_status: clean(syncStatus, 40) || "synced", last_error: lastError ? redactWatchlistError(lastError) : null, updated_at: now });
  return listWatchlistProviderItems({ provider: normalizedProvider, connectionId, remoteScopeKey, representation: scopeRepresentation, mediaKey: normalized.media_key }).find((row) => row.provider_item_id === clean(providerItemId, 300)) || null;
}
export function listWatchlistProviderItems({ provider = "", connectionId = "", remoteScopeKey = "", representation = "", mediaKey = "" } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) return [];
  return selectProviderItemsStmt.all({ provider: normalizedProvider, connection_id: clean(connectionId, 200), remote_scope_key: clean(remoteScopeKey, 500), representation: clean(representation, 30), media_key: clean(mediaKey, 400) }).map(providerItemFromRow);
}
export function getWatchlistProviderItemsForMedia(options = {}) { return listWatchlistProviderItems(options); }
export function markWatchlistProviderOutbound({ provider, connectionId, remoteScopeKey, representation, mediaKey, desiredState, intentId, status = "synced", timestamp = Date.now() }) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider || !WATCHLIST_DESIRED_STATES.includes(desiredState)) return false;
  return updateProviderOutboundStmt.run(desiredState, clean(intentId, 300), timestampValue(timestamp), clean(status, 40) || "synced", timestampValue(timestamp), normalizedProvider, clean(connectionId, 200), clean(remoteScopeKey, 500), normalizeWatchlistRepresentation(normalizedProvider, representation), clean(mediaKey, 400)).changes > 0;
}
export function queueWatchlistMutationForProvider({ provider, connectionId = "", remoteScopeKey = "", representation, media, desiredState, sourceMutationId = null, canonicalRevision = 0, providerItemId = "", timestamp = Date.now() } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider || !WATCHLIST_DESIRED_STATES.includes(desiredState)) throw new Error("Invalid watchlist provider or desired state");
  const normalized = normalizePersonalWatchlistMedia(media);
  const scope = { provider: normalizedProvider, connectionId: clean(connectionId, 200), remoteScopeKey: clean(remoteScopeKey, 500), representation: normalizeWatchlistRepresentation(normalizedProvider, representation) };
  const queued = queueForScope({ scope, media: normalized, desiredState, mutationId: sourceMutationId, canonicalRevision: positiveInteger(canonicalRevision), timestamp: timestampValue(timestamp), providerItemId });
  upsertProviderIntentLedger({ scope, media: normalized, timestamp: timestampValue(timestamp) });
  return queued;
}
export function listWatchlistQueue({ provider = "", status = "", limit = 500 } = {}) { return selectQueueStmt.all({ provider: normalizeProvider(provider), status: clean(status, 40), limit: Math.min(2000, Math.max(1, positiveInteger(limit, 500))) }).map(queueFromRow); }
export function getWatchlistQueueRow({ provider, connectionId = "", remoteScopeKey = "", representation, mediaKey } = {}) { const p = normalizeProvider(provider); return p ? queueFromRow(selectQueueRowStmt.get(p, clean(connectionId, 200), clean(remoteScopeKey, 500), normalizeWatchlistRepresentation(p, representation), clean(mediaKey, 400))) : null; }
export function watchlistQueueCounts({ provider = "" } = {}) {
  const rows = provider ? db.prepare("SELECT status, COUNT(*) AS count FROM personal_watchlist_sync_queue WHERE provider = ? GROUP BY status").all(normalizeProvider(provider)) : queueCountsStmt.all();
  return rows.reduce((result, row) => ({ ...result, [row.status]: Number(row.count || 0) }), {});
}
export function claimWatchlistQueue({ provider = "", owner = crypto.randomUUID(), now = Date.now(), leaseMs = 120_000, limit = 25 } = {}) {
  const p = normalizeProvider(provider); const safeNow = timestampValue(now); const rows = [];
  transaction(() => {
    releaseExpiredQueueLeasesStmt.run(safeNow, safeNow);
    for (const row of selectDueQueueStmt.all({ provider: p, now: safeNow, limit: Math.min(100, Math.max(1, positiveInteger(limit, 25))) })) {
      if (claimQueueStmt.run(clean(owner, 200), safeNow + Math.max(10_000, positiveInteger(leaseMs, 120_000)), safeNow, row.provider, row.connection_id, row.remote_scope_key, row.representation, row.media_key, safeNow).changes) rows.push(queueFromRow(selectQueueRowStmt.get(row.provider, row.connection_id, row.remote_scope_key, row.representation, row.media_key)));
    }
  });
  return { owner: clean(owner, 200), rows };
}
function queueCoordinates(options = {}) { const provider = normalizeProvider(options.provider); if (!provider) throw new Error("Invalid watchlist provider"); return { provider, connectionId: clean(options.connectionId, 200), remoteScopeKey: clean(options.remoteScopeKey, 500), representation: normalizeWatchlistRepresentation(provider, options.representation), mediaKey: clean(options.mediaKey, 400), intentId: clean(options.intentId, 300) }; }
export function acknowledgeWatchlistQueue({ provider, connectionId = "", remoteScopeKey = "", representation, mediaKey, intentId, desiredState, timestamp = Date.now(), details = "" } = {}) {
  const c = queueCoordinates({ provider, connectionId, remoteScopeKey, representation, mediaKey, intentId }); if (!WATCHLIST_DESIRED_STATES.includes(desiredState)) return false; const now = timestampValue(timestamp); let changed = false;
  transaction(() => {
    const row = getQueueForIntentStmt.get(c.provider, c.connectionId, c.remoteScopeKey, c.representation, c.mediaKey, c.intentId); if (!row || row.status !== "processing") return;
    changed = acknowledgeQueueStmt.run(now, now, c.provider, c.connectionId, c.remoteScopeKey, c.representation, c.mediaKey, c.intentId).changes > 0; if (!changed) return;
    updateProviderOutboundStmt.run(desiredState, c.intentId, now, "synced", now, c.provider, c.connectionId, c.remoteScopeKey, c.representation, c.mediaKey);
    db.prepare("UPDATE personal_watchlist_provider_items SET remote_state = ?, managed_by_plembfin = 1, sync_status = 'synced', last_error = NULL, updated_at = ? WHERE provider = ? AND connection_id = ? AND remote_scope_key = ? AND representation = ? AND media_key = ?").run(desiredState, now, c.provider, c.connectionId, c.remoteScopeKey, c.representation, c.mediaKey);
    recordWatchlistActivity({ provider: c.provider, connectionId: c.connectionId, remoteScopeKey: c.remoteScopeKey, representation: c.representation, mediaKey: c.mediaKey, action: desiredState === "present" ? "provider_add" : "provider_remove", origin: "system", reason: row.operation, status: "succeeded", details: details || "Provider watchlist mutation completed.", timestamp: now });
  }); return changed;
}
export function releaseWatchlistQueue({ provider, connectionId = "", remoteScopeKey = "", representation, mediaKey, timestamp = Date.now() } = {}) {
  const p = normalizeProvider(provider);
  if (!p) return false;
  return releaseQueueStmt.run(timestampValue(timestamp), p, clean(connectionId, 200), clean(remoteScopeKey, 500), normalizeWatchlistRepresentation(p, representation), clean(mediaKey, 400)).changes > 0;
}
export function failWatchlistQueue({ provider, connectionId = "", remoteScopeKey = "", representation, mediaKey, intentId, status = "failed", error = "Provider watchlist mutation failed", retryAt = null, timestamp = Date.now() } = {}) {
  const c = queueCoordinates({ provider, connectionId, remoteScopeKey, representation, mediaKey, intentId }); const allowed = ["failed", "not_available", "reauth_required"].includes(status) ? status : "failed"; const now = timestampValue(timestamp); const attempt = Number(getWatchlistQueueRow(c)?.attempt_count || 1); const next = retryAt == null ? now + Math.min(6 * 60 * 60 * 1000, 15_000 * (2 ** Math.min(8, attempt))) : timestampValue(retryAt, now); let changed = false;
  transaction(() => {
    changed = failQueueStmt.run(allowed, next, redactWatchlistError(error), now, c.provider, c.connectionId, c.remoteScopeKey, c.representation, c.mediaKey, c.intentId).changes > 0; if (!changed) return;
    db.prepare("UPDATE personal_watchlist_provider_items SET sync_status = ?, last_error = ?, updated_at = ? WHERE provider = ? AND connection_id = ? AND remote_scope_key = ? AND representation = ? AND media_key = ?").run(allowed, redactWatchlistError(error), now, c.provider, c.connectionId, c.remoteScopeKey, c.representation, c.mediaKey);
    recordWatchlistActivity({ provider: c.provider, connectionId: c.connectionId, remoteScopeKey: c.remoteScopeKey, representation: c.representation, mediaKey: c.mediaKey, action: "provider_sync", origin: "system", reason: allowed, status: allowed, details: redactWatchlistError(error), timestamp: now });
  }); return changed;
}
export function retryWatchlistQueue({ provider = "", timestamp = Date.now() } = {}) { return retryQueueStmt.run({ provider: normalizeProvider(provider), updated_at: timestampValue(timestamp) }).changes; }

export function beginWatchlistSyncRun({ provider, connectionId = "", remoteScopeKey = "", representation, mode = "reconcile", canonicalRevision = getWatchlistRevision(), timestamp = Date.now() } = {}) {
  const p = normalizeProvider(provider); if (!p) throw new Error("Invalid watchlist provider"); const connection = clean(connectionId, 200); const scope = clean(remoteScopeKey, 500); const rep = normalizeWatchlistRepresentation(p, representation); const now = timestampValue(timestamp); const existing = selectRunStmt.get(p, connection, scope, rep); const values = { provider: p, connection_id: connection, remote_scope_key: scope, representation: rep, run_id: crypto.randomUUID(), generation: Number(existing?.generation || 0) + 1, mode: ["initial_publish", "reconcile", "repair"].includes(mode) ? mode : "reconcile", status: "running", canonical_revision: positiveInteger(canonicalRevision), scanned_count: 0, present_count: 0, removed_count: 0, unavailable_count: 0, started_at: now, completed_at: null, cursor_json: null, complete_snapshot: 0, snapshot_hash: null, last_error: null, updated_at: now }; upsertRunStmt.run(values); return runFromRow(selectRunStmt.get(p, connection, scope, rep));
}
export function updateWatchlistSyncRun({ provider, connectionId = "", remoteScopeKey = "", representation, ...changes } = {}) {
  const p = normalizeProvider(provider); if (!p) return null; const connection = clean(connectionId, 200); const scope = clean(remoteScopeKey, 500); const rep = normalizeWatchlistRepresentation(p, representation); const existing = selectRunStmt.get(p, connection, scope, rep); if (!existing) return null; const values = { provider: p, connection_id: connection, remote_scope_key: scope, representation: rep, run_id: changes.runId ?? existing.run_id, generation: positiveInteger(changes.generation ?? existing.generation), mode: changes.mode || existing.mode, status: changes.status || existing.status, canonical_revision: positiveInteger(changes.canonicalRevision ?? existing.canonical_revision), scanned_count: positiveInteger(changes.scannedCount ?? existing.scanned_count), present_count: positiveInteger(changes.presentCount ?? existing.present_count), removed_count: positiveInteger(changes.removedCount ?? existing.removed_count), unavailable_count: positiveInteger(changes.unavailableCount ?? existing.unavailable_count), started_at: changes.startedAt ?? existing.started_at, completed_at: changes.completedAt ?? existing.completed_at, cursor_json: changes.cursor === undefined ? existing.cursor_json : (changes.cursor == null ? null : toJson(changes.cursor)), complete_snapshot: changes.completeSnapshot === undefined ? existing.complete_snapshot : (changes.completeSnapshot ? 1 : 0), snapshot_hash: changes.snapshotHash ?? existing.snapshot_hash, last_error: changes.lastError === undefined ? existing.last_error : (changes.lastError ? redactWatchlistError(changes.lastError) : null), updated_at: timestampValue(changes.timestamp) }; upsertRunStmt.run(values); return runFromRow(selectRunStmt.get(p, connection, scope, rep));
}
export function getWatchlistSyncRun({ provider, connectionId = "", remoteScopeKey = "", representation } = {}) { const p = normalizeProvider(provider); return p ? runFromRow(selectRunStmt.get(p, clean(connectionId, 200), clean(remoteScopeKey, 500), normalizeWatchlistRepresentation(p, representation))) : null; }
export function listWatchlistSyncRuns() { return db.prepare("SELECT * FROM personal_watchlist_sync_runs ORDER BY provider, remote_scope_key, representation").all().map(runFromRow); }
export function reconcileWatchlistQueueForConfig(config = {}, { timestamp = Date.now() } = {}) {
  const queued = [];
  const now = timestampValue(timestamp);
  const scopes = enabledWatchlistProviderScopes(config);
  const activeKeys = new Set(scopes.map((scope) => `${scope.provider}:${scope.connectionId}:${scope.remoteScopeKey}:${scope.representation}`));
  // A disabled provider or a representation change must not leave stale
  // outbound work visible as pending forever. Re-enabling it will recreate the
  // current intent from the latest mutation below.
  for (const row of listWatchlistQueue({ limit: 2000 })) {
    const key = `${row.provider}:${row.connection_id}:${row.remote_scope_key}:${row.representation}`;
    if (!activeKeys.has(key)) deleteQueueRowStmt.run(row.provider, row.connection_id, row.remote_scope_key, row.representation, row.media_key);
  }
  for (const mutation of listLatestWatchlistMutations()) for (const scope of scopes) {
    queued.push(queueForScope({ scope, media: mutation.media, desiredState: mutation.desired_state, mutationId: mutation.id, canonicalRevision: mutation.canonical_revision, timestamp: now }));
    upsertProviderIntentLedger({ scope, media: mutation.media, timestamp: now });
  }
  return queued;
}

function completedWatchlistMedia(media = {}) {
  const type = String(media.type || media.media_type || media.mediaType || "").toLowerCase();
  if (["movie", "tv", "show", "series"].includes(type)) return normalizePersonalWatchlistMedia(media);
  if (type !== "episode" || !(media.showCompleted === true || media.show_complete === true || media.completedShow === true || media.completionScope === "show")) return null;
  return normalizePersonalWatchlistMedia({ type: "tv", title: media.show_title || media.showTitle || media.series_title || media.seriesTitle || media.grandparentTitle || media.title, tmdb_id: media.show_tmdb_id || media.showTmdbId, tvdb_id: media.show_tvdb_id || media.showTvdbId, imdb_id: media.show_imdb_id || media.showImdbId, poster_url: media.show_poster_url || media.posterUrl || media.poster_url, overview: media.show_overview || media.overview, release_date: media.show_release_date || media.release_date });
}
export function removeWatchlistAfterCompletedWatch(media, { config = null, origin = "watched", reason = "watched_completion", eventId = "", eventFingerprint = "", eventAt = null, timestamp = Date.now() } = {}) {
  const target = completedWatchlistMedia(media); if (!target) return { removed: false, reason: "not_a_completed_watchlist_media" }; if (!canonicalRowForMedia(target)) return { removed: false, reason: "not_in_watchlist" }; const result = applyWatchlistMutation(target, "absent", { config, origin, reason, eventId, eventFingerprint, eventAt, timestamp, guardStale: true }); return { removed: Boolean(result && !result.duplicate && !result.stale), stale: Boolean(result?.stale), duplicate: Boolean(result?.duplicate), mutation: result?.mutation || null, queued: result?.queued || [] };
}
export const removeWatchlistForCompletedWatch = removeWatchlistAfterCompletedWatch;
export function recordProviderWatchlistRemoval(media, { provider, config = null, connectionId = "", remoteScopeKey = "", representation, eventId = "", eventFingerprint = "", reason = "provider_removed", eventAt = null, timestamp = Date.now() } = {}) {
  const p = normalizeProvider(provider); const target = normalizePersonalWatchlistMedia(media); const canonical = canonicalRowForMedia(target); if (!p || !canonical) return { removed: false, reason: "not_in_watchlist" }; const result = applyWatchlistMutation(target, "absent", { config, origin: p, reason, eventId, eventFingerprint, eventAt, timestamp, guardStale: true }); if (result?.mutation) recordWatchlistActivity({ provider: p, connectionId, remoteScopeKey, representation, media: target, mediaKey: canonical.media_key, action: "provider_removed_canonical", origin: p, reason, status: result.stale ? "stale" : "queued", details: result.stale ? "Ignored an older provider removal after a newer local watchlist revision." : "Provider removal updated the local canonical watchlist and fanout queue.", timestamp }); return { removed: Boolean(result && !result.duplicate && !result.stale), stale: Boolean(result?.stale), duplicate: Boolean(result?.duplicate), mutation: result?.mutation || null, queued: result?.queued || [] };
}

export function getWatchlistRestoreState() {
  const state = parseJson(selectRestoreStateStmt.get()?.data, {}) || {};
  return { pending: state.pending === true, restoreId: clean(state.restoreId, 200), createdAt: Number(state.createdAt || 0) || 0 };
}

export function markWatchlistRestorePending({ restoreId = crypto.randomUUID(), timestamp = Date.now() } = {}) {
  const state = { pending: true, restoreId: clean(restoreId, 200) || crypto.randomUUID(), createdAt: timestampValue(timestamp) };
  upsertRestoreStateStmt.run(toJson(state), timestampValue(timestamp));
  return state;
}

export function clearWatchlistRestorePending({ timestamp = Date.now() } = {}) {
  const state = { pending: false, restoreId: "", createdAt: 0, clearedAt: timestampValue(timestamp) };
  upsertRestoreStateStmt.run(toJson(state), timestampValue(timestamp));
  return state;
}

// Remote observations and outbound work are never authoritative after a full
// local restore. Keep the activity history, but force the next explicit publish
// to establish a fresh provider baseline.
export function clearWatchlistRemoteProjection() {
  db.prepare("DELETE FROM personal_watchlist_provider_items").run();
  db.prepare("DELETE FROM personal_watchlist_sync_queue").run();
  db.prepare("DELETE FROM personal_watchlist_sync_runs").run();
}

export function listWatchlistActivity({ provider = "", limit = 100, offset = 0 } = {}) { return selectActivityStmt.all({ provider: normalizeProvider(provider), limit: Math.min(500, Math.max(1, positiveInteger(limit, 100))), offset: Math.max(0, positiveInteger(offset, 0)) }).map(activityFromRow); }
