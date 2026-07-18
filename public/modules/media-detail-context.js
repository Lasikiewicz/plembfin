import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml, platformName, formatDate } from "./utils.js";
import { historyAction, syncStatus } from "./sync.js";
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
// If you change one side of this handshake, check the other file too —
// grep both files for `bumpMediaRenderToken` and `showModalRequestToken`.
export function bumpMediaRenderToken() {
  return ++_mediaRenderToken;
}
export function currentMediaRenderToken() {
  return _mediaRenderToken;
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
  state.showModalAllSeasonsExpanded = false;
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
  // Hide the alphabet picker — it should only appear on the bare movie/show explorer.
  elements.alphaFilterNav?.classList.add("hidden");
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
  state.activeShowModalKey = null;
  state.activeShowTmdbId = null;
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
