import { buildAuthHeaders } from "./auth.js";
import {
  state, elements,
  EXPLORER_SORT_KEY_MOVIES, EXPLORER_SORT_KEY_SHOWS,
  EXPLORER_VIEW_KEY_MOVIES, EXPLORER_VIEW_KEY_SHOWS,
  HIDE_WATCHED_KEY_SHOWS, HIDE_ENDED_KEY_SHOWS,
  HISTORY_VIEW_KEY, HISTORY_FILTER_KEY,
  HISTORY_VIEW_MODES, HISTORY_FILTERS,
} from "./state.js";
import {
  escapeHtml, escapeAttribute, slug, showTitleFrom, showName,
  movieHref, platformBadge, sourceClass, formatDate,
  computeProgress, sanitizeTitle, episodeTitle,
} from "./utils.js";
import { posterMarkup, hydratePosters, tmdbPoster, tmdbProfile } from "./images.js";
import {
  historySyncPill, renderSyncStatusDot, renderMediaSyncPills,
  renderAvailabilityPills, renderShowAvailabilityPills, showAvailIssuePopup,
  isWatchedHistoryAction,
} from "./sync.js";
import { dedupeMediaRecords, renderHistoryCard } from "./dashboard.js";
import { nextAiringCell, nextAiringDateValue, formatListDate, futureListDate } from "./stats.js";
// ---------------------------------------------------------------------------
// Callback injection — functions defined outside the 2636–4016 range in app.js
// ---------------------------------------------------------------------------
let _cb = {};
export function initExplorer(callbacks) {
  _cb = callbacks;
}
// ---------------------------------------------------------------------------
// Local auth helper
// ---------------------------------------------------------------------------
function authHeaders() {
  return buildAuthHeaders(state.token);
}
// ---------------------------------------------------------------------------
// Convenience wrappers that delegate to injected callbacks
// (keeps call-sites in this module identical to the original)
// ---------------------------------------------------------------------------
function setMessage(text, tone = "muted") {
  _cb.setMessage?.(text, tone);
}
function syncPageTopbar() {
  _cb.syncPageTopbar?.();
}
function cachedExplorerPage(key) {
  return _cb.cachedExplorerPage?.(key) ?? null;
}
function rememberExplorerPage(key, body) {
  _cb.rememberExplorerPage?.(key, body);
}
function fetchTmdbDetails(mediaType, tmdbId, title, ids) {
  return _cb.fetchTmdbDetails?.(mediaType, tmdbId, title, ids) ?? Promise.resolve(null);
}
function resolveEpisodeTitleFromTmdb(entry, el) {
  return _cb.resolveEpisodeTitleFromTmdb?.(entry, el);
}
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const EXPLORER_PAGE_SIZE = 240;
export const FILMOGRAPHY_PAGE_SIZE = 40;
// ---------------------------------------------------------------------------
// Module-level mutable state
// ---------------------------------------------------------------------------
let _explorerPrefetchObserver = null;
let _filmographyObserver = null;
export function getFilmographyObserver() { return _filmographyObserver; }
export function setFilmographyObserver(v) { _filmographyObserver = v; }
// ---------------------------------------------------------------------------
// syncExplorerControlsState / syncInlineMediaDetailHeading
// ---------------------------------------------------------------------------
export function syncExplorerControlsState() {
  const backBtn = document.querySelector("#explorerBackButton");
  const controls = elements.explorerTopbarControls || document.querySelector("#explorerTopbarControls");
  const heading = document.querySelector('[data-view-panel="explorer"] .explorer-heading-sticky');
  if (state.mediaDetailInline) {
    backBtn?.classList.remove("hidden");
    controls?.classList.add("hidden");
    heading?.classList.add("is-media-detail");
    syncInlineMediaDetailHeading(state.explorerMode);
  } else {
    backBtn?.classList.add("hidden");
    controls?.classList.remove("hidden");
    heading?.classList.remove("is-media-detail");
  }
}
export function syncInlineMediaDetailHeading(mode = state.explorerMode || "movies") {
  if (!state.mediaDetailInline) return;
  const normalized = mode === "shows" ? "shows" : "movies";
  if (elements.explorerTitle) {
    elements.explorerTitle.textContent = normalized === "shows" ? "TV Shows" : "Movies";
  }
  if (elements.explorerSubtitle) {
    elements.explorerSubtitle.textContent = "";
  }
  syncPageTopbar();
}
// ---------------------------------------------------------------------------
// Search page
// ---------------------------------------------------------------------------
export function triggerSearchPage(query) {
  state.searchQuery = query;
  state.searchLoading = true;
  state.searchResults = [];
  syncPageTopbar();
  const loadingEl = document.getElementById("searchViewLoading");
  const emptyEl = document.getElementById("searchViewEmpty");
  const resultsEl = document.getElementById("searchViewResults");
  loadingEl?.classList.remove("hidden");
  emptyEl?.classList.add("hidden");
  if (resultsEl) resultsEl.innerHTML = "";
  fetch(`/api/media-search?q=${encodeURIComponent(query)}&limit=100`, { headers: authHeaders() })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((body) => {
      state.searchLoading = false;
      const results = [];
      const seenTitles = new Set();
      // Local Shows
      const localShows = body.local?.shows || [];
      for (const s of localShows) {
        const title = s.title || "";
        const slugTitle = slug(title);
        seenTitles.add(slugTitle);
        results.push({
          _type: "show",
          title,
          poster: s.poster_url || "",
          href: `/tvshow/${slugTitle}`,
          sub: "TV Show (Local)",
          overview: "",
          isLocal: true,
          mediaType: "tv"
        });
      }
      // Local Movies
      const localMovies = body.local?.movies || [];
      for (const m of localMovies) {
        const title = m.title || "";
        const slugTitle = slug(title);
        seenTitles.add(slugTitle);
        results.push({
          _type: "movie",
          title,
          poster: m.poster_url || "",
          href: movieHref(m),
          sub: "Movie (Local)",
          overview: "",
          isLocal: true,
          mediaType: "movie"
        });
      }
      // TMDB Discovery results (Movies, Shows, People)
      const discovery = body.discovery?.results || [];
      for (const item of discovery) {
        const mediaType = item.media_type || (item.title ? "movie" : "tv");
        if (!["movie", "tv", "person"].includes(mediaType)) continue;
        const title = item.title || item.name || "Unknown title";
        const slugTitle = slug(title);
        const overview = item.overview || (item.known_for ? `Known for: ${item.known_for.map(x => x.title || x.name).filter(Boolean).join(", ")}` : "");
        const existing = results.find((result) => result.mediaType === mediaType && result.title.toLowerCase() === title.toLowerCase());
        if (existing) {
          if (!existing.overview && overview) {
            existing.overview = overview;
          }
          continue;
        }
        const year = (item.release_date || item.first_air_date || "").slice(0, 4);
        results.push({
          _type: mediaType === "person" ? "person" : (mediaType === "movie" ? "movie" : "show"),
          title,
          poster: mediaType === "person" ? (tmdbProfile(item.profile_path) || tmdbPoster(item.profile_path)) : tmdbPoster(item.poster_path, item.id, mediaType),
          href: mediaType === "person" ? `/person/${item.id}` : (mediaType === "movie" ? `/movie/tmdb/${item.id}` : `/tvshow/tmdb/${item.id}`),
          sub: mediaType === "person" ? "Cast Member" : `${mediaType === "movie" ? "Movie" : "TV Show"}${year ? ` · ${year}` : ""} · TMDB`,
          overview,
          isLocal: false,
          mediaType
        });
      }
      // Prioritize actor matching query at the top
      const qLower = query.toLowerCase();
      results.sort((a, b) => {
        const aIsPersonMatch = a.mediaType === "person" && a.title.toLowerCase() === qLower;
        const bIsPersonMatch = b.mediaType === "person" && b.title.toLowerCase() === qLower;
        if (aIsPersonMatch && !bIsPersonMatch) return -1;
        if (!aIsPersonMatch && bIsPersonMatch) return 1;
        const aIsPersonPartial = a.mediaType === "person" && a.title.toLowerCase().includes(qLower);
        const bIsPersonPartial = b.mediaType === "person" && b.title.toLowerCase().includes(qLower);
        if (aIsPersonPartial && !bIsPersonPartial) return -1;
        if (!aIsPersonPartial && bIsPersonPartial) return 1;
        return 0; // Maintain original order
      });
      state.searchResults = results;
      renderSearchPage();
    })
    .catch((error) => {
      state.searchLoading = false;
      console.error("Search failed", error);
      loadingEl?.classList.add("hidden");
      emptyEl?.classList.remove("hidden");
      if (emptyEl) emptyEl.textContent = `Search failed: ${error.message}`;
    });
}
export function renderSearchPage() {
  syncPageTopbar();
  const loadingEl = document.getElementById("searchViewLoading");
  const emptyEl = document.getElementById("searchViewEmpty");
  const resultsEl = document.getElementById("searchViewResults");
  if (state.searchLoading) {
    loadingEl?.classList.remove("hidden");
    emptyEl?.classList.add("hidden");
    if (resultsEl) resultsEl.innerHTML = "";
    return;
  }
  loadingEl?.classList.add("hidden");
  const allResults = state.searchResults || [];
  if (!allResults.length) {
    emptyEl?.classList.remove("hidden");
    if (resultsEl) resultsEl.innerHTML = "";
    return;
  }
  emptyEl?.classList.add("hidden");
  const renderCard = (r) => {
    const posterHtml = r.poster
      ? `<img src="${escapeAttribute(r.poster)}" alt="" class="overview-thumb-poster" loading="lazy">`
      : `<div class="overview-thumb-poster poster-fallback" style="display: flex; align-items: center; justify-content: center; color: var(--muted); height: 100%; min-height: 160px;"><svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg></div>`;
    const badgesHtml = r.isLocal
      ? `<span class="status-pill status-success" style="font-size: 0.65rem; padding: 0.1rem 0.3rem;">Local</span>`
      : `<span class="status-pill status-muted" style="font-size: 0.65rem; padding: 0.1rem 0.3rem;">TMDB</span>`;
    return `
      <article class="explorer-overview-card" data-href="${escapeAttribute(r.href)}">
        <div style="width: 100%; height: 100%; position: relative;">
          ${posterHtml}
        </div>
        <div class="overview-card-meta">
          <div class="overview-card-header">
            <b style="font-size: 0.95rem; font-weight: 800;">${escapeHtml(r.title)}</b>
            <div class="overview-card-badges">
              ${badgesHtml}
            </div>
          </div>
          <div class="overview-card-attrs">${escapeHtml(r.sub)}</div>
          <div class="overview-card-text-wrap"><p class="overview-card-text" style="display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; margin-top: 0.25rem;">${escapeHtml(r.overview || "No synopsis available.")}</p></div>
        </div>
      </article>
    `;
  };
  if (state.searchFilter === "all") {
    const movies = allResults.filter(r => r.mediaType === "movie");
    const shows = allResults.filter(r => r.mediaType === "tv");
    const people = allResults.filter(r => r.mediaType === "person");
    if (resultsEl) {
      resultsEl.className = ""; // clear default grid class for flex columns
      resultsEl.innerHTML = `
        <div class="search-columns">
          <div class="search-column">
            <h3 class="search-column-title">Movies (${movies.length})</h3>
            <div class="search-column-grid">
              ${movies.length ? movies.map(renderCard).join("") : '<div class="gsd-column-empty">No matching movies</div>'}
            </div>
          </div>
          <div class="search-column">
            <h3 class="search-column-title">TV Shows (${shows.length})</h3>
            <div class="search-column-grid">
              ${shows.length ? shows.map(renderCard).join("") : '<div class="gsd-column-empty">No matching TV shows</div>'}
            </div>
          </div>
          <div class="search-column">
            <h3 class="search-column-title">People (${people.length})</h3>
            <div class="search-column-grid">
              ${people.length ? people.map(renderCard).join("") : '<div class="gsd-column-empty">No matching people</div>'}
            </div>
          </div>
        </div>
      `;
    }
  } else {
    let filtered = allResults;
    if (state.searchFilter === "movies") {
      filtered = allResults.filter((r) => r.mediaType === "movie");
    } else if (state.searchFilter === "shows") {
      filtered = allResults.filter((r) => r.mediaType === "tv");
    } else if (state.searchFilter === "people") {
      filtered = allResults.filter((r) => r.mediaType === "person");
    }
    if (!filtered.length) {
      emptyEl?.classList.remove("hidden");
      if (resultsEl) resultsEl.innerHTML = "";
      return;
    }
    if (resultsEl) {
      resultsEl.className = "explorer-overview-view"; // restore default grid layout
      resultsEl.innerHTML = filtered.map(renderCard).join("");
    }
  }
}
// ---------------------------------------------------------------------------
// Explorer top-level render
// ---------------------------------------------------------------------------
export function renderExplorer() {
  syncExplorerControlsState();
  if (state.mediaDetailInline) return;
  for (const button of elements.explorerButtons) {
    button.classList.toggle("active", button.dataset.explorerMode === state.explorerMode);
  }
  const activeView = currentExplorerView();
  const lockNextAirList = state.explorerMode === "shows" && state.explorerSortShows === "next_air_asc";
  for (const button of elements.explorerViewButtons || []) {
    button.classList.toggle("active", button.dataset.explorerView === activeView);
  }
  const viewToggle = elements.explorerViewButtons?.[0]?.closest(".explorer-view-toggle");
  viewToggle?.classList.toggle("hidden", lockNextAirList);
  if (elements.explorerPosterSizeLabel) {
    elements.explorerPosterSizeLabel.style.display = activeView === "posters" ? "" : "none";
  }
  applyExplorerPosterWidth();
  if (elements.explorerSort) {
    const sort = currentExplorerSort();
    elements.explorerSort.value = sort;
    // Only show "Next Airing" option for shows
    for (const opt of elements.explorerSort.options) {
      if (opt.value === "next_air_asc") opt.hidden = state.explorerMode !== "shows";
    }
  }
  const isShows = state.explorerMode === "shows";
  if (elements.explorerHideWatchedLabel) {
    elements.explorerHideWatchedLabel.style.display = isShows ? "" : "none";
  }
  if (elements.explorerHideEndedLabel) {
    elements.explorerHideEndedLabel.style.display = isShows ? "" : "none";
  }
  if (elements.explorerHideWatched) {
    elements.explorerHideWatched.checked = state.hideWatchedShows;
  }
  if (elements.explorerHideEnded) {
    elements.explorerHideEnded.checked = state.hideEndedShows;
  }
  if (elements.explorerTitle) {
    const mode = state.mediaDetailInline && state.activeShowModalKey ? "shows" : state.explorerMode;
    elements.explorerTitle.textContent = mode === "shows" ? "TV Shows" : "Movies";
  }
  if (elements.explorerSubtitle) {
    elements.explorerSubtitle.textContent = state.mediaDetailInline ? "" : (state.savedConfig?.plex?.username || "Watched history library");
  }
  syncPageTopbar();
  const search = elements.explorerSearchInput ? elements.explorerSearchInput.value.trim() : state.explorerSearch;
  state.explorerSearch = search;
  if (elements.globalSearchInput && elements.globalSearchInput.value !== state.explorerSearch) {
    elements.globalSearchInput.value = state.explorerSearch;
  }
  if (state.mediaDetailInline) {
    return;
  }
  if (state.explorerMode === "movies") {
    renderMovieExplorer();
    return;
  }
  renderShowExplorer();
}
export function explorerQueryKey(mode) {
  if (mode === "shows") {
    return [mode, currentExplorerSort(), state.explorerSearch, state.hideWatchedShows, state.hideEndedShows].join("|");
  }
  return [mode, currentExplorerSort(), state.explorerSearch].join("|");
}
// ---------------------------------------------------------------------------
// Alpha filter
// ---------------------------------------------------------------------------
function firstAlphaLetter(title) {
  if (!title) return "#";
  const stripped = String(title).replace(/^(the |a |an )/i, "").trim();
  const ch = stripped.charAt(0).toUpperCase();
  return /[A-Z]/.test(ch) ? ch : "#";
}
const ALPHA_LETTERS = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")];
export function updateAlphaFilter() {
  const nav = elements.alphaFilterNav;
  if (!nav) return;
  if (state.mediaDetailInline || state.activeView !== "explorer") {
    nav.classList.add("hidden");
    return;
  }
  const items = state.explorerMode === "movies" ? state.moviesRaw : state.showsRaw;
  const hasItems = items.length > 0;
  nav.classList.toggle("hidden", !hasItems);
  if (!hasItems) return;
  const hasMore = state.explorerMode === "movies" ? state.moviesHasMore : state.showsHasMore;
  const loaded = new Set(items.map((it) => firstAlphaLetter(it.title)));
  nav.innerHTML = ALPHA_LETTERS.map((letter) => {
    const definitivelyEmpty = !hasMore && !loaded.has(letter);
    return `<button class="${definitivelyEmpty ? "alpha-empty" : ""}" data-alpha="${letter}" title="${letter === "#" ? "Numbers / symbols" : letter}" ${definitivelyEmpty ? "disabled" : ""}>${letter}</button>`;
  }).join("");
}
let alphaScrolling = false;
export async function handleAlphaFilterClick(e) {
  const btn = e.target.closest("[data-alpha]");
  if (!btn || btn.disabled || alphaScrolling) return;
  const letter = btn.dataset.alpha;
  const panel = elements.explorerPanel;
  const nav = elements.alphaFilterNav;
  if (!panel || !nav) return;
  for (const b of nav.querySelectorAll("[data-alpha]")) b.classList.remove("alpha-current");
  btn.classList.add("alpha-current");
  function scrollToTarget(el) {
    const pageShell = document.querySelector(".page-shell");
    if (!pageShell) return;
    const headingEl = elements.pageTopbar || document.querySelector(".page-topbar");
    const relativeTop = el.getBoundingClientRect().top - pageShell.getBoundingClientRect().top;
    const isSticky = headingEl ? window.getComputedStyle(headingEl).position === "sticky" : false;
    const headingHeight = (headingEl && isSticky) ? headingEl.offsetHeight : 0;
    const targetScrollTop = pageShell.scrollTop + relativeTop - headingHeight - 8;
    pageShell.scrollTo({ top: targetScrollTop, behavior: "smooth" });
  }
  let target = panel.querySelector(`[data-alpha-letter="${letter}"]`);
  if (target) {
    scrollToTarget(target);
    return;
  }
  alphaScrolling = true;
  try {
    const mode = state.explorerMode;
    const loadFn = mode === "movies" ? loadExplorerMovies : loadExplorerShows;
    const hasMore = () => (mode === "movies" ? state.moviesHasMore : state.showsHasMore);
    while (hasMore() && !panel.querySelector(`[data-alpha-letter="${letter}"]`)) {
      await loadFn();
    }
    target = panel.querySelector(`[data-alpha-letter="${letter}"]`);
    if (target) {
      scrollToTarget(target);
    } else {
      btn.classList.remove("alpha-current");
      btn.classList.add("alpha-empty");
      btn.disabled = true;
    }
  } finally {
    alphaScrolling = false;
  }
}
// ---------------------------------------------------------------------------
// Reset helpers
// ---------------------------------------------------------------------------
export function resetMovieExplorer(key = explorerQueryKey("movies")) {
  state.moviesRaw = [];
  state.moviesOffset = 0;
  state.moviesHasMore = true;
  state.moviesLoading = false;
  state.moviesQueryKey = key;
  state.explorerScrollArmed = false;
}
export function resetShowExplorer(key = explorerQueryKey("shows")) {
  state.showsRaw = [];
  state.showsOffset = 0;
  state.showsHasMore = true;
  state.showsLoading = false;
  state.showsQueryKey = key;
  state.explorerScrollArmed = false;
}
// ---------------------------------------------------------------------------
// Scroll sentinel
// ---------------------------------------------------------------------------
export function renderExplorerSentinel(mode, hasMore, loading) {
  if (!hasMore && !loading) return "";
  return `
    <div class="explorer-scroll-sentinel" data-explorer-sentinel="${mode}" aria-live="polite">
      <span>${loading ? "Loading..." : ""}</span>
    </div>
  `;
}
export function observeExplorerSentinel(mode) {
  state.explorerLoadObserver?.disconnect();
  state.explorerLoadObserver = undefined;
  const sentinel = elements.explorerPanel?.querySelector(`[data-explorer-sentinel="${mode}"]`);
  if (!sentinel || !("IntersectionObserver" in window)) return;
  state.explorerLoadObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (!state.explorerScrollArmed) return;
      if (mode === "movies") loadExplorerMovies().catch((error) => setMessage(error.message, "error"));
      if (mode === "shows") loadExplorerShows().catch((error) => setMessage(error.message, "error"));
    },
    { rootMargin: "1200px 0px 1200px 0px" },
  );
  state.explorerLoadObserver.observe(sentinel);
}
// ---------------------------------------------------------------------------
// TMDB prefetch observer
// ---------------------------------------------------------------------------
export function observeExplorerTmdbPrefetch(container) {
  _explorerPrefetchObserver?.disconnect();
  if (!("IntersectionObserver" in window)) return;
  _explorerPrefetchObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        const mediaType = el.dataset.prefetchType;
        const tmdbId = el.dataset.prefetchTmdb;
        const title = el.dataset.prefetchTitle;
        // In the default "posters" grid the only thing TMDB details supplies is a
        // poster_path for cards whose poster hasn't resolved yet. Cards that already
        // rendered an <img> need nothing — skip them so we don't fire a request per
        // card. List/overview views always need the metadata (dates, runtime, eps).
        const needsMeta = currentExplorerView() === "list" || currentExplorerView() === "overview" || (mediaType === "tv" && currentExplorerView() === "posters");
        const needsPoster = !!el.querySelector(".poster-fallback[data-poster-id]");
        if (!needsMeta && !needsPoster) {
          _explorerPrefetchObserver?.unobserve(el);
          continue;
        }
        if (mediaType && title) {
          if (state.token) {
            fetchTmdbDetails(mediaType, tmdbId || undefined, title).then((data) => {
              if (!el.isConnected) return;
              if (data?.id && el.dataset.partWatchedMediaKey) {
                const progressEntry = state.partWatchedRaw.find((item) => item.media_key === el.dataset.partWatchedMediaKey);
                if (progressEntry && !progressEntry.tmdb_id) progressEntry.tmdb_id = String(data.id);
              }
              if (data?.poster_path) {
                const posterUrl = tmdbPoster(data.poster_path);
                if (posterUrl) {
                  const fallback = el.querySelector(".poster-fallback[data-poster-id]");
                  if (fallback) {
                    const posterId = fallback.dataset.posterId;
                    state.posterLookupCache.set(posterId, posterUrl);
                    const img = document.createElement("img");
                    img.className = fallback.className.replace(/\bposter-fallback\b/g, "").trim() || fallback.className;
                    img.src = posterUrl;
                    img.alt = title;
                    img.loading = "lazy";
                    img.decoding = "async";
                    img.referrerPolicy = "no-referrer";
                    img.dataset.posterId = posterId;
                    fallback.replaceWith(img);
                  }
                }
              }
              if (currentExplorerView() === "list" && data) {
                const isMovie = mediaType === "movie";
                const releaseEl = el.querySelector("[data-list-release]");
                if (releaseEl && !releaseEl.textContent.trim()) {
                  const raw = isMovie ? data.release_date : data.first_air_date;
                  if (raw) releaseEl.textContent = formatListDate(raw);
                }
                const yearEl = el.querySelector("[data-list-year]");
                if (yearEl && !yearEl.textContent.trim()) {
                  const raw = isMovie ? data.release_date : data.first_air_date;
                  if (raw) yearEl.textContent = raw.slice(0, 4);
                }
                if (isMovie) {
                  const runtimeEl = el.querySelector("[data-list-runtime]");
                  if (runtimeEl && !runtimeEl.textContent.trim() && data.runtime) {
                    runtimeEl.textContent = `${data.runtime} min`;
                  }
                } else {
                  const nextAirEl = el.querySelector("[data-list-next-air]");
                  if (nextAirEl && !nextAirEl.textContent.trim()) {
                    const nextAiring = nextAiringCell(data);
                    if (nextAiring.text) {
                      nextAirEl.textContent = nextAiring.text;
                      nextAirEl.classList.toggle("list-next-air-status", nextAiring.isStatus);
                    }
                  }
                  const epsEl = el.querySelector("[data-list-eps]");
                  if (epsEl && data.number_of_episodes) {
                    const watched = parseInt(epsEl.dataset.watched || "0") || 0;
                    const total = data.number_of_episodes;
                    const pct = Math.round((watched / total) * 100);
                    epsEl.dataset.total = String(total);
                    epsEl.outerHTML = `<div class="list-eps-progress" data-list-eps data-watched="${watched}" data-total="${total}"><div class="list-eps-bar-track"><div class="list-eps-bar-fill" style="width:${pct}%"></div></div><span class="list-eps-label">${watched} / ${total}</span></div>`;
                  }
                }
              }
              const progressPill = el.querySelector(".show-progress-bar-attached");
              if (progressPill && data?.number_of_episodes) {
                const watched = parseInt(progressPill.dataset.watched || "0") || 0;
                const total = data.number_of_episodes;
                progressPill.dataset.total = String(total);
                progressPill.textContent = `${watched}/${total} Watched`;
              }
              if (state.explorerSortShows === "next_air_asc" && mediaType === "tv") {
                scheduleNextAirResort();
              }
              if (currentExplorerView() === "overview" && data) {
                const attrsEl = el.querySelector("[data-overview-attrs]");
                const textEl = el.querySelector("[data-overview-text]");
                if (attrsEl && !attrsEl.textContent.trim()) {
                  const isMovie = mediaType === "movie";
                  const year = isMovie ? data.release_date?.slice(0, 4) : data.first_air_date?.slice(0, 4);
                  const genres = data.genres?.slice(0, 3).map((g) => g.name).join(" · ") || "";
                  const parts = [year, genres].filter(Boolean);
                  attrsEl.textContent = parts.join(" · ");
                }
                if (textEl && !textEl.textContent.trim() && data.overview) {
                  textEl.textContent = data.overview;
                }
              }
            }).catch(() => { });
            _explorerPrefetchObserver?.unobserve(el);
          }
        } else {
          _explorerPrefetchObserver?.unobserve(el);
        }
      }
    },
    { rootMargin: "200px 0px 200px 0px" },
  );
  for (const el of container.querySelectorAll("[data-prefetch-type]")) {
    _explorerPrefetchObserver.observe(el);
  }
}
// ---------------------------------------------------------------------------
// Next-air resort scheduler
// ---------------------------------------------------------------------------
let _nextAirResortTimer = null;
export function scheduleNextAirResort() {
  clearTimeout(_nextAirResortTimer);
  _nextAirResortTimer = setTimeout(() => {
    if (state.explorerSortShows === "next_air_asc" && state.explorerMode === "shows") renderShowExplorer();
  }, 600);
}
// ---------------------------------------------------------------------------
// View / sort helpers
// ---------------------------------------------------------------------------
export function currentExplorerView() {
  if (state.explorerMode === "shows" && state.explorerSortShows === "next_air_asc") return "list";
  return state.explorerMode === "shows" ? state.explorerViewShows : state.explorerViewMovies;
}
export function currentExplorerSort() {
  return state.explorerMode === "shows" ? state.explorerSortShows : state.explorerSortMovies;
}
export function setCurrentExplorerSort(value) {
  if (state.explorerMode === "shows") {
    state.explorerSortShows = value;
    localStorage.setItem(EXPLORER_SORT_KEY_SHOWS, value);
  } else {
    state.explorerSortMovies = value;
    localStorage.setItem(EXPLORER_SORT_KEY_MOVIES, value);
  }
}
export function currentPosterWidthKey() {
  const mode = state.explorerMode === "shows" ? "shows" : "movies";
  const view = currentExplorerView();
  const isMobile = window.innerWidth <= 760;
  return `plembfin:posterWidthV2:${mode}:${view}${isMobile ? ":mobile" : ""}`;
}
export function applyExplorerPosterWidth() {
  const isMobile = window.innerWidth <= 760;
  const defaultSize = isMobile ? "80px" : "160px";
  const saved = localStorage.getItem(currentPosterWidthKey()) || defaultSize;
  document.documentElement.style.setProperty("--poster-width", saved);
  if (elements.explorerPosterSize) elements.explorerPosterSize.value = parseInt(saved) || (isMobile ? 80 : 160);
}
function explorerGridClass(isShows = false) {
  const base = isShows ? "movie-grid explorer-show-grid" : "movie-grid";
  const view = currentExplorerView();
  if (view === "list") return `explorer-list-view ${isShows ? "shows-list" : "movies-list"}`;
  if (view === "overview") return "explorer-overview-view";
  return base;
}
function sortArrow(colKey) {
  const s = currentExplorerSort();
  if (s === `${colKey}_asc`) return `<span class="sort-arrow">↑</span>`;
  if (s === `${colKey}_desc`) return `<span class="sort-arrow">↓</span>`;
  return "";
}
export function applyListHeaderSort(key) {
  if (key === "next_air") {
    setCurrentExplorerSort("next_air_asc");
    if (elements.explorerSort) elements.explorerSort.value = currentExplorerSort();
    if (state.explorerMode === "shows") {
      state.showsRaw = []; state.showsOffset = 0; state.showsHasMore = true; state.showsLoading = false;
    }
    renderExplorer();
    return;
  }
  const asc = `${key}_asc`, desc = `${key}_desc`;
  setCurrentExplorerSort(currentExplorerSort() === asc ? desc : asc);
  if (elements.explorerSort) elements.explorerSort.value = currentExplorerSort();
  if (state.explorerMode === "shows") {
    state.showsRaw = []; state.showsOffset = 0; state.showsHasMore = true; state.showsLoading = false;
  } else {
    state.moviesRaw = []; state.moviesOffset = 0; state.moviesHasMore = true; state.moviesLoading = false;
  }
  renderExplorer();
}
export function resolvedTmdbCache(mediaType, tmdbId, title) {
  if (!tmdbId && !title) return null;
  const baseKey = `${mediaType}|${tmdbId || ""}|${String(title || "").toLowerCase()}`;
  const keys = [baseKey, `${baseKey}||`];
  for (const key of keys) {
    const cached = state.tmdbDetailsCache.get(key);
    if (cached && typeof cached.then !== "function") return cached;
  }
  return null;
}
// ---------------------------------------------------------------------------
// Movie cards
// ---------------------------------------------------------------------------
export function renderMovieCard(movie) {
  if (currentExplorerView() === "list") return renderMovieListCard(movie);
  if (currentExplorerView() === "overview") return renderMovieOverviewCard(movie);
  return `
    <div class="movie-card" data-history-id="${movie.id}" data-alpha-letter="${firstAlphaLetter(movie.title)}" data-prefetch-type="movie" data-prefetch-tmdb="${escapeAttribute(movie.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(movie.title || "")}">
      ${posterMarkup(movie, "movie-poster")}
      <div class="movie-card-body">
        <div class="movie-card-title-row" style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; min-width: 0; width: 100%;">
          <b style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeAttribute(movie.title)}">${escapeHtml(movie.title)}</b>
          ${renderSyncStatusDot(movie, "margin-left: 0.25rem;")}
        </div>
        <span>${formatDate(movie.watched_at)}</span>
      </div>
    </div>
  `;
}
function renderListHeader(isShows) {
  if (isShows) {
    return `
      <div class="explorer-list-header">
        <span></span>
        <span class="list-header-sortable" data-sort-key="title">Series Title${sortArrow("title")}</span>
        <span class="list-header-sortable" data-sort-key="next_air">Next Airing${sortArrow("next_air")}</span>
        <span>Episodes</span>
        <span>Seasons</span>
        <span class="list-header-sortable" data-sort-key="watched">Last Watched${sortArrow("watched")}</span>
        <span>Year</span>
      </div>
    `;
  }
  return `
    <div class="explorer-list-header">
      <span></span>
      <span class="list-header-sortable" data-sort-key="title">Title${sortArrow("title")}</span>
      <span>Source</span>
      <span>Release Date</span>
      <span class="list-header-sortable" data-sort-key="watched">Watched${sortArrow("watched")}</span>
      <span>Year</span>
      <span>Runtime</span>
      <span></span>
    </div>
  `;
}
function renderMovieListCard(movie) {
  const sourceBadge = movie.source ? `<span class="source-badge ${sourceClass(movie.source)}">${escapeHtml(platformBadge(movie.source))}</span>` : "";
  const tmdb = resolvedTmdbCache("movie", movie.tmdb_id, movie.title);
  const releaseDate = tmdb?.release_date ? formatListDate(tmdb.release_date) : "";
  const runtime = tmdb?.runtime ? `${tmdb.runtime} min` : "";
  const year = tmdb?.release_date?.slice(0, 4) || "";
  return `
    <div class="movie-card explorer-list-card" data-history-id="${movie.id}" data-alpha-letter="${firstAlphaLetter(movie.title)}" data-prefetch-type="movie" data-prefetch-tmdb="${escapeAttribute(movie.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(movie.title || "")}">
      ${posterMarkup(movie, "list-thumb-poster")}
      <span class="list-card-title" title="${escapeAttribute(movie.title)}">${escapeHtml(movie.title)}</span>
      <div class="list-card-col list-card-platform">${sourceBadge}</div>
      <span class="list-card-col list-card-release" data-list-release>${escapeHtml(releaseDate)}</span>
      <span class="list-card-col">${escapeHtml(formatDate(movie.watched_at))}</span>
      <span class="list-card-col list-card-year" data-list-year>${escapeHtml(year)}</span>
      <span class="list-card-col" data-list-runtime>${escapeHtml(runtime)}</span>
      <div class="list-card-col list-card-sync">${renderSyncStatusDot(movie)}</div>
    </div>
  `;
}
function renderMovieOverviewCard(movie) {
  const tmdb = resolvedTmdbCache("movie", movie.tmdb_id, movie.title);
  const year = tmdb?.release_date?.slice(0, 4) || "";
  const genres = tmdb?.genres?.slice(0, 3).map((g) => escapeHtml(g.name)).join(" &middot; ") || "";
  const overview = tmdb?.overview || "";
  const sourceBadge = movie.source ? `<span class="source-badge ${sourceClass(movie.source)}">${escapeHtml(platformBadge(movie.source))}</span>` : "";
  return `
    <div class="movie-card explorer-overview-card" data-history-id="${movie.id}" data-alpha-letter="${firstAlphaLetter(movie.title)}" data-prefetch-type="movie" data-prefetch-tmdb="${escapeAttribute(movie.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(movie.title || "")}">
      ${posterMarkup(movie, "overview-thumb-poster")}
      <div class="overview-card-meta">
        <div class="overview-card-header">
          <b title="${escapeAttribute(movie.title)}">${escapeHtml(movie.title)}</b>
          <div class="overview-card-badges">${sourceBadge}${renderSyncStatusDot(movie)}</div>
        </div>
        <div class="overview-card-attrs" data-overview-attrs>${[year, genres].filter(Boolean).join(" &middot; ")}</div>
        <div class="overview-card-text-wrap"><p class="overview-card-text" data-overview-text>${escapeHtml(overview)}</p></div>
        <span class="overview-card-date">${formatDate(movie.watched_at)}</span>
      </div>
    </div>
  `;
}
// ---------------------------------------------------------------------------
// Movie explorer
// ---------------------------------------------------------------------------
export function renderMovieExplorer() {
  if (state.mediaDetailInline) return;
  const key = explorerQueryKey("movies");
  if (state.moviesQueryKey !== key) resetMovieExplorer(key);
  if (!state.moviesRaw.length && state.moviesHasMore && !state.moviesLoading && state.token) {
    loadExplorerMovies().catch((error) => setMessage(error.message, "error"));
  }
  if (!state.moviesRaw.length && state.moviesLoading) {
    elements.explorerPanel.innerHTML = emptyExplorer("Loading movies...");
    return;
  }
  const movieGrid = state.moviesRaw.length
    ? `<div class="${explorerGridClass()}">${currentExplorerView() === "list" ? renderListHeader(false) : ""}${state.moviesRaw.map(renderMovieCard).join("")}</div>${renderExplorerSentinel("movies", state.moviesHasMore, state.moviesLoading)}`
    : emptyExplorer("No movies logged yet");
  elements.explorerPanel.innerHTML = movieGrid;
  hydratePosters(elements.explorerPanel);
  observeExplorerSentinel("movies");
  observeExplorerTmdbPrefetch(elements.explorerPanel);
  updateAlphaFilter();
}
export async function loadExplorerMovies() {
  if (state.moviesLoading || !state.moviesHasMore) return;
  state.moviesLoading = true;
  renderMovieExplorer();
  try {
    const url = new URL("/api/movies", window.location.origin);
    url.searchParams.set("limit", String(EXPLORER_PAGE_SIZE));
    url.searchParams.set("offset", String(state.moviesOffset));
    url.searchParams.set("sort", currentExplorerSort());
    if (state.explorerSearch) url.searchParams.set("search", state.explorerSearch);
    const cacheKey = url.toString();
    let body = cachedExplorerPage(cacheKey);
    if (!body) {
      const res = await fetch(url, { headers: authHeaders() });
      body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Movies load failed ${res.status}`);
      rememberExplorerPage(cacheKey, body);
    }
    const movies = Array.isArray(body.movies) ? body.movies : [];
    state.moviesRaw = dedupeMediaRecords([...state.moviesRaw, ...movies], "movies");
    state.moviesOffset += movies.length;
    state.moviesHasMore = movies.length === EXPLORER_PAGE_SIZE;
    if (state.moviesHasMore) state.explorerScrollArmed = true;
  } finally {
    state.moviesLoading = false;
    renderMovieExplorer();
  }
}
// ---------------------------------------------------------------------------
// History view
// ---------------------------------------------------------------------------
export function applyHistoryPosterWidth() {
  const isMobile = window.innerWidth <= 760;
  const defaultSize = isMobile ? "64px" : "86px";
  const saved = localStorage.getItem("plembfin:history:posterWidth") || defaultSize;
  document.documentElement.style.setProperty("--history-poster-width", saved);
  if (elements.historyPosterSize) elements.historyPosterSize.value = parseInt(saved) || (isMobile ? 64 : 86);
}
export function resetHistoryView(key = "") {
  state.historyViewRaw = [];
  state.historyViewOffset = 0;
  state.historyViewHasMore = true;
  state.historyViewLoading = false;
  state.historyViewQueryKey = key;
  state.historyViewScrollArmed = false;
}
function historyMediaFilterParam() {
  if (state.historyViewFilter === "movies") return "movie";
  if (state.historyViewFilter === "shows") return "episode";
  return "";
}
function historyEntryDisplay(entry) {
  const isEpisode = entry.media_type === "episode";
  let displayTitle = entry.title;
  let epTitle = "";
  let href = "";
  if (isEpisode) {
    displayTitle = entry.show_title || showTitleFrom(entry.title);
    epTitle = entry.episode_title;
    let needsResolve = false;
    if (!epTitle || /^Episode \d+$/i.test(String(epTitle).trim())) {
      const text = String(entry.title || "").trim();
      const suffixMatch = text.match(/S\d{1,2}E\d{1,2}\s+-\s+(.+)$/i);
      if (suffixMatch?.[1]) {
        epTitle = suffixMatch[1].trim();
      } else {
        if (!epTitle) {
          epTitle = `Episode ${entry.episode}`;
        }
        needsResolve = true;
      }
    }
    if (needsResolve) {
      setTimeout(() => {
        const el = document.querySelector(`[data-history-id="${entry.id}"] .history-card-episode`);
        resolveEpisodeTitleFromTmdb(entry, el);
      }, 50);
    }
    const canonicalShowName = entry.show_title || showName(entry.title);
    const showKeySlug = slug(canonicalShowName);
    href = `/tvshow/${showKeySlug}`;
  } else {
    href = entry.tmdb_id ? `/movie/tmdb/${entry.tmdb_id}` : movieHref(entry);
  }
  const sourceBadge = entry.source ? `<span class="source-badge ${sourceClass(entry.source)}">${escapeHtml(platformBadge(entry.source))}</span>` : "None";
  const mediaLabel = isEpisode ? "TV Show" : "Movie";
  const seasonEpisode = isEpisode ? `S${entry.season} - E${entry.episode}` : "";
  return { isEpisode, displayTitle, epTitle, href, sourceBadge, mediaLabel, seasonEpisode };
}
function renderHistoryGridCard(entry) {
  const { isEpisode, displayTitle, epTitle, href, mediaLabel } = historyEntryDisplay(entry);
  return `
    <a class="history-grid-card" data-history-id="${entry.id}" href="${escapeAttribute(href)}" data-prefetch-type="${isEpisode ? "tv" : "movie"}" data-prefetch-tmdb="${escapeAttribute(entry.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(displayTitle || "")}">
      ${posterMarkup(entry, "history-grid-poster")}
      <div class="history-grid-copy">
        <b title="${escapeAttribute(displayTitle)}">${escapeHtml(displayTitle)}</b>
        <span>${escapeHtml(isEpisode ? epTitle : mediaLabel)}</span>
        <small>${formatDate(entry.watched_at)}</small>
      </div>
    </a>
  `;
}
function renderHistoryListRow(entry) {
  const { isEpisode, displayTitle, epTitle, href, sourceBadge, mediaLabel, seasonEpisode } = historyEntryDisplay(entry);
  return `
    <a class="history-list-row" data-history-id="${entry.id}" href="${escapeAttribute(href)}" data-prefetch-type="${isEpisode ? "tv" : "movie"}" data-prefetch-tmdb="${escapeAttribute(entry.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(displayTitle || "")}">
      ${posterMarkup(entry, "history-list-poster")}
      <span class="history-list-title" title="${escapeAttribute(displayTitle)}">${escapeHtml(displayTitle)}</span>
      <span class="history-list-col" title="${escapeAttribute(epTitle || mediaLabel)}">${escapeHtml(epTitle || mediaLabel)}</span>
      <span class="history-list-col">${escapeHtml(seasonEpisode || mediaLabel)}</span>
      <span class="history-list-col">${formatDate(entry.watched_at)}</span>
      <span class="history-list-source">${sourceBadge}</span>
    </a>
  `;
}
function renderHistoryListHeader() {
  return `
    <div class="history-list-header" aria-hidden="true">
      <span></span>
      <span>Title</span>
      <span>Episode</span>
      <span>Type</span>
      <span>Watched</span>
      <span>App</span>
    </div>
  `;
}
function renderHistoryPageCard(entry) {
  const { isEpisode, displayTitle, epTitle, href, sourceBadge } = historyEntryDisplay(entry);
  return `
    <a class="history-page-card" data-history-id="${entry.id}" href="${escapeAttribute(href)}" data-prefetch-type="${isEpisode ? "tv" : "movie"}" data-prefetch-tmdb="${escapeAttribute(entry.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(displayTitle || "")}">
      <div class="history-card-poster-wrapper">
        ${posterMarkup(entry, "history-page-poster")}
      </div>
      <div class="history-card-details">
        <div class="history-card-header">
          <b class="history-card-title" title="${escapeAttribute(displayTitle)}">${escapeHtml(displayTitle)}</b>
          ${isEpisode ? `<span class="history-card-episode" title="${escapeAttribute(epTitle)}">${escapeHtml(epTitle)}</span>` : ""}
        </div>
        <div class="history-card-meta">
          ${isEpisode ? `
            <div class="history-card-meta-row">
              <span class="meta-label">Season/Ep:</span>
              <span class="meta-value">S${entry.season} · E${entry.episode}</span>
            </div>
          ` : ""}
          <div class="history-card-meta-row">
            <span class="meta-label">Last Played:</span>
            <span class="meta-value">${formatDate(entry.watched_at)}</span>
          </div>
        </div>
        <div class="history-card-footer">
          <span class="meta-label">App Used:</span>
          ${sourceBadge}
        </div>
      </div>
    </a>
  `;
}
export function renderHistoryItems() {
  if (!state.historyViewRaw.length) return emptyExplorer("No watch history items found");
  const sentinel = `<div class="explorer-scroll-sentinel" data-history-sentinel aria-live="polite"><span>${state.historyViewLoading ? "Loading..." : ""}</span></div>`;
  if (state.historyViewMode === "list") {
    return `<div class="history-table-view">${renderHistoryListHeader()}${state.historyViewRaw.map(renderHistoryListRow).join("")}</div>${sentinel}`;
  }
  if (state.historyViewMode === "cards") {
    return `<div class="history-list">${state.historyViewRaw.map(renderHistoryPageCard).join("")}</div>${sentinel}`;
  }
  return `<div class="history-grid-view">${state.historyViewRaw.map(renderHistoryGridCard).join("")}</div>${sentinel}`;
}
export function renderHistoryView() {
  if (state.mediaDetailInline) return;
  const key = [state.historyViewSearch, state.historyViewFilter].join("|");
  if (state.historyViewQueryKey !== key) resetHistoryView(key);
  if (!state.historyViewRaw.length && state.historyViewHasMore && !state.historyViewLoading && state.token) {
    loadHistoryView().catch((error) => setMessage(error.message, "error"));
  }
  if (!state.historyViewRaw.length && state.historyViewLoading) {
    elements.historyPanel.innerHTML = emptyExplorer("Loading watch history...");
    return;
  }
  applyHistoryPosterWidth();
  if (elements.historySearchInput && elements.historySearchInput.value !== state.historyViewSearch) {
    elements.historySearchInput.value = state.historyViewSearch;
  }
  for (const button of elements.historyFilterButtons || []) {
    button.classList.toggle("active", button.dataset.historyFilter === state.historyViewFilter);
  }
  for (const button of elements.historyViewButtons || []) {
    button.classList.toggle("active", button.dataset.historyView === state.historyViewMode);
  }
  elements.historyPanel.innerHTML = renderHistoryItems();
  hydratePosters(elements.historyPanel);
  observeHistorySentinel();
  observeExplorerTmdbPrefetch(elements.historyPanel);
}
export async function loadHistoryView() {
  if (state.historyViewLoading || !state.historyViewHasMore) return;
  state.historyViewLoading = true;
  if (elements.historyPanel) {
    const sentinel = elements.historyPanel.querySelector("[data-history-sentinel] span");
    if (sentinel) sentinel.textContent = "Loading...";
  }
  try {
    const url = new URL("/api/history", window.location.origin);
    url.searchParams.set("limit", String(EXPLORER_PAGE_SIZE));
    url.searchParams.set("offset", String(state.historyViewOffset));
    url.searchParams.set("stats", "0");
    url.searchParams.set("dedupe", "false");
    if (state.historyViewSearch) url.searchParams.set("search", state.historyViewSearch);
    const mediaType = historyMediaFilterParam();
    if (mediaType) url.searchParams.set("mediaType", mediaType);
    const res = await fetch(url, { headers: authHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `History load failed ${res.status}`);
    const historyItems = Array.isArray(body.history) ? body.history : [];
    state.historyViewRaw = [...state.historyViewRaw, ...historyItems];
    state.historyViewOffset += historyItems.length;
    state.historyViewHasMore = typeof body.hasMore === "boolean" ? body.hasMore : historyItems.length === EXPLORER_PAGE_SIZE;
  } finally {
    state.historyViewLoading = false;
    renderHistoryView();
  }
}
export function observeHistorySentinel() {
  state.historyViewLoadObserver?.disconnect();
  state.historyViewLoadObserver = undefined;
  const sentinel = elements.historyPanel?.querySelector("[data-history-sentinel]");
  if (!sentinel || !("IntersectionObserver" in window)) return;
  state.historyViewLoadObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      loadHistoryView().catch((error) => setMessage(error.message, "error"));
    },
    { rootMargin: "1200px 0px 1200px 0px" },
  );
  state.historyViewLoadObserver.observe(sentinel);
}
// ---------------------------------------------------------------------------
// Show explorer
// ---------------------------------------------------------------------------
export function renderShowExplorer() {
  if (state.mediaDetailInline) return;
  const key = explorerQueryKey("shows");
  if (state.showsQueryKey !== key) resetShowExplorer(key);
  if (!state.showsRaw.length && state.showsHasMore && !state.showsLoading && state.token) {
    loadExplorerShows().catch((error) => setMessage(error.message, "error"));
  }
  if (!state.showsRaw.length && state.showsLoading) {
    elements.explorerPanel.innerHTML = emptyExplorer("Loading TV shows...");
    return;
  }
  const showsToRender = state.explorerSortShows === "next_air_asc"
    ? [...state.showsRaw].sort((a, b) => {
      const tmdbA = resolvedTmdbCache("tv", a.tmdb_id, a.title);
      const tmdbB = resolvedTmdbCache("tv", b.tmdb_id, b.title);
      const dateA = nextAiringDateValue(tmdbA || a);
      const dateB = nextAiringDateValue(tmdbB || b);
      if (dateA && dateB) return dateA.localeCompare(dateB);
      if (dateA) return -1;
      if (dateB) return 1;
      return String(a.title).localeCompare(String(b.title));
    })
    : state.showsRaw;
  elements.explorerPanel.innerHTML = showsToRender.length
    ? `<div class="${explorerGridClass(true)}">${currentExplorerView() === "list" ? renderListHeader(true) : ""}${showsToRender.map(renderShowRecord).join("")}</div>${renderExplorerSentinel("shows", state.showsHasMore, state.showsLoading)}`
    : emptyExplorer("No TV episodes logged yet");
  hydratePosters(elements.explorerPanel);
  observeExplorerSentinel("shows");
  observeExplorerTmdbPrefetch(elements.explorerPanel);
  updateAlphaFilter();
}
export async function loadExplorerShows() {
  if (state.showsLoading || !state.showsHasMore) return;
  state.showsLoading = true;
  renderShowExplorer();
  try {
    const url = new URL("/api/shows", window.location.origin);
    url.searchParams.set("limit", String(EXPLORER_PAGE_SIZE));
    url.searchParams.set("offset", String(state.showsOffset));
    url.searchParams.set("sort", state.explorerSortShows);
    if (state.explorerSearch) url.searchParams.set("search", state.explorerSearch);
    if (state.hideWatchedShows) url.searchParams.set("hideWatched", "true");
    if (state.hideEndedShows) url.searchParams.set("hideEnded", "true");
    const cacheKey = url.toString();
    let body = cachedExplorerPage(cacheKey);
    if (!body) {
      const res = await fetch(url, { headers: authHeaders() });
      body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Shows load failed ${res.status}`);
      rememberExplorerPage(cacheKey, body);
    }
    const shows = Array.isArray(body.shows) ? body.shows : [];
    state.showsRaw = dedupeMediaRecords([...state.showsRaw, ...shows], "shows");
    state.showsOffset += shows.length;
    state.showsHasMore = shows.length === EXPLORER_PAGE_SIZE;
    if (state.showsHasMore) state.explorerScrollArmed = true;
  } finally {
    state.showsLoading = false;
    renderShowExplorer();
  }
}
export function mergeShowDetail(show = {}) {
  if (!show?.title) return null;
  const showKey = slug(show.title);
  const existingIndex = state.showsRaw.findIndex((item) => slug(item.title) === showKey);
  if (existingIndex >= 0) {
    state.showsRaw[existingIndex] = { ...state.showsRaw[existingIndex], ...show };
    return state.showsRaw[existingIndex];
  }
  state.showsRaw.push(show);
  return show;
}
export async function loadShowDetail(show = {}) {
  const showTitle = show.title || "";
  const showKey = slug(showTitle);
  const cacheKey = show.id || showKey || showTitle;
  if (!cacheKey) return null;
  if (state.showDetailInflight.has(cacheKey)) return state.showDetailInflight.get(cacheKey);
  const request = (async () => {
    const url = new URL("/api/show", window.location.origin);
    if (show.id) url.searchParams.set("id", show.id);
    if (showTitle) url.searchParams.set("title", showTitle);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { headers: authHeaders(), cache: "no-store", signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Show detail failed ${response.status}`);
      return mergeShowDetail(body.show || null);
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("Show detail request timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  })().finally(() => state.showDetailInflight.delete(cacheKey));
  state.showDetailInflight.set(cacheKey, request);
  return request;
}
// ---------------------------------------------------------------------------
// Legacy in-memory explorer helpers (used by old show grouping path)
// ---------------------------------------------------------------------------
export function matchesExplorerSearch(entry = {}, search = "") {
  const needle = String(search || "").trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    entry.title,
    entry.imdb_id,
    entry.tmdb_id,
    entry.tvdb_id,
    entry.source,
    entry.season,
    entry.episode,
  ]
    .filter((value) => value != null && String(value).trim())
    .map((value) => String(value).toLowerCase())
    .join(" ");
  return haystack.includes(needle);
}
export function sortExplorerItems(items, sortMode) {
  return [...items].sort((a, b) => {
    if (sortMode === "title_asc") return String(a.title).localeCompare(String(b.title)) || watchedTime(b) - watchedTime(a);
    if (sortMode === "title_desc") return String(b.title).localeCompare(String(a.title)) || watchedTime(b) - watchedTime(a);
    if (sortMode === "watched_asc") return watchedTime(a) - watchedTime(b) || String(a.title).localeCompare(String(b.title));
    return watchedTime(b) - watchedTime(a) || String(a.title).localeCompare(String(b.title));
  });
}
function sortShowEntries(entries, sortMode) {
  return [...entries].sort(([titleA, seasonsA], [titleB, seasonsB]) => {
    if (sortMode === "title_asc") return titleA.localeCompare(titleB) || latestWatched(seasonsB) - latestWatched(seasonsA);
    if (sortMode === "title_desc") return titleB.localeCompare(titleA) || latestWatched(seasonsB) - latestWatched(seasonsA);
    if (sortMode === "watched_asc") return earliestWatched(seasonsA) - earliestWatched(seasonsB) || titleA.localeCompare(titleB);
    return latestWatched(seasonsB) - latestWatched(seasonsA) || titleA.localeCompare(titleB);
  });
}
function watchedTime(entry) {
  const time = new Date(entry?.watched_at || "").getTime();
  return Number.isFinite(time) ? time : 0;
}
function allSeasonEpisodes(seasons) {
  return [...seasons.values()].flat();
}
function latestWatched(seasons) {
  return Math.max(...allSeasonEpisodes(seasons).map(watchedTime), 0);
}
function earliestWatched(seasons) {
  const times = allSeasonEpisodes(seasons).map(watchedTime).filter(Boolean);
  return times.length ? Math.min(...times) : 0;
}
export function representativeEpisode(seasons) {
  return sortExplorerItems(allSeasonEpisodes(seasons), "watched_desc")[0] || {};
}
function groupShows(episodes) {
  const shows = new Map();
  for (const episode of episodes) {
    if (!isWatchedHistoryAction(episode)) continue;
    const title = showName(episode.title);
    if (!shows.has(title)) shows.set(title, new Map());
    const seasons = shows.get(title);
    const season = Number(episode.season) || 0;
    if (!seasons.has(season)) seasons.set(season, []);
    seasons.get(season).push(episode);
  }
  return shows;
}
export function seasonsFromShowRecord(show = {}) {
  const seasons = new Map();
  for (const episode of show.episodes || []) {
    if (!isWatchedHistoryAction(episode)) continue;
    const season = Number(episode.season) || 0;
    if (!seasons.has(season)) seasons.set(season, []);
    seasons.get(season).push(episode);
  }
  return seasons;
}
function summaryEpisodeFromShow(show = {}) {
  const representative = show.representative_episode || show.representativeEpisode || {};
  return {
    ...representative,
    id: representative.id || show.id || show.title,
    title: sanitizeTitle(representative.title) || sanitizeTitle(show.title) || "Unknown Show",
    media_type: representative.media_type || "episode",
    watched_at: representative.watched_at || show.latest_watched_at || "",
    source: representative.source || show.source || "",
    imdb_id: representative.imdb_id || show.imdb_id || null,
    tmdb_id: representative.tmdb_id || show.tmdb_id || null,
    tvdb_id: representative.tvdb_id || show.tvdb_id || null,
    poster_url: representative.poster_url || show.poster_url || show.posterUrl || null,
  };
}
export function tmdbLookupIdsFromShow(show = {}, seasons = null) {
  const representative = show.representative_episode || show.representativeEpisode || representativeEpisode(seasons || seasonsFromShowRecord(show));
  return {
    imdbId: show.imdb_id || representative?.imdb_id || "",
    tvdbId: show.tvdb_id || representative?.tvdb_id || "",
  };
}
// ---------------------------------------------------------------------------
// Show record / folder rendering
// ---------------------------------------------------------------------------
export function renderShowRecord(show = {}) {
  const displayTitle = sanitizeTitle(show.title) || "Unknown Show";
  const showKey = slug(displayTitle);
  const representative = summaryEpisodeFromShow(show);
  const seasons = Array.isArray(show.episodes) && show.episodes.length ? seasonsFromShowRecord(show) : null;
  const episodeCount = show.episode_count || (seasons ? allSeasonEpisodes(seasons).length : 0);
  const seasonCount = show.season_count || (seasons ? seasons.size : 0);
  const latestEpisode = seasons ? representativeEpisode(seasons) : representative;
  const tmdbId = show.tmdb_id || "";
  if (currentExplorerView() === "list") {
    const tmdbShow = resolvedTmdbCache("tv", tmdbId, displayTitle);
    const year = tmdbShow?.first_air_date?.slice(0, 4) || "";
    const totalEps = show.total_episodes || tmdbShow?.number_of_episodes || 0;
    const nextAiring = nextAiringCell(tmdbShow || show);
    const pct = totalEps ? Math.round((episodeCount / totalEps) * 100) : null;
    const episodeProgressHtml = totalEps
      ? `<div class="list-eps-progress" data-list-eps data-watched="${episodeCount}" data-total="${totalEps}"><div class="list-eps-bar-track"><div class="list-eps-bar-fill" style="width:${pct}%"></div></div><span class="list-eps-label">${episodeCount} / ${totalEps}</span></div>`
      : `<span class="list-card-col" data-list-eps data-watched="${episodeCount}" data-total="0">${episodeCount}</span>`;
    const sourceEl = latestEpisode?.source ? `<span class="source-badge ${sourceClass(latestEpisode.source)}">${escapeHtml(platformBadge(latestEpisode.source))}</span>` : "";
    return `
      <article class="explorer-list-card explorer-list-show-card" data-show-key="${escapeAttribute(showKey)}" data-alpha-letter="${firstAlphaLetter(displayTitle)}" data-prefetch-type="tv" data-prefetch-tmdb="${escapeAttribute(tmdbId)}" data-prefetch-title="${escapeAttribute(displayTitle)}">
        ${posterMarkup(latestEpisode, "list-thumb-poster")}
        <span class="list-card-title">${escapeHtml(displayTitle)}</span>
        <span class="list-card-col${nextAiring.isStatus && nextAiring.text ? " list-next-air-status" : ""}" data-list-next-air>${escapeHtml(nextAiring.text)}</span>
        ${episodeProgressHtml}
        <span class="list-card-col">${escapeHtml(String(seasonCount || ""))}</span>
        <span class="list-card-col">${latestEpisode?.watched_at ? escapeHtml(formatDate(latestEpisode.watched_at)) : ""}</span>
        <span class="list-card-col list-card-year" data-list-year>${escapeHtml(year)}</span>
      </article>
    `;
  }
  if (currentExplorerView() === "overview") {
    const tmdb = resolvedTmdbCache("tv", tmdbId, displayTitle);
    const genres = tmdb?.genres?.slice(0, 3).map((g) => escapeHtml(g.name)).join(" &middot; ") || "";
    const overview = tmdb?.overview || "";
    const firstYear = tmdb?.first_air_date?.slice(0, 4) || "";
    return `
      <article class="explorer-overview-card explorer-overview-show-card" data-alpha-letter="${firstAlphaLetter(displayTitle)}" data-prefetch-type="tv" data-prefetch-tmdb="${escapeAttribute(tmdbId)}" data-prefetch-title="${escapeAttribute(displayTitle)}">
        <button class="folder-trigger overview-show-poster-btn" type="button" data-show-key="${escapeAttribute(showKey)}" style="border:0;background:transparent;padding:0;display:block;">
          ${posterMarkup(latestEpisode, "overview-thumb-poster")}
        </button>
        <div class="overview-card-meta">
          <div class="overview-card-header">
            <button class="folder-trigger overview-show-title-btn" type="button" data-show-key="${escapeAttribute(showKey)}" style="border:0;background:transparent;padding:0;text-align:left;cursor:pointer;"><b>${escapeHtml(displayTitle)}</b></button>
          </div>
          <div class="overview-card-attrs" data-overview-attrs>${[firstYear, genres].filter(Boolean).join(" &middot; ")}${episodeCount ? `${firstYear || genres ? " &middot; " : ""}${episodeCount} ep${episodeCount !== 1 ? "s" : ""}` : ""}</div>
          <div class="overview-card-text-wrap"><p class="overview-card-text" data-overview-text>${escapeHtml(overview)}</p></div>
        </div>
      </article>
    `;
  }
  const tmdbShow = resolvedTmdbCache("tv", tmdbId, displayTitle);
  const totalEps = show.total_episodes || tmdbShow?.number_of_episodes || 0;
  const latestWatchedAt = latestEpisode?.watched_at || show.latest_watched_at || "";
  return `
    <article class="folder-card" data-alpha-letter="${firstAlphaLetter(displayTitle)}" data-prefetch-type="tv" data-prefetch-tmdb="${escapeAttribute(tmdbId)}" data-prefetch-title="${escapeAttribute(displayTitle)}">
      <button class="folder-trigger" type="button" data-show-key="${escapeAttribute(showKey)}" style="border: 0; background: transparent; padding: 0; width: 100%; text-align: left; display: block;">
        ${posterMarkup(latestEpisode, "explorer-folder-poster")}
        <div class="movie-card-body" style="margin-top: 0.5rem;">
          <b>${escapeHtml(displayTitle)}</b>
          <span>${episodeCount}/${totalEps || "?"} watched</span>
          ${latestWatchedAt ? `<span>${formatDate(latestWatchedAt)}</span>` : ""}
        </div>
      </button>
    </article>
  `;
}
export function renderShowFolder(showTitle, seasons, tmdbId) {
  const showKey = slug(showTitle);
  const latestEpisode = representativeEpisode(seasons);
  return `
    <article class="folder-card" data-prefetch-type="tv" data-prefetch-tmdb="${escapeAttribute(tmdbId || "")}" data-prefetch-title="${escapeAttribute(showTitle)}">
      <button class="folder-trigger" type="button" data-show-key="${showKey}" style="border: 0; background: transparent; padding: 0; width: 100%; text-align: left; display: block;">
        ${posterMarkup(latestEpisode, "explorer-folder-poster")}
        <div class="movie-card-body" style="margin-top: 0.5rem;">
          <b>${escapeHtml(showTitle)}</b>
        </div>
      </button>
    </article>
  `;
}
export function renderSeasonFolder(showKey, season, episodes) {
  const seasonKey = `${showKey}:s${season}`;
  const expanded = state.expandedSeasons.has(seasonKey);
  const sortedEpisodes = sortExplorerItems(episodes, currentExplorerSort());
  return `
    <article class="season-card">
      <button class="season-trigger" type="button" data-season-key="${seasonKey}" aria-expanded="${expanded}">
        <span class="accordion-chevron ${expanded ? "expanded" : ""}">▼</span>
        <b>Season ${String(season || "?").padStart(2, "0")}</b>
        <span>${episodes.length} watched episodes</span>
      </button>
      <div class="episode-list ${expanded ? "" : "hidden"}">
        ${sortedEpisodes
      .map((episode) => {
        return `
              <article class="episode-row" style="display: flex; flex-direction: column; align-items: stretch; gap: 0.5rem; padding: 0.5rem;">
                <div style="display: flex; align-items: center; gap: 0.5rem; min-width: 0;">
                  ${posterMarkup(episode, "explorer-episode-poster")}
                  <span class="episode-code">[ E${String(episode.episode || "?").padStart(2, "0")} ]</span>
                  <b style="flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.35rem;">
                    [ ${escapeHtml(episodeTitle(episode.title, episode.episode))} ]
                    ${renderSyncStatusDot(episode)}
                  </b>
                  <button class="debug-badge" type="button" data-history-id="${episode.id}">${formatDate(episode.watched_at)}</button>
                </div>
              </article>
            `;
      })
      .join("")}
      </div>
    </article>
  `;
}
// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
export function emptyExplorer(message) {
  return `<div class="empty-log"><b>${escapeHtml(message)}</b><span>Import history or wait for webhook events.</span></div>`;
}
