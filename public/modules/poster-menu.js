// Builds and positions the dropdown for the poster three-dot overflow button
// (see `posterOverflowMenu` in images.js). The dropdown is appended to
// <body> rather than nested under the button, because the poster wrappers
// it hovers over are small and clip overflow, and because the button itself
// usually sits inside an <a> card - portaling the menu items out of that
// anchor means clicking them never triggers card navigation.

import { state } from "./state.js";
import { customListsForPersonalItem, isPersonalWatchlisted, personalItemFromPosterMenuDataset } from "./personal-media.js?v=20260831r";

let openMenu = null; // { dropdown, button, submenu, submenuTrigger, actionPending, keepOpen, actionButton }

function closeSubmenu() {
  if (!openMenu?.submenu) return;
  openMenu.submenu.remove();
  openMenu.submenuTrigger?.setAttribute("aria-expanded", "false");
  openMenu.submenu = null;
  openMenu.submenuTrigger = null;
}

function closeOpenMenu() {
  if (!openMenu) return;
  closeSubmenu();
  openMenu.button.setAttribute("aria-expanded", "false");
  openMenu.button.classList.remove("is-open");
  openMenu.dropdown.remove();
  openMenu = null;
}

export function closePosterOverflowMenu() {
  closeOpenMenu();
}

export function setPosterOverflowMenuActionPending(button, pending) {
  if (!openMenu) return;
  if (button && openMenu.actionButton && openMenu.actionButton !== button) return;
  if (pending) {
    openMenu.actionPending = true;
    openMenu.keepOpen = true;
    openMenu.actionButton = button || openMenu.actionButton || null;
    return;
  }
  if (!button || openMenu.actionButton === button) {
    openMenu.actionPending = false;
    openMenu.actionButton = null;
  }
}

function menuItem(className, label, dataset) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `poster-overflow-item ${className}`.trim();
  btn.setAttribute("role", "menuitem");
  btn.textContent = label;
  for (const [key, value] of Object.entries(dataset)) {
    if (value) btn.dataset[key] = value;
  }
  return btn;
}

function ratingDataset(d, overrides = {}) {
  return {
    mediaRate: "1",
    mediaRateMediaType: overrides.mediaRateMediaType || d.posterMenuRatingMediaType || d.posterMenuMediaType || "movie",
    mediaRateTmdbId: overrides.mediaRateTmdbId || d.posterMenuRatingTmdbId || "",
    mediaRateTvdbId: overrides.mediaRateTvdbId || d.posterMenuRatingTvdbId || "",
    mediaRateImdbId: overrides.mediaRateImdbId || d.posterMenuRatingImdbId || "",
    mediaRateShowTmdbId: overrides.mediaRateShowTmdbId || d.posterMenuRatingShowTmdbId || "",
    mediaRateShowTvdbId: overrides.mediaRateShowTvdbId || d.posterMenuRatingShowTvdbId || "",
    mediaRateShowImdbId: overrides.mediaRateShowImdbId || d.posterMenuRatingShowImdbId || "",
    mediaRateTitle: overrides.mediaRateTitle || d.posterMenuRatingTitle || d.posterMenuShowTitle || d.posterMenuTitle || "Untitled",
    mediaRateShowTitle: overrides.mediaRateShowTitle || d.posterMenuRatingShowTitle || "",
    mediaRateSeason: overrides.mediaRateSeason || d.posterMenuRatingSeason || "",
    mediaRateEpisode: overrides.mediaRateEpisode || d.posterMenuRatingEpisode || "",
    mediaRatePosterUrl: overrides.mediaRatePosterUrl || d.posterMenuRatingPosterUrl || "",
    mediaRateReleaseDate: overrides.mediaRateReleaseDate || d.posterMenuRatingReleaseDate || "",
  };
}

