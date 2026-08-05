import { state } from "./state.js";
import { escapeAttribute, formatDate, showTitleFrom, showName, slug, movieHref } from "./utils.js";
import { isCachedStorageImageUrl, proxiedArtworkUrl, rememberPosterLookup } from "./images.js";
import {
  openEditDateDialog,
  openEditShowDateDialog,
  openEditImageDialog,
  openFixMatchDialog,
  openMergeShowDialog,
  openEditSeasonDateDialog,
  applyWatchedAtToLocalWatchRecord,
  editDateOptionsFromButton,
} from "./edit-dialogs.js?v=20260810";
import {
  openWatchDatePrompt,
  closeWatchDatePrompt,
  watchActionFromButton,
  submitSeerrRequest,
  openSeerrSeasonRequestDialog,
  markMovieWatched,
  refreshShowAfterManualWatch,
  applyWatchDateChoice,
  confirmAndMarkUnwatched,
  confirmAndDeleteMedia,
} from "./watch-action.js?v=20260810";
import { triggerRetrySync, loadSyncJobs, loadSyncHistory, showAvailIssuePopup } from "./sync.js";
import { renderExplorer, renderHistoryView } from "./explorer.js";
import {
  movieBySlugOrId,
  openShowInlineDetail,
  closeMediaDetail,
  renderImmersiveShowModal,
  renderShowModalContent,
  renderMovieImmersiveModalContent,
  openHistoryDebugModal,
  openMediaInfoModal,
} from "./media-detail.js?v=20260810";
import { fetchWatchedMovieByTmdb, syncRewatchHistoryToggle } from "./media-detail-movie.js?v=20260810";

// Callbacks injected by app-events.js (forwarded from app.js) to avoid circular imports.
let _cb = {};
export function initMediaDetailEvents(callbacks = {}) {
  _cb = callbacks;
}

const navigateTo = (...args) => _cb.navigateTo?.(...args);
const setMessage = (...args) => _cb.setMessage?.(...args);
const authHeaders = (...args) => _cb.authHeaders?.(...args);
const clearDerivedUiCaches = (...args) => _cb.clearDerivedUiCaches?.(...args);
const loadHistory = (...args) => _cb.loadHistory?.(...args);
const selectSettingsTab = (...args) => _cb.selectSettingsTab?.(...args);
const copyToClipboard = (...args) => _cb.copyToClipboard?.(...args);
const toggleSet = (...args) => _cb.toggleSet?.(...args);
const openConfirmDialog = (...args) => _cb.openConfirmDialog?.(...args);

async function refreshActiveMovieAfterDateEdit(entry = null) {
  if (!state.activeMovieModalId) return;
  if (entry?.media_type && entry.media_type !== "movie") return;
  const title = entry?.title || document.querySelector(".immersive-title")?.textContent || "";
  const movie = await fetchWatchedMovieByTmdb(state.activeMovieTmdbId || entry?.tmdb_id || "", title);
  if (movie && state.activeMovieModalId) await renderMovieImmersiveModalContent(movie);
}

async function refreshActiveShowAfterDateEdit(entry = null) {
  if (!state.activeShowModalKey) return;
  if (entry?.media_type && entry.media_type !== "episode") return;
  const activeShow = state.showsRaw.find((show) => slug(show.title) === state.activeShowModalKey);
  const showTitle = entry?.show_title || (entry?.title ? showTitleFrom(entry.title) : "") || activeShow?.title || "";
  if (!showTitle) return;
  await refreshShowAfterManualWatch(showTitle);
  if (state.activeShowModalKey) {
    await renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
  }
}

function mediaForceSyncPayload(button) {
  const payload = {
    type: button.dataset.forceSyncType || "movie",
    title: button.dataset.forceSyncTitle || "",
    tmdb_id: button.dataset.forceSyncTmdbId || "",
    tvdb_id: button.dataset.forceSyncTvdbId || "",
    imdb_id: button.dataset.forceSyncImdbId || "",
  };
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== ""));
}

let mediaForceSyncSession = null;

function mediaForceSyncElements() {
  return {
    modal: document.querySelector("#mediaForceSyncModal"),
    title: document.querySelector("#mediaForceSyncModalTitle"),
    description: document.querySelector("#mediaForceSyncModalDescription"),
    close: document.querySelector("#closeMediaForceSyncModalButton"),
    activity: document.querySelector("#mediaForceSyncActivity"),
    activityState: document.querySelector("#mediaForceSyncActivityState"),
    terminal: document.querySelector("#mediaForceSyncTerminal"),
    progress: document.querySelector("#mediaForceSyncProgress"),
    progressLabel: document.querySelector("#mediaForceSyncProgressLabel"),
    progressMeta: document.querySelector("#mediaForceSyncProgressMeta"),
    progressTrack: document.querySelector("#mediaForceSyncProgressTrack"),
    progressFill: document.querySelector("#mediaForceSyncProgressFill"),
    pushTarget: document.querySelector("#mediaForceSyncPushTarget"),
    pullSource: document.querySelector("#mediaForceSyncPullSource"),
  };
}

function mediaForceSyncModeLabel(mode = "full") {
  return mode === "push" ? "Push To" : mode === "pull" ? "Pull From" : "Full Sync";
}

function mediaForceSyncServerLabel(server = "all") {
  if (server === "all" || !server) return "all connected servers";
  return server.charAt(0).toUpperCase() + server.slice(1);
}

