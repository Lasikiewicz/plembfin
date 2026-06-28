import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, sanitizeTitle, safeImageUrl, slug, movieSlug, movieHref, showName, showTitleFrom, episodeTitle, formatNumber, formatDate, formatTmdbDate, formatLongAiringDate, formatEpisodeAirtime, toDateInputValue, showEpisodeKey, episodeCode, seasonLabel, platformName, platformBadge, sourceClass } from "./utils.js";
import { posterUrlFor, posterMarkup, tmdbImage, tmdbPoster, bestTmdbLogo, tmdbProfile, hydratePosters } from "./images.js";
import { isWatchedHistoryAction, historyAction, syncStatus, getMediaTargetSyncStatus, renderSyncStatusDot, renderAvailabilityPills, renderShowAvailabilityPills, renderMediaSyncPills } from "./sync.js";
import { mergeShowDetail, loadShowDetail, seasonsFromShowRecord, representativeEpisode, tmdbLookupIdsFromShow, syncInlineMediaDetailHeading } from "./explorer.js";
import { dedupeMediaRecords } from "./dashboard.js";
import { fetchTmdbDetails, fetchTmdbSeasonDetails } from "./tmdb.js?v=20260626";
import { renderWatchDatePrompt } from "./watch-action.js";
let _cb = {};
let _playbackProgressRows = [];
let _playbackProgressLoaded = false;
let _playbackProgressLoadPromise = null;
const _seasonDetailsInflight = new Set();
export function initMediaDetail(callbacks = {}) {
  _cb = callbacks;
}
function authHeaders() {
  return buildAuthHeaders(state.token);
}
function setMessage(text, tone = "muted") { _cb.setMessage?.(text, tone); }
function navigateTo(url) { _cb.navigateTo?.(url); }
function selectView(view) { _cb.selectView?.(view); }
function syncPageTopbar() { _cb.syncPageTopbar?.(); }
function renderExplorer() { _cb.renderExplorer?.(); }
function renderSearchPage() { _cb.renderSearchPage?.(); }
function loadExplorerMovies() { return _cb.loadExplorerMovies?.() ?? Promise.resolve(); }
function loadExplorerShows() { return _cb.loadExplorerShows?.() ?? Promise.resolve(); }
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
export async function openShowImmersiveModalByTitle(showTitle, seedEpisode = null, requestedSeason = null) {
  const normalizedTitle = showName(showTitle);
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
      <div style="display: flex; justify-content: center; align-items: center; min-height: 200px;">
        <span class="status-pill status-ready" style="font-size: 1rem; padding: var(--space-2) var(--space-4);">Loading show details...</span>
      </div>
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
// Request coalescer: explorer grids ask for TMDB details one card at a time, which
export function renderCastSection(tmdbData) {
  const cast = tmdbData?.credits?.cast || [];
  if (!cast.length) return "";
  return `
    <section class="seasons-section cast-section">
      <div class="show-section-title"><h3>Cast</h3></div>
      <div class="cast-compact-row cast-scroll-row">
        ${cast.slice(0, 20).map((actor) => {
    const avatarUrl = tmdbProfile(actor.profile_path) || "/favicon.svg";
    return `
            <div class="cast-member-card" style="cursor: pointer;" data-person-id="${actor.id}" data-person-name="${escapeAttribute(actor.name)}">
              <img class="cast-avatar-img" src="${escapeAttribute(avatarUrl)}" alt="${escapeAttribute(actor.name)}" data-err="fav" />
              <span class="cast-actor-name">${escapeHtml(actor.name)}</span>
              <span class="cast-character-name">${escapeHtml(actor.character)}</span>
            </div>
          `;
  }).join("")}
      </div>
    </section>
  `;
}
export function renderTrailersReviewsSection(tmdbData) {
  if (!tmdbData) return "";
  const trailers = (tmdbData.videos?.results || []).filter((v) => v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser"));
  const reviews = tmdbData.reviews?.results || [];
  let html = "";
  if (trailers.length > 0) {
    html += `
      <section class="seasons-section trailers-section">
        <div class="show-section-title"><h3>Trailers & Clips</h3><span>${trailers.length} available</span></div>
        <div class="horizontal-scroll-row trailer-scroll-row" style="margin-top: 0.5rem;">
          ${trailers.map((video) => `
            <div class="trailer-card">
              <div class="trailer-thumb-container" data-video-key="${video.key}" data-video-name="${escapeAttribute(video.name)}">
                <img class="trailer-thumb" src="https://img.youtube.com/vi/${video.key}/mqdefault.jpg" alt="${escapeAttribute(video.name)}" data-err="fav" />
                <div class="play-overlay"><svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>
              </div>
              <span class="trailer-title" title="${escapeAttribute(video.name)}">${escapeHtml(video.name)}</span>
            </div>
          `).join("")}
        </div>
      </section>
    `;
  }
  if (reviews.length > 0) {
    html += `
      <section class="seasons-section reviews-section">
        <div class="show-section-title"><h3>Reviews</h3><span>${reviews.length} reviews</span></div>
        <div class="review-list" style="margin-top: 0.5rem;">
          ${reviews.slice(0, 3).map((review) => {
      const hasLong = review.content?.length > 300;
      return `
              <div class="review-card">
                <div class="review-header">
                  <span class="review-author">${escapeHtml(review.author)}</span>
                  ${review.author_details?.rating ? `<span class="review-rating">★ ${review.author_details.rating}/10</span>` : ""}
                </div>
                <div class="review-content-wrapper"><p class="review-content">${escapeHtml(review.content)}</p></div>
                ${hasLong ? `<button class="action-pill review-toggle-btn" type="button">Read More</button>` : ""}
              </div>
            `;
    }).join("")}
        </div>
      </section>
    `;
  }
  return html;
}
export function renderRelatedShowsSection(tmdbData) {
  const related = tmdbData?.similar?.results || [];
  if (!related.length) return "";
  return `
    <section class="seasons-section related-section">
      <div class="show-section-title"><h3>Related Shows</h3></div>
      <div class="horizontal-scroll-row" style="margin-top: 0.5rem;">
        ${related.slice(0, 20).map((item) => {
    const poster = tmdbPoster(item.poster_path) || "/favicon.svg";
    const year = (item.first_air_date || "").slice(0, 4);
    return `
            <a class="season-poster-card related-show-card" data-immersive-related-tmdb="${item.id}" href="/tvshow/tmdb/${item.id}">
              <img class="season-poster-img" src="${escapeAttribute(poster)}" alt="${escapeAttribute(item.name || "")}" data-err="fav" />
              <span class="season-poster-name">${escapeHtml(item.name || "")}${year ? ` <small>(${escapeHtml(year)})</small>` : ""}</span>
            </a>
          `;
  }).join("")}
      </div>
    </section>
  `;
}

function recommendationTitle(item = {}, mediaType = "movie") {
  return mediaType === "tv" ? (item.name || item.original_name || "") : (item.title || item.original_title || "");
}

function recommendationDate(item = {}, mediaType = "movie") {
  return mediaType === "tv" ? (item.first_air_date || "") : (item.release_date || "");
}

function rankedRecommendations(tmdbData, mediaType = "movie", { includeSource = false } = {}) {
  const ranked = [];
  const add = (items = [], sourceRank = 0) => {
    items.forEach((item, index) => {
      if (!item?.id) return;
      ranked.push({ ...item, _sourceRank: sourceRank, _sourceIndex: index });
    });
  };

  if (includeSource && tmdbData?.id) add([tmdbData], 0);
  add(tmdbData?.similar?.results || [], includeSource ? 1 : 0);
  add(tmdbData?.recommendations?.results || [], includeSource ? 2 : 1);

  const byId = new Map();
  for (const item of ranked) {
    const key = String(item.id);
    const existing = byId.get(key);
    if (!existing || item._sourceRank < existing._sourceRank || (item._sourceRank === existing._sourceRank && item._sourceIndex < existing._sourceIndex)) {
      byId.set(key, item);
    }
  }

  return [...byId.values()]
    .sort((a, b) => a._sourceRank - b._sourceRank || a._sourceIndex - b._sourceIndex)
    .filter((item) => recommendationTitle(item, mediaType));
}

function titleCandidatesForTvRecommendations(movieTitle, tmdbData = null) {
  const candidates = [];
  const add = (title) => {
    const cleaned = String(title || "")
      .replace(/\s*\([^)]*\)\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned && !candidates.some((candidate) => slug(candidate) === slug(cleaned))) candidates.push(cleaned);
  };

  add(tmdbData?.title);
  add(tmdbData?.original_title);
  add(movieTitle);
  for (const title of [...candidates]) {
    const colonBase = title.split(":")[0]?.trim();
    if (colonBase && colonBase.length >= 4) add(colonBase);
  }
  return candidates.slice(0, 4);
}

function titlesLookRelated(movieTitle, tvTitle) {
  const movieSlug = slug(movieTitle || "");
  const tvSlug = slug(tvTitle || "");
  if (!movieSlug || !tvSlug) return false;
  return movieSlug === tvSlug || movieSlug.startsWith(`${tvSlug}-`) || tvSlug.startsWith(`${movieSlug}-`) || movieSlug.includes(tvSlug) || tvSlug.includes(movieSlug);
}

async function recommendedTvShowsForMovie(movieTitle, tmdbData = null) {
  for (const candidate of titleCandidatesForTvRecommendations(movieTitle, tmdbData)) {
    const tvData = await fetchTmdbDetails("tv", null, candidate).catch(() => null);
    const tvTitle = recommendationTitle(tvData, "tv");
    if (!tvData?.id || !titlesLookRelated(candidate, tvTitle)) continue;
    return rankedRecommendations(tvData, "tv", { includeSource: true }).slice(0, 15);
  }
  return [];
}

function renderRecommendationSection({ title, items = [], mediaType = "movie" }) {
  if (!items.length) return "";
  const isTv = mediaType === "tv";
  return `
        <section class="seasons-section">
          <h3>${escapeHtml(title)}</h3>
          <div class="horizontal-scroll-row">
            ${items.slice(0, 15).map((item) => {
    const itemTitle = recommendationTitle(item, mediaType);
    const year = recommendationDate(item, mediaType).slice(0, 4);
    const poster = item.poster_path ? tmdbPoster(item.poster_path, item.id, mediaType) : "/favicon.svg";
    return `
                  <a class="season-poster-card" ${isTv ? `data-immersive-related-tmdb="${escapeAttribute(String(item.id))}" href="/tvshow/tmdb/${escapeAttribute(String(item.id))}"` : `data-immersive-movie-id="${escapeAttribute(String(item.id))}" href="/movie/tmdb/${escapeAttribute(String(item.id))}"`}>
                    <img class="season-poster-img" src="${escapeAttribute(poster)}" alt="${escapeAttribute(itemTitle)}" data-err="fav" />
                    <span class="season-poster-name">${escapeHtml(itemTitle)}${year ? ` <small>(${escapeHtml(year)})</small>` : ""}</span>
                  </a>
                `;
  }).join("")}
          </div>
        </section>
      `;
}
export function renderRichTmdbDetails(tmdbData) {
  return renderTrailersReviewsSection(tmdbData);
}
export function renderMediaImagesSection(tmdbData) {
  if (!tmdbData?.images) return "";
  const seen = new Set();
  const dedupe = (imgs) => imgs.filter((img) => {
    if (!img.file_path || seen.has(img.file_path)) return false;
    seen.add(img.file_path);
    return true;
  });
  // Prefer language-neutral backdrops (no text overlay); fall back to all if too few.
  const raw = tmdbData.images.backdrops || [];
  const clean = dedupe(raw.filter((img) => !img.iso_639_1));
  const backdrops = (clean.length >= 3 ? clean : dedupe(raw))
    .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))
    .slice(0, 20);
  if (!backdrops.length) return "";
  return `
    <section class="seasons-section media-images-section">
      <div class="show-section-title"><h3>Images</h3><span>${backdrops.length} available</span></div>
      <div class="media-images-scroll-row">
        ${backdrops.map((img, i) => {
    const thumb = tmdbImage(img.file_path, "w780");
    const full = tmdbImage(img.file_path, "original");
    return `<button class="media-image-card" type="button" data-lightbox-index="${i}" data-lightbox-src="${escapeAttribute(full)}">
            <img class="media-image-thumb" src="${escapeAttribute(thumb)}" alt="Scene image" loading="lazy" data-err="hide-parent" />
          </button>`;
  }).join("")}
      </div>
    </section>
  `;
}
export function renderMediaFacts(tmdbData, mediaType = "movie", placement = "inline") {
  if (!tmdbData) return "";
  const providers = tmdbData["watch/providers"]?.results?.GB?.flatrate || tmdbData["watch/providers"]?.results?.US?.flatrate || [];
  const runtime = mediaType === "movie"
    ? (tmdbData.runtime ? `${tmdbData.runtime} min` : "")
    : (tmdbData.episode_run_time?.[0] ? `${tmdbData.episode_run_time[0]} min episodes` : "");
  const facts = [
    ["Status", tmdbData.status],
    [mediaType === "movie" ? "Release" : "First aired", formatTmdbDate(tmdbData.release_date || tmdbData.first_air_date)],
    ["Runtime", runtime],
    ["Language", String(tmdbData.original_language || "").toUpperCase()],
    ["Genres", (tmdbData.genres || []).map((genre) => genre.name).join(", ")],
    ["Network", (tmdbData.networks || []).map((network) => network.name).join(", ")],
    ["Streaming", providers.map((provider) => provider.provider_name).join(", ")],
  ].filter(([, value]) => value);
  if (!facts.length) return "";
  const wideLabels = new Set(["Streaming", "Network"]);
  return `<aside class="media-facts-rail ${placement === "sidebar" ? "media-facts-rail--sidebar" : ""}" aria-label="Media facts">${facts.map(([label, value]) => `
    <div class="media-fact${wideLabels.has(label) ? " media-fact--wide" : ""}"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>
  `).join("")}</aside>`;
}
export function tmdbTitleUrl(mediaType, tmdbId) {
  const id = String(tmdbId || "");
  if (!id) return "";
  return `https://www.themoviedb.org/${mediaType === "tv" ? "tv" : "movie"}/${encodeURIComponent(id)}`;
}
export function ratingPillHtml({ label, value = "View", href = "", title = "" } = {}) {
  if (!label || !href) return "";
  return `
    <a class="rating-pill rating-pill-link" href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer" title="${escapeAttribute(title || `${label} rating`)}">
      <span>${escapeHtml(label)}</span>
      <span>${escapeHtml(value)}</span>
    </a>
  `;
}
export function tvAvailabilityLabel(status = {}) {
  const total = Number(status.totalEpisodes || 0);
  const available = Number(status.availableEpisodes || 0);
  if (!total) return status.available ? "Available" : "";
  if (available >= total) return `${available}/${total} Available in 1080p`;
  if (available > 0) return `${available}/${total} Available in 1080p`;
  return "";
}
export function tvAvailability4kLabel(status = {}) {
  const total = Number(status.totalEpisodes || 0);
  const available4k = Number(status.available4kEpisodes || 0);
  if (!total) return status.available4k ? "Available in 4K" : "";
  if (available4k >= total) return `${available4k}/${total} Available in 4K`;
  if (available4k > 0) return `${available4k}/${total} Available in 4K`;
  return "";
}
export function tvSeasonAvailability(status = {}, seasonNumber) {
  return (status.seasons || []).find((season) => Number(season.seasonNumber) === Number(seasonNumber)) || null;
}
export function tvSeasonAvailabilityHtml(status = {}, seasonNumber) {
  if (!Array.isArray(status.seasons)) return "";
  const season = tvSeasonAvailability(status, seasonNumber);
  if (!season || !Number(season.released || season.total || 0)) return "";
  const total = Number(season.released || season.total || 0);
  const available = Number(season.available || 0);
  const available4k = Number(season.available4k || 0);
  const availabilityText = available >= total ? `All ${total} available` : `${available}/${total} available`;
  const fourKText = available4k >= total ? `All ${total} in 4K` : available4k > 0 ? `${available4k}/${total} in 4K` : "";
  return `
    <span class="season-availability-pill ${available >= total ? "is-complete" : available > 0 ? "is-partial" : "is-missing"}">${escapeHtml(availabilityText)}</span>
    ${fourKText ? `<span class="season-availability-pill is-4k ${available4k >= total ? "is-complete" : "is-partial"}">${escapeHtml(fourKText)}</span>` : ""}
  `;
}
export function renderSeasonSeerrControls(tmdbId, seasonNumber, status = {}) {
  if (!state.seerrConfigured || !tmdbId) return "";
  if (!Array.isArray(status.seasons)) return "";
  const season = tvSeasonAvailability(status, seasonNumber);
  const released = Number(season?.released || season?.total || 0);
  const missingStandard = !season || !released || Number(season.available || 0) < released;
  const missing4k = !season || !released || Number(season.available4k || 0) < released;
  const supports4k = state.seerrSupports4k.tv;
  return `
    <span class="season-request-controls">
      ${missingStandard ? `
        <button class="rating-pill seerr-request-btn season-seerr-request-btn" type="button"
          data-seerr-media-type="tv"
          data-seerr-media-id="${escapeAttribute(String(tmdbId))}"
          data-seerr-season="${escapeAttribute(String(seasonNumber))}">
          <span>Request season</span>
        </button>
      ` : ""}
      ${supports4k && missing4k ? `
        <button class="rating-pill seerr-request-btn seerr-request-btn-4k season-seerr-request-btn" type="button"
          data-seerr-media-type="tv"
          data-seerr-media-id="${escapeAttribute(String(tmdbId))}"
          data-seerr-season="${escapeAttribute(String(seasonNumber))}"
          data-seerr-request-4k="true">
          <span>Request 4K</span>
        </button>
      ` : ""}
    </span>
  `;
}
export function renderSeerrRequestPill(mediaType, tmdbId, localAvailable = false) {
  if (!state.seerrConfigured || !tmdbId) return "";
  const status = state.seerrMediaStatusCache.get(`${mediaType}:${tmdbId}`) || {};
  const isTv = mediaType === "tv";
  const isAvailable = Boolean(status.available);
  const supports4k = mediaType === "movie" ? state.seerrSupports4k.movie : state.seerrSupports4k.tv;
  const seerrBaseUrl = String(state.savedConfig?.seerr?.baseUrl || "").replace(/\/+$/, "");
  const seerrIconHtml = seerrBaseUrl
    ? `<img class="seerr-request-icon" src="${escapeAttribute(`${seerrBaseUrl}/favicon.ico`)}" alt="" loading="lazy" data-err="hide-show-next" />`
    : "";
  const iconAndFallback = `${seerrIconHtml}<span class="seerr-request-fallback" aria-hidden="true">S</span>`;
  const tvAvailableLabel = isTv ? tvAvailabilityLabel(status) : "";
  const tv4kLabel = isTv ? tvAvailability4kLabel(status) : "";
  // For whole-show TV 4K requests, embed the season numbers that are missing 4K so
  // Jellyseerr receives the required `seasons` field in the request payload.
  const tv4kSeasons = isTv && Array.isArray(status.seasons)
    ? status.seasons
        .filter((s) => Number(s.released || s.total || 0) > 0 && !s.available4k)
        .map((s) => s.seasonNumber)
    : [];
  return `
    <span id="seerrRequestContainer" style="display: inline-flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;" data-media-type="${escapeAttribute(mediaType)}" data-tmdb-id="${escapeAttribute(String(tmdbId))}" data-local-available="${localAvailable}">
      ${isAvailable ? `<span class="rating-pill seerr-owned-pill">${escapeHtml(isTv ? tvAvailableLabel || "Available" : "Available in 1080p")}</span>` : tvAvailableLabel ? `<span class="rating-pill seerr-owned-pill seerr-owned-pill-partial">${escapeHtml(tvAvailableLabel)}</span>` : `
        <button class="rating-pill seerr-request-btn" type="button"
          data-seerr-media-type="${escapeAttribute(mediaType)}"
          data-seerr-media-id="${escapeAttribute(String(tmdbId))}">
          ${iconAndFallback}
          <span>${status.pending ? "Requested on Seerr" : "Request on Seerr"}</span>
        </button>
      `}
      ${tv4kLabel ? `
        <span class="rating-pill seerr-owned-pill seerr-owned-pill-4k ${status.available4k ? "" : "seerr-owned-pill-partial"}">${escapeHtml(tv4kLabel)}</span>
      ` : supports4k && !status.available4k ? `
        <button class="rating-pill seerr-request-btn seerr-request-btn-4k" type="button"
          data-seerr-media-type="${escapeAttribute(mediaType)}"
          data-seerr-media-id="${escapeAttribute(String(tmdbId))}"
          data-seerr-request-4k="true"${tv4kSeasons.length ? ` data-seerr-seasons="${escapeAttribute(JSON.stringify(tv4kSeasons))}"` : ""}>
          ${iconAndFallback}
          <span>${status.pending4k ? "4K Requested" : "Request 4K"}</span>
        </button>
      ` : status.available4k ? `
        <span class="rating-pill seerr-owned-pill seerr-owned-pill-4k">${escapeHtml(isTv ? tv4kLabel || "Available in 4K" : "Available in 4K")}</span>
      ` : ""}
    </span>
  `;
}
export function fetchSeerrMediaStatus(mediaType, tmdbId) {
  if (!state.seerrConfigured || !tmdbId) return Promise.resolve(null);
  const cacheKey = `${mediaType}:${tmdbId}`;
  if (state.seerrMediaStatusCache.get(cacheKey)?.loading) return Promise.resolve(null);
  state.seerrMediaStatusCache.set(cacheKey, { ...(state.seerrMediaStatusCache.get(cacheKey) || {}), loading: true });
  return fetch(`/api/seerr/media-status?mediaType=${encodeURIComponent(mediaType)}&mediaId=${encodeURIComponent(tmdbId)}`, { headers: authHeaders() })
    .then((response) => response.json().then((body) => ({ response, body })).catch(() => ({ response, body: {} })))
    .then(({ response, body }) => {
      if (!response.ok || !body.ok) throw new Error(body.error || `Seerr status failed with ${response.status}`);
      state.seerrMediaStatusCache.set(cacheKey, { ...body, loading: false });
      return body;
    })
    .catch(() => {
      state.seerrMediaStatusCache.set(cacheKey, { loading: false });
      return null;
    });
}
export function refreshActiveMediaDetailAfterSeerrStatus(mediaType, tmdbId) {
  const container = document.getElementById("seerrRequestContainer");
  if (container && container.getAttribute("data-media-type") === mediaType && String(container.getAttribute("data-tmdb-id")) === String(tmdbId)) {
    const localAvailable = container.getAttribute("data-local-available") === "true";
    container.outerHTML = renderSeerrRequestPill(mediaType, tmdbId, localAvailable);
  }
}
export function renderExternalRatingPills(mediaType, tmdbData, title, rating = "") {
  const tmdbId = tmdbData?.id || tmdbData?.tmdb_id || "";
  const pills = [];
  if (rating) {
    pills.push(ratingPillHtml({
      label: "TMDB",
      value: rating,
      href: tmdbTitleUrl(mediaType, tmdbId),
      title: "Open this title on TMDB",
    }));
  }
  return pills.join("");
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
      <div style="display: flex; justify-content: center; align-items: center; min-height: 200px;">
        <span class="status-pill status-ready" style="font-size: 1rem; padding: var(--space-2) var(--space-4);">Loading TV show details...</span>
      </div>
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

  renderShowModalContent(show, {
    activeSeasonNum: state.activeShowModalSeason,
    tmdbData,
    seasonDetailsByNumber,
    loading: false,
    tmdbOnly: !existingShow,
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

  for (const season of seasonsList.filter((item) => Number(item.season_number) > 0)) {
    const seasonNumber = Number(season.season_number);
    const tmdbSeason = seasonDetailsByNumber.get(seasonNumber);
    const tmdbEpisodes = Array.isArray(tmdbSeason?.episodes) ? tmdbSeason.episodes : [];
    const fallbackPosterUrl = tmdbPoster(season.poster_path) || posterUrlFor(representativeEpisode(localSeasons));

    if (tmdbEpisodes.length) {
      const knownEpNums = new Set();
      for (const episode of tmdbEpisodes) {
        const episodeNumber = Number(episode.episode_number);
        knownEpNums.add(episodeNumber);
        const watched = watchedMap.get(showEpisodeKey(seasonNumber, episodeNumber));
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

function showModalStatus(loading, hasTmdbKey, hasTmdbData) {
  if (loading) return `<span class="show-load-pill">Loading episode metadata...</span>`;
  if (!hasTmdbKey) return `<span class="show-load-pill muted">Add a TMDB API key to load all seasons and episode synopses.</span>`;
  if (!hasTmdbData) return `<span class="show-load-pill muted">TMDB episode metadata was unavailable.</span>`;
  return "";
}

function showSeasonSummary(seasonNumber, seasonEpisodes, season, showTitle = "", tmdbData = null) {
  const watchedInSeason = seasonEpisodes.filter((episode) => episode.watched).length;
  const seasonTotal = Math.max(seasonEpisodes.length, Number(season.episode_count || 0));
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
  const hasTmdbKey = Boolean(state.savedConfig.tmdb?.configured);
  const seasonsList = [...(tmdbData?.seasons?.length ? tmdbData.seasons : fallbackSeasonList(seasonsMap))]
    .filter((season) => Number(season.season_number) > 0)
    .sort((a, b) => Number(b.season_number) - Number(a.season_number));
  const selectedSeason = activeSeasonNum == null ? null : Number(activeSeasonNum);
  const episodeRows = buildShowEpisodeRows(show, seasonsList, seasonDetailsByNumber, tmdbData?.id || show.tmdb_id || "", tmdbData);
  const watchedRows = episodeRows.filter((episode) => episode.watched);
  const metadataEpisodeCount = seasonsList.reduce((total, season) => total + Number(season.episode_count || 0), 0);
  const totalCount = Math.max(episodeRows.length, metadataEpisodeCount, watchedRows.length, 1);
  const watchedCount = watchedRows.length || [...watchedEpisodesByKey(show).keys()].length;
  const progressPercent = Math.max(0, Math.min(100, Math.round((watchedCount / totalCount) * 100)));
  const representative = representativeEpisode(seasonsMap);
  const backdropUrl = tmdbData?.cached_backdrop_url || tmdbImage(tmdbData?.backdrop_path, "original");
  const posterUrl = posterUrlFor(representative) || tmdbData?.cached_poster_url || tmdbPoster(tmdbData?.poster_path, tmdbData?.id, "tv");
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
  state.activeShowRenderContext = { show, activeSeasonNum, tmdbData, seasonDetailsByNumber, loading };

  const selectedSeasonRecord = selectedSeason == null
    ? null
    : seasonsList.find((season) => Number(season.season_number) === selectedSeason) || { season_number: selectedSeason };
  const selectedSeasonNumber = selectedSeasonRecord ? Number(selectedSeasonRecord.season_number) : null;
  const selectedSeasonEpisodes = selectedSeasonNumber == null
    ? []
    : episodeRows
      .filter((episode) => episode.seasonNumber === selectedSeasonNumber)
      .sort((a, b) => Number(a.episodeNumber || 0) - Number(b.episodeNumber || 0));
  const isUnreleased = (episode) => {
    if (episode.watched) return false;
    if (!episode.airDate) return false;
    const parts = episode.airDate.split("-");
    if (parts.length !== 3) return false;
    const air = new Date(parts[0], parts[1] - 1, parts[2]);
    return !Number.isNaN(air.getTime()) && air > new Date();
  };
  const selectedSeasonUnwatched = selectedSeasonEpisodes.filter((episode) => !episode.watched && !isUnreleased(episode));
  const unwatchedRows = episodeRows.filter((episode) => !episode.watched && !isUnreleased(episode));
  const selectedSeasonSummary = selectedSeasonRecord
    ? showSeasonSummary(selectedSeasonNumber, selectedSeasonEpisodes, selectedSeasonRecord, showTitle, tmdbData)
    : { watchedInSeason: 0, seasonTotal: 0 };
  const selectedSeasonSeerrControls = selectedSeasonRecord ? renderSeasonSeerrControls(tvSeerrTmdbId, selectedSeasonNumber, tvSeerrStatus) : "";
  const selectedSeasonEpisodesHtml = selectedSeasonRecord ? `
    <section class="show-season-block" id="showSeason${selectedSeasonNumber}">
      <div class="show-season-head">
        <span class="show-season-label">${selectedSeasonSummary.watchedInSeason} of ${selectedSeasonSummary.seasonTotal || "?"} episodes watched</span>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          ${selectedSeasonSeerrControls}
          ${selectedSeasonSummary.watchedInSeason ? `<button class="action-pill" type="button" data-edit-season-date="${selectedSeasonNumber}" ${isSaving ? "disabled" : ""}>Edit season date</button>` : ""}
          <button class="action-pill" type="button" data-watch-scope="season" data-season-number="${selectedSeasonNumber}" ${(selectedSeasonUnwatched.length && !isSaving) ? "" : "disabled"}>
            ${isSaving && isSaving.scope === "season" && Number(isSaving.episodes[0]?.seasonNumber) === Number(selectedSeasonNumber) ? "Saving…" : "Mark season watched"}
          </button>
        </div>
      </div>
      <div class="show-episode-list">
        ${selectedSeasonEpisodes.length ? selectedSeasonEpisodes.map((episode) => {
    const isHighlighted = (Number(episode.seasonNumber) === Number(selectedSeasonNumber)) && (Number(episode.episodeNumber) === Number(state.activeShowModalEpisode));
    const syncStatusDotHtml = episode.watched ? renderSyncStatusDot(episode.watched) : "";
    const episodeIsUnreleased = isUnreleased(episode);
    return `
            <article class="immersive-episode-row ${episode.watched ? "is-watched" : ""} ${episodeIsUnreleased ? "is-unreleased" : ""} ${isHighlighted ? "is-highlighted" : ""}" ${isHighlighted ? 'id="highlightedEpisode"' : ""} data-immersive-episode-num="${episode.episodeNumber}" data-immersive-season-num="${episode.seasonNumber}">
              ${episodeThumbMarkup(episode)}
              <div class="immersive-episode-copy">
                <div class="immersive-episode-title-row">
                  <b style="display: inline-flex; align-items: center; gap: 0.35rem;">
                    ${escapeHtml(episodeCode(episode.seasonNumber, episode.episodeNumber))} ${escapeHtml(episode.title)}
                    ${syncStatusDotHtml}
                    ${episodeProgressHtml(episode)}
                  </b>
                </div>
                <div class="immersive-episode-copy-wrap"><p>${escapeHtml(episode.overview)}</p></div>
                ${episodeProgressBarHtml(episode)}
                <div class="immersive-episode-meta-row">
                  <span class="immersive-episode-dates">
                    <time datetime="${escapeAttribute(episode.airDate || "")}">${escapeHtml(episodeReleaseLabel(episode.airDate))}</time>
                    ${episode.watched ? `<time>Watched ${formatDate(episode.watched.watched_at)} <button class="edit-date-icon-btn episode-edit-date-btn" type="button" title="Edit watch date" data-edit-id="${escapeAttribute(episode.watched.id)}" data-watched-at="${escapeAttribute(episode.watched.watched_at || "")}">✎</button></time>` : ""}
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
              </div>
            </article>
          `;
  }).join("") : `<div class="empty-log"><b>No episode rows yet</b><span>${loading ? "Episode metadata is loading." : "No local or TMDB episodes were found for this season."}</span></div>`}
      </div>
    </section>
  ` : "";

  hydrateMissingSeasonDetails(show, selectedSeasonNumber, tmdbData, seasonDetailsByNumber, loading);

  const seasonsAccordionHtml = seasonsList.map((season) => {
    const seasonNumber = Number(season.season_number);
    const seasonEpisodes = episodeRows.filter((episode) => episode.seasonNumber === seasonNumber);
    const { watchedInSeason, seasonTotal, nextAiringText } = showSeasonSummary(seasonNumber, seasonEpisodes, season, showTitle, tmdbData);
    const isActive = seasonNumber === selectedSeasonNumber;
    const panelId = `seasonAccordionPanel${seasonNumber}`;
    const seasonMetaText = `${seasonTotal || "?"} episode${seasonTotal === 1 ? "" : "s"}${watchedInSeason ? ` - ${watchedInSeason} watched` : ""}${nextAiringText ? ` - ${nextAiringText}` : ""}`;
    const seasonAvailabilityHtml = tvSeasonAvailabilityHtml(tvSeerrStatus, seasonNumber);
    return `
      <article class="season-accordion ${isActive ? "is-open" : ""}">
        <button class="season-accordion-trigger" type="button" data-season-accordion="${seasonNumber}" aria-expanded="${isActive}" aria-controls="${panelId}">
          <span class="season-accordion-title">
            <strong>${escapeHtml(season.name || seasonLabel(seasonNumber))}</strong>
            <span class="season-episode-count">${escapeHtml(seasonMetaText)}</span>
          </span>
          <span class="season-accordion-meta">
            ${seasonAvailabilityHtml}
            <svg class="season-accordion-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
        </button>
        ${isActive ? `<div class="season-accordion-panel" id="${panelId}">${selectedSeasonEpisodesHtml}</div>` : ""}
      </article>
    `;
  }).join("");

  const seasonsSectionHtml = seasonsList.length ? `
    <section class="seasons-section season-accordions">
      <div class="show-section-title">
        <h3>Seasons</h3>
        <span>${seasonsList.length} season${seasonsList.length === 1 ? "" : "s"}</span>
      </div>
      <div class="season-accordion-list">${seasonsAccordionHtml}</div>
    </section>
  ` : "";

  const showImdbId = show.imdb_id || representativeEpisode(seasonsMap)?.imdb_id || tmdbData?.external_ids?.imdb_id || "";
  const showImdbBasePill = showImdbId && !imdbPillHtml ? ratingPillHtml({ label: "IMDb", value: "View", href: `https://www.imdb.com/title/${escapeAttribute(showImdbId)}`, title: "Open on IMDb" }) : "";

  setMediaDetailActions(`
    <details class="media-actions-menu">
      <summary class="action-pill media-actions-menu-trigger">Show actions</summary>
      <div class="media-actions-menu-panel">
        <button class="action-pill" type="button" data-watch-scope="show" ${(unwatchedRows.length && !isSaving) ? "" : "disabled"}>
          ${isSavingShow ? "Saving watched state…" : "Mark whole show watched"}
        </button>
        ${watchedRows.length ? `<button class="action-pill media-edit-show-date-btn" type="button" ${isSaving ? "disabled" : ""} data-show-title="${escapeAttribute(showTitle)}">Edit Show Watch Date</button>` : ""}
        ${tmdbOnly ? "" : `
          <button class="action-pill media-edit-image-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(representativeEpisode(seasonsMap)?.id || show.id || "")}" data-poster-url="${escapeAttribute(show.poster_url || "")}" data-logo-url="${escapeAttribute(show.logo_url || "")}">Edit Images</button>
          <button class="action-pill media-fix-match-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(representativeEpisode(seasonsMap)?.id || show.id || "")}" data-title="${escapeAttribute(showTitle)}" data-media-type="tv">Fix Match</button>
          <button class="action-pill media-merge-show-btn" type="button" ${isSaving ? "disabled" : ""} data-show-title="${escapeAttribute(showTitle)}">Merge</button>
        `}
      </div>
    </details>
  `);

  root.innerHTML = `
    <div class="modal-backdrop-image" style="background-image: url('${escapeAttribute(backdropUrl || posterUrl || "")}');"></div>
    <div class="immersive-container media-detail-page">

      <header class="immersive-header">
        <img class="immersive-poster-img" src="${escapeAttribute(posterUrl || "/favicon.svg")}" alt="${escapeAttribute(showTitle)} poster" data-err="fav" />
        <div class="immersive-meta">
          ${logoUrl ? `<img class="immersive-logo" src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(showTitle)}" /><h2 class="immersive-title sr-only">${escapeHtml(showTitle)}</h2>` : `<h2 class="immersive-title">${escapeHtml(showTitle)}</h2>`}
          <div class="media-detail-bottom-stack">
            <div class="ratings-row" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
              ${ratingPillsHtml}
              ${imdbPillHtml || showImdbBasePill}
              ${showModalStatus(loading, hasTmdbKey, Boolean(tmdbData))}
              ${renderSeerrRequestPill("tv", tvSeerrTmdbId, showIsNowPlaying)}
            </div>

            <p class="immersive-overview">${escapeHtml(overview)}</p>

            <section class="progress-section" style="border: 0; padding-top: 0; margin-top: 0.5rem; width: 100%;">
              <h3>Progress</h3>
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

      ${renderTrailersReviewsSection(tmdbData)}
      ${renderMediaImagesSection(tmdbData)}
      ${renderRelatedShowsSection(tmdbData)}
    </div>
    ${renderWatchDatePrompt(state.pendingWatchAction)}
  `;
  if (tvSeerrTmdbId && !hasTvSeerrStatus) {
    fetchSeerrMediaStatus("tv", tvSeerrTmdbId)
      .then((status) => {
        if (!status || state.activeShowModalKey !== slug(show.title)) return;
        const current = state.activeShowRenderContext;
        if (current?.tmdbData && !current.loading) {
          renderShowModalContent(current.show, {
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
  const showImdbId = show.imdb_id || tmdbData?.external_ids?.imdb_id || "";
  let imdbPillHtml = "";
  if (showImdbId && state.savedConfig?.omdb?.configured) {
    const omdbRes = await fetch(`/api/omdb-rating?imdbId=${encodeURIComponent(showImdbId)}`, { headers: authHeaders() }).catch(() => null);
    if (omdbRes?.ok) {
      const omdbData = await omdbRes.json().catch(() => null);
      if (omdbData?.imdbRating) {
        imdbPillHtml = ratingPillHtml({
          label: "IMDb",
          value: `${Math.round(parseFloat(omdbData.imdbRating) * 10)}%`,
          href: `https://www.imdb.com/title/${escapeAttribute(showImdbId)}`,
          title: `IMDb rating: ${omdbData.imdbRating}/10`,
        });
      }
    }
    if (requestToken !== state.showModalRequestToken || state.activeShowModalKey !== showKey) return;
  }
  renderShowModalContent(show, { activeSeasonNum, tmdbData, seasonDetailsByNumber: new Map(), loading: true, imdbPillHtml });
  const seasonDetailsByNumber = new Map();
  if (tmdbData?.id && activeSeasonNum != null) {
    const seasonDetails = await fetchTmdbSeasonDetails(tmdbData.id, activeSeasonNum);
    if (seasonDetails) seasonDetailsByNumber.set(Number(activeSeasonNum), seasonDetails);
  }
  if (requestToken !== state.showModalRequestToken || state.activeShowModalKey !== showKey) return;
  renderShowModalContent(show, { activeSeasonNum, tmdbData, seasonDetailsByNumber, loading: false, imdbPillHtml });
}

