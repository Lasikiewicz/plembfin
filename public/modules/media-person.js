import { state, elements } from "./state.js";
import { escapeHtml, escapeAttribute, slug, movieHref, showTitleFrom, showEpisodeKey } from "./utils.js";
import { tmdbProfile, tmdbPoster, hydratePosters } from "./images.js";
import { isWatchedHistoryAction } from "./sync.js";
import { fetchTmdbDetails, fetchTmdbSeasonDetails } from "./tmdb.js?v=20260626";
import { movieBySlugOrId, clearMediaDetailState, mediaDetailRoot } from "./media-detail.js?v=20260701";
import { FILMOGRAPHY_PAGE_SIZE, getFilmographyObserver, setFilmographyObserver, resolvedTmdbCache } from "./explorer.js";

let _cb = {};
export function initMediaPerson(callbacks = {}) { _cb = callbacks; }
function navigateTo(...args) { return _cb.navigateTo?.(...args); }
function setMessage(...args) { return _cb.setMessage?.(...args); }
function authHeaders(...args) { return _cb.authHeaders?.(...args); }
function applyActiveView(...args) { return _cb.applyActiveView?.(...args); }
function syncPageTopbar(...args) { return _cb.syncPageTopbar?.(...args); }

function personAge(birthday, endDate = null) {
  if (!birthday) return null;
  const born = new Date(birthday);
  const ended = endDate ? new Date(endDate) : new Date();
  if (Number.isNaN(born.getTime()) || Number.isNaN(ended.getTime()) || ended < born) return null;
  let age = ended.getFullYear() - born.getFullYear();
  const beforeBirthday =
    ended.getMonth() < born.getMonth() ||
    (ended.getMonth() === born.getMonth() && ended.getDate() < born.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 ? age : null;
}

function personSocialLinks(data = {}) {
  const ids = data.external_ids || {};
  return [
    ids.imdb_id ? { label: "IMDb", href: `https://www.imdb.com/name/${encodeURIComponent(ids.imdb_id)}` } : null,
    ids.instagram_id ? { label: "Instagram", href: `https://www.instagram.com/${encodeURIComponent(ids.instagram_id)}` } : null,
    ids.twitter_id ? { label: "X", href: `https://x.com/${encodeURIComponent(ids.twitter_id)}` } : null,
    ids.facebook_id ? { label: "Facebook", href: `https://www.facebook.com/${encodeURIComponent(ids.facebook_id)}` } : null,
    ids.tiktok_id ? { label: "TikTok", href: `https://www.tiktok.com/@${encodeURIComponent(ids.tiktok_id)}` } : null,
    ids.wikidata_id ? { label: "Wikidata", href: `https://www.wikidata.org/wiki/${encodeURIComponent(ids.wikidata_id)}` } : null,
  ].filter(Boolean);
}

export function closePersonProfile() {
  if (elements.personModal) {
    elements.personModal.classList.add("hidden");
  }
  document.body.style.overflow = "";
  if (window.location.pathname.startsWith("/person/")) {
    const returnUrl = state.personReturnUrl;
    state.personReturnUrl = null;
    navigateTo(returnUrl || "/");
  }
}

export async function loadCastMemberDetails(personId, personName = null) {
  state.personProfileName = personName || "";
  if (elements.personModal) {
    elements.personModal.classList.add("hidden");
  }
  document.body.style.overflow = "";

  state.activeView = "explorer";
  state.mediaDetailInline = true;
  clearMediaDetailState();

  // Don't use prepareInlineMediaDetail() here: it calls selectView("explorer"),
  // which rebuilds the URL from activeMovieModalId/activeShowModalKey (still set
  // from the underlying movie/show) and overwrites the /person/<id> URL we're on.
  // That breaks closeMediaDetail()'s "return to the media item" branch below.
  applyActiveView();
  elements.explorerPanel.innerHTML = "";
  elements.explorerPanel.scrollIntoView({ block: "start" });
  document.querySelector("#explorerBackButton")?.classList.remove("hidden");
  elements.explorerTopbarControls?.classList.add("hidden");
  // Hide the alphabet picker — it should only appear on the bare movie/show explorer.
  elements.alphaFilterNav?.classList.add("hidden");


  const root = mediaDetailRoot();

  if (elements.explorerTitle) {
    elements.explorerTitle.textContent = personName || "Cast Member Profile";
  }
  if (elements.explorerSubtitle) {
    elements.explorerSubtitle.textContent = "";
  }
  syncPageTopbar();

  root.innerHTML = `
    <div style="display: flex; justify-content: center; align-items: center; min-height: 200px;">
      <span class="status-pill status-ready" style="font-size: 1rem; padding: var(--space-2) var(--space-4);">Loading profile...</span>
    </div>
  `;

  try {
    // Fetch person data and all watched movies/shows in parallel so filmography
    // watched-status is accurate regardless of which explorer tabs have been visited.
    const [res, moviesRes, showsRes] = await Promise.all([
      fetch(`/api/tmdb-person?id=${personId}`, { headers: authHeaders() }),
      fetch(`/api/movies?limit=5000&sort=title_asc`, { headers: authHeaders(), cache: "no-store" }),
      fetch(`/api/shows?limit=5000&sort=title_asc`, { headers: authHeaders(), cache: "no-store" }),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const moviesBody = await moviesRes.json().catch(() => ({}));
    const showsBody = await showsRes.json().catch(() => ({}));

    // Build filmography-local lookups by tmdb_id and slug so findLibraryItem can
    // match even when the explorer hasn't been opened yet.
    const allWatchedMovies = Array.isArray(moviesBody.movies) ? moviesBody.movies : [];
    const allWatchedShows = Array.isArray(showsBody.shows) ? showsBody.shows : [];
    const filmographyLookup = { allWatchedMovies, allWatchedShows };

    if (elements.explorerTitle) {
      elements.explorerTitle.textContent = data.name || "Cast Member Profile";
    }
    state.personProfileName = data.name || "Cast Member Profile";
    syncPageTopbar();

    const castCredits = (data.combined_credits?.cast || []);
    const profileUrl = tmdbProfile(data.profile_path) || '/favicon.svg';

    // Initialize temporary filter/sort preferences on state if not set
    state.personCreditsFilter = state.personCreditsFilter || "all";
    state.personCreditsSort = state.personCreditsSort || "popularity";
    state.personCreditsVisible = FILMOGRAPHY_PAGE_SIZE;

    root.innerHTML = `
      <div class="person-profile-container">
        <div class="person-profile-sidebar">
          <img class="person-profile-img" src="${escapeAttribute(profileUrl)}" alt="${escapeAttribute(data.name)}" data-err="fav" />
          <div class="person-profile-meta">
            <h3>Personal Info</h3>
            <div class="meta-item">
              <span class="meta-label">Known For</span>
              <span class="meta-value">${escapeHtml(data.known_for_department || "Acting")}</span>
            </div>
            ${data.birthday ? `
            <div class="meta-item">
              <span class="meta-label">Born</span>
              <span class="meta-value">${escapeHtml(data.birthday)}${!data.deathday && personAge(data.birthday) !== null ? ` (age ${personAge(data.birthday)})` : ''}${data.place_of_birth ? ` in ${escapeHtml(data.place_of_birth)}` : ''}</span>
            </div>
            ` : ''}
            ${data.deathday ? `
            <div class="meta-item">
              <span class="meta-label">Died</span>
              <span class="meta-value">${escapeHtml(data.deathday)}${personAge(data.birthday, data.deathday) !== null ? ` (aged ${personAge(data.birthday, data.deathday)})` : ''}</span>
            </div>
            ` : ''}
            ${(() => {
        const socials = personSocialLinks(data);
        if (!socials.length) return '';
        return `
              <div class="meta-item person-socials">
                <span class="meta-label">Socials</span>
                <span class="person-socials-links">
                  ${socials.map((s) => `<a class="person-social-link" href="${escapeAttribute(s.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.label)}</a>`).join('')}
                </span>
              </div>`;
      })()}
          </div>
        </div>
        <div class="person-profile-content">
          <h2 class="person-profile-name">${escapeHtml(data.name)}${(() => {
            const age = personAge(data.birthday, data.deathday);
            return age !== null ? ` <span class="person-profile-age">(${age})</span>` : '';
          })()}</h2>
          ${data.biography ? `
          <div class="person-biography-section">
            <h3>Biography</h3>
            <p class="person-biography-text" style="white-space: pre-wrap;">${escapeHtml(data.biography)}</p>
          </div>
          ` : '<p class="muted-copy">No biography available for this cast member.</p>'}
        </div>
        
        ${(() => {
      const seen = new Set();
      const addUnique = (list) => list.filter((img) => {
        if (!img.file_path || seen.has(img.file_path)) return false;
        seen.add(img.file_path);
        return true;
      });
      const profiles = addUnique(data.images?.profiles || []);
      // tagged_images are photos TMDB has tagged as featuring this person
      // (drop title posters so the gallery stays photos OF the person).
      const tagged = addUnique(
        (data.tagged_images?.results || []).filter((img) => img.image_type !== "poster")
      );
      const gallery = [...profiles, ...tagged].slice(0, 250);
      if (!gallery.length) return '';
      window._personPhotos = gallery.map((img) => tmdbProfile(img.file_path));
      return `
          <div class="person-photos-section" style="margin-top: 2rem;">
            <h3>Photos <span class="person-photos-count">${gallery.length}</span></h3>
            <div class="person-photos-grid">
              ${gallery.map((img, i) => `
                <img class="person-photo-thumb" src="${escapeAttribute(tmdbProfile(img.file_path))}" loading="lazy" alt="${escapeAttribute(data.name)}" data-photo-index="${i}" data-err="hide" />
              `).join('')}
            </div>
          </div>`;
    })()}

        <div class="person-credits-section" style="margin-top: 2rem;">
          <div class="person-credits-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-3); margin-bottom: var(--space-4); border-bottom: 1px solid var(--line-strong); padding-bottom: var(--space-3);">
            <h3 style="margin: 0;">Filmography (<span id="personCreditsCount">${castCredits.length}</span>)</h3>
            <div class="person-credits-controls" style="display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap;">
              <div class="pill-toggle-group" id="personCreditsFilterBtns">
                <button class="pill-toggle${state.personCreditsFilter === "movie" ? " active" : ""}" type="button" data-filter="movie">Movies</button>
                <button class="pill-toggle${state.personCreditsFilter === "tv" ? " active" : ""}" type="button" data-filter="tv">TV Shows</button>
              </div>
              <div class="pill-toggle-group" id="personCreditsSortBtns">
                <button class="pill-toggle${state.personCreditsSort === "popularity" ? " active" : ""}" type="button" data-sort="popularity">Popularity</button>
                <button class="pill-toggle${state.personCreditsSort === "date_desc" ? " active" : ""}" type="button" data-sort="date_desc">Newest</button>
                <button class="pill-toggle${state.personCreditsSort === "date_asc" ? " active" : ""}" type="button" data-sort="date_asc">Oldest</button>
              </div>
            </div>
          </div>
          <div class="person-credits-grid" id="personCreditsGrid">
            <div style="display: flex; justify-content: center; align-items: center; min-height: 100px; grid-column: 1 / -1;">
              <span style="color: var(--muted); font-size: 0.9rem;">Sorting filmography...</span>
            </div>
          </div>
        </div>
      </div>
    `;

    const filterBtns = root.querySelector("#personCreditsFilterBtns");
    const sortBtns = root.querySelector("#personCreditsSortBtns");
    const gridEl = root.querySelector("#personCreditsGrid");
    const countEl = root.querySelector("#personCreditsCount");

    const renderCreditCards = (credits) => {
      const libraryTvCredits = [];
      const html = credits.map(credit => {
        const isTv = credit.media_type === "tv";
        const title = credit.title || credit.name || "Untitled";
        const character = credit.character || "Unknown Character";
        const posterUrl = tmdbPoster(credit.poster_path) || '/favicon.svg';
        const dateStr = credit.release_date || credit.first_air_date || "";
        const year = dateStr ? `(${dateStr.split("-")[0]})` : "";

        let libItem = findLibraryItem(credit.media_type, credit.id, title, filmographyLookup);
        if (!libItem && credit.in_library) {
          if (isTv) {
            libItem = {
              type: "show",
              key: credit.library_key,
              item: {
                title: credit.show_title || title,
                episode_count: credit.watched_count,
              }
            };
          } else {
            libItem = {
              type: "movie",
              id: credit.library_id
            };
          }
        }

        const isInLibrary = !!credit.in_library;
        const isWatched = !!(credit.in_watch_history || credit.in_library ||
          (!isTv && filmographyLookup.allWatchedMovies.some(m => String(m.tmdb_id || "") === String(credit.id))) ||
          (isTv && filmographyLookup.allWatchedShows.some(s => String(s.tmdb_id || "") === String(credit.id))));

        if (libItem && isInLibrary) {
          const cachedTmdb = isTv ? resolvedTmdbCache("tv", credit.id, title) : null;
          const watchProgress = isTv ? libraryTvWatchProgress(libItem, cachedTmdb) : null;
          if (isTv) libraryTvCredits.push({ credit, libItem, title });
          const href = libItem.type === "tvshow" ? `/tvshow/${libItem.key}` : movieHref(movieBySlugOrId(libItem.id) || { id: libItem.id, title });
          return `
            <a class="person-credit-card in-library" href="${escapeAttribute(href)}" data-library-item-type="${libItem.type}" data-library-item-id="${escapeAttribute(libItem.id || libItem.key)}" data-library-item-title="${escapeAttribute(title)}">
              <img class="person-credit-poster" src="${escapeAttribute(posterUrl)}" alt="${escapeAttribute(title)}" loading="lazy" data-err="fav" />
              <div class="person-credit-info">
                <span class="person-credit-title" title="${escapeAttribute(title)}">${escapeHtml(title)} ${escapeHtml(year)}</span>
                <span class="person-credit-character" title="${escapeAttribute(character)}">as ${escapeHtml(character)}</span>
                <span class="person-credit-badges">
                  <span class="library-badge">In Library</span>
                  ${isTv ? personWatchBadgeMarkup(watchProgress, credit.id) : `<span class="watch-state-badge is-complete">Watched</span>`}
                </span>
              </div>
            </a>
          `;
        } else if (libItem && isWatched) {
          const cachedTmdb = isTv ? resolvedTmdbCache("tv", credit.id, title) : null;
          const watchProgress = isTv ? libraryTvWatchProgress(libItem, cachedTmdb) : null;
          if (isTv) libraryTvCredits.push({ credit, libItem, title });
          const href = libItem.type === "tvshow" ? `/tvshow/${libItem.key}` : movieHref(movieBySlugOrId(libItem.id) || { id: libItem.id, title });
          return `
            <a class="person-credit-card in-library" href="${escapeAttribute(href)}" data-library-item-type="${libItem.type}" data-library-item-id="${escapeAttribute(libItem.id || libItem.key)}" data-library-item-title="${escapeAttribute(title)}">
              <img class="person-credit-poster" src="${escapeAttribute(posterUrl)}" alt="${escapeAttribute(title)}" loading="lazy" data-err="fav" />
              <div class="person-credit-info">
                <span class="person-credit-title" title="${escapeAttribute(title)}">${escapeHtml(title)} ${escapeHtml(year)}</span>
                <span class="person-credit-character" title="${escapeAttribute(character)}">as ${escapeHtml(character)}</span>
                <span class="person-credit-badges">
                  ${isTv ? personWatchBadgeMarkup(watchProgress, credit.id) : `<span class="watch-state-badge is-complete">Watched</span>`}
                </span>
              </div>
            </a>
          `;
        } else {
          const href = isTv ? `/tvshow/tmdb/${credit.id}` : `/movie/tmdb/${credit.id}`;
          return `
            <a class="person-credit-card" href="${escapeAttribute(href)}" data-tmdb-id="${credit.id}" data-tmdb-media-type="${credit.media_type}" data-tmdb-title="${escapeAttribute(title)}">
              <img class="person-credit-poster" src="${escapeAttribute(posterUrl)}" alt="${escapeAttribute(title)}" loading="lazy" data-err="fav" />
              <div class="person-credit-info">
                <span class="person-credit-title" title="${escapeAttribute(title)}">${escapeHtml(title)} ${escapeHtml(year)}</span>
                <span class="person-credit-character" title="${escapeAttribute(character)}">as ${escapeHtml(character)}</span>
              </div>
            </a>
          `;
        }
      }).join("");
      return { html, libraryTvCredits };
    };

    const updateGrid = (resetVisible = true) => {
      if (resetVisible) {
        state.personCreditsVisible = FILMOGRAPHY_PAGE_SIZE;
      }

      let filtered = [...castCredits];
      if (state.personCreditsFilter === "movie") {
        filtered = filtered.filter(c => c.media_type === "movie");
      } else if (state.personCreditsFilter === "tv") {
        filtered = filtered.filter(c => c.media_type === "tv");
      }

      if (state.personCreditsSort === "popularity") {
        filtered.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
      } else if (state.personCreditsSort === "date_desc") {
        filtered.sort((a, b) => {
          const dateA = a.release_date || a.first_air_date || "";
          const dateB = b.release_date || b.first_air_date || "";
          if (!dateA) return 1;
          if (!dateB) return -1;
          return dateB.localeCompare(dateA);
        });
      } else if (state.personCreditsSort === "date_asc") {
        filtered.sort((a, b) => {
          const dateA = a.release_date || a.first_air_date || "";
          const dateB = b.release_date || b.first_air_date || "";
          if (!dateA) return 1;
          if (!dateB) return -1;
          return dateA.localeCompare(dateB);
        });
      }

      countEl.textContent = filtered.length;

      if (getFilmographyObserver()) { getFilmographyObserver().disconnect(); setFilmographyObserver(null); }

      if (filtered.length === 0) {
        gridEl.innerHTML = `<p class="muted-copy" style="grid-column: 1 / -1; text-align: center; padding: 2rem 0;">No matching filmography items found.</p>`;
        return;
      }

      const visibleCount = Math.min(state.personCreditsVisible, filtered.length);
      const page = filtered.slice(0, visibleCount);
      const hasMore = filtered.length > visibleCount;

      const { html, libraryTvCredits } = renderCreditCards(page);
      gridEl.innerHTML = html + (hasMore ? `<div class="filmography-load-sentinel" aria-hidden="true"></div>` : "");

      if (libraryTvCredits.length > 0) {
        hydratePersonFilmographyWatchStatuses(personId, libraryTvCredits);
      }

      if (hasMore) {
        const sentinel = gridEl.querySelector(".filmography-load-sentinel");
        if (sentinel) {
          setFilmographyObserver(new IntersectionObserver(([entry]) => {
            if (!entry.isIntersecting) return;
            state.personCreditsVisible += FILMOGRAPHY_PAGE_SIZE;
            updateGrid(false);
          }, { rootMargin: "600px" }));
          getFilmographyObserver().observe(sentinel);
        }
      }
    };

    filterBtns?.addEventListener("click", (e) => {
      const btn = e.target.closest(".pill-toggle[data-filter]");
      if (!btn) return;
      const val = btn.dataset.filter;
      state.personCreditsFilter = state.personCreditsFilter === val ? "all" : val;
      filterBtns.querySelectorAll(".pill-toggle").forEach(b => b.classList.toggle("active", b.dataset.filter === state.personCreditsFilter));
      updateGrid();
    });

    sortBtns?.addEventListener("click", (e) => {
      const btn = e.target.closest(".pill-toggle[data-sort]");
      if (!btn) return;
      state.personCreditsSort = btn.dataset.sort;
      sortBtns.querySelectorAll(".pill-toggle").forEach(b => b.classList.toggle("active", b.dataset.sort === state.personCreditsSort));
      updateGrid();
    });

    // Initial render of the grid
    updateGrid();

  } catch (err) {
    root.innerHTML = `
      <div style="display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 200px; gap: 1rem;">
        <span class="status-pill status-error" style="font-size: 1rem; padding: var(--space-2) var(--space-4);">Failed to load profile</span>
        <span style="color: var(--muted);">${escapeHtml(err.message)}</span>
      </div>
    `;
  }
}

window.openLibraryItem = function (mediaType, idOrKey, title, isLibraryItem = true, tmdbId = null) {
  const modal = elements.personModal;
  if (modal) modal.classList.add("hidden");

  if (isLibraryItem) {
    if (mediaType === "show" || mediaType === "tv") {
      navigateTo(`/tvshow/${idOrKey}`);
    } else if (mediaType === "movie") {
      navigateTo(movieHref(movieBySlugOrId(idOrKey) || { id: idOrKey, title }));
    }
  } else {
    if (mediaType === "show" || mediaType === "tv") {
      navigateTo(`/tvshow/tmdb/${tmdbId}`);
    } else if (mediaType === "movie") {
      navigateTo(`/movie/tmdb/${tmdbId}`);
    }
  }

  if (elements.debugModal && elements.debugModal.classList.contains("hidden")) {
    document.body.style.overflow = "";
  }
};

export function findLibraryItem(mediaType, tmdbId, title, filmographyLookup = null) {
  const cleanTitle = slug(title);
  if (mediaType === "tv" || mediaType === "show") {
    // Check the full server-fetched list first (filmography page), then fall back
    // to the in-memory explorer state which may be only partially loaded.
    let found = (filmographyLookup?.allWatchedShows || []).find(
      s => String(s.tmdb_id || "") === String(tmdbId) || slug(s.title) === cleanTitle
    );
    if (!found) {
      found = state.showsRaw.find(s => String(s.tmdb_id || "") === String(tmdbId) || slug(s.title) === cleanTitle);
    }
    if (!found) {
      const historyRows = state.history.filter(h => h.media_type === "episode" && isWatchedHistoryAction(h) && (
        String(h.tmdb_id || "") === String(tmdbId) || slug(h.show_title || showTitleFrom(h.title)) === cleanTitle
      ));
      if (historyRows.length) {
        const histRow = historyRows[0];
        found = {
          title: histRow.show_title || showTitleFrom(histRow.title),
          id: histRow.tvdb_id || histRow.tmdb_id || histRow.show_title,
          tmdb_id: histRow.tmdb_id || tmdbId,
          episodes: historyRows,
          episode_count: new Set(historyRows.map((row) => showEpisodeKey(row.season, row.episode))).size,
        };
      }
    }
    return found ? { type: "show", key: slug(found.title), item: found } : null;
  } else {
    // Check the full server-fetched movies list first, then the partially-loaded explorer.
    let found = (filmographyLookup?.allWatchedMovies || []).find(
      m => String(m.tmdb_id || "") === String(tmdbId) || slug(m.title) === cleanTitle
    );
    if (!found) {
      found = state.moviesRaw.find(m => String(m.tmdb_id) === String(tmdbId) || slug(m.title) === cleanTitle);
    }
    if (!found) {
      found = state.history.find(h => h.media_type === "movie" && (String(h.tmdb_id) === String(tmdbId) || slug(h.title) === cleanTitle));
    }
    return found ? { type: "movie", id: found.id } : null;
  }
}

export function libraryTvWatchProgress(libItem, tmdbData = null) {
  const show = libItem?.item || {};
  const watchedKeys = new Set();
  for (const episode of show.episodes || []) {
    if (!isWatchedHistoryAction(episode)) continue;
    if (Number(episode.season || 0) <= 0) continue;
    watchedKeys.add(showEpisodeKey(episode.season, episode.episode));
  }
  const watched = watchedKeys.size || Number(show.episode_count || 0);
  const total = show.total_episodes || Number(tmdbData?.number_of_episodes || 0);
  return {
    watched,
    total,
    complete: total > 0 && watched >= total,
  };
}

export function personWatchBadgeMarkup(progress, tmdbId) {
  if (!progress?.watched) return "";
  const label = progress.complete ? "Watched" : "Part watched";
  const count = progress.total > 0 ? `${Number(progress.watched)}/${Number(progress.total)}` : `${Number(progress.watched)} ep`;
  return `<span class="watch-state-badge ${progress.complete ? "is-complete" : "is-partial"}" data-person-watch-status="${escapeAttribute(tmdbId)}">${escapeHtml(label)} <small>${escapeHtml(count)}</small></span>`;
}

export async function hydratePersonFilmographyWatchStatuses(personId, credits = []) {
  await Promise.all(credits.map(async ({ credit, libItem, title }) => {
    const tmdbData = await fetchTmdbDetails("tv", credit.id, title);
    if (window.location.pathname !== `/person/${personId}`) return;
    const progress = libraryTvWatchProgress(libItem, tmdbData);
    document.querySelectorAll(`[data-person-watch-status="${CSS.escape(String(credit.id))}"]`).forEach((badge) => {
      badge.className = `watch-state-badge ${progress.complete ? "is-complete" : "is-partial"}`;
      const label = progress.complete ? "Watched" : "Part watched";
      const count = progress.total > 0 ? `${Number(progress.watched)}/${Number(progress.total)}` : `${Number(progress.watched)} ep`;
      badge.innerHTML = `${escapeHtml(label)} <small>${escapeHtml(count)}</small>`;
    });
  }));
}
