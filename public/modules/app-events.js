import { buildAuthHeaders, buildNowPlayingUrl, getWebhookToken, onAuthChange, readStoredAdminToken, rotateWebhookSecret, scrubTokenFromLocation, signInAdmin, signOutAdmin, updateAdminCredentials } from "./auth.js?v=0.15.0";
import { claimWithForm } from "./onboarding.js?v=0.15.0";
import { appendDebugLog, clearDebugLogs, logsToText, readStoredDebugLogs, fetchDiagnosticLogs, clearDiagnosticLogs as clearBackendDiagnosticLogs } from "./logs.js?v=0.15.0";
import { state, elements, ACTIVE_VIEW_KEY, ACTIVE_SETTINGS_TAB_KEY, EXPLORER_SORT_KEY_MOVIES, EXPLORER_SORT_KEY_SHOWS, EXPLORER_VIEW_KEY_MOVIES, EXPLORER_VIEW_KEY_SHOWS, HIDE_WATCHED_KEY_SHOWS, HIDE_ENDED_KEY_SHOWS, HISTORY_VIEW_KEY, HISTORY_FILTER_KEY, HISTORY_VIEW_MODES, HISTORY_FILTERS, PRIMARY_VIEWS } from "./state.js?v=0.15.0";
import { escapeHtml, sanitizeTitle, safeImageUrl, movieSlug, showTitleFrom, slug, episodeTitle, startOfWeek, addDays, toDateInputValue, toDateTimeInputValue, formatDayName, formatDayDate, formatWeekRange, formatShortTime, formatNumber, formatDateShort, shortMonthLabel, normalizePlatformSource, platformName, platformBadge, sourceClass, computeProgress, formatDuration, formatPlaybackClock, formatNowPlayingMeta, idLine, csvRows, normalizeHeader, formatTmdbDate, ordinalDay, formatLongAiringDate, knownShowAirtime, formatEpisodeAirtime, showEpisodeKey, episodeCode, seasonLabel } from "./utils.js?v=0.15.0";
import { renderSettingsInlineHelp } from "./help-content.js?v=0.15.0";
import { compactPosterUrl, clearPersistentPosterLookupCache, cachedPosterLookup, posterServerConfig, configuredImageUrl, posterUrlFor, posterMarkup, posterFallbackElement, lookupPosterUrl, hydratePosterFallbacks, bindPosterImageErrorHandler, hydratePosterImages, hydratePosters, tmdbImage, tmdbPoster, bestTmdbLogo, markArtworkUnavailable, tmdbProfile } from "./images.js?v=0.15.0";
import { initTools, APPEARANCE_DEFAULTS, setBackupTransferState, exportPlembfinBackup, readPlembfinBackup, importPlembfinBackup, renderWatchBackups, loadRemoteBackupsForRestoreTab, restoreRemoteBackupFromCard, loadCacheStats, renderCachePanel, loadWatchBackups, postWatchBackupAction, applyAppearanceToBody, loadAppearanceSettings, saveAppearanceSettings, saveWatchBackupSettings, createWatchBackupNow, downloadWatchBackup, uploadWatchBackupFile, restoreWatchBackup, parseSelectedFiles, renderImportPreview, renderImportActivity, startImport, runRepairWorkflow, runTraktBackfill, runEpisodeTitleAudit, runEpisodeTitleBackfill, runRematchTvShows, runSystemIntegrityCheck, triggerClearMissingTelemetry, triggerRetryAllCategory, appendImportLog, loadPlembfinBackups, savePlembfinBackupSettings, createPlembfinBackupNow, downloadPlembfinBackup, deletePlembfinBackupFile, restorePlembfinBackupFromServer, restoreRemotePlembfinBackup, renderPlembfinBackups, updatePlembfinButtonsState, savePlembfinBackupRemoteSettings, createPlembfinBackupRemoteNow, createRemoteWatchBackupNow, saveRemoteWatchBackupSettings } from "./tools.js?v=0.15.0";
import { initSync, nowPlayingUrl, telemetryLineValue, historyAction, isWatchedHistoryAction, syncStatus, historySyncPill, getActiveTargets, sourcePlatform, normalizeTargetStatus, targetStateUnavailable, targetStateNoop, hasConfirmedMediaAvailability, sharedLibraryAvailability, getMediaTargetSyncStatus, getSyncStatusTone, getSyncStatusTooltip, renderSyncStatusDot, renderAvailabilityPills, renderShowAvailabilityPills, renderMediaSyncPills, telemetryTargetStates, syncJobSortWeight, renderTargetPills, syncJobMediaType, syncHistoryTone, syncHistoryActionLabel, syncHistoryTargetPills, categorizeIssues, renderIssueCategory, renderSyncJobs, renderSyncHistory, loadSyncJobs, loadSyncHistory, activeSessionsKey, setActiveSessions, renderActiveSessions, loadActiveSessions, pollNowPlayingOnce, startHistoryPolling, stopHistoryPolling, syncNowPlayingPolling, triggerCronSync, triggerStopSync } from "./sync.js?v=0.15.0";
import { initDashboard, getRowFitLimit, mediaRecordIdentity, dedupeMediaRecords, progressRecordIdentity, dedupePlaybackProgress, renderHistoryCard, observeDashboardPosters, renderDashboard, updateDashboardSplitState, resetPartWatchedView, renderPartWatchedCard, renderPartWatched } from "./dashboard.js?v=0.15.0";
import { loadUpNext, removeUpNextItem, restoreUpNextItem } from "./up-next.js?v=0.15.0";
import { initStats, formatListDate, futureListDate, showStatusLabel, nextAiringDateValue, nextAiringCell, statsReports, statsPeriodLabel, syncStatsPeriodOptions, selectedStatsReport, statsFilteredRows, statsPeriodNoun, statsTrackingSpanText, statsPlatformLabel, statsSelectedMediaLabel, statsIntroCards, renderStatsKpis, renderStatsLeaderboard, renderStatsMoviesTvSplit, renderStatsPlatformRows, renderStatsBookends, renderMonthChart, renderStats, renderRankingTable } from "./stats.js?v=0.15.0";
import { initExplorer, syncExplorerControlsState, syncInlineMediaDetailHeading, triggerSearchPage, loadMoreSearchPeople, loadSearchCollection, renderSearchPage, renderExplorer, explorerQueryKey, updateAlphaFilter, handleAlphaFilterClick, resetMovieExplorer, resetShowExplorer, renderExplorerSentinel, observeExplorerSentinel, observeExplorerTmdbPrefetch, scheduleNextAirResort, currentExplorerView, currentExplorerSort, currentPosterWidthKey, setCurrentExplorerSort, applyExplorerPosterWidth, applyListHeaderSort, renderMovieCard, renderMovieExplorer, loadExplorerMovies, applyHistoryPosterWidth, resetHistoryView, renderHistoryItems, renderHistoryView, loadHistoryView, observeHistorySentinel, renderShowExplorer, loadExplorerShows, mergeShowDetail, loadShowDetail, matchesExplorerSearch, sortExplorerItems, renderShowRecord, renderShowFolder, renderSeasonFolder, seasonsFromShowRecord, representativeEpisode, tmdbLookupIdsFromShow, emptyExplorer, FILMOGRAPHY_PAGE_SIZE, getFilmographyObserver, setFilmographyObserver } from "./explorer.js?v=0.15.0";
import { openWatchDatePrompt, markDiscoverWatched, submitSeerrRequest } from "./watch-action.js?v=0.15.0";
import { addToWatchlist, removeFromWatchlist, openRatingDialog, openAddToListDialog, addToCustomList, removeFromCustomList, openCreateListDialog, personalItemFromPosterMenuDataset } from "./personal-media.js?v=0.15.0";
import { fetchTmdbDetails, fetchTmdbSeasonDetails, resolveEpisodeTitleFromTmdb } from "./tmdb.js?v=0.15.0";
import { initMediaDetail, nowPlayingHref, openMovieInlineDetail, clearMediaDetailState, syncMediaActionsMenuState, syncTopbarControlsMenuState, closeDebugModal, closeMediaDetail, closeMediaInfoModal, openMovieImmersiveModalByTmdbId, openShowImmersiveModalByTmdbId, openHistoryDebugModal, fetchSeerrMediaStatus, refreshActiveMediaDetailAfterSeerrStatus } from "./media-detail.js?v=0.15.0";
import { closePersonProfile, loadCastMemberDetails } from "./media-person.js?v=0.15.0";
import { initMediaLightbox } from "./media-lightbox.js?v=0.15.0";
import { initMediaDetailEvents, attachMediaDetailEvents, initLibraryForceSyncPanel } from "./media-detail-events.js?v=0.15.0";
import { attachSidebarMiddleClickNavigation } from "./sidebar-navigation.js?v=0.15.0";
import { initPosterOverflowMenu, closePosterOverflowMenu, setPosterOverflowMenuActionPending } from "./poster-menu.js?v=0.15.0";

