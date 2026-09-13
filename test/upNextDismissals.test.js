import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-up-next-dismissals-");
const {
  recordUpNextDismissal,
  listUpNextDismissals,
  restoreUpNextDismissal,
  restoreAllUpNextDismissals,
  createUpNextDismissalFilter,
} = await import("../server/src/utils/upNextDismissals.js");
const { buildUpNextProjection } = await import("../server/src/utils/upNextService.js");

const reacher = {
  media_key: "reacher-s04e07",
  media_type: "episode",
  title: "Reacher - S04E07",
  show_title: "Reacher",
  season: 4,
  episode: 7,
  show_ids: { tmdb: "108978" },
  provider_items: { plex: ["4774"] },
};

test("a dismissal matches the same episode under a different provider id", () => {
  restoreAllUpNextDismissals();
  recordUpNextDismissal(reacher);
  const filter = createUpNextDismissalFilter();

  assert.ok(filter.isDismissed(reacher));
  // Same episode, re-matched to a different native id: the coordinate alias
  // keeps the dismissal attached.
  assert.ok(filter.isDismissed({ ...reacher, provider_items: { emby: ["99999"] }, media_key: "other-key" }));
  // A different episode of the same show is not dismissed. It carries its own
  // native id, as it would in a real library.
  assert.equal(filter.isDismissed({
    ...reacher,
    episode: 8,
    media_key: "reacher-s04e08",
    provider_items: { plex: ["4775"] },
  }), false);
});

test("re-dismissing the same item replaces its row rather than adding one", () => {
  restoreAllUpNextDismissals();
  recordUpNextDismissal(reacher);
  recordUpNextDismissal({ ...reacher, media_key: "reacher-s04e07-again" });
  assert.equal(listUpNextDismissals().length, 1);
});

test("restore removes the dismissal", () => {
  restoreAllUpNextDismissals();
  const id = recordUpNextDismissal(reacher);
  assert.equal(listUpNextDismissals().length, 1);
  assert.ok(restoreUpNextDismissal(id));
  assert.equal(listUpNextDismissals().length, 0);
  assert.equal(createUpNextDismissalFilter().isDismissed(reacher), false);
});

test("the projection hides a dismissed item from every device", async () => {
  restoreAllUpNextDismissals();
  const options = {
    now: Date.parse("2026-09-13T12:00:00.000Z"),
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "4774",
      media_type: "episode",
      title: "Reacher - S04E07",
      show_title: "Reacher",
      season: 4,
      episode: 7,
      show_ids: { tmdb: "108978" },
      air_date: "2026-09-08",
    }],
  };

  const before = await buildUpNextProjection(options);
  assert.equal(before.items.length, 1);

  recordUpNextDismissal(before.items[0]);
  const after = await buildUpNextProjection(options);
  assert.equal(after.items.length, 0);

  restoreAllUpNextDismissals();
  const restored = await buildUpNextProjection(options);
  assert.equal(restored.items.length, 1);
});

test("a dismissed item comes back once it is genuinely played again", async () => {
  restoreAllUpNextDismissals();
  const dismissedAt = Date.parse("2026-09-13T10:00:00.000Z");
  recordUpNextDismissal({
    media_key: "movie:tmdb:77",
    media_type: "movie",
    title: "A Dismissed Movie",
    ids: { tmdb: "77" },
  }, { now: dismissedAt });

  const rows = (updatedAt, positionMs) => ([{
    media_key: "movie:tmdb:77",
    media_type: "movie",
    title: "A Dismissed Movie",
    tmdb_id: "77",
    position_ms: positionMs,
    duration_ms: 1200000,
    progress: 25,
    updated_at: updatedAt,
    source: "local",
  }]);

  // Older progress than the dismissal stays hidden.
  const stale = await buildUpNextProjection({
    now: Date.parse("2026-09-13T12:00:00.000Z"),
    localFallback: false,
    playstateRows: [],
    providerItems: [],
    progressRows: rows(dismissedAt - 60000, 300000),
  });
  assert.equal(stale.items.length, 0);

  // A newer real position outranks it.
  const fresh = await buildUpNextProjection({
    now: Date.parse("2026-09-13T12:00:00.000Z"),
    localFallback: false,
    playstateRows: [],
    providerItems: [],
    progressRows: rows(dismissedAt + 60000, 300000),
  });
  assert.equal(fresh.items.length, 1);
});
