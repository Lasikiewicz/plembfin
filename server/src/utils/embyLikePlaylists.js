import { fetchWithTimeout } from "./outbound.js";
import { jellyfinAuthHeaders, jellyfinCredential } from "./jellyfinAuth.js";

// Emby and Jellyfin playlist clients for Plembfin playlist sync. Jellyfin's
// playlist API is Emby-derived and shaped the same way, so one factory serves
// both; they differ in authentication (Emby: X-Emby-Token plus api_key query,
// Jellyfin: the Authorization header only), query-parameter spelling, and
// rename. Every read failure throws with `error.status` set so the sync engine
// can tell a definite not-found (404) apart from a transient failure; only the
// former may ever count as a deletion (plan/archive/custom-playlist-sync/plan.md).

function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function text(value = "") {
  return String(value ?? "").trim();
}

function idList(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).map(text).filter(Boolean))];
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const FLAVORS = {
  emby: {
    label: "Emby",
    credential: (config) => text(config.apiKey),
    headers: (config) => ({ Accept: "application/json", "X-Emby-Token": config.apiKey }),
    sign: (url, config) => url.searchParams.set("api_key", config.apiKey),
    params: { userId: "UserId", name: "Name", mediaType: "MediaType", ids: "Ids", entryIds: "EntryIds" },
  },
  jellyfin: {
    label: "Jellyfin",
    credential: (config) => jellyfinCredential(config),
    headers: (config) => jellyfinAuthHeaders(config),
    sign: () => {},
    params: { userId: "userId", name: "name", mediaType: "mediaType", ids: "ids", entryIds: "entryIds" },
  },
};

export function normalizeEmbyLikePlaylist(item = {}) {
  return {
    id: text(item.Id || item.id),
    title: text(item.Name || item.name),
    itemCount: Number(item.ChildCount ?? item.RecursiveItemCount ?? 0) || 0,
    smart: false,
    raw: item,
  };
}

export function normalizeEmbyLikePlaylistEntry(item = {}) {
  return {
    entryId: text(item.PlaylistItemId ?? item.PlaylistItemID ?? item.playlistItemId ?? item.EntryId ?? item.entryId),
    itemId: text(item.Id || item.id),
    type: text(item.Type || item.type).toLowerCase(),
    title: text(item.Name || item.name),
    raw: item,
  };
}

