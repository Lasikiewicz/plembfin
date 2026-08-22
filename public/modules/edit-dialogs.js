import { state } from "./state.js";
import { escapeHtml, escapeAttribute, slug, sanitizeTitle, showTitleFrom, formatDate, actualWatchHistory, sourceBadgeHtml } from "./utils.js";
import { buildAuthHeaders } from "./auth.js";
import { isWatchedHistoryAction } from "./sync.js";
import { tmdbPoster, tmdbImage, proxiedArtworkUrl } from "./images.js";
import { dateAtMiddayIso, refreshShowAfterManualWatch } from "./watch-action.js?v=20260810";
import { calendarStateFromIso, mountCalendarPicker } from "./calendar-picker.js";

// Callbacks injected by app.js at startup.
let _setMessage = () => {};
let _clearDerivedUiCaches = () => {};
let _renderImmersiveShowModal = async () => {};
let _openShowImmersiveModalByTmdbId = async () => {};
let _openShowImmersiveModalByTvdbId = async () => {};
let _navigateTo = () => {};
let _openConfirmDialog = async () => false;
let _loadHistory = async () => {};
let _renderExplorer = () => {};

export function initEditDialogs(callbacks) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.clearDerivedUiCaches) _clearDerivedUiCaches = callbacks.clearDerivedUiCaches;
  if (callbacks.renderImmersiveShowModal) _renderImmersiveShowModal = callbacks.renderImmersiveShowModal;
  if (callbacks.openShowImmersiveModalByTmdbId) _openShowImmersiveModalByTmdbId = callbacks.openShowImmersiveModalByTmdbId;
  if (callbacks.openShowImmersiveModalByTvdbId) _openShowImmersiveModalByTvdbId = callbacks.openShowImmersiveModalByTvdbId;
  if (callbacks.navigateTo) _navigateTo = callbacks.navigateTo;
  if (callbacks.openConfirmDialog) _openConfirmDialog = callbacks.openConfirmDialog;
  if (callbacks.loadHistory) _loadHistory = callbacks.loadHistory;
  if (callbacks.renderExplorer) _renderExplorer = callbacks.renderExplorer;
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

// ── Core API helper ────────────────────────────────────────────────────────