function personalDataset(d) {
  return {
    posterMenuRatingMediaType: d.posterMenuRatingMediaType || d.posterMenuMediaType || "movie",
    posterMenuRatingTmdbId: d.posterMenuRatingTmdbId || "",
    posterMenuRatingTvdbId: d.posterMenuRatingTvdbId || "",
    posterMenuRatingImdbId: d.posterMenuRatingImdbId || "",
    posterMenuRatingShowTmdbId: d.posterMenuRatingShowTmdbId || "",
    posterMenuRatingShowTvdbId: d.posterMenuRatingShowTvdbId || "",
    posterMenuRatingShowImdbId: d.posterMenuRatingShowImdbId || "",
    posterMenuRatingTitle: d.posterMenuRatingTitle || d.posterMenuTitle || "Untitled",
    posterMenuRatingShowTitle: d.posterMenuRatingShowTitle || d.posterMenuShowTitle || "",
    posterMenuRatingSeason: d.posterMenuRatingSeason || "",
    posterMenuRatingEpisode: d.posterMenuRatingEpisode || "",
    posterMenuRatingPosterUrl: d.posterMenuRatingPosterUrl || "",
    posterMenuRatingReleaseDate: d.posterMenuRatingReleaseDate || "",
    posterMenuKind: d.posterMenuKind || "",
    posterMenuMode: d.posterMenuMode || "",
    posterMenuShowTitle: d.posterMenuShowTitle || "",
    posterMenuTitle: d.posterMenuTitle || "",
    posterMenuUpNextShowTitle: d.posterMenuUpNextShowTitle || "",
    posterMenuUpNextTmdbId: d.posterMenuUpNextTmdbId || "",
    posterMenuUpNextTvdbId: d.posterMenuUpNextTvdbId || "",
    posterMenuUpNextSeason: d.posterMenuUpNextSeason || "",
    posterMenuUpNextEpisode: d.posterMenuUpNextEpisode || "",
    posterMenuUpNextPosterUrl: d.posterMenuUpNextPosterUrl || "",
    posterMenuDiscoverTitle: d.posterMenuDiscoverTitle || "",
    posterMenuDiscoverImdbId: d.posterMenuDiscoverImdbId || "",
    posterMenuDiscoverPosterUrl: d.posterMenuDiscoverPosterUrl || "",
    posterMenuDiscoverReleaseDate: d.posterMenuDiscoverReleaseDate || "",
  };
}

function isWatchlisted(d) {
  const item = personalItemFromPosterMenuDataset(d);
  return isPersonalWatchlisted(item)
    || d.posterMenuDiscoverWatchlisted === "true";
}

function buildCustomListSubmenu(trigger) {
  const submenu = document.createElement("div");
  submenu.className = "poster-overflow-submenu";
  submenu.setAttribute("role", "menu");
  submenu.setAttribute("aria-label", "Custom lists");
  const lists = Array.isArray(state.personalLists) ? state.personalLists : [];
  const dataset = personalDataset(trigger.dataset);
  const item = personalItemFromPosterMenuDataset(trigger.dataset);
  const listIds = new Set(customListsForPersonalItem(item).map((list) => String(list.id)));

  if (!lists.length) {
    const empty = document.createElement("div");
    empty.className = "poster-overflow-submenu-empty";
    empty.setAttribute("role", "presentation");
    empty.textContent = "No custom lists yet";
    submenu.appendChild(empty);
  } else {
    for (const list of lists) {
      const listName = list.name || "Untitled list";
      const alreadyAdded = listIds.has(String(list.id));
      const action = alreadyAdded ? "remove" : "add";
      const listButton = menuItem("", alreadyAdded ? `Remove from ${listName}` : listName, {
        posterMenuListId: String(list.id || ""),
        posterMenuListAction: action,
        posterMenuListName: listName,
        ...dataset,
      });
      listButton.title = alreadyAdded ? `Remove from ${listName}` : `Add to ${listName}`;
      submenu.appendChild(listButton);
    }
  }

  submenu.appendChild(menuItem("poster-overflow-item-create", "Create a new list", {
    posterMenuCreateList: "1",
    ...dataset,
  }));
  return submenu;
}

