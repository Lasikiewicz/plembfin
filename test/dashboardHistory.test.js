import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { mergeDashboardHistoryEntries } = await import("../public/modules/dashboard.js");

function episode(overrides = {}) {
  return {
    media_type: "episode",
    title: "Lioness - S03E04 - Murder Hornets",
    show_title: "Lioness",
    season: 3,
    episode: 4,
    watched_at: "2026-08-23T22:50:00.000Z",
    watch_count: 1,
    show_tmdb_id: "113962",
    ...overrides,
  };
}

test("dashboard history merges one episode across apps and keeps every source badge", () => {
  const merged = mergeDashboardHistoryEntries([
    episode({ id: "plex-row", source: "plex" }),
    episode({ id: "jellyfin-row", source: "jellyfin", watched_at: "2026-08-23T22:49:00.000Z" }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "plex-row", "the newest row remains the card anchor");
  assert.deepEqual(new Set(merged[0].sources), new Set(["plex", "jellyfin"]));
  assert.equal(merged[0].watch_count, 1, "cross-app copies of one viewing are not counted as a rewatch");
});

test("dashboard history collapses provider-specific source aliases into one badge", () => {
  const merged = mergeDashboardHistoryEntries([
    episode({
      id: "plex-aliases",
      source: "plex_webhook",
      sources: ["plex", "Plex webhook"],
      playHistory: [{ source: "plex_import" }],
    }),
  ]);

  assert.deepEqual(merged[0].sources, ["plex"]);
});

test("dashboard history keeps a Plembfin mark distinct from Plex", () => {
  const merged = mergeDashboardHistoryEntries([
    episode({ id: "manual-row", source: "manual", sources: ["manual"] }),
    episode({ id: "plex-row", source: "plex", sources: ["plex"], watched_at: "2026-08-23T22:49:00.000Z" }),
  ]);

  assert.equal(merged.length, 1);
  assert.deepEqual(new Set(merged[0].sources), new Set(["plembfin", "plex"]));
});

test("dashboard history does not merge same-title episodes with conflicting provider identities", () => {
  const merged = mergeDashboardHistoryEntries([
    episode({ id: "original", show_tmdb_id: "100" }),
    episode({ id: "remake", show_tmdb_id: "200", source: "jellyfin" }),
  ]);

  assert.equal(merged.length, 2);
});

test("dashboard history can bridge a TMDB-only row and a TVDB-only row for the same title", () => {
  const merged = mergeDashboardHistoryEntries([
    episode({ id: "tmdb-row", show_tmdb_id: "113962", source: "plex" }),
    episode({ id: "tvdb-row", show_tmdb_id: undefined, show_tvdb_id: "555555", source: "jellyfin" }),
  ]);

  assert.equal(merged.length, 1);
});
