import { state } from "./state.js";
import { escapeHtml, escapeAttribute, slug, sanitizeTitle, showTitleFrom, formatDate } from "./utils.js";
import { buildAuthHeaders } from "./auth.js";
import { isWatchedHistoryAction } from "./sync.js";
import { tmdbPoster, tmdbImage } from "./images.js";
import { dateAtMiddayIso, refreshShowAfterManualWatch } from "./watch-action.js";

// Callbacks injected by app.js at startup.
let _setMessage = () => {};
let _clearDerivedUiCaches = () => {};
let _renderImmersiveShowModal = async () => {};
let _openShowImmersiveModalByTmdbId = async () => {};
let _navigateTo = () => {};

export function initEditDialogs(callbacks) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.clearDerivedUiCaches) _clearDerivedUiCaches = callbacks.clearDerivedUiCaches;
  if (callbacks.renderImmersiveShowModal) _renderImmersiveShowModal = callbacks.renderImmersiveShowModal;
  if (callbacks.openShowImmersiveModalByTmdbId) _openShowImmersiveModalByTmdbId = callbacks.openShowImmersiveModalByTmdbId;
  if (callbacks.navigateTo) _navigateTo = callbacks.navigateTo;
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

// ── Core API helper ────────────────────────────────────────────────────────

