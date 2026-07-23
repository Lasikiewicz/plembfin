import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, sanitizeTitle, safeImageUrl, slug, showTitleFrom, episodeTitle, formatDate, formatTmdbDate, formatLongAiringDate, formatEpisodeAirtime, toDateInputValue, showEpisodeKey, episodeCode, seasonLabel, sourceBadgeHtml } from "./utils.js";
import { posterUrlFor, isCachedStorageImageUrl, tmdbImage, tmdbPoster, bestTmdbLogo, hydratePosters } from "./images.js";
import { isWatchedHistoryAction, renderSyncStatusDot } from "./sync.js";
import { mergeShowDetail, loadShowDetail, seasonsFromShowRecord, representativeEpisode, tmdbLookupIdsFromShow, syncInlineMediaDetailHeading } from "./explorer.js";
import { fetchTmdbDetails, fetchTmdbSeasonDetails } from "./tmdb.js?v=20260710";
import { renderWatchDatePrompt } from "./watch-action.js";
import { authHeaders, setMessage, mediaDetailRoot, mediaDetailLoaderHtml, setMediaDetailActions, prepareInlineMediaDetail, bumpMediaRenderToken } from "./media-detail-context.js";
import {
  renderCastSection, renderTrailersSection, renderReviewsSection, renderRelatedShowsSection,
  renderMediaFacts, renderMediaImagesSection, renderExternalRatingPills, ratingPillHtml,
  renderSeasonSeerrControls, renderSeerrRequestPill, fetchSeerrMediaStatus,
  refreshActiveMediaDetailAfterSeerrStatus, tvSeasonAvailabilityHtml, episodeResolutionPillHtml,
  hydrateMediaAppLinks,
} from "./media-detail-shared.js";

let _playbackProgressRows = [];
let _playbackProgressLoaded = false;
let _playbackProgressLoadPromise = null;
const _seasonDetailsInflight = new Set();

export async function openShowImmersiveModalByTitle(showTitle, seedEpisode = null, requestedSeason = null) {
  const normalizedTitle = showTitleFrom(showTitle);
  const showKey = slug(normalizedTitle);
  state.activeShowModalKey = showKey;
  state.activeShowModalSeason = requestedSeason;

  let show = state.showsRaw.find((entry) => slug(entry.title) === showKey);
  if (!show && seedEpisode) {
    show = {
      title: normalizedTitle,
      episode_count: 1,
      season_count: seedEpisode.season != null ? 1 : 0,
      latest_watched_at: seedEpisode.watched_at,
      earliest_watched_at: seedEpisode.watched_at,
      tmdb_id: seedEpisode.tmdb_id || null,
      episodes: [{ ...seedEpisode, show_title: normalizedTitle }],
    };
    state.showsRaw.push(show);
    if (state.mediaDetailInline) {
      await openShowInlineDetail(slug(show.title), requestedSeason);
    } else {
      await renderImmersiveShowModal(slug(show.title), requestedSeason);
    }
    return;
  }

  if (!state.mediaDetailInline) {
    elements.debugModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    const modalPanel = elements.debugModal.querySelector(".modal-panel");
    if (modalPanel) {
      modalPanel.classList.add("modal-panel--immersive");
    }
  }

  const root = mediaDetailRoot();
  root.innerHTML = `
    <div class="immersive-container">
      ${!state.mediaDetailInline ? '<button class="immersive-back-button" type="button">&larr; Back</button>' : ''}
      ${mediaDetailLoaderHtml("Loading show details")}
    </div>
  `;

  try {
    const response = await fetch(`/api/show?title=${encodeURIComponent(normalizedTitle)}`, { headers: authHeaders() });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.show) {
      mergeShowDetail(body.show);
      show = body.show;
    }
  } catch (error) {
    console.error("Failed to fetch show details by title", error);
  }

  const isModalOpen = state.mediaDetailInline || !elements.debugModal.classList.contains("hidden");
  if (show && state.activeShowModalKey === showKey && isModalOpen) {
    if (state.mediaDetailInline) {
      await openShowInlineDetail(slug(show.title), requestedSeason || state.activeShowModalSeason);
    } else {
      await renderImmersiveShowModal(slug(show.title), requestedSeason || state.activeShowModalSeason);
    }
  } else if (!show && state.activeShowModalKey === showKey && isModalOpen) {
    root.innerHTML = `
      <div class="immersive-container">
        ${!state.mediaDetailInline ? '<button class="immersive-back-button" type="button">&larr; Back</button>' : ''}
        <div style="display: flex; justify-content: center; align-items: center; min-height: 200px; flex-direction: column; gap: var(--space-2);">
          <span style="color: var(--danger); font-size: 1.1rem; font-weight: bold;">Show not found</span>
          <span style="color: var(--muted); font-size: 0.9rem;">Could not locate this TV series in the archive.</span>
        </div>
      </div>
    `;
  }
}

export async function openShowInlineDetail(showKey, activeSeasonNum = null, activeEpisodeNum = null) {
  prepareInlineMediaDetail("shows");
  await renderImmersiveShowModal(showKey, activeSeasonNum, activeEpisodeNum);
}

async function fetchShowImdbPillHtml(show = {}, tmdbData = null, requestStillCurrent = () => true) {
  const showImdbId = show.imdb_id || tmdbData?.external_ids?.imdb_id || "";
  if (!showImdbId) return "";
  const fallbackPill = () => ratingPillHtml({
    label: "IMDb",
    value: "",
    href: `https://www.imdb.com/title/${escapeAttribute(showImdbId)}`,
    title: "Open this title on IMDb",
  });
  if (!state.savedConfig?.omdb?.configured) return fallbackPill();

  const omdbRes = await fetch(`/api/omdb-rating?imdbId=${encodeURIComponent(showImdbId)}`, { headers: authHeaders() }).catch(() => null);
  if (!requestStillCurrent()) return "";
  if (!omdbRes?.ok) return fallbackPill();

  const omdbData = await omdbRes.json().catch(() => null);
  if (!requestStillCurrent()) return "";
  if (!omdbData?.imdbRating) return fallbackPill();

  return ratingPillHtml({
    label: "IMDb",
    value: `${Math.round(parseFloat(omdbData.imdbRating) * 10)}%`,
    href: `https://www.imdb.com/title/${escapeAttribute(showImdbId)}`,
    title: `IMDb rating: ${omdbData.imdbRating}/10`,
  });
}

