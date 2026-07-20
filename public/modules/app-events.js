import { buildAuthHeaders, buildNowPlayingUrl, getWebhookToken, onAuthChange, readStoredAdminToken, rotateWebhookSecret, scrubTokenFromLocation, signInAdmin, signOutAdmin, updateAdminCredentials } from "./auth.js";
import { appendDebugLog, clearDebugLogs, logsToText, readStoredDebugLogs, fetchDiagnosticLogs, clearDiagnosticLogs as clearBackendDiagnosticLogs } from "./logs.js";
import { state, elements, ACTIVE_VIEW_KEY, ACTIVE_SETTINGS_TAB_KEY, EXPLORER_SORT_KEY_MOVIES, EXPLORER_SORT_KEY_SHOWS, EXPLORER_VIEW_KEY_MOVIES, EXPLORER_VIEW_KEY_SHOWS, HIDE_WATCHED_KEY_SHOWS, HIDE_ENDED_KEY_SHOWS, HISTORY_VIEW_KEY, HISTORY_FILTER_KEY, HISTORY_VIEW_MODES, HISTORY_FILTERS, DASHBOARD_HISTORY_VIEW_KEY, DASHBOARD_HISTORY_VIEW_MODES, PRIMARY_VIEWS } from "./state.js";
import { escapeHtml, sanitizeTitle, safeImageUrl, movieSlug, showTitleFrom, episodeTitle, startOfWeek, addDays, toDateInputValue, toDateTimeInputValue, formatDayName, formatDayDate, formatWeekRange, formatShortTime, formatNumber, formatDateShort, shortMonthLabel, normalizePlatformSource, platformName, platformBadge, sourceClass, computeProgress, formatDuration, formatPlaybackClock, formatNowPlayingMeta, idLine, csvRows, normalizeHeader, formatTmdbDate, ordinalDay, formatLongAiringDate, knownShowAirtime, formatEpisodeAirtime, showEpisodeKey, episodeCode, seasonLabel } from "./utils.js";
import { buildWebhookUrl, renderSettingsInlineHelp } from "./help-content.js";
import { compactPosterUrl, clearPersistentPosterLookupCache, cachedPosterLookup, posterServerConfig, configuredImageUrl, posterUrlFor, posterMarkup, posterFallbackElement, lookupPosterUrl, hydratePosterFallbacks, bindPosterImageErrorHandler, hydratePosterImages, hydratePosters, tmdbImage, tmdbPoster, bestTmdbLogo, tmdbProfile } from "./images.js";
import { initTools, APPEARANCE_DEFAULTS, setBackupTransferState, exportPlembfinBackup, readPlembfinBackup, importPlembfinBackup, renderWatchBackups, loadRemoteBackupsForRestoreTab, restoreRemoteBackupFromCard, loadCacheStats, renderCachePanel, loadWatchBackups, postWatchBackupAction, applyAppearanceToBody, loadAppearanceSettings, saveAppearanceSettings, saveWatchBackupSettings, createWatchBackupNow, downloadWatchBackup, uploadWatchBackupFile, restoreWatchBackup, parseSelectedFiles, renderImportPreview, renderImportActivity, startImport, runRepairWorkflow, runDedupHistory, runTraktBackfill, runRematchTvShows, runFullSyncWatchstates, runSystemIntegrityCheck, triggerClearMissingTelemetry, triggerRetryAllCategory, appendImportLog, loadPlembfinBackups, savePlembfinBackupSettings, createPlembfinBackupNow, downloadPlembfinBackup, deletePlembfinBackupFile, restorePlembfinBackupFromServer, renderPlembfinBackups, updatePlembfinButtonsState, savePlembfinBackupRemoteSettings, createPlembfinBackupRemoteNow, createRemoteWatchBackupNow, saveRemoteWatchBackupSettings } from "./tools.js";
import { initSync, nowPlayingUrl, telemetryLineValue, historyAction, isWatchedHistoryAction, syncStatus, historySyncPill, getActiveTargets, sourcePlatform, normalizeTargetStatus, targetStateUnavailable, targetStateNoop, hasConfirmedMediaAvailability, sharedLibraryAvailability, getMediaTargetSyncStatus, getSyncStatusTone, getSyncStatusTooltip, renderSyncStatusDot, renderAvailabilityPills, renderShowAvailabilityPills, renderMediaSyncPills, telemetryTargetStates, syncJobSortWeight, renderTargetPills, syncJobMediaType, syncHistoryTone, syncHistoryActionLabel, syncHistoryTargetPills, categorizeIssues, renderIssueCategory, renderSyncJobs, renderSyncHistory, loadSyncJobs, loadSyncHistory, activeSessionsKey, setActiveSessions, renderActiveSessions, loadActiveSessions, pollNowPlayingOnce, startHistoryPolling, stopHistoryPolling, syncNowPlayingPolling, triggerCronSync, triggerStopSync, triggerForceSync } from "./sync.js";
import { initDashboard, getRowFitLimit, mediaRecordIdentity, dedupeMediaRecords, progressRecordIdentity, dedupePlaybackProgress, renderHistoryCard, observeDashboardPosters, renderDashboard, updateDashboardSplitState, resetPartWatchedView, renderPartWatchedCard, renderPartWatched, loadPartWatched } from "./dashboard.js";
import { initStats, formatListDate, futureListDate, showStatusLabel, nextAiringDateValue, nextAiringCell, statsReports, statsPeriodLabel, syncStatsPeriodOptions, selectedStatsReport, statsFilteredRows, statsPeriodNoun, statsTrackingSpanText, statsPlatformLabel, statsSelectedMediaLabel, statsIntroCards, renderStatsKpis, renderStatsLeaderboard, renderStatsMoviesTvSplit, renderStatsPlatformRows, renderStatsBookends, renderMonthChart, renderStats, renderRankingTable } from "./stats.js";
import { initExplorer, syncExplorerControlsState, syncInlineMediaDetailHeading, triggerSearchPage, renderSearchPage, renderExplorer, explorerQueryKey, updateAlphaFilter, handleAlphaFilterClick, resetMovieExplorer, resetShowExplorer, renderExplorerSentinel, observeExplorerSentinel, observeExplorerTmdbPrefetch, scheduleNextAirResort, currentExplorerView, currentExplorerSort, currentPosterWidthKey, setCurrentExplorerSort, applyExplorerPosterWidth, applyListHeaderSort, renderMovieCard, renderMovieExplorer, loadExplorerMovies, applyHistoryPosterWidth, resetHistoryView, renderHistoryItems, renderHistoryView, loadHistoryView, observeHistorySentinel, renderShowExplorer, loadExplorerShows, mergeShowDetail, loadShowDetail, matchesExplorerSearch, sortExplorerItems, renderShowRecord, renderShowFolder, renderSeasonFolder, seasonsFromShowRecord, representativeEpisode, tmdbLookupIdsFromShow, emptyExplorer, FILMOGRAPHY_PAGE_SIZE, getFilmographyObserver, setFilmographyObserver } from "./explorer.js";
import { openWatchDatePrompt } from "./watch-action.js";
import { fetchTmdbDetails, fetchTmdbSeasonDetails, resolveEpisodeTitleFromTmdb } from "./tmdb.js?v=20260710";
import { initMediaDetail, nowPlayingHref, openMovieInlineDetail, clearMediaDetailState, syncMediaActionsMenuState, syncTopbarControlsMenuState, closeDebugModal, closeMediaDetail, openMovieImmersiveModalByTmdbId, openShowImmersiveModalByTmdbId, openHistoryDebugModal, fetchSeerrMediaStatus, refreshActiveMediaDetailAfterSeerrStatus } from "./media-detail.js?v=20260701";
import { closePersonProfile, loadCastMemberDetails } from "./media-person.js";
import { initMediaLightbox } from "./media-lightbox.js";
import { initMediaDetailEvents, attachMediaDetailEvents } from "./media-detail-events.js";

