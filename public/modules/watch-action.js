import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, formatDate, toDateInputValue, toDateTimeInputValue, episodeCode, seasonLabel, formatTmdbDate, showEpisodeKey } from "./utils.js";
import { buildAuthHeaders } from "./auth.js";
import { isWatchedHistoryAction } from "./sync.js";
import { mergeShowDetail } from "./explorer.js";
import { resetPartWatchedView, renderPartWatched } from "./dashboard.js";

// Callbacks injected by app.js at startup to break circular-import chains.
let _setMessage = () => {};
let _openConfirmDialog = async () => false;
let _clearDerivedUiCaches = () => {};
let _loadHistory = async () => {};
let _closeMediaDetail = () => {};
let _showErrorExplainModal = () => {};
let _fetchSeerrMediaStatus = async () => null;
let _refreshActiveMediaDetailAfterSeerrStatus = () => {};
let _renderImmersiveShowModal = async () => {};
let _openShowImmersiveModalByTmdbId = async () => {};
let _openMovieImmersiveModalByTmdbId = async () => {};

export function initWatchAction(callbacks) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.openConfirmDialog) _openConfirmDialog = callbacks.openConfirmDialog;
  if (callbacks.clearDerivedUiCaches) _clearDerivedUiCaches = callbacks.clearDerivedUiCaches;
  if (callbacks.loadHistory) _loadHistory = callbacks.loadHistory;
  if (callbacks.closeMediaDetail) _closeMediaDetail = callbacks.closeMediaDetail;
  if (callbacks.showErrorExplainModal) _showErrorExplainModal = callbacks.showErrorExplainModal;
  if (callbacks.fetchSeerrMediaStatus) _fetchSeerrMediaStatus = callbacks.fetchSeerrMediaStatus;
  if (callbacks.refreshActiveMediaDetailAfterSeerrStatus) _refreshActiveMediaDetailAfterSeerrStatus = callbacks.refreshActiveMediaDetailAfterSeerrStatus;
  if (callbacks.renderImmersiveShowModal) _renderImmersiveShowModal = callbacks.renderImmersiveShowModal;
  if (callbacks.openShowImmersiveModalByTmdbId) _openShowImmersiveModalByTmdbId = callbacks.openShowImmersiveModalByTmdbId;
  if (callbacks.openMovieImmersiveModalByTmdbId) _openMovieImmersiveModalByTmdbId = callbacks.openMovieImmersiveModalByTmdbId;
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

function mediaDetailRoot() {
  if (state.mediaDetailInline) return elements.explorerPanel;
  if (state.activeView === "dashboard") return document.body;
  return elements.modalBody;
}

const IMPORT_BATCH_SIZE = 100;

// ── Watch-date prompt render ───────────────────────────────────────────────

function renderMovieWatchDatePrompt(action, customValue) {
  const movie = action.movie || {};
  const releaseLabel = movie.releaseDate ? formatTmdbDate(movie.releaseDate) : "Unknown release date";
  const lastPlayedLabel = action.lastPlayedAt ? formatDate(action.lastPlayedAt) : "";
  return `
    <div class="watch-date-overlay" role="dialog" aria-modal="true" aria-label="Choose watched date">
      <div class="watch-date-dialog">
        <div class="watch-date-head">
          <div class="watch-date-head-text">
            <h3>${escapeHtml(action.label)}</h3>
            <p class="watch-date-sub">${escapeHtml(movie.title || "Movie")} &middot; Movie</p>
          </div>
          <button class="watch-date-close" type="button" data-watch-date-cancel="true" aria-label="Cancel">&times;</button>
        </div>

        <p class="watch-date-intro">Logs this movie to your watch history and marks it played on Plex, Emby, and Jellyfin. Pick which date to record.</p>

        <div class="watch-date-section-label">Watched date</div>
        <div class="watch-date-options">
          <button class="watch-date-pick" type="button" data-watch-date-choice="release"${movie.releaseDate ? "" : " disabled"}>
            <span class="watch-date-pick-title">Day of release</span>
            <span class="watch-date-pick-sub">${escapeHtml(releaseLabel)}</span>
          </button>
          <button class="watch-date-pick" type="button" data-watch-date-choice="now">
            <span class="watch-date-pick-title">Now</span>
            <span class="watch-date-pick-sub">Today, ${escapeHtml(formatTmdbDate(customValue))}</span>
          </button>
          ${lastPlayedLabel ? `
          <button class="watch-date-pick" type="button" data-watch-date-choice="last_played">
            <span class="watch-date-pick-title">Last played</span>
            <span class="watch-date-pick-sub">${escapeHtml(lastPlayedLabel)}</span>
          </button>
          ` : ""}
        </div>

        ${watchDateCustomCardHtml()}
      </div>
    </div>
  `;
}

