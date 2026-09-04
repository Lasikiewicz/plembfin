import { db } from "../db.js";
import { getCachedShows, loadTrackedEpisodeRows, queryShowDetail, showTitleFrom } from "./dataRepo.js";
import { getCachedTmdbDetails, getCachedTmdbSeason } from "./tmdbGateway.js";
import { getCanonicalPosterUrl } from "./mediaArtwork.js";
import { minResumePositionMs, watchedThresholdPercent } from "./tuning.js";
import {
  mergeUpNextCandidates,
  normalizeUpNextCandidate,
  sortUpNextItems,
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

// Resolving a candidate's playstate used to re-derive an identity for every
// playstate row on every lookup: a full map + aliasesFor over the whole table,
// then a sort, per episode examined. With a real library that is 8k rows
// rebuilt tens of thousands of times, and because better-sqlite3 and this
// normalization are synchronous it blocked the event loop for a full minute -
// long enough to stall every HTTP request and to let the 60s scheduler lease
// expire, which is what surfaced as the app freezing.
//
// The rows are instead normalized once per projection into an alias index.
// Lookup then touches only the candidate's own aliases.
function buildPlaystateIndex(playstateRows = []) {
  const byAlias = new Map();
  playstateRows.forEach((row, order) => {
    const updatedAt = number(row.updated_at);
    for (const alias of upNextIdentityAliases(rowCandidate(row, { queueKind: "next_up" }))) {
      const existing = byAlias.get(alias);
      if (!existing || updatedAt > existing.updatedAt) byAlias.set(alias, { row, updatedAt, order });
    }
  });
  return byAlias;
}

function newestStateFor(candidate, playstateIndex) {
  let best = null;
  for (const alias of upNextIdentityAliases(candidate)) {
    const entry = playstateIndex.get(alias);
    if (!entry) continue;
    // Ties resolve to the row that came first in the query's own ordering,
    // matching the stable sort this replaced.
    if (!best || entry.updatedAt > best.updatedAt || (entry.updatedAt === best.updatedAt && entry.order < best.order)) {
      best = entry;
    }
  }
  return best?.row || null;
}

function stateBlocksCandidate(candidate, playstateIndex, { progressUpdatedAt = 0 } = {}) {
  const state = newestStateFor(candidate, playstateIndex);
  if (!state) return false;
  const stateTime = number(state.updated_at);
  // A newer explicit watched or unwatched transition wins over a stale feed
  // observation. A genuinely newer playback position can start again after an
  // unwatch, so the timestamp comparison is intentional.
  return stateTime <= 0 || progressUpdatedAt <= 0 || stateTime >= progressUpdatedAt;
}

function stateIsWatched(candidate, playstateIndex) {
  return newestStateFor(candidate, playstateIndex)?.state === "watched";
}

function actionableResume(candidate) {
  const position = number(candidate.position_ms);
  const progress = number(candidate.progress);
  return position >= minResumePositionMs() && progress < watchedThresholdPercent();
}

function providerResumeMembership(candidate) {
  // Plex and Emby both expose a provider-curated Continue Watching rail whose
  // list items can omit playback position. Membership in that native feed is
  // still authoritative for Up Next, even when it cannot be used to
  // propagate a numeric checkpoint to another provider.
  return candidate?.queue_kind === "resume"
    && ["plex", "emby", "jellyfin"].includes(String(candidate?.source || "").toLowerCase())
    && Boolean(candidate?.provider_item_id);
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

function showRecencyKeys(item = {}) {
  const keys = [];
  for (const [kind, values] of [
    ["imdb", [item.show_imdb_id, item.imdb_id]],
    ["tmdb", [item.show_tmdb_id, item.tmdb_id]],
    ["tvdb", [item.show_tvdb_id, item.tvdb_id]],
  ]) {
    for (const value of values) {
      const normalized = text(value).toLowerCase();
      if (normalized) keys.push(`${kind}:${normalized}`);
    }
  }
  const title = normalizedTitle(item.show_title || showTitleFrom(item.title || ""));
  if (title) keys.push(`title:${title}`);
  return [...new Set(keys)];
}

function showRecencyIndex(shows = []) {
  const index = new Map();
  for (const show of Array.isArray(shows) ? shows : []) {
    const latest = text(show.latest_watched_at || show.latestWatchedAt);
    if (!latest) continue;
    for (const key of showRecencyKeys({
      show_title: show.title,
      show_imdb_id: show.imdb_id,
      show_tmdb_id: show.tmdb_id,
      show_tvdb_id: show.tvdb_id,
    })) {
      const current = index.get(key);
      if (!current || String(latest).localeCompare(String(current)) > 0) index.set(key, latest);
    }
  }
  return index;
}

function decorateShowRecency(candidate, index) {
  if (candidate?.media_type !== "episode") return candidate;
  const latest = showRecencyKeys(candidate)
    .map((key) => index.get(key))
    .filter(Boolean)
    .sort((left, right) => String(right).localeCompare(String(left)))[0] || null;
  return latest ? { ...candidate, show_latest_watched_at: latest } : candidate;
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

function providerItemsFromTrackedEpisode(row = {}) {
  const provenance = row.watch_provenance && typeof row.watch_provenance === "object"
    ? row.watch_provenance
    : {};
  const provider = text(provenance.source || row.source).toLowerCase();
  const itemId = text(provenance.item_id || provenance.itemId);
  if (!itemId || !["plex", "emby", "jellyfin"].includes(provider)) return {};
  return { [provider]: [itemId] };
}

function episodeIdsFromTrackedEpisode(row = {}, showIds = {}) {
  const ids = {};
  for (const provider of ["imdb", "tmdb", "tvdb"]) {
    const value = text(row[`${provider}_id`]);
    if (value && value.toLowerCase() !== text(showIds[provider]).toLowerCase()) ids[provider] = value;
  }
  return ids;
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
  // Movies similarly resolve their canonical poster from metadata/cache.
  const canonicalPoster = safe.media_type === "episode"
    ? (getCanonicalPosterUrl({
      media_type: "episode",
      show_title: safe.show_title,
      show_imdb_id: safe.show_imdb_id,
      show_tmdb_id: safe.show_tmdb_id,
      show_tvdb_id: safe.show_tvdb_id,
    }) || showPosterFromHistory(safe))
    : getCanonicalPosterUrl({
      media_type: "movie",
      title: safe.title,
      tmdb_id: safe.tmdb_id,
      imdb_id: safe.imdb_id,
    });
  const effectiveShowPoster = safe.media_type === "episode"
    ? (canonicalPoster || (isKnownPoster(rawShowPoster) ? rawShowPoster : ""))
    : "";
  const effectivePoster = safe.media_type === "episode"
    ? (effectiveShowPoster || (isKnownPoster(rawPoster) ? rawPoster : ""))
    : (isKnownPoster(rawPoster) ? rawPoster : canonicalPoster);
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
  playstateIndex,
  progressCandidates,
  providerCandidates = [],
  episodeRows,
  today,
}) {
  const detail = await queryShowDetail({
    episodeRows,
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
    const canonicalState = newestStateFor(candidate, playstateIndex)?.state;
    const isWatched = canonicalState === "watched"
      || (!canonicalState && String(row.sync_action || "watched").toLowerCase() !== "unwatched");
    if (isWatched) {
      const key = coordinate(row);
      if (key) watched.add(key);
    }
  }

  const metadata = getCachedTmdbDetails({
    mediaType: "tv",
    tmdbId: show.tmdb_id,
    title: show.title,
    ids: { tvdbId: show.tvdb_id, imdbId: show.imdb_id },
  });
  const tmdbId = text(show.tmdb_id || metadata?.id);
  const tvdbId = text(show.tvdb_id || metadata?.external_ids?.tvdb_id);
  if (!tmdbId && !tvdbId) return null;

  const seasonNumbers = [...new Set((metadata?.seasons || [])
    .map((season) => number(season.season_number, NaN))
    .filter((season) => Number.isInteger(season) && season > 0))]
    .sort((left, right) => left - right);
  // Episode rows also include provider-supplied unplayed/future rows. They
  // must not make the fallback jump from the last watched S03 episode to an
  // unrelated S04 placeholder; choose the season from watched coordinates
  // only, then scan later seasons if that season is exhausted.
  const maxWatchedSeason = Math.max(0, ...episodes
    .filter((row) => watched.has(coordinate(row)))
    .map((row) => number(row.season, 0)));
  const firstSeason = maxWatchedSeason || seasonNumbers[0] || 1;
  const candidateSeasons = seasonNumbers.length
    ? [firstSeason, ...seasonNumbers.filter((season) => season > firstSeason)]
    : [firstSeason, firstSeason + 1];

  for (const seasonNumber of [...new Set(candidateSeasons)].slice(0, 3)) {
    const season = getCachedTmdbSeason({ tmdbId, tvdbId, seasonNumber });
    const seasonEpisodes = [...(season?.episodes || [])]
      .filter((episode) => number(episode.episode_number, 0) > 0)
      .sort((left, right) => number(left.episode_number) - number(right.episode_number));
    for (const episode of seasonEpisodes) {
      const episodeNumber = number(episode.episode_number, 0);
      const key = `${seasonNumber}:${episodeNumber}`;
      if (!released(episode.air_date, today) || watched.has(key)) continue;
      const trackedEpisode = episodes.find((row) => coordinate(row) === key) || null;
      const showIds = { tmdb: tmdbId, tvdb: tvdbId, imdb: show.imdb_id };
      const candidate = normalizeUpNextCandidate({
        queue_kind: "next_up",
        media_type: "episode",
        title: show.title,
        show_title: show.title,
        episode_title: episode.name || "",
        season: seasonNumber,
        episode: episodeNumber,
        show_ids: showIds,
        ids: episodeIdsFromTrackedEpisode(trackedEpisode || {}, showIds),
        provider_items: providerItemsFromTrackedEpisode(trackedEpisode || {}),
        show_latest_watched_at: show.latest_watched_at,
        poster_url: show.poster_url || metadata?.cached_poster_url
          || (metadata?.poster_path ? `/api/tmdb-poster?path=${encodeURIComponent(metadata.poster_path)}` : ""),
        air_date: episode.air_date || "",
        source: "local",
      });
      if (stateIsWatched(candidate, playstateIndex)) continue;
      if (progressCandidates.some((resume) => aliasesIntersect(aliasesFor(candidate), aliasesFor(resume)))) continue;
      // Local history and TMDB metadata can tell us what should come next, but
      // cannot prove that a guessed episode still exists in a configured media
      // server library. A matching provider observation already contributes
      // the authoritative card; otherwise require a native item id from a
      // trusted provider-history row before adding the fallback. This keeps a
      // real Reacher S03E04 visible while avoiding grey cards for TMDB-only
      // episodes that are not in any configured library.
      if (providerCandidates.some((providerCandidate) => providerObservationMatches(candidate, providerCandidate))) return null;
      if (!Object.keys(candidate.provider_items || {}).length) continue;
      return candidate;
    }
  }
  return null;
}

function queueShowKey(item = {}) {
  if (item.media_type !== "episode") return "";
  const title = normalizedTitle(
    showTitleFrom(item.show_title || showTitleFrom(item.title || "")).replace(/\(\d{4}\)/g, " "),
  );
  return title ? `title:${title}` : "";
}

function uncertainEpisodeQueueItem(item = {}) {
  return item.media_type === "episode"
    && (item.queue_kind === "next_up" || (item.queue_kind === "resume" && item.playback_position_known === false));
}

function furthestEpisode(left = {}, right = {}) {
  return Number(right.season || 0) - Number(left.season || 0)
    || Number(right.episode || 0) - Number(left.episode || 0)
    || Number(right.updated_at || 0) - Number(left.updated_at || 0)
    || String(left.id || "").localeCompare(String(right.id || ""));
}

function collapseUncertainEpisodeQueues(items = []) {
  const groups = new Map();
  const ungrouped = [];
  for (const item of Array.isArray(items) ? items : []) {
    const key = queueShowKey(item);
    if (!key) {
      ungrouped.push(item);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const collapsed = [...ungrouped];
  for (const rows of groups.values()) {
    const knownResume = rows.filter((row) => row.queue_kind === "resume" && row.playback_position_known !== false);
    const uncertain = rows.filter(uncertainEpisodeQueueItem);
    if (!knownResume.length && uncertain.length > 1) {
      const winner = [...uncertain].sort(furthestEpisode)[0];
      collapsed.push(...rows.filter((row) => !uncertain.includes(row)), winner);
    } else {
      collapsed.push(...rows);
    }
  }
  return sortUpNextItems(collapsed);
}

async function localNextUpCandidates({
  shows,
  playstateIndex,
  progressCandidates,
  providerCandidates = [],
  today,
}) {
  // Every show resolves against the same episode snapshot, so read and dedupe
  // the episode table once for the whole pass rather than once per show.
  const episodeRows = loadTrackedEpisodeRows();
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
        playstateIndex,
        progressCandidates,
        providerCandidates,
        episodeRows,
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
  const playstateIndex = buildPlaystateIndex(playstateRows || selectPlaystateRowsStmt.all());
  const observations = (providerItems || listActiveUpNextProviderItems()).slice(0, MAX_PROVIDER_OBSERVATIONS);
  const rawProviderCandidates = observations.map((item) => normalizeUpNextCandidate(item));
  const showRows = shows || ((localFallback || rawProviderCandidates.some((candidate) => candidate.queue_kind === "next_up"))
    ? await getCachedShows()
    : []);
  const showRecency = showRecencyIndex(showRows);
  const canonicalResume = rawProgressRows
    .map((row) => rowCandidate(row, { queueKind: "resume", canonical: true }))
    .map((candidate) => decorateShowRecency(candidate, showRecency))
    .filter(actionableResume)
    .filter((candidate) => !stateBlocksCandidate(candidate, playstateIndex, { progressUpdatedAt: candidate.updated_at }));
  const canonicalResumeAliases = canonicalResume.map(aliasesFor);

  const providerCandidates = rawProviderCandidates.map((candidate) => decorateShowRecency(candidate, showRecency));
  const providerResume = providerCandidates
    .filter((candidate) => candidate.queue_kind === "resume" && (actionableResume(candidate) || providerResumeMembership(candidate)))
    .filter((candidate) => !stateBlocksCandidate(candidate, playstateIndex, { progressUpdatedAt: candidate.updated_at }))
    .filter((candidate) => !stateIsWatched(candidate, playstateIndex));
  const providerNextUp = providerCandidates
    .filter((candidate) => candidate.queue_kind === "next_up" && released(candidate.air_date, new Date(now).toISOString().slice(0, 10)))
    .filter((candidate) => !stateIsWatched(candidate, playstateIndex))
    .filter((candidate) => !canonicalResumeAliases.some((aliases) => aliasesIntersect(aliases, aliasesFor(candidate))))
    .map((candidate) => ({ ...candidate, position_ms: 0, duration_ms: null, progress: 0 }));

  let localNextUp = [];
  if (localFallback) {
    localNextUp = await localNextUpCandidates({
      shows: showRows,
      playstateIndex,
      progressCandidates: canonicalResume,
      providerCandidates,
      today: new Date(now).toISOString().slice(0, 10),
    });
  }

  const merged = collapseUncertainEpisodeQueues(mergeUpNextCandidates([
    ...canonicalResume,
    ...providerResume,
    ...providerNextUp,
    ...localNextUp,
  ]));
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
