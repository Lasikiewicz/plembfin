import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, formatDate, formatTmdbDate } from "./utils.js";
import { posterUrlFor, tmdbPoster, bestTmdbLogo, hydratePosters } from "./images.js";
import { isWatchedHistoryAction, getMediaTargetSyncStatus, renderSyncStatusDot } from "./sync.js";
import { fetchTmdbDetails } from "./tmdb.js?v=20260710";
import { renderWatchDatePrompt } from "./watch-action.js";
import { authHeaders, mediaDetailRoot, mediaDetailLoaderHtml, setMediaDetailActions, bumpMediaRenderToken, currentMediaRenderToken } from "./media-detail-context.js";
import {
  renderCastSection, renderTrailersSection, renderReviewsSection, renderMediaImagesSection, renderMediaFacts,
  renderExternalRatingPills, ratingPillHtml, renderSeerrRequestPill, fetchSeerrMediaStatus,
  refreshActiveMediaDetailAfterSeerrStatus, rankedRecommendations, recommendedTvShowsForMovie,
  renderRecommendationSection, hydrateMediaAppLinks, renderCollectionSection,
} from "./media-detail-shared.js";

// Watch history list — playHistory (every { id, watched_at, source } entry for
// this movie, collapsed server-side in dedupeMovies/collapseMovieCluster) has
// more than one entry once a genuine rewatch has been recorded.
function rewatchSummaryHtml(movie) {
  const history = Array.isArray(movie?.playHistory) ? movie.playHistory : [];
  if (history.length < 2) return "";
  const rows = [...history]
    .sort((a, b) => String(b.watched_at).localeCompare(String(a.watched_at)))
    .map((entry) => `
      <li class="episode-watch-history-row">
        <span class="episode-watch-history-date">${escapeHtml(formatDate(entry.watched_at))}</span>
      </li>
    `)
    .join("");
  return `
    <div class="episode-watch-history movie-rewatch-history">
      <div class="episode-watch-history-head">
        <span class="rewatch-badge" title="Watched ${history.length} times">&#8635; Watch History &times;${history.length}</span>
      </div>
      <ul class="episode-watch-history-list movie-watch-history-list">
        ${rows}
        <li class="watch-history-toggle-item" hidden>
          <button class="watch-history-toggle" type="button" data-watch-history-toggle aria-expanded="false">
            <span class="watch-history-toggle-icon" aria-hidden="true">&#9662;</span>
            <span class="watch-history-toggle-label">Show more</span>
          </button>
        </li>
      </ul>
    </div>
  `;
}

export function syncRewatchHistoryToggle(root) {
  for (const history of root.querySelectorAll(".movie-rewatch-history")) {
    const list = history.querySelector(".movie-watch-history-list");
    const toggle = history.querySelector("[data-watch-history-toggle]");
    const toggleItem = toggle?.closest(".watch-history-toggle-item") || toggle;
    if (!list || !toggle) continue;
    if (history.classList.contains("is-expanded")) {
      for (const row of list.querySelectorAll(".episode-watch-history-row")) row.hidden = false;
      toggleItem.hidden = false;
      continue;
    }
    const rows = [...list.querySelectorAll(".episode-watch-history-row")];
    for (const row of rows) row.hidden = false;
    toggleItem.hidden = true;
    if (list.scrollHeight > list.clientHeight + 1) {
      toggleItem.hidden = false;
      for (let index = rows.length - 1; index >= 0 && list.scrollHeight > list.clientHeight + 1; index -= 1) {
        rows[index].hidden = true;
      }
    }
    if (!list.dataset.watchHistoryObserved && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => syncRewatchHistoryToggle(root));
      observer.observe(list);
      list.dataset.watchHistoryObserved = "true";
    }
  }
}

