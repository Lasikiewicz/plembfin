import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, formatDate, formatTmdbDate } from "./utils.js";
import { posterUrlFor, tmdbPoster, bestTmdbLogo, hydratePosters } from "./images.js";
import { isWatchedHistoryAction, getMediaTargetSyncStatus, renderSyncStatusDot } from "./sync.js";
import { fetchTmdbDetails } from "./tmdb.js?v=20260626";
import { renderWatchDatePrompt } from "./watch-action.js";
import { authHeaders, mediaDetailRoot, setMediaDetailActions, bumpMediaRenderToken, currentMediaRenderToken } from "./media-detail-context.js";
import {
  renderCastSection, renderRichTmdbDetails, renderMediaImagesSection, renderMediaFacts,
  renderExternalRatingPills, ratingPillHtml, renderSeerrRequestPill, fetchSeerrMediaStatus,
  refreshActiveMediaDetailAfterSeerrStatus, rankedRecommendations, recommendedTvShowsForMovie,
  renderRecommendationSection,
} from "./media-detail-shared.js";

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
    return movies.find((movie) => String(movie.tmdb_id || "") === String(tmdbId)) || null;
  } catch {
    return null;
  }
}

export async function renderMovieImmersiveModalContent(movie) {
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
  const ytWatchBtn = movie.youtube_url
    ? `<a class="action-pill" href="${escapeAttribute(movie.youtube_url)}" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>`
    : "";

  setMediaDetailActions(`
    <details class="media-actions-menu">
      <summary class="action-pill media-actions-menu-trigger">Movie actions</summary>
      <div class="media-actions-menu-panel">
        <button class="action-pill action-pill-ghost" type="button" ${isSaving ? "disabled" : ""} data-unwatch-id="${escapeAttribute(movie.id)}" data-unwatch-kind="movie" data-unwatch-label="${escapeAttribute(movie.title || "this movie")}">Mark unwatched</button>
        <button class="action-pill media-edit-image-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-poster-url="${escapeAttribute(movie.poster_url || "")}" data-logo-url="${escapeAttribute(movie.logo_url || "")}" data-backdrop-url="${escapeAttribute(movie.backdrop_url || "")}">Edit Images</button>
        <button class="action-pill media-fix-match-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-title="${escapeAttribute(movie.title || "")}" data-media-type="movie">Fix Match</button>
        <button class="action-pill action-pill-danger" type="button" ${isSaving ? "disabled" : ""} data-delete-media-id="${escapeAttribute(movie.id)}" data-delete-media-title="${escapeAttribute(movie.title || "this movie")}">Delete</button>
      </div>
    </details>
    ${ytWatchBtn}
  `);

  root.innerHTML = `
    <div class="modal-backdrop-image" style="background-image: url('${escapeAttribute(backdropUrl || posterUrl || localPoster)}');"></div>
    <div class="immersive-container media-detail-page${loading ? " is-loading-metadata" : ""}">
      <header class="immersive-header">
        <img class="immersive-poster-img" src="${escapeAttribute(posterUrl || localPoster)}" alt="${escapeHtml(movieTitle)} poster" data-err="fav" />
        <div class="immersive-meta">
          ${logoUrl ? `<img class="immersive-logo" src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(movieTitle)}" /><h2 class="immersive-title sr-only">${escapeHtml(movieTitle)}</h2>` : `<h2 class="immersive-title">${escapeHtml(movieTitle)}</h2>`}
          <p class="immersive-subtitle">${escapeHtml(released)}${youtubeMeta?.channelName ? ` &middot; ${escapeHtml(youtubeMeta.channelName)}` : ""}</p>
          <div class="ratings-row" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            ${ratingBadgeHtml || (tmdbData ? renderExternalRatingPills("movie", tmdbData, movieTitle) : "")}
            ${imdbPillHtml}
            ${renderSeerrRequestPill("movie", tmdbData?.id || movie.tmdb_id, true)}
            ${syncStatusBlockHtml}
          </div>
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
          </section>
        </div>
        ${renderMediaFacts(tmdbData, "movie", "sidebar")}
      </header>
      ${tmdbData ? renderCastSection(tmdbData) : ""}
      ${tmdbData ? renderRichTmdbDetails(tmdbData) : ""}
      ${tmdbData ? renderMediaImagesSection(tmdbData) : ""}
      ${renderRecommendationSection({ title: "Recommended movies", items: recommendations, mediaType: "movie" })}
      ${renderRecommendationSection({ title: "Recommended TV Shows", items: tvRecommendations, mediaType: "tv" })}
    </div>
    ${renderWatchDatePrompt(state.pendingWatchAction)}
  `;
  hydratePosters(root);
}

export async function openMovieImmersiveModalByTmdbId(tmdbId) {
  state.activeMovieTmdbId = String(tmdbId);
  // Fast path: if it's in the loaded preview, show its watched detail immediately.
  const existingWatched = state.history.find(
    (entry) => entry.media_type === "movie" && isWatchedHistoryAction(entry) && String(entry.tmdb_id || "") === String(tmdbId),
  );
  if (existingWatched) return renderMovieImmersiveModalContent(existingWatched);
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
      <div style="display: flex; justify-content: center; align-items: center; min-height: 200px;">
        <span class="status-pill status-ready" style="font-size: 1rem; padding: var(--space-2) var(--space-4);">Loading movie details...</span>
      </div>
    </div>
  `;
  const tmdbData = await fetchTmdbDetails("movie", tmdbId, null);
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
          <div class="ratings-row" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            ${ratingBadgeHtml || renderExternalRatingPills("movie", tmdbData, movieTitle)}
            ${renderSeerrRequestPill("movie", tmdbId, false)}
          </div>
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
      </header>
      ${renderMediaFacts(tmdbData, "movie")}
      ${renderCastSection(tmdbData)}
      ${renderRichTmdbDetails(tmdbData)}
      ${renderRecommendationSection({ title: "Recommended movies", items: recommendations, mediaType: "movie" })}
      ${renderRecommendationSection({ title: "Recommended TV Shows", items: tvRecommendations, mediaType: "tv" })}
    </div>
  `;

  // Render immediately with TMDB data — no waiting for TV recs.
  root.innerHTML = buildUnwatchedHtml([]);
  hydratePosters(root);
  fetchSeerrMediaStatus("movie", tmdbId)
    .then((status) => { if (status) refreshActiveMediaDetailAfterSeerrStatus("movie", tmdbId); });

  // Fetch TV recommendations non-blocking and patch the page when ready.
  recommendedTvShowsForMovie(movieTitle, tmdbData).then((tvRecommendations) => {
    if (!tvRecommendations.length) return;
    // Only patch if still on this page.
    if (String(state.activeMovieTmdbId) !== String(tmdbId)) return;
    root.innerHTML = buildUnwatchedHtml(tvRecommendations);
    hydratePosters(root);
  }).catch(() => {/* non-fatal */});
}
