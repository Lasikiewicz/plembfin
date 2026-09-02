import { normalizePersonalWatchlistMedia } from "./personalWatchlistIdentity.js";
import {
  clean,
  listItems,
  normalizeRemoteMedia,
  pageResult,
  providerIdsMatch,
  requestJson,
  sortRemoteTargets,
  titleAndYearMatch,
  trimTrailingSlash,
} from "./watchlistAdapterUtils.js";

export const JELLYFIN_WATCHLIST_NAME = "Plembfin Watchlist";

function token(config = {}) {
  return String(config.apiKey || config.api_key || config.token || "");
}

function apiHeaders(config = {}) {
  return { "X-Emby-Token": token(config), "X-MediaBrowser-Token": token(config) };
}

function requireConfig(config = {}) {
  if (!config.baseUrl || !token(config) || !config.userId) {
    const error = new Error("Jellyfin watchlist needs a base URL, API key, and user account");
    error.code = "WATCHLIST_NOT_CONFIGURED";
    error.status = 424;
    throw error;
  }
}

function urlFor(config, pathname, params = {}) {
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

async function jellyfinRequest(config, pathname, { method = "GET", params = {}, body } = {}) {
  requireConfig(config);
  return requestJson(urlFor(config, pathname, params), {
    method,
    headers: apiHeaders(config),
    ...(body === undefined ? {} : { body }),
    lane: "sync",
  });
}

function playlistRows(body) {
  return listItems(body).filter((item) => item && (item.Id || item.id));
}

export function capabilities(config = {}) {
  const configured = Boolean(config.baseUrl && token(config) && config.userId);
  const representation = config.watchlistRepresentation || config.representation || "playlist";
  return {
    provider: "jellyfin",
    representation: ["playlist", "favorites"].includes(representation) ? representation : "playlist",
    configured,
    read: configured,
    add: configured,
    remove: configured,
    capability: configured ? "full" : "unavailable",
    reason: configured ? "" : "Connect a Jellyfin user account before syncing watchlists.",
  };
}

export async function listJellyfinPlaylists(config) {
  const body = await jellyfinRequest(config, "/Playlists", { params: { UserId: config.userId, userId: config.userId } });
  return playlistRows(body);
}

export async function ensureRepresentation(config, { create = true } = {}) {
  const representation = config.watchlistRepresentation || config.representation || "playlist";
  if (representation !== "playlist") return { id: "", name: "", representation: "favorites" };
  const playlists = await listJellyfinPlaylists(config);
  const existing = playlists.find((item) => String(item.Name || item.name || "").trim() === JELLYFIN_WATCHLIST_NAME);
  if (existing) return { id: String(existing.Id || existing.id), name: JELLYFIN_WATCHLIST_NAME, representation: "playlist", created: false };
  if (!create) return { id: "", name: JELLYFIN_WATCHLIST_NAME, representation: "playlist", created: false };
  const created = await jellyfinRequest(config, "/Playlists", {
    method: "POST",
    params: { UserId: config.userId },
    body: { Name: JELLYFIN_WATCHLIST_NAME, UserId: config.userId, Ids: [] },
  });
  const id = String(created?.Id || created?.id || created?.PlaylistId || "");
  if (!id) {
    const error = new Error("Jellyfin created a watchlist playlist without returning its id");
    error.code = "WATCHLIST_CONTAINER_INVALID";
    throw error;
  }
  return { id, name: JELLYFIN_WATCHLIST_NAME, representation: "playlist", created: true };
}

function normalizedItems(items, representation, container) {
  return items.map((item) => {
    const normalized = normalizeRemoteMedia(item, { provider: "jellyfin", itemId: item.Id || item.id });
    if (!normalized) return null;
    return {
      ...normalized,
      managed: representation === "playlist",
      representation,
      container_id: container?.id || "",
      container_name: container?.name || "",
      playlist_entry_id: clean(item.PlaylistItemId || item.PlaylistItemID || item.EntryId || item.entryId, 300),
      provider_item_id: clean(item.Id || item.id, 300),
    };
  }).filter(Boolean);
}

export async function listManagedItems(config, { cursor = null, create = false, pageSize = 100 } = {}) {
  const representation = config.watchlistRepresentation || config.representation || "playlist";
  const startIndex = Number(cursor?.startIndex || 0);
  if (representation === "playlist") {
    const container = await ensureRepresentation(config, { create });
    if (!container.id) return { items: [], nextCursor: null, complete: true, container };
    const body = await jellyfinRequest(config, `/Playlists/${encodeURIComponent(container.id)}/Items`, {
      params: { UserId: config.userId, userId: config.userId, StartIndex: startIndex, Limit: pageSize, Fields: "ProviderIds,ProductionYear,Overview,PremiereDate" },
    });
    const items = listItems(body);
    const page = pageResult(body, items, startIndex, pageSize);
    return { ...page, complete: !page.nextCursor, items: normalizedItems(items, representation, container), container };
  }

  const body = await jellyfinRequest(config, `/Users/${encodeURIComponent(config.userId)}/Items`, {
    params: {
      UserId: config.userId,
      userId: config.userId,
      Recursive: "true",
      IncludeItemTypes: "Movie,Series",
      Filters: "IsFavorite",
      Fields: "ProviderIds,ProductionYear,Overview,PremiereDate",
      StartIndex: startIndex,
      Limit: pageSize,
    },
  });
  const items = listItems(body);
  const page = pageResult(body, items, startIndex, pageSize);
  return { ...page, complete: !page.nextCursor, items: normalizedItems(items, representation, null), container: null };
}

export async function fetchJellyfinWatchlistSnapshot(config, options = {}) {
  const all = [];
  let cursor = options.cursor || null;
  let container = null;
  for (let page = 0; page < 100; page += 1) {
    const result = await listManagedItems(config, { ...options, cursor, create: false });
    container = result.container || container;
    all.push(...result.items);
    if (!result.nextCursor) return { items: all, complete: true, container };
    cursor = result.nextCursor;
  }
  const error = new Error("Jellyfin watchlist pagination exceeded the safety limit");
  error.code = "WATCHLIST_INCOMPLETE_SNAPSHOT";
  throw error;
}

function requestMediaIds(media) {
  const normalized = normalizePersonalWatchlistMedia(media);
  return { tmdb: normalized.tmdb_id, tvdb: normalized.tvdb_id, imdb: normalized.imdb_id };
}

async function searchJellyfin(config, media) {
  const normalized = normalizePersonalWatchlistMedia(media);
  const ids = requestMediaIds(normalized);
  const queries = [];
  for (const [key, value] of Object.entries(ids)) {
    if (value) queries.push({ AnyProviderIdEquals: `${key[0].toUpperCase()}${key.slice(1)}.${value}` });
  }
  if (!queries.length) queries.push({ SearchTerm: normalized.title });
  const results = [];
  for (const query of queries) {
    const body = await jellyfinRequest(config, `/Users/${encodeURIComponent(config.userId)}/Items`, {
      params: { UserId: config.userId, userId: config.userId, Recursive: "true", IncludeItemTypes: normalized.media_type === "movie" ? "Movie" : "Series", Fields: "ProviderIds,ProductionYear,Overview,PremiereDate", Limit: 50, ...query },
    });
    results.push(...listItems(body));
    if (results.length && query.AnyProviderIdEquals) break;
  }
  const requestedIds = requestMediaIds(normalized);
  const matched = results.filter((item) => {
    const remote = normalizeRemoteMedia(item, { provider: "jellyfin", itemId: item.Id || item.id });
    if (!remote || remote.media_type !== normalized.media_type) return false;
    const remoteIds = remote.provider_ids || {};
    const idMatch = Object.entries(requestedIds).some(([key, value]) => value && remoteIds[key] && String(value).toLowerCase() === String(remoteIds[key]).toLowerCase());
    return idMatch || titleAndYearMatch(normalized, remote);
  });
  return [...new Map(matched.map((item) => [String(item.Id || item.id), item])).values()];
}

export async function resolveTargets(config, media) {
  const normalized = normalizePersonalWatchlistMedia(media);
  const raw = await searchJellyfin(config, normalized);
  const targets = sortRemoteTargets(raw.map((item) => {
    const remote = normalizeRemoteMedia(item, { provider: "jellyfin", itemId: item.Id || item.id });
    return { id: String(item.Id || item.id), item, providerIds: remote?.provider_ids || {}, media: remote };
  }).filter((target) => target.media && (providerIdsMatch(requestMediaIds(normalized), target.media) || titleAndYearMatch(normalized, target.media))));
  return {
    targets,
    primaryTarget: targets.length === 1 ? targets[0] : null,
    ambiguous: targets.length > 1,
    unavailable: targets.length === 0,
    reason: targets.length > 1 ? "Multiple Jellyfin items match this watchlist identity." : targets.length ? "" : "Jellyfin has no matching library item yet.",
  };
}

export async function add(config, { target, container = null } = {}) {
  const representation = config.watchlistRepresentation || config.representation || "playlist";
  const id = String(target?.id || target?.provider_item_id || "");
  if (!id) throw new Error("Jellyfin watchlist add needs a library item id");
  if (representation === "favorites") {
    await jellyfinRequest(config, `/Users/${encodeURIComponent(config.userId)}/FavoriteItems/${encodeURIComponent(id)}`, { method: "POST", params: { UserId: config.userId, userId: config.userId } });
    return { id, representation, container: null };
  }
  const resolvedContainer = container?.id ? container : await ensureRepresentation(config, { create: true });
  await jellyfinRequest(config, `/Playlists/${encodeURIComponent(resolvedContainer.id)}/Items`, {
    method: "POST",
    params: { UserId: config.userId, userId: config.userId, Ids: id },
  });
  return { id, representation, container: resolvedContainer };
}

export async function remove(config, { target, container = null } = {}) {
  const representation = config.watchlistRepresentation || config.representation || "playlist";
  const id = String(target?.id || target?.provider_item_id || "");
  if (!id) return { removed: false, reason: "missing_provider_item_id" };
  if (representation === "favorites") {
    await jellyfinRequest(config, `/Users/${encodeURIComponent(config.userId)}/FavoriteItems/${encodeURIComponent(id)}`, { method: "DELETE", params: { UserId: config.userId, userId: config.userId } });
    return { removed: true, id, representation };
  }
  const resolvedContainer = container?.id ? container : await ensureRepresentation(config, { create: false });
  if (!resolvedContainer.id) return { removed: true, id, representation, absent: true };
  const entryId = String(target?.playlist_entry_id || target?.entryId || id);
  await jellyfinRequest(config, `/Playlists/${encodeURIComponent(resolvedContainer.id)}/Items`, {
    method: "DELETE",
    params: { UserId: config.userId, userId: config.userId, EntryIds: entryId },
  });
  return { removed: true, id, representation, container: resolvedContainer };
}

export const jellyfinWatchlistCapabilities = capabilities;
export const listJellyfinWatchlistItems = listManagedItems;
export const resolveJellyfinWatchlistTargets = resolveTargets;
export const addJellyfinWatchlistItem = add;
export const removeJellyfinWatchlistItem = remove;

