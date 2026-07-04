import { buildAuthHeaders, buildNowPlayingUrl } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, platformBadge, sourceClass, sourceBadgeHtml, computeProgress, formatDate, formatPlaybackClock, showName } from "./utils.js";
import { hydratePosters, posterMarkup } from "./images.js";

const NOW_PLAYING_POLL_MS = 10000;

let _cb = {};

export function initSync(callbacks) {
  _cb = callbacks;
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

export function nowPlayingUrl() {
  return buildNowPlayingUrl(window.location.origin);
}

export function telemetryLineValue(telemetry = "", label = "") {
  const prefix = `${label}:`;
  const line = String(telemetry || "").split(/\r?\n/).find((item) => item.toLowerCase().startsWith(prefix.toLowerCase()));
  return line ? line.slice(prefix.length).trim() : "";
}

export function historyAction(entry = {}) {
  const action = String(entry.sync_action || "").toLowerCase();
  if (["unwatched", "unplayed"].includes(action)) return "Marked Unwatched";
  const telemetryAction = telemetryLineValue(entry.sync_dispatch_telemetry, "Action");
  if (/unwatched|unplayed/i.test(telemetryAction)) return "Marked Unwatched";
  return "Marked Watched";
}

export function isWatchedHistoryAction(entry = {}) {
  return historyAction(entry) !== "Marked Unwatched";
}

export function syncStatus(entry = {}) {
  const telemetry = String(entry.sync_dispatch_telemetry || "");
  if (telemetry.includes("Force Sync resolved status to")) {
    return { tone: "success", label: "Full sync complete", detail: telemetry };
  }
  const status = telemetryLineValue(telemetry, "Dispatch status").toLowerCase();
  const origin = telemetryLineValue(telemetry, "Origin").toLowerCase();
  const details = telemetryLineValue(telemetry, "Details").toLowerCase();
  const hasTargetTelemetry = telemetryTargetStates(telemetry).length > 0;
  if (origin.endsWith("_initial_sync") && !hasTargetTelemetry && details.includes("awaiting outbound sync telemetry")) {
    return { tone: "success", label: "Sync skipped intentionally", detail: "This row came from an initial history import and has no active outbound sync job." };
  }
  if (status === "success") {
    return { tone: "success", label: "Full sync complete", detail: "All configured target apps accepted this watched-state change." };
  }
  if (["pending", "queued", "in_progress", "in progress"].includes(status)) {
    return { tone: "pending", label: "Sync in progress", detail: "Propagation is queued or waiting for target app responses." };
  }
  if (status === "skipped") {
    return { tone: "success", label: "Sync skipped intentionally", detail: "No outbound sync was required for this history row." };
  }
  return { tone: "error", label: "Sync needs attention", detail: status ? "One or more target apps did not confirm this watched-state change." : "No dispatch telemetry was recorded for this history row." };
}

export function historySyncPill(entry = {}) {
  return `
    <span class="history-sync-row">
      <span class="history-action-pill ${sourceClass(entry.source)}">${escapeHtml(platformBadge(entry.source))} - ${escapeHtml(historyAction(entry))}</span>
      ${renderSyncStatusDot(entry)}
    </span>
  `;
}

export function getActiveTargets() {
  const targets = [];
  // /api/config exposes a `configured` flag per section instead of raw credentials.
  if (state.savedConfig.plex?.baseUrl && state.savedConfig.plex?.configured && !state.savedConfig.plex?.disabled) targets.push("plex");
  if (state.savedConfig.emby?.baseUrl && state.savedConfig.emby?.configured && state.savedConfig.emby?.userId && !state.savedConfig.emby?.disabled) targets.push("emby");
  if (state.savedConfig.jellyfin?.baseUrl && state.savedConfig.jellyfin?.configured && state.savedConfig.jellyfin?.userId && !state.savedConfig.jellyfin?.disabled) targets.push("jellyfin");
  return targets;
}

export function sourcePlatform(value = "") {
  const source = String(value || "").toLowerCase();
  if (source.startsWith("plex")) return "plex";
  if (source.startsWith("emby")) return "emby";
  if (source.startsWith("jellyfin")) return "jellyfin";
  return "";
}

export function normalizeTargetStatus(value = "") {
  const status = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["fulfilled", "ok", "complete", "completed"].includes(status)) return "success";
  if (["queued", "in_progress", "checking"].includes(status)) return "pending";
  if (["not_found", "not_attempted", "unavailable"].includes(status)) return "skipped";
  return status || "pending";
}

export function targetStateUnavailable(targetState = {}) {
  const text = `${targetState.rawStatus || targetState.status || ""} ${targetState.detail || ""}`.toLowerCase();
  return text.includes("no matching") || text.includes("not_found") || text.includes("not found") || text.includes("unavailable");
}

export function targetStateNoop(targetState = {}) {
  const text = `${targetState.rawStatus || targetState.status || ""} ${targetState.detail || ""}`.toLowerCase();
  return text.includes("not attempted") || text.includes("historical import") || text.includes("stored locally");
}

export function hasConfirmedMediaAvailability(entry = {}, states = []) {
  const activeTargets = getActiveTargets();
  const telemetry = String(entry.sync_dispatch_telemetry || entry.syncDispatchTelemetry || "");
  if (telemetry.includes("Force Sync resolved status to success")) return true;
  if (activeTargets.includes(sourcePlatform(entry.source))) return true;
  return states.some((s) => normalizeTargetStatus(s.status) === "success");
}

export function sharedLibraryAvailability(entry = {}, states = telemetryTargetStates(entry.sync_dispatch_telemetry || entry.syncDispatchTelemetry || "")) {
  if (!hasConfirmedMediaAvailability(entry, states)) return null;
  return { statusClass: "success", statusLabel: "Available" };
}

export function getMediaTargetSyncStatus(entry = {}) {
  const activeTargets = getActiveTargets();
  const telemetry = String(entry.sync_dispatch_telemetry || entry.syncDispatchTelemetry || "");

  if (telemetry.includes("Force Sync resolved status to success")) {
    return activeTargets.map(target => ({ target, status: "success" }));
  }

  const states = telemetryTargetStates(telemetry);
  const source = String(entry.source || "").toLowerCase();
  const available = hasConfirmedMediaAvailability(entry, states);

  return activeTargets.map((target) => {
    if (source === target || source.startsWith(`${target}_`)) {
      return { target, status: "success" };
    }
    const match = states.find((s) => s.target === target);
    if (match) {
      const status = normalizeTargetStatus(match.status);
      if (status === "success" || status === "pending" || status === "error") {
        return { target, status };
      }
      if ((targetStateUnavailable(match) || targetStateNoop(match)) && !available) {
        return { target, status: "skipped", hidden: true, detail: match.detail };
      }
      if (targetStateUnavailable(match) && available) {
        return { target, status: "error", detail: match.detail };
      }
      if (targetStateNoop(match) && available) {
        return { target, status: "pending", detail: match.detail };
      }
      return { target, status: "skipped", detail: match.detail };
    }

    if (telemetry.includes("Details: Historical import stored locally") || telemetry.includes("Origin: import")) {
      return { target, status: "skipped", hidden: true };
    }

    if (!available) {
      return { target, status: "skipped", hidden: true };
    }

    return { target, status: "pending" };
  });
}

