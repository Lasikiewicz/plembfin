// Scoped, detail-page Force Sync.
//
// Library-wide Force Sync deliberately treats Plembfin as canonical and does
// not import server-only watches. This module is the explicit, user-requested
// exception for one movie or show: inspect that title on connected servers,
// import the watched items found there, then replay the resulting canonical
// state to the configured destinations.

import { fetchPlexMetadataItem, fetchPlexSeriesEpisodes, findPlexItem } from "./plexClient.js";
import { fetchEmbySeriesEpisodes, fetchEmbyWatchedItems } from "./embyClient.js";
import { fetchJellyfinSeriesEpisodes, fetchJellyfinWatchedItems } from "./jellyfinClient.js";
import { normalizeProviderIds, parsePlexGuids } from "./parsers.js";
import { isEmbyLikePlayed, watchedAtForEmbyLikeItem, watchedAtForPlexItem } from "./watchDates.js";
import { appendSyncHistory, loadMediaConfig } from "./configStore.js";
import { createLoopStore } from "./loopStore.js";
import { syncCanonicalPlaystate } from "./syncOrchestrator.js";
import {
  getCanonicalWatchState,
  findWatchedByAnyMediaKey,
  getWatchRecordById,
  insertWatchRecord,
  invalidateHistoryDerivedCaches,
  queryShowDetail,
  updateWatchTelemetry,
  upsertPlaystateForMedia,
  watchRowToMedia,
} from "./dataRepo.js";

const MEDIA_SERVERS = ["plex", "emby", "jellyfin"];
const FORCE_SYNC_MODES = ["full", "push", "pull"];

function clean(value) {
  return String(value ?? "").trim();
}

