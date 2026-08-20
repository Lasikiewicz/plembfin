import { getDataVersion } from "../db.js";
import { requireAdmin } from "../utils/auth.js";
import { methodNotAllowed } from "../utils/http.js";
import { loadRuntimeState } from "../utils/configStore.js";

const POLL_MS = 250;
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
  let lastSyncProgress = { total: 0, completed: 0 };
  let pollInFlight = false;
  writeEvent(res, { type: "ready", version: lastVersion });

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
    loadRuntimeState()
      .then((runtime) => {
        if (res.writableEnded || res.destroyed) return;

        // --- Sync progress ---
        const progress = runtime?.backgroundSyncProgress || { total: 0, completed: 0 };
        const syncTotal = Number(progress.total) || 0;
        const syncCompleted = Number(progress.completed) || 0;
        const syncProgressChanged =
          syncTotal !== lastSyncProgress.total || syncCompleted !== lastSyncProgress.completed;
        if (syncProgressChanged) {
          lastSyncProgress = { total: syncTotal, completed: syncCompleted };
        }

        // --- History version ---
        const version = getDataVersion();
        if (version !== lastVersion) {
          lastVersion = version;
          lastWriteAt = Date.now();
          // Include current sync state so the client knows whether a background
          // sync is active before it decides to act on the version change.
          writeEvent(res, { type: "history-version", version, syncTotal, syncCompleted });
          return;
        }

        // No version bump — emit a sync-progress-only update if progress changed.
        if (syncProgressChanged) {
          writeEvent(res, { type: "sync-progress", total: syncTotal, completed: syncCompleted });
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