export function getSyncStatusTone(entry = {}) {
  const activeTargets = getActiveTargets();
  if (!activeTargets.length) return "success";
  const statuses = getMediaTargetSyncStatus(entry).filter((s) => !s.hidden);
  if (!statuses.length) return "";
  if (statuses.some((s) => s.status === "error")) {
    return "error";
  }
  if (statuses.some((s) => s.status === "pending")) {
    return "pending";
  }
  return "success";
}

export function getSyncStatusTooltip(entry = {}) {
  const activeTargets = getActiveTargets();
  if (!activeTargets.length) return "No targets configured";
  const statuses = getMediaTargetSyncStatus(entry).filter((s) => !s.hidden);
  if (!statuses.length) return "No sync status needed";
  return `Watched sync: ${statuses.map(s => `${platformBadge(s.target)} ${s.status}`).join(", ")}`;
}

export function renderSyncStatusDot(entry = {}, style = "") {
  const tone = getSyncStatusTone(entry);
  if (!tone) return "";
  const tooltip = getSyncStatusTooltip(entry);
  const styleAttr = style ? ` style="${escapeAttribute(style)}"` : "";
  return `<span class="sync-status-dot sync-status-dot--${tone}" data-sync-status-dot="true" role="button" tabindex="0" title="${escapeAttribute(tooltip)}" aria-label="${escapeAttribute(tooltip)}"${styleAttr}></span>`;
}

export function showAvailIssuePopup(anchorEl) {
  const existing = document.getElementById("avail-issue-popup");
  if (existing) existing.remove();

  const message = anchorEl.dataset.availIssue || "Unknown issue.";
  const lines = message.split("\\n");
  const [headline, ...steps] = lines;

  const popup = document.createElement("div");
  popup.id = "avail-issue-popup";
  popup.className = "avail-issue-popup";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-modal", "false");

  const stepsHtml = steps.length
    ? `<ol class="avail-issue-steps">${steps.map(s => `<li>${escapeHtml(s.replace(/^\d+\.\s*/, ""))}</li>`).join("")}</ol>`
    : "";

  popup.innerHTML = `
    <button class="avail-issue-close" type="button" aria-label="Close">✕</button>
    <b class="avail-issue-headline">${escapeHtml(headline)}</b>
    ${stepsHtml ? `<p class="avail-issue-fix-label">Steps to fix:</p>${stepsHtml}` : ""}
  `;

  document.body.appendChild(popup);

  const rect = anchorEl.getBoundingClientRect();
  const popupW = 280;
  let left = rect.left + window.scrollX;
  let top = rect.bottom + window.scrollY + 6;
  if (left + popupW > window.innerWidth - 12) left = window.innerWidth - popupW - 12;
  if (left < 8) left = 8;
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;

  const closePopup = (event) => {
    if (!popup.contains(event?.target) || event?.target.classList.contains("avail-issue-close")) {
      popup.remove();
      document.removeEventListener("click", outsideClick, true);
      document.removeEventListener("keydown", escKey);
    }
  };
  const outsideClick = (event) => {
    if (!popup.contains(event.target) && event.target !== anchorEl) closePopup(event);
  };
  const escKey = (event) => { if (event.key === "Escape") closePopup(); };

  popup.querySelector(".avail-issue-close").addEventListener("click", closePopup);
  setTimeout(() => {
    document.addEventListener("click", outsideClick, true);
    document.addEventListener("keydown", escKey);
  }, 0);
}

export function renderAvailabilityPills(entry = {}) {
  const activeTargets = getActiveTargets();
  if (!activeTargets.length) return "";

  const telemetry = String(entry.sync_dispatch_telemetry || entry.syncDispatchTelemetry || "");
  const states = telemetryTargetStates(telemetry);
  const source = String(entry.source || "").toLowerCase();
  const sharedAvailability = sharedLibraryAvailability(entry, states);

  return activeTargets.map((target) => {
    let statusClass = "pending";
    let issueDetail = "";

    if (sharedAvailability) {
      statusClass = sharedAvailability.statusClass;
    } else if (source === target || source.startsWith(`${target}_`)) {
      statusClass = "success";
    } else {
      const match = states.find((s) => s.target === target);
      if (match) {
        if (match.status === "success") {
          statusClass = "success";
        } else if (match.status === "skipped" && (match.detail.includes("No matching") || match.detail.includes("not_found") || match.detail.includes("not found"))) {
          statusClass = "error";
          issueDetail = `${platformBadge(target)} could not find this title in your library. Steps to fix:\n1. Confirm the title exists in your ${platformBadge(target)} library.\n2. Run a library scan in ${platformBadge(target)}.\n3. Check that your ${platformBadge(target)} server URL and credentials are correct in Settings.\n4. Use Force Sync to re-check all platforms.`;
        } else if (match.status === "error") {
          const detailLower = String(match.detail || "").toLowerCase();
          if (detailLower.includes("not found") || detailLower.includes("404") || detailLower.includes("not_found")) {
            statusClass = "error";
            issueDetail = `${platformBadge(target)} returned a 'not found' error for this title. Steps to fix:\n1. Confirm the title exists in your ${platformBadge(target)} library.\n2. Run a library scan in ${platformBadge(target)}.\n3. Check your server URL and API credentials in Settings.`;
          } else {
            statusClass = "error";
            issueDetail = `${platformBadge(target)} reported an error: ${match.detail || "unknown error"}. Steps to fix:\n1. Check your ${platformBadge(target)} server is running and reachable.\n2. Verify your API key / token in Settings.\n3. Use Force Sync to retry.`;
          }
        } else {
          statusClass = "pending";
          issueDetail = `${platformBadge(target)} sync is still in progress. Steps to fix:\n1. Wait a moment and refresh.\n2. If it stays pending, use Force Sync.\n3. Check the Sync Jobs panel for details.`;
        }
      } else {
        if (telemetry.includes("Historical import stored locally") || telemetry.includes("Origin: import")) {
          statusClass = "pending";
          issueDetail = `${platformBadge(target)} sync has not run yet for this imported item. Steps to fix:\n1. Use Force Sync to push this watched-state to all platforms.\n2. Check the Sync Jobs panel for progress.`;
        } else {
          statusClass = "pending";
          issueDetail = `${platformBadge(target)} availability is unknown. Steps to fix:\n1. Use Force Sync to check all platforms.\n2. Verify ${platformBadge(target)} credentials in Settings.`;
        }
      }
    }

    const displayTarget = platformBadge(target);
    const issueAttr = (statusClass !== "success" && issueDetail) ? ` data-avail-issue="${escapeAttribute(issueDetail)}" role="button" tabindex="0" style="cursor:pointer;"` : "";
    return `<span class="target-pill avail-pill" data-status="${statusClass}"${issueAttr} title="${escapeAttribute(displayTarget)}">${escapeHtml(displayTarget)}</span>`;
  }).join(" ");
}