export async function apiUpdateWatch(id, fields) {
  const res = await fetch("/api/update-watch", {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ id, ...fields }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export function watchedAtToInputValue(watchedAt) {
  if (!watchedAt) return "";
  try {
    const d = new Date(watchedAt);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ""; }
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
    <div class="edit-dialog glass-panel">
      <h3>Edit Watch Date</h3>
      <div class="watch-date-section-label">Quick choices</div>
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
      <label class="field-label">
        Or pick a specific time
        <input type="datetime-local" class="field edit-date-input" value="${escapeAttribute(watchedAtToInputValue(currentWatchedAt))}" />
      </label>
      <div class="edit-dialog-actions">
        <button class="button-primary edit-dialog-save" type="button">Save</button>
        <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
      </div>
      <p class="edit-dialog-status"></p>
    </div>
  `;

  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelectorAll("[data-edit-date-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = overlay.querySelector(".edit-date-input");
      if (!input) return;
      const choice = button.dataset.editDateChoice;
      if (choice === "release" && releaseDate) input.value = watchedAtToInputValue(dateAtMiddayIso(releaseDate));
      if (choice === "now") input.value = watchedAtToInputValue(new Date().toISOString());
    });
  });
  overlay.querySelector(".edit-dialog-save").addEventListener("click", async () => {
    const input = overlay.querySelector(".edit-date-input");
    const status = overlay.querySelector(".edit-dialog-status");
    const value = input.value;
    if (!value) { status.textContent = "Please enter a date."; return; }
    const iso = new Date(value).toISOString();
    status.textContent = "Saving…";
    try {
      await apiUpdateWatch(id, { watched_at: iso });
      overlay.remove();
      onSaved?.({ watched_at: iso });
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
  });

  document.body.appendChild(overlay);
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

  const latest = rows.reduce((value, row) => row.watched_at > value ? row.watched_at : value, rows[0].watched_at || "");
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="edit-dialog glass-panel">
      <h3>Edit Show Watch Date</h3>
      <p class="muted-copy">Updates ${rows.length} watched episode date${rows.length === 1 ? "" : "s"} for ${escapeHtml(showTitle || "this show")}.</p>
      <label class="field-label">
        Watched at
        <input type="datetime-local" class="field edit-date-input" value="${escapeAttribute(watchedAtToInputValue(latest))}" />
      </label>
      <div class="edit-dialog-actions">
        <button class="button-primary edit-dialog-save" type="button">Save</button>
        <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
      </div>
      <p class="edit-dialog-status"></p>
    </div>
  `;

  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector(".edit-dialog-save").addEventListener("click", async () => {
    const input = overlay.querySelector(".edit-date-input");
    const status = overlay.querySelector(".edit-dialog-status");
    const saveButton = overlay.querySelector(".edit-dialog-save");
    const value = input.value;
    if (!value) { status.textContent = "Please enter a date."; return; }

    const watched_at = new Date(value).toISOString();
    saveButton.disabled = true;
    status.textContent = `Saving 0/${rows.length}...`;
    try {
      let saved = 0;
      for (const row of rows) {
        await apiUpdateWatch(row.id, { watched_at });
        saved += 1;
        status.textContent = `Saving ${saved}/${rows.length}...`;
      }

      for (const row of rows) row.watched_at = watched_at;
      const showKey = slug(showTitle);
      const show = state.showsRaw.find((item) => slug(item.title) === showKey);
      if (show?.episodes) {
        const ids = new Set(rows.map((row) => row.id));
        for (const episode of show.episodes) {
          if (ids.has(episode.id)) episode.watched_at = watched_at;
        }
        show.latest_watched_at = show.episodes.reduce((value, episode) => episode.watched_at > value ? episode.watched_at : value, "");
        show.earliest_watched_at = show.episodes.reduce((value, episode) => !value || episode.watched_at < value ? episode.watched_at : value, "");
      }

      _clearDerivedUiCaches({ resetExplorer: false });
      if (showTitle) await refreshShowAfterManualWatch(showTitle).catch(() => null);
      if (state.activeShowModalKey) {
        _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
      } else if (state.activeShowTmdbId) {
        await _openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
      }
      overlay.remove();
      _setMessage(`Updated ${rows.length} watched episode date${rows.length === 1 ? "" : "s"}.`, "success");
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
  if (!watchedEpisodes.length) {
    _setMessage("There are no watched episodes in this season to update.", "error");
    return;
  }

  const latest = watchedEpisodes.reduce((value, row) => row.watched_at > value ? row.watched_at : value, watchedEpisodes[0].watched_at || "");
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="edit-dialog glass-panel">
      <h3>Edit Season Watch Date</h3>
      <p class="muted-copy">Updates ${watchedEpisodes.length} watched episode date${watchedEpisodes.length === 1 ? "" : "s"} for Season ${seasonNum} of ${escapeHtml(showTitle || "this show")}.</p>
      <label class="field-label">
        Watched at
        <input type="datetime-local" class="field edit-date-input" value="${escapeAttribute(watchedAtToInputValue(latest))}" />
      </label>
      <div class="edit-dialog-actions">
        <button class="button-primary edit-dialog-save" type="button">Save</button>
        <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
      </div>
      <p class="edit-dialog-status"></p>
    </div>
  `;

  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector(".edit-dialog-save").addEventListener("click", async () => {
    const input = overlay.querySelector(".edit-date-input");
    const status = overlay.querySelector(".edit-dialog-status");
    const saveButton = overlay.querySelector(".edit-dialog-save");
    const value = input.value;
    if (!value) { status.textContent = "Please enter a date."; return; }

    const watched_at = new Date(value).toISOString();
    saveButton.disabled = true;
    status.textContent = `Saving 0/${watchedEpisodes.length}...`;
    try {
      let saved = 0;
      for (const row of watchedEpisodes) {
        await apiUpdateWatch(row.id, { watched_at });
        saved += 1;
        status.textContent = `Saving ${saved}/${watchedEpisodes.length}...`;
      }

      for (const row of watchedEpisodes) row.watched_at = watched_at;
      const showKey = slug(showTitle);
      const show = state.showsRaw.find((item) => slug(item.title) === showKey);
      if (show?.episodes) {
        const ids = new Set(watchedEpisodes.map((row) => row.id));
        for (const episode of show.episodes) {
          if (ids.has(episode.id)) episode.watched_at = watched_at;
        }
        show.latest_watched_at = show.episodes.reduce((value, episode) => episode.watched_at > value ? episode.watched_at : value, "");
        show.earliest_watched_at = show.episodes.reduce((value, episode) => !value || episode.watched_at < value ? episode.watched_at : value, "");
      }

      _clearDerivedUiCaches({ resetExplorer: false });
      if (showTitle) await refreshShowAfterManualWatch(showTitle).catch(() => null);
      if (state.activeShowModalKey) {
        _renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
      } else if (state.activeShowTmdbId) {
        await _openShowImmersiveModalByTmdbId(state.activeShowTmdbId);
      }
      overlay.remove();
      _setMessage(`Updated ${watchedEpisodes.length} episode date${watchedEpisodes.length === 1 ? "" : "s"} for Season ${seasonNum}.`, "success");
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

export function openEditImageDialog(_container, id, currentPosterUrl, tmdbData, onSaved) {
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  let activeTab = "poster";
  const mediaTitle = tmdbData?.title || tmdbData?.name || "";
  const imageSections = {
    poster: { label: "Poster", searchLabel: "posters", saveLabel: "Save poster", field: "poster_url" },
    logo: { label: "Logo", searchLabel: "logo art", saveLabel: "Save logo", field: "logo_url" },
    background: { label: "Background", searchLabel: "background art", saveLabel: "Save background", field: "backdrop_url" },
    youtube: { label: "YouTube Show", searchLabel: "", saveLabel: "Save YouTube show", field: "youtube_url" },
  };

  const searchLinks = (kind) => {
    const query = encodeURIComponent(`${mediaTitle || "media"} ${imageSections[kind]?.searchLabel || "artwork"}`);
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
            <p class="muted-copy edit-image-subtitle">Choose TMDB artwork, use fanart.tv fallback, or upload your own image.</p>
          </div>
          <button class="button-ghost edit-dialog-cancel" type="button">Cancel</button>
        </div>
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
      return `
        <button class="edit-image-option${isLogo ? " edit-image-option--logo" : ""}${isBackdrop ? " edit-image-option--backdrop" : ""}" type="button" data-url="${escapeAttribute(url)}">
          <img src="${escapeAttribute(url)}" alt="${isLogo ? "Logo" : isBackdrop ? "Background" : "Poster"} ${i + 1}" loading="lazy" data-err="hide-closest-btn" />
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
    const firstUrl = typeof items[0] === "string" ? items[0] : items[0]?.url;
    if (selectFirst && firstUrl) {
      urlInput.value = firstUrl;
      gridEl.querySelector(".edit-image-option")?.classList.add("selected");
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
    const tmdbId = tmdbData?.id;
    const mediaType = resolvedMediaType();
    if (state.savedConfig?.tmdb?.configured && tmdbId) {
      try {
        const res = await fetch(`/api/tmdb-images?mediaType=${encodeURIComponent(mediaType)}&tmdbId=${encodeURIComponent(tmdbId)}`, { headers: authHeaders() });
        tmdbImages = await res.json();
      } catch { tmdbImages = {}; }
    } else {
      tmdbImages = {};
    }
    return tmdbImages;
  };

  let fanartImages = null;
  const getFanartImages = async () => {
    if (fanartImages) return fanartImages;
    const tmdbId = tmdbData?.id;
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

  const fanartItems = (fanartData, kind, seen) => {
    const key = kind === "background" ? "backdrops" : `${kind}s`;
    return (fanartData?.[key] || []).reduce((items, item) => {
      if (item.url && !seen.has(item.url)) {
        seen.add(item.url);
        items.push({ url: item.url, lang: item.lang || "", source: "Fanart" });
      }
      return items;
    }, []);
  };

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
    status.textContent = items.length ? "Checking fanart.tv..." : "No TMDB posters found. Checking fanart.tv...";
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
        items.push({ url, lang: l.iso_639_1 ? l.iso_639_1.toUpperCase() : "—", source: "TMDB" });
      }
    }
    status.textContent = items.length ? "Checking fanart.tv..." : "No TMDB logos found. Checking fanart.tv...";
    const fanartLogoItems = fanartItems(await getFanartImages(), "logo", seen);
    items.push(...fanartLogoItems);
    if (items.length) {
      const hasEnTmdb = enLogos.length > 0;
      const hasEnFanart = items.some(l => l.source === "Fanart" && String(l.lang || "").toLowerCase() === "en");
      status.textContent = (!hasEnTmdb && !hasEnFanart && items.length > 0) ? "No English logo found — showing other languages." : "";
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
    status.textContent = items.length ? "Checking fanart.tv..." : "No TMDB backgrounds found. Checking fanart.tv...";
    const fanartBackgroundItems = fanartItems(await getFanartImages(), "background", seen);
    items.push(...fanartBackgroundItems);
    if (items.length) { status.textContent = ""; renderGrid(items, false, true, true); return; }
    const fallback = [];
    if (tmdbData?.backdrop_path) fallback.push(`https://image.tmdb.org/t/p/original${tmdbData.backdrop_path}`);
    if (fallback.length) { status.textContent = ""; renderGrid(fallback, false, true, true); }
    else { status.textContent = state.savedConfig?.tmdb?.configured ? "No backgrounds found." : "Configure a TMDB API key to browse backgrounds."; gridEl.innerHTML = ""; }
  };

  const switchTab = (tab) => {
    activeTab = tab;
    overlay.querySelectorAll(".edit-image-tab").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tab));
    urlInput.value = "";
    fileInput.value = "";
    customPanel.hidden = true;
    gridEl.style.display = "";
    gridEl.classList.remove("edit-image-grid--logo", "edit-image-grid--backdrop");
    ytRow.style.display = "none";
    toolsEl.style.display = tab === "youtube" ? "none" : "";
    titleEl.textContent = imageSections[tab]?.label || "Poster";
    subtitleEl.textContent = tab === "youtube" ? "Paste a YouTube URL and choose the thumbnail to use." : "Choose TMDB artwork, use fanart.tv fallback, or upload your own image.";
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
      status.textContent = "";
      ytRow.style.display = "";
    }
  };

  overlay.querySelectorAll(".edit-image-tab").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());
  saveBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (activeTab === "youtube" && !ytInput.value.trim()) { status.textContent = "Please enter a YouTube URL."; return; }
    if (activeTab !== "youtube" && !url) { status.textContent = "Please select or upload an image."; return; }
    status.textContent = "Saving…";
    try {
      const field = imageSections[activeTab]?.field || "poster_url";
      const payload = activeTab === "youtube"
        ? { youtube_url: ytInput.value.trim(), ...(url ? { poster_url: url } : {}) }
        : { [field]: url };
      const saved = await apiUpdateWatch(id, payload);
      overlay.remove();
      onSaved?.({
        ...payload,
        ...(saved?.poster_url ? { poster_url: saved.poster_url } : {}),
        ...(saved?.backdrop_url ? { backdrop_url: saved.backdrop_url } : {}),
        storage_url: saved?.poster_url,
        updated_ids: saved?.updated_ids,
      });
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
  });

  document.body.appendChild(overlay);
  loadPosters();
}

