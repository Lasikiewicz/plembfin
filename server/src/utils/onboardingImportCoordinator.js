// Coordinates the safe, additive background pulls onboarding offers per
// connected server and for Trakt. Deliberately reuses already-tested sync
// code rather than any new watched-item ingestion path:
//   - Per-server pulls call forceSyncLibraryState({ mode: "pull", source })
//     (server/src/utils/libraryForceSync.js) - the same "Import Watched
//     Status" pull already offered from Settings -> Sync -> Force Sync.
//   - The Trakt baseline snapshot calls pollConnectedTrackers({ reconcile })
//     (server/src/utils/trackerSync.js) - the same first-sync path the
//     regular Trakt poll cycle uses once a connection's baselineComplete is
//     false.
// Both are read-only pulls into Plembfin's local watch_history - neither
// pushes anything outward - so, unlike the global "force_sync" operation
// lock, running several of these at once (e.g. Plex and Jellyfin together)
// is safe. Each import still checks activeSyncOperation() first and refuses
// to start while an unrelated push/scheduled sync is actively running, since
// forceSyncLibraryState() shares the same outbound client/rate-limit state.
import { forceSyncLibraryState } from "./libraryForceSync.js";
import { pollConnectedTrackers } from "./trackerSync.js";
import { activeSyncOperation, loadRuntimeState, SYNC_OPERATION_SCHEDULED } from "./configStore.js";
import { countTrackerItemStates } from "./trackerConnectionRepo.js";
import { getOnboardingState, saveOnboardingState } from "./onboardingStore.js";

const MEDIA_SERVERS = ["plex", "emby", "jellyfin"];
const cancelTokens = new Map();

function patchServerImport(provider, patch) {
  const state = getOnboardingState();
  const servers = { ...state.backgroundImports.servers, [provider]: { ...(state.backgroundImports.servers[provider] || {}), ...patch } };
  return saveOnboardingState({ backgroundImports: { ...state.backgroundImports, servers } });
}

function patchTraktImport(patch) {
  const state = getOnboardingState();
  return saveOnboardingState({
    backgroundImports: { ...state.backgroundImports, trakt: { ...state.backgroundImports.trakt, ...patch } },
  });
}

// The routine per-minute scheduled sync tick shares outbound client/rate-
// limit state with forceSyncLibraryState (see the module comment), so a pull
// intentionally refuses to start while one is actively running - unlike the
// Trakt reconcile above, that guard cannot simply be exempted here. A tick is
// budgeted at 45s and recurs every ~60s, so it clears on its own quickly.
const SCHEDULED_LOCK_RETRY_DELAY_MS = 5_000;
const SCHEDULED_LOCK_MAX_WAIT_MS = 120_000;
// Trakt connects (and its reconcile pass runs) before the media servers
// specifically so its watch dates can take priority once the servers pull -
// see loadTraktWatchedDateIndex in mediaForceSync.js. That reconcile can
// legitimately run for many minutes on a large account, far longer than the
// scheduled-sync wait above covers, so it gets its own much longer cap.
const TRAKT_WAIT_RETRY_DELAY_MS = 5_000;
const TRAKT_WAIT_MAX_MS = 30 * 60_000;

// This wait is deliberately server-side, not something the caller polls for
// and re-triggers itself: onboarding previously queued this from the browser
// tab's own JS timer, which silently evaporated on any page reload or
// navigation, leaving the UI showing "Importing" with nothing actually
// running behind it. Retrying via a real server-side timer survives that.
export async function startServerImport(provider, { lockWaitStartedAt = Date.now(), traktWaitStartedAt = Date.now() } = {}) {
  if (!MEDIA_SERVERS.includes(provider)) throw new Error("Unsupported provider");
  const waitToken = cancelTokens.get(`server:${provider}`) || { cancelled: false };
  cancelTokens.set(`server:${provider}`, waitToken);
  if (waitToken.cancelled) return { started: false, code: "CANCELLED" };

  const traktImport = getOnboardingState().backgroundImports.trakt;
  const traktStillImporting = traktImport?.enabled !== false && traktImport?.status === "importing";
  if (traktStillImporting) {
    if (Date.now() - traktWaitStartedAt < TRAKT_WAIT_MAX_MS) {
      patchServerImport(provider, { enabled: true, status: "importing", error: null });
      setTimeout(() => {
        if (waitToken.cancelled) return;
        startServerImport(provider, { lockWaitStartedAt, traktWaitStartedAt }).catch(() => {});
      }, TRAKT_WAIT_RETRY_DELAY_MS);
      return { started: false, code: "TRAKT_IMPORTING_RETRYING" };
    }
    // After 30 minutes, stop waiting and proceed anyway - Trakt's own poll
    // cycle continues the reconcile regardless, and this server's watched
    // dates are still better than none.
  }

  const runtime = await loadRuntimeState();
  if (activeSyncOperation(runtime)) {
    if (Date.now() - lockWaitStartedAt < SCHEDULED_LOCK_MAX_WAIT_MS) {
      patchServerImport(provider, { enabled: true, status: "importing", error: null });
      setTimeout(() => {
        if (waitToken.cancelled) return;
        startServerImport(provider, { lockWaitStartedAt, traktWaitStartedAt }).catch(() => {});
      }, SCHEDULED_LOCK_RETRY_DELAY_MS);
      return { started: false, code: "SYNC_LOCKED_RETRYING" };
    }
    cancelTokens.delete(`server:${provider}`);
    patchServerImport(provider, { enabled: true, status: "failed", error: "A sync operation is already running. Retry once it finishes." });
    return { started: false, code: "SYNC_LOCKED" };
  }

  const token = waitToken;
  patchServerImport(provider, { enabled: true, status: "importing", startedAt: Date.now(), completedAt: null, itemCount: 0, error: null });

  let itemCount = 0;
  forceSyncLibraryState(
    { mode: "pull", source: provider },
    {
      logger: (message) => {
        if (message.includes("started for all media") || message.includes("Cancellation acknowledged")) return;
        itemCount += 1;
        patchServerImport(provider, { itemCount });
      },
      isCancelled: () => token.cancelled,
    },
  )
    .then((result) => {
      patchServerImport(provider, {
        status: token.cancelled ? "cancelled" : "complete",
        completedAt: Date.now(),
        itemCount: Array.isArray(result?.results) ? result.results.length : itemCount,
      });
    })
    .catch((error) => {
      patchServerImport(provider, { status: "failed", completedAt: Date.now(), error: error.message || String(error) });
    })
    .finally(() => {
      cancelTokens.delete(`server:${provider}`);
    });

  return { started: true };
}

