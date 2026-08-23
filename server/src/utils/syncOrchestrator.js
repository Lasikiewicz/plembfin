import { markPlexPlayed, markPlexUnplayed, setPlexProgress } from "./plexClient.js";
import { markEmbyPlayed, markEmbyUnplayed, setEmbyProgress } from "./embyClient.js";
import { markJellyfinPlayed, markJellyfinUnplayed, setJellyfinProgress } from "./jellyfinClient.js";
import { watchedPlayedSyncEnabled } from "./syncFlags.js";
import { minResumePositionMs, watchedThresholdPercent } from "./tuning.js";
import { canReceiveState, canSendState } from "./syncRoles.js";
import { dispatchTrackerWatchState } from "./trackerDispatcher.js";
import { setRuntimeState } from "./configStore.js";
import { canonicalShowTitleKey, canonicalTitleKey, showTitleFrom } from "./dataRepo.js";

const LOOP_CACHE_TTL_SECONDS = 60;
const LOOP_WINDOW_MS = 15_000;

// Sidebar "Syncing N of M" indicator (public/app.js renderSyncProgress, fed
// by the sync-progress SSE event in liveUpdates.js). Every real dispatch -
// the pending-retry queue working through its per-minute batch, a bulk
// duplicate-watch cleanup firing one propagation per affected episode, a
// single manual watch/unwatch - ultimately calls syncMediaPlaystate or
// syncMediaUnplayedPlaystate, so tracking here covers all of them without
// having to instrument every call site individually. A "burst" opens the
// first time a dispatch starts after being fully idle and closes
// DISPATCH_PROGRESS_IDLE_MS after the last one finishes, so a handful of
// near-simultaneous fire-and-forget calls share one window instead of each
// flashing the indicator open and shut on its own.
const DISPATCH_PROGRESS_IDLE_MS = 2_000;
let dispatchBurstTotal = 0;
let dispatchBurstCompleted = 0;
let dispatchBurstActive = false;
let dispatchIdleTimer = null;

function reportDispatchProgress() {
  setRuntimeState({
    backgroundSyncProgress: { total: dispatchBurstTotal, completed: dispatchBurstCompleted, updatedAt: Date.now() },
  }).catch(() => null);
}

function openDispatchBurstIfIdle() {
  if (dispatchIdleTimer) {
    clearTimeout(dispatchIdleTimer);
    dispatchIdleTimer = null;
  }
  if (!dispatchBurstActive) {
    dispatchBurstActive = true;
    dispatchBurstTotal = 0;
    dispatchBurstCompleted = 0;
  }
}

function beginDispatchTracking() {
  openDispatchBurstIfIdle();
  dispatchBurstTotal += 1;
  reportDispatchProgress();
}

// For a caller that already knows how many items it is about to dispatch
// (a Trakt reconcile pass, a bulk mark-watched/unwatched batch) - adds the
// whole known size to the total in one call instead of letting it climb one
// item at a time as bounded-concurrency workers pick items up over the
// life of the batch, which otherwise makes the indicator look like it never
// settles on a final number. Pair with `trackDispatch: false` on the
// batch's own syncMediaPlaystate/syncMediaUnplayedPlaystate calls so those
// items aren't counted a second time when they individually start.
export function reserveDispatchBatch(size) {
  if (!(size > 0)) return;
  openDispatchBurstIfIdle();
  dispatchBurstTotal += size;
  reportDispatchProgress();
}

// Exported for callers that pre-reserve a batch slot (trackDispatch: false)
// but then take an early-return path in applyWatchedTransition/
// applyUnwatchedTransition without ever reaching syncMediaPlaystate/
// syncMediaUnplayedPlaystate (e.g. "already watched" / "already unwatched") -
// that reserved slot must still be marked complete or the indicator gets
// stuck short of its total and the burst never closes.
export function completeDispatchTracking() {
  dispatchBurstCompleted += 1;
  reportDispatchProgress();
  if (dispatchBurstCompleted >= dispatchBurstTotal) {
    dispatchIdleTimer = setTimeout(() => {
      dispatchIdleTimer = null;
      dispatchBurstActive = false;
      dispatchBurstTotal = 0;
      dispatchBurstCompleted = 0;
      reportDispatchProgress();
    }, DISPATCH_PROGRESS_IDLE_MS);
  }
}

