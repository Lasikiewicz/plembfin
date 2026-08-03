import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, platformName, formatDate } from "./utils.js";
import { historyAction, syncStatus, telemetryLineValue } from "./sync.js";
import { syncInlineMediaDetailHeading } from "./explorer.js";

let _cb = {};
let _mediaRenderToken = 0;

export function initMediaDetail(callbacks = {}) {
  _cb = callbacks;
}
export function authHeaders() {
  return buildAuthHeaders(state.token);
}
export function setMessage(text, tone = "muted") { _cb.setMessage?.(text, tone); }
export function navigateTo(url) { _cb.navigateTo?.(url); }
export function selectView(view) { _cb.selectView?.(view); }
export function syncPageTopbar() { _cb.syncPageTopbar?.(); }
export function renderExplorer() { _cb.renderExplorer?.(); }
export function renderSearchPage() { _cb.renderSearchPage?.(); }
export function loadExplorerMovies() { return _cb.loadExplorerMovies?.() ?? Promise.resolve(); }
export function loadExplorerShows() { return _cb.loadExplorerShows?.() ?? Promise.resolve(); }

// Monotonic token guarding async media-detail renders. Each render captures the
// current value; if navigation (a new render, or clearMediaDetailState) bumps it
// while a slow TMDB fetch is in flight, the stale render aborts before writing the
// DOM. Without this, an abandoned detail page would "appear" after you'd already
// navigated back and opened something else.
//
// This token is one half of a two-token handshake that guards against a movie
// render and a show render clobbering each other; the other half is
// `state.showModalRequestToken` (declared in state.js). Both tokens are bumped
// and checked from *both* media-detail-show.js and media-detail-movie.js:
//   - media-detail-show.js: renderImmersiveShowModal() bumps this token (to
//     cancel any in-flight movie render) and owns state.showModalRequestToken
//     (bumping/checking it to cancel stale show hydration).
//   - media-detail-movie.js: renderMovieImmersiveModalContent() bumps this
//     token (and checks it after every await) and also bumps
//     state.showModalRequestToken to cancel any in-flight show hydration.
// If you change one side of this handshake, check the other file too -
// grep both files for `bumpMediaRenderToken` and `showModalRequestToken`.
export function bumpMediaRenderToken() {
  return ++_mediaRenderToken;
}
export function currentMediaRenderToken() {
  return _mediaRenderToken;
}

function provenanceForEntry(entry = {}) {
  const raw = entry.watch_provenance || entry.watchProvenance;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Fall through to the explicit legacy state below.
    }
  }
  return {
    ingest_path: "unavailable",
    event: "",
    item_id: "",
    session_id: "",
    user: "",
    source_timestamp: "",
    captured_at: "",
    confidence: "source_only",
    note: "Exact ingest path was not stored for this legacy row; only the originating platform was retained.",
  };
}

function provenanceValue(value, fallback = "Not recorded") {
  return value == null || value === "" ? fallback : value;
}

let _mediaInfoOverlay = null;
let _mediaInfoPreviousOverflow = "";
let _mediaInfoKeydown = null;

export function mediaInfoActionHtml() {
  return `
    <button class="action-pill media-info-btn" type="button" data-media-info title="Show all information for this media">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path d="M8 7.1v4.15M8 4.75h.01" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <span>Info</span>
    </button>
  `;
}

export function setMediaInfoContext(context = null) {
  state.activeMediaInfo = context && typeof context === "object" ? context : null;
}

function hasWatchRecordData(record = {}) {
  return Boolean(
    record.watched_at
    || record.sync_action
    || record.sync_dispatch_telemetry
    || record.syncDispatchTelemetry
    || record.watch_provenance
    || record.watchProvenance
    || record.source
  );
}

function infoValue(value, fallback = "Not recorded") {
  if (value == null || value === "") return fallback;
  if (Array.isArray(value)) return value.length ? value.join(", ") : fallback;
  return String(value);
}

function infoDate(value, fallback = "Not recorded") {
  if (!value) return fallback;
  const formatted = formatDate(value);
  return formatted === "Unknown" ? infoValue(value, fallback) : formatted;
}

function infoField(label, value, className = "") {
  return `
    <div class="media-info-field${className ? ` ${className}` : ""}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(infoValue(value))}</strong>
    </div>
  `;
}

function infoSection(title, eyebrow, body) {
  return `
    <section class="media-info-section">
      <div class="media-info-section-head">
        <div>
          ${eyebrow ? `<span class="media-info-eyebrow">${escapeHtml(eyebrow)}</span>` : ""}
          <h3>${escapeHtml(title)}</h3>
        </div>
      </div>
      ${body}
    </section>
  `;
}

