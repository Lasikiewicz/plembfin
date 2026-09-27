import { bumpDataVersion, db, transaction } from "../db.js";
import { personalMediaKey } from "./personalMediaKey.js";
import { withPlaylistLock } from "./playlistPushEngine.js";
import { getTmdbDetails, getTmdbSeason } from "./tmdbGateway.js";

// TV playlists hold separate episodes (plan/archive/custom-playlist-sync/plan.md decisions
// 13, 15, 17, 18). A show item left from before that change becomes every
// episode the metadata lists, specials and unaired ones included, minus the
// episodes the app had removed (its exclusions), at the show's place in the
// playlist. Episodes already in the playlist keep their place. When the
// episodes cannot be fetched the show stays and the next scheduled pass
// retries; the sync skips a playlist until its shows are converted.

function text(value = "") {
  return String(value ?? "").trim();
}

function episodeKey(season, episode) {
  return `s${season}e${episode}`;
}

export const showConversionDeps = Object.freeze({
  getDetails: getTmdbDetails,
  getSeason: getTmdbSeason,
});

// Every episode the metadata lists for a show, in episode order:
// [{ season, episode, title, overview, air_date }]. Also returns the show ids
// the metadata resolved. Throws when any season cannot be read, or when the
// metadata lists no episodes, so a partial answer never replaces a show.
export async function fetchShowEpisodes(show, deps = showConversionDeps) {
  const details = await deps.getDetails({
    mediaType: "tv",
    tmdbId: text(show.tmdb_id),
    title: text(show.title),
    ids: { tvdbId: text(show.tvdb_id), imdbId: text(show.imdb_id) },
    lane: "interactive",
  });
  const tmdbId = text(show.tmdb_id) || text(details?.id);
  const tvdbId = text(details?.external_ids?.tvdb_id) || text(show.tvdb_id);
  const seasonNumbers = [...new Set((details?.seasons || [])
    .map((season) => Number(season?.season_number))
    .filter((number) => Number.isInteger(number) && number >= 0))].sort((a, b) => a - b);
  const episodes = [];
  for (const seasonNumber of seasonNumbers) {
    const season = await deps.getSeason({ tmdbId, tvdbId, seasonNumber, lane: "interactive" });
    for (const entry of season?.episodes || []) {
      const episode = Number(entry?.episode_number);
      if (!Number.isInteger(episode) || episode < 1) continue;
      episodes.push({
        season: seasonNumber,
        episode,
        title: text(entry.name),
        overview: text(entry.overview).slice(0, 4000),
        air_date: text(entry.air_date).slice(0, 40),
      });
    }
  }
  if (!episodes.length) throw new Error(`No episodes are listed for ${text(show.title) || "this show"}.`);
  const unique = new Map(episodes.map((entry) => [episodeKey(entry.season, entry.episode), entry]));
  return {
    ids: { tmdb_id: tmdbId, tvdb_id: tvdbId, imdb_id: text(show.imdb_id) || text(details?.external_ids?.imdb_id) },
    episodes: [...unique.values()].sort((a, b) => (a.season - b.season) || (a.episode - b.episode)),
  };
}

// The playlist item row for one episode of a show. Episode items keep the show
// ids in tmdb_id/tvdb_id/imdb_id, as the route and the pull pass store them.
export function episodeItemRow(show, ids, entry) {
  const row = {
    media_type: "episode",
    title: entry.title || `Episode ${entry.episode}`,
    tmdb_id: ids.tmdb_id || "",
    tvdb_id: ids.tvdb_id || "",
    imdb_id: ids.imdb_id || "",
    poster_url: text(show.poster_url),
    overview: entry.overview || "",
    release_date: entry.air_date || "",
    show_title: text(show.show_title) || text(show.title),
    season: entry.season,
    episode: entry.episode,
  };
  row.media_key = personalMediaKey({
    ...row,
    show_tmdb_id: row.tmdb_id,
    show_tvdb_id: row.tvdb_id,
    show_imdb_id: row.imdb_id,
  });
  return row;
}

