import { buildAuthHeaders } from "./auth.js";
import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute } from "./utils.js";
import { posterMarkup, hydratePosters } from "./images.js";

let _cb = {};

const UPCOMING_SEARCH_MIN_CHARS = 1;
const UPCOMING_SEARCH_WINDOW_MONTHS = 12;
const UPCOMING_SEARCH_DEBOUNCE_MS = 220;
// Start with the month the user can see. Scroll sentinels extend the range on
// demand, avoiding three sequential API requests and hundreds of DOM nodes on
// every first visit.
const UPCOMING_RANGE_PAST_MONTHS = 0;
const UPCOMING_RANGE_FUTURE_MONTHS = 0;

let upcomingSearchTimer = undefined;
let upcomingSearchRequestId = 0;
const upcomingBackgroundLoads = new Map();

export function initUpcoming(callbacks) {
  _cb = callbacks;
  elements.upcomingPrevButton?.addEventListener("click", () => shiftUpcomingMonth(-1));
  elements.upcomingNextButton?.addEventListener("click", () => shiftUpcomingMonth(1));
  elements.upcomingTodayButton?.addEventListener("click", () => goToToday());
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

function todayIsoDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
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

function refreshUpcoming() {
  renderUpcoming();
  loadUpcoming({ force: true }).catch((error) => _cb.setMessage?.(error.message, "error"));
  scheduleUpcomingSearchWindow();
}

function startOfMonthIso(monthKey) {
  return `${monthKey}-01`;
}

function endOfMonthIso(monthKey) {
  const [year, monthNumber] = monthKey.split("-").map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  return `${monthKey}-${String(lastDay).padStart(2, "0")}`;
}

function monthKeysInRange(startIso, endIso) {
  const keys = [];
  let [y, m] = startIso.slice(0, 7).split("-").map(Number);
  const [ey, em] = endIso.slice(0, 7).split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    keys.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return keys;
}

function ensureUpcomingRange() {
  if (state.upcomingRangeStart && state.upcomingRangeEnd) return;
  const anchor = activeMonth();
  state.upcomingRangeStart = startOfMonthIso(addMonths(anchor, -UPCOMING_RANGE_PAST_MONTHS));
  state.upcomingRangeEnd = endOfMonthIso(addMonths(anchor, UPCOMING_RANGE_FUTURE_MONTHS));
}

function resetUpcomingRange(monthKey) {
  state.upcomingRangeStart = startOfMonthIso(addMonths(monthKey, -UPCOMING_RANGE_PAST_MONTHS));
  state.upcomingRangeEnd = endOfMonthIso(addMonths(monthKey, UPCOMING_RANGE_FUTURE_MONTHS));
}

function extendRangePast() {
  state.upcomingRangeStart = startOfMonthIso(addMonths(state.upcomingRangeStart.slice(0, 7), -1));
}

function extendRangeFuture() {
  state.upcomingRangeEnd = endOfMonthIso(addMonths(state.upcomingRangeEnd.slice(0, 7), 1));
}

async function scrollRangeToMonth(monthKey) {
  state.upcomingMonth = monthKey;
  ensureUpcomingRange();
  while (monthKey < state.upcomingRangeStart.slice(0, 7)) extendRangePast();
  while (monthKey > state.upcomingRangeEnd.slice(0, 7)) extendRangeFuture();
  renderUpcoming();
  await loadUpcoming({ force: false }).catch((error) => _cb.setMessage?.(error.message, "error"));
  elements.upcomingCalendar?.querySelector(`[data-month-heading="${monthKey}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (elements.upcomingMonthTitle) elements.upcomingMonthTitle.textContent = monthTitle(monthKey);
}

async function scrollRangeToDay(dayIso, { force = false, behavior = "smooth" } = {}) {
  const monthKey = dayIso.slice(0, 7);
  state.upcomingMonth = monthKey;
  ensureUpcomingRange();
  while (monthKey < state.upcomingRangeStart.slice(0, 7)) extendRangePast();
  while (monthKey > state.upcomingRangeEnd.slice(0, 7)) extendRangeFuture();
  renderUpcoming();
  await loadUpcoming({ force }).catch((error) => _cb.setMessage?.(error.message, "error"));
  elements.upcomingCalendar?.querySelector(`[data-day="${dayIso}"]`)?.scrollIntoView({ behavior, block: "center" });
  if (elements.upcomingMonthTitle) elements.upcomingMonthTitle.textContent = monthTitle(monthKey);
}

function shiftUpcomingMonth(delta) {
  scrollRangeToMonth(addMonths(activeMonth(), delta));
}

function goToToday() {
  scrollRangeToDay(todayIsoDate());
}

// Called whenever the Upcoming page is navigated to, so it always opens on
// today's date rather than wherever a prior visit's scroll position landed.
export function openUpcomingToToday() {
  const dayIso = todayIsoDate();
  // Returning to Upcoming should not retain months that were added while
  // browsing in the previous visit. Reset the visible range so the month
  // title and the first rendered calendar block always describe the same day.
  resetUpcomingRange(dayIso.slice(0, 7));
  return scrollRangeToDay(dayIso, { force: true, behavior: "auto" });
}

export async function loadUpcoming({ force = false } = {}) {
  ensureUpcomingRange();
  const monthsToLoad = monthKeysInRange(state.upcomingRangeStart, state.upcomingRangeEnd);

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

function entryMarkup(episode) {
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
        <span class="upcoming-entry-title">${escapeHtml(episode.showTitle || "Unknown show")}</span>
        <span class="upcoming-entry-meta">
          <span class="upcoming-entry-code">${escapeHtml(code)}</span>
          ${episode.episodeTitle ? `<span class="upcoming-entry-episode">${escapeHtml(episode.episodeTitle)}</span>` : ""}
        </span>
      </span>
    </button>`;
}

function renderMonthGridView() {
  const container = elements.upcomingCalendar;
  if (!container) return;

  ensureUpcomingRange();
  if (elements.upcomingMonthTitle) elements.upcomingMonthTitle.textContent = monthTitle(activeMonth());

  const todayIso = todayIsoDate();
  const monthKeys = monthKeysInRange(state.upcomingRangeStart, state.upcomingRangeEnd);

  const blocks = monthKeys.map((monthKey) => {
    const [year, monthNumber] = monthKey.split("-").map(Number);
    const daysInMonth = new Date(year, monthNumber, 0).getDate();
    const leadingBlanks = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7; // Monday-start week
    const trailingBlanks = (7 - ((leadingBlanks + daysInMonth) % 7)) % 7;
    const monthEpisodes = state.upcomingByMonth.get(monthKey) || [];

    const cells = [];
    for (let i = 0; i < leadingBlanks; i += 1) {
      cells.push(`<div class="upcoming-week-day is-outside" aria-hidden="true"></div>`);
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const dayIso = `${monthKey}-${String(day).padStart(2, "0")}`;
      const dayEpisodes = monthEpisodes.filter((e) => String(e.airDate || "").slice(0, 10) === dayIso);

      const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(new Date(year, monthNumber - 1, day));
      const classes = ["upcoming-week-day"];
      if (dayIso === todayIso) classes.push("is-today");
      if (dayIso < todayIso) classes.push("is-past");
      if (!dayEpisodes.length) classes.push("is-empty");

      cells.push(`
        <div class="${classes.join(" ")}" data-day="${dayIso}">
          <div class="upcoming-week-day-head">
            <span class="upcoming-week-day-weekday">${escapeHtml(weekday)}</span>
            <span class="upcoming-week-day-number">${day}</span>
          </div>
          <div class="upcoming-week-day-entries">${dayEpisodes.map(entryMarkup).join("")}</div>
        </div>`);
    }
    for (let i = 0; i < trailingBlanks; i += 1) {
      cells.push(`<div class="upcoming-week-day is-outside" aria-hidden="true"></div>`);
    }

    return `
      <div class="upcoming-month-block">
        <div class="upcoming-month-heading" data-month-heading="${monthKey}">${escapeHtml(monthTitle(monthKey))}</div>
        <div class="upcoming-month-grid">${cells.join("")}</div>
      </div>`;
  });

  container.innerHTML = blocks.join("");

  hydratePosters(container);
}

function renderSearchResultsView(searchQuery) {
  const container = elements.upcomingCalendar;
  if (!container) return;
  rangeScrollObserver?.disconnect();

  if (elements.upcomingMonthTitle) elements.upcomingMonthTitle.textContent = "Search results";

  const todayIso = todayIsoDate();
  const monthKeys = Array.from(state.upcomingByMonth.keys()).sort();

  let lastMonthKey = "";
  let totalMatches = 0;
  const parts = [];
  for (const monthKey of monthKeys) {
    const monthEpisodes = state.upcomingByMonth.get(monthKey) || [];
    const matches = filterUpcomingEpisodes(monthEpisodes, searchQuery);
    if (!matches.length) continue;

    const byDay = new Map();
    for (const episode of matches) {
      const dayIso = String(episode.airDate || "").slice(0, 10);
      if (!dayIso) continue;
      if (!byDay.has(dayIso)) byDay.set(dayIso, []);
      byDay.get(dayIso).push(episode);
    }
    const dayIsos = Array.from(byDay.keys()).sort();
    if (!dayIsos.length) continue;

    if (monthKey !== lastMonthKey) {
      lastMonthKey = monthKey;
      parts.push(`<div class="upcoming-month-heading">${escapeHtml(monthTitle(monthKey))}</div>`);
    }

    for (const dayIso of dayIsos) {
      const dayEpisodes = byDay.get(dayIso);
      totalMatches += dayEpisodes.length;
      const date = new Date(`${dayIso}T00:00:00`);
      const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
      const dateNum = date.getDate();
      const classes = ["upcoming-week-day"];
      if (dayIso === todayIso) classes.push("is-today");
      if (dayIso < todayIso) classes.push("is-past");

      parts.push(`
        <div class="${classes.join(" ")}">
          <div class="upcoming-week-day-head">
            <span class="upcoming-week-day-weekday">${escapeHtml(weekday)}</span>
            <span class="upcoming-week-day-number">${dateNum}</span>
          </div>
          <div class="upcoming-week-day-entries">${dayEpisodes.map(entryMarkup).join("")}</div>
        </div>`);
    }
  }

  const statusMessage = !totalMatches
    ? `<p class="upcoming-status">${state.upcomingSearchLoading
      ? "Searching upcoming episodes..."
      : `No episodes match "${escapeHtml(searchQuery.trim())}".`}</p>`
    : "";

  container.innerHTML = `
    <div class="upcoming-month-list">${parts.join("")}</div>
    ${statusMessage}`;

  hydratePosters(container);
}

export function renderUpcoming() {
  if (elements.upcomingSearchInput && elements.upcomingSearchInput.value !== state.upcomingSearch) {
    elements.upcomingSearchInput.value = state.upcomingSearch || "";
  }
  const searchQuery = state.upcomingSearch || "";
  if (normalizeUpcomingSearch(searchQuery)) {
    return renderSearchResultsView(searchQuery);
  }
  return renderMonthGridView();
}