function infoRecords(context = {}) {
  if (Array.isArray(context.records)) return context.records.filter(hasWatchRecordData);
  if (Array.isArray(context.media?.episodes)) return context.media.episodes.filter(hasWatchRecordData);
  return hasWatchRecordData(context.media) ? [context.media] : [];
}

function infoRecordTitle(record = {}, context = {}) {
  const title = record.episode_title || record.title || context.media?.title || "Watch record";
  if (context.mediaType !== "tv" || record.season == null || record.episode == null) return title;
  const season = String(record.season).padStart(2, "0");
  const episode = String(record.episode).padStart(2, "0");
  return `S${season}E${episode} · ${title}`;
}

function infoRecordPayload(record = {}) {
  return {
    id: record.id || null,
    title: record.title || null,
    media_type: record.media_type || null,
    watched_at: record.watched_at || null,
    source: record.source || null,
    imdb_id: record.imdb_id || null,
    tmdb_id: record.tmdb_id || null,
    tvdb_id: record.tvdb_id || null,
    season: record.season ?? null,
    episode: record.episode ?? null,
    show_title: record.show_title || null,
    episode_title: record.episode_title || null,
    media_key: record.media_key || null,
    sync_action: record.sync_action || null,
    sync_dispatch_telemetry: record.sync_dispatch_telemetry || record.syncDispatchTelemetry || null,
    watch_provenance: record.watch_provenance || record.watchProvenance || null,
    playHistory: Array.isArray(record.playHistory) ? record.playHistory : undefined,
  };
}

function renderInfoWatchRecord(record, context, index) {
  const telemetry = record.sync_dispatch_telemetry || record.syncDispatchTelemetry || "";
  const provenance = provenanceForEntry(record);
  const hasRecord = hasWatchRecordData(record);
  const status = hasRecord && telemetry ? syncStatus(record) : { label: "Not recorded" };
  const playHistory = Array.isArray(record.playHistory) ? [...record.playHistory].sort((a, b) => String(b.watched_at).localeCompare(String(a.watched_at))) : [];
  const recordId = record.id || `record-${index}`;
  return `
    <details class="media-info-history-record"${index === 0 ? " open" : ""}>
      <summary>
        <span class="media-info-record-title">${escapeHtml(infoRecordTitle(record, context))}</span>
        <span class="media-info-record-meta">${escapeHtml(infoDate(record.watched_at))} · ${escapeHtml(infoValue(record.source, "Source unknown"))}</span>
      </summary>
      <div class="media-info-history-body">
        <div class="media-info-fields">
          ${infoField("Record ID", recordId)}
          ${infoField("Source platform", platformName(record.source))}
          ${infoField("Action", hasRecord ? historyAction(record) : "Not recorded")}
          ${infoField("Sync state", status.label)}
          ${infoField("Telemetry origin", telemetryLineValue(telemetry, "Origin"))}
          ${infoField("Watched at", infoDate(record.watched_at))}
          ${infoField("Media key", record.media_key)}
          ${infoField("Season / episode", record.season != null && record.episode != null ? `S${String(record.season).padStart(2, "0")}E${String(record.episode).padStart(2, "0")}` : "Not applicable")}
        </div>
        <div class="media-info-provenance-block">
          <div class="media-info-subhead">
            <span>Ingest provenance</span>
            <b>${escapeHtml(infoValue(provenance.confidence, "Unknown"))}</b>
          </div>
          <div class="media-info-fields">
            ${infoField("Ingest path", provenance.ingest_path, provenance.ingest_path === "unavailable" ? "media-info-field--warning" : "")}
            ${infoField("Source event", provenance.event)}
            ${infoField("Source item ID", provenance.item_id)}
            ${infoField("Source session ID", provenance.session_id)}
            ${infoField("Source user", provenance.user)}
            ${infoField("Source timestamp", infoDate(provenance.source_timestamp))}
            ${infoField("Captured at", infoDate(provenance.captured_at))}
            ${infoField("Confidence", provenance.confidence)}
            ${infoField("Note", provenance.note, "media-info-field--wide")}
          </div>
        </div>
        ${playHistory.length > 1 ? `
          <div class="media-info-subsection">
            <div class="media-info-subhead"><span>Recorded play history</span><b>${playHistory.length} plays</b></div>
            <ul class="media-info-play-history">
              ${playHistory.map((play) => `<li><span>${escapeHtml(infoDate(play.watched_at))}</span><b>${escapeHtml(platformName(play.source))}</b></li>`).join("")}
            </ul>
          </div>
        ` : ""}
        <details class="media-info-telemetry">
          <summary>Sync dispatch telemetry</summary>
          <pre>${escapeHtml(telemetry || "No sync telemetry recorded for this row.")}</pre>
        </details>
        <details class="media-info-telemetry">
          <summary>Stored record fields</summary>
          <pre>${escapeHtml(JSON.stringify(infoRecordPayload(record), null, 2))}</pre>
        </details>
      </div>
    </details>
  `;
}

