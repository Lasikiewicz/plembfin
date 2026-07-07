import crypto from "node:crypto";
import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { fetchWithTimeout } from "../utils/outbound.js";
import { db, writeAuditLog } from "../db.js";
import { createLoopStore } from "../utils/loopStore.js";
import { listActiveSessions } from "../utils/activeSessions.js";
import { loadMediaConfig, loadRuntimeState, setRuntimeState, appendRuntimeLog } from "../utils/configStore.js";
import { markPlexUnplayedByRatingKey, fetchPlexWatchedItems } from "../utils/plexClient.js";
import { markEmbyUnplayedById, fetchEmbyWatchedItems } from "../utils/embyClient.js";
import { markJellyfinUnplayedById, fetchJellyfinWatchedItems } from "../utils/jellyfinClient.js";
import { syncMediaPlaystate, syncMediaUnplayedPlaystate } from "../utils/syncOrchestrator.js";
import { BACKUP_FORMAT, BACKUP_VERSION, backupManifest, exportCollectionPage, importCollectionBatch } from "../utils/backup.js";
import { batchInsertWatchRecords, requireDb } from "../utils/dataRepo.js";
import {
  createWatchHistoryBackup,
  getBackupDestination,
  importWatchHistoryBackupFile,
  listRemoteBackups,
  pullRemoteBackupToLocal,
  readWatchBackupFile,
  removeBackupDestination,
  clearRestoreStatus,
  pauseCronSync,
  resumeCronSync,
  setLastRestoreAt,
  loadWatchBackupRuntime,
  restoreWatchHistoryBackup,
  saveWatchBackupConfig,
  saveBackupDestination,
  testBackupDestination,
  updateDestinationSecrets,
  watchBackupStatus,
} from "../utils/watchHistoryBackups.js";
import {
  createPlembfinBackup,
  deletePlembfinBackup,
  plembfinBackupStatus,
  readPlembfinBackupFile,
  savePlembfinBackupConfig,
} from "../utils/plembfinBackups.js";
import { deviceCodeEndpoint, tokenEndpoint, ONEDRIVE_SCOPE } from "../utils/backupDestinations/onedrive.js";

export async function handleImport(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const body = await readJson(req);
  const records = Array.isArray(body) ? body : body.records;
  if (!Array.isArray(records)) return sendJson(res, { error: "Expected an array of records" }, 400);
  if (records.length > 100) return sendJson(res, { error: "Batch size must be 100 records or fewer" }, 413);
  return sendJson(res, { ok: true, ...(await batchInsertWatchRecords(records)) });
}

export async function handleBackupExport(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const collection = String(req.query?.collection || "").trim();
  if (!collection) return sendJson(res, backupManifest(req.headers.origin || ""));

  try {
    return sendJson(res, exportCollectionPage(collection, {
      cursor: req.query?.cursor,
      limit: req.query?.limit,
    }));
  } catch (error) {
    return sendJson(res, { error: error.message }, 400);
  }
}

export async function handleBackupImport(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  if (body.format !== BACKUP_FORMAT || Number(body.version) !== BACKUP_VERSION) {
    return sendJson(res, { error: "Unsupported Plembfin backup format or version" }, 400);
  }

  try {
    return sendJson(res, {
      ok: true,
      ...importCollectionBatch(String(body.collection || ""), body.documents, { reset: body.reset === true }),
    });
  } catch (error) {
    return sendJson(res, { error: error.message }, 400);
  }
}

export async function handlePlembfinBackups(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;

  if (req.method === "GET") {
    const filename = String(req.query?.download || "").trim();
    if (!filename) {
      return sendJson(res, plembfinBackupStatus());
    }
    try {
      const file = readPlembfinBackupFile(filename);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      const buffer = Buffer.from(file.content, "utf8");
      res.setHeader("Content-Length", String(buffer.length));
      return res.end(buffer);
    } catch (error) {
      return sendJson(res, { error: error.message }, 404);
    }
  }

  if (req.method !== "POST") return methodNotAllowed(res);
  const body = await readJson(req);
  const action = String(body.action || "").trim();
  try {
    if (action === "configure") {
      return sendJson(res, { ok: true, config: savePlembfinBackupConfig(body.config || {}) });
    }
    if (action === "create") {
      const passphrase = String(body.passphrase || "").trim();
      return sendJson(res, { ok: true, backup: await createPlembfinBackup({ reason: "manual", passphrase }) });
    }
    if (action === "delete") {
      const filename = String(body.filename || "").trim();
      if (!filename) return sendJson(res, { error: "filename is required" }, 400);
      return sendJson(res, { ok: true, ...deletePlembfinBackup(filename) });
    }
    return sendJson(res, { error: `Unsupported action: ${action}` }, 400);
  } catch (error) {
    return sendJson(res, { error: error.message }, 500);
  }
}

