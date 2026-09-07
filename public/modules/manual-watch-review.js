import { state } from "./state.js?v=0.16.0.0.0";
import { buildAuthHeaders } from "./auth.js?v=0.16.0.0.0";
import { posterMarkup, hydratePosters } from "./images.js?v=0.16.0.0.0";
import { escapeAttribute, escapeHtml, formatDate, movieHref, movieTmdbHref, slug, toDateTimeInputValue, tvShowTmdbHref, tvShowTvdbHref } from "./utils.js?v=0.16.0.0.0";

let _cb = {};
let reviewPollTimer = null;
let manualDatePrompt = null;
let manualWatchReviewGroupOrder = [];
let manualWatchReviewRequestSerial = 0;
let latestManualWatchReviewCountRequest = 0;
let latestManualWatchReviewFullRequest = 0;
let manualWatchReviewLastRefreshCount = null;
const expandedReviewShowKeys = new Set();
const collapsedReviewShowKeys = new Set();
const expandedReviewShowOverflowKeys = new Set();

function mediaTypeForReview(review = {}) {
  return String(review.media_type || review.media?.type || review.media?.media_type || "").toLowerCase();
}

export function isEpisodeReview(review = {}) {
  return mediaTypeForReview(review) === "episode";
}

function reviewShowIds(review = {}) {
  const media = review.media || {};
  const explicit = media.showIds || media.show_ids || {};
  return {
    imdb: explicit.imdb || media.showImdbId || media.show_imdb_id || "",
    tmdb: explicit.tmdb || media.showTmdbId || media.show_tmdb_id || "",
    tvdb: explicit.tvdb || media.showTvdbId || media.show_tvdb_id || "",
  };
}

function reviewShowTitle(review = {}) {
  const media = review.media || {};
  const explicit = String(review.show_title || media.showTitle || media.show_title || "").trim();
  if (explicit) return explicit;
  const title = String(review.title || media.title || "").trim();
  const match = title.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  return (match?.[1] || title.split(" - ")[0] || "Unknown show").trim() || "Unknown show";
}

function reviewSeason(review = {}) {
  const value = review.season ?? review.media?.season;
  return value === null || value === undefined || value === "" ? null : Number(value);
}

function reviewEpisode(review = {}) {
  const value = review.episode ?? review.media?.episode;
  return value === null || value === undefined || value === "" ? null : Number(value);
}

