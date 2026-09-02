import { fetchWithTimeout } from "./outbound.js";
import { personalWatchlistMediaKey } from "./personalWatchlistIdentity.js";

export function trimTrailingSlash(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function clean(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function providerIdsFromRemote(item = {}) {
  const raw = item.ProviderIds || item.providerIds || item.provider_ids || item.ids || {};
  const read = (key) => raw[key] ?? raw[key[0].toUpperCase() + key.slice(1)] ?? item[`${key}Id`] ?? item[`${key}_id`];
  return {
    tmdb: clean(read("tmdb"), 100),
    tvdb: clean(read("tvdb"), 100),
    imdb: clean(read("imdb"), 100),
  };
}

export function normalizeTitle(value) {
  return clean(value, 300)
    .toLowerCase()
    .replace(/\(\d{4}\)/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

export function yearFrom(value) {
  const match = String(value || "").match(/(?:^|[^\d])(\d{4})(?:[^\d]|$)/);
  return match ? Number(match[1]) : 0;
}

export function titleAndYearMatch(requested = {}, remote = {}) {
  const requestedTitle = normalizeTitle(requested.title || requested.name);
  const remoteTitle = normalizeTitle(remote.title || remote.name || remote.Name || remote.title_name);
  if (requestedTitle && remoteTitle && requestedTitle !== remoteTitle) return false;
  const requestedYear = Number(requested.year || yearFrom(requested.release_date));
  const remoteYear = Number(remote.year || remote.ProductionYear || remote.productionYear || yearFrom(remote.release_date));
  return !requestedYear || !remoteYear || requestedYear === remoteYear;
}

export function providerIdsMatch(requested = {}, remote = {}) {
  const ids = providerIdsFromRemote(remote);
  return ["tmdb", "tvdb", "imdb"].some((key) => requested[key] && ids[key] && String(requested[key]).toLowerCase() === String(ids[key]).toLowerCase());
}

export function normalizeRemoteMedia(item = {}, { provider = "", itemId = "" } = {}) {
  const typeValue = String(item.Type || item.type || item.media_type || item.MediaType || "").toLowerCase();
  const mediaType = ["series", "show", "tv"].includes(typeValue) ? "tv" : typeValue === "movie" ? "movie" : "";
  if (!mediaType) return null;
  const ids = providerIdsFromRemote(item);
  const title = clean(item.Name || item.title || item.Title || item.name, 300);
  const releaseDate = clean(item.PremiereDate || item.ReleaseDate || item.release_date || "", 40);
  const normalized = {
    type: mediaType,
    media_type: mediaType,
    title,
    tmdb_id: ids.tmdb,
    tvdb_id: ids.tvdb,
    imdb_id: ids.imdb,
    poster_url: clean(item.ImageUrl || item.PosterUrl || item.poster_url || "", 2000),
    overview: clean(item.Overview || item.overview || "", 4000),
    release_date: releaseDate,
    year: Number(item.ProductionYear || item.productionYear || yearFrom(releaseDate)) || undefined,
    provider_item_ids: {
      ...(provider ? { [provider]: clean(itemId || item.Id || item.id || item.ratingKey || item.rating_key, 300) } : {}),
    },
    provider_item_id: clean(itemId || item.Id || item.id || item.ratingKey || item.rating_key, 300),
    provider_ids: ids,
    remote_item: item,
    playlist_entry_id: clean(item.PlaylistItemId || item.PlaylistItemID || item.EntryId || item.entryId || "", 300),
  };
  return { ...normalized, media_key: personalWatchlistMediaKey(normalized) };
}

export async function requestJson(url, {
  method = "GET",
  headers = {},
  body = undefined,
  lane = "sync",
  timeoutMs = undefined,
} = {}) {
  const response = await fetchWithTimeout(url, {
    method,
    headers: { Accept: "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    lane,
  }, timeoutMs);
  let parsed = null;
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (response.status !== 204 && (contentType.includes("json") || method === "GET")) {
    try { parsed = await response.json(); } catch { parsed = null; }
  } else if (response.status !== 204) {
    try { parsed = await response.text(); } catch { parsed = null; }
  }
  if (!response.ok) {
    const error = new Error(`${method} ${new URL(url).pathname} failed with HTTP ${response.status}`);
    error.status = response.status;
    error.retryAfter = response.headers.get("retry-after") || "";
    error.body = typeof parsed === "string" ? parsed.slice(0, 300) : undefined;
    throw error;
  }
  return parsed;
}

export function listItems(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.Items)) return body.Items;
  if (Array.isArray(body?.items)) return body.items;
  if (Array.isArray(body?.MediaContainer?.Metadata)) return body.MediaContainer.Metadata;
  if (Array.isArray(body?.MediaContainer?.Device)) return body.MediaContainer.Device;
  if (Array.isArray(body?.Metadata)) return body.Metadata;
  return [];
}

export function pageResult(body, items, startIndex = 0, pageSize = items.length) {
  const total = Number(body?.TotalRecordCount ?? body?.totalRecordCount ?? body?.MediaContainer?.totalSize);
  const next = Number.isFinite(total) && total > startIndex + items.length
    ? { startIndex: startIndex + items.length }
    : items.length >= pageSize && items.length > 0 && !Number.isFinite(total)
      ? { startIndex: startIndex + items.length }
      : null;
  return { items, nextCursor: next, total: Number.isFinite(total) ? total : null };
}

export function sortRemoteTargets(targets = []) {
  return [...targets].sort((left, right) => String(left.id || left.provider_item_id || "").localeCompare(String(right.id || right.provider_item_id || "")));
}
