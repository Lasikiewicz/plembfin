import { fetchWithTimeout } from "./outbound.js";
import { compoundEpisodeItemsForMedia } from "./compoundEpisode.js";
import { restoreLookupKey } from "./restoreLookupCache.js";

function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function requireEmbyConfig(config = {}) {
  if (!config.baseUrl || !config.apiKey || !config.userId) {
    throw new Error("Missing Emby baseUrl, apiKey, or userId");
  }
}

function authHeaders(config) {
  return {
    Accept: "application/json",
    "X-Emby-Token": config.apiKey,
  };
}

export function embyResumeLastPlayedDate(media = {}, now = Date.now()) {
  const sourceValue = media.updatedAt ?? media.updated_at ?? media.progressUpdatedAt ?? media.playedAt;
  const numericValue = sourceValue === "" || sourceValue == null ? NaN : Number(sourceValue);
  const sourceTime = Number.isFinite(numericValue)
    ? numericValue
    : Date.parse(String(sourceValue || ""));
  const fallbackTime = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  return new Date(Number.isFinite(sourceTime) && sourceTime > 0 ? sourceTime : fallbackTime).toISOString();
}

function providerTerms(ids = {}) {
  return [
    ids.imdb ? `imdb.${ids.imdb}` : undefined,
    ids.tmdb ? `tmdb.${ids.tmdb}` : undefined,
    ids.tvdb ? `tvdb.${ids.tvdb}` : undefined,
  ].filter(Boolean);
}

