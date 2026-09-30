import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plembfin-playstate-alias-review-");
const repo = await import("../server/src/utils/dataRepo.js");
const review = await import("../server/src/utils/playstateAliasReview.js");
const { db } = await import("../server/src/db.js");

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const insertHistoryStmt = db.prepare(`
  INSERT INTO watch_history
    (id, title, title_lower, media_type, watched_at, source, imdb_id, tmdb_id, tvdb_id, season, episode, media_key, show_title, show_title_lower, sync_action, created_at, updated_at)
  VALUES (@id, @title, @title_lower, 'episode', '2026-08-01T00:00:00.000Z', 'emby', @imdb_id, @tmdb_id, NULL, 1, @episode, @media_key, @show_title, @show_title_lower, 'watched', 1, 1)
`);
const insertPlaystateStmt = db.prepare(`
  INSERT INTO playstate (media_key, title, title_lower, media_type, state, watched_at, last_source, sources, imdb_id, tmdb_id, tvdb_id, season, episode, updated_at)
  VALUES (@media_key, @title, @title_lower, 'episode', @state, '2026-09-01T00:00:00.000Z', 'emby', '["emby"]', @imdb_id, @tmdb_id, @tvdb_id, 1, @episode, @updated_at)
`);

function episodeTitle(showTitle, episode) {
  return `${showTitle} - S01E0${episode}`;
}

function history(showTitle, episode, show) {
  const title = episodeTitle(showTitle, episode);
  const media_key = repo.mediaKeyFor({ media_type: "episode", season: 1, episode, ...show });
  insertHistoryStmt.run({
    id: `${showTitle}-${episode}`, title, title_lower: title.toLowerCase(), episode, media_key,
    imdb_id: show.imdb_id, tmdb_id: show.tmdb_id, show_title: showTitle, show_title_lower: showTitle.toLowerCase(),
  });
}

function playstate(showTitle, episode, ids, state, updatedAt) {
  const title = episodeTitle(showTitle, episode);
  const record = { media_type: "episode", season: 1, episode, imdb_id: ids.imdb_id || null, tmdb_id: ids.tmdb_id || null, tvdb_id: ids.tvdb_id || null };
  const media_key = repo.mediaKeyFor(record);
  insertPlaystateStmt.run({ ...record, media_key, title, title_lower: title.toLowerCase(), state, updated_at: updatedAt });
  return media_key;
}

const rowAt = (key) => db.prepare("SELECT * FROM playstate WHERE media_key = ?").get(key);