export function renderShowAvailabilityPills(show = {}) {
  const activeTargets = getActiveTargets();
  if (!activeTargets.length) return "";

  const episodes = show.episodes || [];
  const watchedEpisodes = episodes.filter(e => isWatchedHistoryAction(e));
  const sharedAvailable = watchedEpisodes.some((episode) => sharedLibraryAvailability(episode));

  return activeTargets.map((target) => {
    let statusClass = "pending";
    let issueDetail = "";

    let anyAvailable = false;
    let anyChecked = false;
    let allUnavailable = true;

    for (const ep of watchedEpisodes) {
      const source = String(ep.source || "").toLowerCase();
      if (source === target || source.startsWith(`${target}_`)) {
        anyAvailable = true;
        anyChecked = true;
        allUnavailable = false;
        break;
      }

      const telemetry = String(ep.sync_dispatch_telemetry || ep.syncDispatchTelemetry || "");
      const states = telemetryTargetStates(telemetry);
      const match = states.find((s) => s.target === target);
      if (match) {
        anyChecked = true;
        if (match.status === "success") {
          anyAvailable = true;
          allUnavailable = false;
          break;
        } else if (match.status === "skipped" && (match.detail.includes("No matching") || match.detail.includes("not_found") || match.detail.includes("not found"))) {
          // Continue loop — item not found on this target, keep checking
        } else {
          allUnavailable = false;
        }
      } else {
        allUnavailable = false;
      }
    }

    if (sharedAvailable || anyAvailable) {
      statusClass = "success";
    } else if (anyChecked && allUnavailable && watchedEpisodes.length > 0) {
      statusClass = "error";
      issueDetail = `${platformBadge(target)} could not find this show in your library. Steps to fix:\n1. Confirm the show exists in your ${platformBadge(target)} library.\n2. Run a library scan in ${platformBadge(target)}.\n3. Check that your server URL and credentials are correct in Settings.\n4. Use Force Sync to re-check.`;
    } else {
      statusClass = "pending";
      issueDetail = `${platformBadge(target)} availability is still being determined. Steps to fix:\n1. Use Force Sync to push watched-state to all platforms.\n2. Check the Sync Jobs panel for details.\n3. Verify ${platformBadge(target)} credentials in Settings.`;
    }

    const displayTarget = platformBadge(target);
    const issueAttr = (statusClass !== "success" && issueDetail) ? ` data-avail-issue="${escapeAttribute(issueDetail)}" role="button" tabindex="0" style="cursor:pointer;"` : "";
    return `<span class="target-pill avail-pill" data-status="${statusClass}"${issueAttr} title="${escapeAttribute(displayTarget)}">${escapeHtml(displayTarget)}</span>`;
  }).join(" ");
}

export function renderMediaSyncPills(entry = {}, showRetry = true) {
  const activeTargets = getActiveTargets();
  if (!activeTargets.length) return "";

  const statuses = getMediaTargetSyncStatus(entry).filter((s) => !s.hidden);
  if (!statuses.length) return "";
  const allSynced = statuses.every((s) => s.status === "success" || s.status === "skipped");

  const pillsHtml = statuses
    .map((s) => {
      const statusClass = s.status === "success" ? "success" : s.status === "pending" ? "pending" : "error";
      return `<span class="target-pill" data-status="${statusClass}" style="font-size: 0.62rem; padding: 0.1rem 0.35rem; margin-right: 0.2rem;" title="${escapeAttribute(`${platformBadge(s.target)}: ${s.status}`)}">${escapeHtml(platformBadge(s.target))}</span>`;
    })
    .join("");

  const retryButtonHtml = (showRetry && !allSynced)
    ? `<button class="retry-sync-btn" type="button" data-retry-sync-id="${escapeAttribute(entry.id)}" title="Retry syncing watched state to all platforms">Retry</button>`
    : "";

  return `
    <div class="media-sync-row">
      <div class="media-sync-pills">
        ${pillsHtml}
      </div>
      ${retryButtonHtml}
    </div>
  `;
}

export function telemetryTargetStates(telemetry = "") {
  const rows = [];
  for (const line of String(telemetry || "").split(/\r?\n/)) {
    const match = line.match(/^(?:Target\s+)?(Plex|Emby|Jellyfin)\s+(?:progress\s+)?status:\s*([^-]+)(?:\s+-\s*(.*))?$/i);
    if (!match) continue;
    rows.push({
      target: match[1].toLowerCase(),
      status: normalizeTargetStatus(match[2]),
      rawStatus: match[2].trim().toLowerCase(),
      detail: (match[3] || "").trim(),
    });
  }
  return rows;
}

export function syncJobSortWeight(job = {}) {
  const status = syncStatus(job).tone;
  if (status === "pending") return 0;
  if (status === "error") return 1;
  return 2;
}

export function renderTargetPills(job = {}) {
  const targets = telemetryTargetStates(job.sync_dispatch_telemetry);
  if (!targets.length) return `<span class="target-pill" data-status="error">No target telemetry</span>`;
  return targets
    .map((target) => {
      const status = target.status === "success" ? "success" : target.status === "pending" ? "pending" : "error";
      const detail = target.detail ? ` - ${target.detail}` : "";
      return `<span class="target-pill" data-status="${status}" title="${escapeAttribute(`${platformBadge(target.target)} ${target.status}${detail}`)}">${escapeHtml(platformBadge(target.target))}: ${escapeHtml(target.status)}</span>`;
    })
    .join("");
}

