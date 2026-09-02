import { getValidPlexToken } from "./plexTokenManager.js";
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
import { fetchWithTimeout } from "./outbound.js";

const DEFAULT_PLEX_CLIENT_IDENTIFIER = "plembfin-watchlist";

function looksLikeJwt(value) {
  return String(value || "").split(".").length === 3;
}

async function accountToken(config = {}) {
  if (config.accountToken || config.watchlistToken) return String(config.accountToken || config.watchlistToken);
  // A connected Plex account may expose a server token on the resolved media
  // config. Never use that token for Universal Watchlist calls: ask the token
  // manager for the account JWT instead.
  if ((config.connectionId && config.connectionId !== "legacy") || config.authKind === "plex_jwt" || config.authKind === "plex_managed_jwt" || looksLikeJwt(config.token)) {
    return getValidPlexToken();
  }
  return String(config.token || "");
}

function baseUrl(config = {}) {
  // `baseUrl` is the selected Plex Media Server URL. Universal Watchlist is
  // account-scoped, so never silently send account requests to that server.
  // A deployment may provide an explicitly validated private/account base;
  // otherwise use Plex's account service host.
  return trimTrailingSlash(config.watchlistBaseUrl || "https://discover.provider.plex.tv");
}

function urlFor(config, pathname, params = {}) {
  const url = new URL(`${baseUrl(config)}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

async function plexHeaders(config) {
  const token = await accountToken(config);
  if (!token) {
    const error = new Error("Plex watchlist needs an account token");
    error.code = "WATCHLIST_NOT_CONFIGURED";
    error.status = 424;
    throw error;
  }
  return {
    Accept: "application/json",
    "X-Plex-Token": token,
    "X-Plex-Client-Identifier": String(config.clientIdentifier || DEFAULT_PLEX_CLIENT_IDENTIFIER),
  };
}

async function plexRequest(config, pathname, { method = "GET", params = {}, body } = {}) {
  const headers = await plexHeaders(config);
  return requestJson(urlFor(config, pathname, params), {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    lane: "sync",
  });
}

function parseGuid(value) {
  const text = String(value || "");
  const match = text.match(/(?:^|[|,\s])((?:imdb|tmdb|tvdb)):\/\/([^|,\s]+)/i);
  if (!match) return null;
  return { provider: match[1].toLowerCase(), value: clean(match[2], 100) };
}

function plexProviderIds(item = {}) {
  const ids = {
    tmdb: clean(item.tmdb_id || item.tmdb || "", 100),
    tvdb: clean(item.tvdb_id || item.tvdb || "", 100),
    imdb: clean(item.imdb_id || item.imdb || "", 100),
  };
  const raw = Array.isArray(item.Guid) ? item.Guid : Array.isArray(item.guid) ? item.guid : typeof item.guid === "string" ? item.guid.split(/[|,\s]+/) : [];
  for (const entry of raw) {
    const parsed = parseGuid(typeof entry === "object" ? entry.id || entry.guid : entry);
    if (parsed && parsed.provider in ids && !ids[parsed.provider]) ids[parsed.provider] = parsed.value;
  }
  const guid = parseGuid(item.guid || item.Guid);
  if (guid && guid.provider in ids && !ids[guid.provider]) ids[guid.provider] = guid.value;
  return ids;
}

function normalizePlexItem(item, itemId = "") {
  const ids = plexProviderIds(item);
  const normalized = normalizeRemoteMedia({
    ...item,
    type: String(item.type || item.Type || "").toLowerCase() === "show" ? "series" : item.type || item.Type,
    Name: item.title || item.title_sort || item.grandparentTitle || item.Name,
    ProviderIds: ids,
    ProductionYear: item.year || item.ProductionYear,
    PremiereDate: item.originallyAvailableAt || item.PremiereDate,
  }, { provider: "plex", itemId: itemId || item.ratingKey || item.rating_key || item.key });
  if (!normalized) return null;
  return {
    ...normalized,
    provider_ids: ids,
    provider_item_id: clean(itemId || item.ratingKey || item.rating_key || item.key, 300),
    rating_key: clean(item.ratingKey || item.rating_key || item.key, 300),
    managed: true,
    remote_item: item,
  };
}

export function capabilities(config = {}) {
  const configured = Boolean(config.accountToken || config.watchlistToken || config.token || config.connectionId || config.authMode === "account");
  const representation = config.watchlistRepresentation || config.representation || "native";
  const writeEnabled = Boolean(config.watchlistWriteEnabled || config.writeEnabled);
  const read = configured && representation !== "rss" ? true : Boolean(config.watchlistRssUrl || config.rssUrl);
  return {
    provider: "plex",
    representation: ["native", "rss"].includes(representation) ? representation : "native",
    configured,
    read,
    add: read && representation === "native" && writeEnabled,
    remove: read && representation === "native" && writeEnabled,
    capability: !configured ? "unavailable" : representation === "rss" ? "read_only" : writeEnabled ? "full" : "read_only",
    reason: !configured ? "Connect a Plex account before syncing watchlists." : representation === "rss" ? "Plex RSS is read-only." : writeEnabled ? "" : "Enable verified Plex account-level watchlist writes before publishing.",
  };
}

function plexItemsFromBody(body) {
  if (Array.isArray(body?.MediaContainer?.Metadata)) return body.MediaContainer.Metadata;
  if (Array.isArray(body?.Metadata)) return body.Metadata;
  if (Array.isArray(body?.MediaContainer?.Hub)) return body.MediaContainer.Hub.flatMap((hub) => hub.Metadata || []);
  return listItems(body);
}

export async function listManagedItems(config, { cursor = null, pageSize = 100 } = {}) {
  const representation = config.watchlistRepresentation || config.representation || "native";
  if (representation === "rss") return fetchPlexWatchlistRss(config);
  const startIndex = Number(cursor?.startIndex || 0);
  const body = await plexRequest(config, config.watchlistListPath || "/library/metadata", {
    params: {
      type: "1,4",
      includeGuids: 1,
      "X-Plex-Container-Start": startIndex,
      "X-Plex-Container-Size": pageSize,
      ...(config.watchlistListParams || {}),
    },
  });
  const rawItems = plexItemsFromBody(body);
  const normalized = rawItems.map((item) => normalizePlexItem(item)).filter(Boolean);
  const page = pageResult(body?.MediaContainer || body, rawItems, startIndex, pageSize);
  return { ...page, complete: !page.nextCursor, items: normalized, container: null };
}

export async function fetchPlexWatchlistSnapshot(config, options = {}) {
  if ((config.watchlistRepresentation || config.representation || "native") === "rss") return fetchPlexWatchlistRss(config);
  const all = [];
  let cursor = options.cursor || null;
  for (let page = 0; page < 100; page += 1) {
    const result = await listManagedItems(config, { ...options, cursor });
    all.push(...result.items);
    if (!result.nextCursor) return { items: all, complete: true, container: null };
    cursor = result.nextCursor;
  }
  const error = new Error("Plex watchlist pagination exceeded the safety limit");
  error.code = "WATCHLIST_INCOMPLETE_SNAPSHOT";
  throw error;
}

function xmlEntity(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parsePlexRss(text) {
  const items = [];
  for (const match of String(text || "").matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const read = (name) => xmlEntity(block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] || "");
    const title = read("title");
    const guid = read("guid");
    if (title || guid) items.push(normalizePlexItem({ type: /show|series|tv/i.test(read("mediaType")) ? "show" : "movie", title, guid }, guid));
  }
  return { items: items.filter(Boolean), nextCursor: null, complete: true, container: null, rss: true };
}

export async function fetchPlexWatchlistRss(config) {
  const rssUrl = config.watchlistRssUrl || config.rssUrl;
  if (!rssUrl) {
    const error = new Error("Plex RSS watchlist URL is not configured");
    error.code = "WATCHLIST_RSS_NOT_CONFIGURED";
    error.status = 424;
    throw error;
  }
  const headers = await plexHeaders(config);
  const response = await fetchWithTimeout(rssUrl, { headers, lane: "sync" });
  if (!response.ok) {
    const error = new Error(`Plex RSS watchlist failed with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return parsePlexRss(await response.text());
}

async function searchPlex(config, media) {
  const normalized = normalizePersonalWatchlistMedia(media);
  const body = await plexRequest(config, config.watchlistSearchPath || "/hubs/search", {
    params: { query: normalized.title, type: normalized.media_type === "movie" ? 1 : 4, includeGuids: 1, ...(config.watchlistSearchParams || {}) },
  });
  return plexItemsFromBody(body);
}

function requestedIds(media) {
  const normalized = normalizePersonalWatchlistMedia(media);
  return { tmdb: normalized.tmdb_id, tvdb: normalized.tvdb_id, imdb: normalized.imdb_id };
}

export async function resolveTargets(config, media) {
  const normalized = normalizePersonalWatchlistMedia(media);
  const candidates = [];
  try {
    candidates.push(...(await searchPlex(config, normalized)));
  } catch (error) {
    if (![404, 405].includes(Number(error.status))) throw error;
  }
  if (!candidates.length) {
    const snapshot = await fetchPlexWatchlistSnapshot(config);
    candidates.push(...snapshot.items.map((item) => item.remote_item || item));
  }
  const ids = requestedIds(normalized);
  const targets = sortRemoteTargets([...new Map(candidates.map((item) => [String(item.ratingKey || item.rating_key || item.key || item.guid || item.title), item])).values()]
    .map((item) => {
      const remote = normalizePlexItem(item);
      return remote ? { id: remote.provider_item_id, item, providerIds: remote.provider_ids, media: remote } : null;
    })
    .filter((target) => target && target.media.media_type === normalized.media_type && (providerIdsMatch(ids, target.media) || titleAndYearMatch(normalized, target.media))));
  return {
    targets,
    primaryTarget: targets.length === 1 ? targets[0] : null,
    ambiguous: targets.length > 1,
    unavailable: targets.length === 0,
    reason: targets.length > 1 ? "Multiple Plex items match this watchlist identity." : targets.length ? "" : "Plex has no matching item yet.",
  };
}

function pathWithId(template, id) {
  return String(template).replace(/\{id\}/g, encodeURIComponent(id));
}

export async function add(config, { target } = {}) {
  const representation = config.watchlistRepresentation || config.representation || "native";
  if (representation !== "native") throw Object.assign(new Error("Plex RSS watchlists are read-only"), { code: "WATCHLIST_READ_ONLY", status: 405 });
  const id = String(target?.id || target?.provider_item_id || "");
  if (!id) throw new Error("Plex watchlist add needs an item id");
  await plexRequest(config, pathWithId(config.watchlistAddPath || "/library/metadata/{id}/watchlist", id), {
    method: config.watchlistAddMethod || "PUT",
    params: config.watchlistWriteParams || {},
  });
  return { id, representation };
}

export async function remove(config, { target } = {}) {
  const representation = config.watchlistRepresentation || config.representation || "native";
  if (representation !== "native") throw Object.assign(new Error("Plex RSS watchlists are read-only"), { code: "WATCHLIST_READ_ONLY", status: 405 });
  const id = String(target?.id || target?.provider_item_id || "");
  if (!id) return { removed: false, reason: "missing_provider_item_id" };
  await plexRequest(config, pathWithId(config.watchlistRemovePath || "/library/metadata/{id}/watchlist", id), {
    method: config.watchlistRemoveMethod || "DELETE",
    params: config.watchlistWriteParams || {},
  });
  return { removed: true, id, representation };
}

export const plexWatchlistCapabilities = capabilities;
export const listPlexWatchlistItems = listManagedItems;
export const resolvePlexWatchlistTargets = resolveTargets;
export const addPlexWatchlistItem = add;
export const removePlexWatchlistItem = remove;