function mediaInfoMetadataFields(context = {}) {
  const media = context.media || {};
  const metadata = context.tmdbData || {};
  const isTv = context.mediaType === "tv";
  const externalIds = metadata.external_ids || {};
  const providers = metadata["watch/providers"]?.results?.GB?.flatrate
    || metadata["watch/providers"]?.results?.US?.flatrate
    || [];
  const fields = [
    ["TMDB", metadata.id || media.tmdb_id],
    ["IMDb", metadata.imdb_id || externalIds.imdb_id || media.imdb_id],
    ["TVDB", externalIds.tvdb_id || media.tvdb_id],
    ["Local record ID", media.id],
    [isTv ? "First aired" : "Release date", infoDate(metadata.first_air_date || metadata.release_date)],
    ["Status", metadata.status],
    ["Original title", metadata.original_name || metadata.original_title],
    ["Original language", metadata.original_language ? String(metadata.original_language).toUpperCase() : ""],
    ["Runtime", isTv
      ? (metadata.episode_run_time?.[0] ? `${metadata.episode_run_time[0]} min per episode` : "")
      : (metadata.runtime ? `${metadata.runtime} min` : "")],
    ["Genres", (metadata.genres || []).map((genre) => genre.name).filter(Boolean)],
    ["Networks", (metadata.networks || []).map((network) => network.name).filter(Boolean)],
    ["Streaming", providers.map((provider) => provider.provider_name).filter(Boolean)],
    ["Rating", metadata.vote_average ? `${metadata.vote_average}/10` : ""],
    ["Vote count", metadata.vote_count],
    ["Homepage", metadata.homepage],
  ].filter(([, value]) => value != null && value !== "" && (!Array.isArray(value) || value.length));
  return fields.map(([label, value]) => infoField(label, value)).join("");
}

export function closeMediaInfoModal() {
  if (!_mediaInfoOverlay) return;
  if (_mediaInfoKeydown) document.removeEventListener("keydown", _mediaInfoKeydown);
  _mediaInfoOverlay.remove();
  _mediaInfoOverlay = null;
  document.body.style.overflow = _mediaInfoPreviousOverflow;
  _mediaInfoPreviousOverflow = "";
  _mediaInfoKeydown = null;
}