export function syncJobMediaType(job = {}) {
  return String(job.media_type || "").toLowerCase() === "movie" ? "movie" : "tv";
}

export function syncHistoryTone(entry = {}) {
  const status = String(entry.status || "").toLowerCase();
  const targets = Array.isArray(entry.targetStates) ? entry.targetStates : [];
  if (status === "error" || targets.some((target) => String(target.status || "").toLowerCase() === "error")) return "error";
  if (["pending", "queued", "in_progress", "partial"].includes(status)) return "pending";
  return "success";
}

export function syncHistoryActionLabel(entry = {}) {
  const action = String(entry.action || "").toLowerCase();
  if (action === "progress") return "Resume Progress";
  if (action === "unwatched" || action === "unplayed") return "Marked Unwatched";
  return "Marked Watched";
}

export function syncHistoryTargetPills(entry = {}) {
  const targets = Array.isArray(entry.targetStates) ? entry.targetStates : [];
  if (!targets.length) return `<span class="target-pill" data-status="pending">No target detail</span>`;
  return targets
    .map((target) => {
      const status = String(target.status || "unknown").toLowerCase();
      const tone = status === "success" ? "success" : status === "error" ? "error" : "pending";
      const detail = target.detail ? ` - ${target.detail}` : "";
      return `<span class="target-pill" data-status="${tone}" title="${escapeAttribute(`${platformBadge(target.target)} ${status}${detail}`)}">${escapeHtml(platformBadge(target.target))}: ${escapeHtml(status)}</span>`;
    })
    .join("");
}

export function categorizeIssues(jobs = []) {
  const categories = {
    missingTelemetry: [],
    plexMismatch: [],
    targetMismatch: [],
    otherIssues: [],
  };

  for (const job of jobs) {
    const telemetry = job.sync_dispatch_telemetry || "";
    if (!telemetry || telemetry.trim() === "") {
      categories.missingTelemetry.push(job);
    } else if (telemetry.includes("plex") && telemetry.includes("No matching item found")) {
      categories.plexMismatch.push(job);
    } else if (telemetry.includes("Synced to no targets")) {
      categories.targetMismatch.push(job);
    } else {
      categories.otherIssues.push(job);
    }
  }
  return categories;
}

export function renderIssueCategory(categoryName, jobs = [], helpText = "") {
  if (!jobs.length) return "";

  const titles = {
    missingTelemetry: "Missing Dispatch Telemetry",
    plexMismatch: "Plex Match Issues",
    targetMismatch: "Emby/Jellyfin Match Issues",
    otherIssues: "Unresolved Sync Issues",
  };

  const showFixButtons = categoryName !== 'missingTelemetry';

  return `
    <details class="issue-category">
      <summary style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; padding: var(--space-2); background: rgba(0,0,0,0.1); border-radius: var(--radius-sm); margin-bottom: var(--space-2);">
        <div>
          <b>${titles[categoryName] || categoryName}</b>
          <span style="margin-left: var(--space-2); opacity: 0.7;">${jobs.length} issue${jobs.length !== 1 ? "s" : ""}</span>
        </div>
      </summary>
      <div style="padding: var(--space-2);">
        <div style="background: rgba(0,0,0,0.05); padding: var(--space-2); border-radius: var(--radius-sm); margin-bottom: var(--space-3); font-size: 0.9rem;">
          ${helpText}
        </div>
        <div style="display: flex; gap: var(--space-2); margin-bottom: var(--space-3);">
          ${categoryName === 'missingTelemetry' ? `<button class="button-primary sync-action-btn" type="button" data-action="clearMissingTelemetry">Clear ${jobs.length} Records</button>` : `<button class="button-primary sync-action-btn" type="button" data-action="retryAllCategory" data-category="${categoryName}">Retry All ${jobs.length}</button>`}
        </div>
        <div style="display: grid; gap: var(--space-2);">
          ${jobs.map(job => {
            const telemetry = String(job.sync_dispatch_telemetry || "");
            return `
            <details class="sync-issue-card" style="background: rgba(0,0,0,0.02); border-left: 3px solid var(--color-warning); border-radius: var(--radius-sm); overflow: hidden;">
              <summary style="display: flex; gap: var(--space-2); align-items: flex-start; padding: var(--space-2); cursor: pointer;">
                <div style="flex: 1; min-width: 0;">
                  <div style="font-weight: 500; word-break: break-word;">${escapeHtml(job.title || "Unknown")}</div>
                  <div style="font-size: 0.85rem; opacity: 0.7; margin-top: 0.25rem;">
                    ${escapeHtml(platformBadge(job.source))} • ${escapeHtml(job.media_type || "unknown")} • ${escapeHtml(formatDate(job.watched_at))}
                  </div>
                </div>
                ${showFixButtons ? `
                  <div style="display: flex; gap: var(--space-1); flex-shrink: 0; align-items: center;">
                    <button class="button-ghost media-fix-match-btn sync-btn" type="button" data-edit-id="${escapeAttribute(job.id)}" data-title="${escapeAttribute(job.title || "")}" data-media-type="${escapeAttribute(syncJobMediaType(job))}" style="font-size: 0.75rem; padding: 0.35rem 0.7rem; white-space: nowrap;">Fix</button>
                    <button class="retry-sync-btn sync-job-retry-btn sync-btn" type="button" data-retry-sync-id="${escapeAttribute(job.id)}" style="font-size: 0.75rem; padding: 0.35rem 0.7rem; white-space: nowrap;">Retry</button>
                    <button class="button-ghost dismiss-issue-btn sync-btn" type="button" data-dismiss-id="${escapeAttribute(job.id)}" title="Dismiss this issue" style="font-size: 0.75rem; padding: 0.35rem 0.55rem; color: var(--muted); white-space: nowrap;">✕</button>
                  </div>
                ` : ''}
              </summary>
              ${telemetry ? `
                <div style="background: rgba(0,0,0,0.05); padding: var(--space-2); border-top: 1px solid rgba(0,0,0,0.1); font-size: 0.75rem; font-family: monospace; line-height: 1.4; word-break: break-word; white-space: pre-wrap;">
                  <div style="margin-bottom: var(--space-1); font-weight: 500; opacity: 0.7;">Sync Telemetry Details:</div>
                  ${escapeHtml(telemetry)}
                </div>
              ` : `
                <div style="background: rgba(0,0,0,0.05); padding: var(--space-2); border-top: 1px solid rgba(0,0,0,0.1); font-size: 0.8rem; opacity: 0.7;">
                  ${showFixButtons ? 'Click "Retry" to view detailed error information' : 'No telemetry details available.'}
                </div>
              `}
            </details>
          `;
          }).join("")}
        </div>
      </div>
    </details>
  `;
}