// ── Custom date+time picker ────────────────────────────────────────────────

const WD_WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function initWatchDateCustomState() {
  const now = new Date();
  now.setSeconds(0, 0);
  state.watchDateCustom = { year: now.getFullYear(), month: now.getMonth(), selected: now };
  return state.watchDateCustom;
}

function formatCustomDisplay(date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(date);
}

// Pull the hour/minute <select> values back into the selected Date before
// re-rendering or reading the final value.
function syncCustomTimeFromSelects() {
  const wd = state.watchDateCustom;
  if (!wd?.selected) return;
  const root = mediaDetailRoot();
  const hourEl = root.querySelector("[data-wd-hour]");
  const minuteEl = root.querySelector("[data-wd-minute]");
  if (hourEl) wd.selected.setHours(Number(hourEl.value));
  if (minuteEl) wd.selected.setMinutes(Number(minuteEl.value));
  wd.selected.setSeconds(0, 0);
}

function getCustomWatchDateValue() {
  if (!state.watchDateCustom?.selected) return toDateTimeInputValue(new Date());
  syncCustomTimeFromSelects();
  return toDateTimeInputValue(state.watchDateCustom.selected);
}

export function renderWatchDateCustomPicker() {
  const wd = state.watchDateCustom || initWatchDateCustomState();
  const sel = wd.selected;
  const now = new Date();
  const todayStr = toDateInputValue(now);
  const selStr = toDateInputValue(sel);

  const viewDate = new Date(wd.year, wd.month, 1);
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(viewDate);
  const firstDow = (viewDate.getDay() + 6) % 7;
  const daysInMonth = new Date(wd.year, wd.month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstDow; i += 1) cells.push(`<span class="wd-cell wd-empty"></span>`);
  for (let d = 1; d <= daysInMonth; d += 1) {
    const dateStr = `${wd.year}-${String(wd.month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const classes = ["wd-cell", "wd-day"];
    if (dateStr === selStr) classes.push("is-selected");
    if (dateStr === todayStr) classes.push("is-today");
    const future = dateStr > todayStr;
    cells.push(`<button type="button" class="${classes.join(" ")}" data-wd-day="${dateStr}"${future ? " disabled" : ""}>${d}</button>`);
  }

  const atCurrentMonth = wd.year > now.getFullYear() || (wd.year === now.getFullYear() && wd.month >= now.getMonth());
  const dowHtml = WD_WEEKDAYS.map((d) => `<span class="wd-dow">${d}</span>`).join("");
  const hoursHtml = Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}"${h === sel.getHours() ? " selected" : ""}>${String(h).padStart(2, "0")}</option>`).join("");
  const minutesHtml = Array.from({ length: 60 }, (_, m) =>
    `<option value="${m}"${m === sel.getMinutes() ? " selected" : ""}>${String(m).padStart(2, "0")}</option>`).join("");

  return `
    <div class="wd-display">${escapeHtml(formatCustomDisplay(sel))}</div>
    <div class="wd-body">
      <div class="wd-calendar">
        <div class="wd-cal-head">
          <button type="button" class="wd-nav" data-wd-nav="prev" aria-label="Previous month">&#8249;</button>
          <span class="wd-month">${escapeHtml(monthLabel)}</span>
          <button type="button" class="wd-nav" data-wd-nav="next" aria-label="Next month"${atCurrentMonth ? " disabled" : ""}>&#8250;</button>
        </div>
        <div class="wd-grid wd-dow-row">${dowHtml}</div>
        <div class="wd-grid wd-day-grid">${cells.join("")}</div>
      </div>
      <div class="wd-time">
        <span class="wd-time-label">Time</span>
        <div class="wd-time-selects">
          <select class="wd-select" data-wd-hour aria-label="Hour">${hoursHtml}</select>
          <span class="wd-colon">:</span>
          <select class="wd-select" data-wd-minute aria-label="Minute">${minutesHtml}</select>
        </div>
      </div>
    </div>
    <button class="button-primary wd-use" type="button" data-watch-date-choice="custom">Use this date &amp; time</button>
  `;
}