export function cancelServerImport(provider) {
  const token = cancelTokens.get(`server:${provider}`);
  if (token) token.cancelled = true;
  patchServerImport(provider, { enabled: false, status: "cancelled", completedAt: Date.now() });
  return { cancelled: true };
}

// A connection's very first poll only establishes a baseline reference point
// - the reconcile pass inside pollTrakt (trackerSync.js) is gated behind the
// connection's baselineComplete flag already being true *before* that call
// starts, so the very first call always imports nothing no matter what
// options it's given, then flips the flag true at the end. A real watch-
// history backfill needs at least one more pass after that, now genuinely
// walking the full snapshot against local state. Loop until a pass applies
// zero further watched transitions so "complete" means the backlog is
// actually caught up, not just that the fast baseline handshake finished -
// a large account's snapshot can need several passes.
const MAX_TRAKT_RECONCILE_PASSES = 25;
async function runFullTraktReconcile() {
  for (let pass = 0; pass < MAX_TRAKT_RECONCILE_PASSES; pass++) {
    const result = await pollConnectedTrackers({ reconcile: true });
    // See the identical note where this is called - report what's actually
    // on file, not an in-memory accumulator a restart could lose.
    patchTraktImport({ itemCount: countTrackerItemStates("trakt") });
    if (pass > 0 && !result?.watched) break;
  }
}

export async function startTraktImport() {
  const runtime = await loadRuntimeState();
  const activeOperation = activeSyncOperation(runtime);
  // Unlike the per-server pulls above, pollConnectedTrackers only talks to
  // Trakt's API - it shares no outbound client/rate-limit state with Plex/
  // Emby/Jellyfin, and already coalesces concurrent calls itself (pollInFlight
  // in trackerSync.js). So the routine per-minute scheduled sync tick - which
  // reliably recurs every 60s and can otherwise permanently starve this of a
  // clear window - isn't treated as a conflict; only a genuinely unrelated
  // operation (force sync, rebuild, restore) still blocks.
  if (activeOperation && activeOperation.kind !== SYNC_OPERATION_SCHEDULED) {
    patchTraktImport({ enabled: true, status: "failed", error: "A sync operation is already running. Retry once it finishes." });
    return { started: false, code: "SYNC_LOCKED" };
  }
  patchTraktImport({ enabled: true, status: "importing", startedAt: Date.now(), completedAt: null, itemCount: null, error: null });

  runFullTraktReconcile()
    .then(() => {
      // Report the count actually on file rather than the in-memory total
      // accumulated across this run's passes - a dev-server restart (or any
      // process restart) mid-import abandons that in-flight promise before
      // it ever reaches here, and whatever value a *previous*, unrelated
      // completion left behind would otherwise stand uncorrected forever.
      patchTraktImport({ status: "complete", completedAt: Date.now(), itemCount: countTrackerItemStates("trakt") });
    })
    .catch((error) => {
      patchTraktImport({ status: "failed", completedAt: Date.now(), error: error.message || String(error) });
    });

  return { started: true };
}

export function cancelTraktImport() {
  // The baseline snapshot has no mid-flight cancel hook; unchecking the box
  // just stops onboarding from waiting on/reporting it. The regular Trakt
  // poll cycle still owns baselineComplete and continues in the background.
  patchTraktImport({ enabled: false });
  return { cancelled: true };
}
