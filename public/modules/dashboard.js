import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, slug, showTitleFrom, showName, movieHref, movieTmdbHref, tvShowTmdbHref, tvShowTvdbHref, sourceBadgeHtml, formatDate, formatTmdbDate, resolveEpisodeTitle, episodeTitle, episodeCode, normalizePlatformSource, platformBadge, sourceClass, platformIconMarkup, platformSourceValues, computeProgress } from "./utils.js?v=20260824h";
import { posterMarkup, posterOverflowMenu, hydratePosters, lookupPosterUrl, bindPosterImageErrorHandler, safePosterElementUrl, tmdbPoster } from "./images.js?v=20260831m";
import { renderDashboardChecklist } from "./onboarding.js";

const PART_WATCHED_DASHBOARD_LIMIT = 30;
const EXPLORER_PAGE_SIZE = 240;
const PART_WATCHED_REQUEST_TIMEOUT_MS = 15000;

let _cb = {};

export function initDashboard(callbacks) {
  _cb = callbacks;
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

export function getRowFitLimit(rowElement) {
  // Dashboard history rows scroll horizontally - render more cards than fit on
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
    const tmdbId = record.show_tmdb_id || (mode === "shows" ? record.tmdb_id : "");
    const tvdbId = record.show_tvdb_id || (mode === "shows" ? record.tvdb_id : "");
    const imdbId = record.show_imdb_id || (mode === "shows" ? record.imdb_id : "");
    if (tmdbId) return `show:tmdb:${String(tmdbId).toLowerCase()}`;
    if (tvdbId) return `show:tvdb:${String(tvdbId).toLowerCase()}`;
    if (imdbId) return `show:imdb:${String(imdbId).toLowerCase()}`;
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
    const existingTime = Number(existing.updated_at || 0);
    const itemTime = Number(item.updated_at || 0);
    if (itemTime > existingTime) {
      Object.assign(existing, item);
      // The badge describes the app that supplied the progress row currently
      // being displayed. Do not retain sources from older duplicate rows: a
      // stale match from another server can otherwise make Part Watched claim
      // that playback came from multiple apps.
      existing.sources = [item.source].filter(Boolean);
    } else if (itemTime === existingTime) {
      if (partWatchedProgress(item) > partWatchedProgress(existing)) {
        Object.assign(existing, item);
        existing.sources = [item.source].filter(Boolean);
      }
    }
  }
  return [...map.values()];
}