export function renderSyncJobs() {
  const container = document.getElementById("syncIssuesContainer");
  if (!container) return;

  if (state.syncJobsLoading) {
    if (elements.syncSummary) elements.syncSummary.textContent = "Loading...";
    return;
  }

  const jobs = [...state.syncJobs];
  const categories = categorizeIssues(jobs);
  const totalIssues = jobs.length;
  const hasIssues = totalIssues > 0;

  if (elements.syncSummary) {
    const summary = hasIssues
      ? `${totalIssues} issue${totalIssues !== 1 ? "s" : ""}`
      : "All clear";
    elements.syncSummary.textContent = summary;
    elements.syncSummary.className = `status-pill ${hasIssues ? "status-error" : "status-ready"}`;
  }

  if (!hasIssues) {
    container.innerHTML = `<div class="empty-log"><b>No sync issues</b><span>All watched-state dispatches are up to date.</span></div>`;
    return;
  }

  const html = `
    ${renderIssueCategory('missingTelemetry', categories.missingTelemetry,
      'Records without dispatch telemetry are old or incomplete. They likely synced successfully but logging was missing. Safe to clear without affecting actual sync.')}
    ${renderIssueCategory('plexMismatch', categories.plexMismatch,
      'Plex could not find matching items. Check Plex metadata, external IDs, or library content. Emby/Jellyfin may have synced successfully.')}
    ${renderIssueCategory('targetMismatch', categories.targetMismatch,
      'Plex found the item but Emby/Jellyfin could not. Check their metadata and external IDs to match Plex.')}
    ${renderIssueCategory('otherIssues', categories.otherIssues,
      'These items have unresolved sync issues. Check the telemetry for details on what went wrong.')}
  `;

  container.innerHTML = html;
}

export function renderSyncHistory() {
  if (!elements.syncHistoryPanel) return;

  if (state.syncHistoryLoading) {
    elements.syncHistoryPanel.innerHTML = `<div class="empty-log"><b>Loading sync history</b><span>Fetching recent propagation attempts.</span></div>`;
    if (elements.syncHistorySummary) elements.syncHistorySummary.textContent = "Loading";
    return;
  }

  const history = [...state.syncHistory].sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  const errorCount = history.filter((entry) => syncHistoryTone(entry) === "error").length;

  if (elements.syncHistorySummary) {
    elements.syncHistorySummary.textContent = history.length ? `${history.length} recent / ${errorCount} failed` : "No history";
    elements.syncHistorySummary.className = `status-pill ${errorCount ? "status-error" : history.length ? "status-ready" : "status-muted"}`;
  }

  if (!history.length) {
    elements.syncHistoryPanel.innerHTML = `<div class="empty-log"><b>No sync history yet</b><span>New webhook, cron, and resume propagation attempts will appear here.</span></div>`;
    return;
  }

  elements.syncHistoryPanel.innerHTML = history
    .map((entry) => {
      const tone = syncHistoryTone(entry);
      const debug = entry.rawPayloadDebug && Object.keys(entry.rawPayloadDebug).length ? JSON.stringify(entry.rawPayloadDebug, null, 2) : "";
      return `
        <details class="sync-history-card">
          <summary class="sync-history-summary">
            <span class="sync-status-dot sync-status-dot--${tone}" aria-hidden="true"></span>
            <b>${escapeHtml(entry.title || "Unknown media")}</b>
          </summary>
          <div class="sync-job-main">
            <div class="sync-job-title">
              <span>${escapeHtml(platformBadge(entry.source))} - ${escapeHtml(syncHistoryActionLabel(entry))} - ${escapeHtml(formatDate(entry.timestamp))}</span>
            </div>
            <span class="status-pill ${tone === "error" ? "status-error" : tone === "pending" ? "status-warning" : "status-ready"}">${escapeHtml(entry.status || "unknown")}</span>
          </div>
          <div class="sync-job-meta">
            <div><span>Action</span><b>${escapeHtml(syncHistoryActionLabel(entry))}</b></div>
            <div><span>Media</span><b>${escapeHtml(entry.mediaType || "unknown")}</b></div>
            <div><span>Source</span><b>${escapeHtml(platformBadge(entry.source))}</b></div>
            <div><span>Details</span><b>${escapeHtml(entry.details || "No details")}</b></div>
          </div>
          <div class="sync-target-row">${syncHistoryTargetPills(entry)}</div>
          ${debug ? `<pre class="sync-telemetry">${escapeHtml(debug)}</pre>` : ""}
        </details>
      `;
    })
    .join("");
}

export async function loadSyncJobs({ force = false } = {}) {
  if (!state.token || (state.syncJobsLoading && !force)) return state.syncJobs;
  state.syncJobsLoading = true;
  renderSyncJobs();
  try {
    const url = new URL("/api/sync-jobs", window.location.origin);
    url.searchParams.set("status", "outstanding");
    url.searchParams.set("limit", "150");
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Sync jobs load failed with ${response.status}`);
    state.syncJobs = Array.isArray(body.jobs) ? body.jobs : [];
    state.syncJobsLoaded = true;
    return state.syncJobs;
  } finally {
    state.syncJobsLoading = false;
    renderSyncJobs();
  }
}

export async function loadSyncHistory({ force = false } = {}) {
  if (!state.token || (state.syncHistoryLoading && !force)) return state.syncHistory;
  state.syncHistoryLoading = true;
  renderSyncHistory();
  try {
    const url = new URL("/api/sync-history", window.location.origin);
    url.searchParams.set("limit", "100");
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Sync history load failed with ${response.status}`);
    state.syncHistory = Array.isArray(body.history) ? body.history : [];
    state.syncHistoryLoaded = true;
    return state.syncHistory;
  } finally {
    state.syncHistoryLoading = false;
    renderSyncHistory();
  }
}

export function activeSessionsKey(sessions = []) {
  if (!sessions.length) return "empty";
  return sessions
    .map((session) => {
      const progress = Math.round(Number(session.progress ?? computeProgress(session.offsetMs, session.durationMs) ?? 0));
      return [
        session.source || "",
        session.sessionId || session.id || "",
        session.mediaType || session.media_type || "",
        session.title || "",
        session.season ?? "",
        session.episode ?? "",
        progress,
      ].join("|");
    })
    .sort()
    .join("::");
}

