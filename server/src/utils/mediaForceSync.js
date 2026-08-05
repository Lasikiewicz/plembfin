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
  findWatchedByAnyMediaKey,
  getWatchRecordById,
  insertWatchRecord,
  invalidateHistoryDerivedCaches,
  updateWatchTelemetry,
  upsertPlaystateForMedia,
} from "./dataRepo.js";

const MEDIA_SERVERS = ["plex", "emby", "jellyfin"];

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
  const source = clean(input.source).toLowerCase();

  if (!title) throw new Error("title is required");
  if (!["movie", "show", "episode"].includes(type)) throw new Error("type must be movie, show, or episode");
  if (source && !MEDIA_SERVERS.includes(source)) throw new Error("source must be plex, emby, or jellyfin");

  return { title, type, ids, season, episode, source };
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

export async function collectMediaForceSyncItems(config = {}, requested, { now = Date.now(), logger = () => {} } = {}) {
  const sources = requested.source ? [requested.source] : MEDIA_SERVERS;
  const sourceResults = [];
  const collected = [];

  await Promise.all(sources.map(async (source) => {
    if (!sourceConfigured(config, source)) {
      sourceResults.push({ source, status: "not_configured", watchedCount: 0 });
      return;
    }
    try {
      const items = await collectSourceItems(config, requested, source, now);
      collected.push(...items);
      sourceResults.push({ source, status: items.length ? "success" : "not_watched", watchedCount: items.length });
    } catch (error) {
      logger(`Detail Force Sync: ${source} lookup failed: ${error.message || String(error)}`);
      sourceResults.push({ source, status: "error", watchedCount: 0, error: error.message || String(error) });
    }
  }));

  sourceResults.sort((a, b) => MEDIA_SERVERS.indexOf(a.source) - MEDIA_SERVERS.indexOf(b.source));
  return { items: dedupeMedia(collected), sourceResults };
}

function pendingTelemetry(media) {
  return [
    `Origin: ${media.source}`,
    "Action: Force Synced Watched",
    `Media: ${media.title}`,
    "Loop-check: Passed",
    "Dispatch status: pending",
    "Details: Detail-page Force Sync imported watched state and queued canonical propagation.",
  ].join("\n");
}

function completedTelemetry(media, summary) {
  const lines = [
    `Origin: ${media.source}`,
    "Action: Force Synced Watched",
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

async function appendForceSyncHistory(media, summary) {
  await appendSyncHistory({
    mediaType: media.type,
    title: media.title,
    source: media.source,
    status: summary.status || "unknown",
    details: `Detail-page Force Sync: ${summary.details || "completed"}`,
    action: "watched",
    targetStates: summary.targetStates || [],
    rawPayloadDebug: {
      event: "media_force_sync",
      phase: "completed",
      ids: media.ids || {},
      season: media.season ?? null,
      episode: media.episode ?? null,
    },
  }).catch(() => null);
}

export async function forceSyncMediaState(input, { config = null, now = Date.now(), logger = () => {} } = {}) {
  const requested = normalizeMediaForceSyncRequest(input);
  const resolvedConfig = config || await loadMediaConfig();
  const collection = await collectMediaForceSyncItems(resolvedConfig, requested, { now, logger });
  const loopStore = createLoopStore();
  const results = [];
  const records = [];

  for (const media of collection.items) {
    let record = await findWatchedByAnyMediaKey(media).catch(() => null);
    let inserted = false;
    if (!record) {
      const insertedResult = await insertWatchRecord({
        ...media,
        sync_action: "watched",
        sync_dispatch_telemetry: pendingTelemetry(media),
      }, { skipInvalidate: true });
      record = insertedResult.record;
      record.id = insertedResult.id;
      inserted = true;
      await insertedResult.assetPrefetch?.catch(() => null);
    }

    await upsertPlaystateForMedia(media, "watched", media.watched_at, { skipInvalidate: true });

    const summary = await syncCanonicalPlaystate(media, resolvedConfig, loopStore).catch((error) => ({
      skipped: false,
      status: "error",
      details: `Canonical propagation failed: ${error.message || String(error)}`,
      targetStates: [],
    }));
    await updateWatchTelemetry(record.id, completedTelemetry(media, summary), { skipInvalidate: true });
    await appendForceSyncHistory(media, summary);

    const freshRecord = await getWatchRecordById(record.id).catch(() => null);
    if (freshRecord) records.push(freshRecord);
    results.push({
      title: media.title,
      type: media.type,
      season: media.season,
      episode: media.episode,
      source: media.source,
      id: record.id,
      inserted,
      status: summary.status || "unknown",
      targetStates: summary.targetStates || [],
    });
  }

  await invalidateHistoryDerivedCaches().catch(() => null);
  return {
    ok: true,
    title: requested.title,
    type: requested.type,
    found: collection.items.length,
    imported: results.filter((result) => result.inserted).length,
    existing: results.filter((result) => !result.inserted).length,
    synced: results.filter((result) => ["success", "partial", "skipped"].includes(result.status)).length,
    sourceResults: collection.sourceResults,
    results,
    records,
  };
}