function reviewEpisodeCode(review = {}) {
  const season = reviewSeason(review);
  const episode = reviewEpisode(review);
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return "Episode";
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

function reviewEpisodeTitle(review = {}) {
  return String(review.episode_title || review.media?.episodeTitle || review.media?.episode_title || "").trim();
}

function reviewSource(review = {}) {
  const source = String(review.source || review.media?.source || "app").trim();
  return source ? source.replace(/^./, (value) => value.toUpperCase()) : "App";
}

function reviewStableShowId(review = {}) {
  const ids = reviewShowIds(review);
  return ids.tvdb || ids.tmdb || ids.imdb || "";
}

function reviewShowHref(review = {}) {
  const ids = reviewShowIds(review);
  const title = reviewShowTitle(review);
  if (ids.tmdb) return tvShowTmdbHref(ids.tmdb, title);
  if (ids.tvdb) return tvShowTvdbHref(ids.tvdb, title);
  return `/tvshow/${slug(title)}`;
}

function reviewMediaIds(review = {}) {
  const media = review.media || {};
  const ids = media.ids || {};
  return {
    imdb: ids.imdb || media.imdb_id || review.imdb_id || "",
    tmdb: ids.tmdb || media.tmdb_id || review.tmdb_id || "",
    tvdb: ids.tvdb || media.tvdb_id || review.tvdb_id || "",
  };
}

function reviewMovieHref(review = {}) {
  const ids = reviewMediaIds(review);
  const title = String(review.title || review.media?.title || "Unknown movie").trim();
  if (ids.tmdb) return movieTmdbHref(ids.tmdb, title);
  return movieHref({ id: review.id, title });
}

export function reviewGroupKey(review = {}) {
  if (!isEpisodeReview(review)) return `movie:${String(review.id || review.media_key || slug(review.title || "movie"))}`;
  const stableId = reviewStableShowId(review);
  return `show:${stableId ? String(stableId).toLowerCase() : slug(reviewShowTitle(review))}`;
}

function reviewSearchText(review = {}) {
  const media = review.media || {};
  const ids = media.ids || {};
  const showIds = reviewShowIds(review);
  return [
    review.title,
    review.show_title,
    review.episode_title,
    review.source,
    review.media_type,
    review.media_key,
    media.title,
    media.showTitle,
    media.episodeTitle,
    ...Object.values(ids),
    ...Object.values(showIds),
  ].filter(Boolean).join(" ").toLowerCase();
}

export function filterManualWatchReviews(reviews = [], query = "") {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return Array.isArray(reviews) ? reviews : [];
  return (Array.isArray(reviews) ? reviews : []).filter((review) => reviewSearchText(review).includes(needle));
}

function compareReviewValues(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function compareEpisodeReviews(left, right) {
  const leftSeason = reviewSeason(left);
  const rightSeason = reviewSeason(right);
  const seasonOrder = (Number.isInteger(leftSeason) ? leftSeason : Number.MAX_SAFE_INTEGER)
    - (Number.isInteger(rightSeason) ? rightSeason : Number.MAX_SAFE_INTEGER);
  if (seasonOrder) return seasonOrder;

  const leftEpisode = reviewEpisode(left);
  const rightEpisode = reviewEpisode(right);
  const episodeOrder = (Number.isInteger(leftEpisode) ? leftEpisode : Number.MAX_SAFE_INTEGER)
    - (Number.isInteger(rightEpisode) ? rightEpisode : Number.MAX_SAFE_INTEGER);
  if (episodeOrder) return episodeOrder;

  return compareReviewValues(reviewEpisodeTitle(left), reviewEpisodeTitle(right))
    || compareReviewValues(left.id, right.id);
}

export function groupManualWatchReviews(reviews = []) {
  const groups = [];
  const byKey = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    if (!isEpisodeReview(review)) {
      groups.push({ kind: "movie", key: reviewGroupKey(review), title: review.title || "Unknown movie", reviews: [review] });
      continue;
    }
    const key = reviewGroupKey(review);
    let group = byKey.get(key);
    if (!group) {
      group = { kind: "show", key, title: reviewShowTitle(review), reviews: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.reviews.push(review);
  }

  // The API naturally returns newly detected flags first. Keep that group
  // order, while making the episodes inside each show predictable.
  for (const group of groups) {
    if (group.kind === "show") group.reviews.sort(compareEpisodeReviews);
  }
  return groups;
}

export function orderManualWatchReviewGroups(groups = [], previousOrder = []) {
  const groupList = Array.isArray(groups) ? groups : [];
  const currentKeys = new Set(groupList.map((group) => group.key));
  const orderedKeys = [];
  const seen = new Set();
  for (const key of Array.isArray(previousOrder) ? previousOrder : []) {
    if (currentKeys.has(key) && !seen.has(key)) {
      orderedKeys.push(key);
      seen.add(key);
    }
  }
  for (const group of groupList) {
    if (!seen.has(group.key)) {
      orderedKeys.push(group.key);
      seen.add(group.key);
    }
  }
  const positions = new Map(orderedKeys.map((key, index) => [key, index]));
  return [...groupList].sort((left, right) => (
    (positions.get(left.key) ?? Number.MAX_SAFE_INTEGER)
      - (positions.get(right.key) ?? Number.MAX_SAFE_INTEGER)
  ));
}

function reviewGroupsForDisplay(groups = []) {
  const ordered = orderManualWatchReviewGroups(groups, manualWatchReviewGroupOrder);
  manualWatchReviewGroupOrder = ordered.map((group) => group.key);
  return ordered;
}

function dateLabel(value, fallback = "Not supplied") {
  if (!value) return fallback;
  try {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : formatDate(date.toISOString());
  } catch {
    return fallback;
  }
}

function reviewTitle(review) {
  if (!isEpisodeReview(review)) return review.title || "Unknown movie";
  return `${reviewShowTitle(review)} - ${reviewEpisodeCode(review)}`;
}

function reviewPosterItem(review, title) {
  const media = review.media || {};
  const showIds = reviewShowIds(review);
  const storedPoster = media.posterUrl || media.poster_url || "";
  return {
    ...media,
    id: review.id,
    media_key: review.media_key,
    title,
    show_title: reviewShowTitle(review),
    media_type: mediaTypeForReview(review),
    source: review.source || media.source,
    season: reviewSeason(review),
    episode: reviewEpisode(review),
    show_imdb_id: showIds.imdb || null,
    show_tmdb_id: showIds.tmdb || null,
    show_tvdb_id: showIds.tvdb || null,
    // The image form of the same authenticated resolver is a reliable first
    // paint for pending reviews. It also works when a review has no watch
    // history row yet, while hydratePosters still handles cached/local art and
    // broken-image fallback behaviour.
    poster_url: storedPoster || `/api/poster?format=image&id=${encodeURIComponent(String(review.id))}`,
    show_poster_url: media.showPosterUrl || media.show_poster_url || "",
    prefer_raw_poster: true,
    // Review posters are part of the decision surface. Keep them eager so a
    // movie that moves after an episode decision is not left blank by the
    // browser's lazy-image viewport heuristics.
    eager_poster: true,
  };
}

function reviewPosterHtml(review, title) {
  return posterMarkup(reviewPosterItem(review, title), "manual-watch-review-poster");
}

function reviewActionButtons({ includeEpisodeTiming = true } = {}) {
  return `
    <button class="button-ghost" type="button" data-manual-watch-review-action="approve" data-manual-watch-review-mode="now">Mark watched now</button>
    <button class="button-ghost" type="button" data-manual-watch-review-action="approve" data-manual-watch-review-mode="release_day">Use release day</button>
    ${includeEpisodeTiming ? `<button class="button-ghost" type="button" data-manual-watch-review-action="approve" data-manual-watch-review-mode="episode_timing">Use episode timing</button>` : ""}
    <button class="button-ghost" type="button" data-manual-watch-review-custom="item">Choose date &amp; time</button>
    <button class="button-danger" type="button" data-manual-watch-review-action="dismiss">Dismiss &amp; mark unwatched</button>
  `;
}

function renderReviewCard(review) {
  const title = reviewTitle(review);
  const episodeTitle = reviewEpisodeTitle(review);
  const href = reviewMovieHref(review);
  return `
    <article class="manual-watch-review-card" data-manual-watch-review-id="${escapeAttribute(review.id)}">
      <div class="manual-watch-review-poster-wrap">
        <a class="manual-watch-review-poster-link" href="${escapeAttribute(href)}" data-manual-watch-review-link="${escapeAttribute(href)}" aria-label="View ${escapeAttribute(title)}">
          ${reviewPosterHtml(review, title)}
        </a>
      </div>
      <div class="manual-watch-review-main">
        <div class="manual-watch-review-heading">
          <div>
            <h3><a class="manual-watch-review-title-link" href="${escapeAttribute(href)}" data-manual-watch-review-link="${escapeAttribute(href)}">${escapeHtml(title)}</a></h3>
            ${episodeTitle ? `<p class="manual-watch-review-episode">${escapeHtml(episodeTitle)}</p>` : ""}
          </div>
          <span class="status-pill status-warning">${escapeHtml(reviewSource(review))}</span>
        </div>
        <div class="manual-watch-review-meta">
          <span>App flag detected ${escapeHtml(review.updated_at ? dateLabel(new Date(review.updated_at).toISOString()) : "Not supplied")}</span>
          <span>Release day ${escapeHtml(dateLabel(review.release_date))}</span>
          ${review.observed_watched_at ? `<span>Source date ${escapeHtml(dateLabel(review.observed_watched_at))}</span>` : ""}
        </div>
        <p class="manual-watch-review-copy">This app reported the item as watched without a reliable playback completion time. Choose how Plembfin should date it; leaving this card alone keeps it pending.</p>
        <div class="manual-watch-review-actions">${reviewActionButtons({ includeEpisodeTiming: false })}</div>
      </div>
    </article>
  `;
}

function renderReviewEpisodeRow(review) {
  const episodeTitle = reviewEpisodeTitle(review);
  const title = reviewTitle(review);
  return `
    <article class="manual-watch-review-episode-row" data-manual-watch-review-id="${escapeAttribute(review.id)}">
      <div class="manual-watch-review-episode-copy">
        <div class="manual-watch-review-episode-heading">
          <span class="manual-watch-review-episode-code">${escapeHtml(reviewEpisodeCode(review))}</span>
          <h4>${escapeHtml(episodeTitle || title)}</h4>
          <span class="status-pill status-warning">${escapeHtml(reviewSource(review))}</span>
        </div>
        <div class="manual-watch-review-meta">
          <span>Flag detected ${escapeHtml(review.updated_at ? dateLabel(new Date(review.updated_at).toISOString()) : "Not supplied")}</span>
          <span>Release day ${escapeHtml(dateLabel(review.release_date))}</span>
          ${review.observed_watched_at ? `<span>Source date ${escapeHtml(dateLabel(review.observed_watched_at))}</span>` : ""}
        </div>
      </div>
      <div class="manual-watch-review-episode-actions manual-watch-review-actions">${reviewActionButtons({ includeEpisodeTiming: true })}</div>
    </article>
  `;
}

function groupSourceLabel(reviews) {
  const sources = [...new Set(reviews.map(reviewSource))];
  return sources.length ? sources.join(", ") : "Connected apps";
}

function renderReviewShowGroup(group, query = "") {
  const open = expandedReviewShowKeys.has(group.key) || !collapsedReviewShowKeys.has(group.key) || Boolean(query);
  const previewReviews = group.reviews.slice(0, 2);
  const remainingReviews = group.reviews.slice(2);
  const overflowOpen = expandedReviewShowOverflowKeys.has(group.key) || Boolean(query);
  const count = group.reviews.length;
  const href = reviewShowHref(group.reviews[0]);
  return `
    <article class="manual-watch-review-show" data-manual-watch-review-show-key="${escapeAttribute(group.key)}">
      <div class="manual-watch-review-poster-wrap manual-watch-review-show-poster-wrap">
        <a class="manual-watch-review-poster-link" href="${escapeAttribute(href)}" data-manual-watch-review-link="${escapeAttribute(href)}" aria-label="View ${escapeAttribute(group.title)}">
          ${reviewPosterHtml(group.reviews[0], group.title)}
        </a>
      </div>
      <div class="manual-watch-review-show-content">
        <div class="manual-watch-review-show-header">
          <div class="manual-watch-review-show-copy">
            <h3><a class="manual-watch-review-title-link" href="${escapeAttribute(href)}" data-manual-watch-review-link="${escapeAttribute(href)}">${escapeHtml(group.title)}</a></h3>
            <div class="manual-watch-review-meta">
              <span>${count} episode${count === 1 ? "" : "s"} waiting</span>
              <span>${escapeHtml(groupSourceLabel(group.reviews))}</span>
            </div>
          </div>
          <div class="manual-watch-review-show-actions manual-watch-review-actions">
            <button class="button-ghost" type="button" data-manual-watch-review-group-action="approve" data-manual-watch-review-group-key="${escapeAttribute(group.key)}" data-manual-watch-review-mode="now">Mark all watched now</button>
            <button class="button-ghost" type="button" data-manual-watch-review-group-action="approve" data-manual-watch-review-group-key="${escapeAttribute(group.key)}" data-manual-watch-review-mode="release_day">All on release day</button>
            <button class="button-ghost" type="button" data-manual-watch-review-group-action="approve" data-manual-watch-review-group-key="${escapeAttribute(group.key)}" data-manual-watch-review-mode="episode_timing">All with episode timing</button>
            <button class="button-ghost" type="button" data-manual-watch-review-custom="group" data-manual-watch-review-group-key="${escapeAttribute(group.key)}">All at date &amp; time</button>
            <button class="button-danger" type="button" data-manual-watch-review-group-action="dismiss" data-manual-watch-review-group-key="${escapeAttribute(group.key)}">Dismiss all &amp; mark unwatched</button>
          </div>
        </div>
        <details class="manual-watch-review-episodes" data-manual-watch-review-show-key="${escapeAttribute(group.key)}"${open ? " open" : ""}>
          <summary><span>Episodes</span><span>${count} waiting</span></summary>
          <div class="manual-watch-review-episode-list">${previewReviews.map(renderReviewEpisodeRow).join("")}</div>
          ${remainingReviews.length ? `
            <details class="manual-watch-review-more-episodes" data-manual-watch-review-overflow-key="${escapeAttribute(group.key)}"${overflowOpen ? " open" : ""}>
              <summary>Show ${remainingReviews.length} more episode${remainingReviews.length === 1 ? "" : "s"}</summary>
              <div class="manual-watch-review-episode-list">${remainingReviews.map(renderReviewEpisodeRow).join("")}</div>
            </details>
          ` : ""}
        </details>
      </div>
    </article>
  `;
}

function manualReviewDateInputValue(reviews = []) {
  const first = Array.isArray(reviews) ? reviews[0] : reviews;
  const preferred = first?.observed_watched_at || first?.release_date || new Date().toISOString();
  return toDateTimeInputValue(preferred) || toDateTimeInputValue(new Date());
}

function renderManualDatePrompt(target) {
  const isGroup = target?.kind === "group";
  const reviews = isGroup ? target.reviews : [target.review];
  const title = isGroup ? target.title : reviewTitle(target.review);
  const sub = isGroup
    ? `${reviews.length} episode${reviews.length === 1 ? "" : "s"}`
    : reviewSource(target.review);
  const help = isGroup
    ? "This date and time will be applied to every episode in this show."
    : "This date and time will be saved as the watch date for this item.";
  return `
    <div class="watch-date-overlay manual-watch-review-date-overlay" role="dialog" aria-modal="true" aria-label="Choose watch date and time">
      <div class="watch-date-dialog manual-watch-review-date-dialog">
        <div class="watch-date-head">
          <div class="watch-date-head-text">
            <h3>Choose watch date &amp; time</h3>
            <p class="watch-date-sub">${escapeHtml(title)} &middot; ${escapeHtml(sub)}</p>
          </div>
          <button class="watch-date-close" type="button" data-manual-watch-review-date-cancel aria-label="Cancel">&times;</button>
        </div>
        <label class="manual-watch-review-date-field">
          <span>Watch date and time</span>
          <input class="field" type="datetime-local" data-manual-watch-review-date-input value="${escapeAttribute(manualReviewDateInputValue(reviews))}" max="${escapeAttribute(toDateTimeInputValue(new Date()))}" required />
        </label>
        <p class="manual-watch-review-date-help">${escapeHtml(help)}</p>
        <div class="watch-date-calendar-actions">
          <button class="button-primary" type="button" data-manual-watch-review-date-save>Save date &amp; time</button>
          <button class="button-ghost" type="button" data-manual-watch-review-date-cancel>Cancel</button>
        </div>
      </div>
    </div>
  `;
}

function closeManualDatePrompt() {
  manualDatePrompt = null;
  document.querySelectorAll?.(".manual-watch-review-date-overlay")?.forEach((overlay) => overlay.remove());
}

function reviewElementById(id) {
  return [...document.querySelectorAll("[data-manual-watch-review-id]")]
    .find((element) => String(element.dataset.manualWatchReviewId) === String(id)) || null;
}

function groupElementByKey(key) {
  return [...document.querySelectorAll(".manual-watch-review-show[data-manual-watch-review-show-key]")]
    .find((element) => String(element.dataset.manualWatchReviewShowKey) === String(key)) || null;
}

function openManualDatePrompt(target) {
  if (!target) return;
  closeManualDatePrompt();
  manualDatePrompt = target;
  document.body.insertAdjacentHTML("beforeend", renderManualDatePrompt(target));
  const input = document.querySelector("[data-manual-watch-review-date-input]");
  input?.focus();
  input?.select?.();
}

function bindManualDatePrompt() {
  if (document.body.dataset.manualWatchReviewDateBound) return;
  document.body.dataset.manualWatchReviewDateBound = "true";
  document.body.addEventListener("click", (event) => {
    const cancel = event.target.closest?.("[data-manual-watch-review-date-cancel]");
    if (cancel) {
      closeManualDatePrompt();
      return;
    }

    const save = event.target.closest?.("[data-manual-watch-review-date-save]");
    if (!save) {
      if (event.target.closest?.(".manual-watch-review-date-overlay") && event.target === event.target.closest(".manual-watch-review-date-overlay")) {
        closeManualDatePrompt();
      }
      return;
    }

    const input = document.querySelector("[data-manual-watch-review-date-input]");
    const rawValue = String(input?.value || "").trim();
    const date = new Date(rawValue);
    if (!rawValue || Number.isNaN(date.getTime())) {
      _cb.setMessage?.("Enter a valid watch date and time.", "error");
      input?.focus();
      return;
    }
    if (date.getTime() > Date.now() + 60_000) {
      _cb.setMessage?.("The watch date and time cannot be in the future.", "error");
      input?.focus();
      return;
    }

    const target = manualDatePrompt;
    closeManualDatePrompt();
    if (!target) return;
    if (target.kind === "group") {
      handleGroupAction(
        target.groupKey,
        "approve",
        "custom",
        groupElementByKey(target.groupKey),
        date.toISOString(),
      ).catch((error) => _cb.setMessage?.(error.message || "Manual watch review failed.", "error"));
      return;
    }
    handleReviewAction(
      target.review.id,
      "approve",
      "custom",
      reviewElementById(target.review.id),
      date.toISOString(),
    ).catch((error) => _cb.setMessage?.(error.message || "Manual watch review failed.", "error"));
  });
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

function logManualWatchReviewError(error) {
  if (typeof console !== "undefined") console.warn("Manual Watch review refresh failed", error);
}

function setSummaryVisibility() {
  const button = document.querySelector("#manualWatchReviewButton");
  const count = document.querySelector("#manualWatchReviewCount");
  const pending = Number(state.manualWatchReviewCount || 0);
  const label = `${pending} item${pending === 1 ? "" : "s"} waiting`;
  if (count) {
    count.textContent = pending > 99 ? "99+" : String(pending);
    count.setAttribute("aria-label", label);
  }
  if (button) {
    button.classList.toggle("hidden", !state.token || pending <= 0);
    button.setAttribute("aria-label", pending > 0
      ? `Manual Watch review - ${label}`
      : "Manual Watch review");
  }
}

function bindRenderedReviewDetails(container) {
  for (const details of container.querySelectorAll(".manual-watch-review-episodes[data-manual-watch-review-show-key]")) {
    details.addEventListener("toggle", () => {
      const key = details.dataset.manualWatchReviewShowKey;
      if (!key) return;
      if (details.open) {
        expandedReviewShowKeys.add(key);
        collapsedReviewShowKeys.delete(key);
      } else {
        expandedReviewShowKeys.delete(key);
        collapsedReviewShowKeys.add(key);
      }
    });
  }
  for (const details of container.querySelectorAll(".manual-watch-review-more-episodes[data-manual-watch-review-overflow-key]")) {
    details.addEventListener("toggle", () => {
      const key = details.dataset.manualWatchReviewOverflowKey;
      if (!key) return;
      if (details.open) expandedReviewShowOverflowKeys.add(key);
      else expandedReviewShowOverflowKeys.delete(key);
    });
  }
}

export function initManualWatchReview(callbacks = {}) {
  _cb = callbacks;
  const container = document.querySelector("#manualWatchReviewRows");
  if (!container) return;
  bindManualDatePrompt();

  if (!container.dataset.bound) {
    container.dataset.bound = "true";
    container.addEventListener("click", (event) => {
      const link = event.target.closest?.("[data-manual-watch-review-link]");
      if (link && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) && event.button === 0) {
        const href = link.dataset.manualWatchReviewLink;
        if (href && typeof _cb.navigateTo === "function") {
          event.preventDefault();
          _cb.navigateTo(href);
          return;
        }
      }

      const customButton = event.target.closest?.("[data-manual-watch-review-custom]");
      if (customButton && !customButton.disabled) {
        const kind = customButton.dataset.manualWatchReviewCustom;
        if (kind === "group") {
          const groupKey = customButton.dataset.manualWatchReviewGroupKey || "";
          const reviews = state.manualWatchReviews.filter((review) => isEpisodeReview(review) && reviewGroupKey(review) === groupKey);
          if (groupKey && reviews.length) openManualDatePrompt({ kind: "group", groupKey, title: reviewShowTitle(reviews[0]), reviews });
        } else {
          const card = customButton.closest("[data-manual-watch-review-id]");
          const id = card?.dataset.manualWatchReviewId;
          const review = state.manualWatchReviews.find((item) => String(item.id) === String(id));
          if (review) openManualDatePrompt({ kind: "item", review });
        }
        return;
      }

      const groupButton = event.target.closest("[data-manual-watch-review-group-action]");
      if (groupButton && !groupButton.disabled) {
        const groupKey = groupButton.dataset.manualWatchReviewGroupKey;
        const group = groupButton.closest("[data-manual-watch-review-show-key]");
        const action = groupButton.dataset.manualWatchReviewGroupAction;
        const mode = groupButton.dataset.manualWatchReviewMode || "";
        if (groupKey) {
          handleGroupAction(groupKey, action, mode, group).catch((error) => {
            _cb.setMessage?.(error.message || "Manual watch review failed.", "error");
          });
        }
        return;
      }

      const button = event.target.closest("[data-manual-watch-review-action]");
      if (!button || button.disabled) return;
      const card = button.closest("[data-manual-watch-review-id]");
      const id = card?.dataset.manualWatchReviewId;
      if (!id) return;
      const action = button.dataset.manualWatchReviewAction;
      const mode = button.dataset.manualWatchReviewMode || "";
      handleReviewAction(id, action, mode, card).catch((error) => {
        _cb.setMessage?.(error.message || "Manual watch review failed.", "error");
      });
    });
  }

  const search = document.querySelector("#manualWatchReviewSearch");
  if (search && !search.dataset.bound) {
    search.dataset.bound = "true";
    search.value = state.manualWatchReviewSearch || "";
    search.addEventListener("input", () => {
      state.manualWatchReviewSearch = search.value;
      renderManualWatchReviewPage();
    });
  }

  startManualWatchReviewPolling();
}

export function renderManualWatchReviewSummary() {
  setSummaryVisibility();
}

export function renderManualWatchReviewPage() {
  const container = document.querySelector("#manualWatchReviewRows");
  const status = document.querySelector("#manualWatchReviewStatus");
  const filterStatus = document.querySelector("#manualWatchReviewFilterStatus");
  if (!container) return;
  if (state.manualWatchReviewLoading && !state.manualWatchReviewLoaded) {
    container.innerHTML = `<div class="idle-state"><b>Loading Manual Watch review...</b></div>`;
    return;
  }
  if (state.manualWatchReviewError) {
    container.innerHTML = `<div class="idle-state"><b>Manual Watch review is unavailable.</b><span>${escapeHtml(state.manualWatchReviewError)}</span></div>`;
    return;
  }

  const query = String(state.manualWatchReviewSearch || "").trim();
  const reviews = Array.isArray(state.manualWatchReviews) ? state.manualWatchReviews : [];
  const filtered = filterManualWatchReviews(reviews, query);
  const orderedGroups = reviewGroupsForDisplay(groupManualWatchReviews(reviews));
  if (!reviews.length) {
    container.innerHTML = `<div class="idle-state"><b>No manual watch decisions are waiting.</b><span>Items detected under Require review will appear here.</span></div>`;
  } else if (!filtered.length) {
    container.innerHTML = `<div class="idle-state"><b>No review items match “${escapeHtml(query)}”.</b><span>Try a show, episode, or connected app.</span></div>`;
  } else {
    const filteredGroups = groupManualWatchReviews(filtered);
    const filteredOrderedGroups = orderManualWatchReviewGroups(
      filteredGroups,
      orderedGroups.map((group) => group.key),
    );
    container.innerHTML = filteredOrderedGroups
      .map((group) => group.kind === "show"
        ? renderReviewShowGroup(group, query)
        : renderReviewCard(group.reviews[0]))
      .join("");
    bindRenderedReviewDetails(container);
    hydratePosters(container, { allowNetwork: true });
  }

  if (status) {
    status.textContent = reviews.length
      ? query
        ? `${filtered.length} of ${reviews.length} item${reviews.length === 1 ? "" : "s"} waiting for a decision.`
        : `${reviews.length} item${reviews.length === 1 ? "" : "s"} waiting for a decision.`
      : "Nothing is waiting for review.";
    status.className = "message muted";
  }
  if (filterStatus) {
    filterStatus.textContent = query && reviews.length ? `${filtered.length} match${filtered.length === 1 ? "" : "es"}` : "";
  }
  setSummaryVisibility();
}

export async function loadManualWatchReview({ summaryOnly = false } = {}) {
  if (!state.token) {
    state.manualWatchReviews = [];
    state.manualWatchReviewCount = 0;
    state.manualWatchReviewLoaded = false;
    manualWatchReviewGroupOrder = [];
    renderManualWatchReviewSummary();
    return [];
  }
  const requestId = ++manualWatchReviewRequestSerial;
  if (summaryOnly) {
    latestManualWatchReviewCountRequest = Math.max(latestManualWatchReviewCountRequest, requestId);
  } else {
    latestManualWatchReviewFullRequest = requestId;
  }
  if (!summaryOnly) {
    state.manualWatchReviewLoading = true;
    state.manualWatchReviewError = "";
    renderManualWatchReviewPage();
  }
  try {
    const response = await fetch(`/api/manual-watch-review${summaryOnly ? "?summary=1" : ""}`, {
      cache: "no-store",
      headers: authHeaders(),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || `Manual Watch review failed with ${response.status}`);
    // Summary and full-page requests can overlap during navigation or while a
    // provider event is arriving. Never let an older response put the page
    // back into a state that disagrees with the newer sidebar count.
    if (requestId >= latestManualWatchReviewCountRequest) {
      latestManualWatchReviewCountRequest = requestId;
      state.manualWatchReviewCount = Number(body.count || 0);
    }
    const isLatestFullRequest = !summaryOnly && requestId === latestManualWatchReviewFullRequest;
    if (isLatestFullRequest) {
      state.manualWatchReviews = Array.isArray(body.reviews) ? body.reviews : [];
      // A fresh server snapshot establishes the preferred newest-first order.
      // Single-item decisions keep any remaining show at its current position.
      manualWatchReviewGroupOrder = [];
      state.manualWatchReviewLoaded = true;
      if (state.manualWatchReviews.length === state.manualWatchReviewCount) manualWatchReviewLastRefreshCount = null;
    }
    renderManualWatchReviewSummary();
    if (state.activeView === "manualWatchReview" && isLatestFullRequest) renderManualWatchReviewPage();
    if (
      summaryOnly
      && state.activeView === "manualWatchReview"
      && Number(body.count || 0) !== state.manualWatchReviews.length
      && manualWatchReviewLastRefreshCount !== Number(body.count || 0)
    ) {
      // A summary response can win the race with the full page request that
      // was already in flight when the provider flag arrived. Start one newer
      // full request for this count so the stale response cannot hide the new
      // review row. The request serial above makes the older full response a
      // no-op when it eventually completes.
      manualWatchReviewLastRefreshCount = Number(body.count || 0);
      loadManualWatchReview().catch((error) => {
        logManualWatchReviewError(error);
      });
    }
    return state.manualWatchReviews;
  } catch (error) {
    if (!summaryOnly && requestId === latestManualWatchReviewFullRequest) {
      state.manualWatchReviewError = error.message || "Manual Watch review failed.";
      state.manualWatchReviewLoaded = true;
      renderManualWatchReviewPage();
    }
    throw error;
  } finally {
    if (!summaryOnly && requestId === latestManualWatchReviewFullRequest) {
      state.manualWatchReviewLoading = false;
      if (state.activeView === "manualWatchReview") renderManualWatchReviewPage();
    }
  }
}

async function postReviewAction(id, action, mode = "", watchedAt = "") {
  const payload = {};
  if (mode) payload.mode = mode;
  if (watchedAt) payload.watched_at = watchedAt;
  const response = await fetch(`/api/manual-watch-review/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.error || `Manual watch review ${action} failed with ${response.status}`);
  return body;
}

function removeReviewFromState(id, count) {
  state.manualWatchReviews = state.manualWatchReviews.filter((review) => String(review.id) !== String(id));
  state.manualWatchReviewCount = Number(count ?? state.manualWatchReviews.length);
}

function policyLabel(mode) {
  if (mode === "release_day") return "release day";
  if (mode === "episode_timing") return "episode timing";
  if (mode === "custom") return "manual date & time";
  return "now";
}

function setReviewBusy(element, busy) {
  if (!element) return;
  element.classList.toggle("is-busy", busy);
  if (busy) element.setAttribute("aria-busy", "true");
  else element.removeAttribute("aria-busy");
}

async function handleReviewAction(id, action, mode, card, watchedAt = "") {
  const buttons = [...(card?.querySelectorAll("button") || [])];
  buttons.forEach((button) => { button.disabled = true; });
  setReviewBusy(card, true);
  try {
    const body = await postReviewAction(id, action, mode, watchedAt);
    if (action !== "defer") {
      removeReviewFromState(id, body.count);
      renderManualWatchReviewPage();
    }
    _cb.setMessage?.(
      action === "dismiss"
        ? `Manual watch review dismissed; marked unwatched on ${body.source ? String(body.source).replace(/^./, (value) => value.toUpperCase()) : "the reporting app"}.`
        : action === "defer"
          ? "Manual watch review left pending."
          : `Watch decision saved (${policyLabel(mode)}) and sync queued.`,
      "success",
    );
  } finally {
    setReviewBusy(card, false);
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function handleGroupAction(groupKey, action, mode, groupElement, watchedAt = "") {
  const reviews = state.manualWatchReviews.filter((review) => isEpisodeReview(review) && reviewGroupKey(review) === groupKey);
  if (!reviews.length) return;
  const buttons = [...(groupElement?.querySelectorAll("button") || [])];
  buttons.forEach((button) => { button.disabled = true; });
  setReviewBusy(groupElement, true);
  let completed = 0;
  let failure = null;
  try {
    // Keep these calls sequential: each approval updates local history and
    // queues outbound sync, so a large show should not fan out all at once.
    for (const review of reviews) {
      try {
        const body = await postReviewAction(review.id, action, mode, watchedAt);
        if (action !== "defer") removeReviewFromState(review.id, body.count);
        completed += 1;
      } catch (error) {
        failure = error;
        break;
      }
    }
  } finally {
    setReviewBusy(groupElement, false);
    buttons.forEach((button) => { button.disabled = false; });
  }
  renderManualWatchReviewPage();
  if (failure) {
    throw new Error(`${completed} of ${reviews.length} episode${reviews.length === 1 ? "" : "s"} updated. ${failure.message}`);
  }
  _cb.setMessage?.(
    action === "dismiss"
      ? `${completed} episode${completed === 1 ? "" : "s"} dismissed and marked unwatched on the reporting app${completed === 1 ? "" : "s"}.`
      : `${completed} episode${completed === 1 ? "" : "s"} marked watched (${policyLabel(mode)}); sync queued.`,
    "success",
  );
}

export function startManualWatchReviewPolling() {
  if (reviewPollTimer) return;
  reviewPollTimer = window.setInterval(() => {
    if (document.visibilityState === "hidden" || !state.token) return;
    loadManualWatchReview({ summaryOnly: true }).catch(() => null);
  }, 30_000);
}

export function stopManualWatchReviewPolling() {
  if (reviewPollTimer) window.clearInterval(reviewPollTimer);
  reviewPollTimer = null;
}