export function setActiveSessions(sessions = [], { force = false } = {}) {
  const nextKey = activeSessionsKey(sessions);
  if (!force && nextKey === state.nowPlayingSessionKey) return false;
  state.activeSessions = sessions;
  state.nowPlayingSessionKey = nextKey;
  renderActiveSessions();
  return true;
}

function nowPlayingPosterItem(session = {}) {
  const posterId = session.media_key || session.mediaKey || "";
  if (posterId) {
    return { ...session, id: posterId, media_key: posterId, prefer_raw_poster: true };
  }

  const item = { ...session };
  delete item.id;
  return item;
}

export function renderActiveSessions() {
  if (!elements.nowPlayingGrid) return;

  if (!state.activeSessions.length) {
    elements.nowPlayingGrid.innerHTML = `
      <div class="idle-state">
        <b>No media currently playing.</b>
      </div>
    `;
    if (elements.nowPlayingStatus) elements.nowPlayingStatus.textContent = "";
    _cb.updateDashboardSplitState?.();
    return;
  }

  elements.nowPlayingGrid.innerHTML = state.activeSessions
    .map((session) => {
      const progress = Math.max(0, Math.min(100, Number(session.progress ?? computeProgress(session.offsetMs, session.durationMs))));
      const href = _cb.nowPlayingHref?.(session) ?? "";
      const posterItem = nowPlayingPosterItem(session);
      const isEpisode = session.mediaType === "episode" || (session.season != null && session.episode != null);
      const showTitle = isEpisode ? (session.showTitle || showName(session.title)) : session.title;
      const epLabel = isEpisode && session.season != null && session.episode != null
        ? `S${String(session.season).padStart(2, "0")}E${String(session.episode).padStart(2, "0")}${session.episodeTitle ? ` – ${session.episodeTitle}` : ""}`
        : "";
      const userName = session.client?.userName || "";
      const deviceName = session.client?.deviceName || "";
      return `
        <button class="now-card-large live-now-card" type="button" data-now-playing-href="${escapeAttribute(href)}" aria-label="Open ${escapeAttribute(session.title)} details">
          <span class="now-poster-large-wrapper">
            ${posterMarkup(posterItem, "now-poster-large")}
          </span>
          <div class="now-card-details">
            <div class="now-card-header">
              <div class="now-card-head">
                <span class="stream-indicator">Live</span>
              </div>
              <b class="now-card-title" title="${escapeAttribute(showTitle)}">${escapeHtml(showTitle)}</b>
              ${epLabel ? `<span class="now-card-episode">${escapeHtml(epLabel)}</span>` : ""}
            </div>
            <div class="now-card-meta">
              ${isEpisode && session.season != null ? `<span><span class="meta-label">Season/Ep:</span> S${session.season} · E${session.episode}</span>` : ""}
              ${userName ? `<span><span class="meta-label">User:</span> ${escapeHtml(userName)}</span>` : ""}
              ${deviceName ? `<span><span class="meta-label">Device:</span> ${escapeHtml(deviceName)}</span>` : ""}
              <span><span class="meta-label">App Used:</span> ${sourceBadgeHtml(session.source)}</span>
            </div>
            <div class="now-card-progress-container">
              <div class="now-card-progress-bar">
                <div class="now-card-progress-fill" style="width: ${progress}%;"></div>
              </div>
              <span class="now-card-progress-text">${escapeHtml(formatPlaybackClock(session.offsetMs, session.durationMs))}</span>
            </div>
          </div>
        </button>
      `;
    })
    .join("");

  hydratePosters(elements.nowPlayingGrid);

  if (elements.nowPlayingStatus) {
    elements.nowPlayingStatus.textContent = "";
  }
  _cb.updateDashboardSplitState?.();
}

export async function loadActiveSessions() {
  if (!state.token || state.nowPlayingRequestActive) return state.activeSessions;

  state.nowPlayingRequestActive = true;
  const url = nowPlayingUrl();
  _cb.logDebug?.("Initiating request loop to /api/now-playing unified backend route...", { url: `${url.pathname}?token=present` });

  let response;
  let bodyText = "";
  try {
    response = await fetch(url, {
      headers: authHeaders(),
      cache: "no-store",
    });
    bodyText = await response.clone().text().catch(() => "");
  } catch (error) {
    const message = `Now-playing fetch failed. Reason: FETCH_FAILED (${error?.message || "network request failed"})`;
    _cb.logDebug?.(message);
    throw new Error(message);
  } finally {
    state.nowPlayingLastFetchAt = Date.now();
    state.nowPlayingRequestActive = false;
  }

  _cb.logDebug?.(`Now-playing API returned HTTP ${response.status} ${response.statusText || ""}`.trim(), {
    bodyPreview: bodyText.slice(0, 1200),
  });

  let body = [];
  try {
    body = bodyText ? JSON.parse(bodyText) : [];
  } catch (error) {
    const message = `Now-playing payload parsing exception: ${error?.message || "invalid JSON response"}`;
    _cb.logDebug?.(message, { bodyPreview: bodyText.slice(0, 1200) });
    setActiveSessions([]);
    return [];
  }
  if (!response.ok) {
    const message = `Now playing failed with HTTP ${response.status}`;
    _cb.logDebug?.(message, body);
    setActiveSessions([]);
    return [];
  }

  const refreshToken = response.headers.get("X-Now-Playing-Refresh") || "";
  let sessions = Array.isArray(body) ? body : Array.isArray(body.sessions) ? body.sessions : [];
  _cb.logDebug?.(`Now-playing payload parsed successfully. Active sessions: ${sessions.length}`, sessions);

  const refreshChanged = Boolean(refreshToken && refreshToken !== state.nowPlayingRefreshToken);

  state.nowPlayingRefreshToken = refreshToken || state.nowPlayingRefreshToken;
  setActiveSessions(sessions);

  if (refreshChanged) {
    _cb.loadHistory?.().catch((error) => _cb.setMessage?.(error.message, "error"));
  }

  return sessions;
}

export function pollNowPlayingOnce() {
  if (!state.token || state.activeView !== "dashboard" || document.hidden) {
    stopHistoryPolling();
    return;
  }
  loadActiveSessions().catch((error) => {
    _cb.logDebug?.(`Now Playing poll failed: ${error?.message || "unknown error"}`);
  });
}

export function startHistoryPolling() {
  stopHistoryPolling();
  if (!state.token || state.activeView !== "dashboard" || document.hidden) return;

  _cb.logDebug?.(`Starting Now Playing polling (every ${NOW_PLAYING_POLL_MS / 1000}s).`);
  pollNowPlayingOnce();
  state.nowPlayingInterval = setInterval(pollNowPlayingOnce, NOW_PLAYING_POLL_MS);
}

