import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, slug, showTitleFrom, showName, movieHref, sourceBadgeHtml, formatDate, resolveEpisodeTitle, episodeCode, normalizePlatformSource, platformBadge, sourceClass, platformIconUrl } from "./utils.js";
import { posterMarkup, hydratePosters, lookupPosterUrl, bindPosterImageErrorHandler, tmdbPoster } from "./images.js";

const PART_WATCHED_DASHBOARD_LIMIT = 30;
const EXPLORER_PAGE_SIZE = 240;

let _cb = {};

export function initDashboard(callbacks) {
  _cb = callbacks;
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

export function getRowFitLimit(rowElement) {
  // Dashboard history rows scroll horizontally — render more cards than fit on
  // screen so the row scrolls rather than cutting off content.
  if (rowElement && (rowElement.id === "tvHistoryRow" || rowElement.id === "movieHistoryRow")) {
    return 24;
  }
  const width = rowElement ? rowElement.clientWidth : 0;
  if (width <= 0) return 10;
  const maxCards = Math.floor((width + 12) / 172);
  return Math.max(2, maxCards);
}

function stablePosterIdentity(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  if (lowered.includes("favicon") || lowered.includes("placeholder") || lowered.includes("no-poster")) return "";
  try {
    const url = new URL(raw, window.location.origin);
    if (url.hostname.toLowerCase() === "image.tmdb.org") {
      return `tmdb-poster:${url.pathname.split("/").filter(Boolean).pop() || raw}`;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

export function mediaRecordIdentity(record = {}, mode = "") {
  if (mode === "shows" || record.media_type === "episode") {
    const title = record.show_title || record.title || "";
    return `show:${slug(title)}`;
  }
  const poster = stablePosterIdentity(record.poster_url || record.posterUrl || record.imageUrl || record.thumb || "");
  if (poster) return `movie:poster:${poster}`;
  if (record.imdb_id) return `movie:imdb:${String(record.imdb_id).toLowerCase()}`;
  if (record.tmdb_id) return `movie:tmdb:${String(record.tmdb_id).toLowerCase()}`;
  if (record.tvdb_id) return `movie:tvdb:${String(record.tvdb_id).toLowerCase()}`;
  return `movie:title:${slug(record.title)}`;
}

export function dedupeMediaRecords(records = [], mode = "") {
  const map = new Map();
  for (const record of records) {
    const key = mediaRecordIdentity(record, mode);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, record);
      continue;
    }
    const existingDate = existing.latest_watched_at || existing.watched_at || "";
    const recordDate = record.latest_watched_at || record.watched_at || "";
    if (recordDate > existingDate) map.set(key, record);
  }
  return [...map.values()];
}

export function progressRecordIdentity(record = {}) {
  const mediaType = record.media_type || "";
  const imdb = String(record.imdb_id || "").trim();
  const tmdb = String(record.tmdb_id || "").trim();
  const tvdb = String(record.tvdb_id || "").trim();

  if (mediaType === "episode") {
    const season = record.season ?? "unknown";
    const episode = record.episode ?? "unknown";
    const showTitle = slug(record.show_title || showTitleFrom(record.title) || "");
    if (showTitle && season !== "unknown" && episode !== "unknown") {
      return `episode|show:${showTitle}|s:${season}|e:${episode}`;
    }
    const id = imdb ? `imdb:${imdb}` : tmdb ? `tmdb:${tmdb}` : tvdb ? `tvdb:${tvdb}` : slug(record.title);
    return `episode|id:${id}|s:${season}|e:${episode}`;
  }

  if (mediaType === "movie") {
    const id = imdb ? `imdb:${imdb}` : tmdb ? `tmdb:${tmdb}` : tvdb ? `tvdb:${tvdb}` : slug(record.title);
    return `movie|id:${id}`;
  }

  return `unknown|${slug(record.title)}|${record.updated_at || ""}`;
}

export function dedupePlaybackProgress(items = []) {
  const map = new Map();
  for (const item of items) {
    const key = progressRecordIdentity(item);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...item, sources: [item.source].filter(Boolean) });
      continue;
    }
    if (item.source && !existing.sources.includes(item.source)) {
      existing.sources.push(item.source);
    }
    const existingTime = Number(existing.updated_at || 0);
    const itemTime = Number(item.updated_at || 0);
    if (itemTime > existingTime) {
      const sources = existing.sources;
      Object.assign(existing, item);
      existing.sources = sources;
    } else if (itemTime === existingTime) {
      if (Number(item.progress || 0) > Number(existing.progress || 0)) {
        const sources = existing.sources;
        Object.assign(existing, item);
        existing.sources = sources;
      }
    }
  }
  return [...map.values()];
}

