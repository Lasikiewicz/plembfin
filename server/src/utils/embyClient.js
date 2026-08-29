import { fetchWithTimeout } from "./outbound.js";

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
    throw new Error(`Emby request failed with status ${response.status}`);
  }
  return response.json();
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
  const hasProviderIdentity = Boolean(media.ids?.imdb || media.ids?.tmdb || media.ids?.tvdb);
  const inFlightAliases = hasProviderIdentity ? aliases.filter((alias) => !alias.includes("|title:")) : aliases;
  const cached = getCachedEmbyEntry(aliases, media);
  if (cached) return cached;
  for (const alias of inFlightAliases) {
    const pending = embySeriesInFlight.get(alias);
    if (pending) return pending;
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
  for (const alias of inFlightAliases) embySeriesInFlight.set(alias, promise);
  try { return await promise; } finally {
    for (const [alias, pending] of embySeriesInFlight) if (pending === promise) embySeriesInFlight.delete(alias);
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
  return entry.episodesByCoordinate.get(`${Number(season)}:${Number(episodeNum)}`) || [];
}

export function embyEpisodeMatchesCoordinates(item = {}, season, episode) {
  return Number(item.ParentIndexNumber) === Number(season) && Number(item.IndexNumber) === Number(episode);
}

export async function findEmbyItems(config, media) {
  if (media.type === "movie") {
    let movies = await findByProviderIds(config, media, "Movie");
    if (!movies || movies.length === 0) {
      movies = await searchEmbyFallback(config, media, "Movie");
    }
    return movies;
  }
  if (media.type === "series" || media.type === "show") {
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

    const items = await findEmbyItems(config, media);
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

    const items = await findEmbyItems(config, media);
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

    const items = await findEmbyItems(config, media);
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
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("Filters", "IsResumable");
  url.searchParams.set("IncludeItemTypes", "Movie,Episode");
  url.searchParams.set("Fields", "ProviderIds,SeriesProviderIds,UserData,PremiereDate,ProductionYear,RunTimeTicks");
  url.searchParams.set("SortBy", "DatePlayed");
  url.searchParams.set("SortOrder", "Descending");
  if (Number(limit) > 0) url.searchParams.set("Limit", String(Math.max(1, Math.round(Number(limit)))));
  url.searchParams.set("api_key", config.apiKey);

  const data = await fetchJson(url, config);
  return data?.Items || [];
}