test("Maintenance card: unproven aliases are listed, folded newest-wins, or dismissed (plan playstate-episode-id-repair)", { concurrency: false }, async () => {
  const showTitle = "Kinlike Review";
  const show = { imdb_id: "tt8000001", tmdb_id: "8001" };
  for (const episode of [1, 2, 3, 4, 5]) history(showTitle, episode, show);
  const seriesKey = (episode) => repo.mediaKeyFor({ media_type: "episode", season: 1, episode, ...show });

  playstate(showTitle, 1, show, "watched", 1000);
  const newerAlias = playstate(showTitle, 1, { imdb_id: "tt8100001" }, "unwatched", 2000);
  playstate(showTitle, 2, show, "watched", 3000);
  const olderAlias = playstate(showTitle, 2, { imdb_id: "tt8100002" }, "unwatched", 1000);
  const orphanAlias = playstate(showTitle, 3, { tvdb_id: "8200003" }, "watched", 1000);
  const pendingAlias = playstate(showTitle, 4, { imdb_id: "tt8100004" }, "watched", 1000);
  const provenAlias = playstate(showTitle, 5, { imdb_id: "tt8100005" }, "watched", 1000);
  insertPlaystateStmt.run({
    media_key: "episode:1:4:title:kinlike review---s01e04", title: episodeTitle(showTitle, 4), title_lower: episodeTitle(showTitle, 4).toLowerCase(),
    state: "watched", imdb_id: null, tmdb_id: null, tvdb_id: null, episode: 4, updated_at: 1000,
  });

  const otherTitle = "Reboot Review";
  const other = { imdb_id: "tt8000002", tmdb_id: "8002" };
  for (const episode of [1, 2]) history(otherTitle, episode, other);
  const seriesIdAlias = playstate(otherTitle, 1, { imdb_id: "tt8100011" }, "watched", 1000);

  const answers = {
    "imdb_id:tt8100001": { kind: "episode", showId: "7777", season: 1, episode: 1 },
    "imdb_id:tt8100002": { kind: "none" },
    "tvdb_id:8200003": { kind: "none" },
    "imdb_id:tt8100005": { kind: "episode", showId: "8001", season: 1, episode: 5 },
    "imdb_id:tt8100011": { kind: "series", showId: "9999" },
  };
  const findCached = (source, id) => answers[`${source}:${id.toLowerCase()}`] || null;
  const tvdbCached = (id) => (id === "8200003" ? { kind: "none" } : null);
  const options = { findCached, tvdbCached };

  const shows = await review.listUnprovenPlaystateAliases(options);
  assert.deepEqual(shows.map((entry) => entry.title), [showTitle, otherTitle]);
  const [kinlike, reboot] = shows;
  assert.deepEqual(kinlike.rows.map((row) => row.mediaKey), [newerAlias, olderAlias, orphanAlias, "episode:1:4:title:kinlike review---s01e04"],
    "pending and proven episode-id rows are not listed; title-only rows remain reviewable");
  assert.deepEqual(kinlike.rows.map((row) => row.reason), ["other-show", "not-found", "not-found", "title-only"]);
  assert.deepEqual(kinlike.rows[0].showKeyed, [{ state: "watched", updatedAt: 1000 }]);
  assert.deepEqual(kinlike.rows[2].showKeyed, [null]);
  assert.deepEqual(kinlike.tmdbDisagreement, { findShowId: "7777", profileTmdbIds: ["8001"] });
  assert.equal(reboot.rows[0].reason, "series-id");
  assert.ok(rowAt(pendingAlias) && rowAt(provenAlias), "listing writes nothing");

  const folded = await review.foldPlaystateAliasesIntoShow(kinlike.showKey, 0, options);
  assert.deepEqual(folded, { deleted: 2, rekeyed: 3 });
  assert.equal(rowAt(newerAlias), undefined);
  assert.equal(rowAt(seriesKey(1)).state, "unwatched", "a newer alias replaces the show-keyed row");
  assert.equal(rowAt(seriesKey(1)).updated_at, 2000);
  assert.equal(rowAt(olderAlias), undefined, "an older alias is deleted");
  assert.equal(rowAt(seriesKey(2)).state, "watched");
  assert.equal(rowAt(orphanAlias), undefined);
  assert.equal(rowAt(seriesKey(3)).state, "watched", "an alias with no show-keyed row is rekeyed");
  assert.equal(rowAt(seriesKey(3)).imdb_id, show.imdb_id);
  assert.ok(rowAt(pendingAlias) && rowAt(provenAlias), "only listed aliases are folded");

  const dismissed = await review.dismissPlaystateAliasesForShow(reboot.showKey, options);
  assert.equal(dismissed.dismissed, 1);
  assert.deepEqual((await review.listUnprovenPlaystateAliases(options)).map((entry) => entry.title), []);
  await assert.rejects(review.foldPlaystateAliasesIntoShow(reboot.showKey, 0, options), /no unproven/);

  // The scheduled repair skips a dismissed row even once a proof appears.
  answers["imdb_id:tt8100011"] = { kind: "episode", showId: "8002", season: 1, episode: 1 };
  const result = await repo.repairPlaystateEpisodeIdAliases({ findCached, tvdbCached, skipKeys: review.dismissedPlaystateAliasKeys() });
  assert.ok(rowAt(seriesIdAlias), "a dismissed alias is never folded");
  assert.equal(result.rekeyed, 1, "the proven alias of the other show is still repaired");
  assert.equal(rowAt(provenAlias), undefined);
  // Phase 5 step 2: the id-less title-keyed row folds onto the sole profile.
  assert.equal(rowAt("episode:1:4:title:kinlike review---s01e04"), undefined);
  assert.equal(rowAt(seriesKey(4)).imdb_id, show.imdb_id);
});

function titlePlaystate(showTitle, episode, state, updatedAt) {
  const title = episodeTitle(showTitle, episode);
  const key = repo.mediaKeyFor({ media_type: "episode", title, season: 1, episode });
  insertPlaystateStmt.run({ media_key: key, title, title_lower: title.toLowerCase(), state,
    imdb_id: null, tmdb_id: null, tvdb_id: null, episode, updated_at: updatedAt });
  return key;
}