// Authoritatively check whether a movie is already in watch history. state.history
// is only the dashboard preview, so fall back to the server (which holds the full
// history) to avoid showing a saved movie as unwatched after a refresh.
export async function fetchWatchedMovieByTmdb(tmdbId, title) {
  try {
    const url = new URL("/api/movies", window.location.origin);
    url.searchParams.set("search", title || "");
    url.searchParams.set("limit", "30");
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    const movies = Array.isArray(body.movies) ? body.movies : [];
    const byTmdbId = tmdbId
      ? movies.find((movie) => String(movie.tmdb_id || "") === String(tmdbId))
      : null;
    if (byTmdbId) return byTmdbId;
    const normalizedTitle = String(title || "").trim().toLowerCase();
    return normalizedTitle
      ? movies.find((movie) => String(movie.title || "").trim().toLowerCase() === normalizedTitle) || null
      : null;
  } catch {
    return null;
  }
}

export async function renderMovieImmersiveModalContent(movie) {
  // Route state can contain the lightweight latest-play record rather than the
  // server's collapsed movie record. Rehydrate before the first paint so every
  // detail entry point shows the same complete watch history.
  if (movie && (!Array.isArray(movie.playHistory) || movie.playHistory.length < 2)) {
    const fullMovie = await fetchWatchedMovieByTmdb(movie.tmdb_id, movie.title);
    if (fullMovie && Array.isArray(fullMovie.playHistory) && fullMovie.playHistory.length > (movie.playHistory?.length || 0)) {
      movie = fullMovie;
    }
  }
  // Half of a two-token handshake with media-detail-show.js — see the
  // bumpMediaRenderToken doc comment in media-detail-context.js before changing this.
  const renderToken = bumpMediaRenderToken();
  state.showModalRequestToken += 1; // invalidate any in-flight show hydrate
  state.activeMovieModalId = movie.id;
  state.activeMovieTmdbId = movie.tmdb_id ? String(movie.tmdb_id) : null;
  if (!state.mediaDetailInline) {
    elements.debugModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    const modalPanel = elements.debugModal.querySelector(".modal-panel");
    if (modalPanel) {
      modalPanel.classList.add("modal-panel--immersive");
    }
  }
  const root = mediaDetailRoot();
  const isSaving = state.savingWatchAction;

  // Phase 1: Render immediately with all available local data — no blank screen.
  _renderWatchedMovieContent(root, movie, { tmdbData: null, loading: true, imdbPillHtml: "", tvRecommendations: [], isSaving });


  // Fetch TMDB details (primary enrichment).
  const tmdbData = await fetchTmdbDetails("movie", movie.tmdb_id, movie.title);
  if (currentMediaRenderToken() !== renderToken) return; // navigated away while loading

  if (tmdbData && tmdbData.id) {
    state.activeMovieTmdbId = String(tmdbData.id);
  }

  // For YouTube-only content, fetch metadata from our backend.
  let youtubeMeta = null;
  if (!tmdbData && movie.youtube_url) {
    try {
      const ytRes = await fetch(`/api/youtube-meta?url=${encodeURIComponent(movie.youtube_url)}`, { headers: authHeaders() });
      const ytData = await ytRes.json();
      if (!ytData.error) youtubeMeta = ytData;
    } catch { /* non-fatal */ }
    if (currentMediaRenderToken() !== renderToken) return; // navigated away while loading
  }

  // Phase 2: Render with TMDB data immediately — don't wait for OMDb/TV recs.
  _renderWatchedMovieContent(root, movie, { tmdbData, youtubeMeta, loading: false, imdbPillHtml: "", tvRecommendations: [], isSaving });

  // Phase 3: Fetch OMDb rating and TV recommendations in parallel.
  const imdbId = movie.imdb_id || tmdbData?.imdb_id || "";
  const [omdbRes, tvRecommendations] = await Promise.all([
    imdbId && state.savedConfig?.omdb?.configured
      ? fetch(`/api/omdb-rating?imdbId=${encodeURIComponent(imdbId)}`, { headers: authHeaders() }).catch(() => null)
      : Promise.resolve(null),
    tmdbData ? recommendedTvShowsForMovie(movie.title, tmdbData).catch(() => []) : Promise.resolve([]),
  ]);
  if (currentMediaRenderToken() !== renderToken) return;

  let imdbPillHtml = "";
  if (omdbRes?.ok) {
    const omdbData = await omdbRes.json().catch(() => null);
    if (omdbData?.imdbRating) {
      imdbPillHtml = ratingPillHtml({
        label: "IMDb",
        value: `${Math.round(parseFloat(omdbData.imdbRating) * 10)}%`,
        href: `https://www.imdb.com/title/${escapeAttribute(imdbId)}`,
        title: `IMDb rating: ${omdbData.imdbRating}/10`,
      });
    }
  }
  if (currentMediaRenderToken() !== renderToken) return;

  // Phase 3 render: patch in OMDb pill and TV recommendations if anything new arrived.
  if (imdbPillHtml || tvRecommendations.length) {
    _renderWatchedMovieContent(root, movie, { tmdbData, youtubeMeta, loading: false, imdbPillHtml, tvRecommendations, isSaving });
  }

  const movieSeerrTmdbId = tmdbData?.id || movie.tmdb_id;
  if (movieSeerrTmdbId) {
    fetchSeerrMediaStatus("movie", movieSeerrTmdbId)
      .then((status) => { if (status) refreshActiveMediaDetailAfterSeerrStatus("movie", movieSeerrTmdbId); });
  }
  hydratePosters(root);
}