// `media_key` is optional and identifies the same media across a row being
// replaced. A record can be superseded between the moment a caller reads an id
// and the moment it saves (an unwatch event rewrites the row), and the key
// outlives the id, so the server can still find what the caller meant.
export async function apiUpdateWatch(id, fields, mediaKey = "") {
  const res = await fetch("/api/update-watch", {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...(mediaKey ? { media_key: mediaKey } : {}), ...fields }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function apiUpdateWatchDates(updates = []) {
  const res = await fetch("/api/update-watch-dates", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// Every watch date recorded for the same movie/episode as `id`, oldest first.
async function apiWatchDates(id) {
  try {
    const res = await fetch(`/api/watch-dates?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(body.rows) || !body.rows.length) return null;
    return body.rows;
  } catch {
    return null;
  }
}

async function apiAddWatchDate(anchorId, watchedAtIso) {
  const res = await fetch("/api/add-watch-date", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ id: anchorId, watched_at: watchedAtIso }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function apiDeleteWatchDate(id) {
  const res = await fetch("/api/delete-watch-date", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ id }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function apiDeleteWatchDates(ids) {
  const res = await fetch("/api/delete-watch-dates", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function apiRematchShow(id, showTitle, tvdbId, newShowTitle = "") {
  const res = await fetch("/api/rematch-show", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ id, show_title: showTitle, tvdb_id: tvdbId, new_show_title: newShowTitle }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ── Apply a watched_at update to in-memory state ──────────────────────────

export function applyWatchedAtToLocalWatchRecord(id, watchedAt) {
  if (!id || !watchedAt) return null;
  let updated = null;

  const updateRow = (row) => {
    if (!row || String(row.id) !== String(id)) return;
    row.watched_at = watchedAt;
    updated = row;
  };

  state.history.forEach(updateRow);
  state.historyViewRaw.forEach(updateRow);

  for (const show of state.showsRaw || []) {
    let showUpdated = false;
    for (const episode of show.episodes || []) {
      if (String(episode.id) !== String(id)) continue;
      episode.watched_at = watchedAt;
      updated = episode;
      showUpdated = true;
    }
    if (show.representative_episode && String(show.representative_episode.id) === String(id)) {
      show.representative_episode.watched_at = watchedAt;
      updated = show.representative_episode;
      showUpdated = true;
    }
    if (showUpdated) {
      const dates = (show.episodes || []).map((episode) => episode.watched_at).filter(Boolean).sort();
      if (dates.length) {
        show.earliest_watched_at = dates[0];
        show.latest_watched_at = dates.at(-1);
      }
    }
  }

  for (const episode of state.showModalEpisodes || []) {
    if (!episode.watched || String(episode.watched.id) !== String(id)) continue;
    episode.watched.watched_at = watchedAt;
    updated = episode.watched;
  }

  return updated;
}

export function editDateOptionsFromButton(button, entry = null, resolvedTmdbCacheFn = null) {
  const releaseDateFromRow = button?.closest(".immersive-episode-row")?.querySelector(".immersive-episode-dates time[datetime]")?.getAttribute("datetime");
  if (releaseDateFromRow) return { releaseDate: releaseDateFromRow };

  if (entry?.media_type === "movie" && resolvedTmdbCacheFn) {
    const tmdbData = resolvedTmdbCacheFn("movie", entry.tmdb_id, entry.title);
    if (tmdbData?.release_date) return { releaseDate: tmdbData.release_date };
  }

  return {};
}

// ── Edit date dialog ───────────────────────────────────────────────────────

export function openEditDateDialog(_container, id, currentWatchedAt, onSaved, options = {}) {
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  const releaseDate = String(options.releaseDate || "").slice(0, 10);
  const releaseLabel = releaseDate
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${releaseDate}T12:00:00`))
    : "Release date unavailable";

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="edit-dialog glass-panel edit-dialog--watch-date">
      <h3>Edit Watch Date</h3>
      <p class="edit-dialog-status is-muted">Loading watch dates…</p>
    </div>
  `;
  document.body.appendChild(overlay);

  const rowLabel = (index) => `Watch ${index + 1}`;
  const toIso = (value) => {
    const date = new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  };
  const renderRow = (index, watchedAt, rowId, source) => `
    <div class="watch-date-list-row" data-row-id="${escapeAttribute(rowId || "")}" data-row-new="${rowId ? "" : "1"}">
      <div class="watch-date-row-main">
        <span class="watch-date-row-label">${rowLabel(index)}</span>
        ${source ? sourceBadgeHtml(source) : ""}
        <button type="button" class="watch-date-value-btn" data-watched-iso="${escapeAttribute(toIso(watchedAt))}">
          ${escapeHtml(formatDate(toIso(watchedAt)))}
        </button>
        <button class="watch-date-remove-btn" type="button" title="Remove this watch date" aria-label="Remove this watch date">&times;</button>
      </div>
      <div class="watch-date-calendar-slot"></div>
    </div>
  `;

  (async () => {
    const fetchedRows = await apiWatchDates(id);
    if (!overlay.isConnected) return;
    const rows = fetchedRows && fetchedRows.length ? fetchedRows : [{ id, watched_at: currentWatchedAt }];

    const panel = overlay.querySelector(".edit-dialog");
    panel.innerHTML = `
      <h3>Edit Watch Date</h3>
      <div class="watch-date-list">
        ${rows.map((row, index) => renderRow(index, row.watched_at, row.id, row.source)).join("")}
      </div>
      <button class="button-ghost watch-date-add-btn" type="button">+ Add another watch date</button>
      <div class="watch-date-section-label">Quick choices <span class="muted-copy">(applies to the last row)</span></div>
      <div class="watch-date-options">
        <button class="watch-date-pick edit-date-choice" type="button" data-edit-date-choice="release"${releaseDate ? "" : " disabled"}>
          <span class="watch-date-pick-title">On release date</span>
          <span class="watch-date-pick-sub">${escapeHtml(releaseLabel)}</span>
        </button>
        <button class="watch-date-pick edit-date-choice" type="button" data-edit-date-choice="now">
          <span class="watch-date-pick-title">Now</span>
          <span class="watch-date-pick-sub">Today, ${escapeHtml(new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date()))}</span>
        </button>
      </div>
      <div class="edit-dialog-actions">
        <button class="button-primary edit-dialog-save" type="button">Save</button>
        <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
      </div>
      <p class="edit-dialog-status"></p>
    `;

    const listEl = panel.querySelector(".watch-date-list");
    const lastValueBtn = () => {
      const buttons = listEl.querySelectorAll(".watch-date-value-btn");
      return buttons[buttons.length - 1] || null;
    };
    const setRowValue = (rowEl, iso) => {
      const btn = rowEl.querySelector(".watch-date-value-btn");
      if (!btn) return;
      btn.dataset.watchedIso = iso;
      btn.textContent = formatDate(iso);
    };
    const closeAnyOpenCalendar = () => {
      listEl.querySelectorAll(".watch-date-calendar-slot").forEach((slot) => { slot.innerHTML = ""; });
    };
    const updateRemoveButtonsState = () => {
      const rowEls = [...listEl.querySelectorAll(".watch-date-list-row")];
      const onlyOne = rowEls.length <= 1;
      rowEls.forEach((rowEl) => {
        const btn = rowEl.querySelector(".watch-date-remove-btn");
        if (btn) btn.disabled = onlyOne;
        if (btn) btn.title = onlyOne ? "Use “Mark unwatched” to remove the only watch date" : "Remove this watch date";
      });
    };
    updateRemoveButtonsState();

    panel.querySelector(".watch-date-add-btn").addEventListener("click", () => {
      closeAnyOpenCalendar();
      const index = listEl.children.length;
      const rowEl = document.createElement("div");
      rowEl.innerHTML = renderRow(index, new Date().toISOString(), "").trim();
      listEl.appendChild(rowEl.firstElementChild);
      updateRemoveButtonsState();
    });

    listEl.addEventListener("click", async (event) => {
      const valueBtn = event.target.closest(".watch-date-value-btn");
      if (valueBtn) {
        const rowEl = valueBtn.closest(".watch-date-list-row");
        const slot = rowEl.querySelector(".watch-date-calendar-slot");
        const alreadyOpen = slot.childElementCount > 0;
        closeAnyOpenCalendar();
        if (alreadyOpen) return;
        const pickerState = calendarStateFromIso(valueBtn.dataset.watchedIso);
        mountCalendarPicker(slot, pickerState, {
          onConfirm: (selectedDate) => {
            setRowValue(rowEl, selectedDate.toISOString());
            slot.innerHTML = "";
          },
          onCancel: () => { slot.innerHTML = ""; },
        });
        return;
      }

      const removeBtn = event.target.closest(".watch-date-remove-btn");
      if (!removeBtn || removeBtn.disabled) return;
      const rowEl = removeBtn.closest(".watch-date-list-row");
      const rowId = rowEl.dataset.rowId;
      const isNew = rowEl.dataset.rowNew === "1";
      const status = panel.querySelector(".edit-dialog-status");

      if (isNew) {
        rowEl.remove();
        updateRemoveButtonsState();
        return;
      }

      const confirmed = await _openConfirmDialog({
        title: "Remove watch date",
        body: "Permanently remove this watch date? This cannot be undone.",
        confirmLabel: "Remove watch date",
        danger: true,
      });
      if (!confirmed) return;

      const rowValueBtn = rowEl.querySelector(".watch-date-value-btn");
      const originalValueText = rowValueBtn?.textContent || "";
      removeBtn.disabled = true;
      if (rowValueBtn) {
        rowValueBtn.disabled = true;
        rowValueBtn.textContent = "Removing…";
      }
      try {
        await apiDeleteWatchDate(rowId);
        rowEl.remove();
        updateRemoveButtonsState();
        const remainingDates = [...listEl.querySelectorAll(".watch-date-value-btn")]
          .map((btn) => btn.dataset.watchedIso)
          .filter(Boolean)
          .sort();
        if (remainingDates.length) await onSaved?.({ watched_at: remainingDates.at(-1) });
        // The dashboard's "N actual watches" count and the explorer's rewatch
        // summaries are read from in-memory snapshots (state.history, the
        // cached /api/movies rows) that a deleted row's own watched_at patch
        // never updates. Force a refetch so those counts drop immediately
        // instead of only after the next unrelated reload.
        _clearDerivedUiCaches({ resetExplorer: true });
        await _loadHistory({ force: true }).catch(() => null);
      } catch (err) {
        if (status) status.textContent = `Error: ${err.message}`;
        removeBtn.disabled = false;
        if (rowValueBtn) {
          rowValueBtn.disabled = false;
          rowValueBtn.textContent = originalValueText;
        }
      }
    });

    panel.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());
    panel.querySelectorAll("[data-edit-date-choice]").forEach((button) => {
      button.addEventListener("click", () => {
        const btn = lastValueBtn();
        if (!btn) return;
        const rowEl = btn.closest(".watch-date-list-row");
        closeAnyOpenCalendar();
        const choice = button.dataset.editDateChoice;
        if (choice === "release" && releaseDate) setRowValue(rowEl, dateAtMiddayIso(releaseDate));
        if (choice === "now") setRowValue(rowEl, new Date().toISOString());
      });
    });

    panel.querySelector(".edit-dialog-save").addEventListener("click", async () => {
      const status = panel.querySelector(".edit-dialog-status");
      const rowEls = [...listEl.querySelectorAll(".watch-date-list-row")];
      const entries = rowEls.map((rowEl) => ({
        rowId: rowEl.dataset.rowId || "",
        isNew: rowEl.dataset.rowNew === "1",
        iso: rowEl.querySelector(".watch-date-value-btn")?.dataset.watchedIso || "",
      }));
      if (entries.some((entry) => !entry.iso)) { status.textContent = "Please pick a date for every row."; return; }

      status.textContent = "Saving…";
      try {
        let latestIso = "";
        for (const entry of entries) {
          if (entry.isNew) {
            await apiAddWatchDate(id, entry.iso);
          } else if (entry.rowId) {
            await apiUpdateWatch(entry.rowId, { watched_at: entry.iso });
          }
          if (!latestIso || entry.iso > latestIso) latestIso = entry.iso;
        }
        overlay.remove();
        await onSaved?.({ watched_at: latestIso });
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
    });
  })();
}

// ── Full-show watched rows helper ──────────────────────────────────────────

function fullShowWatchedRows(showTitle = "", fallbackRows = []) {
  const showKey = slug(showTitle);
  const show = state.showsRaw.find((item) => slug(item.title) === showKey);
  const rows = [];
  const seen = new Set();

  const addRow = (row) => {
    if (!row?.id || !isWatchedHistoryAction(row) || seen.has(row.id)) return;
    seen.add(row.id);
    rows.push(row);
  };

  for (const episode of show?.episodes || []) addRow(episode);
  for (const episode of fallbackRows || []) addRow(episode);
  for (const row of state.history || []) {
    if (row.media_type !== "episode") continue;
    const rowShowTitle = row.show_title || showTitleFrom(row.title);
    if (slug(rowShowTitle) === showKey) addRow(row);
  }

  return rows;
}

// ── Edit show date dialog ──────────────────────────────────────────────────

export function openEditShowDateDialog(showTitle, watchedRows = []) {
  const rows = fullShowWatchedRows(showTitle, watchedRows);
  if (!rows.length) {
    _setMessage("There are no watched episodes to update.", "error");
    return;
  }

  // One row per season rather than one date for the whole show: each season
  // defaults to its own latest watched date and can be changed independently.
  const seasonMap = new Map();
  for (const row of rows) {
    const seasonNum = row.season == null ? 0 : Number(row.season);
    if (!seasonMap.has(seasonNum)) seasonMap.set(seasonNum, []);
    seasonMap.get(seasonNum).push(row);
  }
  const seasons = [...seasonMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seasonNum, seasonRows]) => ({
      seasonNum,
      rows: seasonRows,
      initialIso: seasonRows.reduce((value, row) => String(row.watched_at || "") > value ? row.watched_at : value, seasonRows[0].watched_at || ""),
    }));

  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  const seasonRowLabel = (seasonNum) => (seasonNum === 0 ? "Specials" : `Season ${seasonNum}`);
  const toIso = (value) => {
    const date = new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  };
  const renderSeasonRow = (season) => `
    <div class="watch-date-list-row" data-season-number="${season.seasonNum}">
      <div class="watch-date-row-main">
        <span class="watch-date-row-label">${escapeHtml(seasonRowLabel(season.seasonNum))}</span>
        <button type="button" class="watch-date-value-btn" data-watched-iso="${escapeAttribute(toIso(season.initialIso))}">
          ${escapeHtml(formatDate(toIso(season.initialIso)))}
        </button>
        <span class="watch-date-episode-air">${season.rows.length} episode${season.rows.length === 1 ? "" : "s"}</span>
      </div>
      <div class="watch-date-calendar-slot"></div>
    </div>
  `;

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="edit-dialog glass-panel edit-dialog--watch-date">
      <h3>Edit Show Watch Date</h3>
      <p class="muted-copy">Updates ${rows.length} watched episode date${rows.length === 1 ? "" : "s"} across ${seasons.length} season${seasons.length === 1 ? "" : "s"} for ${escapeHtml(showTitle || "this show")}. Click a season's date to change just that season.</p>
      <div class="watch-date-list">
        ${seasons.map(renderSeasonRow).join("")}
      </div>
      <div class="edit-dialog-actions">
        <button class="button-primary edit-dialog-save" type="button">Save</button>
        <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
      </div>
      <p class="edit-dialog-status"></p>
    </div>
  `;

  const listEl = overlay.querySelector(".watch-date-list");
  const closeAnyOpenCalendar = () => {
    listEl.querySelectorAll(".watch-date-calendar-slot").forEach((slot) => { slot.innerHTML = ""; });
  };
  const setRowValue = (rowEl, iso) => {
    const btn = rowEl.querySelector(".watch-date-value-btn");
    if (!btn) return;
    btn.dataset.watchedIso = iso;
    btn.textContent = formatDate(iso);
  };
  listEl.addEventListener("click", (event) => {
    const valueBtn = event.target.closest(".watch-date-value-btn");
    if (!valueBtn) return;
    const rowEl = valueBtn.closest(".watch-date-list-row");
    const slot = rowEl.querySelector(".watch-date-calendar-slot");
    const alreadyOpen = slot.childElementCount > 0;
    closeAnyOpenCalendar();
    if (alreadyOpen) return;
    const pickerState = calendarStateFromIso(valueBtn.dataset.watchedIso);
    mountCalendarPicker(slot, pickerState, {
      onConfirm: (selectedDate) => {
        setRowValue(rowEl, selectedDate.toISOString());
        slot.innerHTML = "";
      },
      onCancel: () => { slot.innerHTML = ""; },
    });
  });

  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector(".edit-dialog-save").addEventListener("click", async () => {
    const status = overlay.querySelector(".edit-dialog-status");
    const saveButton = overlay.querySelector(".edit-dialog-save");

    const watchedAtBySeason = new Map();
    listEl.querySelectorAll(".watch-date-list-row").forEach((rowEl) => {
      const seasonNum = Number(rowEl.dataset.seasonNumber);
      const iso = rowEl.querySelector(".watch-date-value-btn")?.dataset.watchedIso || new Date().toISOString();
      watchedAtBySeason.set(seasonNum, iso);
    });
    const updates = seasons.flatMap((season) => {
      const watched_at = watchedAtBySeason.get(season.seasonNum);
      return season.rows.map((row) => ({ id: row.id, media_key: row.media_key, watched_at }));
    });

    saveButton.disabled = true;
    status.textContent = `Saving 0/${updates.length}...`;
    try {
      await apiUpdateWatchDates(updates);
      status.textContent = `Saving ${updates.length}/${updates.length}...`;

      const updatedAtById = new Map(updates.map((update) => [String(update.id || update.media_key), update.watched_at]));
      for (const row of rows) row.watched_at = updatedAtById.get(String(row.id || row.media_key)) || row.watched_at;
      const showKey = slug(showTitle);
      const show = state.showsRaw.find((item) => slug(item.title) === showKey);
      if (show?.episodes) {
        const ids = new Set(rows.map((row) => String(row.id || "")).filter(Boolean));
        for (const episode of show.episodes) {
          if (ids.has(String(episode.id || ""))) {
            const updatedAt = updatedAtById.get(String(episode.id));
            if (updatedAt) episode.watched_at = updatedAt;
          }
        }
        show.latest_watched_at = show.episodes.reduce((value, episode) => episode.watched_at > value ? episode.watched_at : value, "");
        show.earliest_watched_at = show.episodes.reduce((value, episode) => !value || episode.watched_at < value ? episode.watched_at : value, "");
      }

      _clearDerivedUiCaches({ resetExplorer: false });
      await Promise.all([
        _loadHistory({ force: true }).catch(() => null),
        showTitle ? refreshShowAfterManualWatch(showTitle).catch(() => null) : Promise.resolve(),
      ]);
      _renderExplorer();
      if (state.activeShowModalKey) {
        _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
      } else if (state.activeShowTmdbId) {
        await _openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
      } else if (state.activeShowTvdbId) {
        await _openShowImmersiveModalByTvdbId(state.activeShowTvdbId);
      }
      overlay.remove();
      _setMessage(`Updated ${updates.length} watched episode date${updates.length === 1 ? "" : "s"} across ${seasons.length} season${seasons.length === 1 ? "" : "s"}.`, "success");
    } catch (error) {
      saveButton.disabled = false;
      _setMessage(`Show watch date update failed: ${error.message}`, "error");
      status.textContent = `Error: ${error.message}`;
    }
  });

  document.body.appendChild(overlay);
}

// ── Edit season date dialog ────────────────────────────────────────────────

export function openEditSeasonDateDialog(showTitle, seasonNum, watchedEpisodes = []) {
  const rows = [...new Map((watchedEpisodes || [])
    .filter((row) => row?.id || row?.media_key)
    .map((row) => [String(row.id || row.media_key), row])).values()];
  if (!rows.length) {
    _setMessage("There are no watched episodes in this season to update.", "error");
    return;
  }

  // Duplicate watches (rewatch imports, sync echoes, etc.): for each episode,
  // every recorded watch after the earliest is removable. Entries with no id
  // (older cached rows with only a bare watched_at) can't be targeted by the
  // bulk-delete endpoint, so they're left out of the plan entirely. A play
  // history entry whose own row was later explicitly unwatched is excluded
  // entirely (not just protected from removal) - it's not a countable watch
  // to consolidate, and treating it as one can make it sort ahead of a real
  // watched entry and get "kept" while the actual watch is deleted as the
  // supposed duplicate.
  const dedupePlan = rows.map((row) => {
    const history = [...actualWatchHistory(row)]
      .filter((entry) => entry.syncAction !== "unwatched" && entry.syncAction !== "unplayed")
      .sort((a, b) => String(a.watched_at || "").localeCompare(String(b.watched_at || "")));
    const removableIds = history.slice(1).map((entry) => entry.id).filter(Boolean);
    return { row, removableIds };
  }).filter((plan) => plan.removableIds.length > 0);
  const removableIds = dedupePlan.flatMap((plan) => plan.removableIds);
  const totalRemovable = removableIds.length;

  const releaseDateFor = (row) => {
    const value = String(row?.release_date || row?.air_date || row?.airDate || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
  };
  const releaseRows = rows.map((row) => ({ row, releaseDate: releaseDateFor(row) }));
  const missingReleaseDates = releaseRows.filter(({ releaseDate }) => !releaseDate).length;
  const latest = rows.reduce((value, row) => String(row.watched_at || "") > value ? String(row.watched_at || "") : value, "");
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="edit-dialog glass-panel edit-dialog--watch-date">
      <h3>Edit Season Watch Date</h3>
      <p class="muted-copy">Updates ${rows.length} existing watched episode record${rows.length === 1 ? "" : "s"} for Season ${seasonNum} of ${escapeHtml(showTitle || "this show")}. This never adds another watch.</p>
      ${totalRemovable ? `
      <div class="watch-date-section-label">Duplicate watches</div>
      <div class="season-dedupe-panel">
        <p class="muted-copy">${totalRemovable} extra watch${totalRemovable === 1 ? "" : "es"} across ${dedupePlan.length} episode${dedupePlan.length === 1 ? "" : "s"} in this season. Keep only the oldest date for each episode and remove the rest. This cannot be undone.</p>
        <button class="button-danger season-dedupe-btn" type="button">Remove ${totalRemovable} duplicate watch${totalRemovable === 1 ? "" : "es"}</button>
      </div>
      ` : ""}
      <div class="watch-date-section-label">Quick choices</div>
      <div class="watch-date-options season-watch-date-options">
        <button class="watch-date-pick season-date-choice" type="button" data-season-date-choice="release" aria-pressed="false"${missingReleaseDates ? " disabled" : ""}>
          <span class="watch-date-pick-title">Use episode release dates</span>
          <span class="watch-date-pick-sub">${missingReleaseDates ? `${missingReleaseDates} episode${missingReleaseDates === 1 ? "" : "s"} has no release date` : "Each episode uses its own release day"}</span>
        </button>
        <button class="watch-date-pick season-date-choice is-selected" type="button" data-season-date-choice="shared" aria-pressed="true">
          <span class="watch-date-pick-title">Use one date for all</span>
          <span class="watch-date-pick-sub">Use the date and time selected below</span>
        </button>
      </div>
      <div class="watch-date-calendar-slot"></div>
      <div class="edit-dialog-actions">
        <button class="button-primary edit-dialog-save" type="button">Save</button>
        <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
      </div>
      <p class="edit-dialog-status"></p>
    </div>
  `;

  const pickerState = calendarStateFromIso(latest);
  const calendarSlot = overlay.querySelector(".watch-date-calendar-slot");
  let releaseChoiceSelected = false;
  const setChoice = (choice) => {
    releaseChoiceSelected = choice === "release";
    overlay.querySelectorAll("[data-season-date-choice]").forEach((button) => {
      const selected = button.dataset.seasonDateChoice === choice;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  };
  overlay.querySelectorAll("[data-season-date-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!button.disabled) setChoice(button.dataset.seasonDateChoice);
    });
  });
  calendarSlot.addEventListener("click", (event) => {
    if (event.target.closest("[data-wd-day], [data-wd-nav], [data-wd-month-toggle]")) setChoice("shared");
  });
  calendarSlot.addEventListener("change", (event) => {
    if (event.target.closest("[data-wd-hour], [data-wd-minute], [data-wd-month-select], [data-wd-year-select]")) setChoice("shared");
  });
  mountCalendarPicker(calendarSlot, pickerState, { showConfirm: false });

  // Shared post-write refresh for both Save and the duplicate-watch cleanup below.
  const refreshAfterSeasonChange = async () => {
    _clearDerivedUiCaches({ resetExplorer: false });
    await Promise.all([
      _loadHistory({ force: true }).catch(() => null),
      showTitle ? refreshShowAfterManualWatch(showTitle).catch(() => null) : Promise.resolve(),
    ]);
    _renderExplorer();
    if (state.activeShowModalKey) {
      _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
    } else if (state.activeShowTmdbId) {
      await _openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
    } else if (state.activeShowTvdbId) {
      await _openShowImmersiveModalByTvdbId(state.activeShowTvdbId);
    }
  };

  const dedupeBtn = overlay.querySelector(".season-dedupe-btn");
  dedupeBtn?.addEventListener("click", async () => {
    const status = overlay.querySelector(".edit-dialog-status");
    const confirmed = await _openConfirmDialog({
      title: "Remove duplicate watches",
      body: `Permanently remove ${totalRemovable} duplicate watch${totalRemovable === 1 ? "" : "es"} across ${dedupePlan.length} episode${dedupePlan.length === 1 ? "" : "s"} in Season ${seasonNum}, keeping only the oldest date for each. This cannot be undone.`,
      confirmLabel: "Remove duplicates",
      danger: true,
    });
    if (!confirmed) return;

    dedupeBtn.disabled = true;
    status.textContent = `Removing 0/${totalRemovable}...`;
    try {
      await apiDeleteWatchDates(removableIds);
      status.textContent = `Removed ${totalRemovable}/${totalRemovable}.`;
      await refreshAfterSeasonChange();
      overlay.remove();
      _setMessage(`Removed ${totalRemovable} duplicate watch${totalRemovable === 1 ? "" : "es"} from Season ${seasonNum}.`, "success");
    } catch (error) {
      dedupeBtn.disabled = false;
      _setMessage(`Removing duplicate watches failed: ${error.message}`, "error");
      status.textContent = `Error: ${error.message}`;
    }
  });

  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector(".edit-dialog-save").addEventListener("click", async () => {
    const status = overlay.querySelector(".edit-dialog-status");
    const saveButton = overlay.querySelector(".edit-dialog-save");

    if (releaseChoiceSelected && missingReleaseDates) {
      status.textContent = "Release dates are missing for one or more watched episodes.";
      return;
    }

    const updates = releaseChoiceSelected
      ? releaseRows.map(({ row, releaseDate }) => ({ id: row.id, media_key: row.media_key, watched_at: dateAtMiddayIso(releaseDate) }))
      : rows.map((row) => ({ id: row.id, media_key: row.media_key, watched_at: pickerState.selected.toISOString() }));
    saveButton.disabled = true;
    status.textContent = `Saving 0/${rows.length}...`;
    try {
      await apiUpdateWatchDates(updates);
      status.textContent = `Saving ${rows.length}/${rows.length}...`;

      const updatedAtById = new Map(updates.map((update) => [String(update.id || update.media_key), update.watched_at]));
      for (const row of rows) row.watched_at = updatedAtById.get(String(row.id || row.media_key)) || row.watched_at;
      const showKey = slug(showTitle);
      const show = state.showsRaw.find((item) => slug(item.title) === showKey);
      if (show?.episodes) {
        const ids = new Set(rows.map((row) => String(row.id || "")).filter(Boolean));
        for (const episode of show.episodes) {
          if (ids.has(String(episode.id || ""))) {
            const updatedAt = updatedAtById.get(String(episode.id));
            if (updatedAt) episode.watched_at = updatedAt;
          }
        }
        show.latest_watched_at = show.episodes.reduce((value, episode) => episode.watched_at > value ? episode.watched_at : value, "");
        show.earliest_watched_at = show.episodes.reduce((value, episode) => !value || episode.watched_at < value ? episode.watched_at : value, "");
      }

      await refreshAfterSeasonChange();
      overlay.remove();
      _setMessage(
        releaseChoiceSelected
          ? `Updated ${rows.length} Season ${seasonNum} watch date${rows.length === 1 ? "" : "s"} using each episode's release day.`
          : `Updated ${rows.length} existing episode date${rows.length === 1 ? "" : "s"} for Season ${seasonNum}.`,
        "success",
      );
    } catch (error) {
      saveButton.disabled = false;
      _setMessage(`Season watch date update failed: ${error.message}`, "error");
      status.textContent = `Error: ${error.message}`;
    }
  });

  document.body.appendChild(overlay);
}

