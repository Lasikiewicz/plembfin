import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Posters only on the library and media pages: a clicked poster opens its
// card in place (public/modules/page-card-open.js, theme-styles step 13).

const read = (file) => fs.readFileSync(path.resolve(import.meta.dirname, "..", file), "utf8");

function fakeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...names) => names.forEach((name) => set.add(name)),
    remove: (...names) => names.forEach((name) => set.delete(name)),
    contains: (name) => set.has(name),
    toggle: (name, force) => {
      const on = force ?? !set.has(name);
      if (on) set.add(name);
      else set.delete(name);
      return on;
    },
  };
}

const listeners = [];
const allItems = [];
globalThis.requestAnimationFrame = () => 0;
globalThis.getComputedStyle = () => ({ display: "flex" });
globalThis.document = {
  addEventListener: (type, handler, capture) => listeners.push({ type, handler, capture: Boolean(capture) }),
  querySelector: () => null,
  querySelectorAll: (selector) => (selector === ".page-card-open" ? allItems.filter((item) => item.classList.contains("page-card-open")) : []),
};

await import("../public/modules/page-card-open.js");

function makePanel(compact) {
  const panel = { dataset: { viewPanel: "discover" }, classList: fakeClassList(compact ? ["page-card-mode-compact"] : []) };
  const container = { className: "discover-feed-row", children: [] };
  container.parentElement = panel;
  panel.querySelectorAll = () => [container];
  return { panel, container };
}

function makeItem({ panel, container }, id) {
  const item = {
    dataset: {},
    classList: fakeClassList(["shared-media-card"]),
    parentElement: container,
    getAttribute: () => null,
    querySelector: () => ({ getAttribute: () => `/movie/${id}` }),
    closest: (selector) => {
      if (selector.includes("data-view-panel")) return panel;
      if (selector.includes("discover-feed-row") && !selector.includes(">")) return container;
      return null;
    },
    matches: () => true,
    offsetWidth: 160,
  };
  container.children.push(item);
  allItems.push(item);
  return item;
}

function click(target, { onButton = false, onToggle = false } = {}) {
  const event = {
    target: {
      closest: (selector) => {
        if (selector === "button") return onButton ? {} : null;
        if (selector === "[data-card-mode-toggle]") return onToggle ? {} : null;
        return onToggle ? null : target;
      },
    },
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  };
  for (const listener of listeners.filter((entry) => entry.type === "click" && entry.capture)) listener.handler(event);
  for (const listener of listeners.filter((entry) => entry.type === "click" && !entry.capture)) listener.handler(event);
  return event;
}

test("clicking a folded poster opens its card and closes the one that was open", () => {
  const row = makePanel(true);
  const first = makeItem(row, 1);
  const second = makeItem(row, 2);

  const event = click(first);
  assert.equal(event.defaultPrevented, true, "the first click must not follow the poster's link");
  assert.equal(event.propagationStopped, true);
  assert.equal(first.classList.contains("page-card-open"), true);

  click(second);
  assert.equal(first.classList.contains("page-card-open"), false);
  assert.equal(second.classList.contains("page-card-open"), true);

  const again = click(second);
  assert.equal(again.defaultPrevented, false, "a click on the open card behaves as normal");
  assert.equal(second.classList.contains("page-card-open"), true);
});

test("full cards, poster buttons and the Posters only switch are left alone", () => {
  const full = makePanel(false);
  const item = makeItem(full, 3);
  assert.equal(click(item).defaultPrevented, false);
  assert.equal(item.classList.contains("page-card-open"), false);

  const row = makePanel(true);
  const poster = makeItem(row, 4);
  assert.equal(click(poster, { onButton: true }).defaultPrevented, false, "the poster's menu button still works");
  assert.equal(poster.classList.contains("page-card-open"), false);

  click(poster);
  assert.equal(poster.classList.contains("page-card-open"), true);
  click(poster, { onToggle: true });
  assert.equal(poster.classList.contains("page-card-open"), false, "switching Posters only folds the open card");

  const stack = makeItem(row, 5);
  stack.dataset.playlistStack = "episode:tmdb:5:s1e1";
  assert.equal(click(stack).defaultPrevented, false, "a playlist episode stack expands instead (playlists.js)");
  assert.equal(stack.classList.contains("page-card-open"), false);
});

test("every page with the Posters only switch loads the behaviour", () => {
  assert.match(read("public/modules/media-card.js"), /import "\.\/page-card-open\.js\?v=/);
  assert.match(read("public/modules/dashboard-modern.js"), /import "\.\/page-card-open\.js\?v=/);
  const source = read("public/modules/page-card-open.js");
  for (const panel of ["explorer", "discover", "personal-media", "history"]) {
    assert.ok(source.includes(`[data-view-panel="${panel}"]`), `${panel} panel missing`);
  }
});

test("poster-mode rules that fold an item skip the open one", () => {
  const css = read("public/styles.css");
  const hides = [
    ".page-card-mode-compact :is(.discover-feed-row, .personal-media-card-grid, .personal-media-list-row) > .shared-media-card:not(.page-card-open) .shared-media-card-body",
    ".page-card-mode-compact .history-list .history-page-card:not(.page-card-open) > .history-card-details",
    ".page-card-mode-compact .explorer-list-card:not(.page-card-open) > :not(.list-thumb-poster)",
    ".page-card-mode-compact .history-table-view .history-list-row:not(.page-card-open) > :not(.history-list-poster)",
    ".page-card-mode-compact .explorer-overview-card:not(.page-card-open) > .overview-card-meta",
  ];
  for (const selector of hides) assert.ok(css.includes(selector), `missing: ${selector}`);
  // No rule may still hide card bodies or details for every item in poster mode.
  assert.doesNotMatch(css, /page-card-mode-compact[^{]*\.shared-media-card--(?:discover|personal) \.shared-media-card-body/);
  assert.doesNotMatch(css, /page-card-mode-compact[^{]*\.explorer-history-card > \.history-card-details/);
  assert.match(css, /\.page-card-open-full\) \{\s*grid-column: 1 \/ -1;/);
});
