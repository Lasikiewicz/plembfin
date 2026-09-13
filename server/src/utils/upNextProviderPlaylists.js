import {
  addPlexPlaylistItem,
  createPlexPlaylist,
  fetchPlexPlaylistItems,
  fetchPlexPlaylists,
  removePlexPlaylistItem,
} from "./plexClient.js";
import {
  addEmbyPlaylistItems,
  createEmbyPlaylist,
  fetchEmbyPlaylistItems,
  fetchEmbyPlaylists,
  removeEmbyPlaylistItems,
} from "./embyClient.js";
import {
  addJellyfinPlaylistItems,
  createJellyfinPlaylist,
  fetchJellyfinPlaylistItems,
  fetchJellyfinPlaylists,
  removeJellyfinPlaylistItems,
} from "./jellyfinClient.js";
import { resolveUpNextProviderTargets } from "./upNextLibraryLookup.js";

export const PLEMBFIN_UP_NEXT_PLAYLIST_NAME = "Plembfin Up Next";
const MAX_PLAYLIST_ITEMS = 100;

function text(value = "") {
  return String(value ?? "").trim();
}

// Resolution now happens once per push in upNextProviderSync and arrives as
// `targets`. Falling back to a fresh pass keeps the module usable on its own.
async function resolveDesiredItems(provider, config, desiredItems, targets = null) {
  if (targets) return { resolved: targets.resolved || [], unresolved: targets.unresolved || [] };
  const { resolved, unresolved } = await resolveUpNextProviderTargets({
    provider,
    config,
    items: desiredItems,
    limit: MAX_PLAYLIST_ITEMS,
  });
  return { resolved, unresolved };
}

function playlistTitle(item = {}) {
  return text(item.title || item.Name || item.name || "");
}

function findNamedPlaylist(items, title) {
  const wanted = text(title).toLowerCase();
  return (Array.isArray(items) ? items : []).find((item) => playlistTitle(item).toLowerCase() === wanted) || null;
}

function plexPlaylistId(item) {
  return text(item?.ratingKey || item?.key || item?.id);
}

function plexPlaylistItemId(item) {
  return text(item?.playlistItemID || item?.playlistItemId || item?.PlaylistItemID || item?.PlaylistItemId || item?.id);
}

function plexMediaItemId(item) {
  return text(item?.ratingKey || item?.key || item?.id);
}

function embyPlaylistId(item) {
  return text(item?.Id || item?.id);
}

function embyPlaylistItemId(item) {
  return text(item?.PlaylistItemId || item?.PlaylistItemID || item?.playlistItemId || item?.EntryId || item?.entryId);
}

function embyMediaItemId(item) {
  return text(item?.Id || item?.id);
}

function playlistSummary(provider, playlistId, resolved, unresolved, currentItems, { added = 0, removed = 0, status = "succeeded", error = "" } = {}) {
  const desiredIds = new Set(resolved.map((entry) => entry.providerItemId));
  const finalIds = new Set((currentItems || []).map((item) => provider === "plex" ? plexMediaItemId(item) : embyMediaItemId(item)).filter(Boolean));
  const missing = resolved.filter((entry) => !finalIds.has(entry.providerItemId));
  return {
    provider,
    name: PLEMBFIN_UP_NEXT_PLAYLIST_NAME,
    playlist_id: text(playlistId),
    status,
    desired_count: desiredIds.size + unresolved.length,
    resolved_count: resolved.length,
    added_count: added,
    removed_count: removed,
    final_count: finalIds.size,
    missing_count: missing.length + unresolved.length,
    missing: [
      ...unresolved,
      ...missing.map((entry) => ({ title: text(entry.item?.title || "Untitled"), reason: "The provider did not confirm the item in the playlist." })),
    ],
    error: text(error),
  };
}