function positionSubmenu(submenu, trigger) {
  submenu.style.position = "absolute";
  submenu.style.visibility = "hidden";
  document.body.appendChild(submenu);
  const triggerRect = trigger.getBoundingClientRect();
  const submenuRect = submenu.getBoundingClientRect();
  const viewportLeft = window.scrollX;
  const viewportRight = viewportLeft + window.innerWidth;
  const viewportTop = window.scrollY;
  const viewportBottom = viewportTop + window.innerHeight;
  const gutter = 4;
  const edge = 8;
  let left = triggerRect.right + window.scrollX + gutter;
  if (left + submenuRect.width > viewportRight - edge) {
    left = triggerRect.left + window.scrollX - submenuRect.width - gutter;
  }
  const maxLeft = Math.max(viewportLeft + edge, viewportRight - submenuRect.width - edge);
  left = Math.max(viewportLeft + edge, Math.min(left, maxLeft));
  let top = triggerRect.top + window.scrollY;
  const maxTop = Math.max(viewportTop + edge, viewportBottom - submenuRect.height - edge);
  top = Math.max(viewportTop + edge, Math.min(top, maxTop));
  submenu.style.left = `${left}px`;
  submenu.style.top = `${top}px`;
  submenu.style.visibility = "visible";
}

function toggleCustomListSubmenu(trigger) {
  if (!openMenu) return;
  if (openMenu.submenuTrigger === trigger) {
    closeSubmenu();
    return;
  }
  closeSubmenu();
  const submenu = buildCustomListSubmenu(trigger);
  positionSubmenu(submenu, trigger);
  trigger.setAttribute("aria-expanded", "true");
  openMenu.submenu = submenu;
  openMenu.submenuTrigger = trigger;
}

function deferCloseAfterAction() {
  const menu = openMenu;
  window.setTimeout(() => {
    if (openMenu === menu) closeOpenMenu();
  }, 0);
}

function appendPersonalMenuActions(dropdown, button) {
  const d = button.dataset;
  const personal = personalDataset(d);
  const watchlisted = isWatchlisted(d);
  dropdown.appendChild(menuItem("", watchlisted ? "Remove from watch list" : "Add to watch list", {
    posterMenuWatchlist: watchlisted ? "remove" : "add",
    ...personal,
  }));
  const listTrigger = menuItem("poster-overflow-item-has-submenu", "Add to Custom list", {
    posterMenuCustomList: "1",
    ...personal,
  });
  listTrigger.setAttribute("aria-haspopup", "true");
  listTrigger.setAttribute("aria-expanded", "false");
  dropdown.appendChild(listTrigger);
}