const TARGETS_BY_SOURCE = {
  plex: ["emby", "jellyfin"],
  plex_initial_sync: ["emby", "jellyfin"],
  emby: ["plex", "jellyfin"],
  emby_initial_sync: ["plex", "jellyfin"],
  jellyfin: ["plex", "emby"],
  jellyfin_initial_sync: ["plex", "emby"],
  manual: ["plex", "emby", "jellyfin"],
  force_sync: ["plex", "emby", "jellyfin"],
  trakt_import: ["plex", "emby", "jellyfin"],
  trakt_current: ["plex", "emby", "jellyfin"],
};

export function getTargetsForSource(source = "manual", config = {}, stateType = "watched") {
  const baseSource = String(source).trim().toLowerCase();
  let targets = TARGETS_BY_SOURCE[baseSource];
  if (!targets) {
    // Fallback: target all platforms except the source itself
    targets = ["plex", "emby", "jellyfin"].filter((platform) => !baseSource.startsWith(platform));
  }
  return targets.filter((t) => !config[t]?.disabled && canReceiveState(config, t, stateType));
}

function targetsForMedia(media, config, stateType) {
  const targets = getTargetsForSource(media.source, config, stateType);
  if (!Array.isArray(media.syncTargets)) return targets;
  const requested = new Set(media.syncTargets.map((target) => String(target).trim().toLowerCase()).filter(Boolean));
  return targets.filter((target) => requested.has(target));
}

function mediaWithLane(media, lane = "sync") {
  return { ...media, lane };
}

function clientFor(target, config, media, lane = "sync") {
  const outboundMedia = mediaWithLane(media, lane);
  if (target === "plex") return () => markPlexPlayed(config.plex, outboundMedia);
  if (target === "emby") return () => markEmbyPlayed(config.emby, outboundMedia);
  if (target === "jellyfin") return () => markJellyfinPlayed(config.jellyfin, outboundMedia);
  throw new Error(`Unknown sync target: ${target}`);
}

function clientUnplayedFor(target, config, media, lane = "sync") {
  const outboundMedia = mediaWithLane(media, lane);
  if (target === "plex") return () => markPlexUnplayed(config.plex, outboundMedia);
  if (target === "emby") return () => markEmbyUnplayed(config.emby, outboundMedia);
  if (target === "jellyfin") return () => markJellyfinUnplayed(config.jellyfin, outboundMedia);
  throw new Error(`Unknown sync target: ${target}`);
}

function clientProgressFor(target, config, media, lane = "sync") {
  const outboundMedia = mediaWithLane(media, lane);
  if (target === "plex") return () => setPlexProgress(config.plex, outboundMedia);
  if (target === "emby") return () => setEmbyProgress(config.emby, outboundMedia);
  if (target === "jellyfin") return () => setJellyfinProgress(config.jellyfin, outboundMedia);
  throw new Error(`Unknown sync target: ${target}`);
}

export function shouldSyncResumeProgress(media = {}) {
  const positionMs = Number(media.positionMs ?? media.offsetMs ?? 0);
  const progress = Number(media.progress || 0);
  if (!media?.isValid) return false;
  if (!["movie", "episode"].includes(media.type || media.mediaType)) return false;
  if (!Number.isFinite(positionMs) || positionMs < minResumePositionMs()) return false;
  // Resume progress stops being actionable at the same boundary that marks a
  // play "watched" - past that point there's nothing left to resume.
  if (Number.isFinite(progress) && progress >= watchedThresholdPercent()) return false;
  return true;
}

function normalizeCachePart(value) {
  return String(value ?? "none").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
}