// In-memory pending OneDrive device-code sessions (pendingId -> session). Short-lived
// and intentionally not persisted; a server restart simply cancels an in-flight login.
const deviceCodeSessions = new Map();

async function startOneDriveDeviceAuth(destination) {
  const clientId = destination.settings?.clientId;
  if (!clientId) throw new Error("Enter and save the OneDrive client ID first");
  const tenant = destination.settings?.tenant;
  const params = new URLSearchParams({ client_id: clientId, scope: ONEDRIVE_SCOPE });
  const response = await fetchWithTimeout(deviceCodeEndpoint(tenant), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  }, 15_000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || `Device code request failed (${response.status})`);

  // Drop expired sessions (otherwise they only leave the map when polled).
  for (const [id, session] of deviceCodeSessions) {
    if (session.expiresAt < Date.now()) deviceCodeSessions.delete(id);
  }
  const pendingId = crypto.randomUUID();
  deviceCodeSessions.set(pendingId, {
    destinationId: destination.id,
    clientId,
    tenant,
    deviceCode: data.device_code,
    expiresAt: Date.now() + (Number(data.expires_in) || 900) * 1000,
  });
  return {
    pendingId,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: Number(data.interval) || 5,
    expiresIn: Number(data.expires_in) || 900,
    message: data.message,
  };
}

async function pollOneDriveDeviceAuth(pendingId) {
  const session = deviceCodeSessions.get(pendingId);
  if (!session) return { status: "error", error: "Login session expired â€” start again" };
  if (session.expiresAt < Date.now()) {
    deviceCodeSessions.delete(pendingId);
    return { status: "error", error: "Login code expired â€” start again" };
  }
  const params = new URLSearchParams({
    client_id: session.clientId,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: session.deviceCode,
  });
  const response = await fetchWithTimeout(tokenEndpoint(session.tenant), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  }, 15_000);
  const data = await response.json().catch(() => ({}));
  if (response.ok && data.refresh_token) {
    updateDestinationSecrets(session.destinationId, { refreshToken: data.refresh_token });
    deviceCodeSessions.delete(pendingId);
    return { status: "authorized" };
  }
  if (data.error === "authorization_pending" || data.error === "slow_down") return { status: "pending" };
  deviceCodeSessions.delete(pendingId);
  return { status: "error", error: data.error_description || data.error || "Authorization failed" };
}

