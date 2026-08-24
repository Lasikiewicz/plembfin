import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, formatDate, slug, movieHref, movieTmdbHref, tvShowTmdbHref, tvShowTvdbHref, showTitleFrom, platformIconMarkup } from "./utils.js?v=20260824f";
import { syncHistoryTone, syncHistoryActionLabel } from "./sync.js";

const REFRESH_MS = 15000;
const SEARCH_DEBOUNCE_MS = 180;
const ACTIVITY_PAGE_SIZE = 25;
const DEFAULT_PAGINATION = {
  page: 1,
  limit: ACTIVITY_PAGE_SIZE,
  total: 0,
  totalPages: 1,
  from: 0,
  to: 0,
  hasPrevious: false,
  hasNext: false,
};

let refreshTimer = null;
let searchTimer = null;
let loadRequestToken = 0;

function authHeaders() {
  return buildAuthHeaders(state.token);
}

function statusText() {
  const total = Number(state.syncActivityProgress?.total) || 0;
  const completed = Number(state.syncActivityProgress?.completed) || 0;
  return total > 0 && completed < total ? `Sync - ${completed} of ${total}` : "Sync - Idle";
}

function isActive() {
  const total = Number(state.syncActivityProgress?.total) || 0;
  const completed = Number(state.syncActivityProgress?.completed) || 0;
  return total > 0 && completed < total;
}

// The shared `normalizePlatformSource` helper only knows about the three media
// servers and folds everything else into Plex, which would label a Trakt
// dispatch as Plex here. Sync activity names trackers as well as servers, so it
// resolves platforms itself.
const PLATFORMS = {
  plex: { name: "Plex", icon: "/icons/plex.svg" },
  emby: { name: "Emby", icon: "/icons/emby.svg" },
  jellyfin: { name: "Jellyfin", icon: "/icons/jellyfin.svg" },
  trakt: { name: "Trakt", icon: "/icons/trakt.svg" },
  plembfin: { name: "Plembfin", icon: "" },
};

export function activityPlatform(value) {
  const key = String(value || "").trim().toLowerCase();
  if (key.includes("trakt")) return { key: "trakt", ...PLATFORMS.trakt };
  if (key.startsWith("emby")) return { key: "emby", ...PLATFORMS.emby };
  if (key.startsWith("jellyfin")) return { key: "jellyfin", ...PLATFORMS.jellyfin };
  if (key.startsWith("plex")) return { key: "plex", ...PLATFORMS.plex };
  if (key.startsWith("manual") || key.startsWith("force_sync") || key.startsWith("plembfin")) {
    return { key: "plembfin", ...PLATFORMS.plembfin };
  }
  return { key: "unknown", name: key ? key.charAt(0).toUpperCase() + key.slice(1) : "Unknown", icon: "" };
}

function platformIcon(platform, className = "sync-activity-icon") {
  if (platform.key === "plembfin") return platformIconMarkup("plembfin", className, "sync-activity-icon-set");
  if (!platform.icon) return "";
  return `<img class="${className}" src="${escapeAttribute(platform.icon)}" alt="${escapeAttribute(platform.name)}" loading="lazy" />`;
}

function targetResults(entry = {}) {
  const targets = Array.isArray(entry.targetStates) ? entry.targetStates : [];
  if (!targets.length) {
    const noTargets = String(entry.status || "").toLowerCase() === "skipped" || /no enabled sync destinations/i.test(entry.details || "");
    return `<span class="sync-activity-target" data-status="pending">${noTargets ? "No enabled targets" : "No target detail"}</span>`;
  }
  return targets
    .map((target) => {
      const status = String(target.status || "unknown").toLowerCase();
      const tone = status === "success" ? "success" : status === "error" ? "error" : "pending";
      const platform = activityPlatform(target.target);
      const detail = target.detail ? ` - ${target.detail}` : "";
      const label = `${platform.name} ${status}${detail}`;
      return `<span class="sync-activity-target" data-status="${tone}" title="${escapeAttribute(label)}">${platformIcon(platform)}<span>${escapeHtml(status)}</span></span>`;
    })
    .join("");
}

