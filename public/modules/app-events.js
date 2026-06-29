import { buildAuthHeaders, buildNowPlayingUrl, currentUser, getWebhookToken, onAuthChange, readStoredAdminToken, rotateWebhookSecret, scrubTokenFromLocation, signInAdmin, signOutAdmin, updateAdminCredentials } from "./auth.js";
import { appendDebugLog, clearDebugLogs, logsToText, readStoredDebugLogs, fetchDiagnosticLogs, clearDiagnosticLogs as clearBackendDiagnosticLogs } from "./logs.js";
import { connectionLabel, connectionPayloadFromElements } from "./settings.js";
import { state, elements, ACTIVE_VIEW_KEY, ACTIVE_SETTINGS_TAB_KEY, EXPLORER_SORT_KEY_MOVIES, EXPLORER_SORT_KEY_SHOWS, EXPLORER_VIEW_KEY_MOVIES, EXPLORER_VIEW_KEY_SHOWS, HIDE_WATCHED_KEY_SHOWS, HIDE_ENDED_KEY_SHOWS, HISTORY_VIEW_KEY, HISTORY_FILTER_KEY, HISTORY_VIEW_MODES, HISTORY_FILTERS, DASHBOARD_HISTORY_VIEW_KEY, DASHBOARD_HISTORY_VIEW_MODES, PRIMARY_VIEWS, SETTINGS_TABS } from "./state.js";
import { escapeHtml, escapeAttribute, sanitizeTitle, safeImageUrl, slug, movieSlug, movieHref, showName, showTitleFrom, episodeTitle, startOfWeek, addDays, toDateInputValue, toDateTimeInputValue, formatDayName, formatDayDate, formatWeekRange, formatShortTime, formatNumber, formatDate, formatDateShort, shortMonthLabel, normalizePlatformSource, platformName, platformBadge, sourceClass, computeProgress, formatDuration, formatPlaybackClock, formatNowPlayingMeta, idLine, csvRows, normalizeHeader, formatTmdbDate, ordinalDay, formatLongAiringDate, knownShowAirtime, formatEpisodeAirtime, showEpisodeKey, episodeCode, seasonLabel } from "./utils.js";
import { adminTokenGuide, plexCredentialGuide, embyCredentialGuide, jellyfinCredentialGuide, buildWebhookUrl, plexWebhookSetup, embyWebhookSetup, jellyfinWebhookSetup, webhookWarning, cronSyncGuide, renderSettingsInlineHelp } from "./help-content.js";
import { isCachedStorageImageUrl, compactPosterUrl, clearPersistentPosterLookupCache, cachedPosterLookup, rememberPosterLookup, posterServerConfig, configuredImageUrl, posterUrlFor, posterMarkup, posterFallbackElement, lookupPosterUrl, hydratePosterFallbacks, bindPosterImageErrorHandler, hydratePosterImages, hydratePosters, tmdbImage, tmdbPoster, bestTmdbLogo, tmdbProfile } from "./images.js";
import { initTools, APPEARANCE_DEFAULTS, setBackupTransferState, exportPlembfinBackup, readPlembfinBackup, importPlembfinBackup, renderWatchBackups, loadRemoteBackupsForRestoreTab, addBackupDestination, saveBackupDestinationCard, testBackupDestinationCard, removeBackupDestinationCard, listRemoteBackupsForCard, restoreRemoteBackupFromCard, connectBackupDestinationCard, loadCacheStats, renderCachePanel, loadWatchBackups, postWatchBackupAction, applyAppearanceToBody, loadAppearanceSettings, saveAppearanceSettings, saveWatchBackupSettings, createWatchBackupNow, downloadWatchBackup, uploadWatchBackupFile, restoreWatchBackup, parseSelectedFiles, renderImportPreview, renderImportActivity, startImport, runRepairWorkflow, runDedupHistory, runTraktBackfill, runFullSyncWatchstates, runSystemIntegrityCheck, triggerClearMissingTelemetry, triggerRetryAllCategory, appendImportLog } from "./tools.js";
import { initSync, nowPlayingUrl, telemetryLineValue, historyAction, isWatchedHistoryAction, syncStatus, historySyncPill, getActiveTargets, sourcePlatform, normalizeTargetStatus, targetStateUnavailable, targetStateNoop, hasConfirmedMediaAvailability, sharedLibraryAvailability, getMediaTargetSyncStatus, getSyncStatusTone, getSyncStatusTooltip, renderSyncStatusDot, showAvailIssuePopup, renderAvailabilityPills, renderShowAvailabilityPills, renderMediaSyncPills, telemetryTargetStates, syncJobSortWeight, renderTargetPills, syncJobMediaType, syncHistoryTone, syncHistoryActionLabel, syncHistoryTargetPills, categorizeIssues, renderIssueCategory, renderSyncJobs, renderSyncHistory, loadSyncJobs, loadSyncHistory, activeSessionsKey, setActiveSessions, renderActiveSessions, loadActiveSessions, pollNowPlayingOnce, startHistoryPolling, stopHistoryPolling, syncNowPlayingPolling, triggerRetrySync, triggerCronSync, triggerStopSync, triggerForceSync } from "./sync.js";
import { initDashboard, getRowFitLimit, mediaRecordIdentity, dedupeMediaRecords, progressRecordIdentity, dedupePlaybackProgress, renderHistoryCard, observeDashboardPosters, renderDashboard, updateDashboardSplitState, resetPartWatchedView, renderPartWatchedCard, renderPartWatched, loadPartWatched } from "./dashboard.js";
import { initStats, formatListDate, futureListDate, showStatusLabel, nextAiringDateValue, nextAiringCell, statsReports, statsPeriodLabel, syncStatsPeriodOptions, selectedStatsReport, statsFilteredRows, statsPeriodNoun, statsTrackingSpanText, statsPlatformLabel, statsSelectedMediaLabel, statsIntroCards, renderStatsKpis, renderStatsLeaderboard, renderStatsMoviesTvSplit, renderStatsPlatformRows, renderStatsBookends, renderMonthChart, renderStats, renderRankingTable } from "./stats.js";
import { initExplorer, syncExplorerControlsState, syncInlineMediaDetailHeading, triggerSearchPage, renderSearchPage, renderExplorer, explorerQueryKey, updateAlphaFilter, handleAlphaFilterClick, resetMovieExplorer, resetShowExplorer, renderExplorerSentinel, observeExplorerSentinel, observeExplorerTmdbPrefetch, scheduleNextAirResort, currentExplorerView, currentExplorerSort, currentPosterWidthKey, setCurrentExplorerSort, applyExplorerPosterWidth, applyListHeaderSort, renderMovieCard, renderMovieExplorer, loadExplorerMovies, applyHistoryPosterWidth, resetHistoryView, renderHistoryItems, renderHistoryView, loadHistoryView, observeHistorySentinel, renderShowExplorer, loadExplorerShows, mergeShowDetail, loadShowDetail, matchesExplorerSearch, sortExplorerItems, renderShowRecord, renderShowFolder, renderSeasonFolder, seasonsFromShowRecord, representativeEpisode, tmdbLookupIdsFromShow, emptyExplorer, FILMOGRAPHY_PAGE_SIZE, getFilmographyObserver, setFilmographyObserver } from "./explorer.js";
import { initEditDialogs, openEditDateDialog, openEditShowDateDialog, openEditSeasonDateDialog, openEditImageDialog, openFixMatchDialog, openMergeShowDialog, applyWatchedAtToLocalWatchRecord, editDateOptionsFromButton } from "./edit-dialogs.js";
import { initWatchAction, rerenderWatchDateCustomPicker, openWatchDatePrompt, closeWatchDatePrompt, watchActionFromButton, submitSeerrRequest, markMovieWatched, refreshShowAfterManualWatch, applyWatchDateChoice, confirmAndMarkUnwatched, confirmAndDeleteMedia } from "./watch-action.js";
import { fetchTmdbDetails, fetchTmdbSeasonDetails, resolveEpisodeTitleFromTmdb } from "./tmdb.js?v=20260626";
import { initMediaDetail, movieBySlugOrId, nowPlayingHref, openMovieInlineDetail, openShowInlineDetail, clearMediaDetailState, syncMediaActionsMenuState, syncTopbarControlsMenuState, closeDebugModal, closeMediaDetail, renderImmersiveShowModal, renderShowModalContent, renderMovieImmersiveModalContent, openMovieImmersiveModalByTmdbId, openShowImmersiveModalByTmdbId, openHistoryDebugModal, fetchSeerrMediaStatus, refreshActiveMediaDetailAfterSeerrStatus } from "./media-detail.js?v=20260628a";
import { closePersonProfile, loadCastMemberDetails } from "./media-person.js";
import { initMediaLightbox } from "./media-lightbox.js";