let _cb = {};

function getMobileMenuElements() {
  const hamburgerButton = document.getElementById("hamburgerButton");
  const topnav = document.querySelector(".topnav");
  const collapsibleRegions = topnav
    ? [
      topnav.querySelector(".global-search"),
      topnav.querySelector(".sidebar-scrollable"),
    ].filter(Boolean)
    : [];
  return { hamburgerButton, topnav, collapsibleRegions };
}

function syncMobileMenuAccessibility(isMobile, isOpen) {
  const { hamburgerButton, collapsibleRegions } = getMobileMenuElements();
  const isCollapsed = isMobile && !isOpen;
  collapsibleRegions.forEach((region) => {
    region.toggleAttribute("inert", isCollapsed);
    if (isCollapsed) region.setAttribute("aria-hidden", "true");
    else region.removeAttribute("aria-hidden");
  });
  hamburgerButton?.setAttribute("aria-expanded", String(isMobile && isOpen));
}

export function setMobileMenuState(isMobile, isOpen) {
  const { hamburgerButton, topnav } = getMobileMenuElements();
  if (!hamburgerButton || !topnav) return;
  const shouldOpen = isMobile && isOpen;
  topnav.classList.toggle("nav-open", shouldOpen);
  topnav.classList.toggle("nav-closed", isMobile && !shouldOpen);
  hamburgerButton.classList.toggle("active", shouldOpen);
  syncMobileMenuAccessibility(isMobile, shouldOpen);
}

export function closeMobileMenu() {
  const isMobile = window.innerWidth <= 760;
  const { hamburgerButton, topnav } = getMobileMenuElements();
  if (!topnav) return;
  if (topnav.classList.contains("nav-open") || hamburgerButton?.classList.contains("active")) {
    setMobileMenuState(isMobile, false);
  }
}

export function initAppEvents(callbacks = {}) {
  _cb = callbacks;
  initMediaDetailEvents(callbacks);
  initLibraryForceSyncPanel();
  initPosterOverflowMenu();
  attachEvents();
}

const authHeaders = (...args) => _cb.authHeaders?.(...args), setMessage = (...args) => _cb.setMessage?.(...args), unlockWithToken = (...args) => _cb.unlockWithToken?.(...args), clearSearchInputs = (...args) => _cb.clearSearchInputs?.(...args), selectView = (...args) => _cb.selectView?.(...args), renderLogs = (...args) => _cb.renderLogs?.(...args), logsText = (...args) => _cb.logsText?.(...args), copyToClipboard = (...args) => _cb.copyToClipboard?.(...args), selectBackupsTab = (...args) => _cb.selectBackupsTab?.(...args), navigateTo = (...args) => _cb.navigateTo?.(...args), renderChangelog = (...args) => _cb.renderChangelog?.(...args), lockDashboard = (...args) => _cb.lockDashboard?.(...args), toggleTheme = (...args) => _cb.toggleTheme?.(...args), showConfirmModal = (...args) => _cb.showConfirmModal?.(...args), openConfirmDialog = (...args) => _cb.openConfirmDialog?.(...args) || Promise.resolve(true), closeGlobalSearchDropdown = (...args) => _cb.closeGlobalSearchDropdown?.(...args), saveAdminCredentials = (...args) => _cb.saveAdminCredentials?.(...args), applyActiveView = (...args) => _cb.applyActiveView?.(...args), handleRouting = (...args) => _cb.handleRouting?.(...args), loadHistory = (...args) => _cb.loadHistory?.(...args), loadStats = (...args) => _cb.loadStats?.(...args), loadSavedConfig = (...args) => _cb.loadSavedConfig?.(...args), renderHelp = (...args) => _cb.renderHelp?.(...args), renderDbStatus = (...args) => _cb.renderDbStatus?.(...args), showErrorExplainModal = (...args) => _cb.showErrorExplainModal?.(...args), runRefreshMetadataWorkflow = (...args) => _cb.runRefreshMetadataWorkflow?.(...args), runRefreshTvdbMetadataWorkflow = (...args) => _cb.runRefreshTvdbMetadataWorkflow?.(...args), showToast = (...args) => _cb.showToast?.(...args), logDebug = (...args) => _cb.logDebug?.(...args), syncPageTopbar = (...args) => _cb.syncPageTopbar?.(...args), setUnlocked = (...args) => _cb.setUnlocked?.(...args), renderSettingsStatus = (...args) => _cb.renderSettingsStatus?.(...args), renderAdminCredentialsStatus = (...args) => _cb.renderAdminCredentialsStatus?.(...args), toggleSet = (...args) => _cb.toggleSet?.(...args), renderGlobalSearchDropdown = (...args) => _cb.renderGlobalSearchDropdown?.(...args), loadGlobalDiscovery = (...args) => _cb.loadGlobalDiscovery?.(...args);

function syncAttentionIssueMediaType(issue = {}) {
  const type = String(issue.type || issue.mediaType || "").trim().toLowerCase();
  return ["episode", "movie"].includes(type) ? type : "";
}

function syncAttentionIssueShowTitle(issue = {}) {
  return String(issue.showTitle || issue.sourceShowTitle || showTitleFrom(issue.sourceTitle || issue.title || "")).trim();
}

function syncAttentionIssueSourceKey(issue = {}) {
  return String(issue.sourceRowId || issue.sourceMediaKey || issue.sourcePlaystateKey || issue.mediaKey || "").trim();
}

function syncAttentionIssueRowsFromState() {
  const rows = [];
  const seen = new Set();
  const add = (row) => {
    if (!row?.id || seen.has(String(row.id))) return;
    seen.add(String(row.id));
    rows.push(row);
  };

  for (const row of [...(state.history || []), ...(state.historyViewRaw || []), ...(state.moviesRaw || [])]) add(row);
  for (const show of state.showsRaw || []) {
    for (const episode of show.episodes || []) add(episode?.watched || episode);
  }
  return rows;
}

