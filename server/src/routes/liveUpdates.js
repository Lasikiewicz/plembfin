import { getDataVersion, getDiscoverVersion, getUpNextVersion } from "../db.js";
import { requireAdmin } from "../utils/auth.js";
import { methodNotAllowed } from "../utils/http.js";
import {
  activeSyncOperation,
  loadBackgroundSyncProgress,
  loadRuntimeState,
  syncOperationIsFresh,
} from "../utils/configStore.js";
import { getOnboardingState } from "../utils/onboardingStore.js";
import { syncAttentionState } from "../utils/syncAttention.js";

const POLL_MS = 250;
const HEARTBEAT_MS = 15_000;

function writeEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function onboardingImportIsActive() {
  const onboarding = getOnboardingState();
  const serverImports = Object.values(onboarding.backgroundImports?.servers || {});
  const imports = [...serverImports, onboarding.backgroundImports?.trakt];
  return imports.some((entry) => entry?.status === "importing" && entry?.enabled !== false);
}

function labelForSyncOperation(operation) {
  switch (operation?.kind) {
    case "scheduled_sync": return "Scanning";
    case "force_sync": return "Syncing";
    case "rebuild": return "Rebuilding";
    case "full_sync_watchstates":
    case "backup_restore":
    case "restore": return "Restoring";
    default: return operation ? "Working" : "";
  }
}

// The original progress counter tracks outbound dispatch bursts. Initial
// library imports and the scheduled library scan can be doing real work while
// that counter is empty, so the dashboard needs the broader operation state as
// well. Keep this snapshot read-only and sourced from the same shared stores as
// the existing SSE progress so split web/worker deployments agree.
async function loadSyncStatus() {
  const [progress, runtime] = await Promise.all([
    loadBackgroundSyncProgress(),
    loadRuntimeState(),
  ]);
  const total = Number(progress.total) || 0;
  const completed = Number(progress.completed) || 0;
  const dispatchActive = total > 0 && completed < total;
  const operation = syncOperationIsFresh(runtime) ? activeSyncOperation(runtime) : null;
  const importing = onboardingImportIsActive();
  const active = importing || Boolean(operation) || dispatchActive;
  const attention = syncAttentionState(runtime, getOnboardingState());
  return {
    total,
    completed,
    active,
    label: importing ? "Importing" : labelForSyncOperation(operation) || (dispatchActive ? "Syncing" : ""),
    attentionCount: attention.count,
    attentionStatus: attention.status,
  };
}

function syncEventFields(status) {
  return {
    syncTotal: status.total,
    syncCompleted: status.completed,
    syncActive: status.active,
    syncLabel: status.label,
    syncAttentionCount: status.attentionCount,
    syncAttentionStatus: status.attentionStatus,
  };
}

// Streams shared SQLite cache versions rather than relying on an in-process
// event emitter. This keeps browser updates working when Plembfin's web and
// scheduler roles run in separate processes.
export async function handleLiveUpdates(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  // Send a complete progress snapshot in `ready`, before the browser is
  // allowed to react to a version change. This matters on reconnect: the tab
  // still holds its previous sync-busy flag until this new stream corrects it.
  const initialSyncStatus = await loadSyncStatus();
  const initialVersion = getDataVersion();
  const initialDiscoverVersion = getDiscoverVersion();
  const initialUpNextVersion = getUpNextVersion();

  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let lastVersion = initialVersion;
  let lastDiscoverVersion = initialDiscoverVersion;
  let lastUpNextVersion = initialUpNextVersion;
  let lastWriteAt = Date.now();
  let lastSyncStatus = initialSyncStatus;
  let pollInFlight = false;
  writeEvent(res, {
    type: "ready",
    version: lastVersion,
    discoverVersion: lastDiscoverVersion,
    upNextVersion: lastUpNextVersion,
    ...syncEventFields(initialSyncStatus),
  });

  // Single poll loop: checks both history version and sync-progress every
  // POLL_MS in one pass. When a version bump is detected, the current
  // sync-progress is piggy-backed onto the history-version event (as
  // syncTotal/syncCompleted) so the client can update its sync-busy flag
  // *before* deciding whether to queue a dashboard refresh — closing the
  // race where a version bump fired a refresh before the sync-progress
  // poll interval had a chance to catch up.
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed || pollInFlight) return;
    pollInFlight = true;
    loadSyncStatus()
      .then((syncStatus) => {
        if (res.writableEnded || res.destroyed) return;

        // --- Sync progress ---
        const syncProgressChanged =
          syncStatus.total !== lastSyncStatus.total
          || syncStatus.completed !== lastSyncStatus.completed
          || syncStatus.active !== lastSyncStatus.active
          || syncStatus.label !== lastSyncStatus.label
          || syncStatus.attentionCount !== lastSyncStatus.attentionCount
          || syncStatus.attentionStatus !== lastSyncStatus.attentionStatus;
        if (syncProgressChanged) lastSyncStatus = syncStatus;

        // --- History version ---
        const version = getDataVersion();
        const discoverVersion = getDiscoverVersion();
        const upNextVersion = getUpNextVersion();
        const discoverVersionChanged = discoverVersion !== lastDiscoverVersion;
        if (discoverVersionChanged) lastDiscoverVersion = discoverVersion;
        if (version !== lastVersion) {
          lastVersion = version;
          lastUpNextVersion = upNextVersion;
          lastWriteAt = Date.now();
          // Include current sync state so the client knows whether a background
          // sync is active before it decides to act on the version change.
          writeEvent(res, { type: "history-version", version, discoverVersion, upNextVersion, ...syncEventFields(syncStatus) });
          return;
        }

        if (discoverVersionChanged) {
          lastWriteAt = Date.now();
          writeEvent(res, { type: "discover-version", discoverVersion, ...syncEventFields(syncStatus) });
          return;
        }

        if (upNextVersion !== lastUpNextVersion) {
          lastUpNextVersion = upNextVersion;
          lastWriteAt = Date.now();
          writeEvent(res, { type: "up-next-version", upNextVersion, ...syncEventFields(syncStatus) });
          return;
        }

        // No version bump — emit a sync-progress-only update if progress changed.
        if (syncProgressChanged) {
          writeEvent(res, {
            type: "sync-progress",
            total: syncStatus.total,
            completed: syncStatus.completed,
            active: syncStatus.active,
            label: syncStatus.label,
            ...syncEventFields(syncStatus),
          });
          return;
        }

        if (Date.now() - lastWriteAt >= HEARTBEAT_MS) {
          lastWriteAt = Date.now();
          res.write(": heartbeat\n\n");
        }
      })
      .catch(() => null)
      .finally(() => { pollInFlight = false; });
  }, POLL_MS);
  timer.unref?.();

  const close = () => clearInterval(timer);
  req.once("close", close);
  res.once("close", close);
}