export function partWatchedProgress(entry = {}) {
  const positionMs = Number(entry.position_ms ?? entry.positionMs ?? 0);
  const durationMs = Number(entry.duration_ms ?? entry.durationMs ?? 0);
  if (Number.isFinite(durationMs) && durationMs > 0) return computeProgress(positionMs, durationMs);
  const progress = Number(entry.progress || 0);
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : 0;
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
    const show = state.showsRaw.find((s) => (
      (entry.show_tmdb_id && String(s.tmdb_id || "") === String(entry.show_tmdb_id))
      || (entry.show_tvdb_id && String(s.tvdb_id || "") === String(entry.show_tvdb_id))
      || (!entry.show_tmdb_id && !entry.show_tvdb_id && slug(s.title) === showKeySlug)
    ));
    const tmdbId = show?.tmdb_id || entry.show_tmdb_id || entry.tmdb_id;
    const key = `tv|${tmdbId || ""}|${String(showTitle || "").toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      _cb.fetchTmdbDetails?.("tv", tmdbId, showTitle);
    }
  }
}

function actualWatchCount(entry = {}) {
  const explicit = Number(entry.watch_count);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const historyCount = Array.isArray(entry.playHistory) ? entry.playHistory.length : 0;
  return historyCount || (entry.watched_at ? 1 : 0);
}

function actualWatchText(entry = {}) {
  const count = actualWatchCount(entry);
  return count > 1 ? ` · ${count} actual watches` : "";
}

function actualWatchLabel(entry = {}) {
  const count = actualWatchCount(entry);
  if (count <= 1) return "";
  return count === 2 ? "Watched Twice" : `Watched ${count} Times`;
}

function showProviderIds(entry = {}) {
  return new Map([
    ["imdb", entry.show_imdb_id],
    ["tmdb", entry.show_tmdb_id],
    ["tvdb", entry.show_tvdb_id],
  ].filter(([, value]) => String(value || "").trim()).map(([kind, value]) => [kind, String(value).trim().toLowerCase()]));
}

function sameDashboardEpisode(left = {}, right = {}) {
  if (left.media_type !== "episode" || right.media_type !== "episode") return false;
  if (String(left.season ?? "") !== String(right.season ?? "")) return false;
  if (String(left.episode ?? "") !== String(right.episode ?? "")) return false;

  const leftTitle = slug(left.show_title || showTitleFrom(left.title));
  const rightTitle = slug(right.show_title || showTitleFrom(right.title));
  if (!leftTitle || leftTitle !== rightTitle) return false;

  const leftIds = showProviderIds(left);
  const rightIds = showProviderIds(right);
  if (!leftIds.size || !rightIds.size) return true;
  if ([...leftIds].some(([kind, value]) => rightIds.get(kind) === value)) return true;

  // A TMDB-only row and a TVDB-only row can still be the same series. Keep
  // same-title episodes together unless both rows disagree within the same
  // provider namespace, which is the signal for a genuine reboot/remake.
  return ![...leftIds.keys()].some((kind) => leftIds.has(kind) && rightIds.has(kind));
}

export function mergeDashboardHistoryEntries(entries = []) {
  const groups = [];
  for (const entry of entries) {
    if (!entry || entry.media_type !== "episode") {
      groups.push({ entry: { ...entry }, sources: new Set(platformSourceValues(entry)), watchCount: actualWatchCount(entry) });
      continue;
    }

    const group = groups.find((candidate) => sameDashboardEpisode(candidate.entry, entry));
    if (!group) {
      groups.push({ entry: { ...entry }, sources: new Set(platformSourceValues(entry)), watchCount: actualWatchCount(entry) });
      continue;
    }

    for (const source of platformSourceValues(entry)) group.sources.add(source);
    group.watchCount = Math.max(group.watchCount, actualWatchCount(entry));

    const currentTime = String(group.entry.watched_at || "");
    const entryTime = String(entry.watched_at || "");
    if (entryTime > currentTime) group.entry = { ...entry };

    // Keep useful metadata when the newest source row is sparse.
    for (const field of ["show_title", "show_imdb_id", "show_tmdb_id", "show_tvdb_id", "show_poster_url", "episode_title", "poster_url", "imdb_id", "tmdb_id", "tvdb_id"]) {
      if (!group.entry[field] && entry[field]) group.entry[field] = entry[field];
    }
  }

  return groups
    .map(({ entry, sources, watchCount }) => {
      const sourceValues = platformSourceValues({ ...entry, sources: [...sources] });
      return {
        ...entry,
        sources: sourceValues,
        watch_count: Math.max(Number(entry.watch_count) || 0, watchCount),
      };
    })
    .sort((left, right) => String(right.watched_at || "").localeCompare(String(left.watched_at || "")));
}

function historySourceBadges(entry = {}) {
  return platformSourceValues(entry).map((source) => sourceBadgeHtml(source)).join(" ") || "None";
}

export function renderHistoryCard(entry) {
  if (entry.isPartWatched || entry.part_watched) {
    return renderDashboardHistoryPageCard(entry, { partWatched: true });
  }

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
    const href = tvShowHrefFromHistoryEntry(entry, canonicalShowName);
    const posterEntry = entry.show_poster_url
      ? { ...entry, poster_url: entry.show_poster_url, prefer_raw_poster: true }
      : entry;

    return `
      <a class="history-mini-card" data-history-id="${entry.id}" href="${escapeAttribute(href)}" data-prefetch-type="tv" data-prefetch-tmdb="${escapeAttribute(entry.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(showTitle || "")}">
        <span class="history-mini-card-poster-wrapper">
          ${posterMarkup(posterEntry, "history-mini-poster")}
          ${posterOverflowMenu(entry, { showTitle, label: showTitle })}
        </span>
        <div class="history-mini-card-details">
          <b class="history-mini-card-title" title="${escapeAttribute(showTitle)}">${escapeHtml(showTitle)}</b>
          <span class="history-mini-card-sub history-card-episode-title" title="${escapeAttribute(epTitle)}">${escapeHtml(epTitle)}</span>
          <span class="history-mini-card-sub">${escapeHtml(episodeCode(entry.season, entry.episode))} · ${formatDate(entry.watched_at)}${actualWatchText(entry)}</span>
        </div>
      </a>
    `;
  } else {
    const href = entry.tmdb_id ? movieTmdbHref(entry.tmdb_id, entry.title) : movieHref(entry);
    return `
      <a class="history-mini-card" data-history-id="${entry.id}" href="${escapeAttribute(href)}" data-prefetch-type="movie" data-prefetch-tmdb="${escapeAttribute(entry.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(entry.title || "")}">
        <span class="history-mini-card-poster-wrapper">
          ${posterMarkup(entry, "history-mini-poster")}
          ${posterOverflowMenu(entry)}
        </span>
        <div class="history-mini-card-details">
          <b class="history-mini-card-title" title="${escapeAttribute(entry.title)}">${escapeHtml(entry.title)}</b>
          <span class="history-mini-card-sub">${formatDate(entry.watched_at)}${actualWatchText(entry)}</span>
        </div>
      </a>
    `;
  }
}

function tvShowHrefFromHistoryEntry(entry = {}, title = "") {
  let href = "";
  if (entry.show_tmdb_id) href = tvShowTmdbHref(entry.show_tmdb_id, title);
  else if (entry.show_tvdb_id) href = tvShowTvdbHref(entry.show_tvdb_id, title);
  else if (entry.tmdb_id) href = tvShowTmdbHref(entry.tmdb_id, title);
  else if (entry.tvdb_id) href = tvShowTvdbHref(entry.tvdb_id, title);
  else href = `/tvshow/${slug(title || entry.show_title || showTitleFrom(entry.title))}`;

  const season = Number(entry.season ?? entry.seasonNumber);
  const episode = Number(entry.episode ?? entry.episodeNumber);
  if (Number.isInteger(season) && season >= 0 && Number.isInteger(episode) && episode >= 1) {
    return `${href}/season/${season}/episode/${episode}`;
  }
  return href;
}

function cssSelectorValue(value = "") {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function dashboardCardIdentity(entry = {}) {
  return String(entry.id ?? entry.media_key ?? progressRecordIdentity(entry));
}

function upNextAvailabilityLabel(entry = {}) {
  const airDate = entry.air_date || entry.airDate || "";
  if (!airDate) return "Ready to watch";
  const airDateKey = String(airDate).trim().slice(0, 10);
  return airDateKey > new Date().toISOString().slice(0, 10)
    ? `Airs ${formatTmdbDate(airDate)}`
    : `Ready since ${formatTmdbDate(airDate)}`;
}

function dashboardUpNextEpisodeTitle(entry, showTitle) {
  const storedTitle = String(entry.episode_title || entry.episodeTitle || "").trim();
  const generatedTitle = episodeTitle(entry.title || "", entry.episode);
  const code = episodeCode(entry.season, entry.episode);
  const show = String(showTitle || "").trim().toLowerCase();
  const isGeneratedLabel = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return true;
    if (show && code && (normalized === `${show} - ${code.toLowerCase()}` || normalized === `${show} ${code.toLowerCase()}`)) return true;
    return false;
  };

  if (storedTitle && !isGeneratedLabel(storedTitle)) return storedTitle;
  if (generatedTitle && generatedTitle !== String(entry.title || "").trim() && !isGeneratedLabel(generatedTitle)) return generatedTitle;
  return storedTitle && !isGeneratedLabel(storedTitle) ? storedTitle : "";
}

export function renderDashboardHistoryPageCard(entry, options = {}) {
  const isPartWatched = Boolean(options.partWatched || entry.isPartWatched || entry.part_watched);
  const isUpNext = Boolean(options.upNext || entry.isUpNext || entry.up_next);
  const isEpisode = entry.media_type === "episode";
  const isResume = isPartWatched || (isUpNext && String(entry.queue_kind || "") === "resume");
  let displayTitle = entry.title;
  let epTitle = "";
  let href = "";
  const cardId = isPartWatched ? partWatchedCardIdentity(entry) : dashboardCardIdentity(entry);

  if (isEpisode) {
    displayTitle = entry.show_title || showTitleFrom(entry.title);
    const resolved = isUpNext
      ? { epTitle: dashboardUpNextEpisodeTitle(entry, displayTitle), needsResolve: false }
      : resolveEpisodeTitle(entry);
    epTitle = resolved.epTitle;

    if (resolved.needsResolve) {
      setTimeout(() => {
        const attribute = isPartWatched
          ? "data-part-watched-card-id"
          : "data-history-id";
        const el = document.querySelector(`[${attribute}="${cssSelectorValue(cardId)}"] .history-card-episode`);
        _cb.resolveEpisodeTitleFromTmdb?.(entry, el);
      }, 50);
    }

    const canonicalShowName = entry.show_title || showName(entry.title);
    href = tvShowHrefFromHistoryEntry(entry, canonicalShowName);
  } else {
    href = entry.tmdb_id ? movieTmdbHref(entry.tmdb_id, entry.title) : movieHref(entry);
  }

  const sources = platformSourceValues(entry);
  const sourceBadge = isPartWatched
    ? (sources.map((source) => renderPartWatchedAppBadge(source, entry, isEpisode ? displayTitle : entry.title)).join(" ") || "None")
    : historySourceBadges(entry);
  const isInteractive = isPartWatched || isUpNext;
  const prefetchType = isEpisode ? "tv" : "movie";
  const prefetchTmdb = isEpisode ? (entry.show_tmdb_id || entry.tmdb_id || "") : (entry.tmdb_id || "");
  const posterLabel = `View ${displayTitle || "media"}`;
  // Playback-progress rows use their stable media key as the identity that
  // /api/poster can resolve. A progress row's generic `id` can be a watch
  // record id (or another source-specific identifier), which leaves the new
  // Part Watched card on the placeholder even when artwork is available.
  const posterEntry = {
    ...entry,
    ...(isEpisode && entry.show_poster_url
      ? { poster_url: entry.show_poster_url, prefer_raw_poster: true }
      : {}),
    ...(isPartWatched && entry.media_key ? { id: entry.media_key } : {}),
  };
  const posterHtml = posterMarkup(posterEntry, "history-page-poster");
  const posterLink = isInteractive
    ? `<a class="history-card-poster-link" href="${escapeAttribute(href)}" ${isUpNext ? `data-media-card-href="${escapeAttribute(href)}"` : `data-part-watched-href="${escapeAttribute(href)}"`} aria-label="${escapeAttribute(posterLabel)}">${posterHtml}</a>`
    : posterHtml;
  const titleHtml = isInteractive
    ? `<a class="history-card-title history-card-title-link" href="${escapeAttribute(href)}" ${isUpNext ? `data-media-card-href="${escapeAttribute(href)}"` : `data-part-watched-href="${escapeAttribute(href)}"`} title="${escapeAttribute(displayTitle)}">${escapeHtml(displayTitle)}</a>`
    : `<b class="history-card-title" title="${escapeAttribute(displayTitle)}">${escapeHtml(displayTitle)}</b>`;
  const menuHtml = isUpNext
    ? posterOverflowMenu(entry, { menuMode: "up-next", showTitle: displayTitle, title: displayTitle, label: displayTitle, mediaType: isEpisode ? "tv" : "movie", kind: isEpisode ? "episode" : "movie", queueKind: entry.queue_kind })
    : (!isPartWatched ? posterOverflowMenu(entry, isEpisode ? { showTitle: displayTitle, label: displayTitle } : {}) : "");
  const cardOpen = isPartWatched
    ? `<article class="history-page-card dashboard-history-page-card dashboard-part-watched-card" data-part-watched-card-id="${escapeAttribute(cardId)}" data-part-watched-media-key="${escapeAttribute(entry.media_key || "")}" data-prefetch-type="${prefetchType}" data-prefetch-tmdb="${escapeAttribute(prefetchTmdb)}" data-prefetch-title="${escapeAttribute(displayTitle || "")}">`
    : isUpNext
      ? `<article class="history-page-card dashboard-history-page-card dashboard-up-next-card" data-up-next-card-id="${escapeAttribute(cardId)}" data-prefetch-type="${prefetchType}" data-prefetch-tmdb="${escapeAttribute(prefetchTmdb)}" data-prefetch-title="${escapeAttribute(displayTitle || "")}">`
      : `<a class="history-page-card dashboard-history-page-card" data-history-id="${escapeAttribute(cardId)}" href="${escapeAttribute(href)}" data-prefetch-type="${prefetchType}" data-prefetch-tmdb="${escapeAttribute(prefetchTmdb)}" data-prefetch-title="${escapeAttribute(displayTitle || "")}">`;
  const cardClose = isInteractive ? "</article>" : "</a>";
  const watchedAt = isPartWatched ? entry.updated_at : entry.watched_at;
  const partProgress = isResume ? partWatchedProgress(entry) : 0;
  const partActions = isPartWatched ? `
        <div class="part-watched-card-actions history-card-actions">
          <button class="button-primary part-watched-action-btn" type="button" data-action-watch="${escapeAttribute(entry.media_key || "")}" data-title="${escapeAttribute(entry.title || displayTitle)}">Watched</button>
          <button class="button-ghost part-watched-action-btn" type="button" data-action-unwatch="${escapeAttribute(entry.media_key || "")}" data-title="${escapeAttribute(entry.title || displayTitle)}">Clear</button>
        </div>
      ` : "";
  const watchNowFooter = isUpNext ? `
        <div class="history-card-footer history-card-footer--watch-now">
          <span class="meta-label">Watch now</span>
          <div class="history-card-apps media-app-links up-next-app-links" data-media-app-links
            data-media-type="${isEpisode ? "episode" : "movie"}"
            data-app-link-style="source-badge"
            data-all-apps="true"
            data-tmdb-id="${escapeAttribute(isEpisode ? (entry.show_tmdb_id || entry.tmdb_id || "") : (entry.tmdb_id || ""))}"
            data-imdb-id="${escapeAttribute(isEpisode ? (entry.show_imdb_id || entry.imdb_id || "") : (entry.imdb_id || ""))}"
            data-tvdb-id="${escapeAttribute(isEpisode ? (entry.show_tvdb_id || entry.tvdb_id || "") : (entry.tvdb_id || ""))}"
            data-season="${escapeAttribute(isEpisode ? (entry.season ?? "") : "")}"
            data-episode="${escapeAttribute(isEpisode ? (entry.episode ?? "") : "")}"
            data-provider-items="${escapeAttribute(JSON.stringify(entry.provider_items || entry.providerItems || {}))}"
            data-title="${escapeAttribute(isEpisode ? (displayTitle || "") : (entry.title || ""))}"></div>
        </div>
      ` : `
        <div class="history-card-footer">
          <span class="meta-label">${sources.length > 1 ? "Apps Used:" : "App Used:"}</span>
          <span class="history-card-apps">${sourceBadge}</span>
        </div>
      `;

  return `
    ${cardOpen}
      <div class="history-card-poster-wrapper">
        ${posterLink}
        ${menuHtml}
      </div>
      <div class="history-card-details">
        <div class="history-card-header">
          ${titleHtml}
          ${isEpisode ? `<span class="history-card-episode" title="${escapeAttribute(epTitle)}">${escapeHtml(epTitle)}</span>` : ""}
        </div>
        <div class="history-card-meta">
          ${isEpisode ? `
            <div class="history-card-meta-row">
              <span class="meta-label">Season/Ep:</span>
              <span class="meta-value">${escapeHtml(episodeCode(entry.season, entry.episode))}</span>
            </div>
          ` : ""}
          ${isUpNext ? `
            <div class="history-card-meta-row">
              <span class="meta-label">Available:</span>
              <span class="meta-value">${escapeHtml(upNextAvailabilityLabel(entry))}</span>
            </div>
          ` : `
            <div class="history-card-meta-row">
              <span class="meta-label">Last Played:</span>
              <span class="meta-value ${isPartWatched ? "part-watched-last-played-value" : ""}">${formatDate(watchedAt)}</span>
            </div>
          `}
          ${!isPartWatched && !isUpNext && actualWatchLabel(entry) ? `
            <div class="history-card-meta-row">
              <span class="meta-value history-card-watch-count">${escapeHtml(actualWatchLabel(entry))}</span>
            </div>
          ` : ""}
        </div>
        ${watchNowFooter}
        ${isResume ? `
          <div class="part-watched-progress-container${isUpNext ? " up-next-progress-container" : ""}">
            ${isUpNext ? `<div class="up-next-progress-row">` : ""}
            <div class="part-watched-progress-bar"><div class="part-watched-progress-fill" style="width: ${partProgress}%;"></div></div>
            ${isUpNext ? `<button class="icon-button up-next-clear-button" type="button" aria-label="Clear progress" title="Clear progress" data-up-next-clear="${escapeAttribute(cardId)}">&times;</button></div>` : ""}
            <span class="part-watched-progress-text">${partProgress}% watched</span>
          </div>
        ` : ""}
        ${partActions}
      </div>
    ${cardClose}
  `;
}

export function renderDashboardUpNextCard(entry) {
  return renderDashboardHistoryPageCard({ ...entry, up_next: true }, { upNext: true });
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
        const safeUrl = safePosterElementUrl(posterUrl);
        if (!safeUrl || !fallback.isConnected || !fallback.classList.contains("poster-fallback")) return;

        const image = document.createElement("img");
        image.className = fallback.className.replace(/\bposter-fallback\b/g, "").trim() || fallback.className;
        bindPosterImageErrorHandler(image);
        image.src = encodeURI(safeUrl);
        image.alt = `${fallback.getAttribute("aria-label") || "Media poster"}`;
        image.loading = "lazy";
        image.decoding = "async";
        image.referrerPolicy = "no-referrer";
        image.dataset.posterId = posterId;
        fallback.replaceWith(image);
      };

      // Each IntersectionObserver batch is just the handful of cards that
      // scrolled into view, not the whole row - no need to serialize them.
      await Promise.allSettled(fallbacks.map(hydrateOne));
    },
    { rootMargin: "200px" },
  );

  const tvRow = elements.tvHistoryRow;
  const movieRow = elements.movieHistoryRow;
  const rows = [
    tvRow,
    movieRow,
    elements.partWatchedTvRow,
    elements.partWatchedMovieRow,
  ].filter(Boolean);
  for (const row of rows) {
    for (const fallback of row.querySelectorAll("[data-poster-id].poster-fallback")) {
      state.dashboardPosterObserver.observe(fallback);
    }
  }
}

function setDashboardHistoryRowMode(row) {
  row?.classList.add("dashboard-history-card-row");
}

const DASHBOARD_CARD_MOTION_MS = 280;
const DASHBOARD_CARD_EXIT_MS = 200;

function dashboardMotionReduced() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function dashboardRowCards(row) {
  if (!row) return [];
  return [...row.children].filter((node) => node.matches?.(
    "[data-history-id], [data-part-watched-card-id], [data-up-next-card-id], .shared-media-card",
  ));
}

function dashboardRowCardKey(node) {
  return String(
    node?.dataset?.historyId
      || node?.dataset?.partWatchedCardId
      || node?.dataset?.upNextCardId
      || node?.dataset?.mediaCardKey
      || "",
  );
}

function clearDashboardMotionStyles(node) {
  node.classList.remove("dashboard-card-motion", "dashboard-card-enter");
  node.style.removeProperty("transition");
  node.style.removeProperty("transform");
}

// Resume progress is the only part of a Part Watched card that normally
// changes while the item remains in the same place. Ignore those values when
// comparing the row's generated markup so the existing card (and hydrated
// poster image) can be patched instead of recreated.
function dashboardRowHtmlWithoutPartWatchedProgress(html = "") {
  return String(html)
    .replace(/(<div class="part-watched-progress-fill" style="width:\s*)[^"]+(;"><\/div>)/g, "$1__part_progress__$2")
    .replace(/(<span class="part-watched-progress-text">)[^<]*(<\/span>)/g, "$1__part_progress_text__$2")
    .replace(/(<span class="meta-value part-watched-last-played-value">)[^<]*(<\/span>)/g, "$1__part_last_played__$2");
}

function patchDashboardPartWatchedProgress(row, nextHtml, visibleItems = []) {
  const previousHtml = row?.dataset?.renderedHtml || "";
  const partWatchedItems = visibleItems.filter((entry) => entry?.isPartWatched || entry?.part_watched);
  if (!previousHtml || !partWatchedItems.length) return false;
  if (dashboardRowHtmlWithoutPartWatchedProgress(previousHtml) !== dashboardRowHtmlWithoutPartWatchedProgress(nextHtml)) {
    return false;
  }

  const existingCards = [...row.querySelectorAll("[data-part-watched-card-id]")];
  const expectedIds = partWatchedItems.map(partWatchedCardIdentity);
  const existingIds = existingCards.map((card) => card.dataset.partWatchedCardId);
  if (existingIds.length !== expectedIds.length || existingIds.some((id, index) => id !== expectedIds[index])) {
    return false;
  }

  const cardsById = new Map(existingCards.map((card) => [card.dataset.partWatchedCardId, card]));
  for (const entry of partWatchedItems) {
    patchPartWatchedCardProgress(cardsById.get(partWatchedCardIdentity(entry)), entry);
  }
  return true;
}

function renderDashboardHistoryRow(row, nextHtml, visibleItems = []) {
  if (!row || row.dataset.renderedHtml === nextHtml) return;
  if (patchDashboardPartWatchedProgress(row, nextHtml, visibleItems)) {
    row.dataset.renderedHtml = nextHtml;
    return;
  }

  row.dataset.renderedHtml = nextHtml;
  updateDashboardRowWithMotion(row, nextHtml, {
    onCommitted: () => {
      bindPartWatchedAppBadges(row);
      hydratePosters(row);
    },
  });
}

// Replace a dashboard row while preserving the visual position of cards that
// remain in the row. The server sends a fresh ordered snapshot, so a small
// FLIP pass gives existing cards a natural slide when a new watch arrives and
// lets newly inserted cards enter without animating width/height or causing a
// layout jump. `exitKeys` is used by Up Next so a watched item gets a short
// fade before the new snapshot takes its place.
export function updateDashboardRowWithMotion(row, html, { exitKeys = [], onCommitted } = {}) {
  if (!row) return;
  const previousCards = dashboardRowCards(row);
  const previousPositions = new Map(previousCards.map((card) => [dashboardRowCardKey(card), card.getBoundingClientRect()]));
  const previousKeys = previousCards.map(dashboardRowCardKey);
  const exitSet = new Set((exitKeys || []).map((key) => String(key)));
  const token = Number(row.dataset.motionToken || 0) + 1;
  row.dataset.motionToken = String(token);

  const commit = () => {
    if (Number(row.dataset.motionToken) !== token) return;
    row.innerHTML = html;
    const nextCards = dashboardRowCards(row);
    const nextKeys = nextCards.map(dashboardRowCardKey);
    const membershipChanged = previousKeys.length !== nextKeys.length
      || previousKeys.some((key, index) => key !== nextKeys[index]);
    const shouldAnimate = previousCards.length > 0 && membershipChanged && !dashboardMotionReduced();

    if (shouldAnimate) {
      const previousKeySet = new Set(previousKeys);
      for (const card of nextCards) {
        const key = dashboardRowCardKey(card);
        if (!previousKeySet.has(key)) {
          card.classList.add("dashboard-card-enter");
          continue;
        }
        const from = previousPositions.get(key);
        if (!from) continue;
        const to = card.getBoundingClientRect();
        const deltaX = from.left - to.left;
        const deltaY = from.top - to.top;
        if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;
        card.classList.add("dashboard-card-motion");
        card.style.transition = "none";
        card.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
        requestAnimationFrame(() => {
          if (!card.isConnected) return;
          card.style.transition = `transform ${DASHBOARD_CARD_MOTION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
          card.style.transform = "";
          window.setTimeout(() => clearDashboardMotionStyles(card), DASHBOARD_CARD_MOTION_MS + 40);
        });
      }
      window.setTimeout(() => {
        for (const card of dashboardRowCards(row)) clearDashboardMotionStyles(card);
      }, DASHBOARD_CARD_MOTION_MS + 80);
    }

    onCommitted?.();
  };

  const exitingCards = previousCards.filter((card) => exitSet.has(dashboardRowCardKey(card)));
  if (exitingCards.length && !dashboardMotionReduced()) {
    exitingCards.forEach((card) => card.classList.add("dashboard-card-exit"));
    window.setTimeout(commit, DASHBOARD_CARD_EXIT_MS);
    return;
  }
  commit();
}