function prefetchDashboardHistoryTmdb(tvEntries, movieEntries) {
  if (!state.token) return;
  const seen = new Set();
  for (const entry of movieEntries) {
    const key = `movie|${entry.tmdb_id || ""}|${String(entry.title || "").toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      _cb.fetchTmdbDetails?.("movie", entry.tmdb_id, entry.title);
    }
  }
  for (const entry of tvEntries) {
    const showTitle = entry.show_title || showTitleFrom(entry.title);
    const showKeySlug = slug(showTitle);
    const show = state.showsRaw.find((s) => slug(s.title) === showKeySlug);
    const tmdbId = show?.tmdb_id || entry.tmdb_id;
    const key = `tv|${tmdbId || ""}|${String(showTitle || "").toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      _cb.fetchTmdbDetails?.("tv", tmdbId, showTitle);
    }
  }
}

export function renderHistoryCard(entry) {
  const isEpisode = entry.media_type === "episode";

  if (isEpisode) {
    const showTitle = entry.show_title || showTitleFrom(entry.title);
    const { epTitle, needsResolve } = resolveEpisodeTitle(entry);

    if (needsResolve) {
      setTimeout(() => {
        const el = document.querySelector(`[data-history-id="${entry.id}"] .history-card-episode-title`);
        _cb.resolveEpisodeTitleFromTmdb?.(entry, el);
      }, 50);
    }

    const canonicalShowName = entry.show_title || showName(entry.title);
    const showKeySlug = slug(canonicalShowName);
    const href = `/tvshow/${showKeySlug}`;

    return `
      <a class="history-mini-card" data-history-id="${entry.id}" href="${escapeAttribute(href)}" data-prefetch-type="tv" data-prefetch-tmdb="${escapeAttribute(entry.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(showTitle || "")}">
        <span class="history-mini-card-poster-wrapper">
          ${posterMarkup(entry, "history-mini-poster")}
        </span>
        <div class="history-mini-card-details">
          <b class="history-mini-card-title" title="${escapeAttribute(showTitle)}">${escapeHtml(showTitle)}</b>
          <span class="history-mini-card-sub history-card-episode-title" title="${escapeAttribute(epTitle)}">${escapeHtml(epTitle)}</span>
          <span class="history-mini-card-sub">${escapeHtml(episodeCode(entry.season, entry.episode))} · ${formatDate(entry.watched_at)}</span>
        </div>
      </a>
    `;
  } else {
    const href = entry.tmdb_id ? `/movie/tmdb/${entry.tmdb_id}` : movieHref(entry);
    return `
      <a class="history-mini-card" data-history-id="${entry.id}" href="${escapeAttribute(href)}" data-prefetch-type="movie" data-prefetch-tmdb="${escapeAttribute(entry.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(entry.title || "")}">
        <span class="history-mini-card-poster-wrapper">
          ${posterMarkup(entry, "history-mini-poster")}
        </span>
        <div class="history-mini-card-details">
          <b class="history-mini-card-title" title="${escapeAttribute(entry.title)}">${escapeHtml(entry.title)}</b>
          <span class="history-mini-card-sub">${formatDate(entry.watched_at)}</span>
        </div>
      </a>
    `;
  }
}

