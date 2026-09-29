// Background warm-up of the history-derived caches.
//
// Every derived cache in dataRepo.js is memoized against the shared data
// version and rebuilt lazily by the first reader after the version moves. That
// reader is usually a person opening a page, who then waits for the whole
// rebuild (about 1.3 s for the full history cache on a real library). This
// module moves that wait off the request path: it watches the version and, once
// changes have settled, calls the same getters the pages call so the next page
// load finds them already built.
//
// It never has its own implementation of any cache. It only decides when the
// existing getters run, so what they return and when they are invalidated is
// unchanged. It never calls a provider: the Up Next rebuild and the Upcoming
// calendar keep their own background refresh.
//
// Timing (user decision, 29 September 2026): warm once changes have been quiet
// for 5 seconds, and at least every 60 seconds while they keep arriving.

import { getDataVersion, refreshDataVersion } from "../db.js";
import {
  getCachedHistory,
  getCachedShows,
  getWatchStats,
  queryMovies,
  queryWatchHistory,
  queryWatchHistoryPreview,
} from "./dataRepo.js";

export const WARMUP_QUIET_MS = 5_000;
export const WARMUP_MAX_WAIT_MS = 60_000;
const WARMUP_POLL_MS = 1_000;
// Matches HISTORY_PREVIEW_LIMIT in public/app.js; the preview cache is keyed by
// limit, so warming any other size would not help the dashboard.
const DASHBOARD_PREVIEW_LIMIT = 120;

// In order of page importance. Each step is the call a page's first request
// makes (or the getter behind it), with the smallest page size that still
// builds the whole cache.
export const DEFAULT_WARMUP_STEPS = [
  { name: "history", run: () => getCachedHistory() },
  { name: "dashboardPreview", run: () => queryWatchHistoryPreview({ limit: DASHBOARD_PREVIEW_LIMIT }) },
  // The History page reads un-deduped rows by SQL, then attaches show artwork
  // from the history artwork index; one row is enough to build that index.
  { name: "historyArtwork", run: () => queryWatchHistory({ dedupe: false, limit: 1 }) },
  { name: "shows", run: () => getCachedShows() },
  { name: "movies", run: () => queryMovies({ limit: 1 }) },
  { name: "stats", run: () => getWatchStats() },
  { name: "scheduledShows", run: () => getCachedShows({ includeScheduledLibraryHistory: true }) },
];

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

// Page requests go ahead of the warm-up: before each step it waits while
// requests are still arriving (the last one under REQUEST_QUIET_MS ago), for at
// most REQUEST_DEFER_MAX_MS so a busy client cannot hold the warm-up off forever.
export const REQUEST_QUIET_MS = 50;
export const REQUEST_DEFER_MAX_MS = 1_000;
let lastRequestAt = -Infinity;

export function noteRequestActivity(at = performance.now()) {
  lastRequestAt = at;
}

export function createCacheWarmup({
  steps = DEFAULT_WARMUP_STEPS,
  observeVersion = getDataVersion,
  currentVersion = refreshDataVersion,
  quietMs = WARMUP_QUIET_MS,
  maxWaitMs = WARMUP_MAX_WAIT_MS,
  pollMs = WARMUP_POLL_MS,
  now = Date.now,
  logger = console,
  lastRequest = () => lastRequestAt,
  monotonic = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  requestQuietMs = REQUEST_QUIET_MS,
  requestDeferMaxMs = REQUEST_DEFER_MAX_MS,
} = {}) {
  let timer = null;
  let running = null;
  let lastSeenVersion = null;
  let lastChangeAt = 0;
  let dirtySince = null;
  let warmedVersion = null;
  const runs = [];

  async function waitForRequestsToPass() {
    const deferStarted = monotonic();
    while (monotonic() - lastRequest() < requestQuietMs && monotonic() - deferStarted < requestDeferMaxMs) {
      await sleep(requestQuietMs);
    }
  }

  async function runOnce() {
    const version = currentVersion();
    dirtySince = null;
    const started = performance.now();
    const built = [];
    let abandoned = false;
    let failed = null;
    for (const step of steps) {
      await waitForRequestsToPass();
      if (currentVersion() !== version) {
        abandoned = true;
        break;
      }
      const stepStarted = performance.now();
      try {
        await step.run();
      } catch (error) {
        failed = { step: step.name, error };
        break;
      }
      built.push({ name: step.name, ms: Math.round(performance.now() - stepStarted) });
      // Let queued requests, webhooks and the scheduler tick run between builds.
      await yieldToEventLoop();
      if (currentVersion() !== version) {
        abandoned = true;
        break;
      }
    }
    const totalMs = Math.round(performance.now() - started);
    if (abandoned) {
      // Start a fresh ceiling window, so constant churn warms at most once per
      // maxWaitMs instead of retrying on every poll.
      dirtySince = now();
    } else {
      // A failed step is logged and not retried until the version moves again;
      // the page request that needs it rebuilds it exactly as before.
      warmedVersion = version;
    }
    const result = { version, built, totalMs, abandoned, failed: failed?.step || null };
    runs.push(result);
    if (runs.length > 20) runs.shift();
    const outcome = failed ? `failed=${failed.step}` : `abandoned=${abandoned ? "yes" : "no"}`;
    const caches = built.map((entry) => `${entry.name}:${entry.ms}ms`).join(",") || "none";
    logger.log(`[cache-warmup] version=${version} caches=${caches} totalMs=${totalMs} ${outcome}`);
    if (failed) logger.error("[cache-warmup] step failed", failed.error);
    return result;
  }

  // Single-flight: a trigger while a run is in progress joins that run.
  function trigger() {
    if (!running) {
      running = runOnce().finally(() => { running = null; });
    }
    return running;
  }

  // One observation of the data version. Exposed for tests; the timer calls it.
  function poll() {
    const observed = observeVersion();
    const at = now();
    if (observed !== lastSeenVersion) {
      lastSeenVersion = observed;
      lastChangeAt = at;
      if (dirtySince === null) dirtySince = at;
    }
    if (observed === warmedVersion) {
      dirtySince = null;
      return null;
    }
    if (running || dirtySince === null) return null;
    if (at - lastChangeAt >= quietMs || at - dirtySince >= maxWaitMs) return trigger();
    return null;
  }

  function start() {
    if (timer) return;
    // Treat startup as a change that has already settled: the first poll warms.
    lastSeenVersion = observeVersion();
    lastChangeAt = now() - quietMs;
    dirtySince = now();
    timer = setInterval(() => {
      try {
        poll();
      } catch (error) {
        logger.error("[cache-warmup] poll failed", error);
      }
    }, pollMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    return running || Promise.resolve();
  }

  return {
    start,
    stop,
    poll,
    trigger,
    status: () => ({ running: Boolean(running), warmedVersion, lastSeenVersion, dirtySince, runs: [...runs] }),
  };
}

let sharedWarmup = null;

export function startCacheWarmup() {
  if (!sharedWarmup) sharedWarmup = createCacheWarmup();
  sharedWarmup.start();
  return sharedWarmup;
}

export function stopCacheWarmup() {
  return sharedWarmup?.stop() || Promise.resolve();
}