// Shared renderer for a watched movie. Called up to three times per navigation:
// (1) immediately with local data only, (2) once TMDB resolves, (3) once OMDb +
// TV recs resolve. Only re-renders when there is new data to add.
function _renderWatchedMovieContent(root, movie, {
  tmdbData = null,
  youtubeMeta = null,
  loading = false,
  imdbPillHtml = "",
  tvRecommendations = [],
  isSaving = null,
} = {}) {
  const localPoster = posterUrlFor(movie) || "/favicon.svg";
  let backdropUrl = movie.backdrop_url || "";
  let posterUrl = posterUrlFor(movie);
  let overview = loading ? "Loading synopsis…" : "No synopsis available.";
  let released = "Unknown Release Date";
  let rating = "";
  let recommendations = [];

  if (tmdbData) {
    if (!backdropUrl && tmdbData.backdrop_path) {
      backdropUrl = tmdbData.cached_backdrop_url || `https://image.tmdb.org/t/p/original${tmdbData.backdrop_path}`;
    }
    if (tmdbData.poster_path && !posterUrl) {
      posterUrl = tmdbData.cached_poster_url || tmdbPoster(tmdbData.poster_path, tmdbData.id, "movie");
    }
    overview = tmdbData.overview || "No synopsis available.";
    released = tmdbData.release_date ? `Released ${formatTmdbDate(tmdbData.release_date)}` : released;
    rating = tmdbData.vote_average ? `${Math.round(tmdbData.vote_average * 10)}%` : "";
    recommendations = rankedRecommendations(tmdbData, "movie");
  } else if (youtubeMeta) {
    if (youtubeMeta.thumbnails?.[0]) posterUrl = youtubeMeta.thumbnails[0];
    overview = youtubeMeta.description || "No synopsis available.";
    if (youtubeMeta.publishedAt) released = `Published ${formatTmdbDate(youtubeMeta.publishedAt.slice(0, 10))}`;
  }

  const movieTitle = movie.title;
  const logoUrl = movie.logo_url || bestTmdbLogo(tmdbData);
  const ratingBadgeHtml = rating ? renderExternalRatingPills("movie", tmdbData, movieTitle, rating) : "";
  const syncStatusDotHtml = renderSyncStatusDot(movie);
  const visibleSyncStatuses = getMediaTargetSyncStatus(movie).filter((s) => !s.hidden);
  const allSynced = !visibleSyncStatuses.length || visibleSyncStatuses.every((s) => s.status === "success" || s.status === "skipped");
  const syncStatusBlockHtml = syncStatusDotHtml ? `
            <div style="display: flex; gap: 0.5rem; align-items: center; margin-left: auto;">
              <span style="font-size: 0.72rem; color: var(--muted); font-weight: 800; text-transform: uppercase;">Sync Status:</span>
              ${syncStatusDotHtml}
              ${!allSynced ? `<button class="retry-sync-btn action-pill" type="button" ${isSaving ? "disabled" : ""} data-retry-sync-id="${escapeAttribute(movie.id)}" style="font-size: 0.7rem; padding: 0.15rem 0.45rem;">Retry Sync</button>` : ""}
            </div>
  ` : "";
  const eyeSlashIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 4 8 4c2.12 0 3.879.668 5.168 1.957A13.133 13.133 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12 8 12c-2.12 0-3.879-.668-5.168-1.957A13.133 13.133 0 0 1 1.172 8z"/><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"/></svg>`;
  const imageIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6.002 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/><path d="M2.002 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2h-12zm12 1a1 1 0 0 1 1 1v6.5l-3.777-1.947a.5.5 0 0 0-.577.093l-3.71 3.71-2.66-1.772a.5.5 0 0 0-.63.062L1.002 12V3a1 1 0 0 1 1-1h12z"/></svg>`;
  const searchIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/></svg>`;
  const trashIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3h11V2h-11v1z"/></svg>`;
  const youtubeIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8.051 1.999h.089c.822.003 4.987.033 6.11.335a2.01 2.01 0 0 1 1.415 1.42c.101.38.172.883.22 1.402l.01.104.022.26.008.104c.065.914.073 1.77.074 1.957v.075c-.001.194-.01 1.108-.082 2.06l-.008.105-.009.104c-.05.572-.124 1.14-.235 1.558a2.007 2.007 0 0 1-1.415 1.42c-1.16.312-5.569.334-6.18.335h-.142c-.309 0-1.587-.006-2.927-.052l-.17-.006-.087-.004-.171-.007-.171-.007c-1.11-.049-2.167-.128-2.654-.26a2.007 2.007 0 0 1-1.415-1.419c-.111-.417-.185-.986-.235-1.558L.09 9.82l-.008-.104A31.4 31.4 0 0 1 0 7.58v-.075c.001-.194.01-1.108.082-2.06l.008-.105.009-.104c.05-.572.124-1.14.235-1.558a2.007 2.007 0 0 1 1.415-1.42c1.16-.312 5.569-.334 6.18-.335h.142z"/><path d="M6.168 10.302l3.24-1.62-3.24-1.62v3.24z"/></svg>`;

  const ytWatchBtn = movie.youtube_url
    ? `<a class="action-pill" href="${escapeAttribute(movie.youtube_url)}" target="_blank" rel="noopener noreferrer">
        ${youtubeIcon}
        <span>Trailer</span>
       </a>`
    : "";

  setMediaDetailActions(`
    <button class="action-pill action-pill-ghost" type="button" ${isSaving ? "disabled" : ""} data-unwatch-id="${escapeAttribute(movie.id)}" data-unwatch-kind="movie" data-unwatch-label="${escapeAttribute(movie.title || "this movie")}">
      ${eyeSlashIcon}
      <span>Mark <br>Unwatched</span>
    </button>
    ${ytWatchBtn}
    <button class="action-pill media-edit-image-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-title="${escapeAttribute(movie.title || movieTitle || "")}" data-poster-url="${escapeAttribute(movie.poster_url || "")}" data-logo-url="${escapeAttribute(movie.logo_url || "")}" data-backdrop-url="${escapeAttribute(movie.backdrop_url || "")}">
      ${imageIcon}
      <span>Edit <br>Images</span>
    </button>
    <details class="actions-more-dropdown">
      <summary class="action-pill actions-more-trigger">
        <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>
        <span>More</span>
      </summary>
      <div class="actions-more-panel">
        <button class="action-pill media-fix-match-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-title="${escapeAttribute(movie.title || "")}" data-media-type="movie">
          ${searchIcon}
          <span>Fix Match</span>
        </button>
        <button class="action-pill action-pill-danger" type="button" ${isSaving ? "disabled" : ""} data-delete-media-id="${escapeAttribute(movie.id)}" data-delete-media-title="${escapeAttribute(movie.title || "this movie")}">
          ${trashIcon}
          <span>Delete</span>
        </button>
      </div>
    </details>
  `);

  root.innerHTML = `
    <div class="modal-backdrop-image" style="background-image: url('${escapeAttribute(backdropUrl || posterUrl || localPoster)}');"></div>
    <div class="immersive-container media-detail-page${loading ? " is-loading-metadata" : ""}">
      <header class="immersive-header">
        <img class="immersive-poster-img" src="${escapeAttribute(posterUrl || localPoster)}" alt="${escapeHtml(movieTitle)} poster" data-err="fav" />
        <div class="immersive-meta">
          ${logoUrl ? `<img class="immersive-logo" src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(movieTitle)}" /><h2 class="immersive-title sr-only">${escapeHtml(movieTitle)}</h2>` : `<h2 class="immersive-title">${escapeHtml(movieTitle)}</h2>`}
          <p class="immersive-subtitle">${escapeHtml(released)}${youtubeMeta?.channelName ? ` &middot; ${escapeHtml(youtubeMeta.channelName)}` : ""}</p>
          <div class="media-detail-bottom-stack">
            <div class="ratings-row" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
              ${ratingBadgeHtml || (tmdbData ? renderExternalRatingPills("movie", tmdbData, movieTitle) : "")}
              ${imdbPillHtml}
              ${syncStatusBlockHtml}
            </div>
            ${renderSeerrRequestPill("movie", tmdbData?.id || movie.tmdb_id, true)}
            <p class="immersive-overview">${escapeHtml(overview)}</p>
            <section class="progress-section" style="border: 0; padding-top: 0; margin-top: 0.5rem; width: 100%;">
              <h3>Watch Status</h3>
              <div class="progress-label-row">
                <span>Watched on ${formatDate(movie.watched_at)} <button class="edit-date-icon-btn" type="button" title="Edit watch date" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-watched-at="${escapeAttribute(movie.watched_at || "")}">✎</button></span>
                <span>100% complete</span>
              </div>
              <div class="progress-bar-track">
                <div class="progress-bar-fill" style="width: 100%;"></div>
              </div>
              ${rewatchSummaryHtml(movie)}
            </section>
          </div>
        </div>
        ${renderMediaFacts(tmdbData, "movie", "sidebar")}
      </header>
      ${tmdbData ? renderCastSection(tmdbData) : ""}
      ${tmdbData ? renderMediaImagesSection(tmdbData) : ""}
      ${tmdbData ? renderTrailersSection(tmdbData) : ""}
      ${tmdbData ? renderReviewsSection(tmdbData) : ""}
      ${tmdbData ? renderCollectionSection(tmdbData) : ""}
      ${renderRecommendationSection({ title: "Recommended movies", items: recommendations, mediaType: "movie" })}
      ${renderRecommendationSection({ title: "Recommended TV Shows", items: tvRecommendations, mediaType: "tv" })}
    </div>
    ${renderWatchDatePrompt(state.pendingWatchAction)}
  `;
  hydratePosters(root);
  hydrateMediaAppLinks(root);
  syncRewatchHistoryToggle(root);
}

export function patchMovieWatchedState(movie) {
  if (!movie?.id) return false;
  const root = mediaDetailRoot();
  const page = root?.querySelector?.(".media-detail-page");
  if (!page) return false;

  state.activeMovieModalId = movie.id;
  state.activeMovieTmdbId = movie.tmdb_id ? String(movie.tmdb_id) : state.activeMovieTmdbId;

  const syncStatusDotHtml = renderSyncStatusDot(movie);
  const visibleSyncStatuses = getMediaTargetSyncStatus(movie).filter((s) => !s.hidden);
  const allSynced = !visibleSyncStatuses.length || visibleSyncStatuses.every((s) => s.status === "success" || s.status === "skipped");
  const syncStatusBlockHtml = syncStatusDotHtml ? `
            <div style="display: flex; gap: 0.5rem; align-items: center; margin-left: auto;">
              <span style="font-size: 0.72rem; color: var(--muted); font-weight: 800; text-transform: uppercase;">Sync Status:</span>
              ${syncStatusDotHtml}
              ${!allSynced ? `<button class="retry-sync-btn action-pill" type="button" data-retry-sync-id="${escapeAttribute(movie.id)}" style="font-size: 0.7rem; padding: 0.15rem 0.45rem;">Retry Sync</button>` : ""}
            </div>
  ` : "";
  const ratingsRow = page.querySelector(".ratings-row");
  if (ratingsRow && syncStatusBlockHtml && !ratingsRow.querySelector("[data-sync-status-dot]")) {
    ratingsRow.insertAdjacentHTML("beforeend", syncStatusBlockHtml);
  }

  const eyeSlashIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 4 8 4c2.12 0 3.879.668 5.168 1.957A13.133 13.133 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12 8 12c-2.12 0-3.879-.668-5.168-1.957A13.133 13.133 0 0 1 1.172 8z"/><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"/></svg>`;
  const imageIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6.002 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/><path d="M2.002 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2h-12zm12 1a1 1 0 0 1 1 1v6.5l-3.777-1.947a.5.5 0 0 0-.577.093l-3.71 3.71-2.66-1.772a.5.5 0 0 0-.63.062L1.002 12V3a1 1 0 0 1 1-1h12z"/></svg>`;
  const searchIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/></svg>`;
  const trashIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3h11V2h-11v1z"/></svg>`;
  const youtubeIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8.051 1.999h.089c.822.003 4.987.033 6.11.335a2.01 2.01 0 0 1 1.415 1.42c.101.38.172.883.22 1.402l.01.104.022.26.008.104c.065.914.073 1.77.074 1.957v.075c-.001.194-.01 1.108-.082 2.06l-.008.105-.009.104c-.05.572-.124 1.14-.235 1.558a2.007 2.007 0 0 1-1.415 1.42c-1.16.312-5.569.334-6.18.335h-.142c-.309 0-1.587-.006-2.927-.052l-.17-.006-.087-.004-.171-.007-.171-.007c-1.11-.049-2.167-.128-2.654-.26a2.007 2.007 0 0 1-1.415-1.419c-.111-.417-.185-.986-.235-1.558L.09 9.82l-.008-.104A31.4 31.4 0 0 1 0 7.58v-.075c.001-.194.01-1.108.082-2.06l.008-.105.009-.104c.05-.572.124-1.14.235-1.558a2.007 2.007 0 0 1 1.415-1.42c1.16-.312 5.569-.334 6.18-.335h.142z"/><path d="M6.168 10.302l3.24-1.62-3.24-1.62v3.24z"/></svg>`;

  const ytWatchBtn = movie.youtube_url
    ? `<a class="action-pill" href="${escapeAttribute(movie.youtube_url)}" target="_blank" rel="noopener noreferrer">
        ${youtubeIcon}
        <span>Trailer</span>
       </a>`
    : "";

  setMediaDetailActions(`
    <button class="action-pill action-pill-ghost" type="button" data-unwatch-id="${escapeAttribute(movie.id)}" data-unwatch-kind="movie" data-unwatch-label="${escapeAttribute(movie.title || "this movie")}">
      ${eyeSlashIcon}
      <span>Mark <br>Unwatched</span>
    </button>
    ${ytWatchBtn}
    <button class="action-pill media-edit-image-btn" type="button" data-edit-id="${escapeAttribute(movie.id)}" data-title="${escapeAttribute(movie.title || "")}" data-poster-url="${escapeAttribute(movie.poster_url || "")}" data-logo-url="${escapeAttribute(movie.logo_url || "")}" data-backdrop-url="${escapeAttribute(movie.backdrop_url || "")}">
      ${imageIcon}
      <span>Edit <br>Images</span>
    </button>
    <details class="actions-more-dropdown">
      <summary class="action-pill actions-more-trigger">
        <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>
        <span>More</span>
      </summary>
      <div class="actions-more-panel">
        <button class="action-pill media-fix-match-btn" type="button" data-edit-id="${escapeAttribute(movie.id)}" data-title="${escapeAttribute(movie.title || "")}" data-media-type="movie">
          ${searchIcon}
          <span>Fix Match</span>
        </button>
        <button class="action-pill action-pill-danger" type="button" data-delete-media-id="${escapeAttribute(movie.id)}" data-delete-media-title="${escapeAttribute(movie.title || "this movie")}">
          ${trashIcon}
          <span>Delete</span>
        </button>
      </div>
    </details>
  `);

  const progressSection = page.querySelector(".progress-section");
  if (progressSection) {
    progressSection.innerHTML = `
            <h3>Watch Status</h3>
            <div class="progress-label-row">
              <span>Watched on ${formatDate(movie.watched_at)} <button class="edit-date-icon-btn" type="button" title="Edit watch date" data-edit-id="${escapeAttribute(movie.id)}" data-watched-at="${escapeAttribute(movie.watched_at || "")}">✎</button></span>
              <span>100% complete</span>
            </div>
            <div class="progress-bar-track">
              <div class="progress-bar-fill" style="width: 100%;"></div>
            </div>
            ${rewatchSummaryHtml(movie)}
    `;
    syncRewatchHistoryToggle(page);
  }

  return true;
}