function mediaCacheParts(media) {
  const coordinates = [
    normalizeCachePart(media.type),
    normalizeCachePart(media.season),
    normalizeCachePart(media.episode),
  ].join(":");

  // Emby/Jellyfin can send a played callback without provider ids. Their
  // native item id is still stable across the outbound mark and the callback,
  // so keep it alongside the provider/title fallbacks for echo detection.
  const itemKey = media.itemId ? `${coordinates}:item:${normalizeCachePart(media.itemId)}` : "";

  const providerKeys = Object.entries(media.ids || {})
    .filter(([, value]) => Boolean(value))
    .map(([provider, value]) => `${coordinates}:${normalizeCachePart(provider)}:${normalizeCachePart(value)}`);

  // The title key is always included, never only as a fallback. An outbound
  // sync for a record Plembfin holds no provider ids for claims title keys,
  // while the echo the target server sends back carries that server's own
  // imdb/tmdb/tvdb ids and so checks provider keys. With no key the two forms
  // share, the echo reads as a fresh event and the state bounces between
  // platforms until something else stops it.
  //
  // Built from a canonicalized show/movie title, not the raw title string:
  // one source can format the same episode as "Show (2025) - S01E02" while
  // another reports it as "Show - S01E02" (a trailing year only one side
  // carries). A raw-string key treats those as two different items, so an
  // outbound mark claimed under one source's title is never recognized when
  // the echo comes back formatted the other source's way - the echo then
  // reads as a brand-new watch and gets inserted as a duplicate.
  const rawTitleForKey = media.type === "episode"
    ? (media.show_title || media.showTitle || showTitleFrom(media.title || ""))
    : media.title;
  const canonicalTitleForKey = rawTitleForKey
    ? (media.type === "episode" ? canonicalShowTitleKey(rawTitleForKey) : canonicalTitleKey(rawTitleForKey))
    : "";
  const titleKey = canonicalTitleForKey ? `${coordinates}:title:${canonicalTitleForKey}` : "";
  return [...new Set([itemKey, ...providerKeys, titleKey].filter(Boolean))];
}

function targetCacheKeys(media, target, prefix = "loop") {
  return mediaCacheParts(media).map((part) => `${prefix}:${part}:target:${normalizeCachePart(target)}`);
}

// Atomically checks whether `media` was recently synced to the incoming
// source (i.e. this webhook is an echo of our own outbound sync) and, if not,
// claims cache keys for the outbound `targets` so a later echo from one of
// them is recognized. Both steps run in a single DB transaction (see
// loopStore.checkAndClaim) so two overlapping calls for the same media can't
// both pass the check before either claim becomes visible.
function checkAndClaimLoop(media, target, targets, kv, prefix = "loop") {
  const checkKeys = targetCacheKeys(media, target, prefix);
  if (!kv || !checkKeys.length) return false;

  try {
    const claimKeys = targets.flatMap((t) => targetCacheKeys(media, t, prefix));
    const { loopDetected } = kv.checkAndClaim(checkKeys, claimKeys, LOOP_CACHE_TTL_SECONDS, LOOP_WINDOW_MS);
    if (loopDetected) {
      console.log("(log) Echo loop caught, stopping propagation.", { source: media.source, prefix });
    } else if (claimKeys.length) {
      console.log("Loop cache primed for outbound targets", { keys: claimKeys.length, source: media.source, targets, prefix });
    }
    return loopDetected;
  } catch (error) {
    console.error("Loop cache check/claim failed; continuing sync", error);
    return false;
  }
}

// Marking an item played on a media server bumps that server's own "last played"
// timestamp, so our write looks exactly like a user's play the next time we read
// that server back. Recording every outbound mark - for long enough to outlive
// delayed webhook delivery and daily poll cycles - is what lets the inbound paths
// tell the two apart. The 15-second echo window above only breaks immediate
// ping-pong and expires long before a late echo arrives.
const OUTBOUND_MARK_TTL_SECONDS = 14 * 24 * 60 * 60;
const OUTBOUND_MARK_PREFIX = "mark";