export async function openShowImmersiveModalByTmdbId(tmdbId) {
  setMediaDetailActions("");
  state.activeShowTmdbId = String(tmdbId);
  syncInlineMediaDetailHeading("shows");
  if (!state.mediaDetailInline) {
    elements.debugModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    const modalPanel = elements.debugModal.querySelector(".modal-panel");
    if (modalPanel) {
      modalPanel.classList.add("modal-panel--immersive");
    }
  }
  const root = mediaDetailRoot();
  root.innerHTML = `
    <div class="immersive-container">
      ${mediaDetailLoaderHtml("Loading TV show details")}
    </div>
  `;

  let tmdbData = await fetchTmdbDetails("tv", tmdbId, null);
  if (!tmdbData) {
    // The stored TMDB ID may not map to a valid show (e.g. episode-level ID from
    // Plex, or a show not yet indexed). Fall back to a title search using the
    // matching now-playing session title so first-watch shows still load.
    const matchingSession = state.activeSessions.find(
      (s) => String(s.ids?.tmdb || "") === String(tmdbId)
    );
    if (matchingSession) {
      const fallbackTitle = showTitleFrom(
        matchingSession.showTitle || matchingSession.show_title || matchingSession.title || ""
      );
      if (fallbackTitle) tmdbData = await fetchTmdbDetails("tv", null, fallbackTitle);
    }
  }
  if (!tmdbData) {
    root.innerHTML = `
      <div class="immersive-container">
        <div style="display: flex; justify-content: center; align-items: center; min-height: 200px; flex-direction: column; gap: var(--space-2);">
          <span style="color: var(--danger); font-size: 1.1rem; font-weight: bold;">Could not load TV show details</span>
          <span style="color: var(--muted); font-size: 0.9rem;">Please check your TMDB API Key in Settings.</span>
        </div>
      </div>
    `;
    return;
  }
  if (tmdbData?.id) state.activeShowTmdbId = String(tmdbData.id);

  const showTitle = tmdbData.name || "Untitled TV Show";
  const seasons = [...(tmdbData.seasons || [])]
    .filter((season) => Number(season.season_number) > 0)
    .sort((a, b) => Number(b.season_number) - Number(a.season_number));

  const seasonDetailsByNumber = new Map();
  await Promise.all([
    // Pull persisted watched state from the server so a fresh page load — where
    // state.showsRaw/state.history aren't populated yet — still reflects what is
    // already marked watched (otherwise the show looks unwatched after a refresh).
    loadShowDetail({ title: showTitle }).catch(() => null),
    ensurePlaybackProgressLoaded(),
    ...seasons.map(async (season) => {
      const seasonNumber = Number(season.season_number);
      const details = await fetchTmdbSeasonDetails(tmdbData.id, seasonNumber);
      if (details) seasonDetailsByNumber.set(seasonNumber, details);
    }),
  ]);

  const existingShow = state.showsRaw.find((show) => (
    String(show.tmdb_id || "") === String(tmdbData.id) || slug(show.title) === slug(showTitle)
  ));
  const show = mergeShowWithLoadedHistory(existingShow || {
    title: showTitle,
    tmdb_id: String(tmdbData.id),
    episodes: [],
    episode_count: 0,
    season_count: seasons.length,
  });
  const imdbPillHtml = await fetchShowImdbPillHtml(show, tmdbData, () => String(state.activeShowTmdbId || "") === String(tmdbData.id));

  renderShowModalContent(show, {
    activeSeasonNum: state.activeShowModalSeason,
    tmdbData,
    seasonDetailsByNumber,
    loading: false,
    tmdbOnly: !existingShow,
    imdbPillHtml,
  });
}

function watchedEpisodesByKey(show = {}) {
  const map = new Map();
  for (const episode of show.episodes || []) {
    if (!isWatchedHistoryAction(episode)) continue;
    map.set(showEpisodeKey(episode.season, episode.episode), episode);
  }
  return map;
}

function watchedEpisodeFor(watchedMap, seasonNumber, episodeNumber) {
  const exact = watchedMap.get(showEpisodeKey(seasonNumber, episodeNumber));
  if (exact) return exact;
  if (Number(seasonNumber) === 0) {
    return watchedMap.get(showEpisodeKey(null, episodeNumber)) || null;
  }
  return null;
}

function playbackProgressTitle(row = {}) {
  return showTitleFrom(row.show_title || row.grandparent_title || row.series_title || row.title || "");
}

function playbackProgressMatchesShow(row = {}, showTitle = "", resolvedTmdbId = "") {
  if (String(row.media_type || "").toLowerCase() !== "episode") return false;
  if (row.season == null || row.episode == null) return false;
  if (resolvedTmdbId && String(row.tmdb_id || "") === String(resolvedTmdbId)) return true;
  return slug(playbackProgressTitle(row)) === slug(showTitle);
}

function playbackProgressByEpisode(show = {}, resolvedTmdbId = "") {
  const map = new Map();
  const showTitle = show.title || "";
  for (const row of [...(state.partWatchedRaw || []), ..._playbackProgressRows]) {
    if (!playbackProgressMatchesShow(row, showTitle, resolvedTmdbId || show.tmdb_id || "")) continue;
    const progress = Number(row.progress || 0);
    if (!Number.isFinite(progress) || progress <= 0) continue;
    const key = showEpisodeKey(row.season, row.episode);
    const existing = map.get(key);
    if (!existing || Number(row.updated_at || 0) >= Number(existing.updated_at || 0)) {
      map.set(key, { ...row, progress: Math.max(0, Math.min(100, progress)) });
    }
  }
  return map;
}

async function ensurePlaybackProgressLoaded() {
  if (_playbackProgressLoaded || _playbackProgressLoadPromise) return _playbackProgressLoadPromise;
  _playbackProgressLoadPromise = fetch("/api/playback-progress?limit=100", { headers: authHeaders(), cache: "no-store" })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      _playbackProgressRows = Array.isArray(body.progress) ? body.progress : [];
      _playbackProgressLoaded = true;
      return _playbackProgressRows;
    })
    .catch((error) => {
      console.error("Failed to load playback progress for media detail", error);
      return _playbackProgressRows;
    })
    .finally(() => {
      _playbackProgressLoadPromise = null;
    });
  return _playbackProgressLoadPromise;
}

function hydrateMissingSeasonDetails(show, activeSeasonNum, tmdbData, seasonDetailsByNumber, loading) {
  if (loading || !tmdbData?.id || activeSeasonNum == null) return;
  const seasonNumber = Number(activeSeasonNum);
  if (!Number.isFinite(seasonNumber) || seasonDetailsByNumber.has(seasonNumber)) return;
  const cacheKey = `${tmdbData.id}|${seasonNumber}`;
  if (_seasonDetailsInflight.has(cacheKey)) return;

  _seasonDetailsInflight.add(cacheKey);
  fetchTmdbSeasonDetails(tmdbData.id, seasonNumber)
    .then((details) => {
      if (!details) return;
      seasonDetailsByNumber.set(seasonNumber, details);
      const current = state.activeShowRenderContext;
      const currentTmdbId = current?.tmdbData?.id || tmdbData.id;
      if (Number(state.activeShowModalSeason) !== seasonNumber || String(currentTmdbId) !== String(tmdbData.id)) return;
      renderShowModalContent(current?.show || show, {
        ...current,
        activeSeasonNum: seasonNumber,
        tmdbData,
        seasonDetailsByNumber,
        loading: false,
      });
    })
    .catch((error) => console.error("Failed to hydrate season episode thumbnails", error))
    .finally(() => _seasonDetailsInflight.delete(cacheKey));
}