let _cb = {};
export function initAppEvents(callbacks = {}) {
  _cb = callbacks;
  initMediaDetailEvents(callbacks);
  attachEvents();
}

const authHeaders = (...args) => _cb.authHeaders?.(...args), setMessage = (...args) => _cb.setMessage?.(...args), unlockWithToken = (...args) => _cb.unlockWithToken?.(...args), clearSearchInputs = (...args) => _cb.clearSearchInputs?.(...args), selectView = (...args) => _cb.selectView?.(...args), renderLogs = (...args) => _cb.renderLogs?.(...args), logsText = (...args) => _cb.logsText?.(...args), copyToClipboard = (...args) => _cb.copyToClipboard?.(...args), selectBackupsTab = (...args) => _cb.selectBackupsTab?.(...args), navigateTo = (...args) => _cb.navigateTo?.(...args), renderChangelog = (...args) => _cb.renderChangelog?.(...args), lockDashboard = (...args) => _cb.lockDashboard?.(...args), toggleTheme = (...args) => _cb.toggleTheme?.(...args), showConfirmModal = (...args) => _cb.showConfirmModal?.(...args), closeGlobalSearchDropdown = (...args) => _cb.closeGlobalSearchDropdown?.(...args), saveAdminCredentials = (...args) => _cb.saveAdminCredentials?.(...args), applyActiveView = (...args) => _cb.applyActiveView?.(...args), handleRouting = (...args) => _cb.handleRouting?.(...args), loadHistory = (...args) => _cb.loadHistory?.(...args), loadStats = (...args) => _cb.loadStats?.(...args), loadSavedConfig = (...args) => _cb.loadSavedConfig?.(...args), renderHelp = (...args) => _cb.renderHelp?.(...args), renderDbStatus = (...args) => _cb.renderDbStatus?.(...args), showErrorExplainModal = (...args) => _cb.showErrorExplainModal?.(...args), runRefreshMetadataWorkflow = (...args) => _cb.runRefreshMetadataWorkflow?.(...args), showToast = (...args) => _cb.showToast?.(...args), logDebug = (...args) => _cb.logDebug?.(...args), syncPageTopbar = (...args) => _cb.syncPageTopbar?.(...args), setUnlocked = (...args) => _cb.setUnlocked?.(...args), renderSettingsStatus = (...args) => _cb.renderSettingsStatus?.(...args), renderAdminCredentialsStatus = (...args) => _cb.renderAdminCredentialsStatus?.(...args), toggleSet = (...args) => _cb.toggleSet?.(...args), renderGlobalSearchDropdown = (...args) => _cb.renderGlobalSearchDropdown?.(...args), loadGlobalDiscovery = (...args) => _cb.loadGlobalDiscovery?.(...args);

