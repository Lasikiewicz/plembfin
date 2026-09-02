import { db } from "../db.js";
import { getCachedShows, queryShowDetail, showTitleFrom } from "./dataRepo.js";
import { getTmdbDetails, getTmdbSeason } from "./tmdbGateway.js";
import { getCanonicalPosterUrl } from "./mediaArtwork.js";
import { minResumePositionMs, watchedThresholdPercent } from "./tuning.js";
import {
  mergeUpNextCandidates,
  normalizeUpNextCandidate,
  upNextIdentityAliases,
} from "./upNextIdentity.js";
import {
  getUpNextFeedSourceVersion,
  listActiveUpNextProviderItems,
  listUpNextProviderFeedStates,
} from "./upNextRepository.js";

const MAX_LOCAL_SHOWS = 24;
const LOCAL_METADATA_CONCURRENCY = 4;
const MAX_PROVIDER_OBSERVATIONS = 500;
// Bump when the provider poster proxy contract changes so browsers do not
// retain a stale negative response for the old URL.
const PROVIDER_POSTER_URL_VERSION = "2";

const selectProgressRowsStmt = db.prepare(
  "SELECT * FROM playback_progress WHERE position_ms > 0 ORDER BY COALESCE(updated_at, 0) DESC, media_key DESC",
);
const selectPlaystateRowsStmt = db.prepare(
  "SELECT * FROM playstate ORDER BY COALESCE(updated_at, 0) DESC, media_key DESC",
);
const selectShowPosterFromHistoryStmt = db.prepare(`
  SELECT NULLIF(poster_url, '') AS poster_url
  FROM watch_history
  WHERE media_type = 'episode'
    AND show_title IS NOT NULL
    AND show_title != ''
    AND LOWER(show_title) = LOWER(?)
    AND NULLIF(poster_url, '') IS NOT NULL
  ORDER BY watched_at DESC
  LIMIT 1
`);

function showPosterFromHistory(item = {}) {
  const title = text(item.show_title || showTitleFrom(item.title || ""));
  if (!title) return "";
  try {
    const row = selectShowPosterFromHistoryStmt.get(title);
    return text(row?.poster_url);
  } catch {
    return "";
  }
}

function text(value = "") {
  return String(value ?? "").trim();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function coordinate(row = {}) {
  const season = number(row.season, NaN);
  const episode = number(row.episode, NaN);
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode <= 0) return "";
  return `${season}:${episode}`;
}

function rowCandidate(row = {}, { queueKind = "resume", canonical = false } = {}) {
  const isEpisode = row.media_type === "episode";
  const showTitle = isEpisode ? text(row.show_title || showTitleFrom(row.title || "")) : "";
  return normalizeUpNextCandidate({
    media_key: row.media_key,
    media_type: row.media_type,
    queue_kind: queueKind,
    title: row.title,
    show_title: showTitle,
    episode_title: row.episode_title,
    season: row.season,
    episode: row.episode,
    // Episode rows in the canonical tables historically store the series id
    // in the flattened id columns. Supplying it as show_ids keeps them aligned
    // with provider episode observations without changing those tables.
    show_ids: isEpisode ? {
      imdb: row.show_imdb_id || row.imdb_id,
      tmdb: row.show_tmdb_id || row.tmdb_id,
      tvdb: row.show_tvdb_id || row.tvdb_id,
    } : undefined,
    ids: {
      imdb: row.imdb_id,
      tmdb: row.tmdb_id,
      tvdb: row.tvdb_id,
    },
    poster_url: row.poster_url,
    show_poster_url: row.show_poster_url,
    position_ms: row.position_ms,
    duration_ms: row.duration_ms,
    progress: row.progress,
    updated_at: row.updated_at,
    source: row.source || row.last_source || "local",
    sources: row.sources,
    is_canonical: canonical,
  });
}

function aliasesFor(candidate) {
  return new Set(upNextIdentityAliases(candidate));
}

function aliasesIntersect(left, right) {
  const rightSet = right instanceof Set ? right : new Set(right || []);
  return [...(left instanceof Set ? left : new Set(left || []))].some((alias) => rightSet.has(alias));
}

function newestStateFor(candidate, playstateRows) {
  const aliases = aliasesFor(candidate);
  return playstateRows
    .map((row) => ({ row, candidate: rowCandidate(row, { queueKind: "next_up" }) }))
    .filter(({ candidate: other }) => aliasesIntersect(aliases, aliasesFor(other)))
    .sort((left, right) => number(right.row.updated_at) - number(left.row.updated_at))[0]?.row || null;
}

