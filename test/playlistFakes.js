// In-memory provider playlists shared by the playlist push and pull engine
// tests. Emby-like moves take an index; Plex moves take the entry to place after.

export function statusError(status) {
  return Object.assign(new Error(`status ${status}`), { status });
}

export function fakeProvider(provider) {
  const state = { playlists: new Map(), nextEntry: 1, nextPlaylist: 1, calls: [], rejectIds: new Set(), dropIds: new Set() };
  const playlist = (id) => state.playlists.get(id);
  const append = (entries, itemId) => {
    if (state.dropIds.has(itemId)) return;
    entries.push({ entryId: `${provider}-e${state.nextEntry++}`, itemId });
  };
  const client = {
    provider,
    async fetchPlaylist(_config, id) {
      state.calls.push(["fetchPlaylist", id]);
      return playlist(id) ? { id, title: playlist(id).title } : null;
    },
    async fetchPlaylistItems(_config, id) {
      state.calls.push(["fetchPlaylistItems", id]);
      if (!playlist(id)) throw statusError(404);
      return playlist(id).entries.map((entry) => ({ ...entry }));
    },
    async createPlaylist(_config, { title, itemIds }) {
      state.calls.push(["createPlaylist", title, itemIds]);
      const id = `${provider}-p${state.nextPlaylist++}`;
      state.playlists.set(id, { title, entries: [] });
      for (const itemId of itemIds) append(playlist(id).entries, itemId);
      return { id, title };
    },
    async addPlaylistItems(_config, id, itemIds) {
      state.calls.push(["addPlaylistItems", id, [...itemIds]]);
      if (itemIds.some((itemId) => state.rejectIds.has(itemId))) throw statusError(400);
      for (const itemId of itemIds) append(playlist(id).entries, itemId);
      return { status: "fulfilled" };
    },
    async removePlaylistItems(_config, id, entryIds) {
      state.calls.push(["removePlaylistItems", id, [...entryIds]]);
      playlist(id).entries = playlist(id).entries.filter((entry) => !entryIds.includes(entry.entryId));
      return { status: "fulfilled" };
    },
    async movePlaylistItem(_config, id, entryId, target) {
      state.calls.push(["movePlaylistItem", id, entryId, target]);
      const entries = playlist(id).entries;
      // The real Plex answered a move between two entries with success yet left
      // the entry in place; a move to the top or after the last entry landed.
      const last = entries.filter((candidate) => candidate.entryId !== entryId).at(-1)?.entryId;
      if (state.ignoreInnerMoves && provider === "plex" && target && target !== last) return { status: "fulfilled" };
      const entry = entries.splice(entries.findIndex((candidate) => candidate.entryId === entryId), 1)[0];
      const index = provider === "plex" ? (target ? entries.findIndex((candidate) => candidate.entryId === target) + 1 : 0) : target;
      entries.splice(index, 0, entry);
      return { status: "fulfilled" };
    },
    async renamePlaylist(_config, id, title) {
      state.calls.push(["renamePlaylist", id, title]);
      playlist(id).title = title;
      return { status: "fulfilled" };
    },
    async deletePlaylist(_config, id) {
      state.calls.push(["deletePlaylist", id]);
      if (!playlist(id)) return { status: "not_found" };
      state.playlists.delete(id);
      return { status: "fulfilled" };
    },
  };
  return {
    client,
    state,
    items: (id) => playlist(id).entries.map((entry) => entry.itemId),
    // Simulates a user adding an item in the app.
    appAdd: (id, itemId) => append(playlist(id).entries, itemId),
    // Emby renumbers entry ids after some edits: the same ids come back handed
    // out in playlist order, so an id can now hold another item.
    renumber: (id) => {
      const entries = playlist(id).entries;
      const ids = entries.map((entry) => entry.entryId).sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
      entries.forEach((entry, index) => { entry.entryId = ids[index]; });
    },
    // Simulates a user removing an item in the app.
    appRemove: (id, itemId) => {
      const entries = playlist(id).entries;
      entries.splice(entries.findIndex((entry) => entry.itemId === itemId), 1);
    },
  };
}