test("title-only rows without profiles, ambiguous rows, conflicts, and dismissal restore", async () => {
  db.prepare("DELETE FROM watch_history").run();
  db.prepare("DELETE FROM playstate").run();
  db.prepare("DELETE FROM settings WHERE id = 'playstateAliasDismissed'").run();
  const unprofiled = titlePlaystate("Unknown Show", 1, "watched", 1000);
  const show = { imdb_id: "tt9000001", tmdb_id: "9001" };
  history("Conflict Show", 1, show);
  history("Conflict Show", 2, show);
  playstate("Conflict Show", 1, show, "unwatched", 1000);
  const conflict = titlePlaystate("Conflict Show", 1, "watched", 2000);
  history("Ambiguous Show", 1, show);
  history("Ambiguous Show", 2, show);
  history("Ambiguous Show", 4, { imdb_id: "tt9000002", tmdb_id: "9002" });
  history("Ambiguous Show", 5, { imdb_id: "tt9000002", tmdb_id: "9002" });
  const ambiguous = titlePlaystate("Ambiguous Show", 3, "watched", 1000);
  const options = { findCached: () => ({ kind: "none" }), tvdbCached: () => ({ kind: "none" }) };
  let shows = await review.listUnprovenPlaystateAliases(options);
  assert.equal(shows.find((s) => s.title === "Unknown Show").rows[0].reason, "no-profile");
  const unknown = shows.find((s) => s.title === "Unknown Show");
  await assert.rejects(review.foldPlaystateAliasesIntoShow(unknown.showKey, 0, options), /Unknown show identity/);
  assert.ok(rowAt(unprofiled));
  assert.equal(shows.find((s) => s.title === "Conflict Show").rows[0].reason, "newer-conflict");
  const split = shows.find((s) => s.title === "Ambiguous Show");
  assert.equal(split.profiles.length, 2);
  assert.equal(split.rows[0].reason, "ambiguous");
  await review.dismissPlaystateAliasesForShow(split.showKey, options);
  assert.equal(review.listDismissedPlaystateAliases()[0].rows[0].mediaKey, ambiguous);
  await repo.repairPlaystateEpisodeIdAliases({ ...options, skipKeys: review.dismissedPlaystateAliasKeys() });
  assert.ok(rowAt(ambiguous));
  assert.deepEqual(review.restoreDismissedPlaystateAliases(split.showKey), { restored: 1 });
  assert.equal(review.dismissedPlaystateAliasKeys().has(ambiguous), false);
  assert.deepEqual(review.listDismissedPlaystateAliases(), []);
  assert.throws(() => review.restoreDismissedPlaystateAliases(split.showKey), /no dismissed/);
  shows = await review.listUnprovenPlaystateAliases(options);
  assert.ok(shows.find((s) => s.showKey === split.showKey));
  const selected = split.profiles.findIndex((ids) => ids.tmdb === "9002");
  await review.foldPlaystateAliasesIntoShow(split.showKey, selected, options);
  assert.equal(rowAt(ambiguous), undefined);
  assert.equal(rowAt(repo.mediaKeyFor({ media_type: "episode", season: 1, episode: 3, tmdb_id: "9002", imdb_id: "tt9000002" })).state, "watched");
  const conflictShow = shows.find((s) => s.title === "Conflict Show");
  await review.foldPlaystateAliasesIntoShow(conflictShow.showKey, 0, options);
  assert.equal(rowAt(conflict), undefined);
  assert.equal(rowAt(repo.mediaKeyFor({ media_type: "episode", season: 1, episode: 1, ...show })).state, "watched");
});


test("fold preserves a newer canonical row stored under another title spelling", async () => {
  db.prepare("DELETE FROM watch_history").run();
  db.prepare("DELETE FROM playstate").run();
  const show = { imdb_id: "tt9900001", tmdb_id: "9901" };
  history("Alternate Title", 1, show);
  history("Alternate Title", 2, show);
  const canonical = playstate("Original Title", 1, show, "unwatched", 3000);
  const alias = titlePlaystate("Alternate Title", 1, "watched", 1000);
  const listed = await review.listUnprovenPlaystateAliases();
  const entry = listed.find((s) => s.title === "Alternate Title");
  assert.deepEqual(entry.rows[0].showKeyed, [{ state: "unwatched", updatedAt: 3000 }]);
  assert.deepEqual(await review.foldPlaystateAliasesIntoShow(entry.showKey, 0), { deleted: 1, rekeyed: 0 });
  assert.ok(!rowAt(alias));
  assert.equal(rowAt(canonical).state, "unwatched");
  const newer = titlePlaystate("Alternate Title", 1, "watched", 4000);
  assert.deepEqual(await review.foldPlaystateAliasesIntoShow(entry.showKey, 0), { deleted: 1, rekeyed: 1 });
  assert.ok(!rowAt(newer));
  assert.equal(rowAt(canonical).state, "watched");
});