function buildDropdown(button) {
  const d = button.dataset;
  const dropdown = document.createElement("div");
  dropdown.className = "poster-overflow-dropdown";
  dropdown.setAttribute("role", "menu");

  if (d.posterMenuMode === "personal") {
    appendPersonalMenuActions(dropdown, button);
    return dropdown;
  }

  if (d.posterMenuMode === "up-next") {
    dropdown.appendChild(menuItem("", "Mark watched", {
      upNextMenuWatch: d.posterMenuUpNextWatch || d.posterMenuId || "",
      season: d.posterMenuUpNextSeason || "",
      episode: d.posterMenuUpNextEpisode || "",
      showTitle: d.posterMenuUpNextShowTitle || d.posterMenuTitle || "",
      tmdbId: d.posterMenuUpNextTmdbId || "",
      tvdbId: d.posterMenuUpNextTvdbId || "",
      episodeTitle: d.posterMenuUpNextEpisodeTitle || "",
      airDate: d.posterMenuUpNextAirDate || "",
      posterUrl: d.posterMenuUpNextPosterUrl || "",
    }));
    const showTitle = d.posterMenuUpNextShowTitle || d.posterMenuTitle || "";
    dropdown.appendChild(menuItem("", "Rate", ratingDataset(d, {
      mediaRateMediaType: "episode",
      mediaRateTmdbId: d.posterMenuUpNextTmdbId || "",
      mediaRateTvdbId: d.posterMenuUpNextTvdbId || "",
      mediaRateShowTmdbId: d.posterMenuUpNextTmdbId || "",
      mediaRateShowTvdbId: d.posterMenuUpNextTvdbId || "",
      mediaRateTitle: d.posterMenuUpNextEpisodeTitle || showTitle || "Untitled",
      mediaRateShowTitle: showTitle,
      mediaRateSeason: d.posterMenuUpNextSeason || "",
      mediaRateEpisode: d.posterMenuUpNextEpisode || "",
      mediaRatePosterUrl: d.posterMenuUpNextPosterUrl || "",
      mediaRateReleaseDate: d.posterMenuUpNextAirDate || "",
    })));
    appendPersonalMenuActions(dropdown, button);
    dropdown.appendChild(menuItem("poster-overflow-item-danger", "Remove from up next", {
      upNextRemove: d.posterMenuUpNextWatch || d.posterMenuId || "",
      upNextShowTitle: d.posterMenuUpNextShowTitle || d.posterMenuTitle || "",
      upNextTmdbId: d.posterMenuUpNextTmdbId || "",
      upNextTvdbId: d.posterMenuUpNextTvdbId || "",
      upNextSeason: d.posterMenuUpNextSeason || "",
      upNextEpisode: d.posterMenuUpNextEpisode || "",
      upNextEpisodeTitle: d.posterMenuUpNextEpisodeTitle || "",
      upNextAirDate: d.posterMenuUpNextAirDate || "",
    }));
    return dropdown;
  }

  if (d.posterMenuMode === "discover") {
    const discoverItem = {
      discoverMediaType: d.posterMenuDiscoverMediaType || "movie",
      discoverTmdbId: d.posterMenuDiscoverTmdbId || "",
      discoverTvdbId: d.posterMenuDiscoverTvdbId || "",
      discoverImdbId: d.posterMenuDiscoverImdbId || "",
      discoverTitle: d.posterMenuDiscoverTitle || d.posterMenuTitle || "",
      discoverPosterUrl: d.posterMenuDiscoverPosterUrl || "",
      discoverReleaseDate: d.posterMenuDiscoverReleaseDate || "",
    };
    dropdown.appendChild(menuItem("", "Mark watched", {
      discoverMarkWatched: "1",
      ...discoverItem,
    }));
    dropdown.appendChild(menuItem("", "Request on Seerr", {
      discoverSeerrRequest: "1",
      seerrMediaType: discoverItem.discoverMediaType,
      seerrMediaId: discoverItem.discoverTmdbId,
      ...discoverItem,
    }));
    dropdown.appendChild(menuItem("", "Rate", {
      discoverRate: "1",
      ...discoverItem,
    }));
    appendPersonalMenuActions(dropdown, button);
    return dropdown;
  }

  dropdown.appendChild(menuItem("media-edit-date-btn", "Edit watch date", {
    editId: d.posterMenuId,
    watchedAt: d.posterMenuWatchedAt || "",
  }));
  dropdown.appendChild(menuItem("media-fix-match-btn", "Fix match", {
    editId: d.posterMenuId,
    title: d.posterMenuTitle || "",
    mediaType: d.posterMenuMediaType || "movie",
    gridOrigin: d.posterMenuGrid || "",
  }));
  dropdown.appendChild(menuItem("", "Rate", ratingDataset(d)));
  appendPersonalMenuActions(dropdown, button);
  dropdown.appendChild(menuItem("poster-overflow-item-danger", "Mark unwatched", {
    unwatchId: d.posterMenuId,
    unwatchKind: d.posterMenuKind || "item",
    unwatchLabel: d.posterMenuLabel || "",
    showTitle: d.posterMenuShowTitle || "",
    gridOrigin: d.posterMenuGrid || "",
  }));

  return dropdown;
}

