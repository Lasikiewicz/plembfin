import { getCachedHistory, deleteWatchRecordById, insertWatchRecord, mediaToWatchRecord, upsertPlaystateForMedia } from "./dataRepo.js";
import { markPlexPlayed, markPlexUnplayed } from "./plexClient.js";
import { markEmbyPlayed, markEmbyUnplayed } from "./embyClient.js";
import { markJellyfinPlayed, markJellyfinUnplayed } from "./jellyfinClient.js";
import { recordOutboundPlayedMarks, recordOutboundUnplayedMarks } from "./syncOrchestrator.js";
import { createLoopStore } from "./loopStore.js";
import { collectServerFingerprintCounts, planStaleness } from "./forceSyncPlanner.js";
import { finishSyncPlan, getSyncPlanFull, setSyncPlanSnapshot, setSyncPlanStatus } from "./syncPlans.js";
import { isAuthoritativeRestoreActive } from "./configStore.js";
import { createWatchHistoryBackup, verifyWatchBackup } from "./watchHistoryBackups.js";
import { runWithConcurrency } from "./concurrency.js";

const played = { plex: markPlexPlayed, emby: markEmbyPlayed, jellyfin: markJellyfinPlayed };
const unplayed = { plex: markPlexUnplayed, emby: markEmbyUnplayed, jellyfin: markJellyfinUnplayed };

// Each plan action targets a distinct media key (see forceSyncPlanner.js),
// so actions carry no ordering dependency on one another and are safe to run
// concurrently. The outbound governor already caps actual concurrent
// requests per target host, so this only shortens wall-clock time for a
// large plan - it does not send more simultaneous requests to any one
// server than the governor's profile already allows.
const FORCE_SYNC_CONCURRENCY = 6;

async function remoteWrite(action, config) {
  const fn = action.kind === "mark_played" ? played[action.target] : unplayed[action.target];
  if (!fn) throw new Error(`Unsupported Force Sync target ${action.target}`);
  return fn(config[action.target], action.media);
}

export async function executeForceSyncPlan(id, config, logger = () => {}, { signal, shouldCancel = async () => false } = {}) {
  const plan = getSyncPlanFull(id);
  if (!plan) return { success: false, error: "Plan not found.", planId: id };
  if (plan.status !== "confirmed") return { success: false, error: `Plan is ${plan.status} and is not confirmed.`, planId: id };
  if (plan.summary?.scopeErrors?.length) {
    setSyncPlanStatus(id, "blocked_scan_error");
    return {
      success: false,
      planId: id,
      error: "The plan cannot execute because one or more configured servers were not scanned successfully.",
      scopeErrors: plan.summary.scopeErrors,
    };
  }
  const fingerprintErrors = [];
  const counts = await collectServerFingerprintCounts(config, {
    scope: plan.scope,
    onError: (server, error) => fingerprintErrors.push({ server, error: error?.message || String(error) }),
  });
  if (fingerprintErrors.length) {
    setSyncPlanStatus(id, "blocked_scan_error");
    return {
      success: false,
      planId: id,
      error: "The plan could not verify every configured server before execution; no remote writes were sent.",
      scopeErrors: fingerprintErrors,
    };
  }
  const freshness = planStaleness(plan, { counts, config });
  if (freshness.stale) {
    setSyncPlanStatus(id, "expired");
    return { success: false, planId: id, code: "plan_stale", error: freshness.reasons.join(" "), reasons: freshness.reasons };
  }
  if (plan.summary?.overLimit) {
    setSyncPlanStatus(id, "blocked_over_limit");
    return { success: false, planId: id, error: "Plan exceeds its maximum-change limit." };
  }
  setSyncPlanStatus(id, "executing");
  const loopStore = createLoopStore();
  let snapshot = null;
  try {
    if (plan.summary?.destructive > 0) {
      logger("Force Sync: creating verified pre-run recovery snapshot...");
      snapshot = await createWatchHistoryBackup({ reason: "pre-force-sync" });
      verifyWatchBackup(snapshot.name);
      setSyncPlanSnapshot(id, snapshot.name);
      logger(`Force Sync: recovery snapshot verified (${snapshot.name}).`);
    }
    const result = { success: true, planId: id, snapshot, plannedActions: plan.actions.length, completedActions: 0, failedActions: 0, scope: plan.scope };
    let cancelled = false;
    await runWithConcurrency(plan.actions, async (action) => {
      if (cancelled) return;
      if (signal?.aborted || isAuthoritativeRestoreActive() || await shouldCancel()) {
        cancelled = true;
        return;
      }
      try {
        if (action.kind === "mark_played" || action.kind === "mark_unplayed") {
          const marker = action.kind === "mark_played" ? recordOutboundPlayedMarks : recordOutboundUnplayedMarks;
          await marker(action.media, [action.target], loopStore).catch(() => null);
          if (isAuthoritativeRestoreActive() || await shouldCancel()) {
            cancelled = true;
            return;
          }
          const remoteResult = await remoteWrite(action, config);
          if (remoteResult?.status !== "not_found") {
            const itemIds = Array.isArray(remoteResult?.itemIds) && remoteResult.itemIds.length
              ? remoteResult.itemIds
              : remoteResult?.itemId
                ? [remoteResult.itemId]
                : [];
            if (itemIds.length) {
              await Promise.all(itemIds.map((itemId) => marker({ ...action.media, itemId }, [action.target], loopStore).catch(() => null)));
            } else {
              await marker(action.media, [action.target], loopStore).catch(() => null);
            }
          }
        }
        else if (["remove_unwatched_marker", "delete_history_rows"].includes(action.kind)) for (const rowId of action.historyRowIds || []) {
          if (isAuthoritativeRestoreActive() || await shouldCancel()) {
            cancelled = true;
            return;
          }
          await deleteWatchRecordById(rowId, { skipInvalidate: true });
        }
        else if (action.kind === "insert_unwatched_record") {
          if (isAuthoritativeRestoreActive() || await shouldCancel()) {
            cancelled = true;
            return;
          }
          const record = mediaToWatchRecord({ ...action.media, source: "force_sync", watched_at: action.resolvedAt || new Date().toISOString() }, "force_sync");
          record.sync_action = "unwatched";
          const inserted = await insertWatchRecord(record, { skipInvalidate: true });
          await upsertPlaystateForMedia({ ...action.media, source: "force_sync", isValid: true }, "unwatched", inserted.record.watched_at, { skipInvalidate: true });
        }
        result.completedActions += 1;
      } catch (error) {
        result.failedActions += 1;
        logger(`Force Sync action ${action.seq || ""} failed: ${error.message}`);
      }
    }, FORCE_SYNC_CONCURRENCY);

    if (cancelled) {
      result.success = false;
      result.aborted = true;
      result.cancelled = true;
      result.error = "Force Sync cancelled";
      finishSyncPlan(id, "cancelled", result);
      return result;
    }
    result.success = result.failedActions === 0;
    const status = result.failedActions ? "completed" : "completed";
    finishSyncPlan(id, status, result);
    return result;
  } catch (error) {
    const result = { success: false, planId: id, snapshot, error: error.message };
    finishSyncPlan(id, snapshot ? "completed" : "blocked_snapshot_failed", result);
    return result;
  }
}
