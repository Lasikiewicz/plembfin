import { fetchWithTimeout } from "./outbound.js";
import { fetchPlexMetadataItem } from "./plexClient.js";
import { parsePlexGuids, normalizeProviderIds } from "./parsers.js";
import { jellyfinAuthHeaders } from "./jellyfinAuth.js";

// Resolving the *series* identity for an episode.
//
// Every media server reports two sets of provider ids for an episode: the
// episode's own, and the series'. Plembfin keys episodes on the series ids plus
// season/episode coordinates, which is what watch_history has always stored
// (`episode:1:5:tvdb:435298` - 435298 is the show).
//
// The parsers try to prefer series ids from the payload, but the payload does
// not always carry them:
//
//   - Plex's modern agent sends `grandparentGuid="plex://show/65a075..."`, an
//     internal id with no external provider in it, and sends no grandparent
//     <Guid> children at all. Only the episode's own <Guid> children are
//     present. So the preference silently fell through to episode ids.
//   - Emby and Jellyfin send `SeriesProviderIds` on some payload shapes and
//     omit it on others (notably the flat webhook templates).
//
// The result was episode-level ids stored where series ids belong: the record
// then joins to nothing, so no artwork and no metadata resolve for it, and it
// does not match the other watches of the same show.
//
// This module does the second lookup those payloads need, keyed by the series
// id the media server itself gave us, and memoized so a burst of progress
// events for one show is a single request.

const CACHE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function hasAnyId(ids = {}) {
  return Boolean(ids.imdb || ids.tmdb || ids.tvdb);
}

function cacheKey(source, seriesItemId) {
  return `${source}:${seriesItemId}`;
}

function readCache(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function writeCache(key, value) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + (hasAnyId(value) ? CACHE_TTL_MS : NEGATIVE_TTL_MS),
  });
}

export function resetSeriesIdentityCache() {
  cache.clear();
}

async function fetchPlexSeriesIds(config, seriesItemId) {
  const metadata = await fetchPlexMetadataItem(config, seriesItemId, { lane: "interactive" });
  if (!metadata) return null;
  return parsePlexGuids(metadata);
}

async function fetchEmbyLikeSeriesIds(source, config, seriesItemId) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const userId = config.userId;
  if (!baseUrl || !userId) return null;

  const url = new URL(`${baseUrl}/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(seriesItemId)}`);
  url.searchParams.set("Fields", "ProviderIds");
  const headers =
    source === "jellyfin"
      ? jellyfinAuthHeaders(config)
      : { Accept: "application/json", "X-Emby-Token": config.apiKey };
  if (source === "emby") url.searchParams.set("api_key", config.apiKey);

  const response = await fetchWithTimeout(url, { headers, lane: "interactive" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${source} series lookup failed with status ${response.status} for item ${seriesItemId}`);
  const item = await response.json();
  return normalizeProviderIds(item?.ProviderIds || {});
}

// Returns the series' provider ids, or null when they cannot be resolved.
// Never throws: an unreachable media server must not break ingestion, and the
// caller keeps whatever ids it already had.
export async function resolveSeriesIds(source, seriesItemId, config) {
  const cleanId = String(seriesItemId || "").trim();
  if (!cleanId || !config) return null;

  const key = cacheKey(source, cleanId);
  const cached = readCache(key);
  if (cached !== undefined) return cached;

  let ids = null;
  try {
    if (source === "plex") ids = await fetchPlexSeriesIds(config, cleanId);
    else if (source === "emby" || source === "jellyfin") ids = await fetchEmbyLikeSeriesIds(source, config, cleanId);
  } catch (error) {
    console.warn("Series identity lookup failed", { source, seriesItemId: cleanId, error: error?.message || String(error) });
    ids = null;
  }

  const resolved = ids && hasAnyId(ids) ? ids : null;
  writeCache(key, resolved);
  return resolved;
}

// Upgrades an episode media object in place of its episode-level provider ids.
//
// Only episodes are touched, and only when the payload actually carries a
// series handle. If the payload already agrees with the series identity, or the
// lookup fails, the media object is returned unchanged - so this can be applied
// to every ingest path without making any of them depend on it succeeding.
export async function withSeriesIdentity(media, config) {
  if (!media || media.type !== "episode") return media;

  // Different ingest paths use different names for the media server's native
  // series handle. Webhooks call it seriesItemId; scheduled Continue Watching
  // rows historically called it seriesProviderItemId. They are the same
  // lookup key and must all pass through the resolver before persistence.
  const seriesItemId = media.seriesItemId || media.seriesProviderItemId || media.seriesId || media.series_id;
  if (!seriesItemId) return media;

  const source = String(media.source || "").toLowerCase();
  const providerConfig = config?.[source];
  if (!providerConfig) return media;

  const seriesIds = await resolveSeriesIds(source, seriesItemId, providerConfig);
  if (!seriesIds) return media;

  const current = media.ids || {};
  const alreadyCorrect = ["imdb", "tmdb", "tvdb"].every((provider) => !seriesIds[provider] || current[provider] === seriesIds[provider]);
  if (alreadyCorrect) return media;

  console.log("Series identity resolved for episode", {
    source,
    title: media.title,
    seriesItemId,
    episodeIds: { imdb: current.imdb, tmdb: current.tmdb, tvdb: current.tvdb },
    seriesIds,
  });

  return { ...media, ids: { ...current, ...seriesIds } };
}