async function fetchJson(url, config, media = null) {
  const response = await fetchWithTimeout(url, { headers: authHeaders(config), lane: media?.lane || "sync" });
  if (!response.ok) {
    const error = new Error(`Emby request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function fetchPagedFeed(config, buildUrl, limit = 0, { pageSize: preferredPageSize = 100 } = {}) {
  const requestedLimit = Number(limit) > 0 ? Math.max(1, Math.round(Number(limit))) : 0;
  const maximumPageSize = Math.min(Math.max(1, Math.round(Number(preferredPageSize) || 100)), 500);
  const pageSize = requestedLimit ? Math.min(requestedLimit, maximumPageSize) : maximumPageSize;
  const items = [];
  const seen = new Set();
  for (let start = 0; start <= 10_000_000;) {
    const data = await fetchJson(buildUrl(start, pageSize), config);
    const page = Array.isArray(data?.Items) ? data.Items : [];
    let newItems = 0;
    for (const item of page) {
      const id = String(item?.Id || item?.id || "").trim();
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      items.push(item);
      newItems++;
      if (requestedLimit && items.length >= requestedLimit) return items.slice(0, requestedLimit);
    }
    const total = Number(data?.TotalRecordCount || 0);
    if (!page.length || !newItems || (total > 0 && start + page.length >= total) || (total <= 0 && page.length < pageSize)) break;
    // Some Emby-compatible servers cap Limit below the requested size. Move
    // by the response length so a server-side cap cannot skip a range.
    start += page.length;
  }
  return requestedLimit ? items.slice(0, requestedLimit) : items;
}

function nativeEmbyItems(media = {}) {
  const configured = media.provider_items || media.providerItems || {};
  const values = Array.isArray(configured.emby) ? configured.emby : configured.emby ? [configured.emby] : [];
  const directId = media.provider_item_id || media.providerItemId || media.emby_id || media.embyId;
  return [...new Set([...values, directId].map((value) => String(value || "").trim()).filter(Boolean))]
    .map((Id) => ({ Id }));
}

async function findEmbyItemsForMutation(config, media = {}) {
  const direct = nativeEmbyItems(media);
  if (direct.length) return direct;
  const cache = media?.restoreLookupCache;
  if (cache && typeof cache.resolve === "function") {
    return cache.resolve(
      restoreLookupKey("emby", config, media),
      media,
      () => findEmbyItems(config, media),
    );
  }
  return findEmbyItems(config, media);
}

function extractYear(title) {
  const match = String(title || "").match(/\((\d{4})\)/);
  return match ? Number(match[1]) : undefined;
}

function titleMatches(a, b) {
  const clean = (s) => String(s || "").toLowerCase().replace(/\(\d{4}\)/g, "").trim().replace(/[^a-z0-9]/g, "");
  return clean(a) === clean(b);
}

function yearMatches(dbTitle, resultYear) {
  const dbYear = extractYear(dbTitle);
  if (!dbYear || !resultYear) return true;
  return Number(dbYear) === Number(resultYear);
}

function parseShowTitle(title) {
  const str = String(title || "");
  const regex = /(?:\s*-\s*|\s+)S(\d+)E(\d+)/i;
  const match = str.match(regex);
  if (match) {
    const cleanTitle = str.slice(0, match.index).replace(/\s*-\s*$/, "").trim();
    return {
      title: cleanTitle,
      season: Number(match[1]),
      episode: Number(match[2])
    };
  }
  const cleanTitle = str.replace(/\s*-\s*$/, "").trim();
  return {
    title: cleanTitle,
    season: undefined,
    episode: undefined
  };
}

const SERIES_CACHE_TTL_MS = 10 * 60 * 1000;
const SERIES_CACHE_MAX_ENTRIES = 100;
const embySeriesCache = new Map();
const embySeriesInFlight = new Map();
let embyCacheNow = () => Date.now();

function mediaIdentitiesCompatible(left = {}, right = {}) {
  return ["imdb", "tmdb", "tvdb"].every((provider) => {
    const a = String(left?.ids?.[provider] || "").trim().toLowerCase();
    const b = String(right?.ids?.[provider] || "").trim().toLowerCase();
    return !a || !b || a === b;
  });
}

function normalizedShowTitle(media = {}) {
  return parseShowTitle(media.title).title.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function embySeriesAliases(config, media) {
  const scope = `emby|${trimTrailingSlash(config.baseUrl).toLowerCase()}|${String(config.userId).toLowerCase()}`;
  const aliases = providerTerms(media.ids).map((term) => `${scope}|${term.toLowerCase()}`);
  const year = extractYear(media.title);
  const title = normalizedShowTitle(media);
  if (title) aliases.push(`${scope}|title:${title}${year ? `|year:${year}` : ""}`);
  return [...new Set(aliases)];
}

function embyEntryCompatible(entry, media) {
  if (!entry.series.length) return true;
  const requested = media.ids || {};
  if (!requested.imdb && !requested.tmdb && !requested.tvdb) return true;
  return entry.series.some((item) => {
    const ids = item.ProviderIds || {};
    return (!requested.imdb || !ids.Imdb || String(requested.imdb).toLowerCase() === String(ids.Imdb).toLowerCase())
      && (!requested.tmdb || !ids.Tmdb || String(requested.tmdb).toLowerCase() === String(ids.Tmdb).toLowerCase())
      && (!requested.tvdb || !ids.Tvdb || String(requested.tvdb).toLowerCase() === String(ids.Tvdb).toLowerCase());
  });
}

function deleteEmbyEntry(entry) {
  for (const [alias, value] of embySeriesCache) if (value === entry) embySeriesCache.delete(alias);
}

function getCachedEmbyEntry(aliases, media) {
  const now = embyCacheNow();
  for (const alias of aliases) {
    const entry = embySeriesCache.get(alias);
    if (!entry) continue;
    if (entry.expiresAt <= now) { deleteEmbyEntry(entry); continue; }
    if (embyEntryCompatible(entry, media)) return entry;
  }
  return null;
}

function storeEmbyEntry(entry, aliases) {
  for (const alias of aliases) embySeriesCache.set(alias, entry);
  const entries = [...new Set(embySeriesCache.values())].sort((a, b) => a.createdAt - b.createdAt);
  while (entries.length > SERIES_CACHE_MAX_ENTRIES) deleteEmbyEntry(entries.shift());
}

async function resolveEmbySeriesIdentity(config, media) {
  const aliases = embySeriesAliases(config, media);
  // Title fallback must participate in the in-flight map too. Provider IDs
  // are often present in imported history even when that server cannot resolve
  // them; excluding the title alias made every sibling episode launch its own
  // slow title search during a restore. Pending requests still carry their
  // media identity so two conflicting remakes do not share work.
  const inFlightAliases = aliases;
  const cached = getCachedEmbyEntry(aliases, media);
  if (cached) return cached;
  for (const alias of inFlightAliases) {
    const pending = embySeriesInFlight.get(alias);
    if (pending && mediaIdentitiesCompatible(pending.media, media)) return pending.promise;
  }

  const promise = (async () => {
    let series = [];
    try { series = await findByProviderIds(config, media, "Series"); } catch (error) {
      console.error("Emby provider discovery failed; trying title fallback", error);
    }
    if (!series.length) series = await searchEmbyFallback(config, media, "Series");
    if (!series.length) {
      const now = embyCacheNow();
      const empty = { series: [], episodesByCoordinate: new Map(), expiresAt: now + 20_000, createdAt: now };
      storeEmbyEntry(empty, aliases);
      return empty;
    }
    const settled = await Promise.allSettled(series.map((item) => fetchEmbyEpisodes(config, item.Id, media)));
    const episodes = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (!episodes.length && settled.every((result) => result.status === "rejected")) throw settled[0].reason;
    const episodesByCoordinate = new Map();
    for (const item of episodes) {
      const key = `${Number(item.ParentIndexNumber)}:${Number(item.IndexNumber)}`;
      if (!episodesByCoordinate.has(key)) episodesByCoordinate.set(key, []);
      episodesByCoordinate.get(key).push(item);
    }
    const now = embyCacheNow();
    const entry = { series, episodesByCoordinate, expiresAt: now + SERIES_CACHE_TTL_MS, createdAt: now };
    const discoveredAliases = [...aliases];
    for (const item of series) {
      const ids = item.ProviderIds || {};
      discoveredAliases.push(...embySeriesAliases(config, { ...media, ids: { imdb: ids.Imdb, tmdb: ids.Tmdb, tvdb: ids.Tvdb } }));
    }
    storeEmbyEntry(entry, [...new Set(discoveredAliases)]);
    return entry;
  })();
  const pendingEntry = { media, promise };
  for (const alias of inFlightAliases) embySeriesInFlight.set(alias, pendingEntry);
  try { return await promise; } finally {
    for (const [alias, pending] of embySeriesInFlight) if (pending === pendingEntry) embySeriesInFlight.delete(alias);
  }
}

export function __resetEmbySeriesCache() {
  embySeriesCache.clear();
  embySeriesInFlight.clear();
  embyCacheNow = () => Date.now();
}

export function __setEmbySeriesCacheNow(fn) {
  embyCacheNow = typeof fn === "function" ? fn : () => Date.now();
}

function invalidateEmbySeriesIdentity(config, media) {
  for (const alias of embySeriesAliases(config, media)) {
    const entry = embySeriesCache.get(alias);
    if (entry) deleteEmbyEntry(entry);
  }
  media?.restoreLookupCache?.delete?.(restoreLookupKey("emby", config, media));
}

async function searchEmbyFallback(config, media, targetType) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);

  const parsed = parseShowTitle(media.title);
  const queryTitle = (targetType === "Series" || targetType === "show") ? parsed.title : media.title;

  url.searchParams.set("Recursive", "true");
  url.searchParams.set("IncludeItemTypes", targetType);
  url.searchParams.set("SearchTerm", queryTitle);
  url.searchParams.set("Fields", "ProviderIds,UserData");
  url.searchParams.set("api_key", config.apiKey);

  console.log("Emby search fallback started", { query: queryTitle, targetType });
  try {
    const body = await fetchJson(url, config, media);
    const results = body?.Items || [];

    const matched = results.filter((item) => {
      if (!titleMatches(queryTitle, item.Name)) return false;
      if (!yearMatches(media.title, item.ProductionYear)) return false;
      return true;
    });

    if (matched.length > 0) {
      console.log("Emby search fallback matched items", { count: matched.length, itemIds: matched.map(i => i.Id) });
      return matched;
    }
  } catch (error) {
    console.error("Emby search fallback failed", error);
    throw error;
  }
  return [];
}

async function findByProviderIds(config, media, itemTypes) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const allMatched = new Map();
  const terms = providerTerms(media.ids);
  const lookups = terms.map(async (providerTerm) => {
    const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
    url.searchParams.set("Recursive", "true");
    url.searchParams.set("IncludeItemTypes", itemTypes);
    url.searchParams.set("Fields", "ProviderIds,UserData");
    url.searchParams.set("AnyProviderIdEquals", providerTerm);
    url.searchParams.set("api_key", config.apiKey);

    console.log("Emby lookup started", { itemTypes, providerTerm });
    const body = await fetchJson(url, config, media);
      const [prov, val] = providerTerm.split(".");
      const providerKey = prov.charAt(0).toUpperCase() + prov.slice(1);

      const items = body?.Items?.filter((it) => {
        const pIds = it.ProviderIds || {};
        return String(pIds[providerKey] || "").toLowerCase() === String(val).toLowerCase();
      }) || [];

    return { providerTerm, items };
  });
  const settled = await Promise.allSettled(lookups);
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`Emby lookup failed for providerTerm: ${terms[index]}`, result.reason);
      return;
    }
    for (const item of result.value.items) {
      if (item?.Id) allMatched.set(item.Id, item);
    }
  });
  if (terms.length && settled.every((result) => result.status === "rejected")) {
    throw settled[0].reason;
  }

  const results = Array.from(allMatched.values());
  if (results.length > 0) {
    console.log("Emby lookup matched items", { count: results.length, itemIds: results.map(i => i.Id) });
    return results;
  }

  return [];
}

async function findEpisode(config, media) {
  const parsed = parseShowTitle(media.title);
  const season = media.season ?? parsed.season;
  const episodeNum = media.episode ?? parsed.episode;
  const entry = await resolveEmbySeriesIdentity(config, media);
  return compoundEpisodeItemsForMedia(entry.episodesByCoordinate, {
    ...media,
    season,
    episode: episodeNum,
  });
}

export function embyEpisodeMatchesCoordinates(item = {}, season, episode) {
  return Number(item.ParentIndexNumber) === Number(season) && Number(item.IndexNumber) === Number(episode);
}

export async function findEmbyItems(config, media) {
  const direct = nativeEmbyItems(media);
  if (direct.length) return direct;
  if (media.type === "movie") {
    let movies = await findByProviderIds(config, media, "Movie");
    if (!movies || movies.length === 0) {
      movies = await searchEmbyFallback(config, media, "Movie");
    }
    return movies;
  }
  if (media.type === "tv" || media.type === "series" || media.type === "show") {
    let series = await findByProviderIds(config, media, "Series");
    if (!series || series.length === 0) {
      series = await searchEmbyFallback(config, media, "Series");
    }
    return series;
  }
  if (media.type === "episode") return findEpisode(config, media);
  return [];
}

export async function markEmbyPlayed(config, media) {
  try {
    requireEmbyConfig(config);

    const items = await findEmbyItemsForMutation(config, media);
    if (!items || items.length === 0) {
      console.log(`[NOT FOUND] No matching item in Emby library for: "${media.title}"`);
      return { platform: "emby", status: "not_found" };
    }

    let lastHttpStatus = 200;
    const markJobs = items.map(async (item) => {
      const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/PlayedItems/${item.Id}`);
      url.searchParams.set("api_key", config.apiKey);

      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: authHeaders(config),
        lane: media?.lane || "sync",
      });
      if (!response.ok) {
        const error = new Error(`Emby mark played failed with status ${response.status} for item ${item.Id}`);
        error.status = response.status;
        throw error;
      }
      console.log("Emby item marked played", { itemId: item.Id });
      lastHttpStatus = response.status;
      return response.status;
    });

    await Promise.all(markJobs);
    return { platform: "emby", status: "fulfilled", itemId: items[0].Id, itemIds: items.map(i => i.Id), httpStatus: lastHttpStatus };
  } catch (error) {
    if (error?.status === 404 && media.type === "episode" && !media.__identityRetry) {
      invalidateEmbySeriesIdentity(config, media);
      return markEmbyPlayed(config, { ...media, __identityRetry: true });
    }
    console.error("Emby client failed", error);
    throw error;
  }
}

