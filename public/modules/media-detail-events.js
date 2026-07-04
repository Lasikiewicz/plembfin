import { state } from "./state.js";
import { escapeAttribute, formatDate, showTitleFrom, showName, slug, movieHref } from "./utils.js";
import { isCachedStorageImageUrl, rememberPosterLookup } from "./images.js";
import {
  openEditDateDialog,
  openEditShowDateDialog,
  openEditImageDialog,
  openFixMatchDialog,
  openMergeShowDialog,
  openEditSeasonDateDialog,
  applyWatchedAtToLocalWatchRecord,
  editDateOptionsFromButton,
} from "./edit-dialogs.js";
import {
  rerenderWatchDateCustomPicker,
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
} from "./watch-action.js";
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
} from "./media-detail.js?v=20260701";

// Callbacks injected by app-events.js (forwarded from app.js) to avoid circular imports.
let _cb = {};
export function initMediaDetailEvents(callbacks = {}) {
  _cb = callbacks;
}

const navigateTo = (...args) => _cb.navigateTo?.(...args);
const setMessage = (...args) => _cb.setMessage?.(...args);
const authHeaders = (...args) => _cb.authHeaders?.(...args);
const selectSettingsTab = (...args) => _cb.selectSettingsTab?.(...args);
const copyToClipboard = (...args) => _cb.copyToClipboard?.(...args);
const toggleSet = (...args) => _cb.toggleSet?.(...args);

// Click delegation for the media-detail modal / immersive views: cast,
// trailers, poster/date/match editing, watch actions, and card navigation.
// Extracted verbatim from app-events.js's attachEvents() (was a single
// ~520-line addEventListener callback) to keep app-events.js under the
// module size limit; behavior is unchanged.
export function attachMediaDetailEvents() {
  document.addEventListener("click", (event) => {
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

    const editDateBtn = event.target.closest(".media-edit-date-btn");
    if (editDateBtn) {
      const container = editDateBtn.closest(".immersive-container, .modal-body") || document.body;
      const currentEntry = state.history.find((h) => h.id === editDateBtn.dataset.editId);
      openEditDateDialog(container, editDateBtn.dataset.editId, editDateBtn.dataset.watchedAt, ({ watched_at }) => {
        editDateBtn.dataset.watchedAt = watched_at;
        const span = container.querySelector(".progress-label-row span");
        if (span) span.textContent = `Watched on ${formatDate(watched_at)}`;
        const entry = applyWatchedAtToLocalWatchRecord(editDateBtn.dataset.editId, watched_at)
          || state.history.find((h) => h.id === editDateBtn.dataset.editId);
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
          } else if (entry.media_type === "movie" && state.activeMovieModalId && String(entry.id) === String(state.activeMovieModalId)) {
            fetch(`/api/history?id=${encodeURIComponent(entry.id)}`, { headers: authHeaders() })
              .then(res => res.json())
              .then(body => {
                if (body.row) {
                  renderMovieImmersiveModalContent(body.row).catch(() => {});
                }
              });
          }
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
      // Resolve tmdbData — check both movie and TV caches
      let tmdbData = null;
      const entry = state.history.find((h) => h.id === id);
      if (entry) {
        const movieKey = `movie|${entry.tmdb_id || ""}|${String(entry.title || "").toLowerCase()}`;
        const cached = state.tmdbDetailsCache.get(movieKey);
        if (cached && !(cached instanceof Promise)) tmdbData = cached;
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
            if (logo_url) {
              if (logoEl) {
                logoEl.src = logo_url;
              } else {
                logoEl = document.createElement("img");
                logoEl.className = "immersive-logo";
                logoEl.alt = titleEl?.textContent || "";
                logoEl.src = logo_url;
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
      });
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
      openFixMatchDialog(container, fixMatchBtn.dataset.editId, fixMatchBtn.dataset.title, mediaType, ({ tmdb_id }) => {
        state.tmdbDetailsCache.clear();
        const syncJobCard = fixMatchBtn.closest(".sync-job-card");
        const inSyncIssues = fixMatchBtn.closest("#syncIssuesContainer");
        if (syncJobCard || inSyncIssues) {
          setMessage("Match updated. Retrying sync...", "info");
          triggerRetrySync(fixMatchBtn.dataset.editId, fixMatchBtn).catch(() => {
            loadSyncJobs({ force: true }).catch(() => null);
            loadSyncHistory({ force: true }).catch(() => null);
          });
        } else if (mediaType === "movie") {
          const movie = state.history.find((h) => h.id === fixMatchBtn.dataset.editId);
          if (movie) { movie.tmdb_id = tmdb_id; renderMovieImmersiveModalContent(movie).catch(() => { }); }
        } else if (state.activeShowModalKey) {
          const show = state.showsRaw.find((s) => slug(s.title) === state.activeShowModalKey);
          if (show) { show.tmdb_id = tmdb_id; openShowInlineDetail(state.activeShowModalKey, state.activeShowModalSeason, state.activeShowModalEpisode).catch(() => { }); }
        }
      });
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
      openEditDateDialog(null, id, editDateIconBtn.dataset.watchedAt, ({ watched_at }) => {
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
          } else if (entry.media_type === "movie" && state.activeMovieModalId && String(entry.id) === String(state.activeMovieModalId)) {
            fetch(`/api/history?id=${encodeURIComponent(entry.id)}`, { headers: authHeaders() })
              .then(res => res.json())
              .then(body => {
                if (body.row) {
                  renderMovieImmersiveModalContent(body.row).catch(() => {});
                }
              });
          }
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

    const wdNav = event.target.closest("[data-wd-nav]");
    if (wdNav && state.watchDateCustom) {
      syncCustomTimeFromSelects();
      const dir = wdNav.dataset.wdNav === "next" ? 1 : -1;
      let month = state.watchDateCustom.month + dir;
      let year = state.watchDateCustom.year;
      if (month < 0) { month = 11; year -= 1; }
      if (month > 11) { month = 0; year += 1; }
      state.watchDateCustom.year = year;
      state.watchDateCustom.month = month;
      rerenderWatchDateCustomPicker();
      return;
    }

    const wdDay = event.target.closest("[data-wd-day]");
    if (wdDay && state.watchDateCustom) {
      syncCustomTimeFromSelects();
      const [year, month, day] = wdDay.dataset.wdDay.split("-").map(Number);
      state.watchDateCustom.selected.setFullYear(year, month - 1, day);
      state.watchDateCustom.year = year;
      state.watchDateCustom.month = month - 1;
      rerenderWatchDateCustomPicker();
      return;
    }

    const editSeasonDateBtn = event.target.closest("[data-edit-season-date]");
    if (editSeasonDateBtn) {
      const seasonNum = Number(editSeasonDateBtn.dataset.editSeasonDate);
      const seasonEpisodes = state.showModalEpisodes.filter((ep) => ep.seasonNumber === seasonNum);
      const watchedEpisodes = seasonEpisodes.map((ep) => ep.watched).filter(Boolean);
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
      const currentSeason = state.activeShowModalSeason == null ? null : Number(state.activeShowModalSeason);
      const shouldClose = currentSeason === seasonNum;
      const nextSeason = shouldClose ? null : seasonNum;
      const scrollY = window.scrollY;
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
        // page-style watch-history cards) — navigate via the SPA router
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
      navigateTo(`/tvshow/${showTrigger.dataset.showKey}`);
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