export function openMediaInfoModal() {
  const context = state.activeMediaInfo;
  if (!context) return;
  closeMediaInfoModal();
  const media = context.media || {};
  const metadata = context.tmdbData || {};
  const isTv = context.mediaType === "tv";
  const title = metadata.name || metadata.title || media.title || "Media information";
  const overview = metadata.overview || context.overview || "No synopsis available.";
  const records = infoRecords(context);
  const watchDates = records.map((record) => record.watched_at).filter(Boolean).sort();
  const sources = [...new Set(records.map((record) => platformName(record.source)).filter((source) => source && source !== "Unknown"))];
  const watchedCount = isTv
    ? (context.summary?.watchedCount ?? records.length)
    : (records.length ? 1 : 0);
  const totalCount = isTv ? (context.summary?.totalCount ?? metadata.number_of_episodes ?? media.episode_count) : 1;
  const progress = isTv ? (context.summary?.progressPercent ?? (totalCount ? Math.round((watchedCount / totalCount) * 100) : 0)) : records.length ? 100 : 0;
  const poster = context.posterUrl || media.poster_url || metadata.cached_poster_url || "";
  const infoId = `mediaInfoTitle-${Date.now()}`;
  const recordsBody = records.length
    ? records.map((record, index) => renderInfoWatchRecord(record, context, index)).join("")
    : `<div class="media-info-empty"><strong>No local watch record</strong><span>This page is showing metadata only. A provenance record will appear here after a watched-state entry is saved.</span></div>`;
  const summaryText = isTv
    ? `${watchedCount} of ${infoValue(totalCount, "?")} episodes watched · ${progress}% complete`
    : (records.length ? `Watched · ${infoDate(watchDates.at(-1))}` : "Not watched in Plembfin");

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay media-info-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", infoId);
  overlay.innerHTML = `
    <article class="media-info-panel glass-panel">
      <header class="media-info-head">
        <div class="media-info-title-block">
          ${poster ? `<img class="media-info-poster" src="${escapeAttribute(poster)}" alt="" data-err="hide" />` : ""}
          <div>
            <span class="media-info-eyebrow">${isTv ? "TV show" : "Movie"} · Complete record</span>
            <h2 id="${infoId}">${escapeHtml(title)}</h2>
            <p>${escapeHtml(summaryText)}</p>
          </div>
        </div>
        <button class="button-ghost media-info-close" type="button" data-media-info-close>Close</button>
      </header>
      <div class="media-info-content">
        ${infoSection("At a glance", "State and identity", `
          <div class="media-info-fields">
            ${infoField("Media type", isTv ? "TV show" : "Movie")}
            ${infoField("Watch status", records.length ? "Watched" : "Not watched")}
            ${infoField(isTv ? "Episodes watched" : "Watch records", isTv ? `${watchedCount} of ${infoValue(totalCount, "?")}` : records.length)}
            ${infoField("Completion", `${progress}%`)}
            ${infoField("Source platforms", sources.length ? sources : "Not recorded")}
            ${infoField("Latest watched", infoDate(watchDates.at(-1)))}
            ${infoField("Earliest watched", infoDate(watchDates[0]))}
            ${infoField("Metadata source", context.tmdbData ? "TMDB / Plembfin cache" : "Local record only")}
          </div>
        `)}
        ${infoSection("Metadata and identifiers", "Catalog details", `
          <div class="media-info-fields">${mediaInfoMetadataFields(context) || `<div class="media-info-empty"><span>No enriched metadata is currently available.</span></div>`}</div>
          ${overview ? `<div class="media-info-overview"><span>Synopsis</span><p>${escapeHtml(overview)}</p></div>` : ""}
        `)}
        ${infoSection("Watch history and provenance", "What Plembfin knows about each entry", `<div class="media-info-history-list">${recordsBody}</div>`)}
      </div>
    </article>
  `;
  _mediaInfoPreviousOverflow = document.body.style.overflow;
  _mediaInfoOverlay = overlay;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  const close = () => closeMediaInfoModal();
  overlay.querySelector("[data-media-info-close]")?.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  _mediaInfoKeydown = (event) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", _mediaInfoKeydown);
  overlay.querySelector("[data-media-info-close]")?.focus();
}

