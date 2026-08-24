import test from "node:test";
import assert from "node:assert/strict";

import { watchRowToMedia } from "../server/src/utils/dataRepo.js";

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