export async function recordOutboundPlayedMarks(media, targets = [], kv) {
  if (!kv || !targets.length) return;
  const now = Date.now();
  for (const target of targets) {
    for (const key of targetCacheKeys(media, target, OUTBOUND_MARK_PREFIX)) {
      try {
        await kv.put(key, now, { expirationTtl: OUTBOUND_MARK_TTL_SECONDS });
      } catch (error) {
        console.error("Failed to record outbound played mark", { target, error });
      }
    }
  }
}

// Unplayed callbacks do not carry a reliable timestamp on every server, so
// keep a separate ledger for outbound unscrobble/delete-played writes. This
// prevents a target's acknowledgement from being interpreted as a new source
// event and also covers the direct Force Sync path.
const OUTBOUND_UNPLAYED_MARK_PREFIX = "unmark";
const OUTBOUND_PROGRESS_MARK_PREFIX = "progress_loop";

export async function recordOutboundUnplayedMarks(media, targets = [], kv) {
  if (!kv || !targets.length) return;
  const now = Date.now();
  for (const target of targets) {
    for (const key of targetCacheKeys(media, target, OUTBOUND_UNPLAYED_MARK_PREFIX)) {
      try {
        await kv.put(key, now, { expirationTtl: OUTBOUND_MARK_TTL_SECONDS });
      } catch (error) {
        console.error("Failed to record outbound unplayed mark", { target, error });
      }
    }
  }
}

// Updating resume position on Emby/Jellyfin writes Played=false as part of the
// same UserData payload. Both servers can immediately echo that write as an
// "unplayed" webhook even though the user did not clear the watched flag. Keep
// a short-lived marker so the webhook path can distinguish that acknowledgement
// from a genuine Mark Unplayed action.
export async function recordOutboundProgressMarks(media, targets = [], kv) {
  if (!kv || !targets.length) return;
  const now = Date.now();
  for (const target of targets) {
    for (const key of targetCacheKeys(media, target, OUTBOUND_PROGRESS_MARK_PREFIX)) {
      try {
        await kv.put(key, now, { expirationTtl: LOOP_CACHE_TTL_SECONDS });
      } catch (error) {
        console.error("Failed to record outbound progress mark", { target, error });
      }
    }
  }
}

// Newest time plembfin itself marked `media` played on `target`, or 0.
export async function lastOutboundPlayedMarkAt(media, target, kv) {
  if (!kv) return 0;
  let newest = 0;
  for (const key of targetCacheKeys(media, target, OUTBOUND_MARK_PREFIX)) {
    try {
      const value = Number(await kv.get(key));
      if (Number.isFinite(value) && value > newest) newest = value;
    } catch (error) {
      console.error("Failed to read outbound played mark", { target, error });
    }
  }
  return newest;
}

export async function lastOutboundUnplayedMarkAt(media, target, kv) {
  if (!kv) return 0;
  let newest = 0;
  for (const key of targetCacheKeys(media, target, OUTBOUND_UNPLAYED_MARK_PREFIX)) {
    try {
      const value = Number(await kv.get(key));
      if (Number.isFinite(value) && value > newest) newest = value;
    } catch (error) {
      console.error("Failed to read outbound unplayed mark", { target, error });
    }
  }
  return newest;
}

export async function lastOutboundProgressMarkAt(media, target, kv) {
  if (!kv) return 0;
  let newest = 0;
  for (const key of targetCacheKeys(media, target, OUTBOUND_PROGRESS_MARK_PREFIX)) {
    try {
      const value = Number(await kv.get(key));
      if (Number.isFinite(value) && value > newest) newest = value;
    } catch (error) {
      console.error("Failed to read outbound progress mark", { target, error });
    }
  }
  return newest;
}

export async function isRecentOutboundUnplayedFlagEcho(media, target, kv, {
  now = Date.now(),
  windowMs = 10 * 60 * 1000,
} = {}) {
  const ownMarkAt = await lastOutboundUnplayedMarkAt(media, target, kv);
  if (!ownMarkAt) return false;
  const receivedAt = Number(now);
  return Number.isFinite(receivedAt) && receivedAt >= ownMarkAt && receivedAt - ownMarkAt <= windowMs;
}