async function syncPlexPlaylist(config, desiredItems, targets = null) {
  const { resolved, unresolved } = await resolveDesiredItems("plex", config, desiredItems, targets);
  const playlists = await fetchPlexPlaylists(config);
  let playlist = findNamedPlaylist(playlists, PLEMBFIN_UP_NEXT_PLAYLIST_NAME);
  let playlistId = plexPlaylistId(playlist);

  if (!playlistId && !resolved.length) {
    return playlistSummary("plex", "", resolved, unresolved, [], { status: unresolved.length ? "partial" : "succeeded" });
  }
  if (!playlistId) {
    const created = await createPlexPlaylist(config, {
      title: PLEMBFIN_UP_NEXT_PLAYLIST_NAME,
      ratingKey: resolved[0].providerItemId,
    });
    playlistId = text(created.id);
    if (!playlistId) {
      playlist = findNamedPlaylist(await fetchPlexPlaylists(config), PLEMBFIN_UP_NEXT_PLAYLIST_NAME);
      playlistId = plexPlaylistId(playlist);
    }
    if (!playlistId) throw new Error("Plex created the Up Next playlist but did not return its id.");
  }

  let current = await fetchPlexPlaylistItems(config, playlistId);
  const desiredIds = new Set(resolved.map((entry) => entry.providerItemId));
  const retained = new Set();
  const stale = [];
  for (const item of current) {
    const mediaId = plexMediaItemId(item);
    const entryId = plexPlaylistItemId(item);
    if (desiredIds.has(mediaId) && !retained.has(mediaId)) retained.add(mediaId);
    else if (entryId) stale.push(entryId);
  }

  let removed = 0;
  // Never remove an existing managed entry when one of the desired items could
  // not be resolved. That preserves a usable list while the missing library
  // match is repaired, and avoids turning a partial lookup into a wipe.
  if (!unresolved.length) {
    for (const entryId of stale) {
      await removePlexPlaylistItem(config, playlistId, entryId);
      removed += 1;
    }
  }

  const missingIds = resolved.map((entry) => entry.providerItemId).filter((id) => !retained.has(id));
  let added = 0;
  for (const ratingKey of missingIds) {
    await addPlexPlaylistItem(config, playlistId, ratingKey);
    added += 1;
  }

  current = await fetchPlexPlaylistItems(config, playlistId);
  const summary = playlistSummary("plex", playlistId, resolved, unresolved, current, { added, removed });
  if (summary.missing_count) summary.status = "partial";
  return summary;
}

// Emby and Jellyfin expose the same playlist API shape, so one reconciliation
// serves both. Only the client functions differ.
const EMBY_LIKE_CLIENTS = {
  emby: {
    fetchPlaylists: fetchEmbyPlaylists,
    fetchItems: fetchEmbyPlaylistItems,
    create: createEmbyPlaylist,
    add: addEmbyPlaylistItems,
    remove: removeEmbyPlaylistItems,
  },
  jellyfin: {
    fetchPlaylists: fetchJellyfinPlaylists,
    fetchItems: fetchJellyfinPlaylistItems,
    create: createJellyfinPlaylist,
    add: addJellyfinPlaylistItems,
    remove: removeJellyfinPlaylistItems,
  },
};

