import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, formatDate, slug, movieHref, movieTmdbHref, tvShowTmdbHref, tvShowTvdbHref, showTitleFrom, platformIconMarkup } from "./utils.js?v=20260824h";
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
let attentionRequestToken = 0;
const retryingActivityIds = new Set();
// "Retry all failed" runs one item at a time rather than in parallel, so it
// doesn't fire a burst of simultaneous requests at Plex/Emby/Jellyfin/Trakt -
// this tracks progress through that queue for the header button's label.
let bulkRetryProgress = null;
// Retry feedback is shown inline on the row it came from, not as a toast -
// keyed by activity id (not stored on the entry objects themselves) because
// state.syncActivity is replaced wholesale on every periodic refresh, which
// would otherwise wipe out feedback the moment the list reloads.
const activityFeedback = new Map();
// A durable record of what happened when a row's retry was attempted, folded
// into that row's own log text (buildSyncActivityLog) so it survives closing
// and reopening the row, and shows up in a downloaded log too.
const activityNotes = new Map();
// The page stores only one row per media group. Event pages are fetched when
// a group is opened, so a large audit trail does not become a large browser
// payload. The cache also lets a refresh reopen the group without losing the
// reader's place.
const groupEventCache = new Map();
const groupEventLoading = new Set();

function setActivityFeedback(id, feedback) {
  const key = String(id || "");
  if (!key) return;
  if (feedback) activityFeedback.set(key, feedback);
  else activityFeedback.delete(key);
}