function stateBlocksCandidate(candidate, playstateRows, { progressUpdatedAt = 0 } = {}) {
  const state = newestStateFor(candidate, playstateRows);
  if (!state) return false;
  const stateTime = number(state.updated_at);
  // A newer explicit watched or unwatched transition wins over a stale feed
  // observation. A genuinely newer playback position can start again after an
  // unwatch, so the timestamp comparison is intentional.
  return stateTime <= 0 || progressUpdatedAt <= 0 || stateTime >= progressUpdatedAt;
}

function stateIsWatched(candidate, playstateRows) {
  return newestStateFor(candidate, playstateRows)?.state === "watched";
}

function actionableResume(candidate) {
  const position = number(candidate.position_ms);
  const progress = number(candidate.progress);
  return position >= minResumePositionMs() && progress < watchedThresholdPercent();
}

function released(airDate, today) {
  const date = text(airDate);
  return !date || date <= today;
}

function episodeCoordinateForCandidate(candidate = {}) {
  const season = number(candidate.season, NaN);
  const episode = number(candidate.episode, NaN);
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode <= 0) return "";
  return `${season}:${episode}`;
}

function normalizedTitle(value = "") {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function providerObservationMatches(candidate, providerCandidate) {
  if (candidate?.media_type !== "episode" || providerCandidate?.media_type !== "episode") return false;
  if (!(providerCandidate.source === "plex" || providerCandidate.source === "emby" || providerCandidate.source === "jellyfin")
    || !text(providerCandidate.provider_item_id)) return false;
  const coordinate = episodeCoordinateForCandidate(candidate);
  if (!coordinate || coordinate !== episodeCoordinateForCandidate(providerCandidate)) return false;

  if (aliasesIntersect(aliasesFor(candidate), aliasesFor(providerCandidate))) return true;

  const candidateShowIds = {
    imdb: text(candidate.show_imdb_id),
    tmdb: text(candidate.show_tmdb_id),
    tvdb: text(candidate.show_tvdb_id),
  };
  const providerShowIds = {
    imdb: text(providerCandidate.show_imdb_id),
    tmdb: text(providerCandidate.show_tmdb_id),
    tvdb: text(providerCandidate.show_tvdb_id),
  };
  for (const provider of ["imdb", "tmdb", "tvdb"]) {
    if (candidateShowIds[provider] && providerShowIds[provider]
      && candidateShowIds[provider].toLowerCase() !== providerShowIds[provider].toLowerCase()) {
      return false;
    }
  }

  const candidateTitle = normalizedTitle(candidate.show_title || showTitleFrom(candidate.title || ""));
  const providerTitle = normalizedTitle(providerCandidate.show_title || showTitleFrom(providerCandidate.title || ""));
  return Boolean(candidateTitle && candidateTitle === providerTitle);
}

function publicItem(item) {
  const {
    canonical_key: _canonicalKey,
    source: _source,
    is_canonical: _isCanonical,
    _aliases: _aliases,
    provider_item_id: _providerItemId,
    parent_provider_item_id: _parentProviderItemId,
    series_provider_item_id: _seriesProviderItemId,
    resolution_status: _resolutionStatus,
    last_error: _lastError,
    ...safe
  } = item;
  const providerEntries = Object.entries(item.provider_items || {})
    .map(([provider, ids]) => {
      const values = Array.isArray(ids) ? ids : ids ? [ids] : [];
      return [String(provider || "").toLowerCase(), values];
    })
    .filter(([provider, ids]) => provider && ids.length);
  const preferredProvider = String(item.source || "").toLowerCase();
  const orderedProviderEntries = [
    ...providerEntries.filter(([provider]) => provider === preferredProvider),
    ...providerEntries.filter(([provider]) => provider !== preferredProvider),
  ];
  const providerPoster = orderedProviderEntries.find(([, ids]) => String(ids[0] || "").trim());
  const providerPosterUrl = providerPoster
    ? `/api/poster?id=${encodeURIComponent(String(providerPoster[1][0]))}&provider=${encodeURIComponent(providerPoster[0])}&format=image&v=${PROVIDER_POSTER_URL_VERSION}`
    : "";
  const rawPoster = String(safe.poster_url || "").trim();
  const rawShowPoster = String(safe.show_poster_url || "").trim();
  const isKnownPoster = (value) => Boolean(
    value && (
      /^\/media\/posters\//i.test(value)
      || /^\/api\/tmdb-poster/i.test(value)
      || /^https:\/\/image\.tmdb\.org\//i.test(value)
    )
  );
  // Episodes in Up Next represent the series. Reuse the shared show artwork
  // cache (and watch history show artwork) so known shows load their poster
  // instantly from local storage/cache without querying the provider proxy.
  const canonicalShowPoster = safe.media_type === "episode"
    ? (getCanonicalPosterUrl({
      media_type: "episode",
      show_title: safe.show_title,
      show_imdb_id: safe.show_imdb_id,
      show_tmdb_id: safe.show_tmdb_id,
      show_tvdb_id: safe.show_tvdb_id,
    }) || showPosterFromHistory(safe))
    : "";
  const effectiveShowPoster = canonicalShowPoster || (isKnownPoster(rawShowPoster) ? rawShowPoster : "");
  const effectivePoster = (safe.media_type === "episode" && effectiveShowPoster)
    ? effectiveShowPoster
    : (isKnownPoster(rawPoster) ? rawPoster : canonicalShowPoster);
  return {
    ...safe,
    id: item.id,
    media_key: item.media_key,
    queue_kind: item.queue_kind,
    media_type: item.media_type,
    poster_url: effectivePoster || providerPosterUrl || null,
    show_poster_url: effectiveShowPoster || providerPosterUrl || null,
    is_upcoming: false,
  };
}

export function publicUpNextItems(items = []) {
  return mergeUpNextCandidates(items).map(publicItem);
}

async function localNextUpForShow(show, {
  playstateRows,
  progressCandidates,
  providerCandidates = [],
  today,
}) {
  const detail = await queryShowDetail({
    id: show.id,
    title: show.title,
    tmdbId: show.tmdb_id,
    tvdbId: show.tvdb_id,
    imdbId: show.imdb_id,
  }).catch(() => null);
  const episodes = Array.isArray(detail?.episodes) ? detail.episodes : [];
  const watched = new Set();
  for (const row of episodes) {
    const candidate = rowCandidate(row, { queueKind: "next_up" });
    const canonicalState = newestStateFor(candidate, playstateRows)?.state;
    const isWatched = canonicalState === "watched"
      || (!canonicalState && String(row.sync_action || "watched").toLowerCase() !== "unwatched");
    if (isWatched) {
      const key = coordinate(row);
      if (key) watched.add(key);
    }
  }

  const metadata = await getTmdbDetails({
    mediaType: "tv",
    tmdbId: show.tmdb_id,
    title: show.title,
    ids: { tvdbId: show.tvdb_id, imdbId: show.imdb_id },
    light: true,
  }).catch(() => null);
  const tmdbId = text(show.tmdb_id || metadata?.id);
  const tvdbId = text(show.tvdb_id || metadata?.external_ids?.tvdb_id);
  if (!tmdbId && !tvdbId) return null;

  const seasonNumbers = [...new Set((metadata?.seasons || [])
    .map((season) => number(season.season_number, NaN))
    .filter((season) => Number.isInteger(season) && season > 0))]
    .sort((left, right) => left - right);
  const maxWatchedSeason = Math.max(0, ...episodes.map((row) => number(row.season, 0)));
  const firstSeason = maxWatchedSeason || seasonNumbers[0] || 1;
  const candidateSeasons = seasonNumbers.length
    ? [firstSeason, ...seasonNumbers.filter((season) => season > firstSeason)]
    : [firstSeason, firstSeason + 1];

  for (const seasonNumber of [...new Set(candidateSeasons)].slice(0, 3)) {
    const season = await getTmdbSeason({ tmdbId, tvdbId, seasonNumber }).catch(() => null);
    const seasonEpisodes = [...(season?.episodes || [])]
      .filter((episode) => number(episode.episode_number, 0) > 0)
      .sort((left, right) => number(left.episode_number) - number(right.episode_number));
    for (const episode of seasonEpisodes) {
      const episodeNumber = number(episode.episode_number, 0);
      const key = `${seasonNumber}:${episodeNumber}`;
      if (!released(episode.air_date, today) || watched.has(key)) continue;
      const candidate = normalizeUpNextCandidate({
        queue_kind: "next_up",
        media_type: "episode",
        title: show.title,
        show_title: show.title,
        episode_title: episode.name || "",
        season: seasonNumber,
        episode: episodeNumber,
        show_ids: { tmdb: tmdbId, tvdb: tvdbId, imdb: show.imdb_id },
        tmdb_id: tmdbId,
        tvdb_id: tvdbId,
        poster_url: show.poster_url || metadata?.cached_poster_url
          || (metadata?.poster_path ? `/api/tmdb-poster?path=${encodeURIComponent(metadata.poster_path)}` : ""),
        air_date: episode.air_date || "",
        source: "local",
      });
      if (stateIsWatched(candidate, playstateRows)) continue;
      if (progressCandidates.some((resume) => aliasesIntersect(aliasesFor(candidate), aliasesFor(resume)))) continue;
      // Local history and TMDB metadata can tell us what should come next, but
      // cannot prove that the episode still exists in a configured media
      // server library. Require a matching active provider observation before
      // allowing the fallback into Up Next; otherwise the card renders with
      // no provider items and every Watch now badge is misleadingly greyed.
      if (!providerCandidates.some((providerCandidate) => providerObservationMatches(candidate, providerCandidate))) continue;
      return candidate;
    }
  }
  return null;
}

async function localNextUpCandidates({
  shows,
  playstateRows,
  progressCandidates,
  providerCandidates = [],
  today,
}) {
  const selectedShows = (Array.isArray(shows) ? shows : [])
    .filter((show) => Number(show.episode_count || 0) > 0)
    .sort((left, right) => (
      String(right.latest_watched_at || "").localeCompare(String(left.latest_watched_at || ""))
        || String(left.title || "").localeCompare(String(right.title || ""))
        || String(left.id || "").localeCompare(String(right.id || ""))
    ))
    .slice(0, MAX_LOCAL_SHOWS);
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < selectedShows.length) {
      const show = selectedShows[cursor++];
      const candidate = await localNextUpForShow(show, {
        playstateRows,
        progressCandidates,
        providerCandidates,
        today,
      });
      if (candidate) results.push(candidate);
    }
  }
  await Promise.all(Array.from({
    length: Math.min(LOCAL_METADATA_CONCURRENCY, selectedShows.length),
  }, worker));
  return results;
}

