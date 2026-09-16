import test from "node:test";
import assert from "node:assert/strict";
import fixture from "./fixtures/tautulli/history.json" with { type: "json" };
import { mapTautulliHistoryRow, prepareTautulliImport, buildTautulliTelemetry, targetDefaults } from "../server/src/utils/tautulliImport.js";

test("Tautulli mapper converts Unix seconds and zero-pads episode coordinates", () => {
  const movie = mapTautulliHistoryRow(fixture.movies[0], { userId: "7", userName: "Alex" });
  assert.equal(movie.status, "ready");
  assert.equal(movie.record.watched_at, "2025-09-15T02:33:20.000Z");
  assert.notEqual(new Date(movie.record.watched_at).getUTCFullYear(), 1970);
  assert.equal(movie.record.watch_provenance.event, "history_import");
  assert.equal(movie.record.watch_provenance.item_id, "101");
  assert.equal(movie.record.watch_provenance.percent_complete, 100);

  const episode = mapTautulliHistoryRow(fixture.episodes[0], { userId: "7", userName: "Alex" });
  assert.equal(episode.record.title, "Example Show - S01E02");
  assert.equal(episode.record.tvdb_id, "88888");
});

test("incomplete and wrong-user rows are never importable", () => {
  assert.equal(mapTautulliHistoryRow(fixture.movies[1], { userId: "7" }).reason, "incomplete");
  assert.equal(mapTautulliHistoryRow({ ...fixture.movies[0], user_id: 8 }, { userId: "7" }).reason, "user_scope_mismatch");
});

// This used to assert that ANY different-calendar-day play was preserved as a
// rewatch. That rule was changed deliberately: Plembfin holds many approximated
// watch dates, and a real Tautulli timestamp landing hours either side of one
// is the same viewing, not a second one. The existing record here is at
// 20:00:00 - a round clock hour, which is what marks a date as approximated -
// and the second play is 6 hours later across midnight, so it now merges.
// A genuinely distant rewatch is still preserved; see below.
test("preview merges a same-day play and a near-miss beside an approximated date", async () => {
  const incoming = [fixture.movies[0], { ...fixture.movies[0], row_id: 103, date: 1757986400, stopped: 1757987000 }];
  const preview = await prepareTautulliImport(incoming, {
    userId: "7",
    userName: "Alex",
    history: [{ id: "trakt-1", title: "Example Film", media_type: "movie", watched_at: "2025-09-15T20:00:00.000Z", imdb_id: null, tmdb_id: "1234", tvdb_id: null }],
    selectedTargets: ["emby"],
    activeTargets: ["plex", "emby"],
  });
  assert.equal(preview.merged, 2);
  assert.equal(preview.merged_approximate_date, 1);
  assert.equal(preview.new, 0);
  assert.equal(preview.records.length, 0);
  assert.match(preview.telemetry, /Target plex status: skipped/);
  assert.match(preview.telemetry, /Target emby status: pending/);
});

test("a rewatch well outside the review window is still imported as its own play", async () => {
  const preview = await prepareTautulliImport([fixture.movies[0]], {
    userId: "7",
    userName: "Alex",
    // Same film, watched over a year earlier: unambiguously a separate viewing.
    history: [{ id: "trakt-1", title: "Example Film", media_type: "movie", watched_at: "2024-01-02T20:00:00.000Z", imdb_id: null, tmdb_id: "1234", tvdb_id: null }],
  });
  assert.equal(preview.new, 1);
  assert.equal(preview.needs_review, 0);
  assert.equal(preview.merged, 0);
});

// The importer no longer asks which servers to project to, and no longer turns
// Plex off just because Tautulli points at the same Plex server. Plembfin is the
// source of truth, so its scheduled sync reconciles Emby and Jellyfin with
// imported watches anyway, and both receive the original playback date. An
// already-watched Plex item is detected and reported as `already_matching`,
// which is accurate rather than a guess from the machine identifier, and the
// standing Plex historical setting decides whether Plex is written to at all.
test("every connected app is a target, including a Plex that Tautulli itself points at", () => {
  const config = {
    plex: { baseUrl: "http://plex", token: "token", machineIdentifier: "same" },
    emby: { baseUrl: "http://emby", apiKey: "key", userId: "user" },
    jellyfin: { disabled: true },
  };
  assert.deepEqual(targetDefaults(config), { plex: true, emby: true });
  // A disabled or unconfigured app is still not a target.
  assert.deepEqual(targetDefaults({ emby: { baseUrl: "http://emby", apiKey: "key", userId: "user" } }), { emby: true });
  assert.deepEqual(targetDefaults({}), {});
});

test("a missing Tautulli timestamp merges an existing identity instead of inventing a duplicate date", async () => {
  const row = { ...fixture.movies[0], date: 0, stopped: 0, guid: "com.plexapp.agents.imdb://tt1234567?lang=en" };
  const preview = await prepareTautulliImport([row], {
    userId: "7",
    history: [{ id: "existing", title: "Example Film", media_type: "movie", watched_at: "2025-02-01T12:00:00.000Z", imdb_id: "tt1234567" }],
    activeTargets: [],
    selectedTargets: [],
  });
  assert.equal(preview.merged, 1);
  assert.equal(preview.new, 0);
});

test("telemetry remains explicit for selected and skipped targets", () => {
  const telemetry = buildTautulliTelemetry(["jellyfin"], ["plex", "jellyfin"]);
  assert.match(telemetry, /Origin: tautulli_import/);
  assert.match(telemetry, /Target plex status: skipped/);
  assert.match(telemetry, /Target jellyfin status: pending/);
});