// Dropbox manual (no-redirect) OAuth: the authorize page shows a code the user pastes
// back, so no public callback URL is required for self-hosted installs.
function dropboxAuthorizeUrl(destination) {
  const appKey = destination.settings?.appKey;
  if (!appKey) throw new Error("Enter and save the Dropbox app key first");
  const params = new URLSearchParams({
    client_id: appKey,
    response_type: "code",
    token_access_type: "offline",
  });
  return `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeDropboxCode(destination, code) {
  const appKey = destination.settings?.appKey;
  const appSecret = destination.secrets?.appSecret;
  if (!appKey || !appSecret) throw new Error("Save the Dropbox app key and secret first");
  if (!code) throw new Error("Authorization code is required");
  const basic = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
  const params = new URLSearchParams({ grant_type: "authorization_code", code: String(code).trim() });
  const response = await fetchWithTimeout("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  }, 15_000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.refresh_token) {
    throw new Error(data.error_description || data.error || "Dropbox authorization failed");
  }
  updateDestinationSecrets(destination.id, { refreshToken: data.refresh_token });
  return { status: "authorized" };
}

// Small forward cushion so an app-recorded "viewedAt" stamped a moment after our push
// can't land just past lastRestoreAt and get re-imported. See setLastRestoreAt().
const RESTORE_SKEW_BUFFER_MS = 5000;
const POST_RESTORE_WEBHOOK_GUARD_MS = 24 * 60 * 60 * 1000;
// How many items the restore push/clear processes at once, and the per-item timeout so a single
// hung app call can't stall the whole job.
const RESTORE_PUSH_CONCURRENCY = Math.min(Math.max(Number(process.env.PLEMBFIN_RESTORE_CONCURRENCY || 24), 1), 64);
const RESTORE_ITEM_TIMEOUT_MS = 30000;

function normalizedTitlePart(value = "") {
  return String(value || "").trim().toLowerCase();
}

function mediaIdsOverlap(a = {}, b = {}) {
  const idsA = a.ids || {};
  const idsB = b.ids || {};
  return Boolean(
    (idsA.imdb && idsB.imdb && String(idsA.imdb) === String(idsB.imdb)) ||
      (idsA.tmdb && idsB.tmdb && String(idsA.tmdb) === String(idsB.tmdb)) ||
      (idsA.tvdb && idsB.tvdb && String(idsA.tvdb) === String(idsB.tvdb)),
  );
}

function sameMediaCoordinates(a = {}, b = {}) {
  if (String(a.source || "") !== String(b.source || "")) return false;
  if (String(a.type || a.mediaType || "") !== String(b.type || b.mediaType || "")) return false;
  if (String(a.type || a.mediaType || "") === "episode") {
    if (Number(a.season ?? -1) !== Number(b.season ?? -1)) return false;
    if (Number(a.episode ?? -1) !== Number(b.episode ?? -1)) return false;
  }
  return mediaIdsOverlap(a, b) || normalizedTitlePart(a.title) === normalizedTitlePart(b.title);
}

export async function shouldSkipPostRestoreCompletedWebhook(media) {
  if (media?.phase !== "completed") return false;
  const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
  if (!lastRestoreAt || Date.now() - lastRestoreAt > POST_RESTORE_WEBHOOK_GUARD_MS) return false;

  const activeSessions = await listActiveSessions().catch(() => []);
  const matchingActiveSession = activeSessions.find((session) => (
    sameMediaCoordinates(media, {
      title: session.title,
      type: session.mediaType,
      source: session.source,
      ids: session.ids,
      season: session.season,
      episode: session.episode,
    }) && Number(session.updatedAt || 0) > lastRestoreAt
  ));

  return !matchingActiveSession;
}

function withTimeout(promise, ms, label) {
  const p = Promise.resolve(promise);
  // If the timeout wins the race, the underlying promise may still reject later with nobody
  // awaiting it â€” absorb that so it doesn't surface as an unhandledRejection.
  p.catch(() => {});
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms${label ? `: ${label}` : ""}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Run `worker(item)` over `items` with at most `limit` in flight. The worker is expected to handle
// (count) its own errors; this resolves once every item has been processed.
async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  const runnerCount = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: runnerCount }, async () => {
    while (index < items.length) {
      const current = index++;
      await worker(items[current], current);
    }
  });
  await Promise.all(runners);
}

// Batched runtime-log writer (mirrors the Force-Sync pattern): collect lines in memory and
// flush to runtime_state every `intervalMs` so we don't write per line.
function createBatchedRuntimeLogger(field, { intervalMs = 2000 } = {}) {
  const buffer = [];
  let timer = null;
  const flush = async () => {
    if (!buffer.length) return;
    const batch = buffer.splice(0, buffer.length);
    await appendRuntimeLog(field, batch).catch(() => null);
  };
  const log = (msg) => {
    console.log(msg);
    buffer.push(msg);
    if (!timer) {
      timer = setTimeout(async () => {
        timer = null;
        await flush();
      }, intervalMs);
    }
  };
  const stop = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    await flush();
  };
  return { log, stop };
}

function mediaFromPlaystateRow(row) {
  const media = {
    title: row.title,
    type: row.media_type,
    source: "restore",
    isValid: true,
    ids: {
      imdb: row.imdb_id || undefined,
      tmdb: row.tmdb_id || undefined,
      tvdb: row.tvdb_id || undefined,
    },
  };
  if (String(row.media_type) === "episode") {
    media.season = row.season != null ? Number(row.season) : undefined;
    media.episode = row.episode != null ? Number(row.episode) : undefined;
  }
  return media;
}

// Push the just-restored playstate to every connected app. `source: "restore"` makes
// getTargetsForSource fan out to all three platforms.
async function pushRestoredStateToApps(config, logLine) {
  const loopStore = createLoopStore();
  const rows = requireDb().prepare("SELECT * FROM playstate").all();
  logLine(`Pushing ${rows.length} restored item(s) to connected apps (concurrency ${RESTORE_PUSH_CONCURRENCY})...`);
  let done = 0;
  let watched = 0;
  let unwatched = 0;
  let failed = 0;
  await runWithConcurrency(rows, RESTORE_PUSH_CONCURRENCY, async (row) => {
    const media = mediaFromPlaystateRow(row);
    const isWatched = String(row.state || "watched").toLowerCase() !== "unwatched";
    try {
      if (isWatched) {
        await withTimeout(syncMediaPlaystate(media, config, loopStore), RESTORE_ITEM_TIMEOUT_MS, media.title);
        watched++;
      } else {
        await withTimeout(syncMediaUnplayedPlaystate(media, config, loopStore), RESTORE_ITEM_TIMEOUT_MS, media.title);
        unwatched++;
      }
    } catch (error) {
      failed++;
      logLine(`  ! Failed to push "${media.title}": ${error.message}`);
    }
    done++;
    if (done % 25 === 0 || done === rows.length) {
      logLine(`  Pushed ${done}/${rows.length} (watched ${watched}, unwatched ${unwatched}, failed ${failed})`);
    }
  });
  return { total: rows.length, watched, unwatched, failed };
}

// Full-wipe clear pass: mark every item each app currently reports as watched as unwatched,
// so that the subsequent push re-marks only the backup's watched set and the apps end up
// matching the backup exactly. Operates on native item ids (no re-resolution).
async function clearAppWatchstates(config, logLine) {
  const summary = { plex: 0, emby: 0, jellyfin: 0, failed: 0 };
  const plexActive = !config?.plex?.disabled && Boolean(config?.plex?.baseUrl && config?.plex?.token);
  const embyActive = !config?.emby?.disabled && Boolean(config?.emby?.baseUrl && config?.emby?.apiKey && config?.emby?.userId);
  const jellyfinActive = !config?.jellyfin?.disabled && Boolean(config?.jellyfin?.baseUrl && config?.jellyfin?.apiKey && config?.jellyfin?.userId);

  // Mark one platform's watched items unplayed, in parallel with a per-item timeout.
  const clearPlatform = async (items, getId, unmark) => {
    let cleared = 0;
    let failed = 0;
    await runWithConcurrency(items, RESTORE_PUSH_CONCURRENCY, async (item) => {
      try {
        await withTimeout(unmark(getId(item)), RESTORE_ITEM_TIMEOUT_MS);
        cleared++;
      } catch (error) {
        failed++;
      }
    });
    return { cleared, failed };
  };

  if (plexActive) {
    try {
      const items = await fetchPlexWatchedItems(config.plex);
      logLine(`Clearing ${items.length} watched item(s) on Plex...`);
      const r = await clearPlatform(items, (i) => i.ratingKey || i.key, (id) => markPlexUnplayedByRatingKey(config.plex, id));
      summary.plex = r.cleared;
      summary.failed += r.failed;
    } catch (error) {
      logLine(`  ! Plex clear failed: ${error.message}`);
    }
  }
  if (embyActive) {
    try {
      const items = await fetchEmbyWatchedItems(config.emby);
      logLine(`Clearing ${items.length} watched item(s) on Emby...`);
      const r = await clearPlatform(items, (i) => i.Id, (id) => markEmbyUnplayedById(config.emby, id));
      summary.emby = r.cleared;
      summary.failed += r.failed;
    } catch (error) {
      logLine(`  ! Emby clear failed: ${error.message}`);
    }
  }
  if (jellyfinActive) {
    try {
      const items = await fetchJellyfinWatchedItems(config.jellyfin);
      logLine(`Clearing ${items.length} watched item(s) on Jellyfin...`);
      const r = await clearPlatform(items, (i) => i.Id, (id) => markJellyfinUnplayedById(config.jellyfin, id));
      summary.jellyfin = r.cleared;
      summary.failed += r.failed;
    } catch (error) {
      logLine(`  ! Jellyfin clear failed: ${error.message}`);
    }
  }
  return summary;
}

// Background reconcile job, kicked off after the synchronous DB restore. Optionally wipes app
// watchstates, pushes the restored state to all apps, then stamps lastRestoreAt (AFTER the push
// so the pushes themselves fall under the cron's pre-restore filter) and clears the active flag.
async function runRestoreReconcileJob(clearMode) {
  const { log, stop } = createBatchedRuntimeLogger("restoreSyncLog");
  // Keep the restore guard's heartbeat fresh for the entire job so the cron never treats a
  // long-but-alive restore as stale and un-blocks itself mid-push. Fires independently of where
  // the job is (even inside a long library fetch).
  await setRuntimeState({ restoreSyncHeartbeat: Date.now() }).catch(() => null);
  const heartbeat = setInterval(() => {
    setRuntimeState({ restoreSyncHeartbeat: Date.now() }).catch(() => null);
  }, 30000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();
  let result;
  try {
    const config = await loadMediaConfig();
    if (clearMode === "wipe") {
      log("Clear mode: full wipe â€” marking every watched item on each app as unwatched.");
      const cleared = await clearAppWatchstates(config, log);
      log(`Clear complete: Plex ${cleared.plex}, Emby ${cleared.emby}, Jellyfin ${cleared.jellyfin}, failed ${cleared.failed}.`);
    } else {
      log("Clear mode: reconcile â€” pushing only items tracked by the backup.");
    }
    const pushed = await pushRestoredStateToApps(config, log);
    log(`Push complete: ${pushed.watched} watched, ${pushed.unwatched} unwatched, ${pushed.failed} failed.`);
    result = { success: true, clearMode, pushed };
  } catch (error) {
    log(`ERROR: Restore reconcile failed: ${error.message}`);
    result = { success: false, error: error.message };
  } finally {
    clearInterval(heartbeat);
    // Always advance the watermark: after a successful DB restore the local DB IS the backup,
    // so the cron should ignore any app history at/before now regardless of push outcome.
    const stampedAt = Date.now() + RESTORE_SKEW_BUFFER_MS;
    setLastRestoreAt(stampedAt);
    log(`Stamped lastRestoreAt = ${new Date(stampedAt).toISOString()}; cron will skip app history up to this point.`);
    log("âœ“ Authoritative restore complete.");
    await stop();
    // Clear the active flag LAST (after lastRestoreAt is stamped) so the first allowed cron tick
    // already sees the watermark.
    await setRuntimeState({ restoreSyncActive: false, restoreSyncResult: result || { success: false } }).catch(() => null);
  }
  return result;
}

// Run the synchronous DB restore, then kick off the background clear/push job. Shared by the
// local "restore" and remote "restore-remote-backup" actions. Returns the response payload.
async function startAuthoritativeRestore(filename, clearMode) {
  const runtime = await loadRuntimeState();
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  if (runtime.restoreSyncActive === true && runtime.restoreSyncStartedAt && runtime.restoreSyncStartedAt > tenMinutesAgo) {
    return { status: 409, body: { ok: false, error: "An authoritative restore is already running." } };
  }

  // Mark active BEFORE touching the DB so the cron + webhook stop importing immediately.
  await setRuntimeState({
    restoreSyncActive: true,
    restoreSyncStartedAt: Date.now(),
    restoreSyncHeartbeat: Date.now(),
    restoreSyncResult: null,
    restoreSyncLog: [`Authoritative restore started (${clearMode}) from ${filename}...`],
  });

  let restore;
  try {
    restore = restoreWatchHistoryBackup(filename, { mode: "replace", dryRun: false });
    writeAuditLog("backup.restored", { detail: { filename, clearMode, records: restore?.imported } });
  } catch (error) {
    await setRuntimeState({ restoreSyncActive: false, restoreSyncResult: { success: false, error: error.message } }).catch(() => null);
    return { status: 400, body: { error: error.message } };
  }

  // Fire-and-forget â€” the job stamps lastRestoreAt and clears the flag when it finishes.
  runRestoreReconcileJob(clearMode);

  return { status: 202, body: { ok: true, restore, clearMode, jobStarted: true } };
}

export async function handleWatchBackups(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;

  if (req.method === "GET") {
    const filename = String(req.query?.download || "").trim();
    if (!filename) {
      const runtime = await loadRuntimeState();
      return sendJson(res, {
        ...watchBackupStatus(),
        restoreSync: {
          active: runtime.restoreSyncActive === true,
          log: Array.isArray(runtime.restoreSyncLog) ? runtime.restoreSyncLog : [],
          result: runtime.restoreSyncResult || null,
          startedAt: runtime.restoreSyncStartedAt || null,
        },
      });
    }
    try {
      const file = readWatchBackupFile(filename);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", String(file.compressed.length));
      res.setHeader("X-Content-SHA256", file.checksum);
      return res.end(file.compressed);
    } catch (error) {
      return sendJson(res, { error: error.message }, 404);
    }
  }

  if (req.method !== "POST") return methodNotAllowed(res);
  if (String(req.query?.upload || "") === "1") {
    try {
      const uploaded = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
      const filename = String(req.query?.filename || "");
      return sendJson(res, { ok: true, file: importWatchHistoryBackupFile({ filename, buffer: uploaded }) });
    } catch (error) {
      return sendJson(res, { error: error.message }, 400);
    }
  }

  const body = await readJson(req);
  const action = String(body.action || "").trim();
  try {
    if (action === "configure") {
      return sendJson(res, { ok: true, config: saveWatchBackupConfig(body.config || {}) });
    }
    if (action === "create") {
      return sendJson(res, { ok: true, backup: await createWatchHistoryBackup({ reason: "manual" }) });
    }
    if (action === "restore") {
      const filename = String(body.filename || "").trim();
      if (!filename) return sendJson(res, { error: "filename is required" }, 400);

      const dryRun = body.dryRun === true;
      if (dryRun) {
        // Replace-only: restore is always authoritative; merge is no longer offered.
        return sendJson(res, {
          ok: true,
          restore: restoreWatchHistoryBackup(filename, { mode: "replace", dryRun: true }),
        });
      }

      const clearMode = body.clearMode === "wipe" ? "wipe" : "reconcile";
      const { status, body: payload } = await startAuthoritativeRestore(filename, clearMode);
      return sendJson(res, payload, status);
    }
    if (action === "save-destination") {
      return sendJson(res, { ok: true, destination: saveBackupDestination(body.destination || {}) });
    }
    if (action === "remove-destination") {
      const id = String(body.destinationId || "").trim();
      if (!id) return sendJson(res, { error: "destinationId is required" }, 400);
      return sendJson(res, { ok: true, ...removeBackupDestination(id) });
    }
    if (action === "list-remote-backups") {
      const id = String(body.destinationId || "").trim();
      if (!id) return sendJson(res, { error: "destinationId is required" }, 400);
      return sendJson(res, { ok: true, files: await listRemoteBackups(id) });
    }
    if (action === "restore-remote-backup") {
      const id = String(body.destinationId || "").trim();
      const filename = String(body.filename || "").trim();
      const remoteDryRun = body.dryRun === true;
      if (!id || !filename) return sendJson(res, { error: "destinationId and filename are required" }, 400);
      const pulled = await pullRemoteBackupToLocal(id, filename);
      if (remoteDryRun) {
        return sendJson(res, {
          ok: true,
          pulled,
          restore: restoreWatchHistoryBackup(pulled.name, { mode: "replace", dryRun: true }),
        });
      }
      const clearMode = body.clearMode === "wipe" ? "wipe" : "reconcile";
      const { status, body: payload } = await startAuthoritativeRestore(pulled.name, clearMode);
      return sendJson(res, { ...payload, pulled }, status);
    }
    if (action === "clear-restore-status") {
      return sendJson(res, { ok: true, ...clearRestoreStatus() });
    }
    if (action === "pause-cron") {
      const hours = Math.max(1, Math.min(48, Number(body.hours) || 12));
      return sendJson(res, { ok: true, ...pauseCronSync(hours * 3600000) });
    }
    if (action === "resume-cron") {
      return sendJson(res, { ok: true, ...resumeCronSync() });
    }
    if (["test-destination", "device-start", "device-poll", "oauth-url", "oauth-exchange"].includes(action)) {
      if (action === "device-poll") {
        return sendJson(res, { ok: true, ...(await pollOneDriveDeviceAuth(String(body.pendingId || ""))) });
      }
      const destination = getBackupDestination(String(body.destinationId || "").trim());
      if (!destination) return sendJson(res, { error: "Destination not found" }, 404);
      if (action === "test-destination") {
        return sendJson(res, { ok: true, result: await testBackupDestination(destination) });
      }
      if (action === "device-start") {
        return sendJson(res, { ok: true, ...(await startOneDriveDeviceAuth(destination)) });
      }
      if (action === "oauth-url") {
        return sendJson(res, { ok: true, url: dropboxAuthorizeUrl(destination) });
      }
      if (action === "oauth-exchange") {
        return sendJson(res, { ok: true, ...(await exchangeDropboxCode(destination, body.code)) });
      }
    }
    return sendJson(res, { error: "Unknown watch backup action" }, 400);
  } catch (error) {
    return sendJson(res, { error: error.message }, 400);
  }
}