export async function isRecentOutboundProgressEcho(media, target, kv, {
  now = Date.now(),
  windowMs = LOOP_WINDOW_MS,
} = {}) {
  const ownMarkAt = await lastOutboundProgressMarkAt(media, target, kv);
  if (!ownMarkAt) return false;
  const receivedAt = Number(now);
  return Number.isFinite(receivedAt) && receivedAt >= ownMarkAt && receivedAt - ownMarkAt <= windowMs;
}

// A played-flag callback is not evidence of a new viewing. It is also what
// Jellyfin emits after Plembfin marks a newly re-added item watched. The
// callback can arrive with stale LastPlayedDate data, so use its arrival time
// as a short-window fallback after checking the persisted outbound marker.
export async function isRecentOutboundPlayedFlagEcho(media, target, kv, {
  now = Date.now(),
  windowMs = 10 * 60 * 1000,
} = {}) {
  if (!media?.playedFlagOnly) return false;

  const ownMarkAt = await lastOutboundPlayedMarkAt(media, target, kv);
  if (!ownMarkAt) return false;

  const receivedAt = Number(now);
  const playedAt = Date.parse(String(media.playedAt || media.watched_at || ""));
  if (Number.isFinite(playedAt) && Math.abs(playedAt - ownMarkAt) <= windowMs) return true;

  return Number.isFinite(receivedAt) && receivedAt >= ownMarkAt && receivedAt - ownMarkAt <= windowMs;
}

function summarizeResults(targets, results) {
  const successfulTargets = [];
  const failedTargets = [];
  const missingTargets = [];
  const targetStates = [];

  if (!targets.length) {
    return {
      status: "skipped",
      details: "No enabled sync destinations.",
      targetStates,
    };
  }

  results.forEach((result, index) => {
    const target = targets[index];
    if (result.status === "rejected") {
      failedTargets.push(target);
      targetStates.push({ target, status: "error", detail: String(result.reason?.message || result.reason) });
      return;
    }

    if (result.value?.status === "not_found") {
      missingTargets.push(target);
      targetStates.push({ target, status: "skipped", detail: "No matching item found" });
      return;
    }

    successfulTargets.push(target);
    targetStates.push({
      target,
      status: "success",
      detail: result.value?.httpStatus ? `${result.value.httpStatus} OK` : "Marked played",
      itemId: result.value?.itemId || "",
      itemIds: Array.isArray(result.value?.itemIds) ? result.value.itemIds : undefined,
      httpStatus: result.value?.httpStatus || null,
    });
  });

  if (failedTargets.length) {
    return {
      status: successfulTargets.length ? "partial" : "error",
      details: `Synced to ${formatTargets(successfulTargets)}; failed ${formatTargets(failedTargets)}`,
      targetStates,
    };
  }

  if (missingTargets.length) {
    return {
      status: successfulTargets.length ? "partial" : "skipped",
      details: `Synced to ${formatTargets(successfulTargets)}; no match on ${formatTargets(missingTargets)}`,
      targetStates,
    };
  }

  return {
    status: "success",
    details: `Successfully synced to ${formatTargets(successfulTargets)}`,
    targetStates,
  };
}

