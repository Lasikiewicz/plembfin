import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, formatDate, toDateTimeInputValue, episodeCode, seasonLabel, formatSeasonTitle, formatTmdbDate, showEpisodeKey } from "./utils.js";
import { buildAuthHeaders } from "./auth.js";
import { isWatchedHistoryAction } from "./sync.js";
import { mergeShowDetail } from "./explorer.js?v=20260903m";
import { dedupeMediaRecords, resetPartWatchedView, renderPartWatched } from "./dashboard.js?v=20260903b";
import { tvSeasonAvailability } from "./media-detail-shared.js";
import { calendarStateFromIso, mountCalendarPicker } from "./calendar-picker.js";
import { fetchTmdbDetails, fetchTmdbSeasonDetails } from "./tmdb.js?v=20260823";
import { tmdbPoster } from "./images.js?v=20260903b";

// Callbacks injected by app.js at startup to break circular-import chains.
let _setMessage = () => {};
let _openConfirmDialog = async () => false;
let _clearDerivedUiCaches = () => {};
let _loadHistory = async () => {};
let _closeMediaDetail = () => {};
let _renderActiveView = () => {};
let _showErrorExplainModal = () => {};
let _fetchSeerrMediaStatus = async () => null;
let _refreshActiveMediaDetailAfterSeerrStatus = () => {};
let _renderImmersiveShowModal = async () => {};
let _renderShowModalContent = () => {};
let _openShowImmersiveModalByTmdbId = async () => {};
let _openShowImmersiveModalByTvdbId = async () => {};
let _openMovieImmersiveModalByTmdbId = async () => {};
let _patchMovieWatchedState = () => false;

export function initWatchAction(callbacks) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.openConfirmDialog) _openConfirmDialog = callbacks.openConfirmDialog;
  if (callbacks.clearDerivedUiCaches) _clearDerivedUiCaches = callbacks.clearDerivedUiCaches;
  if (callbacks.loadHistory) _loadHistory = callbacks.loadHistory;
  if (callbacks.closeMediaDetail) _closeMediaDetail = callbacks.closeMediaDetail;
  if (callbacks.renderActiveView) _renderActiveView = callbacks.renderActiveView;
  if (callbacks.showErrorExplainModal) _showErrorExplainModal = callbacks.showErrorExplainModal;
  if (callbacks.fetchSeerrMediaStatus) _fetchSeerrMediaStatus = callbacks.fetchSeerrMediaStatus;
  if (callbacks.refreshActiveMediaDetailAfterSeerrStatus) _refreshActiveMediaDetailAfterSeerrStatus = callbacks.refreshActiveMediaDetailAfterSeerrStatus;
  if (callbacks.renderImmersiveShowModal) _renderImmersiveShowModal = callbacks.renderImmersiveShowModal;
  if (callbacks.renderShowModalContent) _renderShowModalContent = callbacks.renderShowModalContent;
  if (callbacks.openShowImmersiveModalByTmdbId) _openShowImmersiveModalByTmdbId = callbacks.openShowImmersiveModalByTmdbId;
  if (callbacks.openShowImmersiveModalByTvdbId) _openShowImmersiveModalByTvdbId = callbacks.openShowImmersiveModalByTvdbId;
  if (callbacks.openMovieImmersiveModalByTmdbId) _openMovieImmersiveModalByTmdbId = callbacks.openMovieImmersiveModalByTmdbId;
  if (callbacks.patchMovieWatchedState) _patchMovieWatchedState = callbacks.patchMovieWatchedState;
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
// Uses the shared calendar-picker.js component (see edit-dialogs.js for the
// other pickers built on it) so every date/time picker in the app looks and
// behaves identically. state.watchDateCustom holds the one pickerState for
// whichever "mark watched" prompt is currently open - only one can be open
// at a time, so a single shared instance is intentional here (unlike the
// edit-date dialog's per-row instances).

function getCustomWatchDateValue() {
  if (!state.watchDateCustom?.selected) return toDateTimeInputValue(new Date());
  return toDateTimeInputValue(state.watchDateCustom.selected);
}

export function watchDateCustomCardHtml() {
  return `
    <div class="watch-date-custom">
      <div class="watch-date-section-label">Or pick a specific date &amp; time</div>
      <div class="watch-date-picker" data-watch-date-picker></div>
    </div>
  `;
}

// Mounts the shared calendar picker into the card rendered by
// watchDateCustomCardHtml(). Must be called after that HTML is in the DOM.
export function mountWatchDateCustomPicker() {
  const host = document.querySelector("[data-watch-date-picker]");
  if (!host) return;
  state.watchDateCustom = calendarStateFromIso(new Date().toISOString());
  mountCalendarPicker(host, state.watchDateCustom, {
    showCancel: false,
    onConfirm: () => {
      applyWatchDateChoice("custom").catch((error) => _setMessage(error.message, "error"));
    },
  });
}

