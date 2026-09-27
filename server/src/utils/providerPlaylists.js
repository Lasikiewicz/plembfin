import {
  addPlexPlaylistItems,
  createPlexPlaylist,
  deletePlexPlaylist,
  fetchPlexPlaylist,
  fetchPlexPlaylistItems,
  fetchPlexPlaylists,
  movePlexPlaylistItem,
  removePlexPlaylistItem,
  renamePlexPlaylist,
} from "./plexPlaylists.js";
import { embyPlaylists, jellyfinPlaylists } from "./embyLikePlaylists.js";
import { fetchPlexMetadataItem } from "./plexClient.js";

// One interface over the Plex, Emby, and Jellyfin playlist clients for the
// Plembfin playlist sync engine (plan/archive/custom-playlist-sync/plan.md). Playlists are
// { id, title, itemCount, smart, raw }; entries are { entryId, itemId, type,
// title, raw } in playlist order, where itemId is the provider library id and
// entryId is the per-playlist entry id used by remove and move.
// fetchLibraryItem returns the provider's raw item with its provider ids, or
// null on a definite not-found.

const plexPlaylists = Object.freeze({
  provider: "plex",
  fetchLibraryItem: (config, ratingKey) => fetchPlexMetadataItem(config, ratingKey),
  fetchPlaylists: fetchPlexPlaylists,
  fetchPlaylist: fetchPlexPlaylist,
  fetchPlaylistItems: fetchPlexPlaylistItems,
  createPlaylist: (config, { title, itemIds = [] } = {}) => createPlexPlaylist(config, { title, ratingKey: [itemIds].flat()[0] }),
  addPlaylistItems: addPlexPlaylistItems,
  async removePlaylistItems(config, playlistId, entryIds = []) {
    const ids = [...new Set([entryIds].flat().map((id) => String(id ?? "").trim()).filter(Boolean))];
    for (const entryId of ids) await removePlexPlaylistItem(config, playlistId, entryId);
    return { status: ids.length ? "fulfilled" : "not_found", removed: ids.length };
  },
  movePlaylistItem: movePlexPlaylistItem,
  renamePlaylist: renamePlexPlaylist,
  deletePlaylist: deletePlexPlaylist,
});

const CLIENTS = Object.freeze({
  plex: plexPlaylists,
  emby: embyPlaylists,
  jellyfin: jellyfinPlaylists,
});

export const PLAYLIST_PROVIDERS = Object.freeze(Object.keys(CLIENTS));

export function providerPlaylistClient(provider) {
  const client = CLIENTS[String(provider || "").toLowerCase()];
  if (!client) throw new Error(`Unsupported playlist provider: ${provider}`);
  return client;
}

// Only a definite 404 is a not-found. Timeouts, auth failures, and 5xx are
// transient and must never be read as a deletion.
export function isPlaylistNotFound(error) {
  return Number(error?.status) === 404;
}

// Indexes (into `values`) of one longest strictly increasing subsequence.
function longestIncreasingRun(values) {
  const tails = [];
  const previous = new Array(values.length).fill(-1);
  for (let index = 0; index < values.length; index += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[tails[middle]] < values[index]) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  }
  const run = new Set();
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]) run.add(index);
  return run;
}

// Moves entries so the playlist matches `desiredEntryIds` (a subset of the
// current entries, in the wanted order). Entries not listed keep their
// relative order after the ordered ones; callers remove unwanted entries
// first. Entries already in the right relative order stay put, so one entry
// moved in the app costs one move; returns the move count and the order the
// moves should produce. `rebuild` instead moves every entry, in order, to the
// end: the real Plex answered some moves between two entries with success yet
// left the entry in place, while a move after the last entry landed.
// `provider` is a provider name or a client object (the engine's tests pass one).
export async function reorderProviderPlaylist(provider, config, playlistId, currentEntryIds = [], desiredEntryIds = [], { rebuild = false } = {}) {
  const client = typeof provider === "object" && provider ? provider : providerPlaylistClient(provider);
  const current = currentEntryIds.map((id) => String(id ?? "").trim()).filter(Boolean);
  const present = new Set(current);
  const desired = [...new Set(desiredEntryIds.map((id) => String(id ?? "").trim()))].filter((id) => present.has(id));
  const wanted = new Set(desired);
  const order = [...desired, ...current.filter((id) => !wanted.has(id))];
  const plex = client.provider === "plex";
  const move = async (entryId, afterId) => {
    current.splice(current.indexOf(entryId), 1);
    const index = afterId ? current.indexOf(afterId) + 1 : 0;
    current.splice(index, 0, entryId);
    await client.movePlaylistItem(config, playlistId, entryId, plex ? afterId : index);
  };

  let moves = 0;
  if (rebuild) {
    for (const entryId of order) {
      const last = current.at(-1);
      if (last === entryId) continue;
      await move(entryId, last);
      moves += 1;
    }
    return { moves, order: current };
  }

  const positions = new Map(current.map((id, index) => [id, index]));
  const staying = longestIncreasingRun(order.map((id) => positions.get(id)));
  for (let index = 0; index < order.length; index += 1) {
    if (staying.has(index)) continue;
    await move(order[index], index > 0 ? order[index - 1] : "");
    moves += 1;
  }
  return { moves, order: current };
}