function numberOrNull(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function idSet(ids = {}) {
  return new Set([ids.imdb, ids.tmdb, ids.tvdb].map(clean).filter(Boolean).map((id) => id.toLowerCase()));
}

function titleKey(value = "") {
  return clean(value)
    .replace(/\s*\(\d{4}\)\s*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function sourceConfigured(config = {}, source) {
  if (source === "plex") return !config.plex?.disabled && Boolean(config.plex?.baseUrl && config.plex?.token);
  return !config[source]?.disabled && Boolean(config[source]?.baseUrl && config[source]?.apiKey && config[source]?.userId);
}

export function normalizeMediaForceSyncRequest(input = {}) {
  const rawType = clean(input.type || input.media_type || input.mediaType).toLowerCase();
  const type = ["show", "series", "tv"].includes(rawType) ? "show" : rawType;
  const idsInput = input.ids || {};
  const ids = {
    imdb: clean(input.imdb_id || input.imdbId || input.imdb || idsInput.imdb),
    tmdb: clean(input.tmdb_id || input.tmdbId || input.tmdb || idsInput.tmdb),
    tvdb: clean(input.tvdb_id || input.tvdbId || input.tvdb || idsInput.tvdb),
  };
  const title = clean(input.title || input.name);
  const season = numberOrNull(input.season);
  const episode = numberOrNull(input.episode);
  const rawMode = clean(input.mode || input.action || "full").toLowerCase();
  const mode = rawMode === "full_sync" || rawMode === "fullsync" ? "full" : rawMode === "push_to" ? "push" : rawMode === "pull_from" ? "pull" : rawMode;
  const sourceValue = clean(input.pull_from || input.pullFrom || input.source).toLowerCase();
  const targetValue = clean(input.push_to || input.pushTo || input.target).toLowerCase();
  const source = sourceValue === "all" ? "" : sourceValue;
  const target = targetValue === "all" ? "" : targetValue;

  if (!title) throw new Error("title is required");
  if (!["movie", "show", "episode"].includes(type)) throw new Error("type must be movie, show, or episode");
  if (!FORCE_SYNC_MODES.includes(mode)) throw new Error("mode must be full, push, or pull");
  if (source && !MEDIA_SERVERS.includes(source)) throw new Error("source must be plex, emby, or jellyfin");
  if (target && !MEDIA_SERVERS.includes(target)) throw new Error("target must be plex, emby, or jellyfin");

  return { title, type, ids, season, episode, mode, source, target };
}

function sourceTitle(item = {}, source = "") {
  if (source === "plex") return clean(item.grandparentTitle || item.parentTitle || item.title);
  return clean(item.SeriesName || item.seriesName || item.ShowTitle || item.showTitle || item.GrandparentTitle || item.grandparentTitle || item.Name || item.name);
}

function itemTitle(item = {}, source = "") {
  if (source === "plex") return clean(item.title);
  return clean(item.Name || item.name || item.Title || item.title);
}

function itemType(item = {}, source = "") {
  if (source === "plex") return clean(item.type).toLowerCase() === "movie" ? "movie" : "episode";
  return clean(item.Type || item.type).toLowerCase() === "movie" ? "movie" : "episode";
}

function itemCoordinates(item = {}, source = "") {
  if (source === "plex") {
    return { season: numberOrNull(item.parentIndex), episode: numberOrNull(item.index) };
  }
  return { season: numberOrNull(item.ParentIndexNumber), episode: numberOrNull(item.IndexNumber) };
}

function itemIds(item = {}, source = "") {
  if (source === "plex") return parsePlexGuids(item);
  return normalizeProviderIds({ ...(item.SeriesProviderIds || {}), ...(item.ProviderIds || {}) });
}

function itemNativeId(item = {}, source = "") {
  return source === "plex" ? clean(item.ratingKey) : clean(item.Id || item.id);
}

export function remoteItemIsWatched(item = {}, source = "") {
  if (source === "plex") {
    return Number(item.viewCount || 0) > 0 || Boolean(watchedAtForPlexItem(item).watchedAt);
  }
  return isEmbyLikePlayed(item);
}

export function remoteItemToMedia(item = {}, source = "", requested = {}, now = Date.now()) {
  const type = itemType(item, source);
  const coordinates = itemCoordinates(item, source);
  if (type === "episode" && (coordinates.season == null || coordinates.episode == null)) return null;

  const ids = itemIds(item, source);
  const requestedIds = requested.ids || {};
  for (const key of ["imdb", "tmdb", "tvdb"]) {
    if (!ids[key] && requestedIds[key]) ids[key] = requestedIds[key];
  }

  const showTitle = sourceTitle(item, source) || requested.title;
  const title = type === "episode"
    ? `${showTitle || "Unknown Show"} - S${String(coordinates.season).padStart(2, "0")}E${String(coordinates.episode).padStart(2, "0")}`
    : itemTitle(item, source) || requested.title;
  const watchedAtResult = source === "plex" ? watchedAtForPlexItem(item) : watchedAtForEmbyLikeItem(item);
  const watchedAt = watchedAtResult.watchedAt || new Date(now).toISOString();
  const itemId = itemNativeId(item, source);

  return {
    title,
    show_title: type === "episode" ? showTitle : undefined,
    episode_title: type === "episode" ? itemTitle(item, source) : undefined,
    type,
    ids,
    season: coordinates.season,
    episode: coordinates.episode,
    source,
    watched_at: watchedAt,
    itemId,
    isValid: true,
    watchProvenance: {
      source,
      ingest_path: "force_sync",
      event: "media_force_sync",
      phase: "completed",
      item_id: itemId,
      source_timestamp: watchedAtResult.watchedAt || "",
      note: "Watched state explicitly imported from a connected media server from the media detail page.",
    },
  };
}

function mediaMatchesRequest(media, requested) {
  if (!media) return false;
  if (requested.type === "movie" && media.type !== "movie") return false;
  if (requested.type !== "movie" && media.type !== "episode") return false;
  if (requested.season != null && Number(media.season) !== Number(requested.season)) return false;
  if (requested.episode != null && Number(media.episode) !== Number(requested.episode)) return false;

  const requestedIds = idSet(requested.ids);
  const mediaIds = idSet(media.ids);
  if (requestedIds.size && [...requestedIds].some((id) => mediaIds.has(id))) return true;

  if (requested.type === "movie") return titleKey(media.title) === titleKey(requested.title);
  const requestedShow = titleKey(requested.title);
  const mediaShow = titleKey(media.show_title || media.title.split(/\s+-\s+S\d/i)[0]);
  return Boolean(requestedShow && mediaShow && requestedShow === mediaShow);
}

function mediaIdentity(media) {
  if (media.type === "episode") {
    return `episode:${titleKey(media.show_title || media.title.split(/\s+-\s+S\d/i)[0])}:${media.season}:${media.episode}`;
  }
  const ids = media.ids || {};
  return `movie:${clean(ids.imdb || ids.tmdb || ids.tvdb).toLowerCase() || titleKey(media.title)}`;
}

function dedupeMedia(items = []) {
  const byIdentity = new Map();
  for (const item of items) {
    const key = mediaIdentity(item);
    const existing = byIdentity.get(key);
    if (!existing || Date.parse(item.watched_at || "") > Date.parse(existing.watched_at || "")) byIdentity.set(key, item);
  }
  return [...byIdentity.values()].sort((a, b) => String(a.title).localeCompare(String(b.title)) || Number(a.season || 0) - Number(b.season || 0) || Number(a.episode || 0) - Number(b.episode || 0));
}

async function collectSourceItems(config, requested, source, now) {
  const sourceConfig = config[source];
  let rawItems = [];
  const lookup = { ...requested, type: requested.type === "movie" ? "movie" : "episode" };

  if (source === "plex") {
    if (requested.type === "movie") {
      const item = await findPlexItem(sourceConfig, lookup);
      const fullItem = item?.ratingKey ? await fetchPlexMetadataItem(sourceConfig, item.ratingKey) : null;
      rawItems = fullItem ? [fullItem] : item ? [item] : [];
    } else {
      rawItems = await fetchPlexSeriesEpisodes(sourceConfig, { ...lookup, type: "series" });
    }
  } else if (source === "emby") {
    rawItems = requested.type === "movie"
      ? await fetchEmbyWatchedItems(sourceConfig)
      : await fetchEmbySeriesEpisodes(sourceConfig, { ...lookup, type: "episode" });
  } else if (source === "jellyfin") {
    rawItems = requested.type === "movie"
      ? await fetchJellyfinWatchedItems(sourceConfig)
      : await fetchJellyfinSeriesEpisodes(sourceConfig, { ...lookup, type: "episode" });
  }

  return rawItems
    .filter((item) => remoteItemIsWatched(item, source))
    .map((item) => remoteItemToMedia(item, source, requested, now))
    .filter((media) => mediaMatchesRequest(media, requested));
}

function sourceLabel(source = "") {
  return source ? source.charAt(0).toUpperCase() + source.slice(1) : "all connected servers";
}

function modeLabel(mode = "full") {
  if (mode === "push") return "Push To";
  if (mode === "pull") return "Pull From";
  return "Full Sync";
}

async function collectLocalCanonicalItems(requested, { logger = () => {} } = {}) {
  if (requested.type === "show") {
    logger(`[push] Plembfin: loading canonical watched episodes for "${requested.title}".`);
    const show = await queryShowDetail({ title: requested.title });
    const items = (show?.episodes || [])
      .map((row) => ({
        ...watchRowToMedia(row, "manual"),
        show_title: row.show_title || undefined,
        episode_title: row.episode_title || undefined,
        canonicalState: "watched",
        isValid: true,
      }))
      .filter((media) => mediaMatchesRequest(media, requested));
    logger(`[push] Plembfin: found ${items.length} canonical watched episode${items.length === 1 ? "" : "s"}.`);
    return {
      items,
      sourceResults: [{ source: "plembfin", status: items.length ? "success" : "not_watched", watchedCount: items.length }],
    };
  }

  const probe = {
    title: requested.title,
    type: requested.type,
    ids: requested.ids,
    season: requested.season,
    episode: requested.episode,
    isValid: true,
  };
  const canonicalState = await getCanonicalWatchState(probe).catch(() => null);
  if (!canonicalState) {
    logger(`[push] Plembfin: no canonical state exists for "${requested.title}".`);
    return { items: [], sourceResults: [{ source: "plembfin", status: "not_watched", watchedCount: 0 }] };
  }

  const row = await findWatchedByAnyMediaKey(probe).catch(() => null);
  const media = row
    ? { ...watchRowToMedia(row, "manual"), canonicalState, isValid: true }
    : { ...probe, source: "manual", canonicalState, watched_at: "" };
  logger(`[push] Plembfin: canonical state for "${media.title}" is ${canonicalState}.`);
  return {
    items: [media],
    sourceResults: [{ source: "plembfin", status: "success", watchedCount: 1, state: canonicalState }],
  };
}

export async function collectMediaForceSyncItems(config = {}, requested, { now = Date.now(), logger = () => {} } = {}) {
  const sources = requested.source ? [requested.source] : MEDIA_SERVERS;
  const sourceResults = [];
  const collected = [];

  await Promise.all(sources.map(async (source) => {
    if (!sourceConfigured(config, source)) {
      logger(`[pull] ${source}: not configured; skipped.`);
      sourceResults.push({ source, status: "not_configured", watchedCount: 0 });
      return;
    }
    logger(`[pull] ${source}: looking for watched state for "${requested.title}".`);
    try {
      const items = await collectSourceItems(config, requested, source, now);
      collected.push(...items);
      logger(`[pull] ${source}: found ${items.length} watched item${items.length === 1 ? "" : "s"}.`);
      sourceResults.push({ source, status: items.length ? "success" : "not_watched", watchedCount: items.length });
    } catch (error) {
      logger(`Detail Force Sync: ${source} lookup failed: ${error.message || String(error)}`);
      sourceResults.push({ source, status: "error", watchedCount: 0, error: error.message || String(error) });
    }
  }));

  sourceResults.sort((a, b) => MEDIA_SERVERS.indexOf(a.source) - MEDIA_SERVERS.indexOf(b.source));
  return { items: dedupeMedia(collected), sourceResults };
}

function pendingTelemetry(media, requested) {
  const action = requested.mode === "pull" ? "Pulled Watched" : requested.mode === "push" ? "Pushed Canonical State" : "Force Synced Watched";
  return [
    `Origin: ${media.source}`,
    `Action: ${action}`,
    `Media: ${media.title}`,
    "Loop-check: Passed",
    "Dispatch status: pending",
    `Details: Detail-page ${modeLabel(requested.mode)} operation queued for this media item.`,
  ].join("\n");
}

function completedTelemetry(media, summary, requested) {
  const action = requested.mode === "pull" ? "Pulled Watched" : requested.mode === "push" ? "Pushed Canonical State" : "Force Synced Watched";
  const lines = [
    `Origin: ${media.source}`,
    `Action: ${action}`,
    `Media: ${media.title}`,
    "Loop-check: Passed",
    `Dispatch status: ${summary.status || "unknown"}`,
    `Details: ${summary.details || "Detail-page Force Sync completed."}`,
  ];
  for (const target of summary.targetStates || []) {
    lines.push(`${String(target.target || "Target").replace(/^./, (char) => char.toUpperCase())} status: ${target.status}${target.detail ? ` - ${target.detail}` : ""}`);
  }
  return lines.join("\n");
}

async function appendForceSyncHistory(media, summary, requested) {
  await appendSyncHistory({
    mediaType: media.type,
    title: media.title,
    source: media.source,
    status: summary.status || "unknown",
    details: `Detail-page ${modeLabel(requested.mode)}: ${summary.details || "completed"}`,
    action: "watched",
    targetStates: summary.targetStates || [],
    rawPayloadDebug: {
      event: "media_force_sync",
      phase: "completed",
      mode: requested.mode,
      target: requested.target || "all",
      pullFrom: requested.source || "all",
      ids: media.ids || {},
      season: media.season ?? null,
      episode: media.episode ?? null,
    },
  }).catch(() => null);
}

export async function forceSyncMediaState(input, { config = null, now = Date.now(), logger = () => {}, isCancelled = () => false } = {}) {
  const requested = normalizeMediaForceSyncRequest(input);
  const resolvedConfig = config || await loadMediaConfig();
  logger(`[${requested.mode}] ${modeLabel(requested.mode)} started for "${requested.title}".`);
  const collection = requested.mode === "push"
    ? await collectLocalCanonicalItems(requested, { logger })
    : await collectMediaForceSyncItems(resolvedConfig, requested, { now, logger });
  const loopStore = createLoopStore();
  const results = [];
  const records = [];
  let cancelled = Boolean(isCancelled());

  for (const media of collection.items) {
    if (isCancelled()) {
      cancelled = true;
      logger(`[${requested.mode}] Cancellation acknowledged; stopping before remaining items.`);
      break;
    }
    const canonicalState = media.canonicalState || "watched";
    let record = await findWatchedByAnyMediaKey(media).catch(() => null);
    let inserted = false;
    if (requested.mode !== "push" && !record) {
      const insertedResult = await insertWatchRecord({
        ...media,
        sync_action: "watched",
        sync_dispatch_telemetry: pendingTelemetry(media, requested),
      }, { skipInvalidate: true });
      record = insertedResult.record;
      record.id = insertedResult.id;
      inserted = true;
      await insertedResult.assetPrefetch?.catch(() => null);
    }

    await upsertPlaystateForMedia(media, canonicalState, media.watched_at, { skipInvalidate: true });

    let summary;
    if (requested.mode === "pull") {
      summary = {
        skipped: false,
        status: "success",
        details: "Watched state pulled into Plembfin; no outbound targets selected.",
        targetStates: [],
      };
      logger(`[pull] ${media.title}: imported ${canonicalState} state into Plembfin.`);
    } else {
      const syncMedia = requested.target ? { ...media, syncTargets: [requested.target] } : media;
      logger(`[${requested.mode}] ${media.title}: sending ${canonicalState} state to ${sourceLabel(requested.target)}.`);
      summary = await syncCanonicalPlaystate(syncMedia, resolvedConfig, loopStore, canonicalState).catch((error) => ({
        skipped: false,
        status: "error",
        details: `Canonical propagation failed: ${error.message || String(error)}`,
        targetStates: [],
      }));
    }

    for (const target of summary.targetStates || []) {
      logger(`[${requested.mode}] ${media.title}: ${target.target || "target"} -> ${target.status}${target.detail ? ` (${target.detail})` : ""}.`);
    }

    if (record?.id) {
      await updateWatchTelemetry(record.id, completedTelemetry(media, summary, requested), { skipInvalidate: true });
      await appendForceSyncHistory(media, summary, requested);
    }

    const freshRecord = record?.id ? await getWatchRecordById(record.id).catch(() => null) : null;
    if (freshRecord) records.push(freshRecord);
    const operationStatus = requested.mode === "pull" ? "pulled" : summary.status || "unknown";
    logger(`[${requested.mode}] ${media.title}: ${operationStatus} — ${summary.details || "complete"}`);
    results.push({
      title: media.title,
      type: media.type,
      season: media.season,
      episode: media.episode,
      source: media.source,
      id: record?.id || "",
      inserted,
      status: operationStatus,
      canonicalState,
      targetStates: summary.targetStates || [],
    });
  }

  cancelled = cancelled || Boolean(isCancelled());
  await invalidateHistoryDerivedCaches().catch(() => null);
  logger(cancelled
    ? `[${requested.mode}] ${modeLabel(requested.mode)} cancelled after ${results.length} item${results.length === 1 ? "" : "s"}.`
    : `[${requested.mode}] ${modeLabel(requested.mode)} finished: ${results.length} item${results.length === 1 ? "" : "s"}.`);
  return {
    ok: true,
    title: requested.title,
    type: requested.type,
    mode: requested.mode,
    target: requested.target || "all",
    pullFrom: requested.source || "all",
    found: collection.items.length,
    imported: results.filter((result) => result.inserted).length,
    existing: results.filter((result) => !result.inserted).length,
    pulled: results.filter((result) => result.status === "pulled").length,
    synced: requested.mode === "pull" ? 0 : results.filter((result) => ["success", "partial", "skipped"].includes(result.status)).length,
    sourceResults: collection.sourceResults,
    cancelled,
    results,
    records,
  };
}