export async function renderImmersiveShowModal(showKey, activeSeasonNum = null, activeEpisodeNum = null) {
  _mediaRenderToken += 1; // invalidate any in-flight movie render
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
        <div class="empty-log">
          <b>Loading show details...</b>
          <span>Loading TV series history.</span>
        </div>
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
  await ensurePlaybackProgressLoaded();
  if (requestToken !== state.showModalRequestToken || state.activeShowModalKey !== showKey) return;

  renderShowModalContent(show, {
    activeSeasonNum,
    tmdbData: null,
    seasonDetailsByNumber: new Map(),
    loading: Boolean(state.savedConfig.tmdb?.configured),
  });
  hydrateImmersiveShowModal(showKey, activeSeasonNum, requestToken).catch((error) => {
    console.error("Failed to hydrate show modal", error);
    if (requestToken === state.showModalRequestToken && state.activeShowModalKey === showKey) {
      renderShowModalContent(show, { activeSeasonNum, tmdbData: null, seasonDetailsByNumber: new Map(), loading: false });
    }
  });
  hydratePosters(root);
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
export async function openShowInlineDetail(showKey, activeSeasonNum = null, activeEpisodeNum = null) {
  prepareInlineMediaDetail("shows");
  await renderImmersiveShowModal(showKey, activeSeasonNum, activeEpisodeNum);
}
// Monotonic token guarding async media-detail renders. Each render captures the
// current value; if navigation (a new render, or clearMediaDetailState) bumps it
// while a slow TMDB fetch is in flight, the stale render aborts before writing the
// DOM. Without this, an abandoned detail page would "appear" after you'd already
// navigated back and opened something else.
let _mediaRenderToken = 0;
export async function renderMovieImmersiveModalContent(movie) {
  const renderToken = ++_mediaRenderToken;
  console.log("[render] renderMovieImmersiveModalContent called, token=", renderToken, "movie=", movie?.title, new Error().stack);
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
  const localPoster = posterUrlFor(movie) || "/favicon.svg";
  setMediaDetailActions(`
    <details class="media-actions-menu">
      <summary class="action-pill media-actions-menu-trigger">Movie actions</summary>
      <div class="media-actions-menu-panel">
        <button class="action-pill action-pill-ghost" type="button" ${isSaving ? "disabled" : ""} data-unwatch-id="${escapeAttribute(movie.id)}" data-unwatch-kind="movie" data-unwatch-label="${escapeAttribute(movie.title || "this movie")}">Mark unwatched</button>
        <button class="action-pill media-edit-image-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-poster-url="${escapeAttribute(movie.poster_url || "")}" data-logo-url="${escapeAttribute(movie.logo_url || "")}">Edit Images</button>
        <button class="action-pill media-fix-match-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-title="${escapeAttribute(movie.title || "")}" data-media-type="movie">Fix Match</button>
      </div>
    </details>
  `);
  root.innerHTML = `
    <div class="modal-backdrop-image" style="background-image: url('${escapeAttribute(localPoster)}');"></div>
    <div class="immersive-container media-detail-page is-loading-metadata">
      <header class="immersive-header">
        <img class="immersive-poster-img" src="${escapeAttribute(localPoster)}" alt="${escapeAttribute(movie.title || "Movie")} poster" data-err="fav" />
        <div class="immersive-meta">
          <span class="media-kicker">Movie · Loading metadata</span>
          <h2 class="immersive-title">${escapeHtml(movie.title || "Unknown movie")}</h2>
          <p class="immersive-overview">Your library record is ready. Synopsis, cast, providers and related media are loading.</p>
        </div>
      </header>
    </div>
  `;
  const tmdbData = await fetchTmdbDetails("movie", movie.tmdb_id, movie.title);
  console.log("[render] fetchTmdbDetails resolved, token=", renderToken, "current=", _mediaRenderToken, "tmdbData=", tmdbData?.id);
  if (_mediaRenderToken !== renderToken) { console.log("[render] ABORTED - token mismatch!"); return; } // navigated away while loading
  if (tmdbData && tmdbData.id) {
    state.activeMovieTmdbId = String(tmdbData.id);
  }
  // For YouTube-only content, fetch metadata from our backend
  let youtubeMeta = null;
  if (!tmdbData && movie.youtube_url) {
    try {
      const ytRes = await fetch(`/api/youtube-meta?url=${encodeURIComponent(movie.youtube_url)}`, { headers: authHeaders() });
      const ytData = await ytRes.json();
      if (!ytData.error) youtubeMeta = ytData;
    } catch { /* non-fatal */ }
    if (_mediaRenderToken !== renderToken) return; // navigated away while loading
  }
  const movieTitle = movie.title;
  let backdropUrl = "";
  let posterUrl = posterUrlFor(movie);
  let overview = "No synopsis available.";
  let released = "Unknown Release Date";
  let rating = "N/A";
  let recommendations = [];
  let tvRecommendations = [];
  if (tmdbData) {
    if (tmdbData.backdrop_path) {
      backdropUrl = tmdbData.cached_backdrop_url || `https://image.tmdb.org/t/p/original${tmdbData.backdrop_path}`;
    }
    // Keep a locally cached/custom poster (from "Edit Images") over the TMDB
    // default so the detail page matches what the dashboard shows.
    if (tmdbData.poster_path && !posterUrl) {
      posterUrl = tmdbData.cached_poster_url || tmdbPoster(tmdbData.poster_path, tmdbData.id, "movie");
    }
    overview = tmdbData.overview || overview;
    released = tmdbData.release_date ? `Released ${formatTmdbDate(tmdbData.release_date)}` : released;
    rating = tmdbData.vote_average ? `${Math.round(tmdbData.vote_average * 10)}%` : rating;
    recommendations = rankedRecommendations(tmdbData, "movie");
    tvRecommendations = await recommendedTvShowsForMovie(movieTitle, tmdbData);
    if (_mediaRenderToken !== renderToken) return;
  } else if (youtubeMeta) {
    if (youtubeMeta.thumbnails?.[0]) posterUrl = youtubeMeta.thumbnails[0];
    overview = youtubeMeta.description || overview;
    if (youtubeMeta.publishedAt) released = `Published ${formatTmdbDate(youtubeMeta.publishedAt.slice(0, 10))}`;
  }
  const logoUrl = movie.logo_url || bestTmdbLogo(tmdbData);
  const ratingBadgeHtml = rating !== "N/A" ? `
    ${renderExternalRatingPills("movie", tmdbData, movieTitle, rating)}
  ` : "";
  const imdbId = movie.imdb_id || tmdbData?.imdb_id || "";
  let imdbRating = null;
  if (imdbId && state.savedConfig?.omdb?.configured) {
    const omdbRes = await fetch(`/api/omdb-rating?imdbId=${encodeURIComponent(imdbId)}`, { headers: authHeaders() }).catch(() => null);
    if (omdbRes?.ok) {
      const omdbData = await omdbRes.json().catch(() => null);
      if (omdbData?.imdbRating) imdbRating = omdbData.imdbRating;
    }
    if (_mediaRenderToken !== renderToken) return;
  }
  const imdbPillHtml = imdbId ? ratingPillHtml({
    label: "IMDb",
    value: imdbRating ? `${Math.round(parseFloat(imdbRating) * 10)}%` : "View",
    href: `https://www.imdb.com/title/${escapeAttribute(imdbId)}`,
    title: imdbRating ? `IMDb rating: ${imdbRating}/10` : "Open on IMDb",
  }) : "";
  const sourceBadgeHtml = movie.source ? `
    <span class="source-badge ${sourceClass(movie.source)}" style="display: inline-flex;">${escapeHtml(platformBadge(movie.source))}</span>
  ` : "";
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
        <button class="action-pill media-edit-image-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-poster-url="${escapeAttribute(movie.poster_url || "")}" data-logo-url="${escapeAttribute(movie.logo_url || "")}">Edit Images</button>
        <button class="action-pill media-fix-match-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-title="${escapeAttribute(movie.title || "")}" data-media-type="movie">Fix Match</button>
        <button class="action-pill action-pill-danger" type="button" ${isSaving ? "disabled" : ""} data-delete-media-id="${escapeAttribute(movie.id)}" data-delete-media-title="${escapeAttribute(movie.title || "this movie")}">Delete</button>
      </div>
    </details>
    ${ytWatchBtn}
  `);
  root.innerHTML = `
    <div class="modal-backdrop-image" style="background-image: url('${backdropUrl || posterUrl}');"></div>
    <div class="immersive-container media-detail-page">
      <header class="immersive-header">
        <img class="immersive-poster-img" src="${posterUrl}" alt="${escapeHtml(movieTitle)} poster" data-err="fav" />
        <div class="immersive-meta">
          ${logoUrl ? `<img class="immersive-logo" src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(movieTitle)}" /><h2 class="immersive-title sr-only">${escapeHtml(movieTitle)}</h2>` : `<h2 class="immersive-title">${escapeHtml(movieTitle)}</h2>`}
          <p class="immersive-subtitle">${released}${youtubeMeta?.channelName ? ` &middot; ${escapeHtml(youtubeMeta.channelName)}` : ""}</p>
          <div class="ratings-row" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            ${ratingBadgeHtml || renderExternalRatingPills("movie", tmdbData, movieTitle)}
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
      ${renderCastSection(tmdbData)}
      ${renderRichTmdbDetails(tmdbData)}
      ${renderMediaImagesSection(tmdbData)}
      ${renderRecommendationSection({ title: "Recommended movies", items: recommendations, mediaType: "movie" })}
      ${renderRecommendationSection({ title: "Recommended TV Shows", items: tvRecommendations, mediaType: "tv" })}
    </div>
  `;
  const movieSeerrTmdbId = tmdbData?.id || movie.tmdb_id;
  if (movieSeerrTmdbId) {
    fetchSeerrMediaStatus("movie", movieSeerrTmdbId)
      .then((status) => { if (status) refreshActiveMediaDetailAfterSeerrStatus("movie", movieSeerrTmdbId); });
  }
  hydratePosters(root);
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
    return movies.find((movie) => String(movie.tmdb_id || "") === String(tmdbId)) || null;
  } catch {
    return null;
  }
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
  let backdropUrl = tmdbData.cached_backdrop_url || (tmdbData.backdrop_path ? `https://image.tmdb.org/t/p/original${tmdbData.backdrop_path}` : "");
  let posterUrl = tmdbData.cached_poster_url || tmdbPoster(tmdbData.poster_path, tmdbData.id, "movie") || "/favicon.svg";
  let overview = tmdbData.overview || "No synopsis available.";
  let released = tmdbData.release_date ? `Released ${formatTmdbDate(tmdbData.release_date)}` : "Unknown Release Date";
  let rating = tmdbData.vote_average ? `${Math.round(tmdbData.vote_average * 10)}%` : "N/A";
  let recommendations = [];
  recommendations = rankedRecommendations(tmdbData, "movie");
  const tvRecommendations = await recommendedTvShowsForMovie(movieTitle, tmdbData);
  const logoUrl = bestTmdbLogo(tmdbData);
  const ratingBadgeHtml = rating !== "N/A" ? `
    ${renderExternalRatingPills("movie", tmdbData, movieTitle, rating)}
  ` : "";
  root.innerHTML = `
    <div class="modal-backdrop-image" style="background-image: url('${backdropUrl || posterUrl}');"></div>
    <div class="immersive-container media-detail-page">
      <header class="immersive-header">
        <img class="immersive-poster-img" src="${posterUrl}" alt="${escapeHtml(movieTitle)} poster" data-err="fav" />
        <div class="immersive-meta">
          ${logoUrl ? `<img class="immersive-logo" src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(movieTitle)}" /><h2 class="immersive-title sr-only">${escapeHtml(movieTitle)}</h2>` : `<h2 class="immersive-title">${escapeHtml(movieTitle)}</h2>`}
          <p class="immersive-subtitle">${released}</p>
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
  fetchSeerrMediaStatus("movie", tmdbId)
    .then((status) => { if (status) refreshActiveMediaDetailAfterSeerrStatus("movie", tmdbId); });
  hydratePosters(root);
}
export function openDebugModal(entry) {
  if (!entry) return;
  const status = syncStatus(entry);
  elements.debugModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  document.querySelector("#debugModalTitle").textContent = entry.title || "History row";
  elements.modalBody.innerHTML = `
    <section class="diagnostic-grid">
      <div><span>Title</span><b>${escapeHtml(entry.title || "Unknown")}</b></div>
      <div><span>Media type</span><b>${escapeHtml(entry.media_type || "unknown")}</b></div>
      <div><span>IMDb</span><b>${escapeHtml(entry.imdb_id || "None")}</b></div>
      <div><span>TMDB</span><b>${escapeHtml(entry.tmdb_id || "None")}</b></div>
      <div><span>TVDB</span><b>${escapeHtml(entry.tvdb_id || "None")}</b></div>
      <div><span>Source</span><b>${escapeHtml(platformName(entry.source))}</b></div>
      <div><span>Action</span><b>${escapeHtml(historyAction(entry))}</b></div>
      <div><span>Sync state</span><b>${escapeHtml(status.label)}</b></div>
      <div><span>Season</span><b>${escapeHtml(entry.season ?? "None")}</b></div>
      <div><span>Episode</span><b>${escapeHtml(entry.episode ?? "None")}</b></div>
      <div><span>Watched at (oldest)</span><b>${escapeHtml(formatDate(entry.watched_at))}</b></div>
      ${entry.playHistory && entry.playHistory.length > 1 ? `<div><span>Play history</span><b>${entry.playHistory.map(d => escapeHtml(formatDate(d))).join("<br>")}</b></div>` : ""}
    </section>
    <section class="telemetry-block">
      <p>Sync dispatch telemetry</p>
      <pre>${escapeHtml(entry.sync_dispatch_telemetry || "No sync telemetry recorded for this row.")}</pre>
    </section>
  `;
}
export function closeDebugModal() {
  elements.debugModal.classList.add("hidden");
  document.body.style.overflow = "";
  const modalPanel = elements.debugModal.querySelector(".modal-panel");
  if (modalPanel) {
    modalPanel.classList.remove("modal-panel--immersive");
  }
  state.activeShowModalKey = null;
  state.activeShowTmdbId = null;
  state.activeShowModalSeason = null;
  state.activeShowModalEpisode = null;
  state.showModalRequestToken += 1;
  state.showModalEpisodes = [];
  state.showModalEpisodeIndex = new Map();
  state.activeShowRenderContext = null;
  state.pendingWatchAction = null;
  state.activeMovieModalId = null;
  const eyebrowEl = elements.debugModal.querySelector(".eyebrow");
  if (eyebrowEl) {
    eyebrowEl.textContent = "Sync diagnostic audit";
  }
}
export function mediaDetailRoot() {
  if (state.mediaDetailInline) return elements.explorerPanel;
  // The watch-date prompt is opened from the dashboard Part Watched row while the
  // diagnostic modal is closed (and #modalBody therefore display:none, which would
  // suppress the fixed overlay). Anchor to <body> so the overlay always renders.
  if (state.activeView === "dashboard") return document.body;
  return elements.modalBody;
}
export function prepareInlineMediaDetail(mode = state.explorerMode || "movies") {
  setMediaDetailActions("");
  if (!state.mediaDetailInline) {
    state.mediaDetailReturnView = state.activeView || "explorer";
    state.mediaDetailReturnExplorerMode = state.explorerMode || "movies";
  }
  state.mediaDetailInline = true;
  state.explorerMode = mode;
  selectView("explorer");
  syncInlineMediaDetailHeading(mode);
  elements.explorerPanel.innerHTML = "";
  elements.explorerPanel.scrollIntoView({ block: "start" });
  document.querySelector("#explorerBackButton")?.classList.remove("hidden");
  elements.explorerTopbarControls?.classList.add("hidden");
  syncPageTopbar();
}
export function setMediaDetailActions(html) {
  const el = document.getElementById("mediaDetailActions");
  if (el) el.innerHTML = html || "";
  normalizeMediaDetailActions(el);
  syncMediaActionsMenuState();
  syncPageTopbar();
}
export function normalizeMediaDetailActions(el) {
  if (!el || !el.childNodes.length) return;
  let menu = el.querySelector(":scope > .media-actions-menu");
  if (!menu) {
    const actionHtml = el.innerHTML;
    el.innerHTML = `
      <details class="media-actions-menu">
        <summary class="action-pill media-actions-menu-trigger">Actions</summary>
        <div class="media-actions-menu-panel">${actionHtml}</div>
      </details>
    `;
    return;
  }
  const panel = menu.querySelector(".media-actions-menu-panel");
  if (!panel) return;
  for (const node of [...el.childNodes]) {
    if (node === menu) continue;
    if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) {
      node.remove();
      continue;
    }
    panel.appendChild(node);
  }
}
export function syncMediaActionsMenuState() {
  const isMobileActions = window.matchMedia("(max-width: 640px)").matches;
  for (const menu of document.querySelectorAll("#mediaDetailActions .media-actions-menu")) {
    if (isMobileActions) {
      menu.removeAttribute("open");
    } else {
      menu.setAttribute("open", "");
    }
  }
}
export function syncTopbarControlsMenuState() {
  const menu = elements.topbarControlsMenu;
  if (!menu || menu.classList.contains("hidden")) {
    menu?.removeAttribute("open");
    return;
  }
  const isMobileControls = window.matchMedia("(max-width: 640px)").matches;
  if (isMobileControls) {
    menu.removeAttribute("open");
  } else {
    menu.removeAttribute("open");
  }
}
export function clearMediaDetailState() {
  _mediaRenderToken += 1; // invalidate any in-flight detail render (movie/show)
  console.log("[render] clearMediaDetailState bumped token to", _mediaRenderToken, new Error().stack);
  state.activeShowModalKey = null;
  state.activeShowTmdbId = null;
  state.activeShowModalSeason = null;
  state.activeShowModalEpisode = null;
  state.showModalRequestToken += 1;
  state.showModalEpisodes = [];
  state.showModalEpisodeIndex = new Map();
  state.activeShowRenderContext = null;
  state.pendingWatchAction = null;
  state.activeMovieModalId = null;
  state.activeMovieTmdbId = null;
  setMediaDetailActions("");
}
export function closeMediaDetail() {
  if (window.location.pathname.startsWith("/person/")) {
    const returnUrl = state.personReturnUrl;
    state.personReturnUrl = null;
    navigateTo(returnUrl || "/");
    return;
  }
  if (!state.mediaDetailInline) {
    closeDebugModal();
    return;
  }
  state.mediaDetailInline = false;
  clearMediaDetailState();
  document.querySelector("#explorerBackButton")?.classList.add("hidden");
  elements.explorerTopbarControls?.classList.remove("hidden");
  syncPageTopbar();
  state.explorerMode = state.mediaDetailReturnExplorerMode || state.explorerMode || "movies";
  if (state.mediaDetailReturnView && state.mediaDetailReturnView !== "explorer") {
    selectView(state.mediaDetailReturnView);
    return;
  }
  renderExplorer();
}
