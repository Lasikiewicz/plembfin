import test from "node:test";
import assert from "node:assert/strict";

import { planUpNextProviderSync } from "../server/src/utils/upNextProviderSync.js";

test("Up Next provider reconciliation preserves visible ids and dismisses only stale removable resume items", () => {
  const plan = planUpNextProviderSync({
    desiredItems: [
      { provider_items: { plex: ["plex-keep"], emby: ["emby-keep"], jellyfin: ["jelly-keep"] } },
    ],
    feeds: [
      {
        provider: "plex",
        feed_kind: "resume",
        status: "succeeded",
        supportsDismissal: true,
        items: [
          { provider_item_id: "plex-keep", title: "Keep" },
          { provider_item_id: "plex-remove", title: "Remove" },
        ],
      },
      {
        provider: "emby",
        feed_kind: "resume",
        status: "succeeded",
        supportsDismissal: true,
        items: [{ provider_item_id: "emby-keep", title: "Keep" }],
      },
      {
        provider: "jellyfin",
        feed_kind: "resume",
        status: "failed",
        supportsDismissal: true,
        items: [{ provider_item_id: "jelly-remove", title: "Do not trust failed feed" }],
      },
    ],
  });

  assert.deepEqual(plan.desiredProviderIds, {
    plex: ["plex-keep"],
    emby: ["emby-keep"],
    jellyfin: ["jelly-keep"],
  });
  assert.deepEqual(plan.dismissals, [{
    provider: "plex",
    feed_kind: "resume",
    provider_item_id: "plex-remove",
    title: "Remove",
  }]);
  assert.deepEqual(plan.unsupported, []);
});

test("native Next Up items are reported as unsupported instead of being marked watched or hidden", () => {
  const plan = planUpNextProviderSync({
    desiredItems: [{ provider_items: { jellyfin: ["jelly-keep"] } }],
    feeds: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      status: "succeeded",
      supportsDismissal: false,
      items: [
        { provider_item_id: "jelly-keep", title: "Keep" },
        { provider_item_id: "jelly-other", title: "Other" },
      ],
    }],
  });

  assert.deepEqual(plan.dismissals, []);
  assert.deepEqual(plan.unsupported, [{
    provider: "jellyfin",
    feed_kind: "next_up",
    provider_item_id: "jelly-other",
    title: "Other",
  }]);
});