function hydrateAllSeasonEpisodeDetails(show, tmdbData, seasonDetailsByNumber, loading, seasonsList = []) {
  if (loading || !tmdbData?.id || !seasonsList.length) return;
  const requests = [];
  const cacheKeys = [];

  for (const season of seasonsList) {
    const seasonNumber = Number(season.season_number);
    if (!Number.isFinite(seasonNumber) || seasonDetailsByNumber.has(seasonNumber)) continue;

    const cacheKey = `${tmdbData.id}|${seasonNumber}`;
    if (_seasonDetailsInflight.has(cacheKey)) continue;

    _seasonDetailsInflight.add(cacheKey);
    cacheKeys.push(cacheKey);
    requests.push(
      fetchTmdbSeasonDetails(tmdbData.id, seasonNumber)
        .then((details) => ({ seasonNumber, details }))
        .catch((error) => {
          console.error(`Failed to hydrate season ${seasonNumber} episodes`, error);
          return { seasonNumber, details: null };
        })
    );
  }

  if (!requests.length) return;

  Promise.all(requests)
    .then((results) => {
      let changed = false;
      for (const { seasonNumber, details } of results) {
        if (!details) continue;
        seasonDetailsByNumber.set(Number(seasonNumber), details);
        changed = true;
      }
      const current = state.activeShowRenderContext;
      const currentTmdbId = current?.tmdbData?.id || tmdbData.id;
      if (!changed || !state.showModalAllSeasonsExpanded || String(currentTmdbId) !== String(tmdbData.id)) return;
      renderShowModalContent(current?.show || show, {
        ...current,
        activeSeasonNum: state.activeShowModalSeason,
        tmdbData,
        seasonDetailsByNumber,
        loading: false,
      });
    })
    .catch((error) => console.error("Failed to hydrate all season episodes", error))
    .finally(() => {
      for (const cacheKey of cacheKeys) _seasonDetailsInflight.delete(cacheKey);
    });
}

function hydrateUnknownSeasonSummaryDetails(show, tmdbData, seasonDetailsByNumber, loading, seasonsList = []) {
  if (loading || !tmdbData?.id || !seasonsList.length) return;
  const requests = [];
  const cacheKeys = [];

  for (const season of seasonsList) {
    const seasonNumber = Number(season.season_number);
    if (!Number.isFinite(seasonNumber) || seasonNumber <= 0) continue;
    if (Number(season.episode_count || 0) > 0 || seasonDetailsByNumber.has(seasonNumber)) continue;

    const cacheKey = `${tmdbData.id}|${seasonNumber}`;
    if (_seasonDetailsInflight.has(cacheKey)) continue;

    _seasonDetailsInflight.add(cacheKey);
    cacheKeys.push(cacheKey);
    requests.push(
      fetchTmdbSeasonDetails(tmdbData.id, seasonNumber)
        .then((details) => ({ seasonNumber, details }))
        .catch((error) => {
          console.error(`Failed to hydrate season ${seasonNumber} summary`, error);
          return { seasonNumber, details: null };
        })
    );
  }

  if (!requests.length) return;

  Promise.all(requests)
    .then((results) => {
      let changed = false;
      for (const { seasonNumber, details } of results) {
        if (!details) continue;
        seasonDetailsByNumber.set(Number(seasonNumber), details);
        changed = true;
      }
      const current = state.activeShowRenderContext;
      const currentTmdbId = current?.tmdbData?.id || tmdbData.id;
      if (!changed || String(currentTmdbId) !== String(tmdbData.id)) return;
      renderShowModalContent(current?.show || show, {
        ...current,
        activeSeasonNum: state.activeShowModalSeason,
        tmdbData,
        seasonDetailsByNumber,
        loading: false,
      });
    })
    .catch((error) => console.error("Failed to refresh season summaries", error))
    .finally(() => {
      for (const cacheKey of cacheKeys) _seasonDetailsInflight.delete(cacheKey);
    });
}