export function renderWatchDatePrompt(action) {
  if (!action) return "";
  const customValue = new Date().toISOString().slice(0, 10);
  if (action.scope === "movie") return renderMovieWatchDatePrompt(action, customValue);
  const referenceTitle = action.referenceDirection === "after_last"
    ? "After last episode"
    : action.referenceDirection === "before_next"
      ? "Before next episode"
      : "Same as other episodes";
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

        ${action.scope === "show" && action.hasSpecials ? `
        <label class="watch-date-specials-toggle">
          <input type="checkbox" data-watch-date-include-specials ${action.includeSpecials ? "checked" : ""} />
          <span>Include specials (Season 0)</span>
        </label>
        ` : ""}

        <div class="watch-date-section-label">Watched date</div>
        <div class="watch-date-options">
          <button class="watch-date-pick" type="button" data-watch-date-choice="release"${hasAirDate ? "" : " disabled"}>
            <span class="watch-date-pick-title">Day of release</span>
            <span class="watch-date-pick-sub">Use each episode's air date</span>
          </button>
          ${action.referenceWatchedAt ? `
          <button class="watch-date-pick" type="button" data-watch-date-choice="match_watched">
            <span class="watch-date-pick-title">${referenceTitle}</span>
            <span class="watch-date-pick-sub">${escapeHtml(action.referenceEpisodeLabel)} was watched ${escapeHtml(formatDate(action.referenceWatchedAt))}</span>
          </button>
          ` : ""}
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

// ── In-flight watch action tracking ────────────────────────────────────────
// Multiple watch actions can be in flight at once (e.g. marking one episode
// while another is still syncing to media servers/Trakt), so this is a Set
// rather than a single value. Buttons are only disabled when their own
// target overlaps an in-flight action's targets, instead of every "mark
// watched" button in the app freezing until one sync finishes.

// Mirrors the `isUnreleased` check media-detail-show.js uses to hide the
// per-episode "Mark watched" button behind a "Not yet released" pill - a
// season/show bulk mark must apply the same rule, or it back-dates episodes
// that haven't aired yet.
function isEpisodeUnreleased(episode) {
  if (episode?.watched || !episode?.airDate) return false;
  const parts = episode.airDate.split("-");
  if (parts.length !== 3) return false;
  const air = new Date(parts[0], parts[1] - 1, parts[2]);
  return !Number.isNaN(air.getTime()) && air > new Date();
}

function episodeKeysForAction(action) {
  const keys = new Set();
  for (const episode of [...(action?.episodes || []), ...(action?.resyncEpisodes || [])]) {
    if (episode?.key) keys.add(episode.key);
  }
  return keys;
}

// All episode keys, across every in-flight action, belonging to `showTitle`.
// A season- or show-scope action's `episodes`/`resyncEpisodes` already covers
// every episode in its scope, so this single set is enough to answer "is this
// episode/season/show busy" without tracking scope separately.
export function savingEpisodeKeysForShow(showTitle) {
  const keys = new Set();
  for (const action of state.savingWatchActions) {
    if (action.showTitle !== showTitle) continue;
    for (const key of episodeKeysForAction(action)) keys.add(key);
  }
  return keys;
}

export function isMovieSavingWatchAction(tmdbId) {
  if (!tmdbId) return false;
  for (const action of state.savingWatchActions) {
    if (action.scope === "movie" && String(action.movie?.tmdbId || "") === String(tmdbId)) return true;
  }
  return false;
}

// ── Watch date prompt open/close ───────────────────────────────────────────

// Finds a watched reference for the date prompt. A single episode uses the
// nearest watched episode before it when one exists, otherwise the nearest
// watched episode after it. Batch actions keep the original earliest-watch
// reference because they need one shared base date for the whole selection.
export function watchedReferenceFor(scopeEpisodes, targetEpisode = null) {
  if (targetEpisode) {
    const targetSeason = Number(targetEpisode.seasonNumber);
    const targetNumber = Number(targetEpisode.episodeNumber);
    if (Number.isFinite(targetSeason) && Number.isFinite(targetNumber)) {
      const watchedInSeason = scopeEpisodes.filter((episode) => (
        Number(episode?.seasonNumber) === targetSeason
        && episode?.watched?.watched_at
        && Number.isFinite(Number(episode.episodeNumber))
      ));
      const previous = watchedInSeason
        .filter((episode) => Number(episode.episodeNumber) < targetNumber)
        .sort((a, b) => Number(b.episodeNumber) - Number(a.episodeNumber))[0];
      if (previous) {
        return {
          watchedAt: previous.watched.watched_at,
          label: episodeCode(previous.seasonNumber, previous.episodeNumber),
          runtime: previous.runtime ?? null,
          direction: "after_last",
        };
      }

      const next = watchedInSeason
        .filter((episode) => Number(episode.episodeNumber) > targetNumber)
        .sort((a, b) => Number(a.episodeNumber) - Number(b.episodeNumber))[0];
      if (next) {
        return {
          watchedAt: next.watched.watched_at,
          label: episodeCode(next.seasonNumber, next.episodeNumber),
          runtime: next.runtime ?? null,
          direction: "before_next",
        };
      }
    }
  }

  let best = null;
  for (const episode of scopeEpisodes) {
    const watchedAt = episode?.watched?.watched_at;
    if (!watchedAt) continue;
    if (!best || watchedAt < best.watchedAt) best = { watchedAt, episode };
  }
  if (!best) return null;
  return {
    watchedAt: best.watchedAt,
    label: episodeCode(best.episode.seasonNumber, best.episode.episodeNumber),
    runtime: best.episode.runtime ?? null,
    direction: "",
  };
}

export function watchActionFromButton(button) {
  const scope = button?.dataset.watchScope;
  if (!scope) return null;

  // episodes = currently-unwatched-in-plembfin rows that need a watched_at
  // date picked. resyncEpisodes = rows plembfin already has as watched but
  // that the user is explicitly asking to push again (e.g. a media server
  // drifted out of sync after the original dispatch) - these keep their
  // existing watched_at and skip the date prompt entirely.
  let episodes = [];
  let resyncEpisodes = [];
  let referenceScope = [];
  let targetEpisode = null;
  if (scope === "episode") {
    const episode = state.showModalEpisodeIndex.get(button.dataset.episodeKey);
    targetEpisode = episode;
    if (episode) {
      if (!episode.watched) episodes = [episode];
      else resyncEpisodes = [episode];
    }
    referenceScope = state.showModalEpisodes.filter((row) => row.seasonNumber === episode?.seasonNumber);
  } else if (scope === "season") {
    const seasonNumber = Number(button.dataset.seasonNumber);
    const seasonEpisodes = state.showModalEpisodes.filter((row) => row.seasonNumber === seasonNumber);
    episodes = seasonEpisodes.filter((episode) => !episode.watched && !isEpisodeUnreleased(episode));
    resyncEpisodes = seasonEpisodes.filter((episode) => episode.watched);
    referenceScope = seasonEpisodes;
  } else if (scope === "show") {
    // Specials (season 0) are excluded from a whole-show "Mark watched" by
    // default - they're usually bonus/behind-the-scenes content the user
    // hasn't actually seen, so bulk-marking a show shouldn't silently sweep
    // them in. The dialog offers an opt-in "Include specials" toggle.
    const allEpisodes = state.showModalEpisodes.filter((episode) => !episode.watched && !isEpisodeUnreleased(episode));
    const allResyncEpisodes = state.showModalEpisodes.filter((episode) => episode.watched);
    const isSpecial = (episode) => Number(episode.seasonNumber) === 0;
    episodes = allEpisodes.filter((episode) => !isSpecial(episode));
    resyncEpisodes = allResyncEpisodes.filter((episode) => !isSpecial(episode));
    referenceScope = state.showModalEpisodes;

    if (!episodes.length && !resyncEpisodes.length && !allEpisodes.length && !allResyncEpisodes.length) return null;

    const anchor = episodes[0] || resyncEpisodes[0] || allEpisodes[0] || allResyncEpisodes[0];
    const showTitle = anchor?.showTitle || "Show";
    const reference = watchedReferenceFor(referenceScope);

    return {
      scope,
      showTitle,
      showTmdbId: anchor?.showTmdbId || "",
      episodes,
      resyncEpisodes,
      allEpisodes,
      allResyncEpisodes,
      includeSpecials: false,
      hasSpecials: allEpisodes.some(isSpecial) || allResyncEpisodes.some(isSpecial),
      label: `Mark ${showTitle} watched`,
      countLabel: `${episodes.length} episode${episodes.length === 1 ? "" : "s"}`,
      referenceWatchedAt: reference?.watchedAt || "",
      referenceEpisodeLabel: reference?.label || "",
      referenceRuntime: reference?.runtime ?? null,
      referenceDirection: reference?.direction || "",
    };
  }

  if (!episodes.length && !resyncEpisodes.length) return null;

  const anchor = episodes[0] || resyncEpisodes[0];
  const showTitle = anchor?.showTitle || "Show";
  const label = scope === "episode"
    ? `Mark ${episodeCode(anchor.seasonNumber, anchor.episodeNumber)} watched`
    : `Mark ${showTitle} ${seasonLabel(anchor.seasonNumber)} watched`;
  const reference = watchedReferenceFor(referenceScope, targetEpisode);

  return {
    scope,
    showTitle,
    showTmdbId: anchor?.showTmdbId || "",
    episodes,
    resyncEpisodes,
    label,
    countLabel: `${episodes.length} episode${episodes.length === 1 ? "" : "s"}`,
    referenceWatchedAt: reference?.watchedAt || "",
    referenceEpisodeLabel: reference?.label || "",
    referenceRuntime: reference?.runtime ?? null,
    referenceDirection: reference?.direction || "",
  };
}

// Re-applies (or removes) specials from an in-flight "Mark show watched"
// action's episode/resync lists when the dialog's "Include specials"
// checkbox is toggled, then re-renders the dialog to reflect the new scope.
export function toggleWatchDateIncludeSpecials(checked) {
  const action = state.pendingWatchAction;
  if (!action || action.scope !== "show" || !action.hasSpecials) return;
  const isSpecial = (episode) => Number(episode.seasonNumber) === 0;
  action.includeSpecials = checked;
  action.episodes = checked ? action.allEpisodes : action.allEpisodes.filter((episode) => !isSpecial(episode));
  action.resyncEpisodes = checked ? action.allResyncEpisodes : action.allResyncEpisodes.filter((episode) => !isSpecial(episode));
  action.countLabel = `${action.episodes.length} episode${action.episodes.length === 1 ? "" : "s"}`;
  openWatchDatePrompt(action);
}

// Re-pushes episodes plembfin already has as watched to every connected
// media server/tracker, without touching their recorded watched_at. Used
// when "Mark watched" is clicked on a scope that has nothing new to record
// (so the usual date-prompt flow has nothing to ask about) but the user
// still wants a live re-sync - e.g. a media server's watched flag drifted
// after the original push.
export async function runResyncWatchAction(action) {
  if (!action?.resyncEpisodes?.length) return;
  const records = action.resyncEpisodes.map((episode) => ({
    ...watchRecordFromEpisode(episode, episode.watched?.watched_at || new Date().toISOString()),
    resync_only: true,
  }));
  const total = records.length;

  state.savingWatchActions.add(action);
  if (renderActiveShowSavingState()) {
    // Paint the busy state synchronously when the current modal can be
    // refreshed in place; this keeps the action responsive before the
    // propagation request resolves.
  } else if (state.activeShowModalKey) {
    _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
  } else if (state.activeShowTmdbId) {
    await _openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
  } else if (state.activeShowTvdbId) {
    await _openShowImmersiveModalByTvdbId(state.activeShowTvdbId);
  }
  _setMessage(total > 1 ? `Resyncing ${total} episodes to your media apps…` : "Resyncing to your media apps…", "muted");

  try {
    const result = await postManualWatchRecords(records);
    state.savingWatchActions.delete(action);
    _clearDerivedUiCaches({ resetExplorer: false });
    const syncText = result.syncQueued
      ? `sync queued for ${result.syncQueued} item${result.syncQueued === 1 ? "" : "s"}`
      : `pushed ${result.propagated} to media apps`;
    _setMessage(`Resynced ${total} episode${total === 1 ? "" : "s"}; ${syncText}.`, result.rejected ? "error" : "success");
    await refreshShowAfterManualWatch(action.showTitle).catch((error) => _setMessage(error.message, "error"));
    if (state.activeShowModalKey) {
      _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
    } else if (state.activeShowTmdbId) {
      await _openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
    } else if (state.activeShowTvdbId) {
      await _openShowImmersiveModalByTvdbId(state.activeShowTvdbId);
    }
  } catch (error) {
    state.savingWatchActions.delete(action);
    if (state.activeShowModalKey) {
      _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
    } else if (state.activeShowTmdbId) {
      await _openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
    } else if (state.activeShowTvdbId) {
      await _openShowImmersiveModalByTvdbId(state.activeShowTvdbId);
    }
    _setMessage(`Resync failed: ${error.message}`, "error");
  }
}

export function openWatchDatePrompt(action) {
  if (!action) {
    _setMessage("There are no unwatched episodes in that selection.");
    return;
  }
  state.pendingWatchAction = action;
  // Always mount on document.body so that position:fixed inset:0 covers the
  // full viewport. Mounting inside mediaDetailRoot() would place the overlay
  // inside an ancestor that has backdrop-filter, which - per the CSS spec -
  // creates a new containing block for fixed-positioned descendants, breaking
  // the fullscreen overlay and misaligning click targets.
  document.querySelector(".watch-date-overlay")?.remove();
  document.body.insertAdjacentHTML("beforeend", renderWatchDatePrompt(action));
  mountWatchDateCustomPicker();
}

export function closeWatchDatePrompt() {
  state.pendingWatchAction = null;
  // A show refresh can render a second copy inside the current detail root
  // while the body-mounted prompt is open. Remove every copy so a stale
  // dialog cannot remain over the page after a date choice is submitted.
  document.querySelectorAll?.(".watch-date-overlay")?.forEach((overlay) => overlay.remove());
}

function renderActiveShowSavingState() {
  const context = state.activeShowRenderContext;
  if (!context?.show || typeof _renderShowModalContent !== "function") return false;
  _renderShowModalContent(context.show, {
    ...context,
    activeSeasonNum: state.activeShowModalSeason,
  });
  return true;
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

// Keep adjacent episode watches distinct, with enough time for the episode to
// have been watched and a one-minute gap before the next episode starts.
function runtimeSeparationMs(runtimeMinutes) {
  const runtime = Number(runtimeMinutes);
  const durationMs = Number.isFinite(runtime) && runtime > 0 ? Math.round(runtime * 60_000) : 0;
  // Keep adjacent watches distinct even when the metadata has no runtime.
  return durationMs + 60_000;
}

function episodeOrderAscending(a, b) {
  return Number(a?.seasonNumber || 0) - Number(b?.seasonNumber || 0)
    || Number(a?.episodeNumber || 0) - Number(b?.episodeNumber || 0);
}

function usesSharedWatchDate(choice) {
  return choice === "now" || choice === "custom" || choice === "match_watched";
}

// Build dates for a season/show batch in episode order. Shared-date choices
// use the previous episode's runtime plus a one-minute gap instead of putting
// every episode at the exact same instant.
export function watchedAtForEpisodeBatch(choice, episodes, customDate, referenceWatchedAt = "", referenceRuntime = null) {
  const orderedEpisodes = [...episodes].sort(episodeOrderAscending);
  let offsetMs = choice === "match_watched" && referenceWatchedAt
    ? runtimeSeparationMs(referenceRuntime)
    : 0;

  return orderedEpisodes.map((episode) => {
    const watchedAt = watchedAtForChoice(choice, episode, customDate, offsetMs, referenceWatchedAt);
    if (usesSharedWatchDate(choice)) offsetMs += runtimeSeparationMs(episode.runtime);
    return { episode, watchedAt };
  });
}

export function watchedAtForChoice(choice, episode, customDate, offsetMs = 0, referenceWatchedAt = "", referenceDirection = "", referenceRuntime = null) {
  if (choice === "release") return dateAtMiddayIso(episode.airDate);
  if (choice === "last_played") {
    const value = Number(episode.lastPlayedAt || 0);
    if (Number.isFinite(value) && value > 0) return new Date(value).toISOString();
  }
  if (choice === "custom") return new Date(new Date(customWatchedAtIso(customDate)).getTime() + offsetMs).toISOString();
  if (choice === "match_watched" && referenceWatchedAt) {
    const base = Date.parse(referenceWatchedAt);
    const referenceOffset = referenceDirection === "after_last"
      ? runtimeSeparationMs(referenceRuntime)
      : referenceDirection === "before_next"
        ? -runtimeSeparationMs(referenceRuntime)
        : 0;
    return new Date((Number.isNaN(base) ? Date.now() : base) + referenceOffset + offsetMs).toISOString();
  }
  return new Date(Date.now() + offsetMs).toISOString();
}

// ── Watch record builders ──────────────────────────────────────────────────

function watchRecordFromEpisode(episode, watchedAt) {
  return {
    media_type: "episode",
    title: `${episode.showTitle} - ${episodeCode(episode.seasonNumber, episode.episodeNumber)} - ${episode.title}`,
    watched_at: watchedAt,
    source: "manual",
    tmdb_id: episode.showTmdbId || null,
    imdb_id: episode.imdbId || episode.showImdbId || null,
    tvdb_id: episode.tvdbId || episode.showTvdbId || null,
    season: episode.seasonNumber,
    episode: episode.episodeNumber,
    poster_url: episode.posterUrl || episode.stillUrl || null,
    provider_items: episode.providerItems || episode.provider_items || {},
    provider_item_id: episode.providerItemId || episode.provider_item_id || undefined,
  };
}

function watchRecordFromMovie(movie, watchedAt) {
  return {
    media_type: "movie",
    title: movie.title,
    watched_at: watchedAt,
    source: "manual",
    tmdb_id: movie.tmdbId || null,
    imdb_id: movie.imdbId || null,
    tvdb_id: movie.tvdbId || null,
    poster_url: movie.posterUrl || null,
    provider_items: movie.providerItems || movie.provider_items || {},
    provider_item_id: movie.providerItemId || movie.provider_item_id || undefined,
  };
}

// ── Seerr request ──────────────────────────────────────────────────────────

function localWatchRowFromMovie(movie, watchedAt, id = "") {
  return {
    id: id || `local-movie-${movie.tmdbId || movie.title}-${Date.now()}`,
    media_type: "movie",
    title: movie.title,
    watched_at: watchedAt,
    source: "manual",
    sync_action: "watched",
    tmdb_id: movie.tmdbId || null,
    imdb_id: movie.imdbId || null,
    tvdb_id: movie.tvdbId || null,
    poster_url: movie.posterUrl || null,
    logo_url: movie.logoUrl || null,
    backdrop_url: movie.backdropUrl || null,
    youtube_url: movie.youtubeUrl || null,
  };
}

function rememberLocalWatchedMovie(movieRow) {
  if (!movieRow?.id) return;
  state.history = [
    movieRow,
    ...state.history.filter((entry) => {
      if (entry.media_type !== "movie") return true;
      if (String(entry.id || "") === String(movieRow.id)) return false;
      if (movieRow.tmdb_id && String(entry.tmdb_id || "") === String(movieRow.tmdb_id)) return false;
      return String(entry.title || "").toLowerCase() !== String(movieRow.title || "").toLowerCase();
    }),
  ];
  state.moviesRaw = dedupeMediaRecords([movieRow, ...state.moviesRaw], "movies");
}

export async function submitSeerrRequest(mediaType, mediaId, button) {
  if (!mediaId || !mediaType) {
    _setMessage("Cannot send Seerr request - missing media info.", "error");
    return false;
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
      return true;
    } else {
      const errMsg = data.error || `Seerr returned ${res.status}`;
      _setMessage(`Seerr error: ${errMsg}`, "error");
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
      return false;
    }
  } catch (err) {
    _setMessage(`Seerr request failed: ${err.message}`, "error");
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
    return false;
  }
}

// ── Seerr TV season picker ─────────────────────────────────────────────────

export function openSeerrSeasonRequestDialog(mediaType, mediaId, { is4k = false } = {}) {
  if (mediaType !== "tv" || !mediaId) return;
  const ctx = state.activeShowRenderContext;
  const tmdbData = ctx?.tmdbData;
  const showTitle = ctx?.show?.title || tmdbData?.name || tmdbData?.title || "this show";
  const seasons = (tmdbData?.seasons || [])
    .filter((season) => Number(season.season_number) > 0)
    .sort((a, b) => Number(a.season_number) - Number(b.season_number));
  if (!seasons.length) {
    _setMessage("Season information hasn't loaded yet - try again in a moment.", "error");
    return;
  }
  const status = state.seerrMediaStatusCache.get(`tv:${mediaId}`) || {};
  const latestSeasonNumber = Math.max(...seasons.map((season) => Number(season.season_number)));

  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());
  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });

  const rowsHtml = seasons.map((season) => {
    const seasonNumber = Number(season.season_number);
    const availability = tvSeasonAvailability(status, seasonNumber);
    const released = Number(availability?.released || availability?.total || season.episode_count || 0);
    const availableForKind = Number((is4k ? availability?.available4k : availability?.available) || 0);
    const isFullyAvailable = released > 0 && availableForKind >= released;
    const isDefaultChecked = !isFullyAvailable && seasonNumber === latestSeasonNumber;
    const availabilityLabel = released
      ? (isFullyAvailable ? `All ${released} available${is4k ? " in 4K" : ""}` : `${availableForKind}/${released} available${is4k ? " in 4K" : ""}`)
      : "Episode count unknown";
    return `
      <label class="seerr-season-row">
        <input type="checkbox" class="seerr-season-checkbox" value="${seasonNumber}" ${isDefaultChecked ? "checked" : ""} ${isFullyAvailable ? "disabled" : ""} />
        <span class="seerr-season-row-label">${escapeHtml(formatSeasonTitle(seasonNumber, season.name))}</span>
        <span class="seerr-season-row-status">${escapeHtml(availabilityLabel)}</span>
      </label>
    `;
  }).join("");

  overlay.innerHTML = `
    <div class="edit-dialog seerr-season-dialog glass-panel">
      <h3>Request ${is4k ? "4K " : ""}Seasons</h3>
      <p class="muted-copy">Choose which seasons of ${escapeHtml(showTitle)} to request${is4k ? " in 4K" : ""} on Seerr.</p>
      <div class="seerr-season-list">${rowsHtml}</div>
      <div class="edit-dialog-actions">
        <button class="button-ghost seerr-season-select-all" type="button">Select all</button>
        <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
        <button class="button-primary seerr-season-submit" type="button"
          ${is4k ? 'data-seerr-request-4k="true"' : ""}>Request selected</button>
      </div>
      <p class="edit-dialog-status"></p>
    </div>
  `;

  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector(".seerr-season-select-all").addEventListener("click", () => {
    overlay.querySelectorAll(".seerr-season-checkbox:not(:disabled)").forEach((checkbox) => { checkbox.checked = true; });
  });

  const submitButton = overlay.querySelector(".seerr-season-submit");
  submitButton.addEventListener("click", async () => {
    const statusEl = overlay.querySelector(".edit-dialog-status");
    const selected = [...overlay.querySelectorAll(".seerr-season-checkbox:checked")].map((checkbox) => Number(checkbox.value));
    if (!selected.length) {
      statusEl.textContent = "Select at least one season.";
      return;
    }
    submitButton.setAttribute("data-seerr-seasons", JSON.stringify(selected));
    const ok = await submitSeerrRequest(mediaType, mediaId, submitButton);
    if (ok) overlay.remove();
  });

  document.body.appendChild(overlay);
}

