import test from "node:test";
import assert from "node:assert/strict";

import { isDeletedWatchSuppressed, recordDeletedWatchSuppression, watchRowToMedia } from "../server/src/utils/dataRepo.js";

test("watchRowToMedia preserves provider item identity for deletion echo suppression", () => {
  const media = watchRowToMedia({
    title: "G'wed - S02E02",
    show_title: "G'wed",
    media_type: "episode",
    season: 2,
    episode: 2,
    tmdb_id: "245412",
    tvdb_id: "434702",
    watch_provenance: JSON.stringify({
      version: 1,
      source: "plex",
      event: "notification.viewstate",
      item_id: "41780",
    }),
  }, "plex");

  assert.equal(media.showTitle, "G'wed");
  assert.equal(media.itemId, "41780");
});

test("a deleted provider date is tombstoned by native item identity", () => {
  const watchedAt = "2025-02-13T00:00:00.000Z";
  const row = {
    source: "plex",
    watched_at: watchedAt,
    media_key: "episode:2:2:tmdb:245412",
    watch_provenance: JSON.stringify({ version: 1, source: "plex", item_id: "41780" }),
  };
  assert.equal(recordDeletedWatchSuppression(row), 2);
  assert.equal(isDeletedWatchSuppressed({
    source: "plex",
    type: "episode",
    season: 2,
    episode: 2,
    title: "G'wed - S02E02",
    itemId: "41780",
    ids: { tmdb: "245412" },
  }, watchedAt), true);
  assert.equal(isDeletedWatchSuppressed({
    source: "plex",
    type: "episode",
    season: 2,
    episode: 2,
    itemId: "41780",
    ids: { tmdb: "245412" },
  }, "2025-02-13"), true);
  assert.equal(isDeletedWatchSuppressed({ ...row, source: "emby", itemId: "41780", type: "episode" }, watchedAt), false);
});