let _cb = {};
export function initAppEvents(callbacks = {}) {
  _cb = callbacks;
  attachEvents();
}

const authHeaders = (...args) => _cb.authHeaders?.(...args), setMessage = (...args) => _cb.setMessage?.(...args), unlockWithToken = (...args) => _cb.unlockWithToken?.(...args), clearSearchInputs = (...args) => _cb.clearSearchInputs?.(...args), selectView = (...args) => _cb.selectView?.(...args), testConnection = (...args) => _cb.testConnection?.(...args), renderLogs = (...args) => _cb.renderLogs?.(...args), logsText = (...args) => _cb.logsText?.(...args), copyToClipboard = (...args) => _cb.copyToClipboard?.(...args), selectSettingsTab = (...args) => _cb.selectSettingsTab?.(...args), selectBackupsTab = (...args) => _cb.selectBackupsTab?.(...args), navigateTo = (...args) => _cb.navigateTo?.(...args), renderChangelog = (...args) => _cb.renderChangelog?.(...args), lockDashboard = (...args) => _cb.lockDashboard?.(...args), toggleTheme = (...args) => _cb.toggleTheme?.(...args), showConfirmModal = (...args) => _cb.showConfirmModal?.(...args), closeGlobalSearchDropdown = (...args) => _cb.closeGlobalSearchDropdown?.(...args), saveAdminCredentials = (...args) => _cb.saveAdminCredentials?.(...args), saveSavedConfig = (...args) => _cb.saveSavedConfig?.(...args), saveSectionConfig = (...args) => _cb.saveSectionConfig?.(...args), syncSettingsInputsDisabledState = (...args) => _cb.syncSettingsInputsDisabledState?.(...args), applyActiveView = (...args) => _cb.applyActiveView?.(...args), handleRouting = (...args) => _cb.handleRouting?.(...args), loadHistory = (...args) => _cb.loadHistory?.(...args), loadStats = (...args) => _cb.loadStats?.(...args), loadSavedConfig = (...args) => _cb.loadSavedConfig?.(...args), renderHelp = (...args) => _cb.renderHelp?.(...args), renderDbStatus = (...args) => _cb.renderDbStatus?.(...args), showErrorExplainModal = (...args) => _cb.showErrorExplainModal?.(...args), runRefreshMetadataWorkflow = (...args) => _cb.runRefreshMetadataWorkflow?.(...args), showToast = (...args) => _cb.showToast?.(...args), logDebug = (...args) => _cb.logDebug?.(...args), syncPageTopbar = (...args) => _cb.syncPageTopbar?.(...args), setUnlocked = (...args) => _cb.setUnlocked?.(...args), setConnectionButton = (...args) => _cb.setConnectionButton?.(...args), setConnectionStatus = (...args) => _cb.setConnectionStatus?.(...args), renderSettingsStatus = (...args) => _cb.renderSettingsStatus?.(...args), renderAdminCredentialsStatus = (...args) => _cb.renderAdminCredentialsStatus?.(...args), toggleSet = (...args) => _cb.toggleSet?.(...args), renderGlobalSearchDropdown = (...args) => _cb.renderGlobalSearchDropdown?.(...args), loadGlobalDiscovery = (...args) => _cb.loadGlobalDiscovery?.(...args);