function createClient(provider) {
  const flavor = FLAVORS[provider];
  const { label, params } = flavor;

  function requireConfig(config = {}) {
    if (!config.baseUrl || !flavor.credential(config) || !config.userId) {
      throw new Error(`Missing ${label} baseUrl, apiKey, or userId`);
    }
  }

  function buildUrl(config, path) {
    const url = new URL(`${trimTrailingSlash(config.baseUrl)}${path}`);
    flavor.sign(url, config);
    return url;
  }

  async function request(config, url, { method = "GET", body, lane = "sync", action = "request" } = {}) {
    const response = await fetchWithTimeout(url, {
      method,
      headers: {
        ...flavor.headers(config),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      lane,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw statusError(`${label} playlist ${action} failed with status ${response.status}`, response.status);
    const raw = await response.text();
    try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
  }

  const mutate = (config, url, method, action, body) => request(config, url, { method, body, lane: "interactive", action });

  async function fetchPlaylists(config) {
    requireConfig(config);
    const url = buildUrl(config, `/Users/${encodeURIComponent(config.userId)}/Items`);
    url.searchParams.set("Recursive", "true");
    url.searchParams.set("IncludeItemTypes", "Playlist");
    url.searchParams.set("Fields", "ChildCount");
    url.searchParams.set("SortBy", "SortName");
    url.searchParams.set("SortOrder", "Ascending");
    const data = await request(config, url, { action: "lookup" });
    return (Array.isArray(data?.Items) ? data.Items : [])
      .filter((item) => text(item?.Type).toLowerCase() === "playlist")
      .map(normalizeEmbyLikePlaylist);
  }

  // Returns null only on a definite 404; any other failure throws.
  async function fetchPlaylist(config, playlistId) {
    requireConfig(config);
    if (!text(playlistId)) return null;
    const url = buildUrl(config, `/Users/${encodeURIComponent(config.userId)}/Items/${encodeURIComponent(text(playlistId))}`);
    try {
      const item = await request(config, url, { action: "read" });
      if (!text(item?.Id || item?.id)) throw statusError(`${label} playlist read returned no item`, 0);
      if (text(item?.Type).toLowerCase() !== "playlist") throw statusError(`${label} item ${playlistId} is not a playlist`, 0);
      return normalizeEmbyLikePlaylist(item);
    } catch (error) {
      if (error?.status === 404) return null;
      throw error;
    }
  }

  // Entries in playlist order. Throws (status 404 included) on failure, never
  // returns an empty list for an unreadable playlist.
  async function fetchPlaylistItems(config, playlistId) {
    requireConfig(config);
    if (!text(playlistId)) throw new Error(`${label} playlist id is required`);
    const pageSize = 500;
    const items = [];
    for (let start = 0; start <= 10_000_000;) {
      const url = buildUrl(config, `/Playlists/${encodeURIComponent(text(playlistId))}/Items`);
      url.searchParams.set(params.userId, config.userId);
      url.searchParams.set("Fields", "ProviderIds");
      url.searchParams.set("StartIndex", String(start));
      url.searchParams.set("Limit", String(pageSize));
      url.searchParams.set("EnableTotalRecordCount", "true");
      const data = await request(config, url, { action: "items lookup" });
      const page = Array.isArray(data?.Items) ? data.Items : [];
      items.push(...page);
      const total = Number(data?.TotalRecordCount || 0);
      if (!page.length || (total > 0 && start + page.length >= total) || (total <= 0 && page.length < pageSize)) break;
      start += page.length;
    }
    return items.map(normalizeEmbyLikePlaylistEntry);
  }

  async function createPlaylist(config, { title, itemIds = [] } = {}) {
    requireConfig(config);
    const name = text(title);
    const ids = idList(itemIds);
    if (!name) throw new Error(`${label} playlist title is required`);
    if (!ids.length) throw new Error(`${label} playlists require an initial library item`);
    const url = buildUrl(config, "/Playlists");
    url.searchParams.set(params.userId, config.userId);
    url.searchParams.set(params.name, name);
    url.searchParams.set(params.mediaType, "Video");
    url.searchParams.set(params.ids, ids.join(","));
    const body = await mutate(config, url, "POST", "create");
    return { id: text(body?.Id || body?.id), body };
  }

  async function addPlaylistItems(config, playlistId, itemIds = []) {
    requireConfig(config);
    const ids = idList(itemIds);
    if (!text(playlistId) || !ids.length) return { status: "not_found", added: 0 };
    const url = buildUrl(config, `/Playlists/${encodeURIComponent(text(playlistId))}/Items`);
    url.searchParams.set(params.userId, config.userId);
    url.searchParams.set(params.ids, ids.join(","));
    const body = await mutate(config, url, "POST", "add");
    return { status: "fulfilled", added: Number(body?.ItemAddedCount ?? ids.length) || 0 };
  }

  async function removePlaylistItems(config, playlistId, entryIds = []) {
    requireConfig(config);
    const ids = idList(entryIds);
    if (!text(playlistId) || !ids.length) return { status: "not_found", removed: 0 };
    const url = buildUrl(config, `/Playlists/${encodeURIComponent(text(playlistId))}/Items`);
    url.searchParams.set(params.userId, config.userId);
    url.searchParams.set(params.entryIds, ids.join(","));
    await mutate(config, url, "DELETE", "remove");
    return { status: "fulfilled", removed: ids.length };
  }

  // Moves one entry (by playlist entry id) to a zero-based index.
  async function movePlaylistItem(config, playlistId, entryId, newIndex) {
    requireConfig(config);
    const index = Number(newIndex);
    if (!text(playlistId) || !text(entryId)) return { status: "not_found" };
    if (!Number.isInteger(index) || index < 0) throw new Error(`${label} playlist move needs a non-negative index`);
    const url = buildUrl(config, `/Playlists/${encodeURIComponent(text(playlistId))}/Items/${encodeURIComponent(text(entryId))}/Move/${index}`);
    await mutate(config, url, "POST", "move");
    return { status: "fulfilled", entryId: text(entryId) };
  }

  // Jellyfin has a dedicated playlist update endpoint. Emby only renames
  // through the generic item update, which takes the whole item back, so the
  // current item is read first and posted with the new name.
  async function renamePlaylist(config, playlistId, title) {
    requireConfig(config);
    const name = text(title);
    if (!text(playlistId)) return { status: "not_found" };
    if (!name) throw new Error(`${label} playlist title is required`);
    if (provider === "jellyfin") {
      await mutate(config, buildUrl(config, `/Playlists/${encodeURIComponent(text(playlistId))}`), "POST", "rename", { Name: name });
      return { status: "fulfilled" };
    }
    const current = await request(config, buildUrl(config, `/Users/${encodeURIComponent(config.userId)}/Items/${encodeURIComponent(text(playlistId))}`), { action: "read" });
    await mutate(config, buildUrl(config, `/Items/${encodeURIComponent(text(playlistId))}`), "POST", "rename", { ...current, Name: name });
    return { status: "fulfilled" };
  }

  // A 404 means the playlist is already gone, which is the requested end state.
  async function deletePlaylist(config, playlistId) {
    requireConfig(config);
    if (!text(playlistId)) return { status: "not_found" };
    try {
      await mutate(config, buildUrl(config, `/Items/${encodeURIComponent(text(playlistId))}`), "DELETE", "delete");
      return { status: "fulfilled" };
    } catch (error) {
      if (error?.status === 404) return { status: "not_found" };
      throw error;
    }
  }

  // One library item with its provider ids, so the pull pass can identify an
  // entry added in the app. Null only on a definite 404; any other failure throws.
  async function fetchLibraryItem(config, itemId) {
    requireConfig(config);
    if (!text(itemId)) return null;
    const url = buildUrl(config, `/Users/${encodeURIComponent(config.userId)}/Items/${encodeURIComponent(text(itemId))}`);
    url.searchParams.set("Fields", "ProviderIds");
    try {
      const item = await request(config, url, { action: "item read" });
      if (!text(item?.Id || item?.id)) throw statusError(`${label} item read returned no item`, 0);
      return item;
    } catch (error) {
      if (error?.status === 404) return null;
      throw error;
    }
  }

  return Object.freeze({
    provider,
    fetchLibraryItem,
    fetchPlaylists,
    fetchPlaylist,
    fetchPlaylistItems,
    createPlaylist,
    addPlaylistItems,
    removePlaylistItems,
    movePlaylistItem,
    renamePlaylist,
    deletePlaylist,
  });
}

export const embyPlaylists = createClient("emby");
export const jellyfinPlaylists = createClient("jellyfin");