function positionDropdown(dropdown, button) {
  // Set position: absolute (and hide) before appending/measuring - body is a
  // flex column with stretch-aligned children, so an in-flow flex item would
  // measure at the full body width instead of its own compact width, which
  // throws off the right-edge clamp below and pins the menu to the left.
  dropdown.style.position = "absolute";
  dropdown.style.visibility = "hidden";
  document.body.appendChild(dropdown);
  const rect = button.getBoundingClientRect();
  const dropdownRect = dropdown.getBoundingClientRect();
  // Open below and to the right of the button, clamped so it never runs off
  // the right edge of the page.
  const maxLeft = document.documentElement.scrollWidth - dropdownRect.width - 8;
  const left = Math.min(
    Math.max(8, rect.left + window.scrollX),
    Math.max(8, maxLeft),
  );
  const top = rect.bottom + window.scrollY + 4;
  dropdown.style.left = `${left}px`;
  dropdown.style.top = `${top}px`;
  dropdown.style.visibility = "visible";
}

export function initPosterOverflowMenu() {
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const toggle = target?.closest(".poster-overflow-btn");
    if (toggle) {
      event.preventDefault();
      event.stopPropagation();
      const reopening = openMenu?.button === toggle;
      closeOpenMenu();
      if (reopening) return;
      const dropdown = buildDropdown(toggle);
      positionDropdown(dropdown, toggle);
      toggle.setAttribute("aria-expanded", "true");
      toggle.classList.add("is-open");
      openMenu = { dropdown, button: toggle, submenu: null, submenuTrigger: null, actionPending: false, keepOpen: false, actionButton: null };
      return;
    }

    if (!openMenu) return;
    const submenuTrigger = target?.closest("[data-poster-menu-custom-list]");
    if (submenuTrigger && submenuTrigger.closest(".poster-overflow-dropdown") === openMenu.dropdown) {
      event.preventDefault();
      event.stopPropagation();
      toggleCustomListSubmenu(submenuTrigger);
      return;
    }

    if (openMenu.submenu && target?.closest(".poster-overflow-submenu") === openMenu.submenu) {
      if (target.closest("[data-poster-menu-list-id]")) {
        // The app-level delegated handler performs the request and keeps the
        // menu open while the selected list item changes to Saving…/Added.
        setPosterOverflowMenuActionPending(target.closest("[data-poster-menu-list-id]"), true);
        return;
      }
      if (target.closest("[data-poster-menu-create-list]")) {
        // The app-level delegated handler opens a dialog. Defer this cleanup
        // so that handler can still read the portaled button dataset.
        deferCloseAfterAction();
        return;
      }
      closeOpenMenu();
      return;
    }

    if (target?.closest(".poster-overflow-dropdown") === openMenu.dropdown) {
      const watchlistAction = target.closest("[data-poster-menu-watchlist]");
      if (watchlistAction) {
        // The app-level delegated handler performs the request and keeps the
        // menu open while the action changes to Saving…/Added or Removing…/Removed.
        setPosterOverflowMenuActionPending(watchlistAction, true);
        return;
      }
      // A menu item - let the delegated action handlers (edit date / fix
      // match / mark unwatched) act on the click, then close the menu.
      closeOpenMenu();
      return;
    }
    closeOpenMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && openMenu) closeOpenMenu();
  });

  const closeMenuOnViewportChange = () => {
    if (openMenu?.actionPending || openMenu?.keepOpen) return;
    closeOpenMenu();
  };
  window.addEventListener("resize", closeMenuOnViewportChange);
  // Any scroll (including a card row's own horizontal scroll container)
  // invalidates the button's captured position, so close rather than drift.
  document.addEventListener("scroll", closeMenuOnViewportChange, true);
}
