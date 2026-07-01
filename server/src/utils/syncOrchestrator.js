import { markPlexPlayed, markPlexUnplayed, setPlexProgress } from "./plexClient.js";
import { markEmbyPlayed, markEmbyUnplayed, setEmbyProgress } from "./embyClient.js";
import { markJellyfinPlayed, markJellyfinUnplayed, setJellyfinProgress } from "./jellyfinClient.js";
import { watchedPlayedSyncEnabled } from "./syncFlags.js";

const LOOP_CACHE_TTL_SECONDS = 60;
const LOOP_WINDOW_MS = 15_000;
const MIN_RESUME_POSITION_MS = 60_000;
const MAX_RESUME_PROGRESS = 90;

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

export function getTargetsForSource(source = "manual", config = {}) {
  const baseSource = String(source).trim().toLowerCase();
  let targets = TARGETS_BY_SOURCE[baseSource];
  if (!targets) {
    // Fallback: target all platforms except the source itself
    targets = ["plex", "emby", "jellyfin"].filter((platform) => !baseSource.startsWith(platform));
  }
  return targets.filter((t) => !config[t]?.disabled);
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
  if (!Number.isFinite(positionMs) || positionMs < MIN_RESUME_POSITION_MS) return false;
  if (Number.isFinite(progress) && progress >= MAX_RESUME_PROGRESS) return false;
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

  const providerKeys = Object.entries(media.ids || {})
    .filter(([, value]) => Boolean(value))
    .map(([provider, value]) => `${coordinates}:${normalizeCachePart(provider)}:${normalizeCachePart(value)}`);

  if (providerKeys.length) return providerKeys;

  return [`${coordinates}:title:${normalizeCachePart(media.title)}`];
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

  const targets = getTargetsForSource(media.source, config);
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

  const targets = getTargetsForSource(media.source, config);
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

  const targets = getTargetsForSource(media.source, config);
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