export async function markEmbyUnplayed(config, media) {
  try {
    requireEmbyConfig(config);

    const items = await findEmbyItemsForMutation(config, media);
    if (!items || items.length === 0) {
      console.log(`[NOT FOUND] No matching item in Emby library for: "${media.title}"`);
      return { platform: "emby", status: "not_found" };
    }

    let lastHttpStatus = 200;
    const markJobs = items.map(async (item) => {
      const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/PlayedItems/${item.Id}`);
      url.searchParams.set("api_key", config.apiKey);

      const response = await fetchWithTimeout(url, {
        method: "DELETE",
        headers: authHeaders(config),
        lane: media?.lane || "sync",
      });
      if (!response.ok) {
        const error = new Error(`Emby mark unplayed failed with status ${response.status} for item ${item.Id}`);
        error.status = response.status;
        throw error;
      }
      console.log("Emby item marked unplayed", { itemId: item.Id });
      lastHttpStatus = response.status;
      return response.status;
    });

    await Promise.all(markJobs);
    return { platform: "emby", status: "fulfilled", itemId: items[0].Id, itemIds: items.map(i => i.Id), httpStatus: lastHttpStatus };
  } catch (error) {
    if (error?.status === 404 && media.type === "episode" && !media.__identityRetry) {
      invalidateEmbySeriesIdentity(config, media);
      return markEmbyUnplayed(config, { ...media, __identityRetry: true });
    }
    console.error("Emby client failed", error);
    throw error;
  }
}

export async function setEmbyProgress(config, media) {
  try {
    requireEmbyConfig(config);

    const items = await findEmbyItemsForMutation(config, media);
    if (!items || items.length === 0) {
      console.log(`[NOT FOUND] No matching item in Emby library for: "${media.title}"`);
      return { platform: "emby", status: "not_found" };
    }

    const positionMs = Math.max(0, Math.round(Number(media.positionMs ?? media.offsetMs ?? 0)));
    const hasPosition = media.positionMs !== undefined || media.offsetMs !== undefined;
    if (!hasPosition) {
      return { platform: "emby", status: "skipped", detail: "No resume position supplied" };
    }

    let lastHttpStatus = 200;
    const progressJobs = items.map(async (item) => {
      const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/Items/${item.Id}/UserData`);
      url.searchParams.set("api_key", config.apiKey);
      const userData = {
        PlaybackPositionTicks: positionMs * 10000,
        Played: false,
      };
      if (positionMs > 0) {
        // Emby's Resume feed is ordered by LastPlayedDate. A position without
        // that date works on the item detail page but can be absent from
        // Continue Watching, especially when the feed is limited to recent
        // items. Preserve the source progress time instead of making a replay
        // look like fresh playback; position clears deliberately omit it.
        userData.LastPlayedDate = embyResumeLastPlayedDate(media);
      }

      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          ...authHeaders(config),
          "Content-Type": "application/json",
        },
        lane: media?.lane || "sync",
        body: JSON.stringify(userData),
      });
      if (!response.ok) {
        const error = new Error(`Emby progress update failed with status ${response.status} for item ${item.Id}`);
        error.status = response.status;
        throw error;
      }
      console.log("Emby item resume progress updated", { itemId: item.Id, positionMs });
      lastHttpStatus = response.status;
      return response.status;
    });

    await Promise.all(progressJobs);
    return { platform: "emby", status: "fulfilled", itemId: items[0].Id, itemIds: items.map(i => i.Id), positionMs, httpStatus: lastHttpStatus };
  } catch (error) {
    if (error?.status === 404 && media.type === "episode" && !media.__identityRetry) {
      invalidateEmbySeriesIdentity(config, media);
      return setEmbyProgress(config, { ...media, __identityRetry: true });
    }
    console.error("Emby progress client failed", error);
    throw error;
  }
}

