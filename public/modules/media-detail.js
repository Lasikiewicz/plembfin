import { state, elements } from "./state.js";
import { slug, movieSlug, movieHref, showName, showTitleFrom } from "./utils.js";
import { dedupeMediaRecords } from "./dashboard.js";
import { isWatchedHistoryAction } from "./sync.js";
import {
  initMediaDetail, authHeaders, mediaDetailRoot, setMediaDetailActions,
  prepareInlineMediaDetail, syncMediaActionsMenuState, syncTopbarControlsMenuState,
  openDebugModal, closeDebugModal, clearMediaDetailState, closeMediaDetail,
} from "./media-detail-context.js";
import {
  openShowImmersiveModalByTitle, openShowImmersiveModalByTmdbId, openShowInlineDetail,
  renderImmersiveShowModal, renderShowModalContent,
} from "./media-detail-show.js";
import {
  renderMovieImmersiveModalContent, openMovieImmersiveModalByTmdbId,
} from "./media-detail-movie.js";
import { fetchSeerrMediaStatus, refreshActiveMediaDetailAfterSeerrStatus } from "./media-detail-shared.js";

export {
  initMediaDetail,
  mediaDetailRoot,
  syncMediaActionsMenuState,
  syncTopbarControlsMenuState,
  closeDebugModal,
  clearMediaDetailState,
  closeMediaDetail,
  openShowInlineDetail,
  renderImmersiveShowModal,
  renderShowModalContent,
  openShowImmersiveModalByTmdbId,
  renderMovieImmersiveModalContent,
  openMovieImmersiveModalByTmdbId,
  fetchSeerrMediaStatus,
  refreshActiveMediaDetailAfterSeerrStatus,
};

export function historyById(id) {
  return state.history.find((entry) => String(entry.id) === String(id));
}
export function movieById(id) {
  return state.history.find((entry) => String(entry.id) === String(id)) ||
    state.moviesRaw.find((entry) => String(entry.id) === String(id)) ||
    state.activeSessions.find((entry) => String(entry.id || entry.key) === String(id));
}
export function movieBySlugOrId(value) {
  const key = decodeURIComponent(String(value || ""));
  const keySlug = slug(key);
  return movieById(key) ||
    state.moviesRaw.find((entry) => movieSlug(entry) === keySlug) ||
    state.history.find((entry) => entry.media_type === "movie" && movieSlug(entry) === keySlug) ||
    null;
}
function movieSearchFromRouteValue(value) {
  return decodeURIComponent(String(value || ""))
    .replace(/^tmdb\/\d+$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
async function fetchMovieBySlugOrId(value) {
  const key = decodeURIComponent(String(value || ""));
  const keySlug = slug(key);
  const search = movieSearchFromRouteValue(key);
  if (!search) return null;
  try {
    const url = new URL("/api/movies", window.location.origin);
    url.searchParams.set("search", search);
    url.searchParams.set("limit", "30");
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return null;
    const movies = Array.isArray(body.movies) ? body.movies : [];
    const movie = movies.find((entry) => movieSlug(entry) === keySlug) || movies[0] || null;
    if (movie) {
      state.moviesRaw = dedupeMediaRecords([...state.moviesRaw, movie], "movies");
    }
    return movie;
  } catch {
    return null;
  }
}
export async function resolveMovieBySlugOrId(value) {
  return movieBySlugOrId(value) || fetchMovieBySlugOrId(value);
}
export function nowPlayingHref(session = {}) {
  const mediaType = session.mediaType || (session.season != null || session.episode != null ? "tv" : "movie");
  const tmdbId = session.ids?.tmdb || session.tmdb_id || session.tmdbId || "";
  if (mediaType === "tv" || mediaType === "tvshow" || mediaType === "show" || mediaType === "episode") {
    if (tmdbId) return `/tvshow/tmdb/${tmdbId}`;
    const title = showName(session.showTitle || session.show_title || session.title || "");
    return `/tvshow/${slug(title)}`;
  }
  if (tmdbId) return `/movie/tmdb/${tmdbId}`;
  const movie = movieBySlugOrId(session.id || session.key || session.title || "") || {
    id: session.id || session.key || session.title || "",
    title: session.title || session.movieTitle || "Movie",
  };
  return movieHref(movie);
}

export async function openImmersiveModal(id) {
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
    <div class="immersive-container media-detail-page">
      ${!state.mediaDetailInline ? '<button class="immersive-back-button" type="button">← Back</button>' : ''}
      <div style="display: flex; justify-content: center; align-items: center; min-height: 200px;">
        <span class="status-pill status-ready" style="font-size: 1rem; padding: var(--space-2) var(--space-4);">Loading details...</span>
      </div>
    </div>
  `;
  let entry = movieById(id);
  if (!entry) {
    try {
      const response = await fetch(`/api/history?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.row) {
        entry = body.row;
      }
    } catch (error) {
      console.error("Failed to fetch watch history item", error);
    }
  }
  if (!entry) {
    root.innerHTML = `
      <div class="immersive-container">
        ${!state.mediaDetailInline ? '<button class="immersive-back-button" type="button">← Back</button>' : ''}
        <div style="display: flex; justify-content: center; align-items: center; min-height: 200px; flex-direction: column; gap: var(--space-2);">
          <span style="color: var(--danger); font-size: 1.1rem; font-weight: bold;">Content not found</span>
          <span style="color: var(--muted); font-size: 0.9rem;">Could not locate this watch history record.</span>
        </div>
      </div>
    `;
    return;
  }
  if (!isWatchedHistoryAction(entry)) {
    openDebugModal(entry);
    return;
  }
  if (entry.media_type === "episode") {
    const showTitle = entry.show_title || showTitleFrom(entry.title);
    await openShowImmersiveModalByTitle(showTitle, entry);
  } else {
    await renderMovieImmersiveModalContent(entry);
  }
}
export async function openHistoryDebugModal(id) {
  const response = await fetch(`/api/history?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `History detail failed with ${response.status}`);
  openDebugModal(body.row || historyById(id));
}

export async function openMovieImmersiveModal(id) {
  await openImmersiveModal(id);
}
export async function openMovieInlineDetail(id) {
  prepareInlineMediaDetail("movies");
  const movie = await resolveMovieBySlugOrId(id);
  if (movie) {
    await renderMovieImmersiveModalContent(movie);
    return;
  }
  await openImmersiveModal(id);
}
export async function openRecommendedMovieInlineDetail(tmdbId) {
  prepareInlineMediaDetail("movies");
  await openMovieImmersiveModalByTmdbId(tmdbId);
}