// ── Edit image dialog ──────────────────────────────────────────────────────

function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("?")[0];
    if (host === "youtube.com" || host === "m.youtube.com") return u.searchParams.get("v") || null;
  } catch { /* invalid URL */ }
  return null;
}

export function openEditImageDialog(_container, id, currentPosterUrl, tmdbData, onSaved, options = {}) {
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  let activeTab = "poster";
  const mediaTitle = tmdbData?.title || tmdbData?.name || options.title || "";
  // Identifiers used to resolve artwork. Overridable via the manual match search
  // box so images still load when the automatic match failed.
  const match = {
    tmdbId: tmdbData?.id ? String(tmdbData.id) : "",
    tvdbId: String(tmdbData?.tvdb_id || tmdbData?.external_ids?.tvdb_id || "").trim(),
    title: mediaTitle,
  };
  const imageSections = {
    poster: { label: "Poster", searchLabel: "posters", saveLabel: "Save poster", field: "poster_url" },
    logo: { label: "Logo", searchLabel: "logo art", saveLabel: "Save logo", field: "logo_url" },
    background: { label: "Background", searchLabel: "background art", saveLabel: "Save background", field: "backdrop_url" },
    youtube: { label: "YouTube Show", searchLabel: "", saveLabel: "Save YouTube show", field: "youtube_url" },
  };

  const searchLinks = (kind) => {
    const query = encodeURIComponent(`${match.title || "media"} ${imageSections[kind]?.searchLabel || "artwork"}`);
    return `
      <div class="edit-image-search-links">
        <a href="https://www.google.com/search?tbm=isch&q=${query}" target="_blank" rel="noopener noreferrer">Google</a>
        <a href="https://www.bing.com/images/search?q=${query}" target="_blank" rel="noopener noreferrer">Bing</a>
        <a href="https://duckduckgo.com/?iax=images&ia=images&q=${query}" target="_blank" rel="noopener noreferrer">DuckDuckGo</a>
      </div>
    `;
  };

  const resolvedMediaType = () => {
    if (tmdbData?.media_type === "movie" || tmdbData?.mediaType === "movie") return "movie";
    if (tmdbData?.media_type === "tv" || tmdbData?.mediaType === "tv") return "tv";
    return tmdbData?.title !== undefined && tmdbData?.name === undefined ? "movie" : "tv";
  };

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="edit-dialog edit-dialog--wide edit-image-dialog glass-panel">
      <div class="edit-image-tabs edit-image-sidebar">
        <button class="edit-image-tab active" type="button" data-tab="poster">Poster</button>
        <button class="edit-image-tab" type="button" data-tab="logo">Logo</button>
        <button class="edit-image-tab" type="button" data-tab="background">Background</button>
        <button class="edit-image-tab" type="button" data-tab="youtube">YouTube Show</button>
      </div>
      <div class="edit-image-main">
        <div class="edit-image-header">
          <div>
            <h3 class="edit-image-title">Poster</h3>
            <p class="muted-copy edit-image-subtitle">Choose TMDB or TVDB artwork, use fanart.tv fallback, or upload your own image.</p>
          </div>
          <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
        </div>
        <div class="edit-image-match-row">
          <input type="search" class="field edit-image-match-input" placeholder="Search for the correct title…" value="${escapeAttribute(mediaTitle)}" />
          <button class="button-ghost edit-image-match-btn" type="button">Search</button>
        </div>
        <div class="fix-match-results edit-image-match-results" style="display:none;"></div>
        <p class="edit-dialog-status" style="margin:0;"></p>
        <div class="edit-image-yt-row" style="display:none;">
          <label class="field-label" style="margin-top: 0.75rem;">
            YouTube URL <span class="muted-copy" style="font-weight:normal;">(paste to fetch thumbnails)</span>
            <div style="display:flex;gap:0.5rem;">
              <input type="url" class="field yt-url-input" placeholder="https://www.youtube.com/watch?v=..." style="flex:1;" />
              <button class="button-ghost yt-fetch-btn" type="button">Fetch</button>
            </div>
          </label>
        </div>
        <div class="edit-image-grid poster-search-grid"></div>
        <div class="edit-image-tools">
          <button class="button-ghost edit-image-custom-toggle" type="button">Custom Image</button>
          <div class="edit-image-custom-panel" hidden>
            <div class="edit-image-links-slot">${searchLinks("poster")}</div>
            <label class="button-primary edit-image-upload-label">
              Upload Image
              <input class="edit-image-file-input" type="file" accept="image/*" />
            </label>
          </div>
        </div>
        <input type="hidden" class="edit-image-input" value="" />
        <div class="edit-dialog-actions">
          <button class="button-primary edit-dialog-save" type="button">Save poster</button>
        </div>
      </div>
    </div>
  `;

  const gridEl = overlay.querySelector(".poster-search-grid");
  const status = overlay.querySelector(".edit-dialog-status");
  const urlInput = overlay.querySelector(".edit-image-input");
  const ytRow = overlay.querySelector(".edit-image-yt-row");
  const fileInput = overlay.querySelector(".edit-image-file-input");
  const customToggle = overlay.querySelector(".edit-image-custom-toggle");
  const customPanel = overlay.querySelector(".edit-image-custom-panel");
  const ytInput = overlay.querySelector(".yt-url-input");
  const ytFetchBtn = overlay.querySelector(".yt-fetch-btn");
  const saveBtn = overlay.querySelector(".edit-dialog-save");
  const titleEl = overlay.querySelector(".edit-image-title");
  const subtitleEl = overlay.querySelector(".edit-image-subtitle");
  const toolsEl = overlay.querySelector(".edit-image-tools");
  const linksSlot = overlay.querySelector(".edit-image-links-slot");
  const matchRow = overlay.querySelector(".edit-image-match-row");
  const matchInput = overlay.querySelector(".edit-image-match-input");
  const matchBtn = overlay.querySelector(".edit-image-match-btn");
  const matchResults = overlay.querySelector(".edit-image-match-results");

  const setDialogStatus = (message = "", tone = "error") => {
    status.textContent = message;
    status.classList.toggle("is-success", tone === "success");
    status.classList.toggle("is-muted", tone === "muted");
  };

  customToggle.addEventListener("click", () => {
    customPanel.hidden = !customPanel.hidden;
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { status.textContent = "Please choose an image file."; return; }
    if (file.size > 10 * 1024 * 1024) { status.textContent = "Please choose an image under 10 MB."; return; }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      urlInput.value = url;
      customPanel.hidden = true;
      renderGrid([{ url, source: "Upload" }], activeTab === "logo", true, activeTab === "background");
      status.textContent = "";
    };
    reader.onerror = () => { status.textContent = "Could not read that image file."; };
    reader.readAsDataURL(file);
  });

  const renderGrid = (items, isLogo = false, selectFirst = true, isBackdrop = false) => {
    gridEl.classList.toggle("edit-image-grid--logo", isLogo);
    gridEl.classList.toggle("edit-image-grid--backdrop", isBackdrop);
    gridEl.innerHTML = items.map((item, i) => {
      const url = typeof item === "string" ? item : item.url;
      const lang = typeof item === "object" && item.lang ? item.lang : null;
      const source = typeof item === "object" && item.source ? item.source : null;
      const hasBadges = lang || source;
      // The tile previews through the caching proxy when the source host is one
      // the browser may not reach; data-url keeps the original so the saved
      // record still points at the upstream image.
      const previewUrl = proxiedArtworkUrl(url, isLogo ? "logo" : isBackdrop ? "backdrop" : "poster");
      // Artwork already known to be unfetchable renders no tile at all, which is
      // where a failed one would end up anyway via `hide-closest-btn`.
      if (!previewUrl) return "";
      return `
        <button class="edit-image-option${isLogo ? " edit-image-option--logo" : ""}${isBackdrop ? " edit-image-option--backdrop" : ""}" type="button" data-url="${escapeAttribute(url)}">
          <img src="${escapeAttribute(previewUrl)}" alt="${isLogo ? "Logo" : isBackdrop ? "Background" : "Poster"} ${i + 1}" loading="lazy" data-err="hide-closest-btn" />
          ${hasBadges ? `<span class="edit-image-badge-row">${lang ? `<span class="edit-image-logo-lang">${escapeAttribute(lang.toUpperCase())}</span>` : ""}${source ? `<span class="edit-image-source-badge edit-image-source-badge--${escapeAttribute(source.toLowerCase())}">${escapeAttribute(source)}</span>` : ""}</span>` : ""}
        </button>
      `;
    }).join("");
    gridEl.querySelectorAll(".edit-image-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        urlInput.value = btn.dataset.url;
        gridEl.querySelectorAll(".edit-image-option").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
      });
    });
    // Preselect the first tile that actually rendered, so a skipped unfetchable
    // image is never the value waiting in the save box.
    const firstTile = gridEl.querySelector(".edit-image-option");
    if (selectFirst && firstTile?.dataset.url) {
      urlInput.value = firstTile.dataset.url;
      firstTile.classList.add("selected");
    }
  };

  const fetchYouTubeThumbnails = async () => {
    const videoId = extractYouTubeId(ytInput.value.trim());
    if (!videoId) { status.textContent = "Could not find a YouTube video ID in that URL."; return; }
    status.textContent = "Fetching YouTube thumbnails…";
    const candidates = [
      `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
      `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    ];
    const valid = await Promise.all(candidates.map((url) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth > 120 ? url : null);
      img.onerror = () => resolve(null);
      img.src = url;
    })));
    const found = valid.filter(Boolean);
    if (!found.length) { status.textContent = "No thumbnails found for that video."; return; }
    status.textContent = "";
    renderGrid(found, false);
  };

  ytFetchBtn.addEventListener("click", fetchYouTubeThumbnails);
  ytInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fetchYouTubeThumbnails(); } });

  let tmdbImages = null;
  const getTmdbImages = async () => {
    if (tmdbImages) return tmdbImages;
    const tmdbId = match.tmdbId;
    const mediaType = resolvedMediaType();
    const canResolve = tmdbId || (mediaType === "tv" && (match.tvdbId || match.title));
    if (state.savedConfig?.tmdb?.configured && canResolve) {
      try {
        const params = new URLSearchParams({ mediaType });
        if (tmdbId) params.set("tmdbId", String(tmdbId));
        if (match.title) params.set("title", match.title);
        if (mediaType === "tv" && match.tvdbId) params.set("tvdbId", match.tvdbId);
        const res = await fetch(`/api/tmdb-images?${params.toString()}`, { headers: authHeaders() });
        tmdbImages = await res.json();
      } catch { tmdbImages = {}; }
    } else {
      tmdbImages = {};
    }
    return tmdbImages;
  };

  let tvdbImages = null;
  const getTvdbImages = async () => {
    if (tvdbImages) return tvdbImages;
    const mediaType = resolvedMediaType();
    if (mediaType !== "tv") { tvdbImages = {}; return tvdbImages; }
    try {
      const params = new URLSearchParams();
      if (match.tvdbId) params.set("tvdbId", match.tvdbId);
      if (match.title) params.set("title", match.title);
      if (match.tmdbId) params.set("tmdbId", match.tmdbId);
      const res = await fetch(`/api/tvdb-images?${params.toString()}`, { headers: authHeaders() });
      tvdbImages = await res.json();
    } catch { tvdbImages = {}; }
    return tvdbImages;
  };

  let fanartImages = null;
  const getFanartImages = async () => {
    if (fanartImages) return fanartImages;
    const tmdbId = match.tmdbId;
    const mediaType = resolvedMediaType();
    if (tmdbId) {
      try {
        const params = new URLSearchParams({ mediaType, tmdbId: String(tmdbId) });
        const res = await fetch(`/api/fanart-images?${params.toString()}`, { headers: authHeaders() });
        fanartImages = await res.json();
      } catch { fanartImages = {}; }
    } else {
      fanartImages = {};
    }
    return fanartImages;
  };

  const sourceItems = (sourceData, kind, seen, sourceLabel) => {
    const key = kind === "background" ? "backdrops" : `${kind}s`;
    return (sourceData?.[key] || []).reduce((items, item) => {
      if (item.url && !seen.has(item.url)) {
        seen.add(item.url);
        items.push({ url: item.url, lang: item.lang || "", source: sourceLabel });
      }
      return items;
    }, []);
  };
  const fanartItems = (fanartData, kind, seen) => sourceItems(fanartData, kind, seen, "Fanart");
  const tvdbItems = (data, kind, seen) => sourceItems(data, kind, seen, "TVDB");

  const loadPosters = async () => {
    status.textContent = "Loading posters…";
    urlInput.value = "";
    const tmdbData_ = await getTmdbImages();
    const seen = new Set();
    const items = [];
    for (const p of (tmdbData_.posters || []).slice(0, 20)) {
      const url = tmdbPoster(p.file_path);
      if (!seen.has(url)) { seen.add(url); items.push({ url, source: "TMDB" }); }
    }
    status.textContent = "Checking TVDB and fanart.tv...";
    const tvdbPosterItems = tvdbItems(await getTvdbImages(), "poster", seen);
    items.push(...tvdbPosterItems);
    const fanartPosterItems = fanartItems(await getFanartImages(), "poster", seen);
    items.push(...fanartPosterItems);
    if (items.length) { status.textContent = ""; renderGrid(items, false); return; }
    const fallback = [];
    if (tmdbData?.poster_path) fallback.push(tmdbPoster(tmdbData.poster_path));
    if (currentPosterUrl) fallback.push(currentPosterUrl);
    if (fallback.length) { status.textContent = ""; renderGrid(fallback, false); }
    else { status.textContent = state.savedConfig?.tmdb?.configured ? "No posters found." : "Configure a TMDB API key to browse posters."; gridEl.innerHTML = ""; }
  };

  const loadLogos = async () => {
    status.textContent = "Loading logos…";
    urlInput.value = "";
    gridEl.innerHTML = "";
    const tmdbData_ = await getTmdbImages();
    const seen = new Set();
    const items = [];
    const logos = (tmdbData_.logos || []);
    const enLogos = logos.filter(l => l.iso_639_1 === "en");
    const otherLogos = logos.filter(l => l.iso_639_1 !== "en");
    for (const l of [...enLogos, ...otherLogos].slice(0, 16)) {
      const url = tmdbImage(l.file_path, "original");
      if (!seen.has(url)) {
        seen.add(url);
        items.push({ url, lang: l.iso_639_1 ? l.iso_639_1.toUpperCase() : "-", source: "TMDB" });
      }
    }
    status.textContent = "Checking TVDB and fanart.tv...";
    const tvdbLogoItems = tvdbItems(await getTvdbImages(), "logo", seen);
    items.push(...tvdbLogoItems);
    const fanartLogoItems = fanartItems(await getFanartImages(), "logo", seen);
    items.push(...fanartLogoItems);
    if (items.length) {
      const hasEnTmdb = enLogos.length > 0;
      const hasEnFallback = items.some(l => l.source !== "TMDB" && String(l.lang || "").toLowerCase() === "en");
      status.textContent = (!hasEnTmdb && !hasEnFallback && items.length > 0) ? "No English logo found - showing other languages." : "";
      renderGrid(items, true, true);
      return;
    }
    status.textContent = state.savedConfig?.tmdb?.configured ? "No logo art found for this title." : "Configure a TMDB API key to browse logos.";
  };

  const loadBackgrounds = async () => {
    status.textContent = "Loading backgrounds...";
    urlInput.value = "";
    gridEl.innerHTML = "";
    const tmdbData_ = await getTmdbImages();
    const seen = new Set();
    const items = [];
    for (const b of (tmdbData_.backdrops || []).slice(0, 24)) {
      const url = tmdbImage(b.file_path, "original");
      if (url && !seen.has(url)) { seen.add(url); items.push({ url, source: "TMDB" }); }
    }
    status.textContent = "Checking TVDB and fanart.tv...";
    const tvdbBackgroundItems = tvdbItems(await getTvdbImages(), "background", seen);
    items.push(...tvdbBackgroundItems);
    const fanartBackgroundItems = fanartItems(await getFanartImages(), "background", seen);
    items.push(...fanartBackgroundItems);
    if (items.length) { status.textContent = ""; renderGrid(items, false, true, true); return; }
    const fallback = [];
    if (tmdbData?.backdrop_path) fallback.push(`https://image.tmdb.org/t/p/original${tmdbData.backdrop_path}`);
    if (fallback.length) { status.textContent = ""; renderGrid(fallback, false, true, true); }
    else { status.textContent = state.savedConfig?.tmdb?.configured ? "No backgrounds found." : "Configure a TMDB API key to browse backgrounds."; gridEl.innerHTML = ""; }
  };

  const reloadActiveTab = () => {
    if (activeTab === "poster") loadPosters();
    else if (activeTab === "logo") loadLogos();
    else if (activeTab === "background") loadBackgrounds();
  };

  const doMatchSearch = async () => {
    const query = matchInput.value.trim();
    if (!query) return;
    if (!state.savedConfig?.tmdb?.configured) { status.textContent = "Configure a TMDB API key to search for a match."; return; }
    status.textContent = "Searching…";
    matchResults.style.display = "none";
    matchResults.innerHTML = "";
    try {
      const mediaType = resolvedMediaType();
      const res = await fetch(`/api/tmdb-search?mediaType=${encodeURIComponent(mediaType)}&query=${encodeURIComponent(query)}`, { headers: authHeaders() });
      const data = await res.json();
      const results = (data.results || []).slice(0, 10);
      if (!results.length) { status.textContent = "No matches found."; return; }
      status.textContent = "";
      matchResults.style.display = "";
      matchResults.innerHTML = results.map((item) => {
        const poster = tmdbPoster(item.poster_path) || "/favicon.svg";
        const title = item.title || item.name || "Unknown";
        const year = (item.release_date || item.first_air_date || "").slice(0, 4);
        return `
          <button class="fix-match-result" type="button" data-tmdb-id="${item.id}" data-title="${escapeAttribute(title)}">
            <img src="${escapeAttribute(poster)}" alt="" data-err="fav" />
            <span>${escapeHtml(title)}${year ? ` <small>(${escapeHtml(year)})</small>` : ""}</span>
          </button>
        `;
      }).join("");
      matchResults.querySelectorAll(".fix-match-result").forEach((btn) => {
        btn.addEventListener("click", () => {
          match.tmdbId = btn.dataset.tmdbId;
          match.title = btn.dataset.title;
          match.tvdbId = "";
          matchInput.value = btn.dataset.title;
          matchResults.style.display = "none";
          matchResults.innerHTML = "";
          tmdbImages = null;
          tvdbImages = null;
          fanartImages = null;
          linksSlot.innerHTML = searchLinks(activeTab);
          reloadActiveTab();
        });
      });
    } catch (err) {
      status.textContent = `Search failed: ${err.message}`;
    }
  };

  matchBtn.addEventListener("click", doMatchSearch);
  matchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doMatchSearch(); } });

  const switchTab = (tab) => {
    activeTab = tab;
    overlay.querySelectorAll(".edit-image-tab").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tab));
    urlInput.value = "";
    fileInput.value = "";
    customPanel.hidden = true;
    gridEl.style.display = "";
    gridEl.classList.remove("edit-image-grid--logo", "edit-image-grid--backdrop");
    ytRow.style.display = "none";
    matchRow.style.display = tab === "youtube" ? "none" : "";
    matchResults.style.display = "none";
    matchResults.innerHTML = "";
    toolsEl.style.display = tab === "youtube" ? "none" : "";
    titleEl.textContent = imageSections[tab]?.label || "Poster";
    subtitleEl.textContent = tab === "youtube" ? "Paste a YouTube URL and choose the thumbnail to use." : "Choose TMDB or TVDB artwork, use fanart.tv fallback, or upload your own image.";
    saveBtn.textContent = imageSections[tab]?.saveLabel || "Save";
    linksSlot.innerHTML = tab === "youtube" ? "" : searchLinks(tab);
    if (tab === "poster") {
      loadPosters();
    } else if (tab === "logo") {
      loadLogos();
    } else if (tab === "background") {
      loadBackgrounds();
    } else if (tab === "youtube") {
      gridEl.innerHTML = "";
      setDialogStatus("");
      ytRow.style.display = "";
    }
  };

  overlay.querySelectorAll(".edit-image-tab").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());
  saveBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (activeTab === "youtube" && !ytInput.value.trim()) { setDialogStatus("Please enter a YouTube URL."); return; }
    if (activeTab !== "youtube" && !url) { setDialogStatus("Please select or upload an image."); return; }
    const originalLabel = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    setDialogStatus("Saving...", "muted");
    try {
      const field = imageSections[activeTab]?.field || "poster_url";
      const payload = activeTab === "youtube"
        ? { youtube_url: ytInput.value.trim(), ...(url ? { poster_url: url } : {}) }
        : { [field]: url };
      const saved = await apiUpdateWatch(id, payload);
      onSaved?.({
        ...payload,
        ...(saved?.poster_url ? { poster_url: saved.poster_url } : {}),
        ...(saved?.backdrop_url ? { backdrop_url: saved.backdrop_url } : {}),
        storage_url: saved?.poster_url,
        updated_ids: saved?.updated_ids,
      });
      setDialogStatus("Saved.", "success");
      saveBtn.textContent = "Saved";
      window.setTimeout(() => {
        if (!saveBtn.isConnected) return;
        saveBtn.textContent = imageSections[activeTab]?.saveLabel || originalLabel || "Save";
      }, 1200);
    } catch (err) {
      setDialogStatus(`Error: ${err.message}`);
    } finally {
      saveBtn.disabled = false;
    }
  });

  document.body.appendChild(overlay);
  loadPosters();
}