export async function fetchEmbyEpisodes(config, parentId, media = null) {
  requireEmbyConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
  url.searchParams.set("ParentId", parentId);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("IncludeItemTypes", "Episode");
  url.searchParams.set("Fields", "ProviderIds,UserData,PremiereDate,ProductionYear,MediaSources,MediaStreams,Width,Height");
  url.searchParams.set("api_key", config.apiKey);

  const data = await fetchJson(url, config, media);
  return data?.Items || [];
}

export async function fetchEmbySeriesEpisodes(config, media) {
  requireEmbyConfig(config);
  const { series } = await resolveEmbySeriesIdentity(config, media);
  if (!series.length) return [];

  // Callers use this API to inspect mutable UserData, so only the stable
  // native series identity is reused; episode state is always fetched fresh.
  const episodeGroups = await Promise.all(series.map((item) => fetchEmbyEpisodes(config, item.Id, media).catch(() => [])));
  return episodeGroups.flat();
}

// Mark unplayed directly by native item Id, skipping the search/match step. Used by the
// authoritative restore clear pass, which already has the Id from fetchEmbyWatchedItems.
export async function markEmbyUnplayedById(config, itemId, { lane = "sync" } = {}) {
  requireEmbyConfig(config);
  if (!itemId) return { platform: "emby", status: "not_found" };

  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/PlayedItems/${itemId}`);
  url.searchParams.set("api_key", config.apiKey);

  const response = await fetchWithTimeout(url, { method: "DELETE", headers: authHeaders(config), lane });
  if (!response.ok) {
    throw new Error(`Emby mark unplayed failed with status ${response.status} for item ${itemId}`);
  }
  return { platform: "emby", status: "fulfilled", itemId, httpStatus: response.status };
}

export async function hideEmbyFromResume(config, itemId, { lane = "interactive" } = {}) {
  requireEmbyConfig(config);
  if (!itemId) return { platform: "emby", status: "not_found" };
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${encodeURIComponent(config.userId)}/Items/${encodeURIComponent(itemId)}/HideFromResume`);
  url.searchParams.set("Hide", "true");
  const response = await fetchWithTimeout(url, { method: "POST", headers: authHeaders(config), lane });
  if (!response.ok) throw new Error(`Emby resume removal failed with status ${response.status} for item ${itemId}`);
  return { platform: "emby", status: "fulfilled", itemId: String(itemId), httpStatus: response.status };
}