export function watchDateCustomCardHtml() {
  return `
    <div class="watch-date-custom">
      <div class="watch-date-section-label">Or pick a specific date &amp; time</div>
      <div class="watch-date-picker" data-watch-date-picker>${renderWatchDateCustomPicker()}</div>
    </div>
  `;
}

export function rerenderWatchDateCustomPicker() {
  const host = mediaDetailRoot().querySelector("[data-watch-date-picker]");
  if (host) host.innerHTML = renderWatchDateCustomPicker();
}

// Keeps the human-readable display line in sync when selects change.
export function wireWatchDateCustomPicker(root) {
  const host = root.querySelector("[data-watch-date-picker]");
  if (!host) return;
  host.addEventListener("change", (event) => {
    if (!event.target.matches("[data-wd-hour], [data-wd-minute]")) return;
    syncCustomTimeFromSelects();
    const display = host.querySelector(".wd-display");
    if (display && state.watchDateCustom?.selected) {
      display.textContent = formatCustomDisplay(state.watchDateCustom.selected);
    }
  });
}

export function renderWatchDatePrompt(action) {
  if (!action) return "";
  const customValue = new Date().toISOString().slice(0, 10);
  if (action.scope === "movie") return renderMovieWatchDatePrompt(action, customValue);
  const episodeCount = action.episodes.length;
  const them = episodeCount === 1 ? "this episode" : "these episodes";
  const hasAirDate = action.episodes.some((episode) => episode.airDate);
  const lastPlayedLabel = action.lastPlayedAt ? formatDate(action.lastPlayedAt) : "";
  const episodesHtml = action.episodes
    .map((episode) => `
      <li class="watch-date-episode">
        <span class="watch-date-episode-code">${escapeHtml(episodeCode(episode.seasonNumber, episode.episodeNumber))}</span>
        <span class="watch-date-episode-title">${escapeHtml(episode.title || "Untitled episode")}</span>
        <span class="watch-date-episode-air">${episode.airDate ? escapeHtml(formatTmdbDate(episode.airDate)) : "Air date TBA"}</span>
      </li>
    `)
    .join("");

  return `
    <div class="watch-date-overlay" role="dialog" aria-modal="true" aria-label="Choose watched date">
      <div class="watch-date-dialog">
        <div class="watch-date-head">
          <div class="watch-date-head-text">
            <h3>${escapeHtml(action.label)}</h3>
            <p class="watch-date-sub">${escapeHtml(action.showTitle)} &middot; ${escapeHtml(action.countLabel)}</p>
          </div>
          <button class="watch-date-close" type="button" data-watch-date-cancel="true" aria-label="Cancel">&times;</button>
        </div>

        <p class="watch-date-intro">Logs ${escapeHtml(them)} to your watch history and marks ${episodeCount === 1 ? "it" : "them"} played on Plex, Emby, and Jellyfin. Pick which date to record.</p>

        <div class="watch-date-episodes">
          <div class="watch-date-episodes-head">
            <span>${episodeCount === 1 ? "Episode" : "Episodes"}</span>
            <span>${episodeCount}</span>
          </div>
          <ul class="watch-date-episode-list">${episodesHtml}</ul>
        </div>

        <div class="watch-date-section-label">Watched date</div>
        <div class="watch-date-options">
          <button class="watch-date-pick" type="button" data-watch-date-choice="release"${hasAirDate ? "" : " disabled"}>
            <span class="watch-date-pick-title">Day of release</span>
            <span class="watch-date-pick-sub">Use each episode's air date</span>
          </button>
          <button class="watch-date-pick" type="button" data-watch-date-choice="now">
            <span class="watch-date-pick-title">Now</span>
            <span class="watch-date-pick-sub">Today, ${escapeHtml(formatTmdbDate(customValue))}</span>
          </button>
          ${lastPlayedLabel ? `
          <button class="watch-date-pick" type="button" data-watch-date-choice="last_played">
            <span class="watch-date-pick-title">Last played</span>
            <span class="watch-date-pick-sub">${escapeHtml(lastPlayedLabel)}</span>
          </button>
          ` : ""}
        </div>

        ${watchDateCustomCardHtml()}
      </div>
    </div>
  `;
}