function resetMediaForceSyncActivity(elements) {
  elements.activity?.classList.add("hidden");
  if (elements.terminal) elements.terminal.textContent = "";
  if (elements.activityState) elements.activityState.textContent = "Ready";
  elements.progress?.classList.add("hidden");
  if (elements.progressLabel) elements.progressLabel.textContent = "Preparing operation";
  if (elements.progressMeta) elements.progressMeta.textContent = "";
  if (elements.progressTrack) elements.progressTrack.setAttribute("aria-valuenow", "0");
  if (elements.progressFill) elements.progressFill.style.transform = "scaleX(0)";
}

function setMediaForceSyncControlsBusy(elements, busy) {
  elements.modal?.querySelectorAll("[data-media-force-sync-run], select").forEach((control) => {
    control.disabled = busy;
  });
  if (elements.close) {
    elements.close.textContent = busy ? "Running…" : "Close";
    elements.close.setAttribute("aria-disabled", String(busy));
  }
}

function renderMediaForceSyncActivity(activity) {
  const elements = mediaForceSyncElements();
  if (!activity) return;
  elements.activity?.classList.remove("hidden");
  const lines = (activity.lines || []).map((line) => {
    const stamp = line.at ? new Date(line.at).toLocaleTimeString() : "--:--:--";
    const level = String(line.level || "info").toUpperCase().padEnd(7, " ");
    return `[${stamp}] ${level} ${line.text || ""}`;
  });
  if (elements.terminal) {
    elements.terminal.textContent = lines.join("\n");
    elements.terminal.scrollTop = elements.terminal.scrollHeight;
  }

  const status = activity.status || "running";
  const statusLabel = status === "completed" ? "Complete" : status === "error" ? "Failed" : "Live output";
  if (elements.activityState) elements.activityState.textContent = statusLabel;
  if (elements.progressLabel) {
    elements.progressLabel.textContent = status === "running"
      ? `${mediaForceSyncModeLabel(activity.meta?.mode)} in progress`
      : status === "completed" ? "Operation complete" : "Operation stopped with an error";
  }
  if (elements.progressMeta) elements.progressMeta.textContent = `${lines.length} log line${lines.length === 1 ? "" : "s"}`;
  elements.progress?.classList.remove("hidden");
  elements.progress?.setAttribute("data-status", status);
  const progressValue = status === "completed" ? 100 : status === "error" ? 100 : 18;
  if (elements.progressTrack) elements.progressTrack.setAttribute("aria-valuenow", String(progressValue));
  if (elements.progressFill) elements.progressFill.style.transform = `scaleX(${progressValue / 100})`;
}

function waitForMediaForceSyncPoll() {
  return new Promise((resolve) => setTimeout(resolve, 650));
}

function closeMediaForceSyncDialog() {
  const elements = mediaForceSyncElements();
  if (mediaForceSyncSession?.running) return;
  elements.modal?.classList.add("hidden");
}

function openMediaForceSyncDialog(button) {
  if (mediaForceSyncSession?.running) return;
  const elements = mediaForceSyncElements();
  if (!elements.modal) {
    setMessage("Force Sync options are unavailable until the page finishes loading.", "error");
    return;
  }
  const payload = mediaForceSyncPayload(button);
  mediaForceSyncSession = { button, payload, running: false, operationId: "" };
  if (elements.title) elements.title.textContent = `Force Sync · ${payload.title}`;
  if (elements.description) elements.description.textContent = `${payload.type === "show" ? "TV show" : payload.type === "episode" ? "Episode" : "Movie"} · this operation is limited to the selected media item.`;
  if (elements.pushTarget) elements.pushTarget.value = "all";
  if (elements.pullSource) elements.pullSource.value = "all";
  resetMediaForceSyncActivity(elements);
  setMediaForceSyncControlsBusy(elements, false);
  elements.modal.classList.remove("hidden");
  elements.modal.querySelector("[data-media-force-sync-run=full]")?.focus();
}

async function finishMediaForceSyncOperation(payload, activity, error = "") {
  const session = mediaForceSyncSession;
  if (!session) return;
  session.running = false;
  const elements = mediaForceSyncElements();
  renderMediaForceSyncActivity(activity);
  setMediaForceSyncControlsBusy(elements, false);
  if (session.button?.isConnected) {
    session.button.disabled = false;
    session.button.removeAttribute("aria-busy");
  }
  if (error || activity?.status === "error") {
    setMessage(`Force Sync failed: ${error || activity?.error || "operation failed"}`, "error");
    return;
  }

  const result = activity?.result || {};
  clearDerivedUiCaches({ resetExplorer: false });
  await loadHistory({ force: true }).catch(() => null);
  mergeForceSyncRecords(result.records);
  await refreshMediaAfterForceSync(payload, result);

  if (payload.mode === "pull") {
    setMessage(`Pull completed: found ${Number(result.found || 0)} watched item${Number(result.found || 0) === 1 ? "" : "s"}; added ${Number(result.imported || 0)} to Plembfin.`, "success");
  } else if (payload.mode === "push") {
    setMessage(`Push completed to ${mediaForceSyncServerLabel(payload.push_to || "all")}: ${Number(result.synced || 0)} item${Number(result.synced || 0) === 1 ? "" : "s"} processed.`, "success");
  } else {
    setMessage(`Full Sync completed: found ${Number(result.found || 0)} watched item${Number(result.found || 0) === 1 ? "" : "s"}; added ${Number(result.imported || 0)} to Plembfin.`, "success");
  }
}

