import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute } from "./utils.js";
import { posterMarkup, hydratePosters } from "./images.js";

let _cb = {};

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const UPCOMING_SEARCH_MIN_CHARS = 1;
const UPCOMING_SEARCH_WINDOW_MONTHS = 12;
const UPCOMING_SEARCH_DEBOUNCE_MS = 220;

let upcomingSearchTimer = undefined;
let upcomingSearchRequestId = 0;
const upcomingBackgroundLoads = new Map();

export function initUpcoming(callbacks) {
  _cb = callbacks;
  elements.upcomingCalendarViewBtn?.addEventListener("click", () => setUpcomingViewMode("calendar"));
  elements.upcomingWeekViewBtn?.addEventListener("click", () => setUpcomingViewMode("week"));
  elements.upcomingPrevButton?.addEventListener("click", () => shiftUpcomingMonth(-1));
  elements.upcomingNextButton?.addEventListener("click", () => shiftUpcomingMonth(1));
  elements.upcomingTodayButton?.addEventListener("click", () => setUpcomingMonth(currentMonth()));
  elements.upcomingSearchInput?.addEventListener("input", () => {
    state.upcomingSearch = elements.upcomingSearchInput.value || "";
    renderUpcoming();
    scheduleUpcomingSearchWindow();
  });
  elements.upcomingCalendar?.addEventListener("click", (event) => {
    const entry = event.target.closest("[data-upcoming-tmdb], [data-upcoming-show]");
    if (!entry) return;
    const tmdbId = entry.dataset.upcomingTmdb || "";
    const showId = entry.dataset.upcomingShow || "";
    if (tmdbId) _cb.navigateTo?.(`/tvshow/tmdb/${tmdbId}`);
    else if (showId) _cb.navigateTo?.(`/tvshow/${encodeURIComponent(showId)}`);
  });
  // Poster hydration only touches near-viewport fallbacks, so entries scrolled
  // into view later (mobile agenda list) need a rehydrate pass. The page-shell
  // is the app's scroll container — body itself never scrolls.
  document.querySelector(".page-shell")?.addEventListener("scroll", () => {
    if (state.activeView !== "upcoming" || state.posterHydrateScrollScheduled) return;
    state.posterHydrateScrollScheduled = true;
    window.requestAnimationFrame(() => {
      state.posterHydrateScrollScheduled = false;
      hydratePosters(elements.upcomingCalendar);
    });
  }, { passive: true });
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function addMonths(month, delta) {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(year, monthNumber - 1 + delta, 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}`;
}

function activeMonth() {
  if (!/^\d{4}-\d{2}$/.test(state.upcomingMonth || "")) state.upcomingMonth = currentMonth();
  return state.upcomingMonth;
}

function shiftUpcomingMonth(delta) {
  if (state.upcomingViewMode === "week") {
    const current = state.upcomingMonth || currentMonth();
    const [year, month, day] = current.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    date.setDate(date.getDate() + (delta * 7));
    const newIso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    setUpcomingMonth(newIso);
  } else {
    setUpcomingMonth(addMonths(activeMonth(), delta));
  }
}

function setUpcomingMonth(month) {
  state.upcomingMonth = month;
  renderUpcoming();
  loadUpcoming({ force: true }).catch((error) => _cb.setMessage?.(error.message, "error"));
  scheduleUpcomingSearchWindow();
}

function setUpcomingViewMode(mode) {
  state.upcomingViewMode = mode;
  elements.upcomingCalendarViewBtn?.classList.toggle("active", mode === "calendar");
  elements.upcomingWeekViewBtn?.classList.toggle("active", mode === "week");
  renderUpcoming();
  loadUpcoming({ force: true }).catch((error) => _cb.setMessage?.(error.message, "error"));
}

export async function loadUpcoming({ force = false } = {}) {
  const monthsToLoad = [];
  if (state.upcomingViewMode === "week") {
    const current = state.upcomingMonth || currentMonth();
    const weekStart = getWeekStart(current);
    const [weekYear, weekMonth, weekDay] = weekStart.split("-").map(Number);
    for (let i = 0; i < 7; i += 1) {
      const dayDate = new Date(weekYear, weekMonth - 1, weekDay + i);
      const monthKey = `${dayDate.getFullYear()}-${String(dayDate.getMonth() + 1).padStart(2, "0")}`;
      if (!monthsToLoad.includes(monthKey)) monthsToLoad.push(monthKey);
    }
  } else {
    monthsToLoad.push(activeMonth());
  }

  const monthsToFetch = monthsToLoad.filter((m) => force || !state.upcomingByMonth.has(m));
  if (!monthsToFetch.length) {
    renderUpcoming();
    return;
  }
  if (state.upcomingLoadingMonth) return;

  state.upcomingLoadingMonth = monthsToFetch[0];
  renderUpcoming();
  try {
    for (const month of monthsToFetch) {
      const response = await fetch(`/api/upcoming?month=${encodeURIComponent(month)}`, { headers: authHeaders() });
      if (!response.ok) throw new Error("Failed to load upcoming episodes");
      const payload = await response.json();
      state.upcomingByMonth.set(month, Array.isArray(payload.episodes) ? payload.episodes : []);
    }
  } finally {
    state.upcomingLoadingMonth = "";
    renderUpcoming();
  }
}

async function fetchUpcomingMonth(month) {
  if (state.upcomingByMonth.has(month)) return;
  if (upcomingBackgroundLoads.has(month)) return upcomingBackgroundLoads.get(month);
  const promise = fetch(`/api/upcoming?month=${encodeURIComponent(month)}`, { headers: authHeaders() })
    .then((response) => {
      if (!response.ok) throw new Error("Failed to load upcoming episodes");
      return response.json();
    })
    .then((payload) => {
      state.upcomingByMonth.set(month, Array.isArray(payload.episodes) ? payload.episodes : []);
    })
    .finally(() => {
      upcomingBackgroundLoads.delete(month);
    });
  upcomingBackgroundLoads.set(month, promise);
  return promise;
}

function searchWindowMonths(anchorMonth) {
  return Array.from({ length: UPCOMING_SEARCH_WINDOW_MONTHS }, (_, index) => addMonths(anchorMonth, index));
}

function shouldLoadSearchWindow() {
  return normalizeUpcomingSearch(state.upcomingSearch).length >= UPCOMING_SEARCH_MIN_CHARS;
}

function scheduleUpcomingSearchWindow() {
  window.clearTimeout(upcomingSearchTimer);
  if (!shouldLoadSearchWindow()) {
    upcomingSearchRequestId += 1;
    state.upcomingSearchLoading = false;
    renderUpcoming();
    return;
  }
  upcomingSearchTimer = window.setTimeout(() => {
    loadUpcomingSearchWindow().catch((error) => {
      renderUpcoming();
      _cb.setMessage?.(error.message, "error");
    });
  }, UPCOMING_SEARCH_DEBOUNCE_MS);
}

async function loadUpcomingSearchWindow() {
  const requestId = upcomingSearchRequestId + 1;
  upcomingSearchRequestId = requestId;
  const months = searchWindowMonths(activeMonth());
  const missingMonths = months.filter((month) => !state.upcomingByMonth.has(month));
  if (!missingMonths.length) {
    state.upcomingSearchLoading = false;
    renderUpcoming();
    return;
  }
  state.upcomingSearchLoading = true;
  renderUpcoming();
  try {
    for (const month of missingMonths) {
      if (requestId !== upcomingSearchRequestId || !shouldLoadSearchWindow()) return;
      await fetchUpcomingMonth(month);
    }
  } finally {
    if (requestId === upcomingSearchRequestId) state.upcomingSearchLoading = false;
  }
  if (requestId !== upcomingSearchRequestId) return;
  renderUpcoming();
}

function monthTitle(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(year, monthNumber - 1, 1);
  if (Number.isNaN(date.getTime())) return month;
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
}

function episodesByDay(episodes = []) {
  const byDay = new Map();
  for (const episode of episodes) {
    const day = Number(String(episode.airDate || "").slice(8, 10));
    if (!Number.isInteger(day) || day < 1) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(episode);
  }
  return byDay;
}

function normalizeUpcomingSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function episodeCode(episode) {
  return `S${episode.season}E${episode.episode}`;
}

function filterUpcomingEpisodes(episodes = [], query = "") {
  const normalizedQuery = normalizeUpcomingSearch(query);
  if (!normalizedQuery) return episodes;
  return episodes.filter((episode) => {
    const searchable = [
      episode.showTitle,
      episode.episodeTitle,
      episodeCode(episode),
      `season ${episode.season}`,
      `episode ${episode.episode}`,
    ].join(" ").toLowerCase();
    return searchable.includes(normalizedQuery);
  });
}

function formatSearchDate(value) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value || "";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(date);
}

function entryMarkup(episode, { includeDate = false } = {}) {
  const code = episodeCode(episode);
  const tooltipParts = [episode.showTitle, code];
  if (episode.episodeTitle) tooltipParts.push(episode.episodeTitle);
  const posterItem = { poster_url: episode.posterUrl || "", title: episode.showTitle || "" };
  // The representative episode's watch-record id lets the standard poster
  // pipeline (/api/poster + hydratePosters) resolve cached artwork.
  if (episode.posterRecordId) posterItem.id = episode.posterRecordId;
  return `
    <button class="upcoming-entry" type="button"
      data-upcoming-tmdb="${escapeAttribute(episode.tmdbId || "")}"
      data-upcoming-show="${escapeAttribute(episode.showId || "")}"
      title="${escapeAttribute(tooltipParts.join(" — "))}">
      ${posterMarkup(posterItem, "upcoming-entry-poster")}
      <span class="upcoming-entry-text">
        ${includeDate ? `<span class="upcoming-entry-date">${escapeHtml(formatSearchDate(episode.airDate))}</span>` : ""}
        <span class="upcoming-entry-title">${escapeHtml(episode.showTitle || "Unknown show")}</span>
        <span class="upcoming-entry-meta">
          <span class="upcoming-entry-code">${escapeHtml(code)}</span>
          ${episode.episodeTitle ? `<span class="upcoming-entry-episode">${escapeHtml(episode.episodeTitle)}</span>` : ""}
        </span>
      </span>
    </button>`;
}

function outsideMonthSearchResults(month, query) {
  if (!normalizeUpcomingSearch(query)) return [];
  const dedupe = new Set();
  const results = [];
  for (const [episodeMonth, episodes] of state.upcomingByMonth.entries()) {
    if (episodeMonth === month) continue;
    for (const episode of filterUpcomingEpisodes(episodes, query)) {
      const resultMonth = String(episode.airDate || "").slice(0, 7);
      if (resultMonth === month) continue;
      const key = [episode.airDate, episode.tmdbId, episode.showId, episode.season, episode.episode].join("|");
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      results.push(episode);
    }
  }
  results.sort((a, b) => String(a.airDate || "").localeCompare(String(b.airDate || ""))
    || String(a.showTitle || "").localeCompare(String(b.showTitle || ""))
    || Number(a.season || 0) - Number(b.season || 0)
    || Number(a.episode || 0) - Number(b.episode || 0));
  return results;
}

function searchResultsMarkup(month, query) {
  const results = outsideMonthSearchResults(month, query);
  const loading = state.upcomingSearchLoading && shouldLoadSearchWindow();
  if (!results.length && !loading) return "";
  const resultCount = `${results.length} ${results.length === 1 ? "result" : "results"}`;
  return `
    <section class="upcoming-search-results" aria-live="polite">
      <div class="upcoming-search-results-head">
        <p>Matches outside ${escapeHtml(monthTitle(month))}</p>
        <span>${loading ? "Searching other months..." : resultCount}</span>
      </div>
      ${results.length ? `<div class="upcoming-search-results-list">${results.map((episode) => entryMarkup(episode, { includeDate: true })).join("")}</div>` : ""}
    </section>`;
}

function getWeekStart(dateIso) {
  const [year, month, day] = dateIso.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const dayOfWeek = date.getDay();
  const monday = new Date(date);
  monday.setDate(date.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, "0");
  const d = String(monday.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function renderWeekView() {
  const container = elements.upcomingCalendar;
  if (!container) return;

  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const weekStart = getWeekStart(state.upcomingMonth || todayIso);
  const [weekYear, weekMonth, weekDay] = weekStart.split("-").map(Number);

  const weekDays = [];
  for (let i = 0; i < 7; i += 1) {
    const dayDate = new Date(weekYear, weekMonth - 1, weekDay + i);
    const dayIso = `${dayDate.getFullYear()}-${String(dayDate.getMonth() + 1).padStart(2, "0")}-${String(dayDate.getDate()).padStart(2, "0")}`;
    weekDays.push(dayIso);
  }

  const formatWeekDate = (dateIso) => {
    const date = new Date(`${dateIso}T00:00:00`);
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  };
  const weekTitle = `${formatWeekDate(weekStart)} — ${formatWeekDate(weekDays[6])}`;
  if (elements.upcomingMonthTitle) elements.upcomingMonthTitle.textContent = weekTitle;

  const searchQuery = state.upcomingSearch || "";
  const hasSearch = Boolean(normalizeUpcomingSearch(searchQuery));

  const allEpisodesByDay = new Map();
  for (const dayIso of weekDays) {
    const [y, m] = dayIso.split("-");
    const monthKey = `${y}-${m}`;
    const episodes = state.upcomingByMonth.get(monthKey) || [];
    const dayEpisodes = filterUpcomingEpisodes(episodes, searchQuery)
      .filter((e) => String(e.airDate || "").slice(0, 10) === dayIso);
    if (dayEpisodes.length) allEpisodesByDay.set(dayIso, dayEpisodes);
  }

  const cells = weekDays.map((dayIso) => {
    const dayEpisodes = allEpisodesByDay.get(dayIso) || [];
    const date = new Date(`${dayIso}T00:00:00`);
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);
    const dateNum = new Date(`${dayIso}T00:00:00`).getDate();
    const classes = ["upcoming-week-day"];
    if (dayIso === todayIso) classes.push("is-today");
    if (dayIso < todayIso) classes.push("is-past");
    if (!dayEpisodes.length) classes.push("is-empty");

    return `
      <div class="${classes.join(" ")}">
        <div class="upcoming-week-day-head">
          <span class="upcoming-week-day-weekday">${escapeHtml(weekday)}</span>
          <span class="upcoming-week-day-number">${dateNum}</span>
        </div>
        <div class="upcoming-week-day-entries">${dayEpisodes.map(entryMarkup).join("")}</div>
      </div>`;
  });

  const emptyWeek = !allEpisodesByDay.size
    ? `<p class="upcoming-status">${hasSearch
      ? `No episodes match "${escapeHtml(searchQuery.trim())}" this week.`
      : "No episode air dates this week."}</p>`
    : "";

  container.innerHTML = `
    <div class="upcoming-week">${cells.join("")}</div>
    ${emptyWeek}`;
  hydratePosters(container);
}

export function renderUpcoming() {
  if (state.upcomingViewMode === "week") {
    return renderWeekView();
  }

  const container = elements.upcomingCalendar;
  if (!container) return;
  const month = activeMonth();
  if (elements.upcomingMonthTitle) elements.upcomingMonthTitle.textContent = monthTitle(month);
  if (elements.upcomingSearchInput && elements.upcomingSearchInput.value !== state.upcomingSearch) {
    elements.upcomingSearchInput.value = state.upcomingSearch || "";
  }

  const allEpisodes = state.upcomingByMonth.get(month);
  const isLoading = state.upcomingLoadingMonth === month;
  if (!allEpisodes && isLoading) {
    container.innerHTML = `<p class="upcoming-status">Loading episode air dates...</p>`;
    return;
  }
  if (!allEpisodes) {
    container.innerHTML = `<p class="upcoming-status">Episode air dates have not loaded yet.</p>`;
    return;
  }
  const searchQuery = state.upcomingSearch || "";
  const hasSearch = Boolean(normalizeUpcomingSearch(searchQuery));
  const episodes = filterUpcomingEpisodes(allEpisodes, searchQuery);

  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const leadingBlanks = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7; // Monday-start week
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const byDay = episodesByDay(episodes);

  const cells = [];
  for (let blank = 0; blank < leadingBlanks; blank += 1) {
    cells.push(`<div class="upcoming-day is-outside" aria-hidden="true"></div>`);
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateIso = `${month}-${String(day).padStart(2, "0")}`;
    const dayEpisodes = byDay.get(day) || [];
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(year, monthNumber - 1, day));
    const classes = ["upcoming-day"];
    if (dateIso === todayIso) classes.push("is-today");
    if (dateIso < todayIso) classes.push("is-past");
    classes.push(dayEpisodes.length ? "has-episodes" : "is-empty");
    cells.push(`
      <div class="${classes.join(" ")}">
        <div class="upcoming-day-head">
          <span class="upcoming-day-number">${day}</span>
          <span class="upcoming-day-weekday">${escapeHtml(weekday)}</span>
        </div>
        <div class="upcoming-day-entries">${dayEpisodes.map(entryMarkup).join("")}</div>
      </div>`);
  }

  const emptyMonth = !episodes.length
    ? `<p class="upcoming-status">${hasSearch
      ? `No episodes match "${escapeHtml(searchQuery.trim())}" this month.`
      : "No episode air dates this month."}</p>`
    : "";

  container.innerHTML = `
    <div class="upcoming-weekdays">${WEEKDAY_LABELS.map((label) => `<span>${label}</span>`).join("")}</div>
    <div class="upcoming-grid">${cells.join("")}</div>
    ${emptyMonth}
    ${hasSearch ? searchResultsMarkup(month, searchQuery) : ""}`;
  hydratePosters(container);
}