function routeTargetNames(entry = {}) {
  const targets = Array.isArray(entry.targetStates) ? entry.targetStates : [];
  const names = [];
  for (const target of targets) {
    const name = activityPlatform(target.target).name;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// Where the title links to. A record that matches something already in the
// library resolves to its local page; otherwise the provider ids the dispatch
// carried address it directly, and a record with neither falls back to a search
// rather than a route that would resolve to nothing.
export function mediaHrefFor(entry = {}) {
  const isMovie = String(entry.mediaType || "").toLowerCase() === "movie";
  const ids = entry.rawPayloadDebug?.ids || {};
  const tmdbId = ids.tmdb ? String(ids.tmdb) : "";
  const tvdbId = ids.tvdb ? String(ids.tvdb) : "";
  const rawTitle = entry.title || "";

  if (isMovie) {
    const known = (state.history || []).find(
      (record) => String(record.media_type || record.type || "").toLowerCase() === "movie" && slug(record.title) === slug(rawTitle),
    ) || (state.moviesRaw || []).find((movie) => slug(movie.title) === slug(rawTitle));
    if (known) return movieHref(known);
    if (tmdbId) return movieTmdbHref(tmdbId, rawTitle);
    return `/search?q=${encodeURIComponent(rawTitle)}`;
  }

  const showTitle = showTitleFrom(rawTitle);
  const knownShow = (state.showsRaw || []).find((show) => (
    (tmdbId && String(show.tmdb_id || "") === tmdbId)
    || (tvdbId && String(show.tvdb_id || "") === tvdbId)
  )) || ((!tmdbId && !tvdbId) ? (state.showsRaw || []).find((show) => slug(show.title) === slug(showTitle)) : null);
  if (knownShow?.tmdb_id) return tvShowTmdbHref(knownShow.tmdb_id, knownShow.title);
  if (knownShow?.tvdb_id) return tvShowTvdbHref(knownShow.tvdb_id, knownShow.title);
  if (knownShow) return `/tvshow/${slug(knownShow.title)}`;
  if (tmdbId) return tvShowTmdbHref(tmdbId, showTitle);
  if (tvdbId) return tvShowTvdbHref(tvdbId, showTitle);
  return `/search?q=${encodeURIComponent(showTitle)}`;
}

// "Where the request came from and where it went": the source is the app that
// reported the play, the targets are the apps Plembfin dispatched it to.
function routeLine(entry = {}) {
  const source = activityPlatform(entry.source).name;
  const targets = routeTargetNames(entry);
  const to = targets.length ? targets.map((name) => escapeHtml(name)).join(", ") : "No targets recorded";
  return `
    <div class="sync-activity-row-route">
      <span class="sync-activity-route-leg"><span>From</span><b>${escapeHtml(source)}</b></span>
      <span class="sync-activity-route-arrow" aria-hidden="true">-&gt;</span>
      <span class="sync-activity-route-leg"><span>To</span><b>${to}</b></span>
    </div>
  `;
}

function activityRow(entry = {}) {
  const tone = syncHistoryTone(entry);
  const mediaType = String(entry.mediaType || "").toLowerCase() === "movie" ? "Movie" : "TV";
  const source = activityPlatform(entry.source);
  const statusLabel = entry.status || "unknown";
  const statusClass = tone === "error" ? "status-error" : tone === "pending" ? "status-warning" : "status-ready";
  const id = entry.id != null ? String(entry.id) : "";
  const title = entry.title || "Unknown media";
  return `
    <article class="sync-activity-row" data-tone="${tone}" data-activity-id="${escapeAttribute(id)}" aria-expanded="false" title="Show this item's log">
      <span class="sync-status-dot sync-status-dot--${tone}" aria-hidden="true"></span>
      <div class="sync-activity-row-main">
        <button class="sync-activity-row-title" type="button" data-media-href="${escapeAttribute(mediaHrefFor(entry))}" title="Open ${escapeAttribute(title)}">${escapeHtml(title)}</button>
        <div class="sync-activity-row-meta">
          <span class="sync-activity-type">${escapeHtml(mediaType)}</span>
          <span class="sync-activity-source">${platformIcon(source)}<span>${escapeHtml(source.name)}</span></span>
          <span>${escapeHtml(syncHistoryActionLabel(entry))}</span>
          <span>${escapeHtml(formatDate(entry.timestamp))}</span>
        </div>
        ${routeLine(entry)}
        ${entry.details ? `<div class="sync-activity-row-detail">${escapeHtml(entry.details)}</div>` : ""}
      </div>
      <div class="sync-activity-row-results">
        ${targetResults(entry)}
        <button class="button-ghost sync-activity-download" type="button" data-sync-activity-download="${escapeAttribute(id)}" title="Download this item's sync log">Download log</button>
      </div>
      <span class="status-pill ${statusClass} sync-activity-row-status">${escapeHtml(statusLabel)}</span>
      <pre class="sync-activity-log hidden"></pre>
    </article>
  `;
}

function logTimestamp(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return "Unknown";
  return `${formatDate(time)} (${new Date(time).toISOString()})`;
}

// One media item's sync record as plain text: what was synced, where the
// request came from, where it was dispatched to, and what each target replied.
export function buildSyncActivityLog(entry = {}) {
  const targets = Array.isArray(entry.targetStates) ? entry.targetStates : [];
  const lines = [
    "Plembfin sync log",
    `Exported: ${new Date().toISOString()}`,
    "",
    `Title: ${entry.title || "Unknown media"}`,
    `Media type: ${entry.mediaType || "unknown"}`,
    `Action: ${syncHistoryActionLabel(entry)}`,
    `Status: ${entry.status || "unknown"}`,
    `Logged at: ${logTimestamp(entry.timestamp)}`,
    `Record id: ${entry.id != null ? entry.id : "unknown"}`,
    "",
    `Request came from: ${activityPlatform(entry.source).name}`,
    `Dispatched to: ${routeTargetNames(entry).join(", ") || "No targets recorded"}`,
    "",
    `Details: ${entry.details || "No details"}`,
    "",
    "Target results:",
  ];

  if (!targets.length) {
    lines.push("  No target detail recorded.");
  } else {
    for (const target of targets) {
      const detail = target.detail ? ` - ${target.detail}` : "";
      lines.push(`  ${activityPlatform(target.target).name}: ${String(target.status || "unknown").toLowerCase()}${detail}`);
    }
  }

  const debug = entry.rawPayloadDebug && Object.keys(entry.rawPayloadDebug).length ? entry.rawPayloadDebug : null;
  if (debug) {
    lines.push("", "Raw payload debug:", JSON.stringify(debug, null, 2));
  }

  return `${lines.join("\n")}\n`;
}

function syncActivityLogFilename(entry = {}) {
  const safeTitle = String(entry.title || "media")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "media";
  const stamp = Number(entry.timestamp) > 0 ? new Date(Number(entry.timestamp)).toISOString().replace(/[:.]/g, "-") : "unknown-time";
  return `${safeTitle}-sync-${stamp}.log`;
}

export function downloadSyncActivityLog(id) {
  const entry = state.syncActivity.find((item) => String(item.id) === String(id));
  if (!entry) return false;
  const blob = new Blob([buildSyncActivityLog(entry)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = syncActivityLogFilename(entry);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

// Clicking anywhere on a row that is not the title or the download button
// expands it to show the same log text the download would produce.
export function toggleSyncActivityRowLog(row) {
  if (!row) return false;
  const log = row.querySelector(".sync-activity-log");
  if (!log) return false;
  const expanded = row.getAttribute("aria-expanded") === "true";
  if (expanded) {
    log.classList.add("hidden");
    row.setAttribute("aria-expanded", "false");
    return true;
  }
  const entry = state.syncActivity.find((item) => String(item.id) === String(row.dataset.activityId));
  log.textContent = entry ? buildSyncActivityLog(entry) : "This sync log is no longer available - refresh the page.";
  log.classList.remove("hidden");
  row.setAttribute("aria-expanded", "true");
  return true;
}

export function renderSyncActivityStatus() {
  const text = statusText();
  const stateName = isActive() ? "active" : "idle";
  if (elements.syncProgressIndicator && elements.syncProgressText) {
    elements.syncProgressText.textContent = text;
    elements.syncProgressIndicator.dataset.syncState = stateName;
  }
  if (elements.syncActivityStatus && elements.syncActivityStatusText) {
    elements.syncActivityStatusText.textContent = text;
    elements.syncActivityStatus.dataset.syncState = stateName;
  }
}

export function setSyncActivityProgress({ total = 0, completed = 0 } = {}) {
  state.syncActivityProgress = { total, completed };
  renderSyncActivityStatus();
}

function renderSyncActivityPagination() {
  const container = elements.syncActivityPagination;
  if (!container) return;
  const pagination = { ...DEFAULT_PAGINATION, ...(state.syncActivityPagination || {}) };
  const total = Math.max(Number(pagination.total) || 0, 0);
  const totalPages = Math.max(Number(pagination.totalPages) || 1, 1);
  const page = Math.min(Math.max(Number(pagination.page) || 1, 1), totalPages);
  const from = total ? Math.max(Number(pagination.from) || ((page - 1) * pagination.limit + 1), 1) : 0;
  const to = total ? Math.max(Number(pagination.to) || Math.min(page * pagination.limit, total), from) : 0;

  container.classList.toggle("hidden", totalPages <= 1 || !total);
  if (elements.syncActivityPageRange) {
    elements.syncActivityPageRange.textContent = total ? `Showing ${from}-${to} of ${total}` : "Showing 0-0 of 0";
  }
  if (elements.syncActivityPageLabel) {
    elements.syncActivityPageLabel.textContent = `Page ${page} of ${totalPages}`;
  }
  if (elements.syncActivityPageNumbers) {
    elements.syncActivityPageNumbers.innerHTML = paginationItems(page, totalPages).map((item) => {
      if (item === "ellipsis") return `<span class="sync-activity-page-ellipsis" aria-hidden="true">&hellip;</span>`;
      const current = item === page;
      return `<button class="button-ghost sync-activity-page-number ${current ? "is-current" : ""}" type="button" data-sync-activity-page="${item}" ${current ? 'aria-current="page" disabled' : `aria-label="Go to page ${item}"`}>${item}</button>`;
    }).join("");
  }
  if (elements.syncActivityPrevious) {
    elements.syncActivityPrevious.disabled = Boolean(state.syncActivityLoading) || !pagination.hasPrevious;
  }
  if (elements.syncActivityNext) {
    elements.syncActivityNext.disabled = Boolean(state.syncActivityLoading) || !pagination.hasNext;
  }
}

export function paginationItems(page, totalPages, maxVisible = 5) {
  const total = Math.max(Math.floor(Number(totalPages) || 1), 1);
  const current = Math.min(Math.max(Math.floor(Number(page) || 1), 1), total);
  const visible = Math.max(Math.floor(Number(maxVisible) || 5), 3);
  if (total <= visible) return Array.from({ length: total }, (_, index) => index + 1);

  const innerSlots = visible - 2;
  let start = Math.max(2, current - Math.floor(innerSlots / 2));
  let end = Math.min(total - 1, start + innerSlots - 1);
  start = Math.max(2, end - innerSlots + 1);
  const items = [1];
  if (start > 2) items.push("ellipsis");
  for (let number = start; number <= end; number += 1) items.push(number);
  if (end < total - 1) items.push("ellipsis");
  items.push(total);
  return items;
}

function syncActivityMatchesSearch(entry, query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return true;
  return [
    entry.mediaType,
    entry.title,
    entry.source,
    activityPlatform(entry.source).name,
    entry.status,
    entry.details,
    entry.action,
    syncHistoryActionLabel(entry),
    JSON.stringify(entry.targetStates || []),
    JSON.stringify(entry.rawPayloadDebug || {}),
  ].join(" ").toLowerCase().includes(normalized);
}

export function setSyncActivitySearch(value) {
  state.syncActivitySearch = String(value || "").slice(0, 120);
  state.syncActivityPagination = { ...DEFAULT_PAGINATION, ...(state.syncActivityPagination || {}), page: 1 };
  renderSyncActivity();
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    searchTimer = null;
    loadSyncActivity({ force: true, page: 1 }).catch(() => null);
  }, SEARCH_DEBOUNCE_MS);
}

export function renderSyncActivity() {
  renderSyncActivityStatus();
  if (!elements.syncActivityRows) return;
  renderSyncActivityPagination();

  if (state.syncActivityLoading && !state.syncActivity.length) {
    elements.syncActivityRows.innerHTML = `<div class="empty-log"><b>Loading sync activity</b><span>Fetching what has been synced recently.</span></div>`;
    if (elements.syncActivitySummary) {
      elements.syncActivitySummary.textContent = "Loading";
      elements.syncActivitySummary.className = "status-pill status-muted";
    }
    renderSyncActivityPagination();
    return;
  }

  const query = state.syncActivitySearch || "";
  const rows = [...state.syncActivity]
    .filter((entry) => syncActivityMatchesSearch(entry, query))
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  const failed = rows.filter((entry) => syncHistoryTone(entry) === "error").length;
  const pagination = { ...DEFAULT_PAGINATION, ...(state.syncActivityPagination || {}) };
  const total = Math.max(Number(pagination.total) || 0, rows.length);
  const from = total ? Math.max(Number(pagination.from) || 1, 1) : 0;
  const to = total ? Math.max(Number(pagination.to) || rows.length, from) : 0;

  if (elements.syncActivitySummary) {
    elements.syncActivitySummary.textContent = rows.length
      ? `Showing ${from}-${to} of ${total} / ${failed} failed on page`
      : query ? "No matches" : "No activity";
    elements.syncActivitySummary.className = `status-pill ${failed ? "status-error" : rows.length ? "status-ready" : "status-muted"}`;
  }

  if (!rows.length) {
    elements.syncActivityRows.innerHTML = query
      ? `<div class="empty-log"><b>No matching sync activity</b><span>Try another title, platform, action, or status.</span></div>`
      : `<div class="empty-log"><b>Nothing synced yet</b><span>Watches propagated to your media servers and trackers appear here, newest first.</span></div>`;
    renderSyncActivityPagination();
    return;
  }

  // A background refresh replaces the markup, so rows the reader has opened are
  // reopened afterwards rather than snapping shut under them.
  const expandedIds = new Set(
    [...elements.syncActivityRows.querySelectorAll('.sync-activity-row[aria-expanded="true"]')].map((row) => row.dataset.activityId),
  );
  elements.syncActivityRows.innerHTML = rows.map(activityRow).join("");
  for (const id of expandedIds) {
    const row = elements.syncActivityRows.querySelector(`.sync-activity-row[data-activity-id="${CSS.escape(id)}"]`);
    if (row) toggleSyncActivityRowLog(row);
  }
  renderSyncActivityPagination();
}

export async function loadSyncActivity({ force = false, page } = {}) {
  if (!state.token || (state.syncActivityLoading && !force)) return state.syncActivity;
  const currentPage = Number(state.syncActivityPagination?.page) || 1;
  const requestedPage = page == null ? currentPage : Math.max(Math.floor(Number(page) || 1), 1);
  const previousPagination = { ...DEFAULT_PAGINATION, ...(state.syncActivityPagination || {}) };
  const requestToken = ++loadRequestToken;
  const requestedSearch = state.syncActivitySearch || "";
  state.syncActivityPagination = { ...DEFAULT_PAGINATION, ...(state.syncActivityPagination || {}), page: requestedPage };
  state.syncActivityLoading = true;
  renderSyncActivity();
  try {
    const url = new URL("/api/sync-history", window.location.origin);
    url.searchParams.set("limit", String(ACTIVITY_PAGE_SIZE));
    url.searchParams.set("page", String(requestedPage));
    if (requestedSearch.trim()) url.searchParams.set("search", requestedSearch.trim());
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Sync activity load failed with ${response.status}`);
    if (requestToken !== loadRequestToken || requestedSearch !== state.syncActivitySearch) return state.syncActivity;
    state.syncActivity = Array.isArray(body.history) ? body.history : [];
    const rawPagination = body.pagination && typeof body.pagination === "object" ? body.pagination : {};
    const limit = Math.min(Math.max(Number(rawPagination.limit) || ACTIVITY_PAGE_SIZE, 1), 200);
    const total = Math.max(Number(rawPagination.total) || state.syncActivity.length, 0);
    const totalPages = Math.max(Number(rawPagination.totalPages) || Math.ceil(total / limit) || 1, 1);
    const resolvedPage = Math.min(Math.max(Number(rawPagination.page) || requestedPage, 1), totalPages);
    state.syncActivityPagination = {
      ...DEFAULT_PAGINATION,
      ...rawPagination,
      page: resolvedPage,
      limit,
      total,
      totalPages,
      from: Number(rawPagination.from) || (total ? ((resolvedPage - 1) * limit + 1) : 0),
      to: Number(rawPagination.to) || (total ? Math.min(resolvedPage * limit, total) : 0),
      hasPrevious: rawPagination.hasPrevious === true || resolvedPage > 1,
      hasNext: rawPagination.hasNext === true || resolvedPage < totalPages,
    };
    state.syncActivityLoaded = true;
    return state.syncActivity;
  } catch (error) {
    if (requestToken !== loadRequestToken) return state.syncActivity;
    state.syncActivityPagination = previousPagination;
    throw error;
  } finally {
    if (requestToken === loadRequestToken) {
      state.syncActivityLoading = false;
      renderSyncActivity();
    }
  }
}

// The page keeps itself current while it is the visible view: a sync that is
// running writes new rows continuously, and the live-update stream only carries
// the running counter, not the per-item results.
export function startSyncActivityRefresh() {
  stopSyncActivityRefresh();
  refreshTimer = window.setInterval(() => {
    if (state.activeView !== "syncActivity") return;
    loadSyncActivity({ force: true }).catch(() => null);
  }, REFRESH_MS);
}

export function stopSyncActivityRefresh() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = null;
}