function appendActivityNote(id, text) {
  const key = String(id || "");
  if (!key || !text) return;
  const list = activityNotes.get(key) || [];
  list.push({ timestamp: Date.now(), text });
  // Caps memory for a row that gets retried many times in one session - the
  // log only needs recent context, not an unbounded history.
  activityNotes.set(key, list.slice(-10));
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

function normalizeAttentionTone(value, fallback = "warning") {
  const normalized = String(value || "").trim().toLowerCase();
  if (["error", "critical", "blocking", "red", "failed", "attention"].includes(normalized)) return "error";
  if (["warning", "warn", "degraded", "amber"].includes(normalized)) return "warning";
  return fallback;
}

function attentionToneForItem(item = {}) {
  return normalizeAttentionTone(item.severity || item.tone, "warning");
}

function serverAttentionItems() {
  return Array.isArray(state.syncAttention) ? state.syncAttention : [];
}

function clientAttentionItems() {
  return Array.isArray(state.clientAttention) ? state.clientAttention : [];
}

function attentionItems() {
  return [...serverAttentionItems(), ...clientAttentionItems()];
}

function serverAttentionCount() {
  const count = Number(state.syncAttentionCount);
  return Number.isFinite(count) && count > 0 ? count : serverAttentionItems().length;
}

function attentionCount() {
  const serverCount = serverAttentionCount();
  const clientCount = clientAttentionItems().length;
  const attentionCheckFailed = state.syncAttentionError && !serverCount && !clientCount ? 1 : 0;
  return serverCount + clientCount + attentionCheckFailed;
}

function attentionTone() {
  const items = attentionItems();
  if (state.syncAttentionError) return "error";
  if (items.some((item) => attentionToneForItem(item) === "error")) return "error";
  if (items.length) return "warning";
  return state.syncAttentionSeverity === "error" ? "error" : "clear";
}

function syncAttentionNeeded() {
  return serverAttentionCount() > 0 || Boolean(state.syncAttentionError);
}

function statusText() {
  const total = Number(state.syncActivityProgress?.total) || 0;
  const completed = Number(state.syncActivityProgress?.completed) || 0;
  if (total > 0 && completed < total) return `Sync - ${completed} of ${total}`;
  if (state.syncActivityProgress?.active) return `Sync - ${state.syncActivityProgress.label || "Working"}`;
  if (syncAttentionNeeded()) return "Sync - Attention Needed";
  return "Sync - Idle";
}

function isActive() {
  const total = Number(state.syncActivityProgress?.total) || 0;
  const completed = Number(state.syncActivityProgress?.completed) || 0;
  return Boolean(state.syncActivityProgress?.active) || (total > 0 && completed < total);
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
    const status = String(entry.status || "").toLowerCase();
    const noTargets = status === "skipped" || /no enabled sync destinations/i.test(entry.details || "");
    const label = status === "pending" ? "Waiting for dispatch" : noTargets ? "No eligible destinations" : "No target response recorded";
    return `<span class="sync-activity-target sync-activity-target--empty" data-status="pending">${label}</span>`;
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
  const pending = String(entry.status || "").toLowerCase() === "pending";
  const to = targets.length ? targets.map((name) => escapeHtml(name)).join(", ") : pending ? "Awaiting dispatch" : "None recorded";
  return `
    <div class="sync-activity-row-route">
      <span class="sync-activity-route-leg"><span>Source</span><b>${escapeHtml(source)}</b></span>
      <span class="sync-activity-route-arrow" aria-hidden="true">-&gt;</span>
      <span class="sync-activity-route-leg"><span>Destinations</span><b>${to}</b></span>
    </div>
  `;
}

function isRetryableActivity(entry = {}) {
  return ["partial", "error", "failed", "skipped"].includes(String(entry.status || "").toLowerCase())
    && (entry.targetStates || []).some((target) => ["error", "failed", "skipped", "not_found"].includes(String(target.status || "").toLowerCase()));
}

function feedbackHtml(id) {
  const feedback = activityFeedback.get(String(id || ""));
  if (!feedback) return "";
  return `<div class="sync-activity-row-feedback sync-activity-row-feedback--${escapeAttribute(feedback.tone || "muted")}" role="status">${escapeHtml(feedback.text)}</div>`;
}

function groupLatestEntry(group = {}) {
  return group?.latest && typeof group.latest === "object" ? group.latest : {};
}

function groupTone(group = {}) {
  const latest = groupLatestEntry(group);
  if (Number(group.problemCount || 0) > 0) return "error";
  if (Number(group.pendingCount || 0) > 0) return "pending";
  return syncHistoryTone(latest);
}

function statusClassForTone(tone) {
  return tone === "error" ? "status-error" : tone === "pending" ? "status-warning" : "status-ready";
}

function pluralLabel(count, singular, plural = `${singular}s`) {
  const value = Number(count) || 0;
  return `${value} ${value === 1 ? singular : plural}`;
}

function groupSummaryLine(group = {}) {
  const latest = groupLatestEntry(group);
  const source = activityPlatform(latest.source);
  const pieces = [
    pluralLabel(group.eventCount, "event"),
    `latest ${formatDate(group.timestamp || latest.timestamp)}`,
    `${source.name} · ${syncHistoryActionLabel(latest)}`,
  ];
  if (Number(group.problemCount || 0) > 0) pieces.push(pluralLabel(group.problemCount, "issue"));
  return pieces.join(" · ");
}

function activityGroupRow(group = {}) {
  const latest = groupLatestEntry(group);
  const tone = groupTone(group);
  const mediaType = String(group.mediaType || latest.mediaType || "").toLowerCase() === "movie" ? "Movie" : "Show";
  const statusLabel = latest.status || "unknown";
  const statusClass = statusClassForTone(tone);
  const groupKey = String(group.groupKey || latest.activityGroupKey || "");
  const title = group.title || latest.title || "Unknown media";
  return `
    <article class="sync-activity-row sync-activity-group-row" data-tone="${tone}" data-activity-group-key="${escapeAttribute(groupKey)}" role="button" tabindex="0" aria-expanded="false" title="Show all sync activity for ${escapeAttribute(title)}">
      <span class="sync-status-dot sync-status-dot--${tone}" aria-hidden="true"></span>
      <div class="sync-activity-group-main">
        <div class="sync-activity-group-heading">
          <button class="sync-activity-row-title sync-activity-group-title" type="button" data-media-href="${escapeAttribute(mediaHrefFor(latest))}" title="Open ${escapeAttribute(title)}">${escapeHtml(title)}</button>
          <span class="sync-activity-type">${escapeHtml(mediaType)}</span>
        </div>
        <div class="sync-activity-group-summary">${escapeHtml(groupSummaryLine(group))}</div>
        ${routeLine(latest)}
        ${latest.details ? `<div class="sync-activity-row-detail sync-activity-group-latest-detail">${escapeHtml(latest.details)}</div>` : ""}
      </div>
      <div class="sync-activity-group-outcome">
        <div class="sync-activity-outcome-heading">
          <span>Latest result</span>
          <span class="status-pill ${statusClass} sync-activity-row-status">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="sync-activity-row-results">${targetResults(latest)}</div>
        <div class="sync-activity-group-counts">
          <div class="sync-activity-group-count-labels">
            <span>${escapeHtml(pluralLabel(group.eventCount, "recorded event"))}</span>
            ${Number(group.problemCount || 0) > 0 ? `<span class="sync-activity-group-issue-count">${escapeHtml(pluralLabel(group.problemCount, "issue"))}</span>` : ""}
          </div>
          <button class="button-ghost sync-activity-download" type="button" data-sync-activity-download="${escapeAttribute(groupKey)}" title="Download every event for this media">Download all logs</button>
        </div>
      </div>
      <div class="sync-activity-group-detail hidden" data-sync-activity-group-detail></div>
    </article>
  `;
}

function syncActivityEventRow(entry = {}, index = 0) {
  const tone = syncHistoryTone(entry);
  const source = activityPlatform(entry.source);
  const statusClass = statusClassForTone(tone);
  const id = entry.id != null ? String(entry.id) : "";
  const retryable = isRetryableActivity(entry);
  const retrying = retryingActivityIds.has(id);
  const isEpisode = String(entry.mediaType || "").toLowerCase() === "episode";
  const eventLabel = isEpisode && entry.title ? `${syncHistoryActionLabel(entry)} · ${entry.title}` : syncHistoryActionLabel(entry);
  return `
    <details class="sync-activity-event" ${index === 0 ? "open" : ""}>
      <summary>
        <span class="sync-status-dot sync-status-dot--${tone}" aria-hidden="true"></span>
        <strong>${escapeHtml(eventLabel)}</strong>
        <span class="sync-activity-event-source">${platformIcon(source)}${escapeHtml(source.name)}</span>
        <span class="sync-activity-event-time">${escapeHtml(formatDate(entry.timestamp))}</span>
        <span class="status-pill ${statusClass}">${escapeHtml(entry.status || "unknown")}</span>
      </summary>
      <div class="sync-activity-event-body">
        ${routeLine(entry)}
        ${entry.details ? `<div class="sync-activity-row-detail">${escapeHtml(entry.details)}</div>` : ""}
        <div class="sync-activity-row-results">${targetResults(entry)}</div>
        <div class="sync-activity-row-actions">
          ${retryable ? `<button class="button-ghost sync-activity-retry" type="button" data-sync-activity-retry="${escapeAttribute(id)}" ${retrying ? "disabled" : ""} title="Retry only the failed or skipped destinations">${retrying ? "Retrying..." : "Retry failed"}</button>` : ""}
        </div>
        ${feedbackHtml(id)}
        <pre class="sync-activity-log">${escapeHtml(buildSyncActivityLog(entry))}</pre>
      </div>
    </details>
  `;
}

function renderGroupEvents(groupKey, payload, container) {
  if (!container) return;
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const group = payload?.group || {};
  const pagination = payload?.pagination || {};
  const olderButton = pagination.hasNext
    ? `<button class="button-ghost sync-activity-group-more" type="button" data-sync-activity-group-more="${escapeAttribute(groupKey)}" data-sync-activity-group-page="${Number(pagination.page || 1) + 1}">Load older events</button>`
    : "";
  container.innerHTML = `
    <div class="sync-activity-group-detail-heading">
      <b>Latest sync activity</b>
      <span>${escapeHtml(pluralLabel(group.eventCount, "event"))} kept in the audit log</span>
    </div>
    <div class="sync-activity-event-list">
      ${events.length ? events.map((entry, index) => syncActivityEventRow(entry, index)).join("") : `<div class="empty-log"><b>No event details available</b><span>Refresh the page and try again.</span></div>`}
    </div>
    ${olderButton}
  `;
}

// The actual retry call plus outcome-recording, shared by the single-row
// button and the bulk retry loop below. Never throws - every outcome,
// including a network failure, is recorded via feedback/notes and returned
// instead. Deliberately does not touch retryingActivityIds or reload the
// list - callers own that, since the bulk path needs different bookkeeping
// (no per-item full-list reload) than a single click does.
async function dispatchRetry(key) {
  try {
    const response = await fetch("/api/sync-history/retry", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: key }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Retry failed with ${response.status}`);
    const text = body.status === "success"
      ? "Retry completed."
      : body.status === "skipped"
        ? (body.details || "Nothing to retry - no destination is currently configured for this item.")
        : `Retry finished: ${body.status}.`;
    setActivityFeedback(key, { text, tone: body.status === "success" ? "success" : "warning" });
    appendActivityNote(key, text);
    return body;
  } catch (error) {
    const text = error.message || "Sync retry failed.";
    setActivityFeedback(key, { text, tone: "error" });
    appendActivityNote(key, text);
    return { status: "error", details: text };
  }
}

// Feedback is shown inline on the row (feedbackHtml) and folded into that
// row's own log (buildSyncActivityLog) rather than as a toast, so it stays
// attached to the item it's about instead of a corner notification the user
// has to catch before it disappears.
export async function retrySyncActivity(id) {
  const key = String(id || "");
  if (!key || retryingActivityIds.has(key)) return null;

  retryingActivityIds.add(key);
  setActivityFeedback(key, null);
  renderSyncActivity();
  try {
    const result = await dispatchRetry(key);
    for (const [groupKey, cached] of groupEventCache.entries()) {
      if ((cached.events || []).some((entry) => String(entry.id) === key)) groupEventCache.delete(groupKey);
    }
    await loadSyncActivity({ force: true, page: 1 });
    return result;
  } finally {
    retryingActivityIds.delete(key);
    renderSyncActivity();
  }
}

// Walks every page of /api/sync-history (not just what's currently loaded/
// displayed) collecting every retryable entry's id, so "retry all failed"
// covers the whole library rather than only the ~25 rows on screen. Uses the
// server's own 200-row page cap to keep this to a handful of requests even
// for a few thousand entries.
export async function fetchAllRetryableSyncActivityIds() {
  const ids = [];
  const search = (state.syncActivitySearch || "").trim();
  const limit = 200;
  let page = 1;
  for (;;) {
    const url = new URL("/api/sync-history", window.location.origin);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("page", String(page));
    if (search) url.searchParams.set("search", search);
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    if (!response.ok) break;
    const body = await response.json().catch(() => null);
    const history = Array.isArray(body?.history) ? body.history : [];
    for (const entry of history) {
      if (isRetryableActivity(entry)) ids.push(String(entry.id));
    }
    const totalPages = Math.max(Number(body?.pagination?.totalPages) || 1, 1);
    if (!history.length || page >= totalPages) break;
    page += 1;
  }
  return ids;
}

// "Retry all failed" runs as a server-side background job (see
// runRetryAllSyncActivityJob in server/src/routes/sync.js) rather than a
// client-driven loop, so it keeps running - and survives - a closed tab,
// a page reload, or navigating away, the same way Force Sync does. This
// module only starts the job and polls its status/log; the actual retries
// happen entirely on the server.
let bulkRetryPollTimer = null;

function stopBulkRetryPoll() {
  if (bulkRetryPollTimer) window.clearTimeout(bulkRetryPollTimer);
  bulkRetryPollTimer = null;
}

// The job's log lines are "[i/total] <title>: <status>" once discovery has
// run, plus a leading "Found N failed or skipped item(s) to retry." line
// before the first one - parsed back out here instead of carrying a second,
// separate progress channel.
function parseBulkRetryProgress(log) {
  let index = 0;
  let total = 0;
  for (const line of log) {
    const item = /^\[(\d+)\/(\d+)\]/.exec(line);
    if (item) { index = Number(item[1]); total = Number(item[2]); continue; }
    const found = /^Found (\d+) failed or skipped/.exec(line);
    if (found) total = Number(found[1]);
  }
  return { index, total };
}

async function pollRetryAllSyncActivity(onDone) {
  stopBulkRetryPoll();
  let body;
  try {
    const response = await fetch("/api/sync-history/retry-all", { headers: authHeaders(), cache: "no-store" });
    body = await response.json();
  } catch (error) {
    bulkRetryPollTimer = window.setTimeout(() => pollRetryAllSyncActivity(onDone), 3000);
    return;
  }

  const log = Array.isArray(body.log) ? body.log : [];
  if (body.active) {
    bulkRetryProgress = parseBulkRetryProgress(log);
    renderSyncActivity();
    bulkRetryPollTimer = window.setTimeout(() => pollRetryAllSyncActivity(onDone), 2000);
    return;
  }

  bulkRetryProgress = null;
  await loadSyncActivity({ force: true, page: 1 }).catch(() => {});
  renderSyncActivity();
  if (typeof onDone === "function") onDone(body.result || null);
}

// Starts the background job and begins polling it. `onDone(result)` is
// called once the job finishes (or is found to have already finished),
// so the caller can surface a completion message.
export async function startRetryAllSyncActivity(onDone) {
  const response = await fetch("/api/sync-history/retry-all", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && !(response.status === 409 && body.jobId)) {
    throw new Error(body.error || `Retry all failed to start with HTTP ${response.status}`);
  }
  bulkRetryProgress = { index: 0, total: 0 };
  renderSyncActivity();
  pollRetryAllSyncActivity(onDone);
}

// Called whenever the Sync Activity page becomes visible, so a run started
// from another tab (or before a reload) picks its polling back up instead of
// the button silently sitting idle while the job keeps working server-side.
export async function resumeRetryAllSyncActivityIfRunning() {
  if (bulkRetryPollTimer) return;
  try {
    const response = await fetch("/api/sync-history/retry-all", { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!body?.active) return;
    bulkRetryProgress = parseBulkRetryProgress(Array.isArray(body.log) ? body.log : []);
    renderSyncActivity();
    pollRetryAllSyncActivity();
  } catch {
    // No connectivity yet - the next periodic sync activity refresh will retry.
  }
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

  const notes = activityNotes.get(entry.id != null ? String(entry.id) : "") || [];
  if (notes.length) {
    lines.push("", "Retry attempts (this browser session):");
    for (const note of notes) lines.push(`  ${logTimestamp(note.timestamp)}: ${note.text}`);
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

function currentActivityGroup(groupKey) {
  const key = String(groupKey || "");
  return state.syncActivity.find((group) => String(group.groupKey || "") === key) || groupEventCache.get(key)?.group || null;
}

function groupEventPageUrl(groupKey, page = 1, limit = 200) {
  const url = new URL("/api/sync-activity/group", window.location.origin);
  url.searchParams.set("key", String(groupKey || ""));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("page", String(Math.max(Number(page) || 1, 1)));
  return url;
}

async function requestActivityGroupPage(groupKey, page = 1, limit = 200) {
  const response = await fetch(groupEventPageUrl(groupKey, page, limit), { headers: authHeaders(), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Sync activity details failed with ${response.status}`);
  return body;
}

function cacheActivityGroupPage(groupKey, body, append = false) {
  const key = String(groupKey || "");
  const previous = groupEventCache.get(key);
  const incoming = Array.isArray(body?.events) ? body.events : [];
  const events = append
    ? [...(previous?.events || []), ...incoming.filter((event) => !(previous?.events || []).some((item) => String(item.id) === String(event.id)))]
    : incoming;
  const cached = {
    group: body?.group || previous?.group || currentActivityGroup(key),
    events,
    pagination: body?.pagination || previous?.pagination || { page: 1, total: events.length, totalPages: 1, hasNext: false },
  };
  groupEventCache.set(key, cached);
  return cached;
}

async function loadActivityGroupPage(groupKey, { page = 1, force = false } = {}) {
  const key = String(groupKey || "");
  if (!key) throw new Error("Sync activity group is missing");
  const cached = groupEventCache.get(key);
  if (!force && Number(page) === 1 && cached) return cached;
  const body = await requestActivityGroupPage(key, page, 200);
  return cacheActivityGroupPage(key, body, Number(page) > 1 && !force);
}

async function fetchAllActivityGroupEvents(groupKey) {
  const key = String(groupKey || "");
  const first = await requestActivityGroupPage(key, 1, 500);
  const all = [...(Array.isArray(first.events) ? first.events : [])];
  const totalPages = Math.max(Number(first.pagination?.totalPages) || 1, 1);
  for (let page = 2; page <= totalPages; page += 1) {
    const body = await requestActivityGroupPage(key, page, 500);
    for (const event of Array.isArray(body.events) ? body.events : []) {
      if (!all.some((item) => String(item.id) === String(event.id))) all.push(event);
    }
  }
  cacheActivityGroupPage(key, { ...first, events: all }, false);
  return { group: first.group || currentActivityGroup(key), events: all };
}

function buildSyncActivityGroupLog(group = {}, events = []) {
  const latest = groupLatestEntry(group);
  const lines = [
    "Plembfin grouped sync log",
    `Exported: ${new Date().toISOString()}`,
    "",
    `Title: ${group.title || latest.title || "Unknown media"}`,
    `Media type: ${group.mediaType || latest.mediaType || "unknown"}`,
    `Recorded events: ${events.length || Number(group.eventCount) || 0}`,
    `Latest activity: ${logTimestamp(group.timestamp || latest.timestamp)}`,
    "",
  ];
  for (const [index, event] of events.entries()) {
    lines.push(`===== Event ${index + 1} of ${events.length} =====`, buildSyncActivityLog(event).trim(), "");
  }
  return `${lines.join("\n")}\n`;
}

export async function downloadSyncActivityLog(groupKey) {
  const group = currentActivityGroup(groupKey);
  if (!group) return false;
  const detail = await fetchAllActivityGroupEvents(groupKey);
  const latest = detail.group || group;
  const blob = new Blob([buildSyncActivityGroupLog(latest, detail.events)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = syncActivityLogFilename({ title: latest.title || group.title, timestamp: latest.timestamp || group.timestamp });
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

// Clicking anywhere on a group row that is not the title or the download
// button expands it and fetches the complete event list for that media item.
export function toggleSyncActivityRowLog(row) {
  if (!row) return false;
  const detail = row.querySelector("[data-sync-activity-group-detail]");
  const groupKey = String(row.dataset.activityGroupKey || "");
  if (!detail || !groupKey) return false;
  const expanded = row.getAttribute("aria-expanded") === "true";
  if (expanded) {
    detail.classList.add("hidden");
    row.setAttribute("aria-expanded", "false");
    return true;
  }
  row.setAttribute("aria-expanded", "true");
  detail.classList.remove("hidden");
  const cached = groupEventCache.get(groupKey);
  const current = currentActivityGroup(groupKey);
  const cacheIsCurrent = cached && (!current
    || (Number(cached.pagination?.total) || cached.events.length) === (Number(current.eventCount) || 0)
    && Number(cached.group?.timestamp || 0) >= Number(current.timestamp || 0));
  if (cacheIsCurrent) {
    renderGroupEvents(groupKey, cached, detail);
    return true;
  }
  detail.innerHTML = `<div class="empty-log"><b>Loading activity</b><span>Fetching every checkpoint and target result for this media.</span></div>`;
  if (!groupEventLoading.has(groupKey)) {
    groupEventLoading.add(groupKey);
    loadActivityGroupPage(groupKey, { force: Boolean(cached) })
      .then((payload) => {
        if (row.getAttribute("aria-expanded") === "true") renderGroupEvents(groupKey, payload, detail);
      })
      .catch((error) => {
        if (row.getAttribute("aria-expanded") === "true") {
          detail.innerHTML = `<div class="empty-log"><b>Could not load activity details</b><span>${escapeHtml(error.message || "Refresh the page and try again.")}</span></div>`;
        }
      })
      .finally(() => groupEventLoading.delete(groupKey));
  }
  return true;
}

export async function loadOlderSyncActivityGroup(groupKey, page) {
  const key = String(groupKey || "");
  const payload = await loadActivityGroupPage(key, { page: Math.max(Number(page) || 1, 1) });
  const row = [...(elements.syncActivityRows?.querySelectorAll(".sync-activity-group-row") || [])]
    .find((candidate) => candidate.dataset.activityGroupKey === key);
  if (row?.getAttribute("aria-expanded") === "true") {
    renderGroupEvents(key, payload, row.querySelector("[data-sync-activity-group-detail]"));
  }
  return payload;
}

export function renderSyncActivityStatus() {
  const text = statusText();
  const hasAttention = syncAttentionNeeded();
  const stateName = isActive() ? "active" : hasAttention ? "attention" : "idle";
  const attentionToneName = hasAttention
    ? (state.syncAttentionError || state.syncAttentionSeverity === "error" ? "error" : "warning")
    : "clear";
  if (elements.syncProgressIndicator && elements.syncProgressText) {
    elements.syncProgressText.textContent = text;
    elements.syncProgressIndicator.dataset.syncState = stateName;
    elements.syncProgressIndicator.dataset.attentionTone = attentionToneName;
    elements.syncProgressIndicator.title = hasAttention
      ? "Open sync activity - attention needed"
      : "Open sync activity";
  }
  if (elements.syncActivityStatus && elements.syncActivityStatusText) {
    elements.syncActivityStatusText.textContent = text;
    elements.syncActivityStatus.dataset.syncState = stateName;
    elements.syncActivityStatus.dataset.attentionTone = attentionToneName;
  }
  renderSidebarSyncAttention();
}

function renderSidebarSyncAttention() {
  const container = elements.sidebarSyncAttention;
  const button = elements.sidebarSyncAttentionButton;
  if (!container || !button) return;
  const items = clientAttentionItems();
  const count = items.length;
  const tone = items.some((item) => attentionToneForItem(item) === "error") ? "error" : "warning";
  const visible = count > 0;
  container.classList.toggle("hidden", !visible);
  if (!visible) {
    container.removeAttribute("data-attention-tone");
    button.removeAttribute("data-attention-tone");
    return;
  }

  const title = "Attention";
  const detail = tone === "error" ? "Issue" : "Warning";
  container.dataset.attentionTone = tone;
  button.dataset.attentionTone = tone;
  if (elements.sidebarSyncAttentionTitle) elements.sidebarSyncAttentionTitle.textContent = title;
  if (elements.sidebarSyncAttentionText) elements.sidebarSyncAttentionText.textContent = detail;
  button.title = "Open Sync Activity to review this issue";
  button.setAttribute("aria-label", `${title}: ${detail}. Open Sync Activity for details.`);
}

export function setSyncAttentionSummary({ count = 0, status = "", severity = "" } = {}) {
  const normalizedCount = Math.max(Number(count) || 0, 0);
  state.syncAttentionCount = normalizedCount;
  state.syncAttentionStatus = normalizedCount > 0 || String(status || "").toLowerCase() === "attention" ? "attention" : "clear";
  state.syncAttentionSeverity = normalizedCount > 0
    ? normalizeAttentionTone(severity || status, "error")
    : "clear";
  if (normalizedCount === 0) {
    state.syncAttention = [];
    if (String(status || "").toLowerCase() !== "attention") state.syncAttentionError = "";
  }
  renderSyncActivityStatus();
  renderSyncAttention();
}

function clientAttentionSignature(message, route) {
  return `${route}\n${String(message || "").replace(/\s+/g, " ").trim()}`.slice(0, 600);
}

function clientAttentionId(signature) {
  let hash = 0;
  for (let index = 0; index < signature.length; index += 1) {
    hash = ((hash << 5) - hash) + signature.charCodeAt(index);
    hash |= 0;
  }
  return `client:${Math.abs(hash).toString(36)}`;
}

function clientAttentionRoute() {
  if (typeof window === "undefined") return "";
  return `${window.location.pathname || "/"}${window.location.search || ""}${window.location.hash || ""}`;
}

function clientAttentionTitle(message, explicitTitle = "") {
  if (explicitTitle) return explicitTitle;
  const match = String(message || "").match(/^([^:]{2,48}):\s*/);
  const source = match?.[1]?.trim();
  return source ? `${source} needs attention` : "Request needs attention";
}

function clientAttentionRecommendations(message) {
  const lower = String(message || "").toLowerCase();
  if (/unauthorized|forbidden|401|403|token|credential|api key/.test(lower)) {
    return [
      "Open Settings → Connections and verify the affected service URL and credentials.",
      "Test the connection after saving any correction.",
      "Review Settings → Logs if the connection still fails.",
    ];
  }
  if (/timeout|timed out|network|refused|connect|fetch failed|econn|socket/.test(lower)) {
    return [
      "Confirm the affected service is running and reachable from the Plembfin server.",
      "Check firewall, proxy, DNS, and TLS settings for the connection.",
      "Review Settings → Logs for the full request failure.",
    ];
  }
  if (/not found|404|older build|route missing/.test(lower)) {
    return [
      "Confirm the requested item or local API route exists in this Plembfin build.",
      "Restart Plembfin if the message says the server is running an older build.",
      "Review Settings → Logs for the full failure context.",
    ];
  }
  return [
    "Review Settings → Logs for the full failure details.",
    "Check the affected connection or configuration before trying the action again.",
  ];
}

export function recordClientAttention(message, tone = "error", options = {}) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const route = String(options.route || clientAttentionRoute());
  const signature = clientAttentionSignature(text, route);
  const id = clientAttentionId(signature);
  const existing = clientAttentionItems().find((item) => item.id === id);
  const item = {
    ...(existing || {}),
    id,
    source: "client",
    kind: "client_request_failure",
    severity: normalizeAttentionTone(tone, "error"),
    title: clientAttentionTitle(text, String(options.title || "").trim()),
    summary: text,
    explanation: String(options.explanation || "Plembfin could not complete this request. The failure is kept here so it is not lost when the page changes."),
    recommendations: Array.isArray(options.recommendations) && options.recommendations.length
      ? options.recommendations.filter(Boolean)
      : clientAttentionRecommendations(text),
    canSkip: false,
    createdAt: Number(existing?.createdAt || Date.now()),
    context: {
      ...(existing?.context || {}),
      route,
      signature,
    },
  };
  state.clientAttention = [item, ...clientAttentionItems().filter((candidate) => candidate.id !== id)].slice(0, 8);
  renderSyncActivityStatus();
  renderSyncAttention();
  return item;
}

export function clearClientAttention() {
  if (!clientAttentionItems().length) return;
  state.clientAttention = [];
  renderSyncActivityStatus();
  renderSyncAttention();
}

export function clearClientAttentionForRoute(route = clientAttentionRoute()) {
  const targetRoute = String(route || "");
  const remaining = clientAttentionItems().filter((item) => String(item.context?.route || "") !== targetRoute);
  if (remaining.length === clientAttentionItems().length) return;
  state.clientAttention = remaining;
  renderSyncActivityStatus();
  renderSyncAttention();
}

function attentionCreatedAt(item = {}) {
  const value = Number(item.createdAt || 0);
  return Number.isFinite(value) && value > 0 ? formatDate(value) : "during the current sync run";
}

function attentionExamples(item = {}) {
  const examples = Array.isArray(item.context?.examples) ? item.context.examples.filter(Boolean) : [];
  if (!examples.length) return "";
  return `
    <div class="sync-attention-examples">
      <h4>Examples</h4>
      <ul>${examples.map((example) => `<li>${escapeHtml(example)}</li>`).join("")}</ul>
    </div>`;
}

function attentionIssueCode(issue = {}) {
  const season = Number(issue.sourceSeason ?? issue.season);
  const episode = Number(issue.sourceEpisode ?? issue.episode);
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return "";
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

function attentionIssueDate(issue = {}) {
  const watchedAt = String(issue.watchedAt || "").trim();
  return watchedAt ? formatDate(watchedAt) : "Date unavailable";
}

function attentionIssueProvider(issue = {}) {
  const provider = String(issue.provider || issue.target || "").trim().toLowerCase();
  if (provider === "plex") return "Plex";
  if (provider === "emby") return "Emby";
  if (provider === "jellyfin") return "Jellyfin";
  if (provider === "trakt") return "Trakt";
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "";
}

function attentionIssueMarkup(parentId, issue = {}) {
  const issueKey = String(issue.key || issue.sourceRowId || "").trim();
  if (!issueKey) return "";
  const actionKey = `${parentId}:${issueKey}`;
  const skipping = state.syncAttentionIssueSkipping === actionKey;
  const code = attentionIssueCode(issue);
  const provider = attentionIssueProvider(issue);
  const metadata = [code, issue.watchedAt ? `Watched ${attentionIssueDate(issue)}` : "Date unavailable"]
    .concat(provider ? [`Target ${provider}`] : [])
    .filter(Boolean)
    .join(" · ");
  const href = String(issue.localHref || "").trim();
  const linkLabel = String(issue.localLinkLabel || "Open in Plembfin");
  const reason = String(issue.reason || (provider && provider !== "Trakt"
    ? `${provider} did not confirm the restored state.`
    : "Trakt could not match this restored play."));
  const skipButton = `<button class="button-ghost sync-attention-issue-skip" type="button" data-sync-attention-skip-item="${escapeAttribute(parentId)}" data-sync-attention-item-key="${escapeAttribute(issueKey)}" ${skipping ? "disabled" : ""} ${skipping ? 'aria-busy="true"' : ""}>${escapeHtml(skipping ? "Skipping..." : "Skip this issue")}</button>`;
  return `
    <article class="sync-attention-issue" data-sync-attention-issue="${escapeAttribute(issueKey)}">
      <div class="sync-attention-issue-copy">
        <div class="sync-attention-issue-title-row">
          <h4>${escapeHtml(issue.title || "Unknown media")}</h4>
          ${issue.candidate ? '<span class="sync-attention-issue-badge">Candidate</span>' : ""}
        </div>
        <span class="sync-attention-issue-meta">${escapeHtml(metadata)}</span>
        <span class="sync-attention-issue-reason">${escapeHtml(reason)}</span>
      </div>
      <div class="sync-attention-issue-actions">
        ${href ? `<a class="button-ghost sync-attention-issue-link" href="${escapeAttribute(href)}">${escapeHtml(linkLabel)}</a>` : '<span class="sync-attention-issue-unavailable">No local link available</span>'}
        ${issue.canRepair === true ? skipButton : ""}
      </div>
    </article>`;
}

function attentionIssueList(item = {}) {
  const context = item.context || {};
  const issues = Array.isArray(context.issueItems) ? context.issueItems : [];
  const issueCount = Math.max(Number(context.issueCount) || issues.length, issues.length);
  const itemWord = issues.some((issue) => {
    const provider = String(issue.provider || issue.target || "").toLowerCase();
    return provider && provider !== "trakt";
  }) ? "item" : "play";
  if (!issueCount && !issues.length) return attentionExamples(item);
  const listed = issues.length;
  const complete = context.issueItemsComplete === true && listed >= issueCount;
  const description = complete
    ? `All ${issueCount} affected ${itemWord}${issueCount === 1 ? " is" : "s are"} listed below.`
    : listed
      ? `${listed} of ${issueCount} affected ${itemWord}s are listed. The failed run retained only these examples; run a new restore to capture any missing item-level details.`
      : `${issueCount} affected ${itemWord}s were reported, but the failed run did not retain item-level details. Run a new restore to capture them.`;
  return `
    <div class="sync-attention-issues">
      <div class="sync-attention-issues-heading">
        <h4>Affected plays</h4>
        <span>${escapeHtml(`${listed} listed · ${issueCount} total`)}</span>
      </div>
      <p class="sync-attention-issues-note">${escapeHtml(description)}</p>
      ${listed ? `<div class="sync-attention-issue-list">${issues.map((issue) => attentionIssueMarkup(item.id, issue)).join("")}</div>` : ""}
    </div>`;
}

function syncAttentionItemMarkup(item = {}) {
  const recommendations = Array.isArray(item.recommendations) ? item.recommendations.filter(Boolean) : [];
  const skipping = state.syncAttentionSkipping === String(item.id || "");
  const skipLabel = skipping ? "Skipping..." : String(item.skipLabel || "Skip this issue");
  const tone = attentionToneForItem(item);
  const isBlocking = tone === "error";
  return `
    <article class="sync-attention-item" data-sync-attention-item="${escapeAttribute(item.id)}">
      <div class="sync-attention-item-header">
        <div class="sync-attention-item-title">
          <span class="sync-attention-kicker">${isBlocking ? "Blocking issue" : "Warning"}</span>
          <h3>${escapeHtml(item.title || "Sync issue")}</h3>
        </div>
        <span class="status-pill status-${isBlocking ? "error" : "warning"}">${isBlocking ? "Needs attention" : "Review warning"}</span>
      </div>
      <p class="sync-attention-summary">${escapeHtml(item.summary || "This operation did not complete.")}</p>
      <div class="sync-attention-detail-grid">
        <div>
          <h4>Why this blocks completion</h4>
          <p>${escapeHtml(item.explanation || "The sync cannot be considered complete until this issue is resolved or skipped.")}</p>
        </div>
        <div>
          <h4>Recommended next steps</h4>
          ${recommendations.length
            ? `<ol>${recommendations.map((recommendation) => `<li>${escapeHtml(recommendation)}</li>`).join("")}</ol>`
            : `<p>Review Settings → Logs, correct the affected connection, and retry the operation.</p>`}
        </div>
      </div>
      ${attentionIssueList(item)}
      <div class="sync-attention-item-footer">
        <span class="sync-attention-detected">Detected ${escapeHtml(attentionCreatedAt(item))}</span>
        <div class="sync-attention-actions">
          <p>Skipping accepts this incomplete projection and lets normal sync resume; it does not create the missing remote records.</p>
          <button class="button-ghost sync-attention-skip" type="button" data-sync-attention-skip="${escapeAttribute(item.id)}" ${skipping ? "disabled" : ""} ${skipping ? 'aria-busy="true"' : ""}>${escapeHtml(skipLabel)}</button>
        </div>
      </div>
    </article>`;
}

function clientAttentionItemMarkup(item = {}) {
  const recommendations = Array.isArray(item.recommendations) ? item.recommendations.filter(Boolean) : [];
  const tone = attentionToneForItem(item);
  const route = String(item.context?.route || "").trim();
  const internalRoute = route.startsWith("/") && !route.startsWith("//") ? route : "";
  return `
    <article class="sync-attention-item sync-attention-item--client" data-sync-client-attention="${escapeAttribute(item.id)}">
      <div class="sync-attention-item-header">
        <div class="sync-attention-item-title">
          <span class="sync-attention-kicker">${tone === "error" ? "Request failed" : "Warning"}</span>
          <h3>${escapeHtml(item.title || "Request needs attention")}</h3>
        </div>
        <span class="status-pill status-${tone === "error" ? "error" : "warning"}">${tone === "error" ? "Needs attention" : "Review warning"}</span>
      </div>
      <p class="sync-attention-summary">${escapeHtml(item.summary || "The request did not complete.")}</p>
      <div class="sync-attention-detail-grid">
        <div>
          <h4>What happened</h4>
          <p>${escapeHtml(item.explanation || "Plembfin could not complete this request.")}</p>
        </div>
        <div>
          <h4>What to do</h4>
          ${recommendations.length
            ? `<ol>${recommendations.map((recommendation) => `<li>${escapeHtml(recommendation)}</li>`).join("")}</ol>`
            : `<p>Review Settings → Logs for the full failure details.</p>`}
        </div>
      </div>
      <div class="sync-attention-item-footer">
        <span class="sync-attention-detected">Detected ${escapeHtml(attentionCreatedAt(item))}</span>
        ${internalRoute
          ? `<div class="sync-attention-actions"><a class="button-ghost sync-attention-issue-link" href="${escapeAttribute(internalRoute)}">Return to affected page</a></div>`
          : ""}
      </div>
    </article>`;
}

export function renderSyncAttention() {
  const container = elements.syncActivityAttention;
  if (!container) return;
  const items = attentionItems();
  const serverItems = serverAttentionItems();
  const count = attentionCount();
  const loading = state.syncAttentionLoading === true;
  const error = String(state.syncAttentionError || "").trim();

  if (!count && !loading && !error) {
    container.classList.add("hidden");
    container.removeAttribute("data-attention-tone");
    container.innerHTML = "";
    return;
  }

  container.classList.remove("hidden");
  container.dataset.attentionTone = attentionTone() === "error" ? "error" : "warning";
  if (loading && !state.syncAttentionLoaded && !clientAttentionItems().length) {
    container.innerHTML = `<div class="sync-attention-loading"><b>Checking sync blockers</b><span>Reading the latest restore and initial-sync status.</span></div>`;
    return;
  }
  if (error && !items.length) {
    container.innerHTML = `<div class="sync-attention-error"><div><b>Could not load sync attention details</b><span>${escapeHtml(error)} Review Settings → Logs for the full server-side failure. Details will refresh automatically when Sync Activity is opened again.</span></div></div>`;
    return;
  }
  if (!items.length) {
    container.innerHTML = `<div class="sync-attention-loading"><b>Sync needs attention</b><span>Loading the issue details. No automatic retry is offered from this alert.</span></div>`;
    return;
  }

  const affectedCount = serverItems.reduce((total, item) => total + (Number(item.context?.issueCount) || 0), 0);
  const blockingCount = items.filter((item) => attentionToneForItem(item) === "error").length;
  const heading = affectedCount
    ? `${count} issue${count === 1 ? "" : "s"} · ${affectedCount} affected play${affectedCount === 1 ? "" : "s"}`
    : `${count} issue${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} review`;
  const badge = blockingCount ? `${blockingCount} attention` : `${count} to review`;
  const description = serverItems.length
    ? "The restore or initial sync is paused to protect your canonical watch history. Review the explanation and recommended fixes below."
    : "These failed requests are kept here so an important problem is not lost when a temporary message disappears.";
  container.innerHTML = `
    <div class="sync-attention-heading">
      <div>
        <span class="sync-attention-kicker">Sync - Attention Needed</span>
        <h2 id="syncAttentionHeading">${escapeHtml(heading)}</h2>
        <p>${escapeHtml(description)}</p>
      </div>
      <span class="status-pill status-${blockingCount ? "error" : "warning"}">${escapeHtml(badge)}</span>
    </div>
    <div class="sync-attention-list">${items.map((item) => item.source === "client" ? clientAttentionItemMarkup(item) : syncAttentionItemMarkup(item)).join("")}</div>`;
}

export async function loadSyncAttention({ force = false } = {}) {
  if (!state.token || (state.syncAttentionLoading && !force)) return state.syncAttention;
  const requestToken = ++attentionRequestToken;
  state.syncAttentionLoading = true;
  state.syncAttentionError = "";
  renderSyncAttention();
  try {
    const response = await fetch("/api/sync-attention", { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Sync attention load failed with ${response.status}`);
    if (requestToken !== attentionRequestToken) return state.syncAttention;
    state.syncAttention = Array.isArray(body.attention) ? body.attention : [];
    state.syncAttentionCount = Math.max(Number(body.count) || state.syncAttention.length, 0);
    state.syncAttentionStatus = state.syncAttentionCount ? "attention" : "clear";
    state.syncAttentionSeverity = state.syncAttentionCount
      ? (state.syncAttention.some((item) => attentionToneForItem(item) === "error") ? "error" : "warning")
      : "clear";
    state.syncAttentionLoaded = true;
    return state.syncAttention;
  } catch (error) {
    if (requestToken === attentionRequestToken) {
      state.syncAttentionError = error.message || "Could not load sync attention details.";
      state.syncAttentionStatus = "attention";
      state.syncAttentionSeverity = "error";
    }
    throw error;
  } finally {
    if (requestToken === attentionRequestToken) {
      state.syncAttentionLoading = false;
      renderSyncActivityStatus();
      renderSyncAttention();
    }
  }
}

export async function skipSyncAttention(id) {
  const key = String(id || "").trim();
  if (!key || state.syncAttentionSkipping) return null;
  state.syncAttentionSkipping = key;
  state.syncAttentionError = "";
  renderSyncAttention();
  try {
    const response = await fetch("/api/sync-attention", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: key }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Could not skip sync issue (${response.status})`);
    await loadSyncAttention({ force: true });
    return body;
  } catch (error) {
    state.syncAttentionError = error.message || "Could not skip sync issue.";
    throw error;
  } finally {
    state.syncAttentionSkipping = "";
    renderSyncAttention();
  }
}

export async function skipSyncAttentionItem(id, itemKey) {
  const parentId = String(id || "").trim();
  const issueKey = String(itemKey || "").trim();
  if (!parentId || !issueKey || state.syncAttentionIssueSkipping) return null;
  const actionKey = `${parentId}:${issueKey}`;
  state.syncAttentionIssueSkipping = actionKey;
  state.syncAttentionError = "";
  renderSyncAttention();
  try {
    const response = await fetch("/api/sync-attention", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: parentId, itemKey: issueKey, action: "skip-item" }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Could not acknowledge restore issue (${response.status})`);
    await loadSyncAttention({ force: true });
    return body;
  } catch (error) {
    state.syncAttentionError = error.message || "Could not acknowledge restore issue.";
    throw error;
  } finally {
    if (state.syncAttentionIssueSkipping === actionKey) state.syncAttentionIssueSkipping = "";
    renderSyncAttention();
  }
}

export function setSyncActivityProgress({ total = 0, completed = 0, active = false, label = "" } = {}) {
  const normalizedTotal = Math.max(Number(total) || 0, 0);
  const normalizedCompleted = Math.max(Number(completed) || 0, 0);
  state.syncActivityProgress = {
    total: normalizedTotal,
    completed: normalizedCompleted,
    active: Boolean(active) || (normalizedTotal > 0 && normalizedCompleted < normalizedTotal),
    label: String(label || ""),
  };
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

export function resetSyncActivity() {
  loadRequestToken += 1;
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = null;
  state.syncActivity = [];
  state.syncActivityLoaded = false;
  state.syncActivityLoading = false;
  state.syncActivitySearch = "";
  state.syncActivityFailedOnly = false;
  state.syncActivityPagination = { ...DEFAULT_PAGINATION };
  groupEventCache.clear();
  groupEventLoading.clear();
}

// Filters the currently loaded page down to failed entries only - scoped to
// "on page" (matching the summary pill's own wording) rather than querying the
// server, since syncHistoryTone can flag a target-level failure that a plain
// text search wouldn't reliably match.
export function toggleSyncActivityFailedOnly() {
  state.syncActivityFailedOnly = !state.syncActivityFailedOnly;
  renderSyncActivity();
}

function renderTraktDispatchProgress() {
  const el = elements.syncActivityTraktProgress;
  if (!el) return;
  const progress = state.traktDispatchProgress;
  if (!progress || !progress.pending) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  // A stable, whole-backlog figure - separate from the "Sync - X of Y"
  // indicator above, whose Y is only the current small dispatch burst and
  // resets between bursts (see countTraktImportPendingDispatch in
  // dataRepo.js). This number only ever counts down.
  const processed = Math.max(0, progress.total - progress.pending);
  el.classList.remove("hidden");
  el.textContent = `Propagating your imported Trakt history to your media servers: ${processed} of ${progress.total} processed so far.`;
}

export function renderSyncActivity() {
  renderSyncActivityStatus();
  renderSyncAttention();
  renderTraktDispatchProgress();
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
  const pageRows = [...state.syncActivity];
  const failed = pageRows.filter((group) => groupTone(group) === "error").length;
  const failedOnly = Boolean(state.syncActivityFailedOnly) && failed > 0;
  const rows = failedOnly ? pageRows.filter((group) => groupTone(group) === "error") : pageRows;
  const pagination = { ...DEFAULT_PAGINATION, ...(state.syncActivityPagination || {}) };
  const total = Math.max(Number(pagination.total) || 0, pageRows.length);
  const from = total ? Math.max(Number(pagination.from) || 1, 1) : 0;
  const to = total ? Math.max(Number(pagination.to) || pageRows.length, from) : 0;

  if (elements.syncActivitySummary) {
    if (!pageRows.length) {
      elements.syncActivitySummary.textContent = query ? "No matches" : "No activity";
      elements.syncActivitySummary.className = "status-pill status-muted";
      elements.syncActivitySummary.removeAttribute("data-sync-activity-failed-toggle");
    } else {
      elements.syncActivitySummary.textContent = failedOnly
        ? `Showing failed only: ${failed} on page - click to show all`
        : `Showing ${from}-${to} of ${total} media groups / ${failed} with issues on page${failed ? " - click to show only failed" : ""}`;
      elements.syncActivitySummary.className = `status-pill ${failed ? "status-error" : "status-ready"}${failed ? " is-clickable" : ""}`;
      if (failed) elements.syncActivitySummary.setAttribute("data-sync-activity-failed-toggle", "1");
      else elements.syncActivitySummary.removeAttribute("data-sync-activity-failed-toggle");
    }
  }

  if (elements.syncActivityRetryAllFailed) {
    // Deliberately not a count of retryable rows on this page - that read as
    // "there are only N to retry" and undersold how many more existed across
    // the rest of the library. The real total is looked up (and confirmed
    // with the user) only once the button is actually clicked.
    const button = elements.syncActivityRetryAllFailed;
    button.disabled = Boolean(bulkRetryProgress) || total === 0;
    button.textContent = bulkRetryProgress
      ? (bulkRetryProgress.total ? `Retrying ${bulkRetryProgress.index} of ${bulkRetryProgress.total}...` : "Retrying...")
      : "Retry all failed";
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
  const expandedKeys = new Set(
    [...elements.syncActivityRows.querySelectorAll('.sync-activity-row[aria-expanded="true"]')].map((row) => row.dataset.activityGroupKey),
  );
  elements.syncActivityRows.innerHTML = rows.map(activityGroupRow).join("");
  for (const key of expandedKeys) {
    const row = [...elements.syncActivityRows.querySelectorAll(".sync-activity-group-row")]
      .find((candidate) => candidate.dataset.activityGroupKey === key);
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
    const url = new URL("/api/sync-activity", window.location.origin);
    url.searchParams.set("limit", String(ACTIVITY_PAGE_SIZE));
    url.searchParams.set("page", String(requestedPage));
    if (requestedSearch.trim()) url.searchParams.set("search", requestedSearch.trim());
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Sync activity load failed with ${response.status}`);
    if (requestToken !== loadRequestToken || requestedSearch !== state.syncActivitySearch) return state.syncActivity;
    state.syncActivity = Array.isArray(body.groups) ? body.groups : [];
    state.traktDispatchProgress = body.traktDispatchProgress || null;
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
    loadSyncAttention({ force: true }).catch(() => null);
  }, REFRESH_MS);
}

export function stopSyncActivityRefresh() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = null;
}