function attachEvents() {
  document.querySelectorAll(".backup-managed-form").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const target = document.getElementById(form.dataset.submitTarget || "");
      if (target && !target.disabled) target.click();
    });
  });

  document.addEventListener("click", (e) => {
    const controlTab = e.target.closest(".mobile-control-tab");
    if (controlTab) {
      const container = controlTab.closest(".explorer-controls");
      if (container) {
        const target = controlTab.dataset.target;
        const isActive = controlTab.classList.contains("active");

        container.querySelectorAll(".mobile-control-tab").forEach(tab => tab.classList.remove("active"));
        container.querySelectorAll(".compact-field, .explorer-view-toggle, #explorerHideWatchedLabel, #explorerHideEndedLabel").forEach(panel => {
          panel.classList.remove("active-mobile-panel");
        });

        if (!isActive) {
          controlTab.classList.add("active");
          if (target === "search") {
            container.querySelector(".explorer-search-box")?.classList.add("active-mobile-panel");
          } else if (target === "sort") {
            container.querySelector("select")?.closest(".compact-field")?.classList.add("active-mobile-panel");
          } else if (target === "filter") {
            const hideWatched = container.querySelector("#explorerHideWatchedLabel");
            const hideEnded = container.querySelector("#explorerHideEndedLabel");
            const historyFilter = container.querySelector(".history-filter-toggle");
            if (hideWatched) hideWatched.classList.add("active-mobile-panel");
            if (hideEnded) hideEnded.classList.add("active-mobile-panel");
            if (historyFilter) historyFilter.classList.add("active-mobile-panel");
          } else if (target === "size") {
            container.querySelector(".explorer-size-slider")?.classList.add("active-mobile-panel");
          } else if (target === "view") {
            const viewToggle = container.querySelector(".explorer-view-toggle:not(.history-filter-toggle)");
            if (viewToggle) viewToggle.classList.add("active-mobile-panel");
          }
        }
      }
      return;
    }

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
  const collapsibleRegions = topnav
    ? [
      topnav.querySelector(".global-search"),
      topnav.querySelector(".sidebar-scrollable"),
    ].filter(Boolean)
    : [];

  function syncMobileMenuAccessibility(isMobile, isOpen) {
    const isCollapsed = isMobile && !isOpen;
    collapsibleRegions.forEach((region) => {
      region.toggleAttribute("inert", isCollapsed);
      if (isCollapsed) region.setAttribute("aria-hidden", "true");
      else region.removeAttribute("aria-hidden");
    });
    hamburgerButton?.setAttribute("aria-expanded", String(isMobile && isOpen));
  }

  function setMobileMenuState(isMobile, isOpen) {
    if (!hamburgerButton || !topnav) return;
    const shouldOpen = isMobile && isOpen;
    topnav.classList.toggle("nav-open", shouldOpen);
    topnav.classList.toggle("nav-closed", isMobile && !shouldOpen);
    hamburgerButton.classList.toggle("active", shouldOpen);
    syncMobileMenuAccessibility(isMobile, shouldOpen);
  }

  if (hamburgerButton && topnav) {
    let lastIsMobile = window.innerWidth <= 760;
    function initMobileMenu(force = false) {
      const isMobile = window.innerWidth <= 760;
      if (force || isMobile !== lastIsMobile) {
        if (isMobile && collapsibleRegions.some((region) => region.contains(document.activeElement))) {
          hamburgerButton.focus({ preventScroll: true });
        }
        setMobileMenuState(isMobile, false);
        lastIsMobile = isMobile;
      }
    }
    initMobileMenu(true);
    window.addEventListener("resize", () => initMobileMenu(false));

    hamburgerButton.addEventListener("click", () => {
      const isMobile = window.innerWidth <= 760;
      setMobileMenuState(isMobile, !topnav.classList.contains("nav-open"));
    });
  }

  function closeMobileMenu() {
    if (hamburgerButton && hamburgerButton.classList.contains("active")) {
      hamburgerButton.focus({ preventScroll: true });
      const isMobile = window.innerWidth <= 760;
      setMobileMenuState(isMobile, false);
    }
  }

  // No scroll events or arrow click handlers needed for fixed-fit rows

  elements.clearLogsButton.addEventListener("click", () => {
    state.debugLogs = clearDebugLogs();
    clearBackendDiagnosticLogs(authHeaders())
      .catch((error) => setMessage(error.message, "error"))
      .finally(() => renderLogs().catch(() => { }));
  });

  elements.copyLogsButton.addEventListener("click", () => {
    copyToClipboard(state.renderedLogsText || logsText() || "[no diagnostic logs captured yet]");
  });

  document.querySelector("#settingsSectionSelect")?.addEventListener("change", (event) => {
    navigateTo(event.currentTarget.value);
  });

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-settings-path]");
    if (!target) return;
    navigateTo(target.dataset.settingsPath);
  });

  elements.sidebarAppearanceButton?.addEventListener("click", () => {
    const isOpen = !elements.sidebarAppearancePanel?.classList.contains("hidden");
    elements.sidebarAppearancePanel?.classList.toggle("hidden", isOpen);
    elements.sidebarAppearanceButton.setAttribute("aria-expanded", String(!isOpen));
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
  const handleWatchBackupListClick = (event) => {
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
  };
  elements.watchBackupList?.addEventListener("click", handleWatchBackupListClick);
  elements.remoteWatchBackupList?.addEventListener("click", handleWatchBackupListClick);

  const handleWatchBackupListChange = (event) => {
    const clearModeInput = event.target.closest("[data-restore-clear-mode]");
    if (clearModeInput) {
      state.restoreClearMode = clearModeInput.value === "wipe" ? "wipe" : "reconcile";
    }
  };
  elements.watchBackupList?.addEventListener("change", handleWatchBackupListChange);
  elements.remoteWatchBackupList?.addEventListener("change", handleWatchBackupListChange);

  elements.watchBackupRuntime?.addEventListener("click", (event) => {
    const clearBtn = event.target.closest("[data-clear-restore-status]");
    if (clearBtn) {
      postWatchBackupAction({ action: "clear-restore-status" })
        .then(() => loadWatchBackups({ force: true }))
        .catch((error) => setMessage(error.message, "error"));
    }
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
    navigateTo("/settings/about");
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

  attachMediaDetailEvents();

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

  elements.explorerSearchInput?.addEventListener("input", () => {
    window.clearTimeout(state.explorerSearchTimer);
    state.explorerSearchTimer = window.setTimeout(() => {
      state.explorerSearch = elements.explorerSearchInput.value.trim();
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

  elements.backupExportPassphrase?.addEventListener("input", () => {
    updatePlembfinButtonsState();
  });
  elements.backupExportRememberPassphrase?.addEventListener("change", () => {
    updatePlembfinButtonsState();
  });
  elements.plembfinBackupEnabled?.addEventListener("change", () => {
    updatePlembfinButtonsState();
  });

  elements.plembfinBackupRemotePassphrase?.addEventListener("input", () => {
    updatePlembfinButtonsState();
  });
  elements.plembfinBackupRemoteRememberPassphrase?.addEventListener("change", () => {
    updatePlembfinButtonsState();
  });
  elements.plembfinBackupRemoteEnabled?.addEventListener("change", () => {
    updatePlembfinButtonsState();
  });

  elements.savePlembfinBackupRemoteButton?.addEventListener("click", () => {
    savePlembfinBackupRemoteSettings().catch((error) => setMessage(error.message, "error"));
  });

  elements.createPlembfinBackupRemoteButton?.addEventListener("click", () => {
    createPlembfinBackupRemoteNow().catch((error) => setMessage(error.message, "error"));
  });

  elements.createRemoteWatchBackupButton?.addEventListener("click", () => {
    createRemoteWatchBackupNow().catch((error) => setMessage(error.message, "error"));
  });

  elements.saveRemoteWatchBackupConfigButton?.addEventListener("click", () => {
    saveRemoteWatchBackupSettings().catch((error) => setMessage(error.message, "error"));
  });

  elements.savePlembfinBackupConfigButton?.addEventListener("click", () => {
    savePlembfinBackupSettings().catch((error) => setMessage(error.message, "error"));
  });

  elements.createPlembfinBackupButton?.addEventListener("click", () => {
    createPlembfinBackupNow().catch((error) => setMessage(error.message, "error"));
  });

  elements.plembfinBackupList?.addEventListener("click", (event) => {
    const downloadBtn = event.target.closest("[data-plembfin-backup-download]");
    if (downloadBtn) {
      const filename = downloadBtn.dataset.plembfinBackupDownload;
      downloadPlembfinBackup(filename).catch((error) => setMessage(error.message, "error"));
    }
    const restoreBtn = event.target.closest("[data-plembfin-backup-restore]");
    if (restoreBtn) {
      const filename = restoreBtn.dataset.plembfinBackupRestore;
      restorePlembfinBackupFromServer(filename).catch((error) => setMessage(error.message, "error"));
    }
    const deleteBtn = event.target.closest("[data-plembfin-backup-delete]");
    if (deleteBtn) {
      const filename = deleteBtn.dataset.plembfinBackupDelete;
      deletePlembfinBackupFile(filename).catch((error) => setMessage(error.message, "error"));
    }
  });

  elements.backupRestorePassphrase?.addEventListener("input", () => {
    const disabled = elements.backupRestorePassphrase.value.trim().length < 12;
    if (elements.backupImportFile) {
      elements.backupImportFile.disabled = disabled;
    }
    const fileLabel = document.querySelector(".backup-file-button");
    if (fileLabel) {
      if (disabled) {
        fileLabel.classList.add("disabled");
        fileLabel.style.opacity = "0.5";
        fileLabel.style.pointerEvents = "none";
      } else {
        fileLabel.classList.remove("disabled");
        fileLabel.style.opacity = "";
        fileLabel.style.pointerEvents = "";
      }
    }
  });

  elements.backupImportFile?.addEventListener("change", async () => {
    state.backupImport = null;
    elements.backupImportButton.disabled = true;
    const file = elements.backupImportFile.files?.[0];
    if (!file) {
      setBackupTransferState("Idle", "muted", "[idle] Enter a passphrase, then choose an encrypted Plembfin backup.", "restore");
      return;
    }
    try {
      state.backupImport = await readPlembfinBackup(file);
      const documentCount = state.backupImport.included.reduce((sum, name) => sum + state.backupImport.backup.collections[name].length, 0);
      elements.backupImportButton.disabled = false;
      const encryptionLabel = state.backupImport.encrypted ? "Encrypted Plembfin backup" : "Legacy unencrypted Plembfin backup";
      setBackupTransferState("Ready", "ready", `${encryptionLabel}: ${file.name}\n${formatNumber(documentCount)} documents across ${formatNumber(state.backupImport.included.length)} supported collections.`, "restore");
    } catch (error) {
      setBackupTransferState("Invalid", "error", `Backup file rejected: ${error.message}`, "restore");
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

  if (elements.refreshTvdbButton) {
    elements.refreshTvdbButton.addEventListener("click", () => {
      runRefreshTvdbMetadataWorkflow().catch((error) => {
        if (elements.refreshTvdbStatus) elements.refreshTvdbStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.rematchTvButton) {
    elements.rematchTvButton.addEventListener("click", () => {
      runRematchTvShows().catch((error) => {
        if (elements.rematchTvStatus) elements.rematchTvStatus.textContent = `Error: ${error?.message || String(error)}`;
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
        elements.syncHistoryToggle.classList.add("open");
        if (elements.syncHistoryToggleIcon) elements.syncHistoryToggleIcon.style.transform = "rotate(90deg)";
      } else {
        elements.syncHistoryContent.classList.add("hidden");
        elements.syncHistoryToggle.classList.remove("open");
        if (elements.syncHistoryToggleIcon) elements.syncHistoryToggleIcon.style.transform = "rotate(0deg)";
      }
    });
  }

  // Sync tools toggle
  if (elements.syncToolsToggle) {
    elements.syncToolsToggle.addEventListener("click", () => {
      const isHidden = elements.syncToolsContent.classList.contains("hidden");
      if (isHidden) {
        elements.syncToolsContent.classList.remove("hidden");
        elements.syncToolsToggle.classList.add("open");
        if (elements.syncToolsToggleIcon) elements.syncToolsToggleIcon.style.transform = "rotate(90deg)";
      } else {
        elements.syncToolsContent.classList.add("hidden");
        elements.syncToolsToggle.classList.remove("open");
        if (elements.syncToolsToggleIcon) elements.syncToolsToggleIcon.style.transform = "rotate(0deg)";
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
    if (state.activeView !== "explorer" && state.activeView !== "history" && state.activeView !== "upcoming") return;
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
        : state.activeView === "history"
          ? elements.historyPanel
          : elements.upcomingCalendar;
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
      const entry = state.partWatchedRaw.find(e => e.media_key === mediaKey);
      const isEpisode = entry?.media_type === "episode";
      const displayTitle = isEpisode ? (entry.show_title || showTitleFrom(entry.title)) : (entry?.title || title);
      const progressPercent = Math.round(entry?.progress || 0);
      const sources = entry ? (Array.isArray(entry.sources) && entry.sources.length ? entry.sources : (entry.source ? [entry.source] : [])) : [];
      const sourceLabel = sources.length ? sources.map(platformName).join(", ") : "the originating server";

      let mediaHtml = "";
      if (entry) {
        mediaHtml = `
          ${posterMarkup(entry, "confirm-modal-media-poster")}
          <div class="confirm-modal-media-info">
            <span class="confirm-modal-media-title">${escapeHtml(displayTitle)}</span>
            <span class="confirm-modal-media-meta">
              ${isEpisode ? `<span>${escapeHtml(episodeCode(entry.season, entry.episode))}</span>` : ""}
              <span>${progressPercent}% watched</span>
            </span>
          </div>
        `;
      }

      const message = `This will clear the saved playback progress for "${title}", mark it as unwatched, and remove it from your Part Watched list.\n\nThe unwatched status will also be sent back to ${sourceLabel} and propagated to any other connected media servers, so it stays in sync everywhere.`;

      showConfirmModal(message, async () => {
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
      }, { title: "Clear Progress", mediaHtml });
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