function buildShowEpisodeRows(show, seasonsList, seasonDetailsByNumber, resolvedTmdbId = "", tmdbData = null) {
  const watchedMap = watchedEpisodesByKey(show);
  const progressMap = playbackProgressByEpisode(show, resolvedTmdbId);
  const localSeasons = seasonsFromShowRecord(show);
  const rows = [];

  const knownNextEpisodes = new Map();
  for (const ep of [tmdbData?.next_episode_to_air, tmdbData?.last_episode_to_air]) {
    if (ep?.season_number != null && ep?.episode_number != null) {
      knownNextEpisodes.set(showEpisodeKey(Number(ep.season_number), Number(ep.episode_number)), ep);
    }
  }

  // Specials (season 0) are excluded from progress totals further down (via the
  // `> 0` filters on regularSeasonsList/regularEpisodeRows), but still need their
  // own episode rows built here so the Specials accordion has something to show.
  for (const season of seasonsList) {
    const seasonNumber = Number(season.season_number);
    const tmdbSeason = seasonDetailsByNumber.get(seasonNumber);
    const tmdbEpisodes = Array.isArray(tmdbSeason?.episodes) ? tmdbSeason.episodes : [];
    const fallbackPosterUrl = (/^https?:\/\//i.test(season.poster_path || "") ? season.poster_path : tmdbPoster(season.poster_path)) || posterUrlFor(representativeEpisode(localSeasons));

    if (tmdbEpisodes.length) {
      const knownEpNums = new Set();
      for (const episode of tmdbEpisodes) {
        const episodeNumber = Number(episode.episode_number);
        knownEpNums.add(episodeNumber);
        const watched = watchedEpisodeFor(watchedMap, seasonNumber, episodeNumber);
        rows.push({
          key: showEpisodeKey(seasonNumber, episodeNumber),
          showTitle: show.title,
          showTmdbId: resolvedTmdbId || show.tmdb_id || "",
          seasonNumber,
          episodeNumber,
          title: episode.name || episodeTitle(watched?.title, episodeNumber),
          overview: episode.overview || "No synopsis available.",
          airDate: episode.air_date || "",
          airTime: episode.air_time || episode.airTime || episode.airtime || "",
          stillUrl: tmdbImage(episode.still_path, "w300"),
          posterUrl: fallbackPosterUrl,
          watched,
          progress: progressMap.get(showEpisodeKey(seasonNumber, episodeNumber)) || null,
        });
      }

      const totalEpCount = Number(season.episode_count || 0);
      for (let epNum = 1; epNum <= totalEpCount; epNum++) {
        if (knownEpNums.has(epNum)) continue;
        const key = showEpisodeKey(seasonNumber, epNum);
        const hint = knownNextEpisodes.get(key);
        rows.push({
          key,
          showTitle: show.title,
          showTmdbId: resolvedTmdbId || show.tmdb_id || "",
          seasonNumber,
          episodeNumber: epNum,
          title: hint?.name || episodeTitle(null, epNum),
          overview: hint?.overview || "No synopsis available.",
          airDate: hint?.air_date || "",
          airTime: hint?.air_time || hint?.airTime || hint?.airtime || "",
          stillUrl: hint ? tmdbImage(hint.still_path, "w300") : "",
          posterUrl: fallbackPosterUrl,
          watched: null,
          progress: progressMap.get(key) || null,
        });
      }

      continue;
    }

    for (const watched of localSeasons.get(seasonNumber) || []) {
      const episodeNumber = Number(watched.episode);
      rows.push({
        key: showEpisodeKey(seasonNumber, episodeNumber),
        showTitle: show.title,
        showTmdbId: resolvedTmdbId || show.tmdb_id || "",
        seasonNumber,
        episodeNumber,
        title: episodeTitle(watched.title, episodeNumber),
        overview: "TMDB metadata is still loading.",
        airDate: "",
        airTime: "",
        stillUrl: "",
        posterUrl: fallbackPosterUrl,
        watched,
        progress: progressMap.get(showEpisodeKey(seasonNumber, episodeNumber)) || null,
      });
    }
  }

  return rows.sort((a, b) => b.seasonNumber - a.seasonNumber || b.episodeNumber - a.episodeNumber);
}

function episodeThumbMarkup(episode) {
  const stillUrl = safeImageUrl(episode.stillUrl);
  const posterUrl = safeImageUrl(episode.posterUrl) || episode.posterUrl || "";
  const url = stillUrl || posterUrl;
  if (!url) return `<span class="episode-thumb poster-fallback" aria-hidden="true"></span>`;
  const onerrorAttr = stillUrl && posterUrl && stillUrl !== posterUrl
    ? ` onerror="this.onerror=null;this.src=this.dataset.fallback" data-fallback="${escapeAttribute(posterUrl)}"`
    : "";
  return `<img class="episode-thumb" src="${escapeAttribute(url)}" alt="${escapeAttribute(episode.title)} thumbnail" loading="lazy" decoding="async" referrerpolicy="no-referrer"${onerrorAttr} />`;
}

function episodeReleaseLabel(airDate) {
  return airDate ? `Released ${formatTmdbDate(airDate)}` : "Release date unknown";
}

// Full watch history list (each play's date + source app) shown in place of
// the single "Watched on ..." line once an episode has more than one
// recorded watch — see playHistory ({ id, watched_at, source }[]) built
// server-side in dedupeHistory (server/src/utils/dataRepo.js).
function episodeWatchHistoryHtml(watched) {
  const history = Array.isArray(watched?.playHistory) ? watched.playHistory : [];
  if (history.length < 2) return "";
  const rows = [...history]
    .sort((a, b) => String(b.watched_at).localeCompare(String(a.watched_at)))
    .map((entry) => `
      <li class="episode-watch-history-row">
        <span class="episode-watch-history-date">${escapeHtml(formatDate(entry.watched_at))}</span>
        ${sourceBadgeHtml(entry.source)}
      </li>
    `)
    .join("");
  return `
    <div class="episode-watch-history">
      <div class="episode-watch-history-head">
        <span class="rewatch-badge" title="Watched ${history.length} times">&#8635; Watch History &times;${history.length}</span>
        <button class="edit-date-icon-btn episode-edit-date-btn" type="button" title="Edit watch dates" data-edit-id="${escapeAttribute(watched.id)}" data-watched-at="${escapeAttribute(watched.watched_at || "")}">✎</button>
      </div>
      <ul class="episode-watch-history-list">${rows}</ul>
    </div>
  `;
}

function episodeProgressHtml(episode) {
  if (episode.watched || !episode.progress) return "";
  const progressPercent = Math.max(0, Math.min(100, Math.round(Number(episode.progress.progress || 0))));
  if (!progressPercent) return "";
  return `
    <span class="episode-progress-badge" title="${escapeAttribute(`${progressPercent}% watched`)}">
      <span>Part watched</span>
      <small>${progressPercent}%</small>
    </span>
  `;
}

function episodeProgressBarHtml(episode) {
  if (episode.watched || !episode.progress) return "";
  const progressPercent = Math.max(0, Math.min(100, Math.round(Number(episode.progress.progress || 0))));
  if (!progressPercent) return "";
  return `
    <div class="episode-progress-inline" aria-label="${escapeAttribute(`${progressPercent}% watched`)}">
      <div class="episode-progress-track">
        <div class="episode-progress-fill" style="width: ${progressPercent}%;"></div>
      </div>
      <span>${progressPercent}% watched</span>
    </div>
  `;
}

function showModalStatus(loading, hasTmdbData) {
  if (loading) return `<span class="show-load-pill">Loading episode metadata...</span>`;
  if (!hasTmdbData) return `<span class="show-load-pill muted">Season and episode metadata was unavailable.</span>`;
  return "";
}

function seasonEpisodeTotal(seasonNumber, seasonEpisodes, season, seasonDetailsByNumber) {
  const tmdbSeason = seasonDetailsByNumber?.get(Number(seasonNumber));
  const tmdbEpisodeCount = Array.isArray(tmdbSeason?.episodes) ? tmdbSeason.episodes.length : 0;
  return Math.max(seasonEpisodes.length, tmdbEpisodeCount, Number(season.episode_count || 0));
}

function showSeasonSummary(seasonNumber, seasonEpisodes, season, showTitle = "", tmdbData = null, seasonDetailsByNumber = null) {
  const watchedInSeason = seasonEpisodes.filter((episode) => episode.watched).length;
  const seasonTotal = seasonEpisodeTotal(seasonNumber, seasonEpisodes, season, seasonDetailsByNumber);
  const today = toDateInputValue(new Date());
  let nextAiring = seasonEpisodes
    .filter((episode) => !episode.watched && episode.airDate && episode.airDate >= today)
    .sort((a, b) => a.airDate.localeCompare(b.airDate) || Number(a.episodeNumber || 0) - Number(b.episodeNumber || 0))[0] || null;
  const tmdbNextEpisode = tmdbData?.next_episode_to_air;
  if (
    !nextAiring &&
    tmdbNextEpisode?.air_date &&
    tmdbNextEpisode.air_date >= today &&
    Number(tmdbNextEpisode.season_number) === Number(seasonNumber)
  ) {
    nextAiring = {
      airDate: tmdbNextEpisode.air_date,
      airTime: tmdbNextEpisode.air_time || tmdbNextEpisode.airTime || tmdbNextEpisode.airtime || "",
      episodeNumber: tmdbNextEpisode.episode_number,
    };
  }
  const nextAiringText = nextAiring
    ? `Next Airing ${formatLongAiringDate(nextAiring.airDate)} (${formatEpisodeAirtime(nextAiring, showTitle)})`
    : "";
  return { watchedInSeason, seasonTotal, nextAiring, nextAiringText };
}

function renderSeasonPanelHtml(seasonNumber, seasonRecord, episodeRows, showTitle, tmdbData, seasonDetailsByNumber, tvSeerrTmdbId, tvSeerrStatus, isSaving, isUnreleased, loading) {
  if (!seasonRecord) return "";
  const seasonEpisodes = episodeRows
    .filter((episode) => episode.seasonNumber === seasonNumber)
    .sort((a, b) => Number(a.episodeNumber || 0) - Number(b.episodeNumber || 0));
  const seasonUnwatched = seasonEpisodes.filter((episode) => !episode.watched && !isUnreleased(episode));
  const seasonSummary = showSeasonSummary(seasonNumber, seasonEpisodes, seasonRecord, showTitle, tmdbData, seasonDetailsByNumber);
  const seasonSeerrControls = renderSeasonSeerrControls(tvSeerrTmdbId, seasonNumber, tvSeerrStatus);
  return `
    <section class="show-season-block" id="showSeason${seasonNumber}">
      <div class="show-season-head">
        <span class="show-season-label">${seasonSummary.watchedInSeason} of ${seasonSummary.seasonTotal || "?"} episodes watched</span>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          ${seasonSeerrControls}
          ${seasonSummary.watchedInSeason ? `<button class="action-pill" type="button" data-edit-season-date="${seasonNumber}" ${isSaving ? "disabled" : ""}>Edit season date</button>` : ""}
          <button class="action-pill" type="button" data-watch-scope="season" data-season-number="${seasonNumber}" ${(seasonUnwatched.length && !isSaving) ? "" : "disabled"}>
            ${isSaving && isSaving.scope === "season" && Number(isSaving.episodes[0]?.seasonNumber) === Number(seasonNumber) ? "Saving…" : "Mark season watched"}
          </button>
        </div>
      </div>
      <div class="show-episode-list">
        ${seasonEpisodes.length ? seasonEpisodes.map((episode) => {
    const isHighlighted = (Number(episode.seasonNumber) === Number(seasonNumber)) && (Number(episode.episodeNumber) === Number(state.activeShowModalEpisode));
    const syncStatusDotHtml = episode.watched ? renderSyncStatusDot(episode.watched) : "";
    const episodeIsUnreleased = isUnreleased(episode);
    const playHistory = Array.isArray(episode.watched?.playHistory) ? episode.watched.playHistory : [];
    const hasWatchHistory = playHistory.length > 1;
    return `
            <article class="immersive-episode-row ${episode.watched ? "is-watched" : ""} ${episodeIsUnreleased ? "is-unreleased" : ""} ${isHighlighted ? "is-highlighted" : ""}" ${isHighlighted ? 'id="highlightedEpisode"' : ""} data-immersive-episode-num="${episode.episodeNumber}" data-immersive-season-num="${episode.seasonNumber}">
              ${episodeThumbMarkup(episode)}
              <div class="immersive-episode-copy">
                <div class="immersive-episode-title-row">
                  <b style="display: inline-flex; align-items: center; gap: 0.35rem;">
                    ${escapeHtml(episodeCode(episode.seasonNumber, episode.episodeNumber))} ${escapeHtml(episode.title)}
                    ${syncStatusDotHtml}
                    ${episodeProgressHtml(episode)}
                    ${episodeResolutionPillHtml(tvSeerrStatus, episode.seasonNumber, episode.episodeNumber)}
                  </b>
                </div>
                <div class="immersive-episode-copy-wrap"><p>${escapeHtml(episode.overview)}</p></div>
                ${episodeProgressBarHtml(episode)}
                <div class="immersive-episode-meta-row">
                  <span class="immersive-episode-dates">
                    <time datetime="${escapeAttribute(episode.airDate || "")}">${escapeHtml(episodeReleaseLabel(episode.airDate))}</time>
                    ${episode.watched && !hasWatchHistory ? `<time>Watched ${formatDate(episode.watched.watched_at)} <button class="edit-date-icon-btn episode-edit-date-btn" type="button" title="Edit watch date" data-edit-id="${escapeAttribute(episode.watched.id)}" data-watched-at="${escapeAttribute(episode.watched.watched_at || "")}">✎</button></time>` : ""}
                  </span>
                  <span class="immersive-episode-actions">
                    ${episodeIsUnreleased
        ? `<span class="unreleased-pill">Not yet released</span>`
        : !episode.watched
          ? `<button class="action-pill" type="button" data-watch-scope="episode" data-episode-key="${escapeAttribute(episode.key)}" ${isSaving ? "disabled" : ""}>
                            ${isSaving && isSaving.scope === "episode" && isSaving.episodes[0]?.key === episode.key ? "Saving…" : "Mark watched"}
                           </button>`
          : `<button class="action-pill action-pill-ghost" type="button" ${isSaving ? "disabled" : ""} data-unwatch-id="${escapeAttribute(episode.watched.id)}" data-unwatch-kind="episode" data-unwatch-label="${escapeAttribute(`${episodeCode(episode.seasonNumber, episode.episodeNumber)} ${episode.title}`)}" data-show-title="${escapeAttribute(episode.showTitle || showTitle)}">Mark unwatched</button>`}
                  </span>
                </div>
                ${hasWatchHistory ? episodeWatchHistoryHtml(episode.watched) : ""}
              </div>
            </article>
          `;
  }).join("") : `<div class="empty-log"><b>No episode rows yet</b><span>${loading ? "Episode metadata is loading." : "No local or TVDB episodes were found for this season."}</span></div>`}
      </div>
    </section>
  `;
}

export function renderShowModalContent(show, {
  activeSeasonNum = null,
  tmdbData = null,
  seasonDetailsByNumber = new Map(),
  loading = false,
  tmdbOnly = false,
  imdbPillHtml = "",
} = {}) {
  const root = mediaDetailRoot();
  const isSaving = state.savingWatchAction;
  const isSavingShow = isSaving && isSaving.scope === "show";
  show = mergeShowWithLoadedHistory(show);
  const seasonsMap = seasonsFromShowRecord(show);
  const showTitle = sanitizeTitle(show.title) || "Unknown Show";
  // Specials (season 0) are kept in the list so they're still browsable, but
  // are excluded from the progress totals below — a "100 of 100" show isn't
  // meant to imply specials don't exist, just that they don't count toward it.
  const seasonsList = [...(tmdbData?.seasons?.length ? tmdbData.seasons : fallbackSeasonList(seasonsMap))]
    .sort((a, b) => Number(b.season_number) - Number(a.season_number));
  const regularSeasonsList = seasonsList.filter((season) => Number(season.season_number) > 0);
  const selectedSeason = activeSeasonNum == null ? null : Number(activeSeasonNum);
  const episodeRows = buildShowEpisodeRows(show, seasonsList, seasonDetailsByNumber, tmdbData?.id || show.tmdb_id || "", tmdbData);
  const regularEpisodeRows = episodeRows.filter((episode) => Number(episode.seasonNumber) > 0);
  const watchedRows = regularEpisodeRows.filter((episode) => episode.watched);
  const metadataEpisodeCount = regularSeasonsList.reduce((total, season) => total + Number(season.episode_count || 0), 0);
  const totalCount = Math.max(regularEpisodeRows.length, metadataEpisodeCount, watchedRows.length, 1);
  const watchedCount = watchedRows.length || [...watchedEpisodesByKey(show).keys()].length;
  const progressPercent = Math.max(0, Math.min(100, Math.round((watchedCount / totalCount) * 100)));
  const representative = representativeEpisode(seasonsMap);
  const backdropUrl = show.backdrop_url || tmdbData?.cached_backdrop_url || tmdbImage(tmdbData?.backdrop_path, "original");
  const posterUrl = posterUrlFor(representative)
    || (isCachedStorageImageUrl(show.poster_url) ? show.poster_url : "")
    || tmdbData?.cached_poster_url
    || tmdbPoster(tmdbData?.poster_path, tmdbData?.id, "tv");
  const logoUrl = show.logo_url || bestTmdbLogo(tmdbData);
  const overview = tmdbData?.overview || "No synopsis available.";
  const premiered = tmdbData?.first_air_date ? `Premiered ${formatTmdbDate(tmdbData.first_air_date)}` : "Release date unknown";
  const rating = tmdbData?.vote_average ? `${Math.round(tmdbData.vote_average * 10)}%` : "";
  const ratingPillsHtml = renderExternalRatingPills("tv", tmdbData, showTitle, rating);
  const tvSeerrTmdbId = tmdbData?.id || show.tmdb_id || "";
  const tvSeerrCacheKey = `tv:${tvSeerrTmdbId}`;
  const hasTvSeerrStatus = Boolean(tvSeerrTmdbId && state.seerrMediaStatusCache.has(tvSeerrCacheKey));
  const tvSeerrStatus = state.seerrMediaStatusCache.get(tvSeerrCacheKey) || {};
  const showIsNowPlaying = state.activeSessions.some((s) => {
    if (tvSeerrTmdbId && String(s.ids?.tmdb || "") === String(tvSeerrTmdbId)) return true;
    const sessionShowTitle = showTitleFrom(s.showTitle || s.show_title || s.title || "");
    return Boolean(sessionShowTitle && slug(sessionShowTitle) === slug(showTitle));
  });

  state.showModalEpisodes = episodeRows;
  state.showModalEpisodeIndex = new Map(episodeRows.map((episode) => [episode.key, episode]));
  state.activeShowRenderContext = { show, activeSeasonNum, tmdbData, seasonDetailsByNumber, loading, imdbPillHtml };

  const allSeasonsExpanded = state.showModalAllSeasonsExpanded;
  const selectedSeasonRecord = selectedSeason == null
    ? null
    : seasonsList.find((season) => Number(season.season_number) === selectedSeason) || { season_number: selectedSeason };
  const selectedSeasonNumber = selectedSeasonRecord ? Number(selectedSeasonRecord.season_number) : null;
  const isUnreleased = (episode) => {
    if (episode.watched) return false;
    if (!episode.airDate) return false;
    const parts = episode.airDate.split("-");
    if (parts.length !== 3) return false;
    const air = new Date(parts[0], parts[1] - 1, parts[2]);
    return !Number.isNaN(air.getTime()) && air > new Date();
  };
  const unwatchedRows = episodeRows.filter((episode) => !episode.watched && !isUnreleased(episode));

  // Normally only the selected season's episode list is built/rendered — the
  // rest stay collapsed and unbuilt. "Expand all" (state.showModalAllSeasonsExpanded)
  // builds a panel for every season instead, so the accordion below can render
  // them all open at once.
  const seasonPanelsByNumber = new Map();
  if (allSeasonsExpanded) {
    for (const season of seasonsList) {
      const seasonNumber = Number(season.season_number);
      seasonPanelsByNumber.set(seasonNumber, renderSeasonPanelHtml(seasonNumber, season, episodeRows, showTitle, tmdbData, seasonDetailsByNumber, tvSeerrTmdbId, tvSeerrStatus, isSaving, isUnreleased, loading));
    }
  } else if (selectedSeasonRecord) {
    seasonPanelsByNumber.set(selectedSeasonNumber, renderSeasonPanelHtml(selectedSeasonNumber, selectedSeasonRecord, episodeRows, showTitle, tmdbData, seasonDetailsByNumber, tvSeerrTmdbId, tvSeerrStatus, isSaving, isUnreleased, loading));
  }

  if (allSeasonsExpanded) {
    hydrateAllSeasonEpisodeDetails(show, tmdbData, seasonDetailsByNumber, loading, seasonsList);
  } else {
    hydrateMissingSeasonDetails(show, selectedSeasonNumber, tmdbData, seasonDetailsByNumber, loading);
  }
  hydrateUnknownSeasonSummaryDetails(show, tmdbData, seasonDetailsByNumber, loading, seasonsList);

  const seasonsAccordionHtml = seasonsList.map((season) => {
    const seasonNumber = Number(season.season_number);
    const seasonEpisodes = episodeRows.filter((episode) => episode.seasonNumber === seasonNumber);
    const { watchedInSeason, seasonTotal, nextAiringText } = showSeasonSummary(seasonNumber, seasonEpisodes, season, showTitle, tmdbData, seasonDetailsByNumber);
    const isActive = allSeasonsExpanded || seasonNumber === selectedSeasonNumber;
    const panelId = `seasonAccordionPanel${seasonNumber}`;
    const episodeCountText = `${seasonTotal || "?"} episode${seasonTotal === 1 ? "" : "s"}`;
    const watchedText = watchedInSeason ? `${watchedInSeason} watched` : "";
    const seasonAvailabilityHtml = tvSeasonAvailabilityHtml(tvSeerrStatus, seasonNumber, watchedInSeason);
    return `
      <article class="season-accordion ${isActive ? "is-open" : ""}">
        <button class="season-accordion-trigger" type="button" data-season-accordion="${seasonNumber}" aria-expanded="${isActive}" aria-controls="${panelId}">
          <span class="season-row-title"><strong>${escapeHtml(season.name || seasonLabel(seasonNumber))}</strong></span>
          <span class="season-row-col season-row-episodes">${escapeHtml(episodeCountText)}</span>
          <span class="season-row-col season-row-watched">${escapeHtml(watchedText)}</span>
          <span class="season-row-col season-row-availability">${seasonAvailabilityHtml}</span>
          <span class="season-row-col season-row-next">${escapeHtml(nextAiringText)}</span>
          <span class="season-accordion-meta">
            <svg class="season-accordion-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
        </button>
        ${isActive ? `<div class="season-accordion-panel" id="${panelId}">${seasonPanelsByNumber.get(seasonNumber) || ""}</div>` : ""}
      </article>
    `;
  }).join("");

  const seasonsSectionHtml = seasonsList.length ? `
    <section class="seasons-section season-accordions">
      <div class="show-section-title">
        <h3>Seasons</h3>
        <span>${regularSeasonsList.length} season${regularSeasonsList.length === 1 ? "" : "s"}</span>
      </div>
      <div class="season-accordion-list">${seasonsAccordionHtml}</div>
    </section>
  ` : "";

  const checkIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12.736 3.97a.733.733 0 0 1 1.047 0c.286.289.29.756.01 1.05L7.88 12.01a.733.733 0 0 1-1.065.02L3.217 8.384a.757.757 0 0 1 0-1.06.733.733 0 0 1 1.047 0l3.052 3.093 5.4-6.425z"/></svg>`;
  const calendarIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M3.5 0a.5.5 0 0 1 .5.5V1h8V.5a.5.5 0 0 1 1 0V1h1a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h1V.5a.5.5 0 0 1 .5-.5zM1 4v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4H1z"/></svg>`;
  const imageIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6.002 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/><path d="M2.002 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2h-12zm12 1a1 1 0 0 1 1 1v6.5l-3.777-1.947a.5.5 0 0 0-.577.093l-3.71 3.71-2.66-1.772a.5.5 0 0 0-.63.062L1.002 12V3a1 1 0 0 1 1-1h12z"/></svg>`;
  const searchIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/></svg>`;
  const mergeIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M6.5 3a.5.5 0 0 1 .5.5V6h4a2.5 2.5 0 0 1 2.5 2.5v3.793a1.5 1.5 0 1 1-1 0V8.5A1.5 1.5 0 0 0 11 7H7v2.5a.5.5 0 0 1-1 0v-6a.5.5 0 0 1 .5-.5zM2 13.5a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0zm10 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0z"/></svg>`;
  const expandAllIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M3.646 9.646a.5.5 0 0 1 .708 0L8 13.293l3.646-3.647a.5.5 0 0 1 .708.708l-4 4a.5.5 0 0 1-.708 0l-4-4a.5.5 0 0 1 0-.708zm0-3.292a.5.5 0 0 0 .708 0L8 2.707l3.646 3.647a.5.5 0 0 0 .708-.708l-4-4a.5.5 0 0 0-.708 0l-4 4a.5.5 0 0 0 0 .708z"/></svg>`;
  const collapseAllIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8 3a.5.5 0 0 1 .5.5v3.793l1.146-1.147a.5.5 0 0 1 .708.708l-2 2a.5.5 0 0 1-.708 0l-2-2a.5.5 0 1 1 .708-.708L7.5 7.293V3.5A.5.5 0 0 1 8 3zm-.5 9.5V8.707L6.354 9.854a.5.5 0 1 1-.708-.708l2-2a.5.5 0 0 1 .708 0l2 2a.5.5 0 0 1-.708.708L8.5 8.707v3.793a.5.5 0 0 1-1 0z"/></svg>`;
  const allSeasonsExpandedNow = state.showModalAllSeasonsExpanded;
  const expandAllSeasonsBtn = regularSeasonsList.length ? `
    <button class="action-pill media-toggle-all-seasons-btn" type="button" data-toggle-all-seasons aria-pressed="${allSeasonsExpandedNow}">
      ${allSeasonsExpandedNow ? collapseAllIcon : expandAllIcon}
      <span>${allSeasonsExpandedNow ? "Collapse <br>All" : "Expand <br>All"}</span>
    </button>
  ` : "";

  setMediaDetailActions(`
    <button class="action-pill" type="button" data-watch-scope="show" ${(unwatchedRows.length && !isSaving) ? "" : "disabled"}>
      ${checkIcon}
      <span>${isSavingShow ? "Saving..." : "Mark <br>Watched"}</span>
    </button>
    ${watchedRows.length ? `
      <button class="action-pill media-edit-show-date-btn" type="button" ${isSaving ? "disabled" : ""} data-show-title="${escapeAttribute(showTitle)}">
        ${calendarIcon}
        <span>Edit <br>Date</span>
      </button>` : ""}
    ${tmdbOnly ? "" : `
      <button class="action-pill media-edit-image-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(representativeEpisode(seasonsMap)?.id || show.id || "")}" data-title="${escapeAttribute(showTitle)}" data-poster-url="${escapeAttribute(show.poster_url || "")}" data-logo-url="${escapeAttribute(show.logo_url || "")}" data-backdrop-url="${escapeAttribute(show.backdrop_url || "")}">
        ${imageIcon}
        <span>Edit <br>Images</span>
      </button>
      <details class="actions-more-dropdown">
        <summary class="action-pill actions-more-trigger">
          <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>
          <span>More</span>
        </summary>
        <div class="actions-more-panel">
          <button class="action-pill media-fix-match-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(representativeEpisode(seasonsMap)?.id || show.id || "")}" data-title="${escapeAttribute(showTitle)}" data-media-type="tv">
            ${searchIcon}
            <span>Fix Match</span>
          </button>
          <button class="action-pill media-merge-show-btn" type="button" ${isSaving ? "disabled" : ""} data-show-title="${escapeAttribute(showTitle)}">
            ${mergeIcon}
            <span>Merge</span>
          </button>
        </div>
      </details>
    `}
    ${expandAllSeasonsBtn}
  `);

  root.innerHTML = `
    <div class="modal-backdrop-image" style="background-image: url('${escapeAttribute(backdropUrl || posterUrl || "")}');"></div>
    <div class="immersive-container media-detail-page">

      <header class="immersive-header">
        <img class="immersive-poster-img" src="${escapeAttribute(posterUrl || "/favicon.svg")}" alt="${escapeAttribute(showTitle)} poster" data-err="fav" loading="eager" fetchpriority="high" decoding="async" />
        <div class="immersive-meta">
          ${logoUrl ? `<img class="immersive-logo" src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(showTitle)}" /><h2 class="immersive-title sr-only">${escapeHtml(showTitle)}</h2>` : `<h2 class="immersive-title">${escapeHtml(showTitle)}</h2>`}
          <div class="media-detail-bottom-stack">
            <div class="ratings-row" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
              ${ratingPillsHtml}
              ${imdbPillHtml}
              ${showModalStatus(loading, Boolean(tmdbData))}
            </div>

            ${renderSeerrRequestPill("tv", tvSeerrTmdbId, showIsNowPlaying)}

            <p class="immersive-overview">${escapeHtml(overview)}</p>

            <section class="progress-section" style="border: 0; padding-top: 0; margin-top: 0.5rem; width: 100%;">
              <div class="progress-label-row">
                <span>${watchedCount} of ${totalCount} episodes watched</span>
                <span>${progressPercent}% complete</span>
              </div>
              <div class="progress-bar-track">
                <div class="progress-bar-fill" style="width: ${progressPercent}%;"></div>
              </div>
            </section>
          </div>

         </div>
        ${renderMediaFacts(tmdbData, "tv", "sidebar")}
      </header>

      ${seasonsSectionHtml}

      ${renderCastSection(tmdbData)}
      ${renderMediaImagesSection(tmdbData)}
      ${renderTrailersSection(tmdbData)}
      ${renderReviewsSection(tmdbData)}
      ${renderRelatedShowsSection(tmdbData)}
    </div>
    ${renderWatchDatePrompt(state.pendingWatchAction)}
  `;
  // Refresh when there's no status yet, or when the rendered status came from
  // the persisted cache (`stale`) — the fetch resolves null if nothing
  // changed, so an up-to-date page never re-renders.
  if (tvSeerrTmdbId && (!hasTvSeerrStatus || tvSeerrStatus.stale)) {
    fetchSeerrMediaStatus("tv", tvSeerrTmdbId)
      .then((status) => {
        if (!status || state.activeShowModalKey !== slug(show.title)) return;
        const current = state.activeShowRenderContext;
        if (current?.tmdbData && !current.loading) {
          renderShowModalContent(current.show, {
            ...current,
            activeSeasonNum: current.activeSeasonNum,
            tmdbData: current.tmdbData,
            seasonDetailsByNumber: current.seasonDetailsByNumber,
            loading: current.loading,
          });
          return;
        }
        refreshActiveMediaDetailAfterSeerrStatus("tv", tvSeerrTmdbId);
      });
  }
  hydratePosters(root);
  hydrateMediaAppLinks(root);
}

function mergeShowWithLoadedHistory(show = {}) {
  if (!show?.title) return show;
  const showKey = slug(show.title || "");
  const byEpisode = new Map();
  for (const episode of show.episodes || []) {
    if (!isWatchedHistoryAction(episode)) continue;
    if (episode.season == null || episode.episode == null) continue;
    byEpisode.set(showEpisodeKey(episode.season, episode.episode), episode);
  }
  for (const row of state.history || []) {
    if (!isWatchedHistoryAction(row)) continue;
    if (row.media_type !== "episode") continue;
    if (row.season == null || row.episode == null) continue;
    const rowShowTitle = row.show_title || showTitleFrom(row.title);
    if (slug(rowShowTitle) !== showKey) continue;
    const key = showEpisodeKey(row.season, row.episode);
    const existing = byEpisode.get(key);
    if (!existing || String(row.watched_at || "") >= String(existing.watched_at || "")) {
      byEpisode.set(key, { ...row, show_title: rowShowTitle });
    }
  }
  const episodes = [...byEpisode.values()].sort((a, b) => Number(b.season || 0) - Number(a.season || 0) || Number(b.episode || 0) - Number(a.episode || 0));
  if (!episodes.length) return show;
  const seasonCount = new Set(episodes.map((ep) => ep.season).filter((s) => s != null)).size;
  const watchedDates = episodes.map((ep) => ep.watched_at).filter(Boolean).sort();
  return {
    ...show,
    episode_count: Math.max(Number(show.episode_count || 0), episodes.length),
    season_count: Math.max(Number(show.season_count || 0), seasonCount),
    latest_watched_at: watchedDates.at(-1) || show.latest_watched_at,
    earliest_watched_at: watchedDates[0] || show.earliest_watched_at,
    episodes,
  };
}

function fallbackSeasonList(seasonsMap) {
  return [...seasonsMap.keys()].sort((a, b) => b - a).map((seasonNumber) => ({
    season_number: seasonNumber,
    name: seasonLabel(seasonNumber),
    episode_count: seasonsMap.get(seasonNumber)?.length || 0,
    poster_path: null,
  }));
}

async function hydrateImmersiveShowModal(showKey, activeSeasonNum, requestToken) {
  const show = mergeShowWithLoadedHistory(state.showsRaw.find((s) => slug(s.title) === showKey));
  if (!show) return;
  const tmdbData = await fetchTmdbDetails("tv", show.tmdb_id, show.title, tmdbLookupIdsFromShow(show));
  if (requestToken !== state.showModalRequestToken || state.activeShowModalKey !== showKey) return;
  if (tmdbData?.id) state.activeShowTmdbId = String(tmdbData.id);
  const imdbPillHtml = await fetchShowImdbPillHtml(show, tmdbData, () => requestToken === state.showModalRequestToken && state.activeShowModalKey === showKey);
  if (requestToken !== state.showModalRequestToken || state.activeShowModalKey !== showKey) return;
  const currentSeasonNum = state.activeShowModalSeason;
  const seasonDetailsByNumber = new Map();
  if (tmdbData?.id && currentSeasonNum != null) {
    const seasonDetails = await fetchTmdbSeasonDetails(tmdbData.id, currentSeasonNum);
    if (seasonDetails) seasonDetailsByNumber.set(Number(currentSeasonNum), seasonDetails);
  }
  if (requestToken !== state.showModalRequestToken || state.activeShowModalKey !== showKey) return;
  renderShowModalContent(show, { activeSeasonNum: state.activeShowModalSeason, tmdbData, seasonDetailsByNumber, loading: false, imdbPillHtml });
}

export async function renderImmersiveShowModal(showKey, activeSeasonNum = null, activeEpisodeNum = null) {
  // Half of a two-token handshake with media-detail-movie.js — see the
  // bumpMediaRenderToken doc comment in media-detail-context.js before changing this.
  bumpMediaRenderToken(); // invalidate any in-flight movie render
  syncInlineMediaDetailHeading("shows");
  state.activeShowModalKey = showKey;
  state.pendingWatchAction = null;
  state.activeShowModalEpisode = activeEpisodeNum;
  if (!state.mediaDetailInline) {
    elements.debugModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    const modalPanel = elements.debugModal.querySelector(".modal-panel");
    if (modalPanel) {
      modalPanel.classList.add("modal-panel--immersive");
    }
  }
  const root = mediaDetailRoot();

  let show = state.showsRaw.find((s) => slug(s.title) === showKey);
  if (!show) {
    root.innerHTML = `
      <div class="modal-backdrop-image"></div>
      <div class="immersive-container media-detail-page">
        ${mediaDetailLoaderHtml("Loading show details")}
      </div>
    `;
    try {
      const response = await fetch(`/api/show?id=${encodeURIComponent(showKey)}`, { headers: authHeaders(), cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.show) {
        show = body.show;
        state.showsRaw.push(show);
      }
    } catch (error) {
      console.error("Failed to load show detail on direct link", error);
    }
  }

  if (!show) {
    // Not in local library. If the now-playing session has a TMDB ID, delegate to
    // the TMDB-based loader (which has its own title fallback). Otherwise try a
    // TMDB title search using the slug as a title hint.
    const matchingSession = state.activeSessions.find((s) => {
      const t = showTitleFrom(s.showTitle || s.show_title || s.title || "");
      return slug(t) === showKey;
    });
    if (matchingSession?.ids?.tmdb) {
      await openShowImmersiveModalByTmdbId(matchingSession.ids.tmdb);
      return;
    }
    const sessionTitle = matchingSession
      ? showTitleFrom(matchingSession.showTitle || matchingSession.show_title || matchingSession.title || "")
      : "";
    const titleGuess = sessionTitle || showKey.replace(/-/g, " ");
    if (titleGuess) {
      state.activeShowTmdbId = null;
      const tmdbData = await fetchTmdbDetails("tv", null, titleGuess);
      if (tmdbData) {
        await openShowImmersiveModalByTmdbId(tmdbData.id);
        return;
      }
    }
    root.innerHTML = `
      <div class="modal-backdrop-image"></div>
      <div class="immersive-container media-detail-page">
        <div class="empty-log">
          <b style="color: var(--danger);">TV Show Not Found</b>
          <span>Could not locate the series "${escapeHtml(showKey)}" in your archive.</span>
        </div>
      </div>
    `;
    return;
  }

  if (!Array.isArray(show.episodes) || !show.episodes.length) {
    root.innerHTML = `
      <div class="modal-backdrop-image"></div>
      <div class="immersive-container media-detail-page">
        <div class="empty-log">
          <b>Loading episodes...</b>
          <span>Loading episode history.</span>
        </div>
      </div>
    `;
    hydratePosters(root);
    const detailedShow = await loadShowDetail(show).catch((error) => {
      console.error("Failed to load show detail", error);
      setMessage(`Failed to load show details: ${error.message}`, "error");
      return null;
    });
    if (detailedShow) show = detailedShow;
    if (!Array.isArray(show.episodes) || !show.episodes.length) {
      root.innerHTML = `
        <div class="modal-backdrop-image"></div>
        <div class="immersive-container media-detail-page">
          <div class="empty-log">
            <b>No episode rows found</b>
            <span>No local episode history was available.</span>
          </div>
        </div>
      `;
      return;
    }
  }

  state.activeShowModalSeason = activeSeasonNum;
  const requestToken = ++state.showModalRequestToken;
  const playbackProgressPromise = ensurePlaybackProgressLoaded();
  renderShowModalContent(show, {
    activeSeasonNum,
    tmdbData: null,
    seasonDetailsByNumber: new Map(),
    loading: Boolean(state.savedConfig.tmdb?.configured),
  });
  // Progress is secondary to the first paint. Refresh it after the shell is
  // visible so a slow/no-store progress request cannot block artwork and
  // episode history from appearing.
  playbackProgressPromise.then(() => {
    if (requestToken !== state.showModalRequestToken || state.activeShowModalKey !== showKey) return;
    const current = state.activeShowRenderContext;
    if (!current) return;
    renderShowModalContent(current.show, { ...current, activeSeasonNum: state.activeShowModalSeason });
  }).catch(() => { });
  hydrateImmersiveShowModal(showKey, activeSeasonNum, requestToken).catch((error) => {
    console.error("Failed to hydrate show modal", error);
    if (requestToken === state.showModalRequestToken && state.activeShowModalKey === showKey) {
      renderShowModalContent(show, { activeSeasonNum, tmdbData: null, seasonDetailsByNumber: new Map(), loading: false });
    }
  });
  hydratePosters(root);
}