// ── Watch date prompt open/close ───────────────────────────────────────────

export function watchActionFromButton(button) {
  const scope = button?.dataset.watchScope;
  if (!scope) return null;

  let episodes = [];
  if (scope === "episode") {
    const episode = state.showModalEpisodeIndex.get(button.dataset.episodeKey);
    if (episode && !episode.watched) episodes = [episode];
  } else if (scope === "season") {
    const seasonNumber = Number(button.dataset.seasonNumber);
    episodes = state.showModalEpisodes.filter((episode) => episode.seasonNumber === seasonNumber && !episode.watched);
  } else if (scope === "show") {
    episodes = state.showModalEpisodes.filter((episode) => !episode.watched);
  }

  if (!episodes.length) return null;

  const showTitle = episodes[0]?.showTitle || "Show";
  const label = scope === "episode"
    ? `Mark ${episodeCode(episodes[0].seasonNumber, episodes[0].episodeNumber)} watched`
    : scope === "season"
      ? `Mark ${showTitle} ${seasonLabel(episodes[0].seasonNumber)} watched`
      : `Mark ${showTitle} watched`;

  return {
    scope,
    showTitle,
    showTmdbId: episodes[0]?.showTmdbId || "",
    episodes,
    label,
    countLabel: `${episodes.length} episode${episodes.length === 1 ? "" : "s"}`,
  };
}

export function openWatchDatePrompt(action) {
  if (!action) {
    _setMessage("There are no unwatched episodes in that selection.");
    return;
  }
  state.pendingWatchAction = action;
  initWatchDateCustomState();
  const root = mediaDetailRoot();
  root.querySelector(".watch-date-overlay")?.remove();
  root.insertAdjacentHTML("beforeend", renderWatchDatePrompt(action));
  wireWatchDateCustomPicker(root);
}

export function closeWatchDatePrompt() {
  state.pendingWatchAction = null;
  mediaDetailRoot().querySelector(".watch-date-overlay")?.remove();
}

// ── Date/time helpers ──────────────────────────────────────────────────────

export function dateAtMiddayIso(dateString) {
  if (!dateString) return new Date().toISOString();
  const date = new Date(`${dateString}T12:00:00`);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

// Converts custom picker value to an ISO timestamp.
function customWatchedAtIso(value) {
  if (!value) return new Date().toISOString();
  if (value.includes("T")) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }
  return dateAtMiddayIso(value);
}

function watchedAtForChoice(choice, episode, customDate) {
  if (choice === "release") return dateAtMiddayIso(episode.airDate);
  if (choice === "last_played") {
    const value = Number(episode.lastPlayedAt || 0);
    if (Number.isFinite(value) && value > 0) return new Date(value).toISOString();
  }
  if (choice === "custom") return customWatchedAtIso(customDate);
  return new Date().toISOString();
}

// ── Watch record builders ──────────────────────────────────────────────────

function watchRecordFromEpisode(episode, watchedAt) {
  return {
    media_type: "episode",
    title: `${episode.showTitle} - ${episodeCode(episode.seasonNumber, episode.episodeNumber)} - ${episode.title}`,
    watched_at: watchedAt,
    source: "manual",
    tmdb_id: episode.showTmdbId || null,
    season: episode.seasonNumber,
    episode: episode.episodeNumber,
    poster_url: episode.posterUrl || episode.stillUrl || null,
  };
}

