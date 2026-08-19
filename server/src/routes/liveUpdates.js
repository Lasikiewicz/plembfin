import { getDataVersion } from "../db.js";
import { requireAdmin } from "../utils/auth.js";
import { methodNotAllowed } from "../utils/http.js";
import { loadRuntimeState } from "../utils/configStore.js";

const VERSION_CHECK_MS = 250;
const SYNC_PROGRESS_CHECK_MS = 1_000;
const HEARTBEAT_MS = 15_000;

function writeEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Streams the shared SQLite history version rather than relying on an
// in-process event emitter. This keeps browser updates working when Plembfin's
// web and scheduler roles run in separate processes.
export async function handleLiveUpdates(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let lastVersion = getDataVersion();
  let lastWriteAt = Date.now();
  writeEvent(res, { type: "ready", version: lastVersion });

  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    const version = getDataVersion();
    if (version !== lastVersion) {
      lastVersion = version;
      lastWriteAt = Date.now();
      writeEvent(res, { type: "history-version", version });
      return;
    }
    if (Date.now() - lastWriteAt >= HEARTBEAT_MS) {
      lastWriteAt = Date.now();
      res.write(": heartbeat\n\n");
    }
  }, VERSION_CHECK_MS);
  timer.unref?.();

  // The pending-dispatch backlog (scheduled.js's syncPendingManualDispatches)
  // writes its snapshot to runtime_state so this works across a split
  // web/worker deployment too, the same reason the history version above
  // reads shared SQLite rather than an in-process emitter. Polled on its own
  // slower interval since it's a DB read, not the cheap in-process counter
  // getDataVersion() uses; syncInFlight guards against a slow read piling up
  // if it ever takes longer than the poll interval.
  let lastSyncProgress = { total: 0, completed: 0 };
  let syncProgressInFlight = false;
  const syncProgressTimer = setInterval(() => {
    if (res.writableEnded || res.destroyed || syncProgressInFlight) return;
    syncProgressInFlight = true;
    loadRuntimeState()
      .then((runtime) => {
        const progress = runtime?.backgroundSyncProgress || { total: 0, completed: 0 };
        const total = Number(progress.total) || 0;
        const completed = Number(progress.completed) || 0;
        if (total === lastSyncProgress.total && completed === lastSyncProgress.completed) return;
        lastSyncProgress = { total, completed };
        if (!res.writableEnded && !res.destroyed) {
          writeEvent(res, { type: "sync-progress", total, completed });
        }
      })
      .catch(() => null)
      .finally(() => { syncProgressInFlight = false; });
  }, SYNC_PROGRESS_CHECK_MS);
  syncProgressTimer.unref?.();

  const close = () => {
    clearInterval(timer);
    clearInterval(syncProgressTimer);
  };
  req.once("close", close);
  res.once("close", close);
}
