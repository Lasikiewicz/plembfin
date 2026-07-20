import { runForceSync, runScheduledSync } from "./scheduled.js";
import { collectServerWatchedItems, buildForceSyncPlan } from "./utils/forceSyncPlanner.js";
import { createSyncPlanRecord } from "./utils/syncPlans.js";
import { getCachedHistory } from "./utils/dataRepo.js";
import { loadMediaConfig } from "./utils/configStore.js";
import { runScheduledTick, startPlexNotificationListener, stopPlexNotificationListener, restartPlexNotificationListener } from "./scheduler.js";
import { backfillUnknownShowTitles } from "./utils/dataRepo.js";
import { db } from "./db.js";
import { setRuntimeState } from "./utils/configStore.js";
import {
  claimSchedulerLease,
  markSchedulerTick,
  releaseSchedulerLease,
  renewSchedulerLease,
  validateSchedulerLease,
} from "./utils/schedulerLease.js";
import {
  appendBackgroundJobLog,
  claimNextBackgroundJob,
  finishBackgroundJob,
  getBackgroundJob,
  heartbeatBackgroundJob,
  pruneBackgroundJobs,
} from "./utils/backgroundJobs.js";

function timing(name, fallback) {
  if (process.env.PLEMBFIN_TEST_MODE !== "1") return fallback;
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 25 ? value : fallback;
}

const ACQUIRE_MS = timing("PLEMBFIN_TEST_LEASE_ACQUIRE_MS", 5_000);
const RENEW_MS = timing("PLEMBFIN_TEST_LEASE_RENEW_MS", 10_000);
const LEASE_TTL_MS = timing("PLEMBFIN_TEST_LEASE_TTL_MS", 60_000);
const TICK_MS = timing("PLEMBFIN_TEST_TICK_MS", 60_000);
const FIRST_TICK_MS = timing("PLEMBFIN_TEST_FIRST_TICK_MS", 10_000);
const JOB_POLL_MS = timing("PLEMBFIN_TEST_JOB_POLL_MS", 1_000);

