import test from "node:test";
import assert from "node:assert/strict";
import { nativeProviderItemIds } from "../server/src/utils/providerItemIds.js";

test("a bare provider item id is not reused for a different provider", () => {
  // The real incident: a Plex Continue Watching row cleared through the
  // shared outbound path handed ratingKey 1505 to Jellyfin.
  const media = { source: "plex", provider_item_id: "1505", title: "The Drama" };
  assert.deepEqual(nativeProviderItemIds(media, "plex"), ["1505"]);
  assert.deepEqual(nativeProviderItemIds(media, "jellyfin"), []);
  assert.deepEqual(nativeProviderItemIds(media, "emby"), []);
});

test("an id already listed under another provider is not reused either", () => {
  // source is "manual" here, so the source check alone would let it through.
  const media = {
    source: "manual",
    provider_item_id: "3478",
    provider_items: { plex: ["3478"], emby: ["12105"] },
  };
  assert.deepEqual(nativeProviderItemIds(media, "plex"), ["3478"]);
  assert.deepEqual(nativeProviderItemIds(media, "emby"), ["12105"]);
  assert.deepEqual(nativeProviderItemIds(media, "jellyfin"), []);
});

test("a bare id with no attributable owner is still accepted", () => {
  // Callers that pass a native id without naming a source must keep working.
  assert.deepEqual(nativeProviderItemIds({ providerItemId: "jellyfin-item" }, "jellyfin"), ["jellyfin-item"]);
});

test("per-provider entries and named aliases are always honoured", () => {
  const media = { source: "plex", provider_items: { emby: ["504"] }, jellyfin_id: "abc" };
  assert.deepEqual(nativeProviderItemIds(media, "emby"), ["504"]);
  assert.deepEqual(nativeProviderItemIds(media, "jellyfin"), ["abc"]);
});
