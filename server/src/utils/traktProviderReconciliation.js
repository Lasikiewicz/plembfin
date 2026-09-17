import { fetchTraktSeasonEpisodes, fetchTraktShowByProviderId } from "./traktClient.js";

function cleanId(value) {
  const text = String(value ?? "").trim();
  return text || "";
}

function groupKey(row) {
  const override = row?.provider_overrides?.trakt;
  return [
    cleanId(row?.tvdb_id),
    cleanId(override?.tmdb_id),
    Number(row?.season),
  ].join(":");
}

export function groupTraktProviderOverrideRows(rows = []) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const override = row?.provider_overrides?.trakt;
    if (row?.media_type !== "episode" || !row?.tvdb_id || !override?.tmdb_id) continue;
    const sourceSeason = Number(row.season);
    const sourceEpisode = Number(row.episode);
    if (!Number.isInteger(sourceSeason) || sourceSeason < 0) continue;
    if (!Number.isInteger(sourceEpisode) || sourceEpisode < 1) continue;
    const key = groupKey(row);
    let group = groups.get(key);
    if (!group) {
      group = {
        tvdbId: cleanId(row.tvdb_id),
        tmdbId: cleanId(override.tmdb_id),
        sourceSeason,
        rows: [],
        episodes: new Set(),
      };
      groups.set(key, group);
    }
    group.rows.push(row);
    group.episodes.add(sourceEpisode);
  }
  return [...groups.values()];
}

export function seasonContainsEpisodes(episodes = [], requiredEpisodes = []) {
  const available = new Set((Array.isArray(episodes) ? episodes : [])
    .map((episode) => Number(episode?.number ?? episode?.episode))
    .filter((number) => Number.isInteger(number) && number > 0));
  return [...requiredEpisodes].every((episode) => available.has(Number(episode)));
}

function idsMatchCanonical(show, { tvdbId, tmdbId }) {
  const ids = show?.ids || {};
  return cleanId(ids.tvdb) === cleanId(tvdbId) && cleanId(ids.tmdb) === cleanId(tmdbId);
}

async function lookupWithoutExpectedNotFound(lookup, ...args) {
  try {
    return await lookup(...args);
  } catch (error) {
    // A provider can briefly return 404 while rebuilding its catalogue. That
    // is not evidence that the local mapping should change.
    if (Number(error?.status) === 404) return null;
    throw error;
  }
}

// Check only explicit Trakt/TMDB split overrides. The canonical local TVDB
// id and season/episode coordinates remain authoritative unless Trakt now
// identifies that same series and exposes the same season numbering.
export async function reconcileTraktProviderOverrides({
  connection,
  rows = [],
  lookupShow = fetchTraktShowByProviderId,
  lookupSeason = fetchTraktSeasonEpisodes,
  clearOverrides = async () => ({ updatedRows: 0 }),
} = {}) {
  if (!connection || connection.status !== "connected") {
    return { skipped: true, reason: "trakt-not-connected", checked: 0, changed: 0 };
  }

  const groups = groupTraktProviderOverrideRows(rows);
  let checked = 0;
  let changed = 0;
  let errors = 0;
  const reconciledGroups = [];

  for (const group of groups) {
    checked += 1;
    try {
      const byTvdb = await lookupWithoutExpectedNotFound(lookupShow, connection, "tvdb", group.tvdbId);
      let matchingShow = idsMatchCanonical(byTvdb, group) ? byTvdb : null;

      // The TVDB search is the strongest signal, but also check the provider
      // series directly. This covers a Trakt catalogue refresh where the
      // reverse TVDB index lags behind the TMDB record for a short time.
      if (!matchingShow) {
        const byTmdb = await lookupWithoutExpectedNotFound(lookupShow, connection, "tmdb", group.tmdbId);
        if (idsMatchCanonical(byTmdb, group)) matchingShow = byTmdb;
      }
      if (!matchingShow?.ids?.trakt) continue;

      const episodes = await lookupWithoutExpectedNotFound(
        lookupSeason,
        connection,
        matchingShow.ids.trakt,
        group.sourceSeason,
      );
      if (!seasonContainsEpisodes(episodes, group.episodes)) continue;

      const result = await clearOverrides(group.rows);
      const updatedRows = Number(result?.updatedRows || result?.changed || 0);
      changed += Number.isFinite(updatedRows) ? updatedRows : 0;
      reconciledGroups.push({ tvdbId: group.tvdbId, tmdbId: group.tmdbId, season: group.sourceSeason, updatedRows });
    } catch {
      // One provider/API failure must not prevent another independent group
      // from being checked, and must never cause a speculative data rewrite.
      errors += 1;
    }
  }

  return { skipped: false, checked, changed, errors, reconciledGroups };
}
