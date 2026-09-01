import { getDataVersion, getDiscoverVersion, getUpNextVersion } from "../db.js";
import { requireAdmin } from "../utils/auth.js";
import { methodNotAllowed } from "../utils/http.js";
import { loadBackgroundSyncProgress } from "../utils/configStore.js";

const POLL_MS = 250;
const HEARTBEAT_MS = 15_000;

function writeEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
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
  const initialProgress = await loadBackgroundSyncProgress();
  const initialSyncTotal = Number(initialProgress.total) || 0;
  const initialSyncCompleted = Number(initialProgress.completed) || 0;
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
  let lastSyncProgress = { total: initialSyncTotal, completed: initialSyncCompleted };
  let pollInFlight = false;
  writeEvent(res, {
    type: "ready",
    version: lastVersion,
    discoverVersion: lastDiscoverVersion,
    upNextVersion: lastUpNextVersion,
    syncTotal: initialSyncTotal,
    syncCompleted: initialSyncCompleted,
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
    loadBackgroundSyncProgress()
      .then((progress) => {
        if (res.writableEnded || res.destroyed) return;

        // --- Sync progress ---
        const syncTotal = Number(progress.total) || 0;
        const syncCompleted = Number(progress.completed) || 0;
        const syncProgressChanged =
          syncTotal !== lastSyncProgress.total || syncCompleted !== lastSyncProgress.completed;
        if (syncProgressChanged) {
          lastSyncProgress = { total: syncTotal, completed: syncCompleted };
        }

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
          writeEvent(res, { type: "history-version", version, discoverVersion, upNextVersion, syncTotal, syncCompleted });
          return;
        }

        if (discoverVersionChanged) {
          lastWriteAt = Date.now();
          writeEvent(res, { type: "discover-version", discoverVersion });
          return;
        }

        if (upNextVersion !== lastUpNextVersion) {
          lastUpNextVersion = upNextVersion;
          lastWriteAt = Date.now();
          writeEvent(res, { type: "up-next-version", upNextVersion });
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