// ── Fix match dialog ───────────────────────────────────────────────────────

export function openFixMatchDialog(_container, id, currentTitle, mediaType, onSaved) {
  document.querySelectorAll(".edit-dialog-overlay").forEach((el) => el.remove());

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="edit-dialog edit-dialog--wide glass-panel">
      <h3>Fix Match</h3>
      <p class="muted-copy" style="margin-bottom: 0.75rem;">Search TMDB to link the correct ${mediaType === "movie" ? "movie" : "TV show"}, or match to a YouTube video.</p>
      <div style="display: flex; gap: 0.5rem;">
        <input type="search" class="field fix-match-input" placeholder="${escapeAttribute(currentTitle || "Search title…")}" value="${escapeAttribute(currentTitle || "")}" style="flex: 1;" />
        <button class="button-primary fix-match-search-btn" type="button">Search TMDB</button>
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

  const doSearch = async () => {
    const query = input.value.trim();
    if (!query) return;
    status.textContent = "Searching…";
    resultsEl.innerHTML = "";
    try {
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
            <span>${escapeHtml(title)}${year ? ` <small>(${escapeHtml(year)})</small>` : ""}</span>
          </button>
        `;
      }).join("");

      resultsEl.querySelectorAll(".fix-match-result").forEach((btn) => {
        btn.addEventListener("click", async () => {
          status.textContent = "Saving…";
          try {
            await apiUpdateWatch(id, { tmdb_id: btn.dataset.tmdbId });
            state.tmdbDetailsCache.clear();
            overlay.remove();
            onSaved?.({ tmdb_id: btn.dataset.tmdbId, title: btn.dataset.title });
          } catch (err) {
            status.textContent = `Error: ${err.message}`;
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
        ? `<img src="${escapeAttribute(meta.thumbnails[0])}" alt="thumbnail" style="width:120px;height:68px;object-fit:cover;border-radius:4px;flex-shrink:0;" data-err="hide" />`
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
          await apiUpdateWatch(id, updates);
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
  overlay.querySelector(".edit-dialog-cancel").addEventListener("click", () => overlay.remove());

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