// ── Mark watched ───────────────────────────────────────────────────────────

export function markMovieWatched(movie) {
  if (!movie?.title) {
    _setMessage("Cannot mark this movie watched - missing details.", "error");
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

// Discover cards are not guaranteed to exist in the local library yet. Movies
// can use the normal movie watch-date flow directly; a TV card needs the
// released episode list first so "Mark watched" records real episode rows
// rather than inventing a show-level history record.
export async function markDiscoverWatched(item = {}) {
  const mediaType = item.media_type === "tv" ? "tv" : "movie";
  if (mediaType === "movie") {
    markMovieWatched({
      tmdbId: item.tmdb_id || item.tmdbId || "",
      imdbId: item.imdb_id || item.imdbId || "",
      tvdbId: item.tvdb_id || item.tvdbId || "",
      title: item.title || "Untitled",
      posterUrl: item.poster_url || item.posterUrl || "",
      releaseDate: item.release_date || item.releaseDate || "",
    });
    return;
  }

  const tmdbId = item.tmdb_id || item.tmdbId || "";
  if (!tmdbId) throw new Error("This TV show has no TMDB id to load its episodes.");
  _setMessage(`Loading released episodes for "${item.title || "this show"}"…`, "muted");

  try {
    const details = await fetchTmdbDetails("tv", tmdbId, item.title || "", {
      imdbId: item.imdb_id || item.imdbId || "",
      tvdbId: item.tvdb_id || item.tvdbId || "",
    }, { immediate: true });
    const showTitle = details?.name || details?.title || item.title || "Show";
    const showTmdbId = details?.id || tmdbId;
    const showTvdbId = details?.external_ids?.tvdb_id || item.tvdb_id || item.tvdbId || "";
    const seasons = (Array.isArray(details?.seasons) ? details.seasons : [])
      .filter((season) => Number(season?.season_number) > 0)
      .sort((left, right) => Number(left.season_number) - Number(right.season_number));
    const seasonDetails = await Promise.all(seasons.map((season) => fetchTmdbSeasonDetails(showTmdbId, season.season_number).catch(() => null)));
    const today = new Date().toISOString().slice(0, 10);
    const episodes = seasonDetails
      .flatMap((season) => Array.isArray(season?.episodes) ? season.episodes : [])
      .filter((episode) => Number(episode?.episode_number) > 0 && (!episode.air_date || episode.air_date <= today))
      .map((episode) => ({
        seasonNumber: Number(episode.season_number),
        episodeNumber: Number(episode.episode_number),
        title: episode.name || episode.episode_name || episodeCode(episode.season_number, episode.episode_number),
        showTitle,
        showTmdbId: String(showTmdbId),
        tvdbId: showTvdbId,
        posterUrl: item.poster_url || item.posterUrl || "",
        stillUrl: episode.still_path ? tmdbPoster(episode.still_path, showTmdbId, "tv") : "",
        key: `discover:${showTmdbId}:${episode.season_number}:${episode.episode_number}`,
        airDate: episode.air_date || null,
      }))
      .sort((left, right) => left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber);

    if (!episodes.length) throw new Error("No released episodes were found for this TV show.");
    state.pendingWatchAction = {
      origin: "discover",
      scope: "show",
      showTitle,
      showTmdbId: String(showTmdbId),
      episodes,
      allEpisodes: episodes,
      resyncEpisodes: [],
      allResyncEpisodes: [],
      includeSpecials: false,
      hasSpecials: false,
      label: `Mark ${showTitle} watched`,
      countLabel: `${episodes.length} released episode${episodes.length === 1 ? "" : "s"}`,
    };
    openWatchDatePrompt(state.pendingWatchAction);
  } catch (error) {
    _setMessage(`Could not load episodes for "${item.title || "this show"}": ${error.message}`, "error");
    throw error;
  }
}

export async function postManualWatchRecords(records, onProgress) {
  let inserted = 0;
  let skipped = 0;
  let rejected = 0;
  let propagated = 0;
  let syncQueued = 0;
  const results = [];

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
    if (Array.isArray(body.results)) results.push(...body.results);
    onProgress?.(Math.min(index + batch.length, records.length), records.length);
  }

  return { inserted, skipped, rejected, propagated, syncQueued, results };
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

  document.querySelector(".watch-date-overlay")?.querySelectorAll("[data-watch-date-choice], [data-watch-date-cancel]").forEach((button) => {
    button.disabled = true;
  });

  state.savingWatchActions.add(action);
  closeWatchDatePrompt();

  const markWatchedBtn = root.querySelector("[data-movie-mark-watched]");
  if (markWatchedBtn) {
    markWatchedBtn.disabled = true;
    markWatchedBtn.textContent = "Saving…";
  }

  _setMessage(`Syncing "${movie.title}" to your media apps…`, "muted");

  try {
    const result = await postManualWatchRecords([record]);
    state.savingWatchActions.delete(action);
    const savedId = result.results?.[0]?.id || "";
    const watchedMovie = localWatchRowFromMovie(movie, watchedAt, savedId);
    rememberLocalWatchedMovie(watchedMovie);
    _clearDerivedUiCaches({ resetExplorer: false });
    _setMessage(
      `Marked "${movie.title}" watched${result.skipped ? " (already logged)" : ""}; pushed ${result.propagated} of ${result.syncQueued} to media apps.`,
      result.rejected ? "error" : "success",
    );
    const patchedCurrentDetail = _patchMovieWatchedState(watchedMovie);
    await _loadHistory({ force: true }).catch(() => null);
    rememberLocalWatchedMovie(watchedMovie);
    if (!patchedCurrentDetail && movie.tmdbId) {
      await _openMovieImmersiveModalByTmdbId(movie.tmdbId);
    }
  } catch (error) {
    state.savingWatchActions.delete(action);
    if (markWatchedBtn) {
      markWatchedBtn.disabled = false;
      markWatchedBtn.textContent = "Mark watched";
    }
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
  if (index < 0) {
    state.showsRaw.push({
      title: action.showTitle,
      tmdb_id: action.showTmdbId || null,
      episodes: [],
      episode_count: 0,
      season_count: 0,
    });
    index = state.showsRaw.length - 1;
  }

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
}

async function applyPartWatchedWatchDateChoice(choice) {
  const action = state.pendingWatchAction;
  if (!action) return;

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

  document.querySelector(".watch-date-overlay")?.querySelectorAll("[data-watch-date-choice], [data-watch-date-cancel]").forEach((button) => {
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
    await _loadHistory({ force: true }).catch(() => null);
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

  const customDate = getCustomWatchDateValue();
  const watchedEntries = action.scope === "episode"
    ? action.episodes.map((episode) => ({
      episode,
      watchedAt: watchedAtForChoice(choice, episode, customDate, 0, action.referenceWatchedAt, action.referenceDirection, action.referenceRuntime),
    }))
    : watchedAtForEpisodeBatch(choice, action.episodes, customDate, action.referenceWatchedAt, action.referenceRuntime);
  const watchedRows = watchedEntries.map(({ episode, watchedAt }) => localWatchRowFromEpisode(episode, watchedAt));
  const records = watchedEntries.map(({ episode, watchedAt }) => watchRecordFromEpisode(episode, watchedAt));
  // Episodes plembfin already has as watched ride along in the same batch so a
  // season/show "mark watched" always re-pushes them too, without touching
  // their existing watched_at.
  const resyncRecords = (action.resyncEpisodes || []).map((episode) => ({
    ...watchRecordFromEpisode(episode, episode.watched?.watched_at || new Date().toISOString()),
    resync_only: true,
  }));
  const allRecords = [...records, ...resyncRecords];
  const overlay = document.querySelector(".watch-date-overlay");
  const buttons = [...(overlay?.querySelectorAll("[data-watch-date-choice], [data-watch-date-cancel]") ?? [])];
  buttons.forEach((button) => {
    button.disabled = true;
  });

  // Rows in `action.episodes` show a "Saving..." state (driven by
  // state.savingWatchActions) instead of flipping to watched right away - the
  // optimistic update only runs below once postManualWatchRecords resolves,
  // i.e. once the live sync to every target has actually finished, not just
  // once the click was registered.
  state.savingWatchActions.add(action);
  closeWatchDatePrompt();
  if (renderActiveShowSavingState()) {
    // Paint the saving state synchronously before the request starts so the
    // episode action never sits on "Mark watched" with no feedback.
  } else if (state.activeShowModalKey) {
    _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
  } else if (state.activeShowTmdbId) {
    await _openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
  } else if (state.activeShowTvdbId) {
    await _openShowImmersiveModalByTvdbId(state.activeShowTvdbId);
  }

  const total = allRecords.length;
  _setMessage(total > 1 ? `Syncing ${total} episodes to your media apps… 0/${total}` : "Syncing to your media apps…", "muted");

  try {
    const result = await postManualWatchRecords(allRecords, (done, all) => {
      if (all > 1) _setMessage(`Syncing ${all} episodes to your media apps… ${done}/${all}`, "muted");
    });
    state.savingWatchActions.delete(action);
    applyOptimisticWatchedEpisodes(action, watchedRows);
    _clearDerivedUiCaches({ resetExplorer: false });
    const totalMarked = result.inserted + result.skipped;
    _setMessage(
      `Marked ${totalMarked} episode${totalMarked === 1 ? "" : "s"} watched; pushed ${result.propagated} of ${result.syncQueued} to media apps${result.skipped ? `, ${result.skipped} already logged` : ""}.`,
      result.rejected ? "error" : "success",
    );
    await refreshShowAfterManualWatch(action.showTitle).catch((error) => _setMessage(error.message, "error"));
    if (state.activeShowModalKey) {
      _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
    } else if (state.activeShowTmdbId) {
      await _openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
    } else if (state.activeShowTvdbId) {
      await _openShowImmersiveModalByTvdbId(state.activeShowTvdbId);
    }
  } catch (error) {
    state.savingWatchActions.delete(action);
    if (state.activeShowModalKey) {
      _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
    } else if (state.activeShowTmdbId) {
      await _openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
    } else if (state.activeShowTvdbId) {
      await _openShowImmersiveModalByTvdbId(state.activeShowTvdbId);
    }
    _setMessage(`Manual watch update failed: ${error.message}`, "error");
    throw error;
  }
}

// ── Confirm dialogs ────────────────────────────────────────────────────────

// Poster-grid cards (dashboard/explorer) aren't part of the immersive show
// modal's "Removing…" label swap above, and the grid they live in doesn't
// re-render until the history refresh round-trip completes. Toggling this
// class gives an immediate visual response the moment the unwatch is
// confirmed, on every card for that id across every currently-mounted view.
function setGridCardsRemoving(ids, removing) {
  for (const id of ids) {
    for (const card of document.querySelectorAll(`[data-history-id="${CSS.escape(String(id))}"]`)) {
      card.classList.toggle("card-removing", removing);
    }
  }
}

// Animates out and removes the poster card(s) for these ids in place, and
// keeps state.moviesRaw/state.historyViewRaw in sync by hand so no full
// explorer refetch is needed. Used instead of the fallback
// closeMediaDetail()+renderActiveView() path below, which rebuilds the whole
// explorer grid from scratch and resets scroll position - jarring when the
// action was a poster-grid card unwatch rather than a page-level navigation.
// Returns false (doing nothing) when no matching card is mounted, so the
// caller can fall back to that full re-render for any other trigger site.
function removeGridCards(ids) {
  const idSet = new Set(ids.map(String));
  let removedAny = false;
  for (const id of ids) {
    for (const card of document.querySelectorAll(`[data-history-id="${CSS.escape(String(id))}"]`)) {
      if (!card.matches(".movie-card, .history-grid-card, .history-mini-card, .history-page-card")) continue;
      removedAny = true;
      card.classList.remove("card-removing");
      card.classList.add("card-removed");
      window.setTimeout(() => card.remove(), 260);
    }
  }
  if (removedAny) {
    if (Array.isArray(state.moviesRaw)) state.moviesRaw = state.moviesRaw.filter((m) => !idSet.has(String(m?.id)));
    if (Array.isArray(state.historyViewRaw)) state.historyViewRaw = state.historyViewRaw.filter((h) => !idSet.has(String(h?.id)));
  }
  return removedAny;
}

export async function confirmAndMarkUnwatched(button) {
  const idsJson = button.dataset.unwatchIds;
  const ids = idsJson ? JSON.parse(idsJson) : button.dataset.unwatchId ? [button.dataset.unwatchId] : [];
  if (!ids.length) return;
  const kind = button.dataset.unwatchKind || "item";
  const label = button.dataset.unwatchLabel || "this item";
  const showTitle = button.dataset.showTitle || "";
  const bulk = ids.length > 1;
  // Set on every poster-grid overflow menu's unwatch item (posterOverflowMenu
  // in images.js). Take it at face value and skip the "was a detail modal
  // open?" checks below entirely, rather than trust state flags that can go
  // stale - e.g. after a browser back-navigation away from a detail page
  // that didn't fully reset them - and misroute a grid unwatch into a no-op
  // "reopen the modal" branch that never touches the grid.
  const gridOrigin = button.dataset.gridOrigin === "1";

  const confirmed = await _openConfirmDialog({
    title: "Mark unwatched",
    body: bulk
      ? `Remove all ${ids.length} watched episodes of "${label}" from your watch history and mark them unplayed on Plex, Emby, and Jellyfin?`
      : `Remove "${label}" from your watch history and mark it unplayed on Plex, Emby, and Jellyfin?`,
    confirmLabel: "Mark unwatched",
    danger: true,
  });
  if (!confirmed) return;

  // Keep the movie identity before any awaited work. The forced history load
  // below can cause another render (or a live update) to replace the active
  // detail state, which used to make the post-unwatch branch fall through to
  // closeMediaDetail and send the user back to the library.
  const movieTmdbId = kind === "movie"
    ? String(
      button.dataset.unwatchTmdbId
      || state.activeMovieTmdbId
      || state.activeMediaInfo?.tmdbData?.id
      || state.activeMediaInfo?.media?.tmdb_id
      || "",
    ).trim()
    : "";
  const movieDetailWasOpen = kind === "movie" && (
    Boolean(movieTmdbId)
    || Boolean(state.activeMovieModalId)
    || state.activeMediaInfo?.mediaType === "movie"
    || state.mediaDetailInline
    || window.location.pathname.startsWith("/movie/")
  );

  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Removing…";

  // Marks these ids as "being removed" so the season/show progress labels
  // (which otherwise just recompute from the still-watched rows) show
  // "Removing…" immediately instead of the stale watched count until the
  // request resolves and the page re-renders.
  for (const id of ids) state.savingUnwatchIds.add(id);
  setGridCardsRemoving(ids, true);
  if (!gridOrigin && (kind === "episode" || kind === "season" || kind === "show") && state.activeShowModalKey) {
    // Paint the saving state synchronously (same as applyWatchDateChoice)
    // before the request starts, instead of the full async
    // _renderImmersiveShowModal reload - that one can re-fetch metadata and
    // briefly show a loading state, stomping the is-saving pulse it was
    // meant to show.
    if (!renderActiveShowSavingState()) {
      _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
    }
  }

  try {
    // /api/manual-unwatch caps a single request at 100 ids, so a show/season
    // whole-scope unwatch (every watched episode's id, which can easily
    // exceed that for a long-running show) has to go out in chunks instead
    // of one request - otherwise it 413s, the animation reverts, and every
    // episode is left showing watched with no indication why.
    let succeeded = 0;
    let failed = 0;
    let queued = 0;
    for (let index = 0; index < ids.length; index += IMPORT_BATCH_SIZE) {
      const batch = ids.slice(index, index + IMPORT_BATCH_SIZE);
      const response = await fetch("/api/manual-unwatch", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(bulk ? { ids: batch } : { id: batch[0] }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Mark unwatched failed (${response.status})`);
      if (bulk) {
        succeeded += Number(result.succeeded || 0);
        failed += Number(result.failed || 0);
        queued += Number(result.queued || 0);
      } else {
        succeeded += 1;
        if (result.queued) queued += 1;
      }
    }

    for (const id of ids) state.savingUnwatchIds.delete(id);
    // The server has committed the unwatch at this point. Reflect that success
    // immediately instead of leaving the control on "Removing…" while the
    // detail page performs its comparatively expensive metadata refresh.
    button.textContent = "Removed";
    const propagationMessage = queued
      ? `${queued} item${queued === 1 ? "" : "s"} queued to sync after the current blocking operation completes`
      : "pushed unplayed to media apps";
    _setMessage(
      bulk
        ? `Marked ${succeeded} episode${succeeded === 1 ? "" : "s"} of "${label}" unwatched; ${propagationMessage}.${failed ? ` ${failed} failed.` : ""}`
        : queued
          ? `Marked "${label}" unwatched; sync queued until the current blocking operation completes.`
          : `Marked "${label}" unwatched; ${propagationMessage}.`,
      failed ? "error" : "success",
    );
    const historyRefresh = _loadHistory({ force: true }).catch(() => null);

    if (!gridOrigin && (kind === "episode" || kind === "season" || kind === "show") && (state.activeShowModalKey || state.activeShowTmdbId || state.activeShowTvdbId)) {
      _clearDerivedUiCaches({ resetExplorer: kind === "movie" });
      await historyRefresh;
      if (showTitle) await refreshShowAfterManualWatch(showTitle).catch(() => null);
      if (state.activeShowModalKey) {
        _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
      } else if (state.activeShowTmdbId) {
        await _openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
      } else {
        await _openShowImmersiveModalByTvdbId(state.activeShowTvdbId);
      }
    } else if (!gridOrigin && movieDetailWasOpen) {
      _clearDerivedUiCaches({ resetExplorer: kind === "movie" });
      // Stay on the movie's own detail page and re-render it showing the new
      // unwatched status, matching the show/episode/season branch above,
      // instead of closing the modal back to whatever page was behind it.
      // A title without a TMDB id has no alternate detail loader, so leave its
      // already-mounted page in place rather than navigating away from it.
      // Do not keep the completed action pending on TMDB/OMDb/recommendation
      // hydration. Multiple movie tabs can make that refresh take noticeably
      // longer, but it is no longer part of the unwatch transaction.
      if (movieTmdbId) {
        Promise.allSettled([historyRefresh]).then(() => {
          _openMovieImmersiveModalByTmdbId(movieTmdbId).catch(() => null);
        });
      }
    } else if (removeGridCards(ids)) {
      // A poster-grid card for this id is mounted (dashboard and/or explorer)
      // - animate it out in place and leave the rest of the page exactly
      // where the user was, instead of the full closeMediaDetail() +
      // renderActiveView() rebuild below, which resets scroll position.
      // Only the pagination cache needs invalidating for a later fresh
      // explorer visit; state.moviesRaw/historyViewRaw were already kept in
      // sync by removeGridCards, so nothing needs refetching right now.
      _clearDerivedUiCaches({ resetExplorer: false });
      // The live-update SSE event for this mutation now refreshes data
      // silently, so it will not undo this in-place removal or reset scroll.
    } else {
      _clearDerivedUiCaches({ resetExplorer: kind === "movie" });
      await historyRefresh;
      _closeMediaDetail();
      _renderActiveView();
    }
  } catch (error) {
    for (const id of ids) state.savingUnwatchIds.delete(id);
    setGridCardsRemoving(ids, false);
    button.disabled = false;
    button.textContent = originalText;
    if (!gridOrigin && (kind === "episode" || kind === "season" || kind === "show") && state.activeShowModalKey) {
      _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
    }
    _setMessage(`Mark unwatched failed: ${error.message}`, "error");
  }
}

// ── Bulk unwatch buttons (season/show) ─────────────────────────────────────

export function seasonUnwatchButtonHtml(ids, seasonNumber, showTitle, disabled, removing = false) {
  if (!ids.length) return "";
  return `<button class="action-pill action-pill-ghost" type="button" ${(disabled || removing) ? "disabled" : ""} data-unwatch-ids="${escapeAttribute(JSON.stringify(ids))}" data-unwatch-kind="season" data-unwatch-label="${escapeAttribute(`${showTitle} ${seasonLabel(seasonNumber)}`)}" data-show-title="${escapeAttribute(showTitle)}">${removing ? "Unwatching…" : "Mark season unwatched"}</button>`;
}

export function showUnwatchButtonHtml(ids, showTitle, disabled, removing = false) {
  if (!ids.length) return "";
  const xIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 1 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>`;
  return `<button class="action-pill action-pill-ghost" type="button" ${(disabled || removing) ? "disabled" : ""} data-unwatch-ids="${escapeAttribute(JSON.stringify(ids))}" data-unwatch-kind="show" data-unwatch-label="${escapeAttribute(showTitle)}" data-show-title="${escapeAttribute(showTitle)}">${xIcon}<span>${removing ? "Unwatching…" : "Mark <br>Unwatched"}</span></button>`;
}

// Permanently delete a library item - requires three explicit confirmations.
export async function confirmAndDeleteMedia(button) {
  const id = button.dataset.deleteMediaId;
  if (!id) return;
  const label = button.dataset.deleteMediaTitle || "this item";
  const mediaType = String(button.dataset.deleteMediaType || "movie").toLowerCase();
  const isShow = ["episode", "show", "tv", "tvshow", "series"].includes(mediaType);
  const mediaLabel = isShow ? "TV show" : "movie";
  const historyLabel = isShow ? "all watched episode history" : "its entire watch history";

  const first = await _openConfirmDialog({
    title: "Delete from library?",
    body: `This permanently deletes the ${mediaLabel} "${label}" and ${historyLabel} from Plembfin. This does NOT affect Plex, Emby or Jellyfin - it only removes the local record.`,
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
    body: `Last chance - permanently delete "${label}" now?`,
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
      body: JSON.stringify({ id, media_type: mediaType, confirm: "DELETE" }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Delete failed (${response.status})`);

    _clearDerivedUiCaches({ resetExplorer: true });
    _setMessage(`Deleted "${label}" and its history (${result.deleted || 0} record${result.deleted === 1 ? "" : "s"}).`, "success");
    await _loadHistory({ force: true }).catch(() => null);
    _closeMediaDetail();
  } catch (error) {
    button.disabled = false;
    button.textContent = originalText;
    _setMessage(`Delete failed: ${error.message}`, "error");
  }
}
