import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, formatDate, slug, movieHref, movieTmdbHref, tvShowTmdbHref, tvShowTvdbHref, showTitleFrom } from "./utils.js";
import { syncHistoryTone, syncHistoryActionLabel } from "./sync.js";

const REFRESH_MS = 15000;
const ACTIVITY_LIMIT = 200;

let refreshTimer = null;

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
  plembfin: { name: "Plembfin", icon: "/icons/plembfin.png" },
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
  if (!platform.icon) return "";
  return `<img class="${className}" src="${escapeAttribute(platform.icon)}" alt="${escapeAttribute(platform.name)}" loading="lazy" />`;
}

function targetResults(entry = {}) {
  const targets = Array.isArray(entry.targetStates) ? entry.targetStates : [];
  if (!targets.length) return `<span class="sync-activity-target" data-status="pending">No target detail</span>`;
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
  const knownShow = (state.showsRaw || []).find((show) => slug(show.title) === slug(showTitle));
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

export function renderSyncActivity() {
  renderSyncActivityStatus();
  if (!elements.syncActivityRows) return;

  if (state.syncActivityLoading && !state.syncActivity.length) {
    elements.syncActivityRows.innerHTML = `<div class="empty-log"><b>Loading sync activity</b><span>Fetching what has been synced recently.</span></div>`;
    if (elements.syncActivitySummary) {
      elements.syncActivitySummary.textContent = "Loading";
      elements.syncActivitySummary.className = "status-pill status-muted";
    }
    return;
  }

  const rows = [...state.syncActivity].sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  const failed = rows.filter((entry) => syncHistoryTone(entry) === "error").length;

  if (elements.syncActivitySummary) {
    elements.syncActivitySummary.textContent = rows.length
      ? `${rows.length} item${rows.length === 1 ? "" : "s"} / ${failed} failed`
      : "No activity";
    elements.syncActivitySummary.className = `status-pill ${failed ? "status-error" : rows.length ? "status-ready" : "status-muted"}`;
  }

  if (!rows.length) {
    elements.syncActivityRows.innerHTML = `<div class="empty-log"><b>Nothing synced yet</b><span>Watches propagated to your media servers and trackers appear here, newest first.</span></div>`;
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
}

export async function loadSyncActivity({ force = false } = {}) {
  if (!state.token || (state.syncActivityLoading && !force)) return state.syncActivity;
  state.syncActivityLoading = true;
  renderSyncActivity();
  try {
    const url = new URL("/api/sync-history", window.location.origin);
    url.searchParams.set("limit", String(ACTIVITY_LIMIT));
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Sync activity load failed with ${response.status}`);
    state.syncActivity = Array.isArray(body.history) ? body.history : [];
    state.syncActivityLoaded = true;
    return state.syncActivity;
  } finally {
    state.syncActivityLoading = false;
    renderSyncActivity();
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