function syncAttentionIssueRowMatch(rows = [], issue = {}) {
  const type = syncAttentionIssueMediaType(issue);
  const sourceKey = syncAttentionIssueSourceKey(issue);
  const byKey = sourceKey && rows.find((row) => String(row.media_key || row.mediaKey || "") === sourceKey);
  if (byKey) return byKey;

  const sourceIds = issue.sourceIds || issue.ids || {};
  const byProviderId = rows.find((row) => type === String(row.media_type || row.type || "").toLowerCase()
    && ["imdb", "tmdb", "tvdb"].some((name) => sourceIds[name] && String(row[`${name}_id`] || row[name] || "") === String(sourceIds[name])));
  if (byProviderId) return byProviderId;

  if (type === "episode") {
    const showTitle = syncAttentionIssueShowTitle(issue);
    const showKey = showTitle ? slug(showTitle) : "";
    const season = Number(issue.sourceSeason ?? issue.season);
    const episode = Number(issue.sourceEpisode ?? issue.episode);
    const coordinateRows = rows.filter((row) => String(row.media_type || row.type || "").toLowerCase() === "episode"
      && Number(row.season) === season
      && Number(row.episode) === episode);
    return (showKey && coordinateRows.find((row) => slug(row.show_title || row.showTitle || showTitleFrom(row.title || "")) === showKey))
      || coordinateRows[0]
      || null;
  }

  const titleKey = slug(issue.sourceTitle || issue.title || "");
  return rows.find((row) => String(row.media_type || row.type || "").toLowerCase() === "movie" && slug(row.title || "") === titleKey) || null;
}