// ── Fix match dialog ───────────────────────────────────────────────────────

export function openFixMatchDialog(_container, id, currentTitle, mediaType, onSaved, options = {}) {
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());
  const isTv = mediaType !== "movie";
  const sourceLabel = isTv ? "TheTVDB" : "TMDB";
  const headerTitle = options.headerTitle || "Fix Match";

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.remove();
      if (typeof options.onCancel === "function") options.onCancel();
    }
  });
  overlay.innerHTML = `
    <div class="edit-dialog edit-dialog--wide fix-match-dialog glass-panel">
      <h3>${escapeHtml(headerTitle)}</h3>
      <p class="muted-copy" style="margin-bottom: 0.75rem;">Search ${sourceLabel} to link the correct ${isTv ? "TV show" : "movie"}${isTv ? " - this rematches every episode of the show" : ""}, or match to a YouTube video.</p>
      <div style="display: flex; gap: 0.5rem;">
        <input type="search" class="field fix-match-input" placeholder="${escapeAttribute(currentTitle || "Search title…")}" value="${escapeAttribute(currentTitle || "")}" style="flex: 1;" />
        <button class="button-primary fix-match-search-btn" type="button">Search ${sourceLabel}</button>
      </div>
      <div class="fix-match-results"></div>
      <hr style="border:0;border-top:1px solid var(--border);margin:1rem 0 0.75rem;" />
      <p class="muted-copy" style="margin-bottom:0.5rem;">YouTube content not on TMDB? Paste the video URL below.</p>
      <div style="display:flex;gap:0.5rem;">
        <input type="url" class="field fix-match-yt-input" placeholder="https://www.youtube.com/watch?v=..." style="flex:1;" />
        <button class="button-ghost fix-match-yt-fetch-btn" type="button">Fetch</button>
      </div>
      <div class="fix-match-yt-preview" style="display:none;margin-top:0.75rem;"></div>
      <p class="edit-dialog-status"></p>
      <div class="edit-dialog-actions" style="margin-top: 0.5rem;">
        ${options.onSkip ? `<button class="button-ghost edit-dialog-skip" type="button">Skip / Next</button>` : ""}
        <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
      </div>
    </div>
  `;

  const resultsEl = overlay.querySelector(".fix-match-results");
  const status = overlay.querySelector(".edit-dialog-status");
  const input = overlay.querySelector(".fix-match-input");
  const ytInput = overlay.querySelector(".fix-match-yt-input");
  const ytFetchBtn = overlay.querySelector(".fix-match-yt-fetch-btn");
  const ytPreview = overlay.querySelector(".fix-match-yt-preview");
  const tmdbType = mediaType === "movie" ? "movie" : "tv";

  const setResultBusy = (button, label = "Saving match...") => {
    for (const result of resultsEl.querySelectorAll(".fix-match-result")) {
      result.disabled = true;
      result.classList.toggle("is-rematching", result === button);
    }
    let progress = button.querySelector(".fix-match-result-progress");
    if (!progress) {
      progress = document.createElement("span");
      progress.className = "fix-match-result-progress";
      button.appendChild(progress);
    }
    progress.innerHTML = `
      <span class="fix-match-result-progress-label">${escapeHtml(label)}</span>
      <span class="fix-match-result-progress-track"><span style="width: 100%;"></span></span>
    `;
  };

  const doTvRematch = async (tvdbId, title, resultButton) => {
    const rows = fullShowWatchedRows(currentTitle);
    status.textContent = "";
    if (resultButton) setResultBusy(resultButton, "Updating show match...");
    const result = await apiRematchShow(id, currentTitle, tvdbId, title);
    const renamed = Boolean(result.renamed);
    const nextTitle = String(result.show_title || title || currentTitle);
    for (const row of rows) {
      row.tvdb_id = tvdbId;
      row.tmdb_id = "";
      row.poster_url = "";
      row.logo_url = "";
      row.backdrop_url = "";
      if (!renamed) continue;
      // Swap the show name but keep the SxxEyy coordinates and episode name.
      row.title = String(row.title || "").replace(/^.*?(?=\s+-\s+S\d{1,3}E\d{1,3}\b)/i, () => nextTitle);
      row.show_title = nextTitle;
    }
    const showKey = slug(currentTitle);
    const show = state.showsRaw.find((item) => slug(item.title) === showKey);
    if (show) {
      show.tvdb_id = tvdbId;
      show.tmdb_id = "";
      show.poster_url = "";
      show.logo_url = "";
      show.backdrop_url = "";
      if (renamed) show.title = nextTitle;
    }
    state.tmdbDetailsCache.clear();
    state.tmdbSeasonCache.clear();
    _clearDerivedUiCaches({ resetExplorer: true });
    overlay.remove();
    const updatedRows = Number(result.updated_rows || rows.length || 1);
    _setMessage(`Match updated for ${updatedRows} episode${updatedRows === 1 ? "" : "s"}. Refreshing metadata in the background.`, "success");

    // The show's route key is derived from its name, so a rename moves it to a
    // new URL - stay put and the current page no longer resolves to anything.
    if (renamed && slug(nextTitle) !== showKey) {
      _navigateTo(`/tvshow/${slug(nextTitle)}`);
      return;
    }

    Promise.resolve(onSaved?.({ tmdb_id: "", tvdb_id: tvdbId, title, refreshed: true })).catch((error) => {
      console.error("Failed refreshing show after Fix Match", error);
      _setMessage("Match saved. Reload the show to see refreshed metadata.", "warning");
    });
  };

  const doSearch = async () => {
    const query = input.value.trim();
    if (!query) return;
    status.textContent = "Searching…";
    resultsEl.innerHTML = "";
    try {
      if (isTv) {
        const res = await fetch(`/api/tvdb-search?query=${encodeURIComponent(query)}`, { headers: authHeaders() });
        const data = await res.json();
        const results = data.results || [];
        status.textContent = results.length ? "" : "No results found.";
        resultsEl.innerHTML = results.map((item) => `
          <button class="fix-match-result" type="button" data-tvdb-id="${escapeAttribute(item.tvdb_id)}" data-title="${escapeAttribute(item.name)}">
            <img src="${escapeAttribute(item.image_url || "/favicon.svg")}" alt="" data-err="fav" />
            <span class="fix-match-result-title">${escapeHtml(item.name)}${item.year ? ` <small>(${escapeHtml(item.year)})</small>` : ""}</span>
          </button>
        `).join("");

        resultsEl.querySelectorAll(".fix-match-result").forEach((btn) => {
          btn.addEventListener("click", async () => {
            status.textContent = "";
            setResultBusy(btn, "Preparing rematch...");
            try {
              await doTvRematch(btn.dataset.tvdbId, btn.dataset.title, btn);
            } catch (err) {
              status.textContent = `Error: ${err.message}`;
              btn.classList.remove("is-rematching");
              for (const result of resultsEl.querySelectorAll(".fix-match-result")) result.disabled = false;
            }
          });
        });
        return;
      }

      if (!state.savedConfig?.tmdb?.configured) { status.textContent = "TMDB API key not configured."; return; }
      const res = await fetch(`/api/tmdb-search?mediaType=${encodeURIComponent(tmdbType)}&query=${encodeURIComponent(query)}`, { headers: authHeaders() });
      const data = await res.json();
      const results = data.results || [];
      status.textContent = results.length ? "" : "No results found.";
      resultsEl.innerHTML = results.slice(0, 10).map((item) => {
        const poster = tmdbPoster(item.poster_path) || "/favicon.svg";
        const title = item.title || item.name || "Unknown";
        const year = (item.release_date || item.first_air_date || "").slice(0, 4);
        return `
          <button class="fix-match-result" type="button" data-tmdb-id="${item.id}" data-title="${escapeAttribute(title)}">
            <img src="${escapeAttribute(poster)}" alt="" data-err="fav" />
            <span class="fix-match-result-title">${escapeHtml(title)}${year ? ` <small>(${escapeHtml(year)})</small>` : ""}</span>
          </button>
        `;
      }).join("");

      resultsEl.querySelectorAll(".fix-match-result").forEach((btn) => {
        btn.addEventListener("click", async () => {
          status.textContent = "";
          setResultBusy(btn, "Saving match...");
          try {
            await apiUpdateWatch(id, { tmdb_id: btn.dataset.tmdbId }, options.mediaKey);
            state.tmdbDetailsCache.clear();
            state.tmdbSeasonCache.clear();
            _clearDerivedUiCaches({ resetExplorer: true });
            setResultBusy(btn, "Refreshing artwork and metadata...");
            await onSaved?.({ tmdb_id: btn.dataset.tmdbId, title: btn.dataset.title, refreshed: true });
            overlay.remove();
          } catch (err) {
            status.textContent = `Error: ${err.message}`;
            btn.classList.remove("is-rematching");
            for (const result of resultsEl.querySelectorAll(".fix-match-result")) result.disabled = false;
          }
        });
      });
    } catch (err) {
      status.textContent = `Search failed: ${err.message}`;
    }
  };

  const doYtFetch = async () => {
    const url = ytInput.value.trim();
    const videoId = extractYouTubeId(url);
    if (!videoId) { status.textContent = "Could not find a YouTube video ID in that URL."; return; }
    status.textContent = "Fetching YouTube metadata…";
    ytPreview.style.display = "none";
    try {
      const res = await fetch(`/api/youtube-meta?url=${encodeURIComponent(url)}`, { headers: authHeaders() });
      const meta = await res.json();
      if (meta.error) { status.textContent = `YouTube: ${meta.error}`; return; }
      status.textContent = "";

      const thumbHtml = meta.thumbnails?.length
        ? `<img src="${escapeAttribute(meta.thumbnails[0])}" alt="thumbnail" style="width:120px;height:68px;object-fit:cover;border-radius:var(--poster-radius);flex-shrink:0;" data-err="hide" />`
        : "";
      const descHtml = meta.description
        ? `<p style="font-size:0.8rem;color:var(--muted);margin:0.4rem 0 0;max-height:4.5rem;overflow:hidden;">${escapeHtml(meta.description)}</p>`
        : "";
      const dateHtml = meta.publishedAt ? `<small style="color:var(--muted);">${escapeHtml(meta.publishedAt.slice(0, 10))}</small>` : "";

      ytPreview.style.display = "block";
      ytPreview.innerHTML = `
        <div style="display:flex;gap:0.75rem;align-items:flex-start;background:var(--surface-raised,rgba(255,255,255,0.04));border-radius:8px;padding:0.6rem;">
          ${thumbHtml}
          <div style="flex:1;min-width:0;">
            <b style="display:block;">${escapeHtml(meta.title || "Unknown title")}</b>
            <small style="color:var(--muted);">${escapeHtml(meta.channelName || "")}${dateHtml ? " &middot; " + dateHtml : ""}</small>
            ${descHtml}
          </div>
        </div>
        <button class="button-primary fix-match-yt-confirm-btn" type="button" style="margin-top:0.6rem;width:100%;">Match as YouTube video</button>
      `;

      ytPreview.querySelector(".fix-match-yt-confirm-btn").addEventListener("click", async () => {
        status.textContent = "Saving…";
        try {
          const updates = { youtube_url: url, poster_url: meta.thumbnails?.[0] || "" };
          if (meta.title && meta.title !== currentTitle) updates.title = meta.title;
          await apiUpdateWatch(id, updates, options.mediaKey);
          state.tmdbDetailsCache.clear();
          overlay.remove();
          onSaved?.({ youtube_url: url, poster_url: updates.poster_url, title: updates.title || currentTitle });
        } catch (err) {
          status.textContent = `Error: ${err.message}`;
        }
      });
    } catch (err) {
      status.textContent = `Fetch failed: ${err.message}`;
    }
  };

  overlay.querySelector(".fix-match-search-btn").addEventListener("click", doSearch);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  ytFetchBtn.addEventListener("click", doYtFetch);
  ytInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doYtFetch(); } });
  const skipBtn = overlay.querySelector(".edit-dialog-skip");
  if (skipBtn && typeof options.onSkip === "function") {
    skipBtn.addEventListener("click", () => {
      overlay.remove();
      options.onSkip();
    });
  }

  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => {
    overlay.remove();
    if (typeof options.onCancel === "function") options.onCancel();
  });

  document.body.appendChild(overlay);
  doSearch();
}