function summarizeProgressResults(targets, results) {
  const successfulTargets = [];
  const failedTargets = [];
  const missingTargets = [];
  const skippedTargets = [];
  const targetStates = [];

  if (!targets.length) {
    return {
      status: "skipped",
      details: "No enabled sync destinations for resume progress.",
      targetStates,
    };
  }

  results.forEach((result, index) => {
    const target = targets[index];
    if (result.status === "rejected") {
      failedTargets.push(target);
      targetStates.push({ target, status: "error", detail: String(result.reason?.message || result.reason) });
      return;
    }

    if (result.value?.status === "not_found") {
      missingTargets.push(target);
      targetStates.push({ target, status: "skipped", detail: "No matching item found" });
      return;
    }

    if (result.value?.status === "skipped") {
      skippedTargets.push(target);
      targetStates.push({ target, status: "skipped", detail: result.value?.detail || "Progress update skipped" });
      return;
    }

    successfulTargets.push(target);
    targetStates.push({
      target,
      status: "success",
      detail: result.value?.positionMs ? `Resume set to ${Math.round(result.value.positionMs / 1000)}s` : "Resume position updated",
      itemId: result.value?.itemId || "",
      itemIds: Array.isArray(result.value?.itemIds) ? result.value.itemIds : undefined,
      positionMs: result.value?.positionMs ?? null,
      httpStatus: result.value?.httpStatus || null,
    });
  });

  if (failedTargets.length) {
    return {
      status: successfulTargets.length ? "partial" : "error",
      details: `Progress synced to ${formatTargets(successfulTargets)}; failed ${formatTargets(failedTargets)}`,
      targetStates,
    };
  }

  if (missingTargets.length || skippedTargets.length) {
    return {
      status: successfulTargets.length ? "partial" : "skipped",
      details: `Progress synced to ${formatTargets(successfulTargets)}; no update on ${formatTargets([...missingTargets, ...skippedTargets])}`,
      targetStates,
    };
  }

  return {
    status: "success",
    details: `Successfully synced resume progress to ${formatTargets(successfulTargets)}`,
    targetStates,
  };
}