export function createWorkerCoordinator({ holderId, role }) {
  let lease = null;
  let stopped = false;
  let tickRunning = false;
  let jobRunning = false;
  let activeTickPromise = null;
  let activeJobPromise = null;
  let lastSettingsUpdatedAt = null;
  const timers = new Set();

  const isLeader = () => Boolean(lease && validateSchedulerLease({ holderId, generation: lease.generation }));
  const later = (fn, ms) => {
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (stopped) return;
      try { await fn(); } catch (error) { console.error("Worker coordinator task failed", error); }
    }, ms);
    timers.add(timer);
  };

  async function becomeLeader(nextLease) {
    const changed = !lease || lease.generation !== nextLease.generation;
    lease = nextLease;
    if (!changed) return;
    console.log(`[worker] scheduler leadership acquired (generation ${lease.generation})`);
    startPlexNotificationListener();
    await backfillUnknownShowTitles().catch((error) => console.error("backfillUnknownShowTitles failed", error));
    later(runTick, FIRST_TICK_MS);
  }

  function loseLeadership(reason) {
    if (!lease) return;
    console.warn(`[worker] scheduler leadership lost: ${reason}`);
    lease = null;
    stopPlexNotificationListener();
  }

  async function maintainLease() {
    if (stopped) return;
    if (lease) {
      const renewed = renewSchedulerLease({ holderId, generation: lease.generation, ttlMs: LEASE_TTL_MS });
      if (!renewed) loseLeadership("renewal rejected");
      else lease.expiresAt = Date.now() + LEASE_TTL_MS;
    }
    if (!lease) {
      const claimed = claimSchedulerLease({ holderId, role, ttlMs: LEASE_TTL_MS });
      if (claimed) await becomeLeader(claimed);
    }
    if (lease) {
      const settingsUpdatedAt = Number(db.prepare("SELECT updated_at FROM settings WHERE id='mediaConfig'").get()?.updated_at || 0);
      if (lastSettingsUpdatedAt !== null && settingsUpdatedAt !== lastSettingsUpdatedAt) restartPlexNotificationListener();
      lastSettingsUpdatedAt = settingsUpdatedAt;
    }
    later(maintainLease, lease ? RENEW_MS : ACQUIRE_MS);
  }

  async function runTick() {
    if (stopped) return;
    if (!tickRunning && isLeader()) {
      tickRunning = true;
      try {
        markSchedulerTick({ holderId, generation: lease.generation });
        activeTickPromise = runScheduledTick({ isLeader });
        await activeTickPromise;
      } catch (error) {
        console.error("Scheduled tick failed", error);
      } finally {
        tickRunning = false;
        activeTickPromise = null;
      }
    }
    later(runTick, TICK_MS);
  }

  async function executeJob(job) {
    const token = { id: job.id, holderId, generation: lease.generation };
    const log = (message) => {
      console.log(message);
      appendBackgroundJobLog(job.id, message);
    };
    const heartbeat = setInterval(() => {
      heartbeatBackgroundJob(token);
      if (job.type === "force_sync") setRuntimeState({ forceSyncHeartbeat: Date.now() }).catch(() => null);
    }, Math.min(30_000, Math.max(1_000, Math.floor(LEASE_TTL_MS / 3))));
    heartbeat.unref?.();
    try {
      let result;
      if (job.type === "cron_sync") {
        log("Cron Sync started...");
        result = await runScheduledSync(log, { forceCatchup: true });
      } else if (job.type === "force_sync_plan") {
        log("Force Sync preview started...");
        const config = await loadMediaConfig();
        const collected = await collectServerWatchedItems(config, { scope: job.payload?.scope, logger: log });
        const plan = buildForceSyncPlan({ ...collected, historyRows: await getCachedHistory(), config });
        const record = createSyncPlanRecord(plan);
        result = { success: true, planId: record.id, summary: record.summary, status: record.status };
        log(`Force Sync preview complete: ${record.id}`);
      } else {
        await setRuntimeState({
          forceSyncActive: true,
          forceSyncStartedAt: job.startedAt || Date.now(),
          forceSyncHeartbeat: Date.now(),
          forceSyncCancelRequested: false,
        });
        log("Force Sync started...");
        result = await runForceSync(log, { lockAlreadyClaimed: true, planId: job.payload?.planId || "" });
      }
      const current = getBackgroundJob(job.id);
      const cancelled = current?.cancelRequested || result?.aborted;
      appendBackgroundJobLog(job.id, `RESULT: ${JSON.stringify(result)}`);
      finishBackgroundJob({ ...token, status: cancelled ? "cancelled" : "succeeded", result });
      if (job.type === "cron_sync") await setRuntimeState({ lastCronResult: { ok: !cancelled, result, finishedAt: Date.now() } });
      if (job.type === "force_sync") await setRuntimeState({ forceSyncActive: false, forceSyncCancelRequested: false, forceSyncResult: result, forceSyncHeartbeat: Date.now() });
    } catch (error) {
      appendBackgroundJobLog(job.id, `ERROR: ${error.message}`);
      finishBackgroundJob({ ...token, status: "failed", error: error.message, result: { success: false, error: error.message } });
      if (job.type === "force_sync") await setRuntimeState({ forceSyncActive: false, forceSyncCancelRequested: false, forceSyncResult: { success: false, error: error.message }, forceSyncHeartbeat: Date.now() }).catch(() => null);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function pollJobs() {
    if (stopped) return;
    if (!jobRunning && isLeader()) {
      const job = claimNextBackgroundJob({ holderId, generation: lease.generation });
      if (job) {
        jobRunning = true;
        try {
          activeJobPromise = executeJob(job);
          await activeJobPromise;
        } finally {
          activeJobPromise = null;
          jobRunning = false;
        }
      }
      pruneBackgroundJobs();
    }
    later(pollJobs, JOB_POLL_MS);
  }

  return {
    async start() {
      stopped = false;
      await maintainLease();
      later(pollJobs, 25);
    },
    async stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      stopPlexNotificationListener();
      const closingLease = lease;
      await Promise.allSettled([activeTickPromise, activeJobPromise].filter(Boolean));
      if (closingLease) releaseSchedulerLease({ holderId, generation: closingLease.generation });
      lease = null;
    },
    isLeader,
  };
}