export async function openMovieImmersiveModalByTmdbId(tmdbId) {
  const renderToken = bumpMediaRenderToken();
  state.showModalRequestToken += 1;
  state.activeMovieTmdbId = String(tmdbId);
  // Fast path: if it's in the loaded preview, show its watched detail immediately.
  const existingWatched = state.history.find(
    (entry) => entry.media_type === "movie" && isWatchedHistoryAction(entry) && String(entry.tmdb_id || "") === String(tmdbId),
  );
  if (existingWatched) {
    // The history preview is intentionally lightweight and does not include
    // the deduped playHistory array. Paint it immediately, then replace it
    // with the authoritative movie record so rewatches are visible on first
    // open instead of only after editing/saving a watch date.
    await renderMovieImmersiveModalContent(existingWatched);
    const fullMovie = await fetchWatchedMovieByTmdb(tmdbId, existingWatched.title);
    if (fullMovie && state.activeMovieTmdbId === String(tmdbId)) {
      await renderMovieImmersiveModalContent(fullMovie);
    }
    return;
  }
  setMediaDetailActions("");
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
      ${mediaDetailLoaderHtml("Loading movie details")}
    </div>
  `;
  const tmdbData = await fetchTmdbDetails("movie", tmdbId, null);
  if (currentMediaRenderToken() !== renderToken) return;
  if (!tmdbData) {
    root.innerHTML = `
      <div class="immersive-container">
        <div style="display: flex; justify-content: center; align-items: center; min-height: 200px; flex-direction: column; gap: var(--space-2);">
          <span style="color: var(--danger); font-size: 1.1rem; font-weight: bold;">Could not load movie details</span>
          <span style="color: var(--muted); font-size: 0.9rem;">Please check your TMDB API Key in Settings.</span>
        </div>
      </div>
    `;
    return;
  }
  const movieTitle = tmdbData.title;
  // state.history is only the dashboard preview; confirm against the server so a
  // movie marked watched (especially with an old release date) still shows watched.
  const persistedWatched = await fetchWatchedMovieByTmdb(tmdbId, movieTitle);
  if (currentMediaRenderToken() !== renderToken) return;
  if (persistedWatched) return renderMovieImmersiveModalContent(persistedWatched);
  const isSaving = state.savingWatchAction;
  const isSavingThisMovie = isSaving && isSaving.scope === "movie" && String(isSaving.movie?.tmdbId || "") === String(tmdbId);
  const backdropUrl = tmdbData.cached_backdrop_url || (tmdbData.backdrop_path ? `https://image.tmdb.org/t/p/original${tmdbData.backdrop_path}` : "");
  const posterUrl = tmdbData.cached_poster_url || tmdbPoster(tmdbData.poster_path, tmdbData.id, "movie") || "/favicon.svg";
  const overview = tmdbData.overview || "No synopsis available.";
  const released = tmdbData.release_date ? `Released ${formatTmdbDate(tmdbData.release_date)}` : "Unknown Release Date";
  const rating = tmdbData.vote_average ? `${Math.round(tmdbData.vote_average * 10)}%` : "N/A";
  const recommendations = rankedRecommendations(tmdbData, "movie");
  const logoUrl = bestTmdbLogo(tmdbData);
  const ratingBadgeHtml = rating !== "N/A" ? `${renderExternalRatingPills("movie", tmdbData, movieTitle, rating)}` : "";

  const buildUnwatchedHtml = (tvRecommendations = []) => `
    <div class="modal-backdrop-image" style="background-image: url('${escapeAttribute(backdropUrl || posterUrl)}');"></div>
    <div class="immersive-container media-detail-page">
      <header class="immersive-header">
        <img class="immersive-poster-img" src="${escapeAttribute(posterUrl)}" alt="${escapeHtml(movieTitle)} poster" data-err="fav" />
        <div class="immersive-meta">
          ${logoUrl ? `<img class="immersive-logo" src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(movieTitle)}" /><h2 class="immersive-title sr-only">${escapeHtml(movieTitle)}</h2>` : `<h2 class="immersive-title">${escapeHtml(movieTitle)}</h2>`}
          <p class="immersive-subtitle">${escapeHtml(released)}</p>
          <div class="media-detail-bottom-stack">
            <div class="ratings-row" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
              ${ratingBadgeHtml || renderExternalRatingPills("movie", tmdbData, movieTitle)}
            </div>
            ${renderSeerrRequestPill("movie", tmdbId, false)}
            <p class="immersive-overview">${escapeHtml(overview)}</p>
            <section class="progress-section" style="border: 0; padding-top: 0; margin-top: 0.5rem; width: 100%;">
              <h3>Watch Status</h3>
              <div class="progress-label-row">
                <span>Unwatched (local archive)</span>
                <span>0% complete</span>
              </div>
              <div class="progress-bar-track">
                <div class="progress-bar-fill" style="width: 0%;"></div>
              </div>
              <div class="immersive-actions" style="margin-top: 0.75rem;">
                <button class="action-pill" type="button" ${isSaving ? "disabled" : ""}
                  data-movie-mark-watched="${escapeAttribute(String(tmdbId))}"
                  data-movie-title="${escapeAttribute(movieTitle)}"
                  data-movie-poster="${escapeAttribute(posterUrl)}"
                  data-movie-release="${escapeAttribute(tmdbData.release_date || "")}">${isSavingThisMovie ? "Saving watched state…" : "Mark watched"}</button>
              </div>
            </section>
          </div>
        </div>
        ${renderMediaFacts(tmdbData, "movie", "sidebar")}
      </header>
      ${renderCastSection(tmdbData)}
      ${renderMediaImagesSection(tmdbData)}
      ${renderTrailersSection(tmdbData)}
      ${renderReviewsSection(tmdbData)}
      ${renderCollectionSection(tmdbData)}
      ${renderRecommendationSection({ title: "Recommended movies", items: recommendations, mediaType: "movie" })}
      ${renderRecommendationSection({ title: "Recommended TV Shows", items: tvRecommendations, mediaType: "tv" })}
    </div>
  `;

  // Render immediately with TMDB data — no waiting for TV recs.
  root.innerHTML = buildUnwatchedHtml([]);
  hydratePosters(root);
  hydrateMediaAppLinks(root);
  fetchSeerrMediaStatus("movie", tmdbId)
    .then((status) => { if (status) refreshActiveMediaDetailAfterSeerrStatus("movie", tmdbId); });

  // Fetch TV recommendations non-blocking and patch the page when ready.
  recommendedTvShowsForMovie(movieTitle, tmdbData).then((tvRecommendations) => {
    if (!tvRecommendations.length) return;
    // Only patch if still on this page.
    if (String(state.activeMovieTmdbId) !== String(tmdbId)) return;
    root.innerHTML = buildUnwatchedHtml(tvRecommendations);
    hydratePosters(root);
    hydrateMediaAppLinks(root);
  }).catch(() => {/* non-fatal */});
}