function attachEvents() {
  document.addEventListener("click", (e) => {
    const castCard = e.target.closest("[data-person-id]");
    if (castCard) {
      window.showCastMemberDetails(castCard.dataset.personId, castCard.dataset.personName);
      return;
    }
    const trailer = e.target.closest(".trailer-thumb-container[data-video-key]");
    if (trailer) {
      window.playTrailer(trailer, trailer.dataset.videoKey, trailer.dataset.videoName);
      return;
    }
    const reviewBtn = e.target.closest(".review-toggle-btn");
    if (reviewBtn) {
      const p = reviewBtn.previousElementSibling.querySelector(".review-content");
      p.classList.toggle("expanded");
      reviewBtn.textContent = p.classList.contains("expanded") ? "Show Less" : "Read More";
      return;
    }
    const photoThumb = e.target.closest("[data-photo-index]");
    if (photoThumb) {
      window.openPhotoLightbox(window._personPhotos, parseInt(photoThumb.dataset.photoIndex, 10));
      return;
    }
  });

  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img.tagName !== "IMG") return;
    const mode = img.dataset.err;
    if (!mode) return;
    img.dataset.err = "";
    if (mode === "fav") { img.src = "/favicon.svg"; }
    else if (mode === "hide") { img.style.display = "none"; }
    else if (mode === "hide-parent") { img.parentElement.style.display = "none"; }
    else if (mode === "hide-closest-btn") { img.closest("button").style.display = "none"; }
    else if (mode === "hide-show-next") { img.style.display = "none"; img.nextElementSibling.style.display = "inline-grid"; }
  }, true);

  elements.authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await unlockWithToken(elements.adminToken.value);
    } catch (error) {
      setUnlocked(false);
      renderDbStatus(false);
      setMessage(error.message, "error");
    }
  });

  elements.tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.explorerNav) {
        if (state.activeView === "explorer" && !state.mediaDetailInline && state.explorerMode !== button.dataset.explorerNav) {
          clearSearchInputs();
        }
        state.explorerMode = button.dataset.explorerNav;
      }
      if (state.mediaDetailInline) {
        state.mediaDetailInline = false;
        state.activeShowModalKey = null;
        state.activeShowModalSeason = null;
        state.activeShowModalEpisode = null;
        state.showModalRequestToken += 1;
        state.showModalEpisodes = [];
        state.showModalEpisodeIndex = new Map();
        state.pendingWatchAction = null;
        state.activeMovieModalId = null;
        document.querySelector("#explorerBackButton")?.classList.add("hidden");
        elements.explorerTopbarControls?.classList.remove("hidden");
      }
      closeMobileMenu();
      selectView(button.dataset.view);
    });
  });

  const hamburgerButton = document.getElementById("hamburgerButton");
  const topnav = document.querySelector(".topnav");
  if (hamburgerButton && topnav) {
    let lastIsMobile = window.innerWidth <= 760;
    function initMobileMenu(force = false) {
      const isMobile = window.innerWidth <= 760;
      if (force || isMobile !== lastIsMobile) {
        if (isMobile) {
          topnav.classList.add("nav-closed");
          topnav.classList.remove("nav-open");
          hamburgerButton.classList.remove("active");
        } else {
          hamburgerButton.classList.remove("active");
          topnav.classList.remove("nav-closed");
          topnav.classList.remove("nav-open");
        }
        lastIsMobile = isMobile;
      }
    }
    initMobileMenu(true);
    window.addEventListener("resize", () => initMobileMenu(false));

    hamburgerButton.addEventListener("click", () => {
      hamburgerButton.classList.toggle("active");
      topnav.classList.toggle("nav-closed");
      topnav.classList.toggle("nav-open");
      hamburgerButton.setAttribute("aria-expanded", hamburgerButton.classList.contains("active"));
    });
  }

  function closeMobileMenu() {
    if (hamburgerButton && hamburgerButton.classList.contains("active")) {
      hamburgerButton.classList.remove("active");
      topnav.classList.add("nav-closed");
      topnav.classList.remove("nav-open");
      hamburgerButton.setAttribute("aria-expanded", "false");
    }
  }

  // No scroll events or arrow click handlers needed for fixed-fit rows

  elements.testConnectionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      testConnection(button.dataset.testConnection, button).catch((error) => {
        const type = button.dataset.testConnection;
        const message = `${connectionLabel(type)} connection test exception: ${error?.message || "unknown error"}`;
        setConnectionButton(button, "✘ Failed", "error");
        setConnectionStatus(type, message, "error");
        logDebug(message);
      });
    });
  });

  elements.clearLogsButton.addEventListener("click", () => {
    state.debugLogs = clearDebugLogs();
    clearBackendDiagnosticLogs(authHeaders())
      .catch((error) => setMessage(error.message, "error"))
      .finally(() => renderLogs().catch(() => { }));
  });

  elements.copyLogsButton.addEventListener("click", () => {
    copyToClipboard(state.renderedLogsText || logsText() || "[no diagnostic logs captured yet]");
  });

  elements.settingsTabButtons.forEach((button) => {
    button.addEventListener("click", () => selectSettingsTab(button.dataset.settingsTab));
  });

  elements.backupsSubTabButtons.forEach((button) => {
    button.addEventListener("click", () => selectBackupsTab(button.dataset.backupsTab));
  });

  for (const id of ["appearShowLogoArt", "appearShowCast", "appearShowTrailers", "appearShowReviews", "appearShowImages", "appearShowRelated"]) {
    elements[id]?.addEventListener("change", () => saveAppearanceSettings().catch(() => null));
  }

  elements.saveWatchBackupConfigButton?.addEventListener("click", () => {
    saveWatchBackupSettings().catch((error) => setMessage(error.message, "error"));
  });
  elements.createWatchBackupButton?.addEventListener("click", () => {
    createWatchBackupNow().catch((error) => setMessage(error.message, "error"));
  });
  elements.chooseWatchBackupFileButton?.addEventListener("click", () => {
    elements.watchBackupUploadFile?.click();
  });
  elements.watchBackupUploadFile?.addEventListener("change", () => {
    const file = elements.watchBackupUploadFile.files?.[0];
    uploadWatchBackupFile(file)
      .catch((error) => {
        if (elements.watchBackupUploadStatus) elements.watchBackupUploadStatus.textContent = "Upload failed";
        setMessage(error.message, "error");
      })
      .finally(() => {
        if (elements.watchBackupUploadFile) elements.watchBackupUploadFile.value = "";
      });
  });
  elements.refreshWatchBackupsButton?.addEventListener("click", () => {
    state.watchBackups = null;
    loadWatchBackups({ force: true }).catch((error) => setMessage(error.message, "error"));
  });
  elements.watchBackupList?.addEventListener("click", (event) => {
    const download = event.target.closest("[data-watch-backup-download]");
    if (download) {
      downloadWatchBackup(download.dataset.watchBackupDownload).catch((error) => setMessage(error.message, "error"));
      return;
    }
    const dryRun = event.target.closest("[data-watch-backup-dry-run]");
    if (dryRun) {
      restoreWatchBackup(dryRun.dataset.watchBackupDryRun, "reconcile", true).catch((error) => setMessage(error.message, "error"));
      return;
    }
    const restore = event.target.closest("[data-watch-backup-restore]");
    if (restore) {
      const clearMode = state.restoreClearMode || "reconcile";
      const destId = restore.dataset.restoreDestId;
      if (destId) {
        restoreRemoteBackupFromCard({ dataset: { destId } }, restore.dataset.watchBackupRestore, clearMode).catch((error) => setMessage(error.message, "error"));
      } else {
        restoreWatchBackup(restore.dataset.watchBackupRestore, clearMode).catch((error) => setMessage(error.message, "error"));
      }
    }
  });

  elements.watchBackupList?.addEventListener("change", (event) => {
    const clearModeInput = event.target.closest("[data-restore-clear-mode]");
    if (clearModeInput) {
      state.restoreClearMode = clearModeInput.value === "wipe" ? "wipe" : "reconcile";
    }
  });

  elements.watchBackupRuntime?.addEventListener("click", (event) => {
    const clearBtn = event.target.closest("[data-clear-restore-status]");
    if (clearBtn) {
      postWatchBackupAction({ action: "clear-restore-status" })
        .then(() => loadWatchBackups({ force: true }))
        .catch((error) => setMessage(error.message, "error"));
    }
  });

  elements.addWatchBackupDestinationButton?.addEventListener("click", () => {
    addBackupDestination().catch((error) => setMessage(error.message, "error"));
  });
  elements.watchBackupDestinations?.addEventListener("click", (event) => {
    const restoreFile = event.target.closest("[data-dest-restore-file]");
    if (restoreFile) {
      const card = restoreFile.closest("[data-dest-id]");
      if (card) restoreRemoteBackupFromCard(card, restoreFile.dataset.destRestoreFile, state.restoreClearMode || "reconcile").catch((error) => setMessage(error.message, "error"));
      return;
    }
    const button = event.target.closest("[data-dest-action]");
    if (!button) return;
    const card = button.closest("[data-dest-id]");
    if (!card) return;
    const actions = {
      save: saveBackupDestinationCard,
      test: testBackupDestinationCard,
      remove: removeBackupDestinationCard,
      connect: connectBackupDestinationCard,
      "restore-list": listRemoteBackupsForCard,
    };
    const run = actions[button.dataset.destAction];
    if (run) run(card).catch((error) => setMessage(error.message, "error"));
  });


  elements.explorerButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.explorerMode = button.dataset.explorerMode;
      renderExplorer();
      selectView("explorer");
    });
  });

  elements.explorerSort?.addEventListener("change", () => {
    setCurrentExplorerSort(elements.explorerSort.value || "title_asc");
    renderExplorer();
  });
  elements.explorerHideWatched?.addEventListener("change", () => {
    state.hideWatchedShows = elements.explorerHideWatched.checked;
    localStorage.setItem(HIDE_WATCHED_KEY_SHOWS, String(state.hideWatchedShows));
    renderExplorer();
  });
  elements.explorerHideEnded?.addEventListener("change", () => {
    state.hideEndedShows = elements.explorerHideEnded.checked;
    localStorage.setItem(HIDE_ENDED_KEY_SHOWS, String(state.hideEndedShows));
    renderExplorer();
  });
  elements.statsMediaFilter?.addEventListener("change", () => {
    state.statsMediaFilter = elements.statsMediaFilter.value || "all";
    renderStats();
  });
  elements.statsPeriodType?.addEventListener("change", () => {
    state.statsPeriodType = elements.statsPeriodType.value || "all";
    state.statsPeriodValue = state.statsPeriodType === "all" ? "all" : "";
    renderStats();
  });
  elements.statsPeriodValue?.addEventListener("change", () => {
    state.statsPeriodValue = elements.statsPeriodValue.value || "all";
    renderStats();
  });
  document.querySelector("#stats-view")?.addEventListener("click", (event) => {
    const card = event.target.closest("[data-stats-media-href]");
    if (!card) return;
    navigateTo(card.dataset.statsMediaHref);
  });
  document.querySelector("#stats-view")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest("[data-stats-media-href]");
    if (!card) return;
    event.preventDefault();
    navigateTo(card.dataset.statsMediaHref);
  });

  elements.explorerPanel?.addEventListener("click", (e) => {
    const header = e.target.closest("[data-sort-key]");
    if (!header) return;
    applyListHeaderSort(header.dataset.sortKey);
  });

  elements.alphaFilterNav?.addEventListener("click", handleAlphaFilterClick);


  const brandLink = document.querySelector("#brandLink");
  if (brandLink) {
    brandLink.addEventListener("click", (event) => {
      event.preventDefault();
      navigateTo("/");
    });
  }

  elements.appVersion?.addEventListener("click", () => {
    navigateTo("/settings/changelog");
  });

  elements.changelogRefreshButton?.addEventListener("click", () => {
    renderChangelog(true).catch(() => { });
  });

  elements.lockButton.addEventListener("click", lockDashboard);
  if (elements.themeToggleButton) {
    elements.themeToggleButton.addEventListener("click", (...args) => _cb.toggleTheme?.(...args));
  }
  elements.closeModalButton.addEventListener("click", closeDebugModal);
  elements.debugModal.addEventListener("click", (event) => {
    if (event.target === elements.debugModal) closeDebugModal();
  });

  if (elements.closePersonModalButton) {
    elements.closePersonModalButton.addEventListener("click", () => {
      closePersonProfile();
    });
  }
  if (elements.personModal) {
    elements.personModal.addEventListener("click", (event) => {
      if (event.target === elements.personModal) {
        closePersonProfile();
      }
    });
  }

  const closeConfirmModal = () => {
    if (elements.confirmModal) elements.confirmModal.classList.add("hidden");
  };
  if (elements.closeConfirmModalButton) {
    elements.closeConfirmModalButton.addEventListener("click", closeConfirmModal);
  }
  if (elements.cancelConfirmButton) {
    elements.cancelConfirmButton.addEventListener("click", closeConfirmModal);
  }
  if (elements.confirmModal) {
    elements.confirmModal.addEventListener("click", (event) => {
      if (event.target === elements.confirmModal) closeConfirmModal();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (elements.personModal && !elements.personModal.classList.contains("hidden")) {
        closePersonProfile();
      } else {
        closeMediaDetail();
      }
      closeConfirmModal();
      elements.terminalModal?.classList.add("hidden");
    }
  });

  const wheelScrollTargets = new WeakMap();
  document.addEventListener("wheel", (e) => {
    const row = e.target.closest(".horizontal-scroll-row, .trailer-scroll-row, .cast-scroll-row, .media-images-scroll-row");
    if (!row) return;
    if (row.scrollWidth <= row.clientWidth) return;
    // Let native horizontal gestures (trackpad swipe) pass through untouched.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

    // Normalise delta to pixels regardless of the device's wheel mode.
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;
    else if (e.deltaMode === 2) delta *= row.clientWidth;

    const maxScroll = row.scrollWidth - row.clientWidth;
    const atLeft = row.scrollLeft <= 0;
    const atRight = Math.ceil(row.scrollLeft + row.clientWidth) >= row.scrollWidth;
    // At an edge in the scroll direction, release the wheel back to the page.
    if ((delta > 0 && atRight) || (delta < 0 && atLeft)) {
      wheelScrollTargets.delete(row);
      return;
    }
    e.preventDefault();

    const current = wheelScrollTargets.has(row) ? wheelScrollTargets.get(row) : row.scrollLeft;
    const target = Math.max(0, Math.min(maxScroll, current + delta));
    wheelScrollTargets.set(row, target);

    if (!row._wheelRAF) {
      const step = () => {
        const goal = wheelScrollTargets.get(row);
        if (goal == null) {
          row._wheelRAF = null;
          return;
        }
        const diff = goal - row.scrollLeft;
        if (Math.abs(diff) < 0.5) {
          row.scrollLeft = goal;
          wheelScrollTargets.delete(row);
          row._wheelRAF = null;
          return;
        }
        row.scrollLeft += diff * 0.2;
        row._wheelRAF = requestAnimationFrame(step);
      };
      row._wheelRAF = requestAnimationFrame(step);
    }
  }, { passive: false });

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
      submitSeerrRequest(mediaType, mediaId, seerrBtn);
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
      const shouldClose = Number(state.activeShowModalSeason) === seasonNum;
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
        ? (nextSeason ? `/tvshow/${state.activeShowModalKey}#season${nextSeason}` : `/tvshow/${state.activeShowModalKey}`)
        : state.activeShowTmdbId
          ? (nextSeason ? `/tvshow/tmdb/${state.activeShowTmdbId}#season${nextSeason}` : `/tvshow/tmdb/${state.activeShowTmdbId}`)
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

  document.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    const statusDot = event.target.closest?.("[data-sync-status-dot]");
    if (!statusDot) return;
    const historyRow = statusDot.closest("[data-history-id]");
    if (!historyRow) return;
    event.preventDefault();
    openHistoryDebugModal(historyRow.dataset.historyId).catch((error) => setMessage(error.message, "error"));
  });

  elements.adminCredentialsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveAdminCredentials().catch((error) => {
      renderAdminCredentialsStatus(error.message, "error");
      setMessage(error.message, "error");
    });
  });

  elements.checkSessionButton.addEventListener("click", async () => {
    const user = currentUser();
    const text = user ? `Signed in as ${user.username || user.email || "admin"}.` : "Sign in again from the lock screen.";
    const tone = user ? "success" : "error";
    renderAdminCredentialsStatus(text, tone);
    setMessage(text, tone);
  });

  elements.rotateWebhookButton?.addEventListener("click", async () => {
    try {
      await rotateWebhookSecret();
      elements.webhookUrl.textContent = buildWebhookUrl();
      renderSettingsInlineHelp();
      setMessage("Webhook secret rotated. Update the webhook URL in all media servers.", "success");
    } catch (error) {
      setMessage(`Failed to rotate webhook secret: ${error.message}`, "error");
    }
  });

  elements.saveConfigButton?.addEventListener("click", () => {
    saveSavedConfig().catch((error) => {
      renderSettingsStatus(error.message, "error");
      setMessage(error.message, "error");
    });
  });

  elements.savePlexConfigButton?.addEventListener("click", () => {
    saveSectionConfig("plex");
  });
  elements.saveEmbyConfigButton?.addEventListener("click", () => {
    saveSectionConfig("emby");
  });
  elements.saveJellyfinConfigButton?.addEventListener("click", () => {
    saveSectionConfig("jellyfin");
  });
  elements.saveTmdbConfigButton?.addEventListener("click", () => {
    saveSectionConfig("tmdb");
  });
  elements.saveYoutubeConfigButton?.addEventListener("click", () => {
    saveSectionConfig("youtube");
  });
  elements.saveFanartConfigButton?.addEventListener("click", () => {
    saveSectionConfig("fanart");
  });
  elements.saveOmdbConfigButton?.addEventListener("click", () => {
    saveSectionConfig("omdb");
  });
  elements.saveSeerrConfigButton?.addEventListener("click", () => {
    saveSectionConfig("seerr");
  });

  elements.plexEnabled?.addEventListener("change", syncSettingsInputsDisabledState);
  elements.embyEnabled?.addEventListener("change", syncSettingsInputsDisabledState);
  elements.jellyfinEnabled?.addEventListener("change", syncSettingsInputsDisabledState);
  elements.seerrEnabled?.addEventListener("change", syncSettingsInputsDisabledState);

  elements.explorerSearchInput?.addEventListener("input", () => {
    window.clearTimeout(state.explorerSearchTimer);
    state.explorerSearchTimer = window.setTimeout(() => {
      state.explorerSearch = elements.explorerSearchInput.value.trim();
      if (elements.globalSearchInput && elements.globalSearchInput.value !== state.explorerSearch) {
        elements.globalSearchInput.value = state.explorerSearch;
      }
      renderExplorer();
    }, 220);
  });

  elements.globalSearchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeGlobalSearchDropdown();
      elements.globalSearchInput.blur();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const first = document.querySelector(".global-search-result");
      first?.focus();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const firstResult = document.querySelector(".global-search-result");
    if (firstResult) {
      firstResult.click();
      return;
    }
    closeGlobalSearchDropdown();
    const query = elements.globalSearchInput.value.trim();
    if (query) {
      navigateTo(`/search?q=${encodeURIComponent(query)}`);
    }
  });

  elements.globalSearchInput?.addEventListener("input", () => {
    const query = elements.globalSearchInput.value.trim();
    window.clearTimeout(state.globalSearchDropdownTimer);
    window.clearTimeout(state.globalSearchRemoteTimer);
    if (!query) { closeGlobalSearchDropdown(); }
    else {
      renderGlobalSearchDropdown(query);
      state.globalSearchRemoteTimer = window.setTimeout(() => loadGlobalDiscovery(query), 260);
    }
    if (state.activeView === "explorer") {
      window.clearTimeout(state.explorerSearchTimer);
      state.explorerSearchTimer = window.setTimeout(() => {
        state.explorerSearch = query;
        if (elements.explorerSearchInput && elements.explorerSearchInput.value !== query) {
          elements.explorerSearchInput.value = query;
        }
        renderExplorer();
      }, 220);
    }
  });

  // Browsers ignore autocomplete="off" and will dump the saved login username into
  // the first text field on load. The search box ships read-only so the password
  // manager can't autofill it; unlock it the moment the user actually interacts.
  const unlockGlobalSearch = () => elements.globalSearchInput?.removeAttribute("readonly");
  elements.globalSearchInput?.addEventListener("pointerdown", unlockGlobalSearch);
  elements.globalSearchInput?.addEventListener("focus", unlockGlobalSearch);

  const unlockExplorerSearch = () => elements.explorerSearchInput?.removeAttribute("readonly");
  elements.explorerSearchInput?.addEventListener("pointerdown", unlockExplorerSearch);
  elements.explorerSearchInput?.addEventListener("focus", unlockExplorerSearch);

  elements.globalSearchInput?.addEventListener("focus", () => {
    const query = elements.globalSearchInput.value.trim();
    if (query) renderGlobalSearchDropdown(query);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".global-search")) closeGlobalSearchDropdown();
  });

  document.querySelectorAll(".search-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".search-filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.searchFilter = btn.dataset.filter;
      renderSearchPage();
    });
  });

  document.getElementById("searchViewResults")?.addEventListener("click", (e) => {
    const card = e.target.closest(".explorer-overview-card");
    if (card && card.dataset.href) {
      navigateTo(card.dataset.href);
    }
  });

  elements.importFile.addEventListener("change", async () => {
    const files = elements.importFile.files;
    if (!files?.length) return;
    try {
      await parseSelectedFiles(files);
      setMessage(`Parsed ${state.importRecords.length} records from ${files.length} file${files.length === 1 ? "" : "s"}.`, "success");
    } catch (error) {
      state.importRecords = [];
      state.importFileNames = [];
      appendImportLog(`Parse failed: ${error.message}`);
      renderImportPreview();
      setMessage(`Import parse failed: ${error.message}`, "error");
    }
  });

  elements.startImportButton.addEventListener("click", () => {
    startImport().catch((error) => setMessage(error.message, "error"));
  });

  elements.clearImportButton.addEventListener("click", () => {
    state.importRecords = [];
    state.importFileNames = [];
    state.importLogs = ["[idle] Waiting for files."];
    state.importProgressValue = 0;
    elements.importFile.value = "";
    renderImportPreview();
    setMessage("Import selection cleared.");
  });

  elements.backupExportButton?.addEventListener("click", () => {
    exportPlembfinBackup().catch((error) => setMessage(error.message, "error"));
  });

  elements.backupImportFile?.addEventListener("change", async () => {
    state.backupImport = null;
    elements.backupImportButton.disabled = true;
    const file = elements.backupImportFile.files?.[0];
    if (!file) {
      setBackupTransferState("Idle", "muted", "[idle] Select Export or choose a backup file.");
      return;
    }
    try {
      state.backupImport = await readPlembfinBackup(file);
      const documentCount = state.backupImport.included.reduce((sum, name) => sum + state.backupImport.backup.collections[name].length, 0);
      elements.backupImportButton.disabled = false;
      setBackupTransferState("Ready", "ready", `${file.name}\n${formatNumber(documentCount)} documents across ${formatNumber(state.backupImport.included.length)} supported collections.`);
    } catch (error) {
      setBackupTransferState("Invalid", "error", `Backup file rejected: ${error.message}`);
      setMessage(error.message, "error");
    }
  });

  elements.backupImportButton?.addEventListener("click", () => {
    importPlembfinBackup().catch((error) => setMessage(error.message, "error"));
  });

  if (elements.runCompleteCheckButton) {
    elements.runCompleteCheckButton.addEventListener("click", () => {
      runSystemIntegrityCheck().catch((error) => {
        setMessage(`Integrity check exception: ${error.message}`, "error");
      });
    });
  }

  if (elements.refreshCacheStatsButton) {
    elements.refreshCacheStatsButton.addEventListener("click", () => {
      loadCacheStats({ force: true }).catch((error) => setMessage(error.message, "error"));
    });
  }

  if (elements.runRepairButton) {
    elements.runRepairButton.addEventListener("click", () => {
      runRepairWorkflow().catch((error) => {
        renderSettingsStatus(error.message, "error");
        setMessage(error.message, "error");
      });
    });
  }

  if (elements.traktBackfillButton) {
    elements.traktBackfillButton.addEventListener("click", () => {
      runTraktBackfill().catch((error) => {
        elements.traktBackfillStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.dedupHistoryButton) {
    elements.dedupHistoryButton.addEventListener("click", () => {
      runDedupHistory().catch((error) => {
        if (elements.dedupHistoryStatus) elements.dedupHistoryStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.refreshMetadataButton) {
    elements.refreshMetadataButton.addEventListener("click", () => {
      runRefreshMetadataWorkflow().catch((error) => {
        if (elements.refreshMetadataStatus) elements.refreshMetadataStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.fullSyncButton) {
    elements.fullSyncButton.addEventListener("click", () => {
      runFullSyncWatchstates().catch(() => { });
    });
  }

  if (elements.runCronSyncButton) {
    elements.runCronSyncButton.addEventListener("click", () => {
      triggerCronSync().catch(() => { });
    });
  }

  if (elements.refreshSyncButton) {
    elements.refreshSyncButton.addEventListener("click", () => {
      loadSyncJobs({ force: true }).catch((error) => setMessage(error.message, "error"));
      loadSyncHistory({ force: true }).catch((error) => setMessage(error.message, "error"));
    });
  }

  if (elements.forceSyncButton) {
    elements.forceSyncButton.addEventListener("click", () => {
      triggerForceSync().catch(() => { });
    });
  }

  if (elements.stopSyncButton) {
    elements.stopSyncButton.addEventListener("click", () => {
      triggerStopSync().catch(() => { });
    });
  }

  // Sync issues toggle
  if (elements.syncIssuesToggle) {
    elements.syncIssuesToggle.addEventListener("click", () => {
      const isHidden = elements.syncIssuesContent.classList.contains("hidden");
      if (isHidden) {
        elements.syncIssuesContent.classList.remove("hidden");
        elements.syncIssuesToggleIcon.textContent = "▼";
      } else {
        elements.syncIssuesContent.classList.add("hidden");
        elements.syncIssuesToggleIcon.textContent = "▶";
      }
    });
  }

  // Sync history toggle
  if (elements.syncHistoryToggle) {
    elements.syncHistoryToggle.addEventListener("click", () => {
      const isHidden = elements.syncHistoryContent.classList.contains("hidden");
      if (isHidden) {
        elements.syncHistoryContent.classList.remove("hidden");
        elements.syncHistoryToggleIcon.textContent = "▼";
      } else {
        elements.syncHistoryContent.classList.add("hidden");
        elements.syncHistoryToggleIcon.textContent = "▶";
      }
    });
  }

  // Sync tools toggle
  if (elements.syncToolsToggle) {
    elements.syncToolsToggle.addEventListener("click", () => {
      const isHidden = elements.syncToolsContent.classList.contains("hidden");
      if (isHidden) {
        elements.syncToolsContent.classList.remove("hidden");
        elements.syncToolsToggleIcon.textContent = "▼";
      } else {
        elements.syncToolsContent.classList.add("hidden");
        elements.syncToolsToggleIcon.textContent = "▶";
      }
    });
  }

  // Event delegation for action buttons in sync issues
  document.addEventListener("click", (e) => {
    if (e.target.dataset.action === "clearMissingTelemetry") {
      triggerClearMissingTelemetry(e.target).catch(() => { });
    }
    if (e.target.dataset.action === "retryAllCategory") {
      triggerRetryAllCategory(e.target.dataset.category, e.target).catch(() => { });
    }
    if (e.target.classList.contains("dismiss-issue-btn")) {
      const issueCard = e.target.closest(".sync-issue-card");
      if (issueCard) {
        issueCard.style.animation = "fadeOut 0.3s ease forwards";
        setTimeout(() => {
          issueCard.remove();
          const container = document.getElementById("syncIssuesContainer");
          if (container && container.querySelectorAll(".sync-issue-card").length === 0) {
            loadSyncJobs({ force: true }).catch(() => { });
          }
        }, 300);
      }
    }
  });

  window.addEventListener("error", (event) => {
    logDebug("Global browser error captured.", {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    logDebug("Global unhandled promise rejection captured.", {
      reason: event.reason?.message || String(event.reason || "unknown"),
    });
  });

  window.addEventListener("resize", () => {
    applyExplorerPosterWidth();
    applyHistoryPosterWidth();
    syncPageTopbar();
    syncMediaActionsMenuState();
    window.clearTimeout(state.dashboardHistoryResizeTimer);
    state.dashboardHistoryResizeTimer = window.setTimeout(() => {
      if (state.activeView === "dashboard") renderDashboard();
    }, 120);
  });

  window.addEventListener("scroll", () => {
    if (state.activeView !== "explorer" && state.activeView !== "history") return;
    if (state.activeView === "explorer") {
      state.explorerScrollArmed = true;
    } else if (state.activeView === "history") {
      state.historyViewScrollArmed = true;
    }
    if (state.posterHydrateScrollScheduled) return;
    state.posterHydrateScrollScheduled = true;
    window.requestAnimationFrame(() => {
      state.posterHydrateScrollScheduled = false;
      const container = state.activeView === "explorer"
        ? elements.explorerPanel
        : elements.historyPanel;
      hydratePosters(container);
    });
  }, { passive: true });

  document.addEventListener("visibilitychange", () => {
    if (!state.token || state.activeView !== "dashboard") return;
    if (document.hidden) {
      stopHistoryPolling();
      return;
    }
    startHistoryPolling();
  });

  window.addEventListener("popstate", () => {
    state.internalHistoryCount = history.state?.index || 0;
    handleRouting(window.location.pathname + window.location.search + window.location.hash);
    applyActiveView();
  });

  elements.explorerPosterSize?.addEventListener("input", (e) => {
    const val = e.target.value;
    document.documentElement.style.setProperty("--poster-width", `${val}px`);
    localStorage.setItem(currentPosterWidthKey(), `${val}px`);
  });

  elements.historyPosterSize?.addEventListener("input", (e) => {
    const val = e.target.value;
    document.documentElement.style.setProperty("--history-poster-width", `${val}px`);
    localStorage.setItem("plembfin:history:posterWidth", `${val}px`);
  });

  elements.partWatchedPanel?.addEventListener("click", async (event) => {
    const posterLink = event.target.closest("[data-part-watched-href]");
    if (posterLink) {
      event.preventDefault();
      navigateTo(posterLink.dataset.partWatchedHref);
      return;
    }
    const watchBtn = event.target.closest("[data-action-watch]");
    const unwatchBtn = event.target.closest("[data-action-unwatch]");
    if (!watchBtn && !unwatchBtn) return;

    const btn = watchBtn || unwatchBtn;
    const mediaKey = watchBtn ? watchBtn.dataset.actionWatch : unwatchBtn.dataset.actionUnwatch;
    const title = watchBtn ? watchBtn.dataset.title : unwatchBtn.dataset.title;

    if (watchBtn) {
      const entry = state.partWatchedRaw.find(e => e.media_key === mediaKey);
      if (entry) {
        if (entry.media_type === "movie") {
          state.pendingWatchAction = {
            origin: "part-watched",
            scope: "movie",
            mediaKey: entry.media_key,
            title: entry.title,
            movie: {
              title: entry.title,
              tmdbId: entry.tmdb_id,
              imdbId: entry.imdb_id,
              tvdbId: entry.tvdb_id,
              posterUrl: entry.poster_url || entry.imageUrl || entry.thumb || null,
            },
            label: `Mark ${entry.title} watched`,
            lastPlayedAt: entry.updated_at,
          };
        } else {
          const showTitle = entry.show_title || showTitleFrom(entry.title);
          state.pendingWatchAction = {
            origin: "part-watched",
            scope: "episode",
            mediaKey: entry.media_key,
            title: entry.title,
            showTitle: showTitle,
            episodes: [{
              seasonNumber: entry.season,
              episodeNumber: entry.episode,
              title: entry.episode_title || entry.title,
              showTmdbId: entry.tmdb_id,
              imdbId: entry.imdb_id,
              tvdbId: entry.tvdb_id,
              posterUrl: entry.poster_url || entry.imageUrl || entry.thumb || null,
              key: entry.media_key,
              airDate: entry.airDate || entry.air_date || null,
            }],
            label: `Mark ${showTitle} watched`,
            countLabel: `Season ${entry.season} · Episode ${entry.episode}`,
            lastPlayedAt: entry.updated_at,
          };
        }
        openWatchDatePrompt(state.pendingWatchAction);
      }
    } else if (unwatchBtn) {
      showConfirmModal(`Clear playback progress for "${title}"? This will mark it unwatched and reset progress.`, async () => {
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Clearing...";
        try {
          const res = await fetch("/api/playback-progress/unwatch", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            body: JSON.stringify({ media_key: mediaKey }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          setMessage(`Progress cleared for "${title}"`, "success");
          resetPartWatchedView("default");
          renderPartWatched();
        } catch (error) {
          showErrorExplainModal(`Failed to clear progress for "${title}"`, error.message);
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    }
  });

  elements.historySearchInput?.addEventListener("input", () => {
    window.clearTimeout(state.historyViewSearchTimer);
    state.historyViewSearchTimer = window.setTimeout(() => {
      state.historyViewSearch = elements.historySearchInput.value.trim();
      renderHistoryView();
    }, 220);
  });

  const unlockHistorySearch = () => elements.historySearchInput?.removeAttribute("readonly");
  elements.historySearchInput?.addEventListener("pointerdown", unlockHistorySearch);
  elements.historySearchInput?.addEventListener("focus", unlockHistorySearch);

  for (const btn of elements.historyFilterButtons || []) {
    btn.addEventListener("click", () => {
      const filter = btn.dataset.historyFilter || "all";
      if (!HISTORY_FILTERS.includes(filter)) return;
      if (filter === state.historyViewFilter) return;
      state.historyViewFilter = filter;
      localStorage.setItem(HISTORY_FILTER_KEY, filter);
      resetHistoryView([state.historyViewSearch, state.historyViewFilter].join("|"));
      renderHistoryView();
    });
  }

  for (const btn of elements.historyViewButtons || []) {
    btn.addEventListener("click", () => {
      const view = btn.dataset.historyView || "grid";
      if (!HISTORY_VIEW_MODES.includes(view)) return;
      if (view === state.historyViewMode) return;
      state.historyViewMode = view;
      localStorage.setItem(HISTORY_VIEW_KEY, view);
      renderHistoryView();
    });
  }

  for (const btn of elements.dashboardHistoryViewButtons || []) {
    btn.addEventListener("click", () => {
      const view = btn.dataset.dashboardHistoryView || "cards";
      if (!DASHBOARD_HISTORY_VIEW_MODES.includes(view)) return;
      if (view === state.dashboardHistoryViewMode) return;
      state.dashboardHistoryViewMode = view;
      localStorage.setItem(DASHBOARD_HISTORY_VIEW_KEY, view);
      renderDashboard();
    });
  }

  for (const btn of elements.explorerViewButtons || []) {
    btn.addEventListener("click", () => {
      const view = btn.dataset.explorerView;
      if (!view || view === currentExplorerView()) return;
      if (state.explorerMode === "shows") {
        state.explorerViewShows = view;
        localStorage.setItem(EXPLORER_VIEW_KEY_SHOWS, view);
        state.showsRaw = [];
        state.showsOffset = 0;
        state.showsHasMore = true;
        state.showsLoading = false;
      } else {
        state.explorerViewMovies = view;
        localStorage.setItem(EXPLORER_VIEW_KEY_MOVIES, view);
        state.moviesRaw = [];
        state.moviesOffset = 0;
        state.moviesHasMore = true;
        state.moviesLoading = false;
      }
      renderExplorer();
    });
  }

  elements.closeTerminalModalButton?.addEventListener("click", () => {
    elements.terminalModal?.classList.add("hidden");
  });

  elements.terminalModal?.addEventListener("click", (event) => {
    if (event.target === elements.terminalModal) {
      elements.terminalModal.classList.add("hidden");
    }
  });
}
