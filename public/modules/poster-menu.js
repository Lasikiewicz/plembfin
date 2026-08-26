// Builds and positions the dropdown for the poster three-dot overflow button
// (see `posterOverflowMenu` in images.js). The dropdown is appended to
// <body> rather than nested under the button, because the poster wrappers
// it hovers over are small and clip overflow, and because the button itself
// usually sits inside an <a> card - portaling the menu items out of that
// anchor means clicking them never triggers card navigation.

let openMenu = null; // { dropdown, button }

function closeOpenMenu() {
  if (!openMenu) return;
  openMenu.button.setAttribute("aria-expanded", "false");
  openMenu.button.classList.remove("is-open");
  openMenu.dropdown.remove();
  openMenu = null;
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

function buildDropdown(button) {
  const d = button.dataset;
  const dropdown = document.createElement("div");
  dropdown.className = "poster-overflow-dropdown";
  dropdown.setAttribute("role", "menu");

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
    const toggle = event.target.closest(".poster-overflow-btn");
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
      openMenu = { dropdown, button: toggle };
      return;
    }

    if (!openMenu) return;
    if (event.target.closest(".poster-overflow-dropdown") === openMenu.dropdown) {
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

  window.addEventListener("resize", closeOpenMenu);
  // Any scroll (including a card row's own horizontal scroll container)
  // invalidates the button's captured position, so close rather than drift.
  document.addEventListener("scroll", closeOpenMenu, true);
}