const selectItemsStmt = db.prepare("SELECT * FROM personal_list_items WHERE list_id = ? ORDER BY position ASC, media_key ASC");
const selectShowStmt = db.prepare("SELECT * FROM personal_list_items WHERE list_id = ? AND media_key = ? AND media_type = 'tv'");
const selectExclusionsStmt = db.prepare("SELECT season, episode FROM personal_list_item_exclusions WHERE list_id = ? AND media_key = ?");
const selectShowListsStmt = db.prepare("SELECT DISTINCT list_id FROM personal_list_items WHERE media_type = 'tv' ORDER BY list_id ASC");
const selectShowKeysStmt = db.prepare("SELECT media_key FROM personal_list_items WHERE list_id = ? AND media_type = 'tv' ORDER BY position ASC");
const insertItemStmt = db.prepare(`
  INSERT INTO personal_list_items
    (list_id, media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date,
     show_title, season, episode, position, created_at, updated_at)
  VALUES (@list_id, @media_key, 'episode', @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url, @overview, @release_date,
     @show_title, @season, @episode, @position, @now, @now)
`);
const setPositionStmt = db.prepare("UPDATE personal_list_items SET position = ? WHERE list_id = ? AND media_key = ?");
const deleteItemStmt = db.prepare("DELETE FROM personal_list_items WHERE list_id = ? AND media_key = ?");
// The show's app entries now stand for its episode items, so the push keeps
// them instead of removing and re-adding every episode.
const relinkLedgerStmt = db.prepare(`
  UPDATE personal_list_entry_ledger SET media_key = ?
  WHERE list_id = ? AND media_key = ? AND season = ? AND episode = ?
`);
const touchListStmt = db.prepare("UPDATE personal_lists SET kind = COALESCE(kind, 'tv'), updated_at = ? WHERE id = ?");

// Replaces one show item with its episodes. Returns the number of episodes
// added, or null when the show is no longer in the playlist.
export function applyShowConversion(listId, showKey, { ids, episodes }, now = Date.now()) {
  return transaction(() => {
    const show = selectShowStmt.get(listId, showKey);
    if (!show) return null;
    const excluded = new Set(selectExclusionsStmt.all(listId, showKey).map((row) => episodeKey(row.season, row.episode)));
    const items = selectItemsStmt.all(listId);
    const existing = new Set(items.map((row) => row.media_key));
    const rows = episodes
      .filter((entry) => !excluded.has(episodeKey(entry.season, entry.episode)))
      .map((entry) => episodeItemRow(show, ids, entry));
    const added = rows.filter((row) => !existing.has(row.media_key));
    for (const row of rows) relinkLedgerStmt.run(row.media_key, listId, showKey, row.season, row.episode);
    for (const row of added) insertItemStmt.run({ ...row, list_id: listId, position: 0, now });
    const order = [];
    for (const item of items) {
      if (item.media_key === showKey) order.push(...added.map((row) => row.media_key));
      else order.push(item.media_key);
    }
    deleteItemStmt.run(listId, showKey);
    order.forEach((key, index) => setPositionStmt.run(index, listId, key));
    touchListStmt.run(now, listId);
    return added.length;
  });
}

export async function convertPlaylistShows(listId, { deps = showConversionDeps, now = () => Date.now() } = {}) {
  const results = [];
  for (const { media_key: showKey } of selectShowKeysStmt.all(listId)) {
    const show = selectShowStmt.get(listId, showKey);
    if (!show) continue;
    try {
      const fetched = await fetchShowEpisodes(show, deps);
      const added = await withPlaylistLock(listId, async () => applyShowConversion(listId, showKey, fetched, now()));
      results.push({ showKey, status: added === null ? "gone" : "converted", added: added ?? 0 });
    } catch (error) {
      console.warn(`[playlists] Converting ${show.title} in playlist ${listId} to episodes failed; retrying on the next pass: ${error?.message || error}`);
      results.push({ showKey, status: "error", error: text(error?.message || error) });
    }
  }
  return results;
}

// Called by the scheduled playlist pass, for every playlist including
// Plembfin-only and deleted ones (a restore must not bring a show back).
export async function convertAllPlaylistShows(options = {}) {
  const results = [];
  for (const { list_id: listId } of selectShowListsStmt.all()) {
    results.push({ listId, shows: await convertPlaylistShows(listId, options) });
  }
  if (results.some((entry) => entry.shows.some((show) => show.status === "converted"))) bumpDataVersion();
  return results;
}