export function openDebugModal(entry) {
  if (!entry) return;
  const status = syncStatus(entry);
  const provenance = provenanceForEntry(entry);
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
      ${entry.playHistory && entry.playHistory.length > 1 ? `<div><span>Play history</span><b>${entry.playHistory.map(p => escapeHtml(`${formatDate(p.watched_at)} (${platformName(p.source)})`)).join("<br>")}</b></div>` : ""}
    </section>
    <section class="diagnostic-grid">
      <div><span>Ingest path</span><b>${escapeHtml(provenanceValue(provenance.ingest_path, "Unavailable"))}</b></div>
      <div><span>Source event</span><b>${escapeHtml(provenanceValue(provenance.event))}</b></div>
      <div><span>Source item ID</span><b>${escapeHtml(provenanceValue(provenance.item_id))}</b></div>
      <div><span>Source session ID</span><b>${escapeHtml(provenanceValue(provenance.session_id))}</b></div>
      <div><span>Source user</span><b>${escapeHtml(provenanceValue(provenance.user))}</b></div>
      <div><span>Source timestamp</span><b>${escapeHtml(provenanceValue(provenance.source_timestamp))}</b></div>
      <div><span>Provenance captured</span><b>${escapeHtml(provenanceValue(provenance.captured_at))}</b></div>
      <div><span>Confidence</span><b>${escapeHtml(provenanceValue(provenance.confidence))}</b></div>
      <div style="grid-column: 1 / -1;"><span>Provenance note</span><b>${escapeHtml(provenanceValue(provenance.note))}</b></div>
    </section>
    <section class="telemetry-block">
      <p>Sync dispatch telemetry</p>
      <pre>${escapeHtml(entry.sync_dispatch_telemetry || "No sync telemetry recorded for this row.")}</pre>
    </section>
  `;
}
export function closeDebugModal() {
  closeMediaInfoModal();
  elements.debugModal.classList.add("hidden");
  document.body.style.overflow = "";
  const modalPanel = elements.debugModal.querySelector(".modal-panel");
  if (modalPanel) {
    modalPanel.classList.remove("modal-panel--immersive");
  }
  state.activeShowModalKey = null;
  state.activeShowTmdbId = null;
  state.activeShowTvdbId = null;
  state.activeShowModalTitle = null;
  state.activeShowModalSeason = null;
  state.activeShowModalEpisode = null;
  state.pendingShowHistoryId = "";
  state.activeShowHistoryId = "";
  state.showModalAllSeasonsExpanded = false;
  state.showModalRequestToken += 1;
  state.showModalEpisodes = [];
  state.showModalEpisodeIndex = new Map();
  state.activeShowRenderContext = null;
  state.pendingWatchAction = null;
  state.activeMovieModalId = null;
  state.activeMediaInfo = null;
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
export function mediaDetailLoaderHtml(label = "Loading details") {
  const safeLabel = escapeHtml(label);
  return `
    <div class="media-detail-loader" role="status" aria-live="polite" aria-label="${safeLabel}">
      <span class="media-detail-loader-spinner" aria-hidden="true"></span>
      <span class="media-detail-loader-label">${safeLabel}&hellip;</span>
    </div>
  `;
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
  // Hide the alphabet picker - it should only appear on the bare movie/show explorer.
  elements.alphaFilterNav?.classList.add("hidden");
  syncPageTopbar();
}
export function setMediaDetailActions(html) {
  const el = document.getElementById("mediaDetailActions");
  if (el) el.innerHTML = html || "";
  el?.querySelector("[data-media-info]")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openMediaInfoModal();
  });
  normalizeMediaDetailActions(el);
  syncMediaActionsMenuState();
  syncPageTopbar();
}
export function normalizeMediaDetailActions(el) {
  // No-op: Actions are rendered directly as flat buttons now.
}
export function syncMediaActionsMenuState() {
  const el = document.getElementById("mediaDetailActions");
  if (!el) return;
  const dropdown = el.querySelector(".actions-more-dropdown");
  if (!dropdown) {
    el.classList.remove("actions-collapsed");
    return;
  }
  // <details> hides its non-summary content natively whenever it lacks the
  // `open` attribute, regardless of author CSS display overrides. Force it
  // open while measuring/flattened so the flattened items actually render;
  // only a real "More" button toggles it closed once collapsed.
  dropdown.open = true;
  el.classList.remove("actions-collapsed");
  // #mediaDetailActions right-aligns its content (justify-content: flex-end),
  // so overflow spills off the *start* edge. Browsers don't count start-edge
  // overflow in scrollWidth the way they do trailing overflow, which made
  // this check never fire. Force flex-start just for this synchronous
  // measurement so scrollWidth reflects the real content width.
  const previousJustify = el.style.justifyContent;
  el.style.justifyContent = "flex-start";
  const overflowing = el.scrollWidth > el.clientWidth + 1;
  el.style.justifyContent = previousJustify;
  el.classList.toggle("actions-collapsed", overflowing);
  dropdown.open = !overflowing;
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
  bumpMediaRenderToken();
  closeMediaInfoModal();
  state.activeShowModalKey = null;
  state.activeShowTmdbId = null;
  state.activeShowTvdbId = null;
  state.activeShowModalTitle = null;
  state.activeShowModalSeason = null;
  state.activeShowModalEpisode = null;
  state.showModalAllSeasonsExpanded = false;
  state.showModalRequestToken += 1;
  state.showModalEpisodes = [];
  state.showModalEpisodeIndex = new Map();
  state.activeShowRenderContext = null;
  state.pendingWatchAction = null;
  state.activeMovieModalId = null;
  state.activeMovieTmdbId = null;
  state.activeMediaInfo = null;
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
  state.explorerMode = state.mediaDetailReturnExplorerMode || state.explorerMode || "movies";
  if (state.mediaDetailReturnView && state.mediaDetailReturnView !== "explorer") {
    selectView(state.mediaDetailReturnView);
    return;
  }
  // A detail page owns a real URL, so closing one has to restore the library URL
  // as well. Rendering the grid without navigating left /tvshow/<key> in the
  // address bar, and the topbar (which derives its title and inline-detail state
  // from location.pathname) stayed in detail mode with the library controls hidden.
  navigateTo(state.explorerMode === "shows" ? "/tvshows" : "/movies");
}