function renderDashboardHistoryRows() {
  const tvHistory = mergeDashboardHistoryEntries(state.history.filter((entry) => entry.media_type === "episode"));
  const movieHistory = dedupeMediaRecords(state.history.filter((entry) => entry.media_type === "movie"), "movies");
  const tvItems = tvHistory;
  const movieItems = movieHistory;

  let visibleTv = [];
  let visibleMovies = [];

  if (elements.tvHistoryRow) {
    if (!tvItems.length) {
      elements.tvHistoryRow.innerHTML = `
        <div class="empty-log">
          <b>${state.history.length ? "No TV history in this preview" : "No watch history yet"}</b>
          <span>${state.history.length ? "New watched episodes will appear here." : "Import a Trakt export or send watched webhooks to start building the archive."}</span>
        </div>
      `;
      delete elements.tvHistoryRow.dataset.renderedHtml;
    } else {
      const tvFitLimit = getRowFitLimit(elements.tvHistoryRow);
      visibleTv = tvItems.slice(0, tvFitLimit);
      const nextTvHtml = visibleTv
        .map((entry, index) => renderDashboardHistoryPageCard({ ...entry, eager_poster: index < 6 }))
        .join("");
      renderDashboardHistoryRow(elements.tvHistoryRow, nextTvHtml, visibleTv);
    }
  }

  if (elements.movieHistoryRow) {
    if (!movieItems.length) {
      elements.movieHistoryRow.innerHTML = `
        <div class="empty-log">
          <b>${state.history.length ? "No movie history in this preview" : "No watch history yet"}</b>
          <span>${state.history.length ? "New watched movies will appear here." : "Import a Trakt export or send watched webhooks to start building the archive."}</span>
        </div>
      `;
      delete elements.movieHistoryRow.dataset.renderedHtml;
    } else {
      const movieFitLimit = getRowFitLimit(elements.movieHistoryRow);
      visibleMovies = movieItems.slice(0, movieFitLimit);
      const nextMovieHtml = visibleMovies
        .map((entry, index) => renderDashboardHistoryPageCard({ ...entry, eager_poster: index < 6 }))
        .join("");
      renderDashboardHistoryRow(elements.movieHistoryRow, nextMovieHtml, visibleMovies);
    }
  }

  if (visibleTv.length || visibleMovies.length) {
    prefetchDashboardHistoryTmdb(visibleTv, visibleMovies);
  }

  observeDashboardPosters();
}