async function syncEmbyLikePlaylist(provider, config, desiredItems, targets = null) {
  const client = EMBY_LIKE_CLIENTS[provider];
  const label = provider === "jellyfin" ? "Jellyfin" : "Emby";
  const { resolved, unresolved } = await resolveDesiredItems(provider, config, desiredItems, targets);
  const playlists = await client.fetchPlaylists(config);
  let playlist = findNamedPlaylist(playlists, PLEMBFIN_UP_NEXT_PLAYLIST_NAME);
  let playlistId = embyPlaylistId(playlist);

  if (!playlistId && !resolved.length) {
    return playlistSummary(provider, "", resolved, unresolved, [], { status: unresolved.length ? "partial" : "succeeded" });
  }
  if (!playlistId) {
    const created = await client.create(config, {
      title: PLEMBFIN_UP_NEXT_PLAYLIST_NAME,
      itemIds: [resolved[0].providerItemId],
    });
    playlistId = text(created.id);
    if (!playlistId) {
      playlist = findNamedPlaylist(await client.fetchPlaylists(config), PLEMBFIN_UP_NEXT_PLAYLIST_NAME);
      playlistId = embyPlaylistId(playlist);
    }
    if (!playlistId) throw new Error(`${label} created the Up Next playlist but did not return its id.`);
  }

  let current = await client.fetchItems(config, playlistId);
  const desiredIds = new Set(resolved.map((entry) => entry.providerItemId));
  const retained = new Set();
  const stale = [];
  for (const item of current) {
    const mediaId = embyMediaItemId(item);
    const entryId = embyPlaylistItemId(item);
    if (desiredIds.has(mediaId) && !retained.has(mediaId)) retained.add(mediaId);
    else if (entryId) stale.push(entryId);
  }

  let removed = 0;
  if (!unresolved.length && stale.length) {
    await client.remove(config, playlistId, stale);
    removed = stale.length;
  }

  const missingIds = resolved.map((entry) => entry.providerItemId).filter((id) => !retained.has(id));
  let added = 0;
  if (missingIds.length) {
    await client.add(config, playlistId, missingIds);
    current = await client.fetchItems(config, playlistId);
    // The comma-delimited request is normally accepted whole, but some
    // compatible servers silently take only part of a large batch. Retry each
    // item the provider did not confirm, then verify final membership below.
    const stillMissing = missingIds.filter((id) => !new Set(current.map(embyMediaItemId).filter(Boolean)).has(id));
    for (const itemId of stillMissing) {
      await client.add(config, playlistId, [itemId]);
    }
    if (stillMissing.length) current = await client.fetchItems(config, playlistId);
    const finalIds = new Set(current.map(embyMediaItemId).filter(Boolean));
    added = missingIds.filter((id) => finalIds.has(id)).length;
  }

  if (!missingIds.length) current = await client.fetchItems(config, playlistId);
  const summary = playlistSummary(provider, playlistId, resolved, unresolved, current, { added, removed });
  if (summary.missing_count) summary.status = "partial";
  return summary;
}

export async function syncUpNextProviderPlaylists({ desiredItems = [], config = {}, targetsByProvider = {} } = {}) {
  const results = [];
  const syncs = [
    ["plex", (providerConfig, items, targets) => syncPlexPlaylist(providerConfig, items, targets)],
    ["emby", (providerConfig, items, targets) => syncEmbyLikePlaylist("emby", providerConfig, items, targets)],
    ["jellyfin", (providerConfig, items, targets) => syncEmbyLikePlaylist("jellyfin", providerConfig, items, targets)],
  ];
  for (const [provider, sync] of syncs) {
    const providerConfig = config?.[provider] || {};
    const configured = provider === "plex"
      ? Boolean(providerConfig.baseUrl && providerConfig.token)
      : Boolean(providerConfig.baseUrl && (providerConfig.apiKey || providerConfig.api_key || providerConfig.token) && providerConfig.userId);
    if (!configured || providerConfig.disabled) {
      results.push({ provider, name: PLEMBFIN_UP_NEXT_PLAYLIST_NAME, status: providerConfig.disabled ? "disabled" : "not_configured", desired_count: Math.min(Array.isArray(desiredItems) ? desiredItems.length : 0, MAX_PLAYLIST_ITEMS), resolved_count: 0, added_count: 0, removed_count: 0, final_count: 0, missing_count: 0, missing: [], error: "" });
      continue;
    }
    try {
      results.push(await sync(providerConfig, desiredItems, targetsByProvider[provider] || null));
    } catch (error) {
      results.push({ provider, name: PLEMBFIN_UP_NEXT_PLAYLIST_NAME, status: "failed", desired_count: Math.min(Array.isArray(desiredItems) ? desiredItems.length : 0, MAX_PLAYLIST_ITEMS), resolved_count: 0, added_count: 0, removed_count: 0, final_count: 0, missing_count: 0, missing: [], error: text(error?.message || error) || "Provider playlist sync failed" });
    }
  }
  return results;
}
