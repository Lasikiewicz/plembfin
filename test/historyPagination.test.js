import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-history-pagination-");

const repo = await import("../server/src/utils/dataRepo.js");

async function insert(record) {
  const result = repo.insertWatchRecordSync(record);
  await repo.invalidateHistoryDerivedCaches("historyPaginationTest");
  return result.id;
}

test("flat history keeps global same-day collapsing while paging through indexed rows", async () => {
  const oldestSameDay = await insert({
    title: "Daily Repeat (2024)", media_type: "movie", tmdb_id: "daily-repeat",
    watched_at: "2026-08-10T09:00:00.000Z", source: "plex",
  });
  const latestSameDay = await insert({
    title: "Daily Repeat (2024)", media_type: "movie", tmdb_id: "daily-repeat",
    watched_at: "2026-08-10T21:00:00.000Z", source: "emby",
  });
  const nextDay = await insert({
    title: "Daily Repeat (2024)", media_type: "movie", tmdb_id: "daily-repeat",
    watched_at: "2026-08-11T08:00:00.000Z", source: "jellyfin",
  });
  const otherMovie = await insert({
    title: "Other Movie", media_type: "movie", tmdb_id: "other-movie",
    watched_at: "2026-08-12T08:00:00.000Z", source: "plex",
  });

  const firstPage = await repo.queryWatchHistory({ limit: 2, offset: 0, dedupe: false });
  const secondPage = await repo.queryWatchHistory({ limit: 2, offset: 2, dedupe: false });
  assert.deepEqual(firstPage.map((row) => row.id), [otherMovie, nextDay]);
  assert.deepEqual(secondPage.map((row) => row.id), [latestSameDay]);
  assert.ok(![...firstPage, ...secondPage].some((row) => row.id === oldestSameDay));
});

test("flat history applies search before same-day collapsing", async () => {
  const matchingOlder = await insert({
    title: "Search Repeat", media_type: "movie", tmdb_id: "search-repeat",
    watched_at: "2026-08-20T09:00:00.000Z", source: "plex",
  });
  await insert({
    title: "Search Repeat", media_type: "movie", tmdb_id: "search-repeat",
    watched_at: "2026-08-20T21:00:00.000Z", source: "emby",
  });

  const rows = await repo.queryWatchHistory({ search: "plex", limit: 20, offset: 0, dedupe: false });
  assert.ok(rows.some((row) => row.id === matchingOlder));
});