function buildEmbyWatchedItemsUrl(config, { limit = 0, parentId = "" } = {}) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("Filters", "IsPlayed");
  url.searchParams.set("IncludeItemTypes", "Movie,Episode");
  url.searchParams.set("Fields", "ProviderIds,SeriesProviderIds,UserData,PremiereDate,ProductionYear");
  url.searchParams.set("SortBy", "DatePlayed");
  url.searchParams.set("SortOrder", "Descending");
  if (parentId) url.searchParams.set("ParentId", String(parentId));
  if (Number(limit) > 0) url.searchParams.set("Limit", String(Math.max(1, Math.round(Number(limit)))));
  url.searchParams.set("api_key", config.apiKey);
  return url;
}

export async function fetchEmbyWatchedItems(config, { limit = 0, libraryIds } = {}) {
  requireEmbyConfig(config);
  const parents = Array.isArray(libraryIds) && libraryIds.length ? libraryIds : [""];
  const items = [];
  for (const parentId of parents) {
    const data = await fetchJson(buildEmbyWatchedItemsUrl(config, { limit, parentId }), config);
    items.push(...(data?.Items || []));
  }
  return items;
}

function buildEmbyLibraryItemsUrl(config, { parentId = "" } = {}) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("Filters", "IsUnplayed");
  url.searchParams.set("IncludeItemTypes", "Movie,Episode");
  url.searchParams.set("Fields", "ProviderIds,SeriesProviderIds,UserData,PremiereDate,ProductionYear");
  url.searchParams.set("EnableUserData", "true");
  url.searchParams.set("StartIndex", "0");
  url.searchParams.set("EnableTotalRecordCount", "true");
  if (parentId) url.searchParams.set("ParentId", String(parentId));
  url.searchParams.set("api_key", config.apiKey);
  return url;
}

