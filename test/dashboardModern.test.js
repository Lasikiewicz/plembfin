import test from "node:test";
import assert from "node:assert/strict";

let style = null;
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.history ??= { state: null, pushState() {}, replaceState() {} };
globalThis.window ??= { addEventListener() {}, location: { origin: "http://localhost:5055", pathname: "/" } };
globalThis.document = { addEventListener() {}, querySelector: () => null, documentElement: { getAttribute: (name) => (name === "data-style" ? style : null) } };

const { bindDashboardRuns, dashboardTvRowUnits, isDashboardRowCompact, setDashboardRowCompact, setDashboardRunExpanded } = await import("../public/modules/dashboard-modern.js");

const episode = (id, show, season, number) => ({ id, media_type: "episode", show_tmdb_id: show, show_title: `Show ${show}`, season, episode: number });

const history = [
  episode(5, 1, 1, 5),
  episode(4, 1, 1, 4),
  episode(3, 1, 1, 3),
  episode(2, 2, 2, 1),
  episode(1, 1, 1, 2),
];

test("Classic collapses runs the same as Modern", () => {
  style = null;
  const units = dashboardTvRowUnits(history);
  assert.deepEqual(units.map((unit) => unit.entries.map((entry) => entry.id)), [[5, 4, 3], [2], [1]]);
  assert.equal(units[0].key, "run:id:1:3");
});

test("Modern collapses consecutive episodes of one show into a keyed run", () => {
  style = "modern";
  const units = dashboardTvRowUnits(history);
  assert.deepEqual(units.map((unit) => unit.entries.map((entry) => entry.id)), [[5, 4, 3], [2], [1]]);
  assert.equal(units[0].key, "run:id:1:3");
  assert.equal(units[1].key, undefined);
  // A later watch of the same show after another show starts a new run.
  assert.equal(units[2].key, undefined);
});

test("the compact toggle is per row and leaves the TV row's cards alone", () => {
  style = null;
  const before = dashboardTvRowUnits(history);
  assert.equal(isDashboardRowCompact("tv"), false);
  setDashboardRowCompact("tv", true);
  assert.equal(isDashboardRowCompact("tv"), true);
  assert.equal(isDashboardRowCompact("movie"), false);
  // Compact only folds cards visually; the row's units are unchanged.
  assert.deepEqual(dashboardTvRowUnits(history), before);
  setDashboardRowCompact("tv", false);
  assert.equal(isDashboardRowCompact("tv"), false);
});

test("Modern never folds part-watched entries into a run", () => {
  style = "modern";
  const units = dashboardTvRowUnits([{ ...episode(9, 1, 1, 6), isPartWatched: true }, ...history.slice(0, 2)]);
  assert.deepEqual(units.map((unit) => unit.entries.map((entry) => entry.id)), [[9], [5, 4]]);
});

test("Modern never folds movies into a run, even repeat watches of one title", () => {
  style = "modern";
  const movie = (id) => ({ id, media_type: "movie", tmdb_id: 7, title: "Film" });
  const units = dashboardTvRowUnits([movie(3), movie(2), ...history.slice(0, 2)]);
  assert.deepEqual(units.map((unit) => unit.entries.map((entry) => entry.id)), [[3], [2], [5, 4]]);
});

test("expanding or collapsing a run re-renders every view that shows runs", () => {
  style = "modern";
  const calls = [];
  bindDashboardRuns(() => calls.push("dashboard"));
  bindDashboardRuns(() => calls.push("history"));
  setDashboardRunExpanded("run:id:1:3", true);
  setDashboardRunExpanded("run:id:1:3", false);
  assert.deepEqual(calls, ["dashboard", "history", "dashboard", "history"]);
});

test("an expanded run gives one card per episode, with no Collapse control", () => {
  style = "modern";
  setDashboardRunExpanded("run:id:1:3", true);
  const expanded = dashboardTvRowUnits(history);
  assert.deepEqual(expanded.map((unit) => unit.entries.map((entry) => entry.id)), [[5], [4], [3], [2], [1]]);
  assert.ok(expanded.slice(0, 3).every((unit) => unit.expanded && !unit.key));
  assert.ok(expanded.every((unit) => !("expandedKey" in unit) && !("count" in unit)));
  // Every card of the run carries its key, so a compact row can open the whole run.
  assert.ok(expanded.slice(0, 3).every((unit) => unit.runKey === "run:id:1:3"));
  assert.equal(expanded[3].runKey, undefined);
  assert.ok(!expanded[3].expanded);

  setDashboardRunExpanded("run:id:1:3", false);
  assert.equal(dashboardTvRowUnits(history)[0].key, "run:id:1:3");
});

test("opening a run folds any other open run back into its stack", () => {
  style = "modern";
  const rows = [...history.slice(0, 3), episode(8, 2, 2, 3), episode(7, 2, 2, 2)];
  setDashboardRunExpanded("run:id:1:3", true);
  setDashboardRunExpanded("run:id:2:7", true);
  const units = dashboardTvRowUnits(rows);
  assert.equal(units[0].key, "run:id:1:3");
  assert.deepEqual(units.slice(1).map((unit) => unit.runKey), ["run:id:2:7", "run:id:2:7"]);
  setDashboardRunExpanded("run:id:2:7", false);
  assert.deepEqual(dashboardTvRowUnits(rows).map((unit) => unit.key), ["run:id:1:3", "run:id:2:7"]);
});