export async function buildUpNextProjection({
  limit = 100,
  now = Date.now(),
  progressRows = null,
  playstateRows = null,
  providerItems = null,
  shows = null,
  localFallback = true,
} = {}) {
  const rawProgressRows = progressRows || selectProgressRowsStmt.all();
  const rawPlaystateRows = playstateRows || selectPlaystateRowsStmt.all();
  const canonicalResume = rawProgressRows
    .map((row) => rowCandidate(row, { queueKind: "resume", canonical: true }))
    .filter(actionableResume)
    .filter((candidate) => !stateBlocksCandidate(candidate, rawPlaystateRows, { progressUpdatedAt: candidate.updated_at }));
  const canonicalResumeAliases = canonicalResume.map(aliasesFor);

  const observations = (providerItems || listActiveUpNextProviderItems()).slice(0, MAX_PROVIDER_OBSERVATIONS);
  const providerCandidates = observations.map((item) => normalizeUpNextCandidate(item));
  const providerResume = providerCandidates
    .filter((candidate) => candidate.queue_kind === "resume" && actionableResume(candidate))
    .filter((candidate) => !stateBlocksCandidate(candidate, rawPlaystateRows, { progressUpdatedAt: candidate.updated_at }))
    .filter((candidate) => !stateIsWatched(candidate, rawPlaystateRows));
  const providerNextUp = providerCandidates
    .filter((candidate) => candidate.queue_kind === "next_up" && released(candidate.air_date, new Date(now).toISOString().slice(0, 10)))
    .filter((candidate) => !stateIsWatched(candidate, rawPlaystateRows))
    .filter((candidate) => !canonicalResumeAliases.some((aliases) => aliasesIntersect(aliases, aliasesFor(candidate))))
    .map((candidate) => ({ ...candidate, position_ms: 0, duration_ms: null, progress: 0 }));

  let localNextUp = [];
  if (localFallback) {
    const localShows = shows || await getCachedShows();
    localNextUp = await localNextUpCandidates({
      shows: localShows,
      playstateRows: rawPlaystateRows,
      progressCandidates: canonicalResume,
      providerCandidates,
      today: new Date(now).toISOString().slice(0, 10),
    });
  }

  const merged = mergeUpNextCandidates([
    ...canonicalResume,
    ...providerResume,
    ...providerNextUp,
    ...localNextUp,
  ]);
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const sourceStatus = listUpNextProviderFeedStates().map(({ cursor: _cursor, ...feed }) => feed);
  return {
    items: publicUpNextItems(merged.slice(0, safeLimit)),
    sourceStatus,
    sourceVersion: getUpNextFeedSourceVersion(),
  };
}

export async function buildUpNextItems(options = {}) {
  const projection = await buildUpNextProjection(options);
  return projection.items;
}