function formatTargets(targets) {
  const labels = targets.map((target) => target.charAt(0).toUpperCase() + target.slice(1));
  if (!labels.length) return "no targets";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} & ${labels.at(-1)}`;
}

async function includeTrackerDispatch(summary, media, state, lane = "sync") {
  const trackerStates = (await dispatchTrackerWatchState(media, state, { lane })).filter((entry) => entry.status !== "skipped");
  if (!trackerStates.length) return summary;
  const normalized = trackerStates.map((entry) => ({ ...entry, status: entry.status === "failed" ? "error" : entry.status === "not_found" ? "skipped" : entry.status }));
  const targetStates = [...(summary.targetStates || []), ...normalized];
  const successes = targetStates.filter((entry) => entry.status === "success").map((entry) => entry.target);
  const failures = targetStates.filter((entry) => entry.status === "error").map((entry) => entry.target);
  const skipped = targetStates.filter((entry) => entry.status === "skipped").map((entry) => entry.target);
  return {
    ...summary,
    targetStates,
    status: failures.length ? (successes.length ? "partial" : "error") : skipped.length ? (successes.length ? "partial" : "skipped") : "success",
    details: failures.length
      ? `Synced to ${formatTargets(successes)}; failed ${formatTargets(failures)}`
      : skipped.length ? `Synced to ${formatTargets(successes)}; no match on ${formatTargets(skipped)}` : `Successfully synced to ${formatTargets(successes)}`,
  };
}

export async function syncMediaPlaystate(media, config, kv, { trackDispatch = true, lane = "sync" } = {}) {
  if (!watchedPlayedSyncEnabled()) {
    console.log("Sync playstate skipped: watched/played syncing is disabled");
    return { skipped: true, status: "skipped", details: "Watched/played syncing is disabled.", targetStates: [], results: [] };
  }

  if (!media?.isValid) {
    console.log("Sync skipped; invalid normalized media payload", media);
    return { skipped: true, status: "skipped", details: "Invalid normalized media payload", results: [] };
  }

  if (!["manual", "force_sync", "trakt", "trakt_import", "trakt_current"].includes(String(media.source || "").toLowerCase()) && !canSendState(config, String(media.source || "").toLowerCase(), "watched")) {
    return { skipped: true, status: "skipped", details: "Source is not allowed to send watched state", targetStates: [], results: [] };
  }

  const targets = targetsForMedia(media, config, "watched");
  if (checkAndClaimLoop(media, media.source, targets, kv)) {
    console.log("Sync playstate skipped: echo loop detected", { source: media.source, title: media.title });
    return {
      skipped: true,
      status: "skipped",
      details: "Echo loop caught, stopping propagation",
      targetStates: [{ target: media.source, status: "skipped", detail: "Echo loop caught, stopping propagation" }],
      results: [],
    };
  }

  console.log("Sync playstate dispatch started", {
    source: media.source,
    title: media.title,
    targets,
    type: media.type,
    ids: media.ids,
  });

  if (trackDispatch) beginDispatchTracking();
  try {
    // Prime the echo ledger before making any remote calls. Plex can emit its
    // played notification while the request is still in flight; recording only
    // after the calls complete leaves a small window where our own write could
    // be mistaken for a new watch.
    await recordOutboundPlayedMarks(media, targets, kv);

    const jobs = targets.map((target) => {
      const run = clientFor(target, config, media, lane);
      return run();
    });

    const results = await Promise.allSettled(jobs);
    let summary = summarizeResults(targets, results);

    // Remember which servers we just stamped so a played flag read back from them
    // later is recognised as our own write rather than a fresh play.
    await recordOutboundPlayedMarks(
      media,
      summary.targetStates.filter((state) => state.status === "success").map((state) => state.target),
      kv,
    );

    console.log("Sync playstate dispatch completed", {
      source: media.source,
      title: media.title,
      status: summary.status,
      results: results.map((result, index) => ({
        target: targets[index],
        status: result.status,
        reason: result.status === "rejected" ? String(result.reason?.message || result.reason) : undefined,
      })),
    });

    summary = await includeTrackerDispatch(summary, media, "watched", lane);
    return { ...summary, skipped: summary.status === "skipped", results };
  } finally {
    completeDispatchTracking();
  }
}

// Plembfin is the canonical watched-state store.  Use a synthetic manual
// source when replaying that state so every configured destination is
// considered, including the platform that originally reported the drift.
// This is intentionally separate from syncMediaPlaystate: normal inbound
// events still fan out only to the other platforms, while canonical repair
// must be able to put the reporting platform back into agreement too.
export async function syncCanonicalPlaystate(media, config, kv, state = "watched", { lane = "sync" } = {}) {
  const canonicalMedia = {
    ...media,
    source: "manual",
    isValid: media?.isValid !== false,
  };
  if (String(state).toLowerCase() === "unwatched" || String(state).toLowerCase() === "unplayed") {
    return syncMediaUnplayedPlaystate(canonicalMedia, config, kv, { lane });
  }
  return syncMediaPlaystate(canonicalMedia, config, kv, { lane });
}

export async function syncMediaUnplayedPlaystate(media, config, kv, { trackDispatch = true, lane = "sync" } = {}) {
  if (!watchedPlayedSyncEnabled()) {
    return { skipped: true, status: "skipped", details: "Watched/played syncing is disabled.", targetStates: [], results: [] };
  }

  if (!media?.isValid) {
    console.log("Sync unplayed skipped; invalid normalized media payload", media);
    return { skipped: true, status: "skipped", details: "Invalid normalized media payload", results: [] };
  }

  if (!["manual", "force_sync", "trakt", "trakt_import", "trakt_current"].includes(String(media.source || "").toLowerCase()) && !canSendState(config, String(media.source || "").toLowerCase(), "unwatched")) {
    return { skipped: true, status: "skipped", details: "Source is not allowed to send unwatched state", targetStates: [], results: [] };
  }
  const targets = targetsForMedia(media, config, "unwatched");
  if (checkAndClaimLoop(media, media.source, targets, kv, "unplayed_loop")) {
    return {
      skipped: true,
      status: "skipped",
      details: "Echo loop caught, stopping propagation",
      targetStates: [{ target: media.source, status: "skipped", detail: "Echo loop caught, stopping propagation" }],
      results: [],
    };
  }

  console.log("Sync unplayed dispatch started", {
    source: media.source,
    targets,
    type: media.type,
    ids: media.ids,
  });

  if (trackDispatch) beginDispatchTracking();
  try {
    // Prime before the DELETE/unscrobble requests because some servers emit the
    // callback before the outbound request resolves.
    await recordOutboundUnplayedMarks(media, targets, kv);

    // "Mark unplayed" and "resume position" are separate fields on Emby/Jellyfin/
    // Plex - clearing the played flag alone leaves a stale progress bar in
    // Continue Watching. Best-effort and non-fatal: a target that rejects this
    // still gets the unplayed mark below.
    await Promise.all(targets.map(async (target) => {
      try {
        await clientProgressFor(target, config, { ...media, positionMs: 0 }, lane)();
      } catch (error) {
        console.log(`Resume progress clear on ${target} during unwatch failed (non-fatal)`, error.message);
      }
    }));

    const jobs = targets.map((target) => {
      const run = clientUnplayedFor(target, config, media, lane);
      return run();
    });

    const results = await Promise.allSettled(jobs);
    let summary = summarizeResults(targets, results);
    const successfulTargets = summary.targetStates
      .filter((state) => state.status === "success")
      .map((state) => state.target);
    await recordOutboundUnplayedMarks(media, successfulTargets, kv);
    console.log("Sync unplayed dispatch completed", {
      source: media.source,
      results: results.map((result, index) => ({
        target: targets[index],
        status: result.status,
        reason: result.status === "rejected" ? String(result.reason?.message || result.reason) : undefined,
      })),
    });

    summary = await includeTrackerDispatch(summary, media, "unwatched", lane);
    return { ...summary, skipped: summary.status === "skipped", results };
  } finally {
    completeDispatchTracking();
  }
}

export async function syncMediaProgress(media, config, kv, { lane = "sync" } = {}) {
  if (!shouldSyncResumeProgress(media)) {
    console.log("Sync progress skipped: resume payload is not actionable", {
      source: media.source,
      title: media.title,
      isValid: media.isValid,
      type: media.type,
      positionMs: media.positionMs ?? media.offsetMs,
      progress: media.progress,
    });
    return { skipped: true, status: "skipped", details: "Resume progress is not actionable", results: [] };
  }

  if (!["manual", "force_sync", "trakt_import", "trakt_current"].includes(String(media.source || "").toLowerCase()) && !canSendState(config, String(media.source || "").toLowerCase(), "progress")) {
    return { skipped: true, status: "skipped", details: "Source is not allowed to send progress", targetStates: [], results: [] };
  }
  const targets = targetsForMedia(media, config, "progress");
  if (checkAndClaimLoop(media, media.source, targets, kv, "progress_loop")) {
    console.log("Sync progress skipped: echo loop detected", { source: media.source, title: media.title });
    return {
      skipped: true,
      status: "skipped",
      details: "Echo loop caught, stopping propagation",
      targetStates: [{ target: media.source, status: "skipped", detail: "Echo loop caught, stopping propagation" }],
      results: [],
    };
  }

  console.log("Sync progress dispatch started", {
    source: media.source,
    title: media.title,
    targets,
    type: media.type,
    positionMs: media.positionMs ?? media.offsetMs,
    progress: media.progress,
    ids: media.ids,
  });

  // Prime a readable marker as well as the atomic loop claim above. Some
  // Emby/Jellyfin progress acknowledgements are parsed as unplayed events, so
  // the webhook handler needs to recognize the write before it clears local
  // playback_progress.
  await recordOutboundProgressMarks(media, targets, kv);

  const jobs = targets.map((target) => {
    const run = clientProgressFor(target, config, media, lane);
    return run();
  });

  const results = await Promise.allSettled(jobs);
  const summary = summarizeProgressResults(targets, results);
  console.log("Sync progress dispatch completed", {
    source: media.source,
    title: media.title,
    status: summary.status,
    results: results.map((result, index) => ({
      target: targets[index],
      status: result.status,
      reason: result.status === "rejected" ? String(result.reason?.message || result.reason) : undefined,
    })),
  });

  return { ...summary, skipped: summary.status === "skipped", results };
}