// Full paginated unplayed inventory used by the scheduled availability
// reconciliation. A new duplicate/quality variant is normally unplayed on
// Emby even when Plembfin already knows that the same episode was watched.
export async function fetchEmbyLibraryItems(config, { limit = 0, libraryIds } = {}) {
  requireEmbyConfig(config);
  const parents = Array.isArray(libraryIds) && libraryIds.length ? libraryIds : [""];
  const items = [];
  for (const parentId of parents) {
    items.push(...await fetchPagedFeed(
      config,
      (start, pageSize) => {
        const url = buildEmbyLibraryItemsUrl(config, { parentId });
        url.searchParams.set("StartIndex", String(start));
        url.searchParams.set("Limit", String(pageSize));
        return url;
      },
      limit,
      { pageSize: 500 },
    ));
  }
  return items;
}

// User-visible libraries (views) with their stable ids, for sync scope selection.
export async function listEmbyLibraries(config) {
  requireEmbyConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Views`);
  url.searchParams.set("api_key", config.apiKey);
  const data = await fetchJson(url, config);
  return (data?.Items || [])
    .filter((item) => ["movies", "tvshows"].includes(String(item.CollectionType || "").toLowerCase()))
    .map((item) => ({
      id: String(item.Id),
      name: String(item.Name || item.Id),
      type: String(item.CollectionType || "").toLowerCase() === "movies" ? "movie" : "show",
    }));
}

// Cheap watched-item count via TotalRecordCount, for plan staleness checks.
export async function countEmbyWatchedItems(config, { libraryIds } = {}) {
  requireEmbyConfig(config);
  const parents = Array.isArray(libraryIds) && libraryIds.length ? libraryIds : [""];
  let total = 0;
  for (const parentId of parents) {
    const url = buildEmbyWatchedItemsUrl(config, { limit: 1, parentId });
    const data = await fetchJson(url, config);
    total += Number(data?.TotalRecordCount ?? (data?.Items || []).length);
  }
  return total;
}

export async function fetchEmbyResumableItems(config, { limit = 0 } = {}) {
  requireEmbyConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const buildNativeResumeUrl = (start, pageSize) => {
    const url = new URL(`${baseUrl}/Users/${encodeURIComponent(config.userId)}/Items/Resume`);
    url.searchParams.set("Recursive", "true");
    // Emby exposes Continue Watching through the dedicated Resume endpoint.
    // The generic Items?Filters=IsResumable query returns an empty snapshot on
    // some Emby versions even while the native Continue Watching rail is full.
    url.searchParams.set("MediaTypes", "Video");
    url.searchParams.set("Fields", "ProviderIds,SeriesProviderIds,UserData,PremiereDate,ProductionYear,RunTimeTicks");
    url.searchParams.set("StartIndex", String(start));
    url.searchParams.set("Limit", String(pageSize));
    url.searchParams.set("EnableTotalRecordCount", "true");
    url.searchParams.set("api_key", config.apiKey);
    return url;
  };

  try {
    return await fetchPagedFeed(config, buildNativeResumeUrl, limit);
  } catch (error) {
    // Keep compatibility with older Emby-compatible servers that do not
    // implement /Items/Resume. Only a missing route should select the legacy
    // query; a real auth/upstream failure must remain visible to the caller.
    if (Number(error?.status) !== 404) throw error;
    return fetchPagedFeed(config, (start, pageSize) => {
      const url = new URL(`${baseUrl}/Users/${encodeURIComponent(config.userId)}/Items`);
      url.searchParams.set("Recursive", "true");
      url.searchParams.set("Filters", "IsResumable");
      url.searchParams.set("IncludeItemTypes", "Movie,Episode");
      url.searchParams.set("Fields", "ProviderIds,SeriesProviderIds,UserData,PremiereDate,ProductionYear,RunTimeTicks");
      url.searchParams.set("SortBy", "DatePlayed");
      url.searchParams.set("SortOrder", "Descending");
      url.searchParams.set("StartIndex", String(start));
      url.searchParams.set("Limit", String(pageSize));
      url.searchParams.set("api_key", config.apiKey);
      return url;
    }, limit);
  }
}

export async function fetchEmbyNextUpItems(config, { limit = 0 } = {}) {
  requireEmbyConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  return fetchPagedFeed(config, (start, pageSize) => {
    const url = new URL(`${baseUrl}/Shows/NextUp`);
    url.searchParams.set("UserId", config.userId);
    url.searchParams.set("Fields", "ProviderIds,SeriesProviderIds,UserData,PremiereDate,ProductionYear,RunTimeTicks,MediaSources");
    url.searchParams.set("EnableResumable", "true");
    url.searchParams.set("EnableUserData", "true");
    url.searchParams.set("StartIndex", String(start));
    url.searchParams.set("Limit", String(pageSize));
    url.searchParams.set("api_key", config.apiKey);
    return url;
  }, limit);
}

// ---------------------------------------------------------------------------
// Personal ratings
// ---------------------------------------------------------------------------

function embyProviderIds(item = {}) {
  const ids = item.ProviderIds || {};
  return {
    imdb: ids.Imdb || ids.imdb || "",
    tmdb: ids.Tmdb || ids.tmdb || "",
    tvdb: ids.Tvdb || ids.tvdb || "",
    emby: item.Id || "",
  };
}

function embyRatingRecord(item = {}) {
  const type = String(item.Type || item.type || "").toLowerCase();
  const isEpisode = type === "episode";
  const isShow = type === "series";
  const providerIds = embyProviderIds(item);
  const seriesIds = isEpisode ? {
    imdb: item.SeriesProviderIds?.Imdb || item.SeriesProviderIds?.imdb || "",
    tmdb: item.SeriesProviderIds?.Tmdb || item.SeriesProviderIds?.tmdb || "",
    tvdb: item.SeriesProviderIds?.Tvdb || item.SeriesProviderIds?.tvdb || "",
  } : providerIds;
  return {
    media: {
      media_type: isEpisode ? "episode" : isShow ? "tv" : "movie",
      title: String(item.Name || item.Title || "Untitled"),
      tmdb_id: seriesIds.tmdb || "",
      tvdb_id: seriesIds.tvdb || "",
      imdb_id: seriesIds.imdb || "",
      show_title: isEpisode ? String(item.SeriesName || item.SeriesName || "") : "",
      show_tmdb_id: isEpisode ? seriesIds.tmdb || "" : "",
      show_tvdb_id: isEpisode ? seriesIds.tvdb || "" : "",
      show_imdb_id: isEpisode ? seriesIds.imdb || "" : "",
      episode_tmdb_id: isEpisode ? providerIds.tmdb || "" : "",
      episode_tvdb_id: isEpisode ? providerIds.tvdb || "" : "",
      episode_imdb_id: isEpisode ? providerIds.imdb || "" : "",
      season: isEpisode ? Number(item.ParentIndexNumber) : null,
      episode: isEpisode ? Number(item.IndexNumber) : null,
      year: Number(item.ProductionYear || 0) || null,
      poster_url: "",
    },
    providerItemId: String(item.Id || ""),
    providerIds,
    rating: Number(item.UserData?.Rating),
    ratedAt: null,
  };
}

export async function fetchEmbyPersonalRatingSnapshot(config) {
  requireEmbyConfig(config);
  const records = [];
  const pageSize = 200;
  for (let start = 0; start <= 10_000_000; start += pageSize) {
    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/Items`);
    url.searchParams.set("Recursive", "true");
    url.searchParams.set("IncludeItemTypes", "Movie,Series,Episode");
    url.searchParams.set("Fields", "ProviderIds,SeriesProviderIds,UserData,PremiereDate,ProductionYear");
    url.searchParams.set("StartIndex", String(start));
    url.searchParams.set("Limit", String(pageSize));
    url.searchParams.set("api_key", config.apiKey);
    const response = await fetchWithTimeout(url, { headers: authHeaders(config), lane: "sync" });
    if (!response.ok) {
      const error = new Error(`Emby rating scan failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    const page = data?.Items || [];
    for (const item of page) {
      const rating = Number(item.UserData?.Rating);
      if (!Number.isFinite(rating) || rating < 1 || rating > 10) continue;
      const record = embyRatingRecord(item);
      record.rating = Math.round(rating);
      if (Number.isInteger(record.rating) && record.rating >= 1 && record.rating <= 10) records.push(record);
    }
    const total = Number(data?.TotalRecordCount || 0);
    if (!page.length || page.length < pageSize || (total > 0 && start + page.length >= total)) break;
  }
  return records;
}

async function writeEmbyPersonalRating(config, media, rating, { lane = "sync" } = {}) {
  requireEmbyConfig(config);
  const lookup = {
    ...media,
    type: media.media_type || media.mediaType || media.type,
    ids: {
      tmdb: media.show_tmdb_id || media.tmdb_id,
      tvdb: media.show_tvdb_id || media.tvdb_id,
      imdb: media.show_imdb_id || media.imdb_id,
    },
  };
  const items = await findEmbyItems(config, lookup);
  if (!items?.length) return { platform: "emby", status: "not_found" };
  let lastHttpStatus = 200;
  for (const item of items) {
    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/Items/${item.Id}/UserData`);
    url.searchParams.set("api_key", config.apiKey);
    const body = { Rating: rating == null ? null : Math.max(1, Math.min(10, Math.round(Number(rating)))) };
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { ...authHeaders(config), "Content-Type": "application/json" },
      lane,
      body: JSON.stringify(body),
    });
    if (response.status === 404) return { platform: "emby", status: "not_found", itemId: item.Id };
    if (!response.ok) {
      const error = new Error(`Emby personal rating update failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    lastHttpStatus = response.status;
  }
  return { platform: "emby", status: "fulfilled", itemId: items[0].Id, itemIds: items.map((item) => item.Id), httpStatus: lastHttpStatus };
}

export function setEmbyPersonalRating(config, media, rating, options = {}) {
  return writeEmbyPersonalRating(config, media, rating, options);
}

export function clearEmbyPersonalRating(config, media, options = {}) {
  return writeEmbyPersonalRating(config, media, null, options);
}
