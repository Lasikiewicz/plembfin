import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-watch-date-sync-activity-");

const { propagateWatchDateRemoval } = await import("../server/src/routes/media.js");
const { getSyncHistory } = await import("../server/src/utils/configStore.js");

test("watch-date removal writes a sync activity entry with merged identity", async () => {
  const deletedRow = {
    id: "deleted-activity-row",
    title: "Activity Movie",
    media_type: "movie",
    imdb_id: "tt-activity",
    tmdb_id: "activity-tmdb",
    watched_at: "2026-08-20T12:00:00.000Z",
    source: "manual",
  };
  const remainingRow = {
    id: "remaining-activity-row",
    title: "Activity Movie!",
    media_type: "movie",
    watched_at: "2026-08-21T12:00:00.000Z",
    source: "manual",
  };

  await propagateWatchDateRemoval(remainingRow, deletedRow, { deletedRows: [deletedRow] });

  const activity = (await getSyncHistory(50)).find((entry) => entry.title === "Activity Movie!");
  assert.ok(activity, "expected the removal replay in Sync Activity");
  assert.equal(activity.action, "watched");
  assert.equal(activity.rawPayloadDebug.watchRecordId, remainingRow.id);
  assert.equal(activity.rawPayloadDebug.ids.imdb, deletedRow.imdb_id);
  assert.equal(activity.rawPayloadDebug.ids.tmdb, deletedRow.tmdb_id);
});
