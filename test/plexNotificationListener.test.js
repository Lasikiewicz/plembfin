import test from "node:test";
import assert from "node:assert/strict";
import { parsePlexNotificationRatingKeys } from "../server/src/utils/plexNotificationListener.js";

test("parsePlexNotificationRatingKeys extracts rating keys from single object TimelineEntry", () => {
  const singlePayload = JSON.stringify({
    NotificationContainer: {
      type: "timeline",
      size: 1,
      TimelineEntry: {
        identifier: "com.plexapp.plugins.library",
        itemID: "12345",
        type: 1, // Movie
      },
    },
  });

  const keys = parsePlexNotificationRatingKeys(singlePayload);
  assert.deepEqual(keys, ["12345"]);
});

test("parsePlexNotificationRatingKeys extracts rating keys from array TimelineEntry", () => {
  const arrayPayload = JSON.stringify({
    NotificationContainer: {
      type: "timeline",
      size: 2,
      TimelineEntry: [
        {
          identifier: "com.plexapp.plugins.library",
          itemID: "101",
          type: 1,
        },
        {
          identifier: "com.plexapp.plugins.library",
          ratingKey: "202",
          type: 4, // Episode
        },
      ],
    },
  });

  const keys = parsePlexNotificationRatingKeys(arrayPayload);
  assert.deepEqual(keys, ["101", "202"]);
});

test("parsePlexNotificationRatingKeys extracts rating keys from ActivityNotification payload", () => {
  const activityPayload = JSON.stringify({
    NotificationContainer: {
      type: "activity",
      size: 1,
      ActivityNotification: [
        {
          event: "updated",
          uuid: "fb444864-fae6-4de0-b5f0-bc4f072e6df0",
          Activity: {
            uuid: "fb444864-fae6-4de0-b5f0-bc4f072e6df0",
            type: "library.refresh.items",
            cancellable: false,
            userID: 1,
            title: "Refreshing",
            subtitle: "Checking files",
            progress: 0,
            Context: { key: "/library/metadata/38800" },
          },
        },
      ],
    },
  });

  const keys = parsePlexNotificationRatingKeys(activityPayload);
  assert.deepEqual(keys, ["38800"]);
});

test("parsePlexNotificationRatingKeys ignores non-watchable timeline entries", () => {
  const nonWatchablePayload = JSON.stringify({
    NotificationContainer: {
      type: "timeline",
      TimelineEntry: {
        identifier: "com.plexapp.plugins.library",
        itemID: "999",
        type: 2, // Show container
      },
    },
  });

  const keys = parsePlexNotificationRatingKeys(nonWatchablePayload);
  assert.deepEqual(keys, []);
});
