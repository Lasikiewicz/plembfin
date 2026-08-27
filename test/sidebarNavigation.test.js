import test from "node:test";
import assert from "node:assert/strict";

import { sidebarNavigationPath } from "../public/modules/sidebar-navigation.js";

function target({ id = "", view = "", explorerNav = "", settingsPath = "" } = {}) {
  return { id, dataset: { view, explorerNav, settingsPath } };
}

test("sidebar primary destinations resolve to browser-friendly paths", () => {
  assert.equal(sidebarNavigationPath(target({ view: "dashboard" })), "/");
  assert.equal(sidebarNavigationPath(target({ view: "explorer", explorerNav: "movies" })), "/movies");
  assert.equal(sidebarNavigationPath(target({ view: "explorer", explorerNav: "shows" })), "/tvshows");
  assert.equal(sidebarNavigationPath(target({ view: "upcoming" })), "/upcoming");
  assert.equal(sidebarNavigationPath(target({ view: "history" })), "/history");
  assert.equal(sidebarNavigationPath(target({ view: "stats" })), "/stats");
  assert.equal(sidebarNavigationPath(target({ view: "settings" })), "/settings");
});

test("sidebar special and nested destinations resolve correctly", () => {
  assert.equal(sidebarNavigationPath(target({ id: "brandLink" })), "/");
  assert.equal(sidebarNavigationPath(target({ id: "syncProgressIndicator" })), "/sync-activity");
  assert.equal(sidebarNavigationPath(target({ settingsPath: "/settings/sync#activity" })), "/settings/sync#activity");
  assert.equal(sidebarNavigationPath(target()), "");
});
