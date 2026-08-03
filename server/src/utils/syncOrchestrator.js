import { markPlexPlayed, markPlexUnplayed, setPlexProgress } from "./plexClient.js";
import { markEmbyPlayed, markEmbyUnplayed, setEmbyProgress } from "./embyClient.js";
import { markJellyfinPlayed, markJellyfinUnplayed, setJellyfinProgress } from "./jellyfinClient.js";
import { watchedPlayedSyncEnabled } from "./syncFlags.js";
import { minResumePositionMs, watchedThresholdPercent } from "./tuning.js";
import { canReceiveState, canSendState } from "./syncRoles.js";

const LOOP_CACHE_TTL_SECONDS = 60;
const LOOP_WINDOW_MS = 15_000;

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

function clientFor(target, config, media) {
  if (target === "plex") return () => markPlexPlayed(config.plex, media);
  if (target === "emby") return () => markEmbyPlayed(config.emby, media);
  if (target === "jellyfin") return () => markJellyfinPlayed(config.jellyfin, media);
  throw new Error(`Unknown sync target: ${target}`);
}

function clientUnplayedFor(target, config, media) {
  if (target === "plex") return () => markPlexUnplayed(config.plex, media);
  if (target === "emby") return () => markEmbyUnplayed(config.emby, media);
  if (target === "jellyfin") return () => markJellyfinUnplayed(config.jellyfin, media);
  throw new Error(`Unknown sync target: ${target}`);
}

function clientProgressFor(target, config, media) {
  if (target === "plex") return () => setPlexProgress(config.plex, media);
  if (target === "emby") return () => setEmbyProgress(config.emby, media);
  if (target === "jellyfin") return () => setJellyfinProgress(config.jellyfin, media);
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
  const titleKey = media.title ? `${coordinates}:title:${normalizeCachePart(media.title)}` : "";
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

export async function syncMediaPlaystate(media, config, kv) {
  if (!watchedPlayedSyncEnabled()) {
    console.log("Sync playstate skipped: watched/played syncing is disabled");
    return { skipped: true, status: "skipped", details: "Watched/played syncing is disabled.", targetStates: [], results: [] };
  }

  if (!media?.isValid) {
    console.log("Sync skipped; invalid normalized media payload", media);
    return { skipped: true, status: "skipped", details: "Invalid normalized media payload", results: [] };
  }

  if (!["manual", "force_sync", "trakt_import", "trakt_current"].includes(String(media.source || "").toLowerCase()) && !canSendState(config, String(media.source || "").toLowerCase(), "watched")) {
    return { skipped: true, status: "skipped", details: "Source is not allowed to send watched state", targetStates: [], results: [] };
  }

  const targets = getTargetsForSource(media.source, config, "watched");
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

  const jobs = targets.map((target) => {
    const run = clientFor(target, config, media);
    return run();
  });

  const results = await Promise.allSettled(jobs);
  const summary = summarizeResults(targets, results);

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

  return { ...summary, skipped: false, results };
}

export async function syncMediaUnplayedPlaystate(media, config, kv) {
  if (!watchedPlayedSyncEnabled()) {
    return { skipped: true, status: "skipped", details: "Watched/played syncing is disabled.", targetStates: [], results: [] };
  }

  if (!media?.isValid) {
    console.log("Sync unplayed skipped; invalid normalized media payload", media);
    return { skipped: true, status: "skipped", details: "Invalid normalized media payload", results: [] };
  }

  if (!["manual", "force_sync", "trakt_import", "trakt_current"].includes(String(media.source || "").toLowerCase()) && !canSendState(config, String(media.source || "").toLowerCase(), "unwatched")) {
    return { skipped: true, status: "skipped", details: "Source is not allowed to send unwatched state", targetStates: [], results: [] };
  }
  const targets = getTargetsForSource(media.source, config, "unwatched");
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

  const jobs = targets.map((target) => {
    const run = clientUnplayedFor(target, config, media);
    return run();
  });

  const results = await Promise.allSettled(jobs);
  const summary = summarizeResults(targets, results);
  console.log("Sync unplayed dispatch completed", {
    source: media.source,
    results: results.map((result, index) => ({
      target: targets[index],
      status: result.status,
      reason: result.status === "rejected" ? String(result.reason?.message || result.reason) : undefined,
    })),
  });

  return { ...summary, skipped: false, results };
}

export async function syncMediaProgress(media, config, kv) {
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
  const targets = getTargetsForSource(media.source, config, "progress");
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

  const jobs = targets.map((target) => {
    const run = clientProgressFor(target, config, media);
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

  return { ...summary, skipped: false, results };
}