function renderDashboardHistoryPageCard(entry) {
  const isEpisode = entry.media_type === "episode";
  let displayTitle = entry.title;
  let epTitle = "";
  let href = "";

  if (isEpisode) {
    displayTitle = entry.show_title || showTitleFrom(entry.title);
    const resolved = resolveEpisodeTitle(entry);
    epTitle = resolved.epTitle;

    if (resolved.needsResolve) {
      setTimeout(() => {
        const el = document.querySelector(`[data-history-id="${entry.id}"] .history-card-episode`);
        _cb.resolveEpisodeTitleFromTmdb?.(entry, el);
      }, 50);
    }

    const canonicalShowName = entry.show_title || showName(entry.title);
    href = `/tvshow/${slug(canonicalShowName)}`;
  } else {
    href = entry.tmdb_id ? `/movie/tmdb/${entry.tmdb_id}` : movieHref(entry);
  }

  const sourceBadge = entry.source ? sourceBadgeHtml(entry.source) : "None";
  return `
    <a class="history-page-card dashboard-history-page-card" data-history-id="${entry.id}" href="${escapeAttribute(href)}" data-prefetch-type="${isEpisode ? "tv" : "movie"}" data-prefetch-tmdb="${escapeAttribute(entry.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(displayTitle || "")}">
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
              <span class="meta-value">${escapeHtml(episodeCode(entry.season, entry.episode))}</span>
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

export function observeDashboardPosters() {
  state.dashboardPosterObserver?.disconnect();
  if (!("IntersectionObserver" in window)) return;

  state.dashboardPosterObserver = new IntersectionObserver(
    async (entries) => {
      const fallbacks = entries
        .filter((entry) => entry.isIntersecting && entry.target.classList.contains("poster-fallback"))
        .map((entry) => entry.target);

      if (!fallbacks.length) return;

      const hydrateOne = async (fallback) => {
        const posterId = fallback.dataset.posterId;
        if (!posterId || state.posterLookupCache.has(posterId)) return;

        const posterUrl = await lookupPosterUrl(posterId);
        if (!posterUrl || !fallback.isConnected || !fallback.classList.contains("poster-fallback")) return;

        const image = document.createElement("img");
        image.className = fallback.className.replace(/\bposter-fallback\b/g, "").trim() || fallback.className;
        bindPosterImageErrorHandler(image);
        image.src = posterUrl;
        image.alt = `${fallback.getAttribute("aria-label") || "Media poster"}`;
        image.loading = "lazy";
        image.decoding = "async";
        image.referrerPolicy = "no-referrer";
        image.dataset.posterId = posterId;
        fallback.replaceWith(image);
      };

      // Each IntersectionObserver batch is just the handful of cards that
      // scrolled into view, not the whole row — no need to serialize them.
      await Promise.allSettled(fallbacks.map(hydrateOne));
    },
    { rootMargin: "200px" },
  );

  const tvRow = elements.tvHistoryRow;
  const movieRow = elements.movieHistoryRow;
  if (tvRow) {
    for (const fallback of tvRow.querySelectorAll("[data-poster-id].poster-fallback")) {
      state.dashboardPosterObserver.observe(fallback);
    }
  }
  if (movieRow) {
    for (const fallback of movieRow.querySelectorAll("[data-poster-id].poster-fallback")) {
      state.dashboardPosterObserver.observe(fallback);
    }
  }
}

function syncDashboardHistoryViewButtons() {
  for (const button of elements.dashboardHistoryViewButtons || []) {
    button.classList.toggle("active", button.dataset.dashboardHistoryView === state.dashboardHistoryViewMode);
  }
}

function setDashboardHistoryRowMode(row) {
  if (!row) return;
  row.classList.toggle("dashboard-history-card-row", state.dashboardHistoryViewMode === "cards");
}

export function renderDashboard() {
  renderPartWatched();
  syncDashboardHistoryViewButtons();
  setDashboardHistoryRowMode(elements.tvHistoryRow);
  setDashboardHistoryRowMode(elements.movieHistoryRow);

  if (!state.history.length) {
    if (elements.tvHistoryRow) {
      elements.tvHistoryRow.innerHTML = `
        <div class="empty-log">
          <b>No watch history yet</b>
          <span>Import a Trakt export or send watched webhooks to start building the archive.</span>
        </div>
      `;
    }
    if (elements.movieHistoryRow) {
      elements.movieHistoryRow.innerHTML = "";
    }
    return;
  }

  const tvHistory = state.history.filter((entry) => entry.media_type === "episode");
  const movieHistory = dedupeMediaRecords(state.history.filter((entry) => entry.media_type === "movie"), "movies");

  let visibleTv = [];
  let visibleMovies = [];

  if (elements.tvHistoryRow) {
    if (!tvHistory.length) {
      elements.tvHistoryRow.innerHTML = `
        <div class="empty-log">
          <b>No TV history in this preview</b>
          <span>New watched episodes will appear here.</span>
        </div>
      `;
    } else {
      const tvFitLimit = getRowFitLimit(elements.tvHistoryRow);
      visibleTv = tvHistory.slice(0, tvFitLimit);
      elements.tvHistoryRow.innerHTML = visibleTv
        .map(state.dashboardHistoryViewMode === "cards" ? renderDashboardHistoryPageCard : renderHistoryCard)
        .join("");
      hydratePosters(elements.tvHistoryRow);
    }
  }

  if (elements.movieHistoryRow) {
    if (!movieHistory.length) {
      elements.movieHistoryRow.innerHTML = `
        <div class="empty-log">
          <b>No movie history in this preview</b>
          <span>New watched movies will appear here.</span>
        </div>
      `;
    } else {
      const movieFitLimit = getRowFitLimit(elements.movieHistoryRow);
      visibleMovies = movieHistory.slice(0, movieFitLimit);
      elements.movieHistoryRow.innerHTML = visibleMovies
        .map(state.dashboardHistoryViewMode === "cards" ? renderDashboardHistoryPageCard : renderHistoryCard)
        .join("");
      hydratePosters(elements.movieHistoryRow);
    }
  }

  if (visibleTv.length || visibleMovies.length) {
    prefetchDashboardHistoryTmdb(visibleTv, visibleMovies);
  }

  observeDashboardPosters();
}

export function updateDashboardSplitState() {
  if (!elements.timelineView) return;
  const playing = state.activeSessions.length > 0;
  const hasPartWatched = state.partWatchedRaw.length > 0;
  const dashState = hasPartWatched ? (playing ? "1" : "2") : "3";
  elements.timelineView.dataset.dashState = dashState;
}

function applyPartWatchedPosterWidth() {
  document.documentElement.style.setProperty("--part-watched-poster-width", "128px");
}

export function resetPartWatchedView(key = "") {
  state.partWatchedRaw = [];
  state.partWatchedOffset = 0;
  state.partWatchedHasMore = true;
  state.partWatchedLoading = false;
  state.partWatchedQueryKey = key;
  state.partWatchedScrollArmed = false;
}

export function renderPartWatchedCard(entry) {
  const isEpisode = entry.media_type === "episode";
  let displayTitle = entry.title;
  let epTitle = "";

  if (isEpisode) {
    displayTitle = entry.show_title || showTitleFrom(entry.title);
    const resolved = resolveEpisodeTitle(entry);
    epTitle = resolved.epTitle;

    if (resolved.needsResolve) {
      setTimeout(() => {
        const el = document.querySelector(`[data-part-watched-card-id="${entry.id}"] .part-watched-card-episode`);
        _cb.resolveEpisodeTitleFromTmdb?.(entry, el);
      }, 50);
    }
  }

  const sources = Array.isArray(entry.sources) && entry.sources.length ? entry.sources : (entry.source ? [entry.source] : []);
  const sourceBadges = sources.map((src) => renderPartWatchedAppBadge(src, entry, isEpisode ? displayTitle : entry.title)).join(" ");
  const sourceBadgeMarkup = sourceBadges || "None";
  const progressPercent = Math.round(entry.progress || 0);
  const formattedTime = entry.updated_at ? formatDate(entry.updated_at) : "";
  const prefetchType = isEpisode ? "tv" : "movie";
  const prefetchTitle = isEpisode ? displayTitle : entry.title;
  const mediaHref = isEpisode
    ? `/tvshow/${encodeURIComponent(slug(displayTitle))}`
    : `/movie/${encodeURIComponent(slug(entry.title || displayTitle))}`;

  return `
    <div class="part-watched-page-card" data-part-watched-card-id="${entry.id}" data-part-watched-media-key="${escapeAttribute(entry.media_key)}" data-prefetch-type="${prefetchType}" data-prefetch-title="${escapeAttribute(prefetchTitle)}"${entry.tmdb_id ? ` data-prefetch-tmdb="${escapeAttribute(entry.tmdb_id)}"` : ""}>
      <a class="part-watched-card-poster-wrapper" href="${escapeAttribute(mediaHref)}" data-part-watched-href="${escapeAttribute(mediaHref)}" aria-label="View ${escapeAttribute(displayTitle)}">
        ${posterMarkup(entry, "part-watched-page-poster")}
      </a>
      <div class="part-watched-card-details">
        <div class="part-watched-card-header">
          <b class="part-watched-card-title" title="${escapeAttribute(displayTitle)}">${escapeHtml(displayTitle)}</b>
          ${isEpisode ? `<span class="part-watched-card-episode" title="${escapeAttribute(epTitle)}">${escapeHtml(epTitle)}</span>` : ""}
        </div>
        <div class="part-watched-card-meta">
          ${isEpisode ? `<span><span class="meta-label">Season/Ep:</span> ${escapeHtml(episodeCode(entry.season, entry.episode))}</span>` : ""}
          <span><span class="meta-label">Last Played:</span> ${formattedTime}</span>
          <span><span class="meta-label">App Used:</span> ${sourceBadgeMarkup}</span>
        </div>

        <div class="part-watched-progress-container">
          <div class="part-watched-progress-bar">
            <div class="part-watched-progress-fill" style="width: ${progressPercent}%;"></div>
          </div>
          <span class="part-watched-progress-text">${progressPercent}% watched</span>
        </div>

        <div class="part-watched-card-actions">
          <button class="button-primary part-watched-action-btn" type="button" data-action-watch="${escapeAttribute(entry.media_key)}" data-title="${escapeAttribute(entry.title)}">
            Mark Watched
          </button>
          <button class="button-ghost part-watched-action-btn" type="button" data-action-unwatch="${escapeAttribute(entry.media_key)}" data-title="${escapeAttribute(entry.title)}">
            Clear Progress
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderPartWatchedAppBadge(source, entry, mediaTitle) {
  const target = normalizePlatformSource(source);
  const label = platformBadge(source);
  return `
    <button class="source-badge source-badge--icon ${sourceClass(source)} part-watched-app-badge" type="button"
      data-part-watched-app-target="${escapeAttribute(target)}"
      data-part-watched-app-type="${entry.media_type === "episode" ? "tv" : "movie"}"
      data-part-watched-app-title="${escapeAttribute(mediaTitle || "")}"
      data-part-watched-app-tmdb="${escapeAttribute(entry.tmdb_id || "")}"
      data-part-watched-app-imdb="${escapeAttribute(entry.imdb_id || "")}"
      data-part-watched-app-tvdb="${escapeAttribute(entry.tvdb_id || "")}"
      aria-label="Open ${escapeAttribute(label)}"
      title="Open in ${escapeAttribute(label)}">
      <img class="source-badge-icon" src="${platformIconUrl(source)}" alt="" loading="lazy" />
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

function bindPartWatchedAppBadges(root) {
  for (const button of root.querySelectorAll("[data-part-watched-app-target]")) {
    button.addEventListener("click", async () => {
      const target = button.dataset.partWatchedAppTarget;
      const popup = window.open("about:blank", "_blank");
      if (!popup) {
        _cb.setMessage?.("Allow pop-ups to open the media app.", "error");
        return;
      }
      popup.opener = null;

      try {
        const params = new URLSearchParams({
          mediaType: button.dataset.partWatchedAppType || "movie",
          title: button.dataset.partWatchedAppTitle || "",
        });
        for (const [key, datasetKey] of [["tmdbId", "partWatchedAppTmdb"], ["imdbId", "partWatchedAppImdb"], ["tvdbId", "partWatchedAppTvdb"]]) {
          if (button.dataset[datasetKey]) params.set(key, button.dataset[datasetKey]);
        }

        const response = await fetch(`/api/media-app-links?${params.toString()}`, { headers: authHeaders(), cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        const link = Array.isArray(body.links)
          ? body.links.find((candidate) => normalizePlatformSource(candidate?.target) === target)
          : null;
        if (!response.ok || !link?.url) throw new Error(`Could not open ${platformBadge(target)}.`);
        popup.location.href = link.url;
      } catch (error) {
        popup.close();
        _cb.setMessage?.(error.message, "error");
      }
    });
  }
}

export function renderPartWatched() {
  if (!elements.partWatchedPanel) return;
  const key = "default";
  if (state.partWatchedQueryKey !== key) resetPartWatchedView(key);

  if (!state.partWatchedRaw.length && state.partWatchedHasMore && !state.partWatchedLoading && state.token) {
    loadPartWatched().catch((error) => _cb.setMessage?.(error.message, "error"));
  }

  applyPartWatchedPosterWidth();

  if (!state.partWatchedRaw.length) {
    if (state.partWatchedLoading) {
      if (elements.partWatchedSection) elements.partWatchedSection.classList.remove("hidden");
      elements.partWatchedPanel.innerHTML = `<div class="empty-log"><b>Loading partly watched items…</b></div>`;
    } else {
      if (elements.partWatchedSection) elements.partWatchedSection.classList.add("hidden");
      elements.partWatchedPanel.innerHTML = "";
    }
    updateDashboardSplitState();
    return;
  }

  if (elements.partWatchedSection) elements.partWatchedSection.classList.remove("hidden");
  const items = state.partWatchedRaw.slice(0, PART_WATCHED_DASHBOARD_LIMIT);
  elements.partWatchedPanel.innerHTML = items.map(renderPartWatchedCard).join("");
  bindPartWatchedAppBadges(elements.partWatchedPanel);
  hydratePosters(elements.partWatchedPanel);
  _cb.observeExplorerTmdbPrefetch?.(elements.partWatchedPanel);
  updateDashboardSplitState();
}

export async function loadPartWatched() {
  if (state.partWatchedLoading || !state.partWatchedHasMore) return;
  state.partWatchedLoading = true;

  try {
    const url = new URL("/api/playback-progress", window.location.origin);
    url.searchParams.set("limit", String(EXPLORER_PAGE_SIZE));
    url.searchParams.set("offset", String(state.partWatchedOffset));

    const res = await fetch(url, { headers: authHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Progress load failed ${res.status}`);

    const items = Array.isArray(body.progress) ? body.progress : [];
    state.partWatchedRaw = dedupePlaybackProgress([...state.partWatchedRaw, ...items]);
    state.partWatchedOffset += items.length;
    state.partWatchedHasMore = false;
  } finally {
    state.partWatchedLoading = false;
    renderPartWatched();
  }
}