async function syncAttentionHistoryRowById(id) {
  const key = String(id || "").trim();
  if (!key) return null;
  const response = await fetch(`/api/history?id=${encodeURIComponent(key)}`, { headers: authHeaders(), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body.row || null : null;
}

async function resolveSyncAttentionFixMatchAnchor(issue = {}) {
  const sourceRowId = String(issue.sourceRowId || "").trim();
  if (sourceRowId) {
    const row = await syncAttentionHistoryRowById(sourceRowId).catch(() => null);
    if (row?.id) return row;
  }

  let rows = syncAttentionIssueRowsFromState();
  let match = syncAttentionIssueRowMatch(rows, issue);
  if (match?.id) return match;

  const type = syncAttentionIssueMediaType(issue);
  const search = type === "episode" ? syncAttentionIssueShowTitle(issue) : String(issue.sourceTitle || issue.title || "").trim();
  if (!search) return null;
  const url = new URL("/api/history", window.location.origin);
  url.searchParams.set("search", search);
  url.searchParams.set("mediaType", type);
  url.searchParams.set("limit", "500");
  url.searchParams.set("dedupe", "false");
  const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  rows = Array.isArray(body.history) ? body.history : [];
  match = syncAttentionIssueRowMatch(rows, issue);
  return match?.id ? match : null;
}

async function openSyncAttentionFixMatch(issue = {}) {
  const type = syncAttentionIssueMediaType(issue);
  const anchor = await resolveSyncAttentionFixMatchAnchor(issue);
  if (!anchor?.id) {
    const href = String(issue.localHref || "").trim();
    if (href) {
      navigateTo(href);
      setMessage("No local watch row was found for a direct match dialog. Opened the affected Plembfin item instead.", "warning");
      return;
    }
    throw new Error("Could not find a local watch row to fix-match.");
  }

  const currentTitle = type === "episode"
    ? syncAttentionIssueShowTitle(issue)
    : String(issue.sourceTitle || issue.title || anchor.title || "").trim();
  if (!currentTitle) throw new Error("This issue does not include a title to match.");

  _cb.openFixMatchDialog?.(null, anchor.id, currentTitle, type, async () => {
    setMessage("Match updated. Retry this item now; the retry will use the corrected local identity.", "success");
  }, {
    headerTitle: `Fix match · ${currentTitle}`,
    ...(type === "movie" && syncAttentionIssueSourceKey(issue)
      ? { mediaKey: syncAttentionIssueSourceKey(issue) }
      : {}),
  });
}

function updatePosterMenuAction(button, { label, ariaLabel = label, title = ariaLabel, busy = false, disabled = false }) {
  button.textContent = label;
  button.disabled = disabled;
  button.toggleAttribute("aria-busy", busy);
  button.setAttribute("aria-label", ariaLabel);
  button.title = title;
}

function attachEvents() {
  attachSidebarMiddleClickNavigation(document.querySelector(".topnav"));

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

  // Posters render their skeleton until the bitmap is decoded. `load` does not
  // bubble, so this listens in the capture phase and covers every poster the
  // app renders, including ones swapped in after a lookup.
  document.addEventListener("load", (e) => {
    const img = e.target;
    if (img.tagName === "IMG" && img.classList.contains("poster-img")) img.classList.add("is-loaded");
  }, true);

  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img.tagName !== "IMG") return;
    // A poster that failed is no longer loading; the error paths below decide
    // what replaces it.
    img.classList.add("is-loaded");
    markArtworkUnavailable(img.src);
    const mode = img.dataset.err;
    if (!mode) return;
    img.dataset.err = "";
    if (mode === "fav") { img.src = "/favicon.svg"; }
    else if (mode === "hide") { img.style.display = "none"; }
    else if (mode === "hide-parent") { img.parentElement.style.display = "none"; }
    else if (mode === "hide-closest-btn") { img.closest("button").style.display = "none"; }
    else if (mode === "hide-show-next") { img.style.display = "none"; img.nextElementSibling.style.display = "inline-grid"; }
    // A logo that cannot be fetched must not leave the hero blank: drop the
    // image and promote the screen-reader title back to the visible heading.
    else if (mode === "logo-title") {
      const heading = img.parentElement?.querySelector(".immersive-title");
      img.remove();
      heading?.classList.remove("sr-only");
    }
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

  elements.claimForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await claimWithForm(elements.claimUsername.value, elements.claimPassword.value, elements.claimPasswordConfirm.value);
    } catch (error) {
      elements.claimMessage.textContent = error.message;
      elements.claimMessage.dataset.tone = "error";
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
        const { collapsibleRegions } = getMobileMenuElements();
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

  // No scroll events or arrow click handlers needed for fixed-fit rows

  elements.clearLogsButton.addEventListener("click", () => {
    state.debugLogs = clearDebugLogs();
    clearBackendDiagnosticLogs(authHeaders())
      .catch((error) => setMessage(error.message, "error"))
      .finally(() => renderLogs().catch(() => { }));
  });

  elements.copyLogsButton.addEventListener("click", () => {
    copyToClipboard(state.renderedLogsText || logsText() || "[no diagnostic logs captured yet]", elements.copyLogsButton);
  });

  elements.downloadLogsButton?.addEventListener("click", async () => {
    try {
      const backendLogs = await fetchDiagnosticLogs(authHeaders(), "all");
      const localLogs = logsText();
      const content = [
        `=== PLEMBFIN DIAGNOSTIC LOGS EXPORT (${new Date().toISOString()}) ===`,
        ...backendLogs,
        "",
        "=== FRONTEND DEBUG LOGS ===",
        localLogs || "[no frontend logs]"
      ].join("\n");

      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const dateStr = new Date().toISOString().slice(0, 10);
      link.href = url;
      link.download = `plembfin-logs-${dateStr}.log`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setMessage("Logs downloaded successfully", "success");
    } catch (error) {
      setMessage(`Download logs failed: ${error.message || String(error)}`, "error");
    }
  });

  document.querySelector("#logsCategoryFilter")?.addEventListener("click", (event) => {
    const btn = event.target.closest(".logs-cat-btn");
    if (!btn) return;
    const category = btn.dataset.category || "all";
    state.activeLogCategory = category;
    document.querySelectorAll("#logsCategoryFilter .logs-cat-btn").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    renderLogs(true).catch(() => {});
  });

  document.querySelector("#settingsSectionSelect")?.addEventListener("change", (event) => {
    navigateTo(event.currentTarget.value);
  });

  document.addEventListener("click", (event) => {
    const copyBtn = event.target.closest(".copy-button");
    if (copyBtn) {
      const copyText = copyBtn.dataset.copy || copyBtn.closest(".copy-block")?.querySelector("code")?.textContent;
      if (copyText) copyToClipboard(copyText.trim(), copyBtn);
      return;
    }
    const target = event.target.closest("[data-settings-path]");
    if (!target) return;
    closeMobileMenu();
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
      const clearMode = state.restoreClearMode || "wipe";
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
      closeMobileMenu();
      navigateTo("/");
    });
  }

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest("a[data-media-card-href]");
    if (!link?.dataset.mediaCardHref) return;
    event.preventDefault();
    navigateTo(link.dataset.mediaCardHref);
  });

  const parseDatasetObject = (value, fallback = {}) => {
    if (!value) return fallback;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch {
      return fallback;
    }
  };

  const upNextPayloadFromButton = (button) => {
    const d = button?.dataset || {};
    const mediaType = d.upNextMediaType === "episode" ? "episode" : "movie";
    const isEpisode = mediaType === "episode";
    const title = d.upNextTitle || d.upNextMenuTitle || d.title || "Untitled";
    const showTitle = d.showTitle || d.upNextShowTitle || (isEpisode ? title : "");
    return {
      id: d.upNextWatch || d.upNextMenuWatch || d.upNextClear || d.upNextRemove || "",
      mediaType,
      isEpisode,
      title,
      showTitle,
      episodeTitle: d.episodeTitle || d.upNextEpisodeTitle || "",
      season: d.season || d.upNextSeason || "",
      episode: d.episode || d.upNextEpisode || "",
      tmdbId: d.tmdbId || d.upNextTmdbId || "",
      tvdbId: d.tvdbId || d.upNextTvdbId || "",
      imdbId: d.imdbId || d.upNextImdbId || "",
      posterUrl: d.posterUrl || d.upNextPosterUrl || "",
      airDate: d.airDate || d.upNextAirDate || "",
      providerItems: parseDatasetObject(d.providerItems || d.upNextProviderItems, {}),
    };
  };

  const openUpNextWatchPrompt = (watchBtn, event = null) => {
    event?.preventDefault();
    event?.stopPropagation();
    const item = upNextPayloadFromButton(watchBtn);
    if (!item.id) return;

    if (!item.isEpisode) {
      state.pendingWatchAction = {
        origin: "up-next",
        scope: "movie",
        mediaKey: item.id,
        title: item.title,
        movie: {
          title: item.title,
          tmdbId: item.tmdbId,
          imdbId: item.imdbId,
          tvdbId: item.tvdbId,
          posterUrl: item.posterUrl || null,
          releaseDate: item.airDate || null,
          providerItems: item.providerItems,
        },
        providerItems: item.providerItems,
        label: `Mark ${item.title} watched`,
        countLabel: "1 movie",
      };
      openWatchDatePrompt(state.pendingWatchAction);
      return;
    }

    const season = Number(item.season);
    const episode = Number(item.episode);
    if (!Number.isInteger(season) || !Number.isInteger(episode) || episode <= 0) return;
    const showTitle = item.showTitle || "Show";
    state.pendingWatchAction = {
      origin: "up-next",
      scope: "episode",
      showTitle,
      showTmdbId: item.tmdbId,
      episodes: [{
        seasonNumber: season,
        episodeNumber: episode,
        title: item.episodeTitle || episodeCode(season, episode),
        showTitle,
        showTmdbId: item.tmdbId,
        tvdbId: item.tvdbId,
        imdbId: item.imdbId,
        posterUrl: item.posterUrl || null,
        providerItems: item.providerItems,
        key: item.id || `up-next:${showTitle}:${season}:${episode}`,
        airDate: item.airDate || null,
      }],
      resyncEpisodes: [],
      label: `Mark ${episodeCode(season, episode)} watched`,
      countLabel: `${episodeCode(season, episode)} · ${showTitle}`,
    };
    openWatchDatePrompt(state.pendingWatchAction);
  };

  const clearUpNextProgress = async (clearBtn, event = null) => {
    event?.preventDefault();
    event?.stopPropagation();
    const d = clearBtn?.dataset || {};
    const itemId = d.upNextClear || "";
    const item = state.upNextItems.find((candidate) => String(candidate?.id || "") === String(itemId)) || null;
    const payload = item
      ? {
          ...item,
          providerItems: item.provider_items || item.providerItems || {},
        }
      : upNextPayloadFromButton(clearBtn);
    if (!payload.id && !payload.media_key) return;

    const payloadMediaType = payload.media_type || payload.mediaType || "movie";
    const title = payloadMediaType === "episode"
      ? (payload.show_title || payload.showTitle || payload.title || "this episode")
      : (payload.title || "this movie");
    const confirmed = await openConfirmDialog({
      title: "Clear Progress",
      body: `Clear saved progress for "${title}" and mark it unwatched?`,
      confirmLabel: "Clear progress",
      danger: true,
    });
    if (!confirmed) return;

    const originalText = clearBtn.textContent;
    const originalLabel = clearBtn.getAttribute("aria-label");
    clearBtn.disabled = true;
    clearBtn.textContent = "…";
    clearBtn.setAttribute("aria-label", "Clearing progress");
    try {
      const mediaType = payload.media_type || payload.mediaType || (payload.season != null ? "episode" : "movie");
      const response = await fetch("/api/playback-progress/unwatch", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          media_key: payload.media_key || payload.id,
          media_type: mediaType,
          title: payload.title || payload.episode_title || payload.show_title || payload.showTitle || "Untitled",
          show_title: payload.show_title || payload.showTitle || "",
          tmdb_id: payload.tmdb_id || payload.tmdbId || payload.show_tmdb_id || payload.showTmdbId || "",
          imdb_id: payload.imdb_id || payload.imdbId || payload.show_imdb_id || payload.showImdbId || "",
          tvdb_id: payload.tvdb_id || payload.tvdbId || payload.show_tvdb_id || payload.showTvdbId || "",
          season: mediaType === "episode" ? (payload.season ?? "") : "",
          episode: mediaType === "episode" ? (payload.episode ?? "") : "",
          provider_items: payload.provider_items || payload.providerItems || {},
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setMessage(
        body.queued
          ? `Progress cleared for "${title}"; unwatched sync queued until the current blocking operation completes`
          : `Progress cleared for "${title}"`,
        "success",
      );
      await loadHistory({ force: true, silent: true }).catch(() => null);
      await loadUpNext({ force: true });
      renderDashboard();
    } catch (error) {
      showErrorExplainModal(`Failed to clear progress for "${title}"`, error.message);
    } finally {
      clearBtn.disabled = false;
      clearBtn.textContent = originalText;
      if (originalLabel === null) clearBtn.removeAttribute("aria-label");
      else clearBtn.setAttribute("aria-label", originalLabel);
    }
  };

  const removeUpNextItemAction = async (removeBtn, event = null) => {
    event?.preventDefault();
    event?.stopPropagation();
    const d = removeBtn?.dataset || {};
    const itemId = d.upNextRemove || "";
    const item = state.upNextItems.find((candidate) => String(candidate?.id || "") === String(itemId)) || null;
    const payload = item
      ? {
          ...item,
          providerItems: item.provider_items || item.providerItems || {},
        }
      : upNextPayloadFromButton(removeBtn);
    if (!payload.id && !payload.media_key && !itemId) return;

    const payloadMediaType = payload.media_type || payload.mediaType || (payload.season != null ? "episode" : "movie");
    const isEpisode = payloadMediaType === "episode";
    const title = isEpisode
      ? (payload.show_title || payload.showTitle || payload.title || "this episode")
      : (payload.title || "this movie");
    const confirmed = await openConfirmDialog({
      title: "Remove from Up Next",
      body: `Remove "${title}" from Up Next in Plembfin and every connected media app?`,
      confirmLabel: "Remove from Up Next",
      danger: true,
    });
    if (!confirmed) return;

    const originalText = removeBtn.textContent;
    const originalLabel = removeBtn.getAttribute("aria-label");
    removeBtn.disabled = true;
    removeBtn.textContent = "…";
    removeBtn.setAttribute("aria-label", "Removing from Up Next");

    // Start the card-level exit immediately after confirmation. The provider
    // calls still run before the action is considered complete; a failed call
    // restores the card and clears the temporary dismissal.
    const pendingRemoval = removeUpNextItem(payload.id || itemId, payload);
    try {
      const response = await fetch("/api/up-next/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          media_key: payload.media_key || payload.id || itemId,
          media_type: payloadMediaType,
          queue_kind: payload.queue_kind || payload.queueKind || d.upNextQueueKind || "",
          title: payload.title || payload.episode_title || payload.show_title || payload.showTitle || "Untitled",
          show_title: payload.show_title || payload.showTitle || "",
          tmdb_id: payload.tmdb_id || payload.tmdbId || payload.show_tmdb_id || payload.showTmdbId || "",
          imdb_id: payload.imdb_id || payload.imdbId || payload.show_imdb_id || payload.showImdbId || "",
          tvdb_id: payload.tvdb_id || payload.tvdbId || payload.show_tvdb_id || payload.showTvdbId || "",
          season: isEpisode ? (payload.season ?? "") : "",
          episode: isEpisode ? (payload.episode ?? "") : "",
          provider_items: payload.provider_items || payload.providerItems || {},
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      const dismissals = Array.isArray(body.providerDismissals) ? body.providerDismissals : [];
      const synced = dismissals.filter((entry) => entry.status === "fulfilled").length;
      const issues = dismissals.filter((entry) => entry.status !== "fulfilled").length;
      setMessage(
        issues
          ? `Removed "${title}" in Plembfin and ${synced} connected app${synced === 1 ? "" : "s"}; ${issues} app${issues === 1 ? " needs" : "s need"} attention`
          : body.queued
          ? `Removed "${title}" from Up Next; sync queued until the current blocking operation completes`
          : synced
            ? `Removed "${title}" from Up Next in Plembfin and ${synced} connected app${synced === 1 ? "" : "s"}`
            : `Removed "${title}" from Up Next in Plembfin`,
        issues ? "muted" : "success",
      );
      await loadHistory({ force: true, silent: true }).catch(() => null);
      await loadUpNext({ force: true });
      renderDashboard();
    } catch (error) {
      restoreUpNextItem(pendingRemoval);
      showErrorExplainModal(`Failed to remove "${title}" from Up Next`, error.message);
    } finally {
      removeBtn.disabled = false;
      removeBtn.textContent = originalText;
      if (originalLabel === null) removeBtn.removeAttribute("aria-label");
      else removeBtn.setAttribute("aria-label", originalLabel);
    }
  };

  elements.upNextPanel?.addEventListener("click", (event) => {
    const removeBtn = event.target.closest("[data-up-next-remove]");
    if (removeBtn) {
      removeUpNextItemAction(removeBtn, event);
      return;
    }
    const clearBtn = event.target.closest("[data-up-next-clear]");
    if (clearBtn) {
      clearUpNextProgress(clearBtn, event);
      return;
    }
    const watchBtn = event.target.closest("[data-up-next-watch]");
    if (!watchBtn) return;
    openUpNextWatchPrompt(watchBtn, event);
  });

  // Overflow menus are portaled to <body>, so their Up Next actions cannot be
  // delegated from the horizontal row itself.
  document.addEventListener("click", (event) => {
    const removeBtn = event.target.closest("[data-up-next-remove]");
    if (removeBtn) {
      removeUpNextItemAction(removeBtn, event);
      return;
    }

    const clearBtn = event.target.closest("[data-up-next-clear]");
    if (clearBtn) {
      clearUpNextProgress(clearBtn, event);
      return;
    }

    const watchBtn = event.target.closest("[data-up-next-menu-watch]");
    if (watchBtn) {
      event.preventDefault();
      event.stopPropagation();
      openUpNextWatchPrompt(watchBtn, event);
      return;
    }

    const discoverItemFromButton = (button) => ({
      media_type: button.dataset.discoverMediaType || "movie",
      tmdb_id: button.dataset.discoverTmdbId || "",
      tvdb_id: button.dataset.discoverTvdbId || "",
      imdb_id: button.dataset.discoverImdbId || "",
      title: button.dataset.discoverTitle || "Untitled",
      poster_url: button.dataset.discoverPosterUrl || "",
      release_date: button.dataset.discoverReleaseDate || "",
    });

    const mediaRateButton = event.target.closest("[data-media-rate]");
    if (mediaRateButton) {
      event.preventDefault();
      event.stopPropagation();
      openRatingDialog({
        media_type: mediaRateButton.dataset.mediaRateMediaType || "movie",
        tmdb_id: mediaRateButton.dataset.mediaRateTmdbId || "",
        tvdb_id: mediaRateButton.dataset.mediaRateTvdbId || "",
        imdb_id: mediaRateButton.dataset.mediaRateImdbId || "",
        show_tmdb_id: mediaRateButton.dataset.mediaRateShowTmdbId || "",
        show_tvdb_id: mediaRateButton.dataset.mediaRateShowTvdbId || "",
        show_imdb_id: mediaRateButton.dataset.mediaRateShowImdbId || "",
        episode_tmdb_id: mediaRateButton.dataset.mediaRateEpisodeTmdbId || "",
        episode_tvdb_id: mediaRateButton.dataset.mediaRateEpisodeTvdbId || "",
        episode_imdb_id: mediaRateButton.dataset.mediaRateEpisodeImdbId || "",
        title: mediaRateButton.dataset.mediaRateTitle || "Untitled",
        show_title: mediaRateButton.dataset.mediaRateShowTitle || "",
        season: mediaRateButton.dataset.mediaRateSeason || "",
        episode: mediaRateButton.dataset.mediaRateEpisode || "",
        poster_url: mediaRateButton.dataset.mediaRatePosterUrl || "",
        overview: mediaRateButton.dataset.mediaRateOverview || "",
        release_date: mediaRateButton.dataset.mediaRateReleaseDate || "",
      });
      return;
    }

    const posterPersonalAction = event.target.closest("[data-poster-menu-watchlist], [data-poster-menu-list-id], [data-poster-menu-create-list]");
    if (posterPersonalAction) {
      event.preventDefault();
      event.stopPropagation();
      const item = personalItemFromPosterMenuDataset(posterPersonalAction.dataset);
      if (posterPersonalAction.matches("[data-poster-menu-watchlist]")) {
        const isAdd = posterPersonalAction.dataset.posterMenuWatchlist === "add";
        const originalLabel = posterPersonalAction.textContent || (isAdd ? "Add to watch list" : "Remove from watch list");
        const pendingLabel = isAdd ? "Saving…" : "Removing…";
        const pendingDescription = isAdd ? "Saving to watchlist" : "Removing from watchlist";
        updatePosterMenuAction(posterPersonalAction, {
          label: pendingLabel,
          ariaLabel: pendingDescription,
          title: pendingDescription,
          busy: true,
          disabled: true,
        });
        setPosterOverflowMenuActionPending(posterPersonalAction, true);
        const request = isAdd
          ? addToWatchlist(item, { showMessage: false })
          : removeFromWatchlist(item, { showMessage: false });
        request
          .then(() => {
            const label = isAdd ? "Added to watchlist" : "Removed from watchlist";
            updatePosterMenuAction(posterPersonalAction, { label, ariaLabel: label, title: label, disabled: true });
            posterPersonalAction.dataset.posterMenuWatchlist = isAdd ? "added" : "removed";
          })
          .catch((error) => {
            updatePosterMenuAction(posterPersonalAction, {
              label: originalLabel,
              ariaLabel: originalLabel,
              title: originalLabel,
              disabled: false,
            });
            setMessage(error.message, "error");
          })
          .finally(() => setPosterOverflowMenuActionPending(posterPersonalAction, false));
      } else if (posterPersonalAction.matches("[data-poster-menu-list-id]")) {
        const originalLabel = posterPersonalAction.textContent;
        const isRemove = posterPersonalAction.dataset.posterMenuListAction === "remove";
        const listName = posterPersonalAction.dataset.posterMenuListName
          || originalLabel.replace(/^Remove from\s+/, "")
          || "Custom list";
        const pendingLabel = `${listName} - ${isRemove ? "Removing…" : "Saving…"}`;
        updatePosterMenuAction(posterPersonalAction, {
          label: pendingLabel,
          ariaLabel: pendingLabel,
          title: pendingLabel,
          busy: true,
          disabled: true,
        });
        setPosterOverflowMenuActionPending(posterPersonalAction, true);
        const request = isRemove
          ? removeFromCustomList(item, posterPersonalAction.dataset.posterMenuListId, { showMessage: false })
          : addToCustomList(item, posterPersonalAction.dataset.posterMenuListId, { showMessage: false });
        request
          .then(() => {
            const label = `${listName} - ${isRemove ? "Removed" : "Added"}`;
            updatePosterMenuAction(posterPersonalAction, { label, ariaLabel: label, title: label, disabled: true });
            posterPersonalAction.dataset.posterMenuListAction = isRemove ? "removed" : "added";
          })
          .catch((error) => {
            updatePosterMenuAction(posterPersonalAction, {
              label: originalLabel,
              ariaLabel: originalLabel,
              title: originalLabel,
              disabled: false,
            });
            setMessage(error.message, "error");
          })
          .finally(() => setPosterOverflowMenuActionPending(posterPersonalAction, false));
      } else {
        closePosterOverflowMenu();
        openCreateListDialog(item);
      }
      return;
    }

    const discoverWatchButton = event.target.closest("[data-discover-mark-watched]");
    if (discoverWatchButton) {
      event.preventDefault();
      event.stopPropagation();
      markDiscoverWatched(discoverItemFromButton(discoverWatchButton)).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const discoverSeerrButton = event.target.closest("[data-discover-seerr-request]");
    if (discoverSeerrButton) {
      event.preventDefault();
      event.stopPropagation();
      const mediaType = discoverSeerrButton.dataset.seerrMediaType || discoverSeerrButton.dataset.discoverMediaType || "movie";
      const mediaId = discoverSeerrButton.dataset.seerrMediaId || discoverSeerrButton.dataset.discoverTmdbId || "";
      submitSeerrRequest(mediaType, mediaId, discoverSeerrButton);
      return;
    }

    const discoverWatchlistButton = event.target.closest("[data-discover-watchlist]");
    if (discoverWatchlistButton) {
      event.preventDefault();
      event.stopPropagation();
      const item = discoverItemFromButton(discoverWatchlistButton);
      const action = discoverWatchlistButton.dataset.discoverWatchlist === "remove" ? removeFromWatchlist : addToWatchlist;
      action(item).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const discoverRateButton = event.target.closest("[data-discover-rate]");
    if (discoverRateButton) {
      event.preventDefault();
      event.stopPropagation();
      openRatingDialog(discoverItemFromButton(discoverRateButton));
      return;
    }

    const discoverListButton = event.target.closest("[data-discover-add-list]");
    if (discoverListButton) {
      event.preventDefault();
      event.stopPropagation();
      openAddToListDialog(discoverItemFromButton(discoverListButton));
      return;
    }

  });

  elements.syncProgressIndicator?.addEventListener("click", () => {
    closeMobileMenu();
    navigateTo("/sync-activity");
  });

  elements.sidebarSyncAttentionButton?.addEventListener("click", () => {
    closeMobileMenu();
    navigateTo("/sync-activity");
  });

  elements.syncActivityRefresh?.addEventListener("click", () => {
    _cb.loadSyncActivity?.({ force: true })?.catch?.(() => { });
  });

  elements.syncActivityRetryAllFailed?.addEventListener("click", async () => {
    const button = elements.syncActivityRetryAllFailed;
    if (!button || button.disabled) return;
    const idleLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Checking...";
    let started = false;
    try {
      const ids = await _cb.fetchAllRetryableSyncActivityIds?.() || [];
      if (!ids.length) {
        setMessage("No failed or skipped sync items to retry.", "muted");
        return;
      }
      const confirmed = await openConfirmDialog({
        title: "Retry all failed sync items?",
        body: `This retries ${ids.length} failed or skipped item${ids.length === 1 ? "" : "s"} across your entire sync history, not just this page - one at a time, as a background job that keeps running even if you close this tab. Each one dispatches to your media servers and/or Trakt, so this may take a while.`,
        confirmLabel: "Retry all",
      });
      if (!confirmed) return;
      started = true;
      await _cb.startRetryAllSyncActivity?.((result) => {
        if (!result) return;
        if (result.cancelled) {
          setMessage("Retry all was cancelled.", "muted");
        } else if (result.success) {
          setMessage(`Retry all complete: ${result.succeeded || 0} succeeded, ${result.stillFailed || 0} still failed, ${result.skipped || 0} skipped, out of ${result.total || 0}.`, (result.stillFailed || result.errored) ? "warning" : "success");
        } else {
          setMessage(result.error || "Retry all finished with an error.", "error");
        }
      });
    } catch (error) {
      setMessage(error.message || "Could not start retry all.", "error");
    } finally {
      // Once a run actually starts, the polling loop's own renderSyncActivity
      // calls own the button's label/disabled state from here on (including
      // re-disabling it once the job finishes) - only reset it directly for
      // the paths above that returned before a run ever started (checking
      // failed, nothing found, cancelled, or the start request itself failed).
      if (!started) {
        button.textContent = idleLabel;
        button.disabled = false;
      }
    }
  });

  elements.syncActivitySummary?.addEventListener("click", () => {
    if (!elements.syncActivitySummary.hasAttribute("data-sync-activity-failed-toggle")) return;
    _cb.toggleSyncActivityFailedOnly?.();
  });

  elements.syncActivityAttention?.addEventListener("click", async (event) => {
    const fixMatch = event.target.closest("[data-sync-attention-fix-match]");
    if (fixMatch && !fixMatch.disabled) {
      const id = String(fixMatch.dataset.syncAttentionFixMatch || "");
      const itemKey = String(fixMatch.dataset.syncAttentionItemKey || "");
      const parent = (state.syncAttention || []).find((candidate) => String(candidate.id) === id);
      const issue = parent?.context?.issueItems?.find((candidate) => String(candidate.key || candidate.sourceRowId || "") === itemKey);
      if (!issue) {
        setMessage("That restore issue is no longer available. Refresh Sync Activity and try again.", "error");
        return;
      }
      fixMatch.disabled = true;
      try {
        await openSyncAttentionFixMatch(issue);
      } catch (error) {
        setMessage(error.message || "Could not open Fix match.", "error");
      } finally {
        if (fixMatch.isConnected) fixMatch.disabled = false;
      }
      return;
    }

    const retryShow = event.target.closest("[data-sync-attention-retry-show]");
    if (retryShow && !retryShow.disabled) {
      const id = String(retryShow.dataset.syncAttentionRetryShow || "");
      const showKey = String(retryShow.dataset.syncAttentionShowKey || "");
      try {
        const result = await _cb.retrySyncAttentionShow?.(id, showKey);
        setMessage(result?.message || "Show retry complete.", result?.failed > 0 ? "warning" : "success");
      } catch (error) {
        setMessage(error.message || "Could not retry this show.", "error");
      }
      return;
    }

    const skipShow = event.target.closest("[data-sync-attention-skip-show]");
    if (skipShow && !skipShow.disabled) {
      const id = String(skipShow.dataset.syncAttentionSkipShow || "");
      const showKey = String(skipShow.dataset.syncAttentionShowKey || "");
      const parent = (state.syncAttention || []).find((candidate) => String(candidate.id) === id);
      const allIssues = Array.isArray(parent?.context?.issueItems) ? parent.context.issueItems : [];
      const showIssues = allIssues.filter((issue) => {
        const explicit = String(issue.showTitle || issue.show_title || "").trim();
        const title = String(issue.title || "").trim();
        const stripped = explicit || title.replace(/\s*-?\s*S\d{1,3}E\d{1,3}\b.*$/i, "").trim() || title;
        return String(stripped).toLowerCase().replace(/[^a-z0-9]+/g, "").trim() === showKey;
      });
      const showTitle = showIssues[0]?.showTitle || showIssues[0]?.show_title || "this show";
      const count = showIssues.length || 1;
      const confirmed = await openConfirmDialog({
        title: `Skip all plays for ${showTitle}?`,
        body: `${count} ${count === 1 ? "play" : "plays"} for "${showTitle}" will remain missing from Trakt. The restore fence stays active until every remaining issue is repaired or skipped.`,
        confirmLabel: `Skip ${count} ${count === 1 ? "play" : "plays"}`,
      });
      if (!confirmed) return;
      try {
        const result = await _cb.skipSyncAttentionShow?.(id, showKey);
        setMessage(result?.message || `Plays for "${showTitle}" skipped.`, result?.released ? "warning" : "muted");
      } catch (error) {
        setMessage(error.message || `Could not skip plays for "${showTitle}".`, "error");
      }
      return;
    }

    const toggleShow = event.target.closest("[data-sync-attention-toggle-show]");
    if (toggleShow) {
      if (event.target.closest("button, a, input")) return;
      const id = String(toggleShow.dataset.syncAttentionToggleShow || "");
      const showKey = String(toggleShow.dataset.syncAttentionShowKey || "");
      const actionKey = `${id}:${showKey}`;
      if (!state.syncAttentionExpandedShows) state.syncAttentionExpandedShows = new Set();
      if (state.syncAttentionExpandedShows.has(actionKey)) {
        state.syncAttentionExpandedShows.delete(actionKey);
      } else {
        state.syncAttentionExpandedShows.add(actionKey);
      }
      _cb.renderSyncAttention?.();
      return;
    }

    const retryItem = event.target.closest("[data-sync-attention-retry-item]");
    if (retryItem && !retryItem.disabled) {
      const id = String(retryItem.dataset.syncAttentionRetryItem || "");
      const itemKey = String(retryItem.dataset.syncAttentionItemKey || "");
      try {
        const result = await _cb.retrySyncAttentionItem?.(id, itemKey);
        setMessage(result?.message || "The restored item was repaired.", "success");
      } catch (error) {
        setMessage(error.message || "Could not retry this restored item.", "error");
      }
      return;
    }

    const skipItem = event.target.closest("[data-sync-attention-skip-item]");
    if (skipItem && !skipItem.disabled) {
      const id = String(skipItem.dataset.syncAttentionSkipItem || "");
      const itemKey = String(skipItem.dataset.syncAttentionItemKey || "");
      const parent = (state.syncAttention || []).find((candidate) => String(candidate.id) === id);
      const issue = parent?.context?.issueItems?.find((candidate) => String(candidate.key) === itemKey);
      const confirmed = await openConfirmDialog({
        title: "Skip this restored play?",
        body: `${issue?.title || "This play"} will remain missing from Trakt. The restore fence stays active until every remaining issue is repaired or skipped.`,
        confirmLabel: "Skip this play",
      });
      if (!confirmed) return;
      try {
        const result = await _cb.skipSyncAttentionItem?.(id, itemKey);
        setMessage(result?.message || "Restore play skipped.", result?.released ? "warning" : "muted");
      } catch (error) {
        setMessage(error.message || "Could not skip this restored play.", "error");
      }
      return;
    }

    const skip = event.target.closest("[data-sync-attention-skip]");
    if (!skip || skip.disabled) return;
    const id = String(skip.dataset.syncAttentionSkip || "");
    const item = (state.syncAttention || []).find((candidate) => String(candidate.id) === id);
    const confirmed = await openConfirmDialog({
      title: "Skip this sync issue?",
      body: `${item?.summary || "This sync operation did not complete."}\n\nSkipping acknowledges the incomplete projection and releases the restore fence when it belongs to this issue. The missing remote records will not be created automatically.`,
      confirmLabel: item?.skipLabel || "Skip and resume sync",
    });
    if (!confirmed) return;
    try {
      const result = await _cb.skipSyncAttention?.(id);
      setMessage(result?.message || "Sync issue skipped.", result?.released ? "warning" : "muted");
    } catch (error) {
      setMessage(error.message || "Could not skip this sync issue.", "error");
    }
  });

  elements.syncAttention?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const toggleShow = event.target.closest("[data-sync-attention-toggle-show]");
    if (!toggleShow) return;
    event.preventDefault();
    toggleShow.click();
  });

  elements.syncActivitySearch?.addEventListener("input", (event) => {
    _cb.setSyncActivitySearch?.(event.target.value);
  });

  const changeSyncActivityPage = (delta) => {
    const pagination = state.syncActivityPagination || {};
    const page = Math.max(Number(pagination.page) || 1, 1) + delta;
    if (page < 1 || (pagination.totalPages && page > Number(pagination.totalPages))) return;
    _cb.loadSyncActivity?.({ page })?.catch?.(() => { });
  };

  elements.syncActivityPrevious?.addEventListener("click", () => changeSyncActivityPage(-1));
  elements.syncActivityNext?.addEventListener("click", () => changeSyncActivityPage(1));

  elements.syncActivityPagination?.addEventListener("click", (event) => {
    const pageButton = event.target.closest("[data-sync-activity-page]");
    if (!pageButton) return;
    const page = Number(pageButton.dataset.syncActivityPage);
    if (!Number.isFinite(page) || page < 1 || page === Number(state.syncActivityPagination?.page)) return;
    _cb.loadSyncActivity?.({ page })?.catch?.(() => { });
  });

  elements.syncActivityRows?.addEventListener("click", (event) => {
    const retry = event.target.closest("[data-sync-activity-retry]");
    if (retry) {
      // Feedback renders inline on the row itself (and is folded into its log)
      // rather than as a toast - retrySyncActivity handles every outcome
      // internally and never throws, so there's nothing to do with the result here.
      _cb.retrySyncActivity?.(retry.dataset.syncActivityRetry)?.catch?.(() => { });
      return;
    }

    const older = event.target.closest("[data-sync-activity-group-more]");
    if (older) {
      older.disabled = true;
      older.textContent = "Loading older events...";
      _cb.loadOlderSyncActivityGroup?.(older.dataset.syncActivityGroupMore, older.dataset.syncActivityGroupPage)
        ?.catch?.((error) => setMessage(error.message || "Could not load older activity.", "error"));
      return;
    }

    const download = event.target.closest("[data-sync-activity-download]");
    if (download) {
      Promise.resolve(_cb.downloadSyncActivityLog?.(download.dataset.syncActivityDownload))
        .then((downloaded) => {
          if (!downloaded) setMessage("That sync log is no longer available - refresh the page.", "error");
        })
        .catch((error) => setMessage(error.message || "Could not download the sync log.", "error"));
      return;
    }

    const titleLink = event.target.closest("[data-media-href]");
    if (titleLink?.dataset.mediaHref) {
      navigateTo(titleLink.dataset.mediaHref);
      return;
    }

    if (event.target.closest(".sync-activity-group-detail")) return;

    const row = event.target.closest(".sync-activity-row");
    if (row) _cb.toggleSyncActivityRowLog?.(row);
  });

  elements.syncActivityRows?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target.closest(".sync-activity-group-detail") || event.target.closest("button,[data-media-href]")) return;
    const row = event.target.closest(".sync-activity-group-row");
    if (!row) return;
    event.preventDefault();
    _cb.toggleSyncActivityRowLog?.(row);
  });

  elements.appVersion?.addEventListener("click", () => {
    closeMobileMenu();
    navigateTo("/settings/about");
  });

  elements.changelogRefreshButton?.addEventListener("click", () => {
    renderChangelog(true).catch(() => { });
  });

  elements.lockButton.addEventListener("click", () => {
    closeMobileMenu();
    lockDashboard();
  });
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
      const topnav = document.querySelector(".topnav");
      if (topnav?.classList.contains("nav-open")) {
        closeMobileMenu();
        document.getElementById("hamburgerButton")?.focus({ preventScroll: true });
        return;
      }
      if (document.querySelector(".media-info-overlay")) {
        closeMediaInfoModal();
        return;
      }
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

  elements.rotateWebhookButton?.addEventListener("click", () => {
    showConfirmModal(
      "Rotating your webhook secret will immediately invalidate your current webhook token.\n\nAll incoming webhook events sent using the old secret will fail with an HTTP 401 Unauthorized error until you update the URL in every configured service.",
      () => {
        showConfirmModal(
          "Are you 100% sure you want to rotate your webhook secret right now?\n\nRemember: Your media servers (Plex, Emby, Jellyfin) and automation scripts will stop syncing watchstates until you paste the new URL into their settings.",
          async () => {
            try {
              await rotateWebhookSecret();
              renderSettingsInlineHelp();
              setMessage("Webhook secret rotated successfully. Remember to update the URL in Plex, Emby, Jellyfin, and your automation clients.", "success");
            } catch (error) {
              setMessage(`Failed to rotate webhook secret: ${error.message}`, "error");
            }
          },
          {
            title: "Final Confirmation: Rotate Webhook Secret",
            approveLabel: "Yes, Rotate Secret Now",
          }
        );
      },
      {
        title: "Rotate Webhook Secret - Step 1 of 2",
        approveLabel: "Proceed to Final Step",
        mediaHtml: `
          <div style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 8px; padding: 12px; margin-bottom: 12px; font-size: 0.82rem; line-height: 1.5; color: var(--text);">
            <b style="color: #ef4444; display: block; margin-bottom: 6px; font-size: 0.88rem;">⚠️ Required Updates After Rotation:</b>
            <ol style="margin: 0; padding-left: 1.2rem; display: grid; gap: 4px;">
              <li><b>Plex Media Server:</b> Update the Webhook URL in Plex Web Settings ➔ Webhooks.</li>
              <li><b>Emby Server:</b> Update the Webhook URL in Emby Server Settings ➔ Webhooks.</li>
              <li><b>Jellyfin Server:</b> Update the generic webhook URL in Jellyfin Dashboard ➔ Plugins ➔ Webhooks.</li>
              <li><b>Automation Clients:</b> Update any scripts, daemons, or tools passing <code>X-Plembfin-Webhook-Secret</code> or <code>Authorization: Bearer</code> headers.</li>
            </ol>
          </div>
        `,
      }
    );
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
    const loadMorePeople = e.target.closest("[data-search-load-more-people]");
    if (loadMorePeople) {
      e.stopPropagation();
      loadMoreSearchPeople();
      return;
    }
    const collectionToggle = e.target.closest("[data-search-collection]");
    if (collectionToggle) {
      e.preventDefault();
      e.stopPropagation();
      loadSearchCollection(collectionToggle.dataset.searchCollection);
      return;
    }
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

  elements.remotePlembfinBackupList?.addEventListener("click", (event) => {
    const restoreBtn = event.target.closest("[data-plembfin-remote-backup-restore]");
    if (restoreBtn) {
      const filename = restoreBtn.dataset.plembfinRemoteBackupRestore;
      const destinationId = restoreBtn.dataset.restoreDestId;
      restoreRemotePlembfinBackup(destinationId, filename).catch((error) => setMessage(error.message, "error"));
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

  if (elements.phantomAuditButton) {
    elements.phantomAuditButton.addEventListener("click", () => {
      _cb.runPhantomWatchAudit?.().catch((error) => {
        if (elements.phantomAuditStatus) elements.phantomAuditStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.phantomRepairButton) {
    elements.phantomRepairButton.addEventListener("click", () => {
      _cb.runPhantomWatchRepair?.().catch((error) => {
        if (elements.phantomAuditStatus) elements.phantomAuditStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.duplicateWatchTvButton) {
    elements.duplicateWatchTvButton.addEventListener("click", () => {
      _cb.runDuplicateWatchCleanup?.("episode").catch((error) => {
        if (elements.duplicateWatchStatus) elements.duplicateWatchStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.duplicateWatchMovieButton) {
    elements.duplicateWatchMovieButton.addEventListener("click", () => {
      _cb.runDuplicateWatchCleanup?.("movie").catch((error) => {
        if (elements.duplicateWatchStatus) elements.duplicateWatchStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.episodeTitleAuditButton) {
    elements.episodeTitleAuditButton.addEventListener("click", () => {
      runEpisodeTitleAudit().catch((error) => {
        if (elements.episodeTitleStatus) elements.episodeTitleStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.episodeTitleBackfillButton) {
    elements.episodeTitleBackfillButton.addEventListener("click", () => {
      runEpisodeTitleBackfill().catch((error) => {
        if (elements.episodeTitleStatus) elements.episodeTitleStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.wipeDataContent) {
    elements.wipeDataContent.addEventListener("click", (event) => {
      const button = event.target.closest("[data-wipe-scope]");
      if (!button) return;
      _cb.runWipeData?.(button.dataset.wipeScope)?.catch?.(() => {});
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
    const path = window.location.pathname + window.location.search + window.location.hash;
    closeMobileMenu();
    _cb.resetPageEntryState?.(path);
    handleRouting(path);
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

  // Keep the legacy Part Watched panel fallbacks for older embeds. The current
  // dashboard renders resume cards through the mixed Up Next rail.
  (elements.partWatchedRows || elements.partWatchedPanel || elements.timelineView)?.addEventListener("click", async (event) => {
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
    event.preventDefault();
    event.stopPropagation();

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
          setMessage(
            body.queued
              ? `Progress cleared for "${title}"; unwatched sync queued until the current blocking operation completes`
              : `Progress cleared for "${title}"`,
            "success",
          );
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
