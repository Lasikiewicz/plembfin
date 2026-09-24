import { db, parseJson, toJson, transaction } from "../db.js";
import {
  idsShareAny,
  invalidateHistoryDerivedCaches,
  invalidateSeriesIdentityIndex,
  mediaKeyFor,
  normalizeRepairShowTitle,
  provenPlaystateAliasProfile,
  seriesCoordinate,
  seriesIdentityProfilesForShowTitle,
  showTitleFromEpisodeTitle,
} from "./dataRepo.js";
import { getCachedTmdbExternalIdKind } from "./tmdbGateway.js";
import { getCachedTvdbEpisodeKind } from "./tvdbGateway.js";

// The Maintenance card for episode playstate aliases no proof tier can place
// (plan/playstate-episode-id-repair.md, "Rows no tier proves"). The scheduled
// repair never folds these (decision 34); the user decides per show:
// "Belongs to this show" folds them with the newest state winning, and
// "Different show" stores their keys so the card and the repair skip them.

const DISMISSED_ID = "playstateAliasDismissed";
const selectSetting = db.prepare("SELECT data FROM settings WHERE id = ?");
const upsertSetting = db.prepare(`
  INSERT INTO settings (id, data, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);

export function dismissedPlaystateAliasKeys() {
  const data = parseJson(selectSetting.get(DISMISSED_ID)?.data, {});
  return new Set(Array.isArray(data.keys) ? data.keys : []);
}

function rowIds(row = {}) {
  return {
    imdb: String(row.imdb_id || "").trim(),
    tmdb: String(row.tmdb_id || "").trim(),
    tvdb: String(row.tvdb_id || "").trim(),
  };
}

function profileKeyFor(profile, row) {
  return mediaKeyFor({
    media_type: "episode",
    season: row.season,
    episode: row.episode,
    imdb_id: profile.ids.imdb,
    tmdb_id: profile.ids.tmdb,
    tvdb_id: profile.ids.tvdb,
  });
}

// The show-keyed row a fold compares against: the row at the profile's own
// key, else the newest row that shares any of the profile's ids.
function showKeyedRow(profile, row, group) {
  const key = profileKeyFor(profile, row);
  const siblings = group.filter((other) => idsShareAny(rowIds(other), profile.ids));
  return siblings.find((other) => other.media_key === key)
    || siblings.sort((left, right) => Number(right.updated_at || 0) - Number(left.updated_at || 0))[0]
    || null;
}

// Why no tier proves the row, from the cached answers only.
function unprovenReason(row, profiles, { findCached, tvdbCached }) {
  const answers = [["imdb", "imdb_id"], ["tvdb", "tvdb_id"]]
    .map(([provider, source]) => (row[`${provider}_id`] ? findCached(source, String(row[`${provider}_id`]).trim()) : null))
    .filter(Boolean);
  if (!answers.length) return { code: "no-lookup", otherShowId: "" };
  if (answers.some((answer) => answer.kind === "series")) return { code: "series-id", otherShowId: "" };
  const episodes = answers.filter((answer) => answer.kind === "episode");
  if (!episodes.length) {
    const tvdbAnswer = row.tvdb_id ? tvdbCached(String(row.tvdb_id).trim()) : null;
    return { code: tvdbAnswer?.kind === "episode" ? "tvdb-unmatched" : "not-found", otherShowId: "" };
  }
  const otherShow = episodes.find((answer) => !profiles.some((profile) => profile.ids.tmdb && String(profile.ids.tmdb) === String(answer.showId || "")));
  if (otherShow) return { code: "other-show", otherShowId: String(otherShow.showId || "") };
  const sameCoordinate = episodes.every((answer) => Number(answer.season) === Number(row.season) && Number(answer.episode) === Number(row.episode));
  return { code: sameCoordinate ? "ambiguous" : "coordinate", otherShowId: "" };
}

// Groups every episode playstate row by show title and coordinate (as the
// repair does) and returns the rows no tier proves, excluding rows still
// waiting for a lookup, proven rows (the repair's), and dismissed rows.
export async function listUnprovenPlaystateAliases({
  findCached = getCachedTmdbExternalIdKind,
  tvdbCached = getCachedTvdbEpisodeKind,
} = {}) {
  invalidateSeriesIdentityIndex();
  const dismissed = dismissedPlaystateAliasKeys();
  const groups = new Map();
  for (const row of db.prepare("SELECT * FROM playstate WHERE media_type = 'episode'").all()) {
    if (dismissed.has(row.media_key)) continue;
    const showKey = normalizeRepairShowTitle(showTitleFromEpisodeTitle(row.title));
    const coordinate = seriesCoordinate(row);
    if (!showKey || !coordinate) continue;
    const key = `${showKey}|${coordinate}`;
    if (!groups.has(key)) groups.set(key, { showKey, rows: [] });
    groups.get(key).rows.push(row);
  }

  const shows = new Map();
  for (const { showKey, rows: group } of groups.values()) {
    const profiles = seriesIdentityProfilesForShowTitle(showKey);
    if (!profiles.length) continue;
    for (const row of group) {
      // Title-keyed rows with no id at all are out of this card's scope (plan).
      if (!Object.values(rowIds(row)).some(Boolean)) continue;
      if (profiles.some((profile) => idsShareAny(rowIds(row), profile.ids))) continue;
      const proof = { findCached, tvdbCached, pendingLookups: new Map(), pendingTvdbLookups: new Map() };
      if (provenPlaystateAliasProfile(row, profiles, proof)) continue;
      if (proof.pendingLookups.size || proof.pendingTvdbLookups.size) continue;
      if (!shows.has(showKey)) {
        shows.set(showKey, {
          showKey,
          title: showTitleFromEpisodeTitle(row.title),
          profiles: profiles.map((profile) => ({ ...profile.ids })),
          tmdbDisagreement: null,
          rows: [],
        });
      }
      const show = shows.get(showKey);
      const reason = unprovenReason(row, profiles, proof);
      if (reason.code === "other-show" && profiles.every((profile) => profile.ids.tmdb) && !show.tmdbDisagreement) {
        show.tmdbDisagreement = { findShowId: reason.otherShowId, profileTmdbIds: profiles.map((profile) => profile.ids.tmdb) };
      }
      show.rows.push({
        mediaKey: row.media_key,
        title: row.title,
        season: Number(row.season),
        episode: Number(row.episode),
        ids: rowIds(row),
        state: row.state,
        updatedAt: Number(row.updated_at || 0),
        reason: reason.code,
        showKeyed: profiles.map((profile) => {
          const series = showKeyedRow(profile, row, group);
          return series ? { state: series.state, updatedAt: Number(series.updated_at || 0) } : null;
        }),
      });
    }
  }
  invalidateSeriesIdentityIndex();
  return [...shows.values()]
    .map((show) => ({ ...show, rows: show.rows.sort((left, right) => left.season - right.season || left.episode - right.episode) }))
    .sort((left, right) => left.title.localeCompare(right.title));
}

function listedShow(shows, showKey) {
  const show = shows.find((entry) => entry.showKey === String(showKey || ""));
  if (!show) throw Object.assign(new Error("That show has no unproven watch-state aliases left"), { status: 404 });
  return show;
}

// "Belongs to this show": each listed alias is compared with the profile's
// show-keyed row at its coordinate and the newest state wins. An older alias
// is deleted; a newer one (or one with no show-keyed row) replaces the row
// at the profile's key, keeping its own state and timestamps.
export async function foldPlaystateAliasesIntoShow(showKey, profileIndex, options = {}) {
  const show = listedShow(await listUnprovenPlaystateAliases(options), showKey);
  const profileIds = show.profiles[Number(profileIndex)];
  if (!profileIds) throw Object.assign(new Error("Unknown show identity for this title"), { status: 400 });
  const profile = { ids: profileIds };
  const listedKeys = new Set(show.rows.map((row) => row.mediaKey));
  const rows = db.prepare("SELECT * FROM playstate WHERE media_type = 'episode'").all()
    .filter((row) => normalizeRepairShowTitle(showTitleFromEpisodeTitle(row.title)) === show.showKey);
  const byCoordinate = new Map();
  for (const row of rows) {
    const coordinate = seriesCoordinate(row);
    if (!byCoordinate.has(coordinate)) byCoordinate.set(coordinate, []);
    byCoordinate.get(coordinate).push(row);
  }

  const deleteStmt = db.prepare("DELETE FROM playstate WHERE media_key = ?");
  const rekeyStmt = db.prepare("UPDATE playstate SET media_key = ?, imdb_id = ?, tmdb_id = ?, tvdb_id = ? WHERE media_key = ?");
  let deleted = 0;
  let rekeyed = 0;
  transaction(() => {
    for (const group of byCoordinate.values()) {
      const aliases = group.filter((row) => listedKeys.has(row.media_key))
        .sort((left, right) => Number(right.updated_at || 0) - Number(left.updated_at || 0));
      if (!aliases.length) continue;
      const key = profileKeyFor(profile, aliases[0]);
      let series = showKeyedRow(profile, aliases[0], group.filter((row) => !listedKeys.has(row.media_key)));
      for (const alias of aliases) {
        if (series && Number(alias.updated_at || 0) <= Number(series.updated_at || 0)) {
          deleteStmt.run(alias.media_key);
          deleted += 1;
          continue;
        }
        if (group.some((row) => row.media_key === key)) {
          deleteStmt.run(key);
          deleted += 1;
        }
        rekeyStmt.run(key, profileIds.imdb || null, profileIds.tmdb || null, profileIds.tvdb || null, alias.media_key);
        rekeyed += 1;
        series = alias;
      }
    }
  });
  if (deleted || rekeyed) await invalidateHistoryDerivedCaches("foldPlaystateAliasesIntoShow");
  return { deleted, rekeyed };
}

// "Different show": the listed aliases are never flagged again, and the
// scheduled repair skips them.
export async function dismissPlaystateAliasesForShow(showKey, options = {}) {
  const show = listedShow(await listUnprovenPlaystateAliases(options), showKey);
  const keys = dismissedPlaystateAliasKeys();
  for (const row of show.rows) keys.add(row.mediaKey);
  upsertSetting.run(DISMISSED_ID, toJson({ keys: [...keys] }), Date.now());
  return { dismissed: show.rows.length };
}