function watchRecordFromMovie(movie, watchedAt) {
  return {
    media_type: "movie",
    title: movie.title,
    watched_at: watchedAt,
    source: "manual",
    tmdb_id: movie.tmdbId || null,
    poster_url: movie.posterUrl || null,
  };
}

// ── Seerr request ──────────────────────────────────────────────────────────

export async function submitSeerrRequest(mediaType, mediaId, button) {
  if (!mediaId || !mediaType) {
    _setMessage("Cannot send Seerr request — missing media info.", "error");
    return;
  }
  const is4k = button?.getAttribute("data-seerr-request-4k") === "true";
  const seasonNumber = Number(button?.getAttribute("data-seerr-season") || 0);
  const seasonsJson = button?.getAttribute("data-seerr-seasons");
  const seasonsArray = seasonsJson ? JSON.parse(seasonsJson).filter((s) => Number.isInteger(s) && s > 0) : [];
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "Requesting…";
  }
  try {
    const tvSeasons = mediaType === "tv"
      ? seasonNumber > 0
        ? [seasonNumber]
        : seasonsArray.length > 0 ? seasonsArray : undefined
      : undefined;
    const res = await fetch("/api/seerr/request", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        mediaType,
        mediaId,
        is4k,
        ...(tvSeasons ? { seasons: tvSeasons } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      _setMessage(`✔ ${is4k ? "4K request" : "Request"} submitted to Seerr!`, "success");
      if (button) button.textContent = "✔ Requested";
      state.seerrMediaStatusCache.delete(`${mediaType}:${mediaId}`);
      _fetchSeerrMediaStatus(mediaType, mediaId)
        .then((status) => {
          if (!status) return;
          if (mediaType === "tv" && state.activeShowModalKey) {
            _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason, state.activeShowModalEpisode);
            return;
          }
          _refreshActiveMediaDetailAfterSeerrStatus(mediaType, mediaId);
        });
    } else {
      const errMsg = data.error || `Seerr returned ${res.status}`;
      _setMessage(`Seerr error: ${errMsg}`, "error");
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  } catch (err) {
    _setMessage(`Seerr request failed: ${err.message}`, "error");
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

// ── Mark watched ───────────────────────────────────────────────────────────

export function markMovieWatched(movie) {
  if (!movie?.title) {
    _setMessage("Cannot mark this movie watched — missing details.", "error");
    return;
  }
  openWatchDatePrompt({
    scope: "movie",
    movie,
    label: `Mark ${movie.title} watched`,
    showTitle: movie.title,
    countLabel: "1 movie",
  });
}

export async function postManualWatchRecords(records, onProgress) {
  let inserted = 0;
  let skipped = 0;
  let rejected = 0;
  let propagated = 0;
  let syncQueued = 0;

  for (let index = 0; index < records.length; index += IMPORT_BATCH_SIZE) {
    const batch = records.slice(index, index + IMPORT_BATCH_SIZE);
    const response = await fetch("/api/manual-watch", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ records: batch }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Manual watch update failed with ${response.status}`);
    inserted += Number(body.inserted || 0);
    skipped += Number(body.skipped || 0);
    rejected += Array.isArray(body.rejected) ? body.rejected.length : Number(body.rejected || 0);
    propagated += Number(body.propagated || 0);
    syncQueued += Number(body.syncQueued || 0);
    onProgress?.(Math.min(index + batch.length, records.length), records.length);
  }

  return { inserted, skipped, rejected, propagated, syncQueued };
}

export async function refreshShowAfterManualWatch(showTitle) {
  const url = new URL("/api/show", window.location.origin);
  url.searchParams.set("title", showTitle);
  const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.show) return;
  mergeShowDetail(body.show);
}

async function applyMovieWatchDateChoice(choice) {
  const action = state.pendingWatchAction;
  const movie = action?.movie;
  if (!movie) return;

  const root = mediaDetailRoot();
  const customDate = getCustomWatchDateValue();
  const watchedAt = watchedAtForChoice(choice, { airDate: movie.releaseDate }, customDate);
  const record = watchRecordFromMovie(movie, watchedAt);

  root.querySelectorAll("[data-watch-date-choice], [data-watch-date-cancel]").forEach((button) => {
    button.disabled = true;
  });

  state.savingWatchAction = action;
  closeWatchDatePrompt();

  const markWatchedBtn = root.querySelector("[data-movie-mark-watched]");
  if (markWatchedBtn) {
    markWatchedBtn.disabled = true;
    markWatchedBtn.textContent = "Saving watched state…";
  }

  _setMessage(`Saving "${movie.title}" to your watch history…`, "muted");

  try {
    const result = await postManualWatchRecords([record]);
    state.savingWatchAction = null;
    _clearDerivedUiCaches({ resetExplorer: false });
    const syncText = result.syncQueued
      ? `sync queued for ${result.syncQueued} item${result.syncQueued === 1 ? "" : "s"}`
      : `pushed ${result.propagated} to media apps`;
    _setMessage(
      `Marked "${movie.title}" watched${result.skipped ? " (already logged)" : ""}; ${syncText}.`,
      result.rejected ? "error" : "success",
    );
    await _loadHistory({ force: true }).catch(() => null);
    if (movie.tmdbId) await _openMovieImmersiveModalByTmdbId(movie.tmdbId);
  } catch (error) {
    state.savingWatchAction = null;
    if (movie.tmdbId) await _openMovieImmersiveModalByTmdbId(movie.tmdbId).catch(() => null);
    _setMessage(`Manual watch update failed: ${error.message}`, "error");
    throw error;
  }
}

function localWatchRowFromEpisode(episode, watchedAt) {
  return {
    id: `local-${episode.key}-${Date.now()}`,
    media_type: "episode",
    title: `${episode.showTitle} - ${episodeCode(episode.seasonNumber, episode.episodeNumber)} - ${episode.title}`,
    watched_at: watchedAt,
    source: "manual",
    tmdb_id: episode.showTmdbId || null,
    season: episode.seasonNumber,
    episode: episode.episodeNumber,
    poster_url: episode.posterUrl || episode.stillUrl || null,
    show_title: episode.showTitle,
  };
}

function cloneShowRecord(show) {
  return show ? JSON.parse(JSON.stringify(show)) : null;
}

function applyOptimisticWatchedEpisodes(action, watchedRows) {
  const showKey = action.showTitle ? action.showTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "";
  let index = state.showsRaw.findIndex((show) => {
    const t = (show.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return t === showKey;
  });
  const created = index < 0;
  if (created) {
    state.showsRaw.push({
      title: action.showTitle,
      tmdb_id: action.showTmdbId || null,
      episodes: [],
      episode_count: 0,
      season_count: 0,
    });
    index = state.showsRaw.length - 1;
  }

  const previousShow = cloneShowRecord(state.showsRaw[index]);
  const show = cloneShowRecord(state.showsRaw[index]);
  const watchedByKey = new Map(watchedRows.map((row) => [showEpisodeKey(row.season, row.episode), row]));
  const existing = (show.episodes || []).filter((row) => !watchedByKey.has(showEpisodeKey(row.season, row.episode)));
  show.episodes = [...existing, ...watchedRows].sort((a, b) => Number(a.season || 0) - Number(b.season || 0) || Number(a.episode || 0) - Number(b.episode || 0));
  show.episode_count = show.episodes.length;
  show.season_count = new Set(show.episodes.map((episode) => Number(episode.season || 0)).filter(Boolean)).size;
  show.latest_watched_at = show.episodes.reduce((latest, episode) => episode.watched_at > latest ? episode.watched_at : latest, show.latest_watched_at || "");
  show.earliest_watched_at = show.episodes.reduce((earliest, episode) => !earliest || episode.watched_at < earliest ? episode.watched_at : earliest, show.earliest_watched_at || "");
  state.showsRaw[index] = show;

  for (const modalEpisode of state.showModalEpisodes) {
    const watched = watchedByKey.get(showEpisodeKey(modalEpisode.seasonNumber, modalEpisode.episodeNumber));
    if (watched) modalEpisode.watched = watched;
  }
  state.showModalEpisodeIndex = new Map(state.showModalEpisodes.map((episode) => [episode.key, episode]));
  return { showKey, previousShow, created };
}

function rollbackOptimisticWatchedEpisodes(rollback) {
  if (!rollback?.showKey) return;
  const index = state.showsRaw.findIndex((show) => {
    const t = (show.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return t === rollback.showKey;
  });
  if (rollback?.created) {
    if (index >= 0) state.showsRaw.splice(index, 1);
    return;
  }
  if (index >= 0 && rollback?.previousShow) state.showsRaw[index] = rollback.previousShow;
}

async function applyPartWatchedWatchDateChoice(choice) {
  const action = state.pendingWatchAction;
  if (!action) return;

  const root = mediaDetailRoot();
  const customDate = getCustomWatchDateValue();

  const episode = action.episodes?.[0] || {};
  const airDate = action.scope === "movie" ? action.movie?.releaseDate : episode.airDate;
  const watchedAt = watchedAtForChoice(choice, { airDate, lastPlayedAt: action.lastPlayedAt }, customDate);
  const ids = action.scope === "movie"
    ? {
        tmdb_id: action.movie?.tmdbId || null,
        imdb_id: action.movie?.imdbId || null,
        tvdb_id: action.movie?.tvdbId || null,
      }
    : {
        tmdb_id: episode.showTmdbId || null,
        imdb_id: episode.imdbId || null,
        tvdb_id: episode.tvdbId || null,
      };

  root.querySelectorAll("[data-watch-date-choice], [data-watch-date-cancel]").forEach((button) => {
    button.disabled = true;
  });

  closeWatchDatePrompt();
  _setMessage(`Marking "${action.title}" as watched…`, "muted");

  try {
    const res = await fetch("/api/playback-progress/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ media_key: action.mediaKey, watched_at: watchedAt, ...ids }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    _setMessage(`"${action.title}" marked as watched`, "success");
    resetPartWatchedView("default");
    renderPartWatched();
  } catch (error) {
    _showErrorExplainModal(`Failed to mark "${action.title}" as watched`, error.message);
  }
}

export async function applyWatchDateChoice(choice) {
  const action = state.pendingWatchAction;
  if (action?.origin === "part-watched") return applyPartWatchedWatchDateChoice(choice);
  if (action?.scope === "movie") return applyMovieWatchDateChoice(choice);
  if (!action?.episodes?.length) return;

  const root = mediaDetailRoot();
  const customDate = getCustomWatchDateValue();
  const watchedRows = action.episodes.map((episode) => localWatchRowFromEpisode(episode, watchedAtForChoice(choice, episode, customDate)));
  const records = action.episodes.map((episode, index) => watchRecordFromEpisode(episode, watchedRows[index].watched_at));
  const buttons = [...root.querySelectorAll("[data-watch-date-choice], [data-watch-date-cancel]")];
  buttons.forEach((button) => {
    button.disabled = true;
  });

  state.savingWatchAction = action;
  closeWatchDatePrompt();
  const rollback = applyOptimisticWatchedEpisodes(action, watchedRows);
  if (state.activeShowModalKey) {
    _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
  } else if (state.activeShowTmdbId) {
    await _openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
  }

  const total = records.length;
  _setMessage(total > 1 ? `Saving ${total} episodes to your watch history… 0/${total}` : "Saving to your watch history…", "muted");

  try {
    const result = await postManualWatchRecords(records, (done, all) => {
      if (all > 1) _setMessage(`Saving ${all} episodes to your watch history… ${done}/${all}`, "muted");
    });
    state.savingWatchAction = null;
    _clearDerivedUiCaches({ resetExplorer: false });
    const totalMarked = result.inserted + result.skipped;
    const syncText = result.syncQueued
      ? `sync queued for ${result.syncQueued} item${result.syncQueued === 1 ? "" : "s"}`
      : `pushed ${result.propagated} to media apps`;
    _setMessage(
      `Marked ${totalMarked} episode${totalMarked === 1 ? "" : "s"} watched; ${syncText}${result.skipped ? `, ${result.skipped} already logged` : ""}.`,
      result.rejected ? "error" : "success",
    );
    await refreshShowAfterManualWatch(action.showTitle).catch((error) => _setMessage(error.message, "error"));
    if (state.activeShowModalKey) {
      _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
    } else if (state.activeShowTmdbId) {
      await _openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
    }
  } catch (error) {
    state.savingWatchAction = null;
    rollbackOptimisticWatchedEpisodes(rollback);
    if (state.activeShowModalKey) {
      _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
    } else if (state.activeShowTmdbId) {
      await _openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
    }
    _setMessage(`Manual watch update failed: ${error.message}`, "error");
    throw error;
  }
}

// ── Confirm dialogs ────────────────────────────────────────────────────────

export async function confirmAndMarkUnwatched(button) {
  const id = button.dataset.unwatchId;
  if (!id) return;
  const kind = button.dataset.unwatchKind || "item";
  const label = button.dataset.unwatchLabel || "this item";
  const showTitle = button.dataset.showTitle || "";

  const confirmed = await _openConfirmDialog({
    title: "Mark unwatched",
    body: `Remove "${label}" from your watch history and mark it unplayed on Plex, Emby, and Jellyfin?`,
    confirmLabel: "Mark unwatched",
    danger: true,
  });
  if (!confirmed) return;

  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Removing…";

  try {
    const response = await fetch("/api/manual-unwatch", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Mark unwatched failed (${response.status})`);

    _clearDerivedUiCaches({ resetExplorer: kind === "movie" });
    _setMessage(`Marked "${label}" unwatched; pushed unplayed to media apps.`, "success");

    if (kind === "episode" && (state.activeShowModalKey || state.activeShowTmdbId)) {
      if (showTitle) await refreshShowAfterManualWatch(showTitle).catch(() => null);
      await _loadHistory().catch(() => null);
      if (state.activeShowModalKey) {
        _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
      } else {
        await _openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
      }
    } else {
      await _loadHistory().catch(() => null);
      _closeMediaDetail();
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = originalText;
    _setMessage(`Mark unwatched failed: ${error.message}`, "error");
  }
}

// Permanently delete a library item — requires three explicit confirmations.
export async function confirmAndDeleteMedia(button) {
  const id = button.dataset.deleteMediaId;
  if (!id) return;
  const label = button.dataset.deleteMediaTitle || "this item";

  const first = await _openConfirmDialog({
    title: "Delete from library?",
    body: `This permanently deletes "${label}" and its entire watch history from Plembfin. This does NOT affect Plex, Emby or Jellyfin — it only removes the local record.`,
    confirmLabel: "Continue",
    cancelLabel: "Keep it",
    danger: true,
  });
  if (!first) return;

  const second = await _openConfirmDialog({
    title: "This cannot be undone",
    body: `There is no recoverable history. Every play date, sync record and progress entry for "${label}" will be erased and cannot be restored. Are you absolutely sure?`,
    confirmLabel: "Yes, I understand",
    cancelLabel: "Cancel",
    danger: true,
  });
  if (!second) return;

  const third = await _openConfirmDialog({
    title: "Final confirmation",
    body: `Last chance — permanently delete "${label}" now?`,
    confirmLabel: "Delete permanently",
    cancelLabel: "Cancel",
    danger: true,
  });
  if (!third) return;

  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Deleting…";

  try {
    const response = await fetch("/api/delete-media", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id, confirm: "DELETE" }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Delete failed (${response.status})`);

    _clearDerivedUiCaches({ resetExplorer: true });
    _setMessage(`Deleted "${label}" and its history (${result.deleted || 0} record${result.deleted === 1 ? "" : "s"}).`, "success");
    await _loadHistory().catch(() => null);
    _closeMediaDetail();
  } catch (error) {
    button.disabled = false;
    button.textContent = originalText;
    _setMessage(`Delete failed: ${error.message}`, "error");
  }
}