// Reconciles only the dashboard history surfaces after an SSE-triggered
// background fetch. The rest of the dashboard stays untouched, including
// Now Playing, checklist content, scroll positions, and any open controls.
export function refreshDashboardHistoryInPlace() {
  if (partWatchedTargets().length) renderPartWatched({ renderInline: false });
  renderDashboardHistoryRows();
}

export function renderDashboard() {
  renderDashboardChecklist();
  if (partWatchedTargets().length) renderPartWatched({ renderInline: false });
  setDashboardHistoryRowMode(elements.tvHistoryRow);
  setDashboardHistoryRowMode(elements.movieHistoryRow);
  renderDashboardHistoryRows();
}

export function updateDashboardSplitState() {
  if (!elements.timelineView) return;
  const playing = state.activeSessions.length > 0;
  elements.timelineView.dataset.dashState = playing ? "playing" : "idle";
}

function applyPartWatchedPosterWidth() {
  document.documentElement.style.setProperty("--part-watched-poster-width", "128px");
}

export function resetPartWatchedView(key = "", { preserveItems = false } = {}) {
  // A dashboard live refresh can reset this view while its previous request is
  // still pending. Abort and invalidate that request before clearing loading;
  // otherwise its late finally block can own the new generation and leave the
  // panel stuck on "Loading partly watched items…" indefinitely. Automatic
  // refreshes pass preserveItems so the last successful snapshot remains
  // visible until the replacement snapshot is ready.
  state.partWatchedRequestVersion += 1;
  state.partWatchedAbortController?.abort();
  state.partWatchedAbortController = null;
  if (!preserveItems) state.partWatchedRaw = [];
  state.partWatchedOffset = 0;
  state.partWatchedHasMore = true;
  state.partWatchedLoading = false;
  state.partWatchedQueryKey = key;
  state.partWatchedScrollArmed = false;
}