// ── Merge show dialog ──────────────────────────────────────────────────────

export function openMergeShowDialog(targetTitle) {
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="edit-dialog edit-dialog--wide glass-panel">
      <h3>Merge Into "${escapeHtml(targetTitle)}"</h3>
      <p class="muted-copy" style="margin-bottom: 0.75rem;">Select a duplicate show to merge into this one. Its episodes will be moved here and the duplicate removed.</p>
      <div style="display: flex; gap: 0.5rem;">
        <input type="search" class="field merge-show-input" placeholder="Search shows…" value="${escapeAttribute(targetTitle)}" style="flex: 1;" />
        <button class="button-primary merge-show-search-btn" type="button">Search</button>
      </div>
      <div class="fix-match-results merge-show-results"></div>
      <p class="edit-dialog-status"></p>
      <div class="edit-dialog-actions" style="margin-top: 0.5rem;">
        <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
      </div>
    </div>
  `;

  const resultsEl = overlay.querySelector(".merge-show-results");
  const status = overlay.querySelector(".edit-dialog-status");
  const input = overlay.querySelector(".merge-show-input");

  const doSearch = async () => {
    const query = input.value.trim();
    if (!query) return;
    status.textContent = "Searching…";
    resultsEl.innerHTML = "";
    try {
      const res = await fetch(`/api/shows?search=${encodeURIComponent(query)}&limit=20`, { headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      const shows = (body.shows || []).filter((s) => (sanitizeTitle(s.title) || "").toLowerCase() !== targetTitle.toLowerCase());
      status.textContent = shows.length ? "" : "No other shows found.";
      resultsEl.innerHTML = shows.map((s) => {
        const title = sanitizeTitle(s.title) || "Unknown Show";
        const count = s.episode_count || s.episodes?.length || 0;
        const posterUrl = s.poster_url || "";
        return `
          <button class="fix-match-result" type="button" data-source-title="${escapeAttribute(title)}">
            ${posterUrl ? `<img src="${escapeAttribute(posterUrl)}" alt="" data-err="hide" />` : ""}
            <span>${escapeHtml(title)}${count ? ` <small>(${count} eps)</small>` : ""}</span>
          </button>
        `;
      }).join("");

      resultsEl.querySelectorAll(".fix-match-result").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const sourceTitle = btn.dataset.sourceTitle;
          if (!confirm(`Merge "${sourceTitle}" into "${targetTitle}"? This cannot be undone.`)) return;
          status.textContent = "Merging…";
          try {
            const r = await fetch("/api/merge-shows", {
              method: "POST",
              headers: { ...authHeaders(), "Content-Type": "application/json" },
              body: JSON.stringify({ source_title: sourceTitle, target_title: targetTitle }),
            });
            const result = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(result.error || "Merge failed");
            overlay.remove();
            state.showsRaw = state.showsRaw.filter((s) => (sanitizeTitle(s.title) || "") !== sourceTitle);
            _setMessage(`Merged "${sourceTitle}" into "${targetTitle}"`, "success");
            _navigateTo("/tvshows");
          } catch (err) {
            status.textContent = `Error: ${err.message}`;
          }
        });
      });
    } catch (err) {
      status.textContent = `Search failed: ${err.message}`;
    }
  };

  overlay.querySelector(".merge-show-search-btn").addEventListener("click", doSearch);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());

  document.body.appendChild(overlay);
  doSearch();
}