async function pollMediaForceSync(operationId, payload) {
  let missingAttempts = 0;
  while (mediaForceSyncSession?.operationId === operationId) {
    const response = await fetch(`/api/force-sync/media/status?id=${encodeURIComponent(operationId)}`, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (response.status === 404 && missingAttempts < 5) {
      missingAttempts += 1;
      await waitForMediaForceSyncPoll();
      continue;
    }
    if (!response.ok || body.ok === false) throw new Error(body.error || `Force Sync status failed with ${response.status}`);
    missingAttempts = 0;
    renderMediaForceSyncActivity(body);
    if (body.status === "completed" || body.status === "error") {
      await finishMediaForceSyncOperation(payload, body, body.error || "");
      return;
    }
    await waitForMediaForceSyncPoll();
  }
}

async function runMediaForceSync(mode) {
  const session = mediaForceSyncSession;
  if (!session || session.running) return;
  const elements = mediaForceSyncElements();
  const payload = { ...session.payload, mode };
  const pushTarget = elements.pushTarget?.value || "all";
  const pullSource = elements.pullSource?.value || "all";
  if (mode === "push" && pushTarget !== "all") payload.push_to = pushTarget;
  if (mode === "pull" && pullSource !== "all") payload.pull_from = pullSource;
  session.running = true;
  setMediaForceSyncControlsBusy(elements, true);
  if (session.button) {
    session.button.disabled = true;
    session.button.setAttribute("aria-busy", "true");
  }
  elements.activity?.classList.remove("hidden");
  if (elements.terminal) elements.terminal.textContent = `[client] Starting ${mediaForceSyncModeLabel(mode)} for ${payload.title}…`;
  if (elements.activityState) elements.activityState.textContent = "Starting";
  setMessage(`${mediaForceSyncModeLabel(mode)} ${payload.title}…`, "muted");

  try {
    const response = await fetch("/api/force-sync/media", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw new Error(body.error || `Force Sync failed with ${response.status}`);
    session.operationId = body.operationId;
    await pollMediaForceSync(body.operationId, payload);
  } catch (error) {
    const message = error.message || String(error);
    await finishMediaForceSyncOperation(payload, {
      status: "error",
      error: message,
      lines: [{ at: Date.now(), level: "error", text: message }],
    }, message);
  }
}

function mergeForceSyncRecords(records = []) {
  if (!Array.isArray(records) || !records.length) return;
  const historyById = new Map((state.history || []).filter((row) => row?.id).map((row) => [String(row.id), row]));
  for (const record of records) {
    if (record?.id) historyById.set(String(record.id), record);
  }
  state.history = [...historyById.values()];
}

async function refreshMediaAfterForceSync(payload, body) {
  const records = Array.isArray(body.records) ? body.records : [];
  if (payload.type === "show") {
    if (state.activeShowModalKey) {
      await renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason, state.activeShowModalEpisode);
    } else if (state.activeShowRenderContext?.show) {
      renderShowModalContent(state.activeShowRenderContext.show, {
        ...state.activeShowRenderContext,
        activeSeasonNum: state.activeShowModalSeason,
      });
    }
    return;
  }

  const movieRecord = records.find((record) => record?.media_type === "movie")
    || state.history.find((record) => record?.media_type === "movie" && (
      (payload.tmdb_id && String(record.tmdb_id || "") === String(payload.tmdb_id))
      || (payload.title && String(record.title || "").trim().toLowerCase() === String(payload.title).trim().toLowerCase())
    ));
  const tmdbId = movieRecord?.tmdb_id || payload.tmdb_id || state.activeMovieTmdbId || "";
  if (!movieRecord && !tmdbId) return;
  if (state.activeMovieTmdbId && tmdbId && String(state.activeMovieTmdbId) !== String(tmdbId)) return;
  const movie = await fetchWatchedMovieByTmdb(tmdbId, movieRecord?.title || payload.title);
  if (movie) {
    await renderMovieImmersiveModalContent(movie);
  } else if (movieRecord) {
    await renderMovieImmersiveModalContent(movieRecord);
  }
}

// Click delegation for the media-detail modal / immersive views: cast,
// trailers, poster/date/match editing, watch actions, and card navigation.
// Extracted verbatim from app-events.js's attachEvents() (was a single
// ~520-line addEventListener callback) to keep app-events.js under the
// module size limit; behavior is unchanged.
export function attachMediaDetailEvents() {
  document.addEventListener("click", async (event) => {
    // Only dropdowns inside a "collapsed" actions bar are real popup menus.
    // When the bar isn't collapsed, its dropdown is forced open so its
    // contents render flattened inline (see syncMediaActionsMenuState) and
    // must not be closed by an outside click.
    const openDropdowns = document.querySelectorAll("#mediaDetailActions.actions-collapsed .actions-more-dropdown[open]");
    for (const dropdown of openDropdowns) {
      if (!dropdown.contains(event.target)) {
        dropdown.removeAttribute("open");
      }
    }

    const mediaImageCard = event.target.closest(".media-image-card[data-lightbox-src]");
    if (mediaImageCard) {
      const row = mediaImageCard.closest(".media-images-scroll-row");
      const cards = row ? [...row.querySelectorAll(".media-image-card[data-lightbox-src]")] : [mediaImageCard];
      const srcs = cards.map((c) => c.dataset.lightboxSrc);
      const index = parseInt(mediaImageCard.dataset.lightboxIndex, 10) || 0;
      window.openPhotoLightbox(srcs, index);
      return;
    }

    const nowPlayingCard = event.target.closest("[data-now-playing-href]");
    if (nowPlayingCard) {
      navigateTo(nowPlayingCard.dataset.nowPlayingHref);
      return;
    }

    const retryBtn = event.target.closest("[data-retry-sync-id]");
    if (retryBtn) {
      triggerRetrySync(retryBtn.dataset.retrySyncId, retryBtn).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const forceSyncRunButton = event.target.closest("[data-media-force-sync-run]");
    if (forceSyncRunButton) {
      event.preventDefault();
      runMediaForceSync(forceSyncRunButton.dataset.mediaForceSyncRun).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const forceSyncCloseButton = event.target.closest("#closeMediaForceSyncModalButton");
    if (forceSyncCloseButton) {
      event.preventDefault();
      closeMediaForceSyncDialog();
      return;
    }

    if (event.target === document.querySelector("#mediaForceSyncModal")) {
      closeMediaForceSyncDialog();
      return;
    }

    const forceSyncButton = event.target.closest("[data-media-force-sync]");
    if (forceSyncButton) {
      event.preventDefault();
      openMediaForceSyncDialog(forceSyncButton);
      return;
    }

    const mediaInfoTrigger = event.target.closest("[data-media-info]");
    if (mediaInfoTrigger) {
      event.preventDefault();
      openMediaInfoModal();
      return;
    }

    const watchHistoryToggle = event.target.closest("[data-watch-history-toggle]");
    if (watchHistoryToggle) {
      const history = watchHistoryToggle.closest(".movie-rewatch-history");
      if (history) {
        const expanded = history.classList.toggle("is-expanded");
        watchHistoryToggle.setAttribute("aria-expanded", String(expanded));
        watchHistoryToggle.querySelector(".watch-history-toggle-icon").textContent = expanded ? "▲" : "▼";
        watchHistoryToggle.querySelector(".watch-history-toggle-label").textContent = expanded ? "Show less" : "Show more";
        const toggleItem = watchHistoryToggle.closest(".watch-history-toggle-item");
        if (toggleItem) toggleItem.hidden = false;
        if (!expanded) syncRewatchHistoryToggle(history);
      }
      return;
    }

    const editDateBtn = event.target.closest(".media-edit-date-btn");
    if (editDateBtn) {
      const container = editDateBtn.closest(".immersive-container, .modal-body") || document.body;
      const currentEntry = state.history.find((h) => h.id === editDateBtn.dataset.editId);
      openEditDateDialog(container, editDateBtn.dataset.editId, editDateBtn.dataset.watchedAt, async ({ watched_at }) => {
        editDateBtn.dataset.watchedAt = watched_at;
        const span = container.querySelector(".progress-label-row span");
        if (span) span.textContent = `Watched on ${formatDate(watched_at)}`;
        const entry = applyWatchedAtToLocalWatchRecord(editDateBtn.dataset.editId, watched_at)
          || state.history.find((h) => h.id === editDateBtn.dataset.editId);
        if (entry) {
          if (entry.media_type === "episode") {
            const showTitle = entry.show_title || showTitleFrom(entry.title);
            if (showTitle) {
              await refreshShowAfterManualWatch(showTitle);
              if (state.activeShowModalKey) {
                await renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
              }
            }
          } else if (entry.media_type === "movie") {
            // Re-fetch from /api/movies (not /api/history?id=) so the refreshed
            // modal gets the deduped movie record with its playHistory array -
            // a raw watch_history row doesn't carry other watch dates for the
            // rewatch summary.
            await refreshActiveMovieAfterDateEdit(entry);
          }
        } else {
          await refreshActiveMovieAfterDateEdit();
          await refreshActiveShowAfterDateEdit();
        }
        if (state.activeView === "history") {
          renderHistoryView();
        }
      }, editDateOptionsFromButton(editDateBtn, currentEntry));
      return;
    }

    const editImageBtn = event.target.closest(".media-edit-image-btn");
    if (editImageBtn) {
      const container = editImageBtn.closest(".immersive-container, .modal-body") || document.body;
      const id = editImageBtn.dataset.editId;
      // Resolve tmdbData - check both movie and TV caches
      let tmdbData = null;
      const entry = state.history.find((h) => h.id === id) || state.moviesRaw.find((m) => m.id === id);
      if (entry) {
        const movieKey = `movie|${entry.tmdb_id || ""}|${String(entry.title || "").toLowerCase()}`;
        const cached = state.tmdbDetailsCache.get(movieKey);
        if (cached && !(cached instanceof Promise)) tmdbData = cached;
      }
      if (!tmdbData && state.activeMovieModalId && String(state.activeMovieModalId) === String(id)) {
        const tmdbId = state.activeMovieTmdbId;
        if (tmdbId) {
          const prefix = `movie|${tmdbId}|`;
          for (const [key, cached] of state.tmdbDetailsCache.entries()) {
            if (key.startsWith(prefix) && cached && !(cached instanceof Promise)) {
              tmdbData = cached;
              break;
            }
          }
          if (!tmdbData) {
            tmdbData = {
              id: Number(tmdbId),
              title: entry?.title || "",
              media_type: "movie"
            };
          }
        }
      }
      if (!tmdbData && state.activeShowModalKey) {
        const show = state.showsRaw.find((s) => slug(s.title) === state.activeShowModalKey);
        if (show) {
          const tvKey = `tv|${show.tmdb_id || ""}|${String(show.title || "").toLowerCase()}`;
          const cached = state.tmdbDetailsCache.get(tvKey);
          if (cached && !(cached instanceof Promise)) tmdbData = cached;
          if (!tmdbData && show.tmdb_id) {
            tmdbData = {
              id: show.tmdb_id,
              name: show.title,
              media_type: "tv",
              tvdb_id: show.tvdb_id || show.representative_episode?.tvdb_id || "",
            };
          } else if (tmdbData) {
            tmdbData = {
              ...tmdbData,
              media_type: "tv",
              tvdb_id: tmdbData.tvdb_id || tmdbData.external_ids?.tvdb_id || show.tvdb_id || show.representative_episode?.tvdb_id || "",
            };
          }
        }
      }
      if (!tmdbData && entry?.tmdb_id && entry.media_type === "movie") {
        tmdbData = { id: entry.tmdb_id, title: entry.title, media_type: "movie" };
      }
      const imageDialogTitle = editImageBtn.dataset.title || tmdbData?.title || tmdbData?.name || entry?.title || "";
      openEditImageDialog(container, id, editImageBtn.dataset.posterUrl, tmdbData, ({ poster_url, logo_url, backdrop_url, youtube_url, storage_url, updated_ids }) => {
        if (poster_url) {
          editImageBtn.dataset.posterUrl = poster_url;
          const posterImg = container.querySelector(".immersive-poster-img");
          if (posterImg) posterImg.src = poster_url;
          const backdrop = container.querySelector(".modal-backdrop-image");
          if (backdrop) backdrop.style.backgroundImage = `url('${poster_url}')`;
          // The backend cached the chosen poster and propagated it to every
          // related record. Point the client poster cache at that stored image
          // so the dashboard and explorer cards (which resolve posters by record
          // id) pick it up instead of the previously cached artwork.
          if (storage_url && isCachedStorageImageUrl(storage_url)) {
            for (const updatedId of (Array.isArray(updated_ids) ? updated_ids : [id])) {
              rememberPosterLookup(String(updatedId), storage_url);
            }
          }
        }
        if (logo_url !== undefined) {
          editImageBtn.dataset.logoUrl = logo_url;
          const meta = container.querySelector(".immersive-meta");
          if (meta) {
            let logoEl = meta.querySelector(".immersive-logo");
            const titleEl = meta.querySelector(".immersive-title");
            // An empty proxy URL means the artwork is known to be unfetchable,
            // so treat it the same as having no logo at all.
            const logoSrc = logo_url ? proxiedArtworkUrl(logo_url, "logo") : "";
            if (logoSrc) {
              if (logoEl) {
                logoEl.src = logoSrc;
              } else {
                logoEl = document.createElement("img");
                logoEl.className = "immersive-logo";
                logoEl.alt = titleEl?.textContent || "";
                logoEl.src = logoSrc;
                meta.insertBefore(logoEl, titleEl);
              }
              titleEl?.classList.add("sr-only");
            } else {
              logoEl?.remove();
              titleEl?.classList.remove("sr-only");
            }
          }
        }
        if (backdrop_url !== undefined) {
          editImageBtn.dataset.backdropUrl = backdrop_url;
          const backdrop = container.querySelector(".modal-backdrop-image");
          if (backdrop) backdrop.style.backgroundImage = `url('${backdrop_url}')`;
        }
        if (youtube_url !== undefined) {
          editImageBtn.dataset.youtubeUrl = youtube_url;
        }
      }, { title: imageDialogTitle });
      return;
    }

    const editShowDateBtn = event.target.closest(".media-edit-show-date-btn");
    if (editShowDateBtn) {
      const fallbackRows = state.showModalEpisodes.map((episode) => episode.watched).filter(Boolean);
      openEditShowDateDialog(editShowDateBtn.dataset.showTitle || "", fallbackRows);
      return;
    }

    const fixMatchBtn = event.target.closest(".media-fix-match-btn");
    if (fixMatchBtn) {
      const container = fixMatchBtn.closest(".immersive-container, .modal-body") || document.body;
      const mediaType = fixMatchBtn.dataset.mediaType;
      openFixMatchDialog(container, fixMatchBtn.dataset.editId, fixMatchBtn.dataset.title, mediaType, async ({ tmdb_id, tvdb_id, title }) => {
        state.tmdbDetailsCache.clear();
        state.tmdbSeasonCache.clear();
        const syncJobCard = fixMatchBtn.closest(".sync-job-card");
        const inSyncIssues = fixMatchBtn.closest("#syncIssuesContainer, #syncMatchReportContainer");
        if (syncJobCard || inSyncIssues) {
          setMessage("Match updated. Retrying sync...", "info");
          triggerRetrySync(fixMatchBtn.dataset.editId, fixMatchBtn).catch(() => {
            loadSyncJobs({ force: true }).catch(() => null);
            loadSyncHistory({ force: true }).catch(() => null);
          }).then(() => {
            if (inSyncIssues) window.dispatchEvent(new Event("sync-match-report-refresh"));
          });
        } else if (mediaType === "movie") {
          const movie = state.history.find((h) => h.id === fixMatchBtn.dataset.editId);
          if (movie) {
            movie.tmdb_id = tmdb_id;
            movie.poster_url = "";
            movie.logo_url = "";
            movie.backdrop_url = "";
          }
          try {
            const res = await fetch(`/api/history?id=${encodeURIComponent(fixMatchBtn.dataset.editId)}`, { headers: authHeaders(), cache: "no-store" });
            const body = await res.json().catch(() => ({}));
            const freshMovie = body.row || movie;
            if (freshMovie) {
              freshMovie.tmdb_id = tmdb_id;
              await renderMovieImmersiveModalContent(freshMovie);
            }
          } catch {
            if (movie) await renderMovieImmersiveModalContent(movie);
          }
        } else if (state.activeShowModalKey) {
          const showTitle = fixMatchBtn.dataset.title || title || "";
          const show = state.showsRaw.find((s) => slug(s.title) === state.activeShowModalKey);
          if (show) {
            show.tmdb_id = tmdb_id;
            show.tvdb_id = tvdb_id || show.tvdb_id;
            show.poster_url = "";
            show.logo_url = "";
            show.backdrop_url = "";
          }
          if (showTitle) await refreshShowAfterManualWatch(showTitle).catch(() => null);
          await openShowInlineDetail(state.activeShowModalKey, state.activeShowModalSeason, state.activeShowModalEpisode).catch(() => { });
        }

        // The match response updates the detail view, but the explorer and
        // dashboard may already contain rendered cards backed by old rows.
        // Drop those snapshots and immediately repopulate the visible view so
        // the new poster and metadata are visible without navigation/reload.
        clearDerivedUiCaches({ resetExplorer: true });
        if (state.activeView === "explorer" && !state.mediaDetailInline) {
          renderExplorer();
        } else if (state.activeView === "dashboard") {
          loadHistory({ force: true }).catch(() => null);
        }
      });
      return;
    }

    const removeHistoryBtn = event.target.closest(".media-remove-history-btn");
    if (removeHistoryBtn) {
      const id = removeHistoryBtn.dataset.deleteHistoryId;
      if (!id) return;
      const confirmed = await openConfirmDialog({
        title: "Remove unmatched entry?",
        body: "This removes the local Plembfin watch record only. It will not affect Plex, Emby or Jellyfin.",
        confirmLabel: "Continue",
        cancelLabel: "Keep entry",
        danger: true,
      });
      if (!confirmed) return;
      const finalConfirmed = await openConfirmDialog({
        title: "This cannot be undone",
        body: "The episode, watch date and local history for this unmatched entry will be permanently deleted. Continue?",
        confirmLabel: "Remove permanently",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!finalConfirmed) return;
      removeHistoryBtn.disabled = true;
      try {
        const response = await fetch("/api/delete-history-record", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ id, confirm: "DELETE" }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Remove failed (${response.status})`);
        state.history = state.history.filter((row) => String(row.id || "") !== String(id));
        state.showsRaw = state.showsRaw.filter((show) => String(show.unmatched_history_id || "") !== String(id));
        clearDerivedUiCaches({ resetExplorer: true });
        setMessage("Unmatched watch entry removed.", "success");
        closeMediaDetail();
        if (state.activeView === "explorer" && !state.mediaDetailInline) renderExplorer();
        else if (state.activeView === "history") renderHistoryView();
      } catch (error) {
        removeHistoryBtn.disabled = false;
        setMessage(`Remove failed: ${error.message}`, "error");
      }
      return;
    }

    const mergeShowBtn = event.target.closest(".media-merge-show-btn");
    if (mergeShowBtn) {
      openMergeShowDialog(mergeShowBtn.dataset.showTitle);
      return;
    }

    const editDateIconBtn = event.target.closest(".edit-date-icon-btn");
    if (editDateIconBtn) {
      const id = editDateIconBtn.dataset.editId;
      const currentEntry = state.history.find((h) => h.id === id);
      openEditDateDialog(null, id, editDateIconBtn.dataset.watchedAt, async ({ watched_at }) => {
        editDateIconBtn.dataset.watchedAt = watched_at;
        // Update the time element this icon is inside
        const timeEl = editDateIconBtn.closest("time");
        if (timeEl) timeEl.innerHTML = `Watched ${formatDate(watched_at)} <button class="edit-date-icon-btn" type="button" title="Edit watch date" data-edit-id="${escapeAttribute(id)}" data-watched-at="${escapeAttribute(watched_at)}">✎</button>`;
        // Also update movie watch status row if present
        const span = editDateIconBtn.closest(".progress-label-row")?.querySelector("span");
        if (span) span.innerHTML = `Watched on ${formatDate(watched_at)} <button class="edit-date-icon-btn" type="button" title="Edit watch date" data-edit-id="${escapeAttribute(id)}" data-watched-at="${escapeAttribute(watched_at)}">✎</button>`;
        const entry = applyWatchedAtToLocalWatchRecord(id, watched_at)
          || state.history.find((h) => h.id === id);
        if (entry) {
          if (entry.media_type === "episode") {
            const showTitle = entry.show_title || showTitleFrom(entry.title);
            if (showTitle) {
              refreshShowAfterManualWatch(showTitle).then(() => {
                if (state.activeShowModalKey) {
                  renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
                }
              });
            }
          } else if (entry.media_type === "movie") {
            // Re-fetch from /api/movies (not /api/history?id=) so the refreshed
            // modal gets the deduped movie record with its playHistory array -
            // a raw watch_history row doesn't carry other watch dates for the
            // rewatch summary.
            await refreshActiveMovieAfterDateEdit(entry);
          }
        } else {
          await refreshActiveMovieAfterDateEdit();
          await refreshActiveShowAfterDateEdit();
        }
        if (state.activeView === "history") {
          renderHistoryView();
        }
      }, editDateOptionsFromButton(editDateIconBtn, currentEntry));
      return;
    }

    const availIssueEl = event.target.closest("[data-avail-issue]");
    if (availIssueEl) {
      showAvailIssuePopup(availIssueEl);
      return;
    }


    const settingsLink = event.target.closest("[data-settings-link]");
    if (settingsLink) {
      event.preventDefault();
      selectSettingsTab(settingsLink.dataset.settingsLink);
      return;
    }

    const copyButton = event.target.closest("[data-copy]");
    if (copyButton) {
      copyToClipboard(copyButton.dataset.copy);
      return;
    }

    const watchDateCancel = event.target.closest("[data-watch-date-cancel]");
    if (watchDateCancel) {
      event.preventDefault();
      closeWatchDatePrompt();
      return;
    }

    const watchDateChoice = event.target.closest("[data-watch-date-choice]");
    if (watchDateChoice) {
      event.preventDefault();
      applyWatchDateChoice(watchDateChoice.dataset.watchDateChoice).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const editSeasonDateBtn = event.target.closest("[data-edit-season-date]");
    if (editSeasonDateBtn) {
      const seasonNum = Number(editSeasonDateBtn.dataset.editSeasonDate);
      const seasonEpisodes = state.showModalEpisodes.filter((ep) => ep.seasonNumber === seasonNum);
      const watchedEpisodes = seasonEpisodes
        .filter((ep) => ep.watched)
        .map((ep) => ({ ...ep.watched, release_date: ep.airDate || "" }));
      if (!watchedEpisodes.length) {
        setMessage("No watched episodes in this season to update.", "error");
        return;
      }
      const showTitle = seasonEpisodes[0]?.showTitle || "";
      openEditSeasonDateDialog(showTitle, seasonNum, watchedEpisodes);
      return;
    }

    const movieWatchButton = event.target.closest("[data-movie-mark-watched]");
    if (movieWatchButton) {
      markMovieWatched({
        tmdbId: movieWatchButton.dataset.movieMarkWatched,
        title: movieWatchButton.dataset.movieTitle,
        posterUrl: movieWatchButton.dataset.moviePoster,
        releaseDate: movieWatchButton.dataset.movieRelease,
      });
      return;
    }

    const seerrBtn = event.target.closest("[data-seerr-media-type]");
    if (seerrBtn) {
      const mediaType = seerrBtn.dataset.seerrMediaType;
      const mediaId = Number(seerrBtn.dataset.seerrMediaId);
      if (mediaType === "tv" && !seerrBtn.hasAttribute("data-seerr-season")) {
        openSeerrSeasonRequestDialog(mediaType, mediaId, { is4k: seerrBtn.getAttribute("data-seerr-request-4k") === "true" });
      } else {
        submitSeerrRequest(mediaType, mediaId, seerrBtn);
      }
      return;
    }

    const unwatchButton = event.target.closest("[data-unwatch-id]");
    if (unwatchButton) {
      confirmAndMarkUnwatched(unwatchButton).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const deleteMediaButton = event.target.closest("[data-delete-media-id]");
    if (deleteMediaButton) {
      confirmAndDeleteMedia(deleteMediaButton).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const backBtn = event.target.closest(".immersive-back-button");
    if (backBtn) {
      if (state.internalHistoryCount > 0) {
        window.history.back();
      } else {
        closeMediaDetail();
      }
      return;
    }

    const toggleEpisodes = event.target.closest("[data-immersive-toggle-episodes]");
    if (toggleEpisodes) {
      const list = document.querySelector("#immersiveEpisodeList");
      if (list) list.classList.toggle("hidden");
      return;
    }

    const seasonAccordion = event.target.closest("[data-season-accordion]");
    if (seasonAccordion) {
      event.preventDefault();
      const seasonNum = Number(seasonAccordion.dataset.seasonAccordion);
      const wasAllExpanded = state.showModalAllSeasonsExpanded;
      const currentSeason = state.activeShowModalSeason == null ? null : Number(state.activeShowModalSeason);
      // Clicking an individual season while "expand all" is active means the
      // user wants to focus on just this one - drop out of "all" mode instead
      // of leaving every season open underneath it.
      const shouldClose = !wasAllExpanded && currentSeason === seasonNum;
      const nextSeason = shouldClose ? null : seasonNum;
      const scrollY = window.scrollY;
      state.showModalAllSeasonsExpanded = false;
      state.activeShowModalSeason = nextSeason;
      const ctx = state.activeShowRenderContext;
      if (ctx?.show) {
        renderShowModalContent(ctx.show, {
          ...ctx,
          activeSeasonNum: nextSeason,
          activeEpisodeNum: null,
        });
        requestAnimationFrame(() => window.scrollTo({ top: scrollY, left: 0, behavior: "auto" }));
      }
      const nextUrl = state.activeShowModalKey
        ? (nextSeason != null ? `/tvshow/${state.activeShowModalKey}#season${nextSeason}` : `/tvshow/${state.activeShowModalKey}`)
        : state.activeShowTmdbId
          ? (nextSeason != null ? `/tvshow/tmdb/${state.activeShowTmdbId}#season${nextSeason}` : `/tvshow/tmdb/${state.activeShowTmdbId}`)
          : "";
      if (nextUrl) {
        window.history.replaceState({}, "", nextUrl);
      }
      return;
    }

    const toggleAllSeasons = event.target.closest("[data-toggle-all-seasons]");
    if (toggleAllSeasons) {
      event.preventDefault();
      state.showModalAllSeasonsExpanded = !state.showModalAllSeasonsExpanded;
      if (!state.showModalAllSeasonsExpanded) {
        state.activeShowModalSeason = null;
      }
      const ctx = state.activeShowRenderContext;
      if (ctx?.show) {
        renderShowModalContent(ctx.show, {
          ...ctx,
          activeSeasonNum: state.activeShowModalSeason,
          activeEpisodeNum: null,
        });
      }
      return;
    }

    const watchButton = event.target.closest("[data-watch-scope]");
    if (watchButton) {
      event.preventDefault();
      openWatchDatePrompt(watchActionFromButton(watchButton));
      return;
    }

    const episodeRow = event.target.closest("[data-immersive-episode-num]");
    if (episodeRow) {
      if (event.target.closest("button") || event.target.closest("a") || event.target.closest(".avail-pill")) {
        return;
      }
      event.preventDefault();
      const episodeNum = Number(episodeRow.dataset.immersiveEpisodeNum);
      const seasonNum = Number(episodeRow.dataset.immersiveSeasonNum);
      const shouldClear = Number(state.activeShowModalEpisode) === episodeNum && Number(state.activeShowModalSeason) === seasonNum;
      state.activeShowModalSeason = seasonNum;
      state.activeShowModalEpisode = shouldClear ? null : episodeNum;
      const ctx = state.activeShowRenderContext;
      if (ctx?.show) {
        renderShowModalContent(ctx.show, {
          ...ctx,
          activeSeasonNum: seasonNum,
          activeEpisodeNum: state.activeShowModalEpisode,
        });
      }
      const baseUrl = state.activeShowModalKey
        ? `/tvshow/${state.activeShowModalKey}`
        : state.activeShowTmdbId
          ? `/tvshow/tmdb/${state.activeShowTmdbId}`
          : "";
      if (baseUrl) {
        const hash = state.activeShowModalEpisode == null ? `#season${seasonNum}` : `#season${seasonNum}ep${episodeNum}`;
        window.history.replaceState({}, "", `${baseUrl}${hash}`);
      }
      return;
    }

    const recMovieCard = event.target.closest("[data-immersive-movie-id]");
    if (recMovieCard && event.button === 0 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      navigateTo(`/movie/tmdb/${recMovieCard.dataset.immersiveMovieId}`);
      return;
    }

    const relatedShowCard = event.target.closest("[data-immersive-related-tmdb]");
    if (relatedShowCard && event.button === 0 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      navigateTo(`/tvshow/tmdb/${relatedShowCard.dataset.immersiveRelatedTmdb}`);
      return;
    }

    const libraryItemCard = event.target.closest("a[data-library-item-type]");
    if (libraryItemCard && event.button === 0 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      window.openLibraryItem(libraryItemCard.dataset.libraryItemType, libraryItemCard.dataset.libraryItemId, libraryItemCard.dataset.libraryItemTitle, true, null);
      return;
    }

    const tmdbItemCard = event.target.closest("a[data-tmdb-id]");
    if (tmdbItemCard && event.button === 0 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      window.openLibraryItem(tmdbItemCard.dataset.tmdbMediaType, null, tmdbItemCard.dataset.tmdbTitle, false, tmdbItemCard.dataset.tmdbId);
      return;
    }

    const provenanceTrigger = event.target.closest("[data-history-debug-id]");
    if (provenanceTrigger) {
      event.preventDefault();
      openHistoryDebugModal(provenanceTrigger.dataset.historyDebugId).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const historyRow = event.target.closest("[data-history-id]");
    if (historyRow) {
      if (event.target.closest("[data-sync-status-dot]")) {
        openHistoryDebugModal(historyRow.dataset.historyId).catch((error) => setMessage(error.message, "error"));
        return;
      }
      if (historyRow.classList.contains("history-mini-card") && event.button === 0 && !event.ctrlKey && !event.metaKey) {
        const href = historyRow.getAttribute("href");
        if (href) {
          event.preventDefault();
          navigateTo(href);
          return;
        }
      }
      if (event.target.closest("#historyPanel") && event.button === 0 && !event.ctrlKey && !event.metaKey) {
        const href = historyRow.getAttribute("href");
        if (href) {
          event.preventDefault();
          navigateTo(href);
          return;
        }
      }
      const isTvRow = event.target.closest("#tvHistoryRow");
      if (isTvRow && event.button === 0 && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        const entry = state.history.find(e => e.id === historyRow.dataset.historyId);
        if (entry) {
          const canonicalShowName = entry.show_title || showName(entry.title);
          const showKeySlug = slug(canonicalShowName);
          let showObj = state.showsRaw.find(s => slug(s.title) === showKeySlug);
          if (!showObj) {
            showObj = { title: canonicalShowName, id: entry.tvdb_id || entry.tmdb_id || canonicalShowName };
            state.showsRaw.push(showObj);
          }

          navigateTo(`/tvshow/${showKeySlug}`);
        }
      } else if (event.target.closest(".movie-card") && event.button === 0 && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        navigateTo(movieHref(movieBySlugOrId(historyRow.dataset.historyId) || { id: historyRow.dataset.historyId }));
      } else if (historyRow.tagName === "A" && historyRow.getAttribute("href") && event.button === 0 && !event.ctrlKey && !event.metaKey) {
        // Any other anchor-based history card (e.g. the dashboard's
        // page-style watch-history cards) - navigate via the SPA router
        // instead of falling through to the debug modal below, which left
        // preventDefault() uncalled and let the browser's native link
        // navigation fire a full page reload.
        event.preventDefault();
        navigateTo(historyRow.getAttribute("href"));
      } else if (!event.target.closest(".movie-card")) {
        openHistoryDebugModal(historyRow.dataset.historyId).catch((error) => setMessage(error.message, "error"));
      }
      return;
    }

    const showTrigger = event.target.closest("[data-show-key]");
    if (showTrigger) {
      // The poster grid renders this trigger as a real <a> so the card keeps a
      // copyable URL and can be middle-clicked or opened in a new tab. Leave
      // those gestures to the browser and take over only the plain left-click,
      // which otherwise followed the href and reloaded the whole document.
      if (showTrigger.tagName === "A") {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
      }
      const recordId = showTrigger.dataset.showRecordId;
      if (recordId) {
        state.pendingShowHistoryId = recordId;
        state.activeShowHistoryId = recordId;
      }
      navigateTo(`/tvshow/${showTrigger.dataset.showKey}${recordId ? `?historyId=${encodeURIComponent(recordId)}` : ""}`);
      return;
    }

    const seasonTrigger = event.target.closest("[data-season-key]");
    if (seasonTrigger) {
      toggleSet(state.expandedSeasons, seasonTrigger.dataset.seasonKey);
      if (state.activeShowModalKey) {
        if (state.mediaDetailInline) {
          let url = `/tvshow/${state.activeShowModalKey}`;
          if (state.activeShowModalSeason !== null) {
            url += `#season${state.activeShowModalSeason}`;
          }
          navigateTo(url);
        } else {
          renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
        }
      } else {
        renderExplorer();
      }
      return;
    }
  });
}
