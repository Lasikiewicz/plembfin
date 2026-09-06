import test from "node:test";
import assert from "node:assert/strict";

import { statsPayloadForPeriod } from "../server/src/utils/statsPayload.js";

test("stats payload keeps a compact period index and selects one report", () => {
  const all = { period: "all", total: 12, totalWatches: 12, movies: 7, shows: 5 };
  const year = { period: "2026", total: 8, totalWatches: 8, movies: 5, shows: 3 };
  const month = { period: "2026-09", label: "September 2026", total: 2, totalWatches: 2, movies: 1, shows: 1 };
  const stats = {
    total: 12,
    totalWatches: 12,
    movies: 7,
    uniqueMoviesLogged: 7,
    episodes: 5,
    reports: {
      all,
      years: [year],
      months: [month],
    },
  };

  const allPayload = statsPayloadForPeriod(stats, "all");
  assert.equal(allPayload.total, 12);
  assert.equal(allPayload.reports.all, all);
  assert.deepEqual(allPayload.reports.years, [{ period: "2026", label: "2026" }]);
  assert.deepEqual(allPayload.reports.months, [{ period: "2026-09", label: "September 2026" }]);
  assert.equal(allPayload.reports.selected, undefined);

  const yearPayload = statsPayloadForPeriod(stats, "2026");
  assert.equal(yearPayload.total, 12);
  assert.equal(yearPayload.reports.all, null);
  assert.equal(yearPayload.reports.selected, year);

  const monthPayload = statsPayloadForPeriod(stats, "2026-09");
  assert.equal(monthPayload.total, 12);
  assert.equal(monthPayload.reports.selected, month);
});

test("stats payload falls back to all for an unknown period", () => {
  const all = { period: "all", total: 3 };
  const payload = statsPayloadForPeriod({ total: 3, reports: { all, years: [], months: [] } }, "not-a-period");

  assert.equal(payload.total, 3);
  assert.equal(payload.reports.all, all);
  assert.equal(payload.reports.selected, undefined);
});