export function stopHistoryPolling() {
  if (state.nowPlayingInterval) {
    clearInterval(state.nowPlayingInterval);
    state.nowPlayingInterval = undefined;
  }
  _cb.logDebug?.("Stopped Now Playing polling.");
}

export function syncNowPlayingPolling() {
  if (state.activeView === "dashboard") {
    startHistoryPolling();
    return;
  }

  stopHistoryPolling();
}

// ── Sync trigger actions ───────────────────────────────────────────────────

export async function triggerRetrySync(id, button) {
  if (!id || !button) return;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Syncing...";

  const titleEl = document.getElementById("terminalModalTitle");
  if (titleEl) titleEl.textContent = "Retry Sync Terminal";

  elements.terminalModal?.classList.remove("hidden");
  if (elements.retryTerminalOutput) elements.retryTerminalOutput.innerHTML = "";

  function termLog(text, tone = "info") {
    if (!elements.retryTerminalOutput) return;
    const span = document.createElement("span");
    if (tone === "error") { span.style.color = "#fb7185"; span.style.fontWeight = "bold"; }
    else if (tone === "success") { span.style.color = "#34d399"; span.style.fontWeight = "bold"; }
    else if (tone === "warn") { span.style.color = "#f59e0b"; }
    else if (tone === "header") { span.style.color = "#38bdf8"; span.style.fontWeight = "bold"; }
    else { span.style.color = "#e8edf2"; }
    span.textContent = text + "\n";
    elements.retryTerminalOutput.appendChild(span);
    elements.retryTerminalOutput.scrollTop = elements.retryTerminalOutput.scrollHeight;
  }

  termLog("plembfin@server:~$ ./retry-sync --id=" + id, "header");
  termLog("Initializing sync connection...", "info");
  termLog("POST /api/retry-sync HTTP/1.1", "info");

  try {
    const response = await fetch("/api/retry-sync", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      termLog("[ERROR] Sync request failed with status: " + response.status, "error");
      if (body.error) termLog("Reason: " + body.error, "error");
      throw new Error(body.error || `Retry failed with status ${response.status}`);
    }

    termLog("Response received: HTTP 200 OK", "success");
    termLog("Fetching updated watch record from database...", "info");

    const refreshRes = await fetch(`/api/history?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
    const refreshBody = await refreshRes.json().catch(() => ({}));
    if (refreshRes.ok && refreshBody.row) {
      const updatedRow = refreshBody.row;
      if (Array.isArray(state.history)) {
        const idx = state.history.findIndex((x) => x.id === id);
        if (idx !== -1) state.history[idx] = updatedRow;
      }
      if (Array.isArray(state.moviesRaw)) {
        const idx = state.moviesRaw.findIndex((x) => x.id === id);
        if (idx !== -1) state.moviesRaw[idx] = updatedRow;
      }
      if (Array.isArray(state.showsRaw)) {
        for (const show of state.showsRaw) {
          if (Array.isArray(show.episodes)) {
            const idx = show.episodes.findIndex((x) => x.id === id);
            if (idx !== -1) show.episodes[idx] = updatedRow;
          }
        }
      }

      termLog("\n--- Sync Telemetry Dispatch Output ---", "header");
      const telemetry = String(updatedRow.sync_dispatch_telemetry || updatedRow.syncDispatchTelemetry || "");
      if (telemetry) {
        for (const line of telemetry.split(/\r?\n/)) {
          if (line.toLowerCase().includes("status: success") || line.toLowerCase().includes("resolved status to success")) {
            termLog(line, "success");
          } else if (line.toLowerCase().includes("status: error") || line.toLowerCase().includes("status: failed") || line.toLowerCase().includes("error") || line.toLowerCase().includes("fail")) {
            termLog(line, "error");
          } else if (line.toLowerCase().includes("status: pending") || line.toLowerCase().includes("pending")) {
            termLog(line, "warn");
          } else {
            termLog(line, "info");
          }
        }
      } else {
        termLog("No dispatch telemetry recorded.", "warn");
      }

      const targetStatuses = getMediaTargetSyncStatus(updatedRow);
      const errors = targetStatuses.filter((t) => t.status === "error" || t.status === "failed");
      const pendings = targetStatuses.filter((t) => t.status === "pending");

      if (errors.length > 0) {
        termLog("\n⚠️ Sync failure detected for one or more targets!", "error");
        for (const err of errors) {
          termLog(`\n[DIAGNOSTICS & FIX FOR ${err.target.toUpperCase()}]:`, "warn");
          const telLine = telemetry.split("\n").find((l) => l.toLowerCase().includes(err.target) && l.toLowerCase().includes("error"));
          termLog(`Details: ${telLine || "Connection failed"}`, "info");
          const errLower = (telLine || "").toLowerCase();
          if (errLower.includes("unauthorized") || errLower.includes("401") || errLower.includes("token") || errLower.includes("auth")) {
            termLog("👉 FIX: Go to the settings tab for this app (Settings -> Apps) and verify that the API Key or Token is correct, valid, and not expired.", "success");
          } else if (errLower.includes("refused") || errLower.includes("timeout") || errLower.includes("conn") || errLower.includes("reach") || errLower.includes("address")) {
            termLog("👉 FIX: Verify that the Server URL is correct, the target server is currently online, and there are no network rules or firewalls blocking the connection from the machine running Plembfin.", "success");
          } else if (errLower.includes("not found") || errLower.includes("404") || errLower.includes("match")) {
            termLog("👉 FIX: The media item was not found on the target platform. Ensure the TMDB/IMDB/TVDB IDs are correct and that the media is properly scanned/matched in your Plex/Emby/Jellyfin library.", "success");
          } else {
            termLog("👉 FIX: Check the Settings -> Apps configuration for this platform. Try testing the connection to verify credentials and endpoint URLs.", "success");
          }
        }
      } else if (pendings.length > 0) {
        termLog("\n⚠️ One or more sync dispatches are still pending or queued.", "warn");
        termLog("👉 SUGGESTION: The target sync is in progress or propagation is queued. Wait a few moments and retry.", "info");
      } else {
        termLog("\n✨ Sync completed successfully! All configured targets are fully up to date.", "success");
      }

      _cb.clearDerivedUiCaches?.({ resetExplorer: false });
      _cb.renderDashboard?.();
      _cb.renderStats?.();
      await Promise.all([
        _cb.loadSyncJobs?.({ force: true }),
        _cb.loadSyncHistory?.({ force: true }),
      ]).catch(() => null);

      if (state.activeView === "explorer") _cb.renderExplorer?.();
      if (state.activeShowModalKey) _cb.renderImmersiveShowModal?.(state.activeShowModalKey, state.activeShowModalSeason, state.activeShowModalEpisode);

      _cb.setMessage?.("Retry sync completed.", "success");
    } else {
      throw new Error("Could not fetch the updated sync state from server.");
    }
  } catch (error) {
    termLog(`\n[FATAL ERROR] Retry sync process aborted: ${error.message}`, "error");
    button.disabled = false;
    button.textContent = originalText;
    _cb.setMessage?.(`Retry sync failed: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

export async function triggerCronSync() {
  const button = elements.runCronSyncButton;
  const terminal = elements.forceSyncTerminal;
  if (!button) return;

  if (terminal) { terminal.classList.remove("hidden"); terminal.textContent = "Cron Sync started...\n"; }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Syncing...";

  try {
    const response = await fetch("/api/cron-sync", { method: "POST", headers: authHeaders() });
    if (!response.ok) throw new Error(`Cron sync failed with HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let finalResult = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("RESULT: ")) {
          try { finalResult = JSON.parse(trimmed.substring(8)); } catch (e) { console.error("Failed to parse final result JSON", e); }
        } else if (terminal) {
          terminal.textContent += `${trimmed}\n`;
          terminal.scrollTop = terminal.scrollHeight;
        }
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("RESULT: ")) {
        try { finalResult = JSON.parse(trimmed.substring(8)); } catch (e) { console.error("Failed to parse final result JSON", e); }
      } else if (terminal) {
        terminal.textContent += `${trimmed}\n`;
        terminal.scrollTop = terminal.scrollHeight;
      }
    }

    if (finalResult) {
      const detail = `Cron run complete! Sessions: ${finalResult.sessions ?? 0}, completions: ${finalResult.completions ?? 0}, cached: ${finalResult.cached ?? 0}`;
      _cb.showToast?.(detail);
      if (terminal) { terminal.textContent += `\nSUCCESS: ${detail}\n`; terminal.scrollTop = terminal.scrollHeight; }
    } else {
      throw new Error("No final result returned from server");
    }

    await Promise.all([_cb.loadSyncJobs?.({ force: true }), _cb.loadSyncHistory?.({ force: true })]);
  } catch (error) {
    _cb.showToast?.(`Error: ${error.message}`);
    if (terminal) { terminal.textContent += `\nERROR: ${error.message}\n`; terminal.scrollTop = terminal.scrollHeight; }
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

export async function triggerStopSync() {
  const button = elements.stopSyncButton;
  if (!button) return;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Stopping...";
  try {
    const response = await fetch("/api/stop-force-sync", { method: "POST", headers: authHeaders() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Stop sync failed with HTTP ${response.status}`);
    _cb.showToast?.("Stop sync request sent.");
  } catch (error) {
    _cb.showToast?.(`Error stopping sync: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

export async function triggerForceSync() {
  const button = elements.forceSyncButton;
  const stopButton = elements.stopSyncButton;
  const terminal = elements.forceSyncTerminal;
  if (!button) return;

  _cb.showConfirmModal?.(
    "Are you sure you want to run Force Sync?\n\nThis will check all configured media servers (Plex, Emby, Jellyfin) and resolve their watched/unwatched states based on the newest timestamp. It may take some time.",
    async () => {
      if (terminal) { terminal.classList.remove("hidden"); terminal.textContent = "Force Sync starting...\n"; }
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "Syncing...";
      button.classList.add("hidden");
      if (stopButton) stopButton.classList.remove("hidden");

      try {
        const startResponse = await fetch("/api/force-sync", { method: "POST", headers: authHeaders() });
        if (!startResponse.ok) {
          const body = await startResponse.json().catch(() => ({}));
          throw new Error(body.error || `Force sync failed with HTTP ${startResponse.status}`);
        }

        let seenLines = 0;
        let finalResult = null;
        let pollActive = true;

        while (pollActive) {
          await new Promise((r) => setTimeout(r, 2000));
          let statusBody;
          try {
            const statusRes = await fetch("/api/force-sync", { headers: authHeaders(), cache: "no-store" });
            statusBody = await statusRes.json();
          } catch (err) { continue; }

          const log = Array.isArray(statusBody.log) ? statusBody.log : [];
          for (let i = seenLines; i < log.length; i++) {
            const line = log[i];
            if (line && line.startsWith("RESULT: ")) {
              try { finalResult = JSON.parse(line.substring(8)); } catch (_) { }
            } else if (terminal && line) {
              terminal.textContent += `${line}\n`;
              terminal.scrollTop = terminal.scrollHeight;
            }
          }
          seenLines = log.length;
          if (!statusBody.active) { finalResult = finalResult || statusBody.result; pollActive = false; }
        }

        if (finalResult && finalResult.success) {
          const stats = finalResult.stats || {};
          const detail = finalResult.aborted
            ? `Force Sync stopped! Found: ${stats.totalWatchedFoundAcrossServers ?? 0}, added: ${stats.addedToHistory ?? 0}, deleted: ${stats.deletedFromHistory ?? 0}, propagated: ${stats.propagatedUpdates ?? 0}`
            : `Force Sync complete! Targets: ${(finalResult.activeTargets || []).join(", ") || "none"}. Found: ${stats.totalWatchedFoundAcrossServers ?? 0}, added: ${stats.addedToHistory ?? 0}, deleted: ${stats.deletedFromHistory ?? 0}, propagated: ${stats.propagatedUpdates ?? 0}`;
          _cb.showToast?.(detail);
          if (terminal) { terminal.textContent += `\n${finalResult.aborted ? "ABORTED" : "SUCCESS"}: ${detail}\n`; terminal.scrollTop = terminal.scrollHeight; }
        } else if (finalResult) {
          throw new Error(finalResult.error || "Force Sync ended with an unknown error.");
        }

        await Promise.all([_cb.loadSyncJobs?.({ force: true }), _cb.loadSyncHistory?.({ force: true })]);
      } catch (error) {
        _cb.showToast?.(`Error: ${error.message}`);
        if (terminal) { terminal.textContent += `\nERROR: ${error.message}\n`; terminal.scrollTop = terminal.scrollHeight; }
      } finally {
        button.disabled = false;
        button.textContent = originalText;
        button.classList.remove("hidden");
        if (stopButton) stopButton.classList.add("hidden");
      }
    }
  );
}