function partWatchedCardIdentity(entry = {}) {
  return String(entry.media_key || progressRecordIdentity(entry));
}

export function renderPartWatchedCard(entry) {
  return renderDashboardHistoryPageCard({
    ...entry,
    isPartWatched: true,
  }, { partWatched: true });
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
      ${platformIconMarkup(source)}
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

// Patches only the parts of an already-rendered part-watched card that resume
// progress actually changes (the progress bar and the last-played time),
// leaving its poster/title/badges DOM nodes completely untouched. The SSE
// live-update stream only reports "something changed" (a shared history
// version bump), not which item - and on the dashboard the overwhelmingly
// common cause while something is playing is this same row's own resume
// position ticking forward, not a new item starting or its poster changing.
// Rebuilding the row's whole innerHTML for that recreated every poster
// <img> in it, which is what looked like posters "refreshing" during
// playback (see KNOWN_ISSUES.md).
function patchPartWatchedCardProgress(node, entry) {
  if (!node) return;
  const progressPercent = partWatchedProgress(entry);
  const fill = node.querySelector(".part-watched-progress-fill");
  if (fill) fill.style.width = `${progressPercent}%`;
  const text = node.querySelector(".part-watched-progress-text");
  if (text) text.textContent = `${progressPercent}% watched`;
  const lastPlayed = node.querySelector(".part-watched-last-played-value");
  if (lastPlayed) lastPlayed.textContent = entry.updated_at ? formatDate(entry.updated_at) : "";
}

function partWatchedTargets() {
  if (elements.partWatchedTvRow || elements.partWatchedMovieRow) {
    return [
      { type: "episode", row: elements.partWatchedTvRow, section: elements.partWatchedTvSection },
      { type: "movie", row: elements.partWatchedMovieRow, section: elements.partWatchedMovieSection },
    ].filter((target) => target.row);
  }
  return elements.partWatchedPanel
    ? [{ type: "all", row: elements.partWatchedPanel, section: elements.partWatchedSection }]
    : [];
}

function enrichPartWatchedEntry(entry = {}) {
  if (entry.media_type !== "episode") return { ...entry };
  const matchingHistory = state.history.find((historyEntry) => (
    (entry.media_key && historyEntry.media_key === entry.media_key)
    || (entry.tmdb_id && historyEntry.tmdb_id === entry.tmdb_id && historyEntry.season === entry.season && historyEntry.episode === entry.episode)
    || (entry.tvdb_id && historyEntry.tvdb_id === entry.tvdb_id && historyEntry.season === entry.season && historyEntry.episode === entry.episode)
  ));
  if (!matchingHistory) return { ...entry };
  return {
    ...matchingHistory,
    ...entry,
    show_title: entry.show_title || matchingHistory.show_title || showTitleFrom(matchingHistory.title),
    poster_url: entry.poster_url || matchingHistory.poster_url,
    show_tmdb_id: entry.show_tmdb_id || matchingHistory.show_tmdb_id,
    show_tvdb_id: entry.show_tvdb_id || matchingHistory.show_tvdb_id,
  };
}

function renderPartWatchedBucket(target, items) {
  if (!target.row) return;
  if (!items.length) {
    target.section?.classList.add("hidden");
    target.row.innerHTML = "";
    delete target.row.dataset.renderedHtml;
    return;
  }

  target.section?.classList.remove("hidden");
  const visibleItems = items.slice(0, PART_WATCHED_DASHBOARD_LIMIT);
  const currentIds = visibleItems.map(partWatchedCardIdentity);
  const existingCards = [...target.row.querySelectorAll("[data-part-watched-card-id]")];
  const existingIds = existingCards.map((el) => el.dataset.partWatchedCardId);
  const sameMembership = existingIds.length === currentIds.length && existingIds.every((id, index) => id === currentIds[index]);

  if (!sameMembership) {
    const nextHtml = visibleItems.map((entry, index) => renderPartWatchedCard({
      ...entry,
      eager_poster: index < 6,
      prefer_raw_poster: true,
    })).join("");
    target.row.innerHTML = nextHtml;
    bindPartWatchedAppBadges(target.row);
    hydratePosters(target.row);
    _cb.observeExplorerTmdbPrefetch?.(target.row);
  } else {
    const nodesById = new Map(existingCards.map((el) => [el.dataset.partWatchedCardId, el]));
    for (const entry of visibleItems) patchPartWatchedCardProgress(nodesById.get(partWatchedCardIdentity(entry)), entry);
  }
}

export function renderPartWatched({ renderInline = true } = {}) {
  const targets = partWatchedTargets();
  const inline = !targets.length && Boolean(elements.tvHistoryRow || elements.movieHistoryRow);
  if (!targets.length && !inline) return;
  const key = "default";
  if (state.partWatchedQueryKey !== key) resetPartWatchedView(key);

  if (!state.partWatchedRaw.length && state.partWatchedHasMore && !state.partWatchedLoading && state.token) {
    loadPartWatched().catch((error) => _cb.setMessage?.(error.message, "error"));
  }

  applyPartWatchedPosterWidth();

  if (inline) {
    // The dashboard renderer owns the TV/movie rows in the current shell. A
    // caller such as the Clear Progress action can request an immediate
    // redraw after resetting the progress cache; the fetch completion then
    // redraws the row again with the new first card in place.
    if (renderInline) renderDashboard();
    return;
  }

  const wrapper = elements.partWatchedRows;
  if (!state.partWatchedRaw.length) {
    if (state.partWatchedLoading) {
      // A first load has no cards to preserve, so show a placeholder. Live
      // refreshes keep their last successful snapshot in partWatchedRaw and
      // therefore leave the existing cards painted while this request runs.
      const firstTarget = targets[0];
      const hasCards = targets.some((target) => target.row.querySelectorAll("[data-part-watched-card-id]").length);
      if (!hasCards && firstTarget.row) {
        wrapper?.classList.remove("hidden");
        firstTarget.section?.classList.remove("hidden");
        firstTarget.row.innerHTML = `<div class="empty-log"><b>Loading partly watched items…</b></div>`;
      }
    } else {
      wrapper?.classList.add("hidden");
      for (const target of targets) {
        target.section?.classList.add("hidden");
        target.row.innerHTML = "";
        delete target.row.dataset.renderedHtml;
      }
      // Legacy test and embedding fallback: the old section is the wrapper.
      if (!wrapper) elements.partWatchedSection?.classList.add("hidden");
    }
    updateDashboardSplitState();
    return;
  }

  wrapper?.classList.remove("hidden");
  const items = state.partWatchedRaw.map(enrichPartWatchedEntry);
  for (const target of targets) {
    const bucket = target.type === "all"
      ? items
      : items.filter((entry) => target.type === "episode" ? entry.media_type === "episode" : entry.media_type === "movie");
    renderPartWatchedBucket(target, bucket);
  }
  if (!wrapper) elements.partWatchedSection?.classList.remove("hidden");
  updateDashboardSplitState();
}

export async function loadPartWatched({ silent = false } = {}) {
  if (state.partWatchedLoading || !state.partWatchedHasMore) return;
  const requestVersion = state.partWatchedRequestVersion + 1;
  state.partWatchedRequestVersion = requestVersion;
  const controller = new AbortController();
  state.partWatchedAbortController = controller;
  state.partWatchedLoading = true;
  const timeout = setTimeout(() => controller.abort(), PART_WATCHED_REQUEST_TIMEOUT_MS);

  try {
    const url = new URL("/api/playback-progress", window.location.origin);
    url.searchParams.set("limit", String(EXPLORER_PAGE_SIZE));
    url.searchParams.set("offset", String(state.partWatchedOffset));

    const res = await fetch(url, { headers: authHeaders(), cache: "no-store", signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Progress load failed ${res.status}`);
    if (requestVersion !== state.partWatchedRequestVersion) return;

    const items = Array.isArray(body.progress) ? body.progress : [];
    // A reset starts a new first page. When that reset preserved the previous
    // snapshot for a live refresh, the response is authoritative and must
    // replace it rather than merge removed rows back into the list.
    const pageOffset = state.partWatchedOffset;
    state.partWatchedRaw = dedupePlaybackProgress(pageOffset === 0 ? items : [...state.partWatchedRaw, ...items]);
    state.partWatchedOffset = pageOffset + items.length;
    state.partWatchedHasMore = false;
  } catch (error) {
    // A reset intentionally aborts the old generation; it must not change or
    // render the replacement request's state.
    if (requestVersion !== state.partWatchedRequestVersion) return;
    state.partWatchedHasMore = false;
    if (error?.name === "AbortError") throw new Error("Part Watched request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
    if (requestVersion === state.partWatchedRequestVersion) {
      state.partWatchedAbortController = null;
      state.partWatchedLoading = false;
      if (!silent) {
        if (!partWatchedTargets().length && (elements.tvHistoryRow || elements.movieHistoryRow)) {
          renderDashboard();
        } else {
          renderPartWatched();
        }
      }
    }
  }
}
