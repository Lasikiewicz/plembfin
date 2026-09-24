import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plembfin-episode-identity-repair-");
const repo = await import("../server/src/utils/dataRepo.js");
const { db } = await import("../server/src/db.js");

const insertHistoryStmt = db.prepare(`
  INSERT INTO watch_history
    (id, title, title_lower, media_type, watched_at, source, imdb_id, tmdb_id, tvdb_id, season, episode, media_key, show_title, show_title_lower, sync_action, created_at, updated_at)
  VALUES (@id, @title, @title_lower, 'episode', @watched_at, 'emby', @imdb_id, @tmdb_id, @tvdb_id, @season, @episode, @media_key, @show_title, @show_title_lower, 'watched', @created_at, @updated_at)
`);
const insertProgressStmt = db.prepare(`
  INSERT INTO playback_progress
    (media_key, title, media_type, source, imdb_id, tmdb_id, tvdb_id, season, episode, position_ms, duration_ms, progress, updated_at)
  VALUES (@media_key, @title, 'episode', @source, @imdb_id, @tmdb_id, @tvdb_id, @season, @episode, @position_ms, @duration_ms, @progress, @updated_at)
`);

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function insertHistory({ showTitle, season, episode, ids }) {
  const title = `${showTitle} - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  const media = {
    title,
    media_type: "episode",
    season,
    episode,
    imdb_id: ids.imdb_id || null,
    tmdb_id: ids.tmdb_id || null,
    tvdb_id: ids.tvdb_id || null,
  };
  const timestamp = Date.now();
  insertHistoryStmt.run({
    id: `${showTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${season}-${episode}-${media.imdb_id || media.tmdb_id || media.tvdb_id}`,
    title,
    title_lower: title.toLowerCase(),
    watched_at: `2026-08-${String(episode).padStart(2, "0")}T00:00:00.000Z`,
    ...media,
    media_key: repo.mediaKeyFor(media),
    show_title: showTitle,
    show_title_lower: showTitle.toLowerCase(),
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function insertProgress({ title, season, episode, source = "emby", ids, positionMs, updatedAt }) {
  const media = {
    media_type: "episode",
    title,
    season,
    episode,
    source,
    imdb_id: ids.imdb || null,
    tmdb_id: ids.tmdb || null,
    tvdb_id: ids.tvdb || null,
  };
  insertProgressStmt.run({
    media_key: repo.mediaKeyFor(media),
    title,
    source,
    imdb_id: media.imdb_id,
    tmdb_id: media.tmdb_id,
    tvdb_id: media.tvdb_id,
    season,
    episode,
    position_ms: positionMs,
    duration_ms: 1_000_000,
    progress: positionMs / 10_000,
    updated_at: updatedAt,
  });
}

test("scheduled identity repair collapses Ted Lasso episode aliases and future writes stay canonical", { concurrency: false }, async () => {
  for (const episode of [1, 2, 3]) {
    insertHistory({
      showTitle: "Ted Lasso",
      season: 4,
      episode,
      ids: { imdb_id: "tt10986410", tmdb_id: "97546", tvdb_id: "383203" },
    });
  }

  const title = "Ted Lasso - S04E06";
  insertProgress({
    title,
    season: 4,
    episode: 6,
    ids: { imdb: "tt38494472" },
    positionMs: 100_000,
    updatedAt: 100,
  });
  insertProgress({
    title,
    season: 4,
    episode: 6,
    ids: { tvdb: "383203" },
    positionMs: 200_000,
    updatedAt: 200,
  });

  await repo.repairEpisodeSeriesIdentity();

  let rows = db.prepare(
    "SELECT * FROM playback_progress WHERE media_type = 'episode' AND title = ?",
  ).all(title);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].imdb_id, "tt10986410");
  assert.equal(rows[0].tmdb_id, "97546");
  assert.equal(rows[0].tvdb_id, "383203");
  assert.equal(rows[0].position_ms, 200_000);

  await repo.upsertPlaybackProgress({
    title,
    media_type: "episode",
    source: "emby",
    imdb_id: "tt38494472",
    season: 4,
    episode: 6,
    position_ms: 300_000,
    duration_ms: 1_000_000,
    updated_at: 300,
  });

  rows = db.prepare(
    "SELECT * FROM playback_progress WHERE media_type = 'episode' AND title = ?",
  ).all(title);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].imdb_id, "tt10986410");
  assert.equal(rows[0].position_ms, 300_000);
  assert.deepEqual(repo.seriesIdsForShowTitle(title), {
    imdb: "tt10986410",
    tmdb: "97546",
    tvdb: "383203",
  });
});

test("a disagreeing series-level id outranks the single known title profile (decisions entry 34)", { concurrency: false }, async () => {
  // The only proven "Frasier" profile is the reboot, as when one provider's
  // library is mismatched. A fresh event resolved to the original show by its
  // own series lookup must keep its ids.
  for (const episode of [1, 2]) {
    insertHistory({
      showTitle: "Frasier",
      season: 1,
      episode,
      ids: { imdb_id: "tt14128670", tmdb_id: "209374", tvdb_id: "420737" },
    });
  }
  await repo.repairEpisodeSeriesIdentity();

  const title = "Frasier - S01E03";
  await repo.upsertPlaybackProgress({
    title,
    media_type: "episode",
    source: "plex",
    imdb_id: "tt0106004",
    tmdb_id: "3452",
    tvdb_id: "77811",
    season: 1,
    episode: 3,
    position_ms: 120_000,
    duration_ms: 1_000_000,
    updated_at: 400,
  });

  const readRows = () => db.prepare(
    "SELECT * FROM playback_progress WHERE media_type = 'episode' AND title = ?",
  ).all(title);
  let rows = readRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].imdb_id, "tt0106004");
  assert.equal(rows[0].tmdb_id, "3452");
  assert.equal(rows[0].tvdb_id, "77811");

  // The scheduled repair must not undo it either. Verified live on Scrubs: the
  // ingest kept the original's ids, then the next repair tick rekeyed the row
  // onto the reboot profile. A same-episode alias on the reboot stays separate.
  insertProgress({
    title,
    season: 1,
    episode: 3,
    source: "jellyfin",
    ids: { imdb: "tt14128670", tmdb: "209374", tvdb: "420737" },
    positionMs: 90_000,
    updatedAt: 350,
  });
  await repo.repairEpisodeSeriesIdentity();
  rows = readRows().sort((left, right) => left.updated_at - right.updated_at);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tmdb_id, "209374");
  assert.equal(rows[1].tmdb_id, "3452");
  assert.equal(rows[1].imdb_id, "tt0106004");
  assert.equal(rows[1].position_ms, 120_000);
});

test("a progress write keeps its own series ids where the title profile has none", { concurrency: false }, async () => {
  // Scot Squad history holds only the series TVDB id. A Jellyfin play resolved
  // all three series ids; blanking the IMDb/TMDB ids keyed the row apart from
  // the show's other rows and made a second, id-less resume card (step 6 repeat).
  for (const episode of [1, 3]) {
    insertHistory({ showTitle: "Scot Squad", season: 1, episode, ids: { tvdb_id: "264603" } });
  }
  await repo.repairEpisodeSeriesIdentity();

  const title = "Scot Squad - S01E02";
  await repo.upsertPlaybackProgress({
    title,
    media_type: "episode",
    source: "jellyfin",
    imdb_id: "tt2493352",
    tmdb_id: "55615",
    tvdb_id: "264603",
    season: 1,
    episode: 2,
    position_ms: 300_000,
    duration_ms: 1_724_080,
    updated_at: 500,
  });
  const readRows = () => db.prepare(
    "SELECT * FROM playback_progress WHERE media_type = 'episode' AND title = ?",
  ).all(title);
  const expectOneFullRow = () => {
    const rows = readRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].media_key, "episode:1:2:imdb:tt2493352");
    assert.equal(rows[0].imdb_id, "tt2493352");
    assert.equal(rows[0].tmdb_id, "55615");
    assert.equal(rows[0].tvdb_id, "264603");
  };
  expectOneFullRow();
  await repo.repairEpisodeSeriesIdentity();
  expectOneFullRow();

  // An episode IMDb id leaked into the series slot shares nothing with the
  // profile, so it still takes only the profile's ids.
  await repo.upsertPlaybackProgress({
    title: "Scot Squad - S01E04",
    media_type: "episode",
    source: "emby",
    imdb_id: "tt4095599",
    season: 1,
    episode: 4,
    position_ms: 60_000,
    duration_ms: 1_724_080,
    updated_at: 600,
  });
  const leaked = db.prepare("SELECT * FROM playback_progress WHERE title = ?").get("Scot Squad - S01E04");
  assert.equal(leaked.imdb_id, null);
  assert.equal(leaked.tvdb_id, "264603");
});

test("repair leaves episode-level progress unresolved when same-title reboots are ambiguous", { concurrency: false }, async () => {
  for (const [tmdb, episodes] of [["4556", [1, 2]], ["295778", [1, 2]]]) {
    for (const episode of episodes) {
      insertHistory({
        showTitle: "Scrubs",
        season: 1,
        episode,
        ids: { tmdb_id: tmdb },
      });
    }
  }

  const title = "Scrubs - S01E01";
  insertProgress({ title, season: 1, episode: 1, ids: { tmdb: "4556" }, positionMs: 100_000, updatedAt: 100 });
  insertProgress({ title, season: 1, episode: 1, ids: { tvdb: "episode-only-id" }, positionMs: 200_000, updatedAt: 200 });
  insertProgress({ title, season: 1, episode: 1, ids: { tmdb: "295778" }, positionMs: 150_000, updatedAt: 150 });

  await repo.repairEpisodeSeriesIdentity();

  const rows = db.prepare(
    "SELECT * FROM playback_progress WHERE media_type = 'episode' AND title = ? ORDER BY updated_at",
  ).all(title);
  assert.equal(rows.length, 3);
  assert.ok(rows.some((row) => row.tvdb_id === "episode-only-id"));
  assert.equal(repo.seriesIdsForShowTitle(title), null);
});

test("playstate episode-id aliases are folded only when TMDB find proves them (plan playstate-episode-id-repair)", { concurrency: false }, async () => {
  const showTitle = "Parkside Alias";
  const show = { imdb_id: "tt9000001", tmdb_id: "9001" };
  for (const episode of [1, 2, 3]) insertHistory({ showTitle, season: 1, episode, ids: show });
  const insertPlaystate = db.prepare(`
    INSERT INTO playstate (media_key, title, title_lower, media_type, state, watched_at, last_source, sources, imdb_id, tmdb_id, tvdb_id, season, episode, updated_at)
    VALUES (@media_key, @title, @title_lower, 'episode', @state, '2026-09-01T00:00:00.000Z', 'emby', '["emby"]', @imdb_id, @tmdb_id, @tvdb_id, @season, @episode, @updated_at)
  `);
  const playstate = (episode, ids, state, updatedAt) => {
    const title = `${showTitle} - S01E0${episode}`;
    const record = { media_type: "episode", season: 1, episode, imdb_id: ids.imdb_id || null, tmdb_id: ids.tmdb_id || null, tvdb_id: ids.tvdb_id || null };
    const media_key = repo.mediaKeyFor(record);
    insertPlaystate.run({ ...record, media_key, title, title_lower: title.toLowerCase(), state, updated_at: updatedAt });
    return media_key;
  };
  const seriesKey = (episode) => repo.mediaKeyFor({ media_type: "episode", season: 1, episode, ...show });

  playstate(1, show, "watched", 2000);
  const olderAlias = playstate(1, { imdb_id: "tt9100011" }, "unwatched", 1000);
  playstate(2, show, "unwatched", 1000);
  const newerConflict = playstate(2, { tvdb_id: "9200012" }, "watched", 2000);
  const orphanAlias = playstate(3, { imdb_id: "tt9100013" }, "watched", 1000);
  const mismatch = playstate(4, { imdb_id: "tt9100014" }, "watched", 1000);
  const realSeries = playstate(5, { imdb_id: "tt9100015" }, "watched", 1000);
  const uncached = playstate(6, { imdb_id: "tt9100016" }, "watched", 1000);

  const answers = {
    "imdb_id:tt9100011": { kind: "episode", showId: "9001", season: 1, episode: 1 },
    "tvdb_id:9200012": { kind: "episode", showId: "9001", season: 1, episode: 2 },
    "imdb_id:tt9100013": { kind: "episode", showId: "9001", season: 1, episode: 3 },
    "imdb_id:tt9100014": { kind: "episode", showId: "9001", season: 1, episode: 5 },
    "imdb_id:tt9100015": { kind: "series", showId: "9001" },
  };
  const findCached = (source, id) => answers[`${source}:${id.toLowerCase()}`] || null;
  const result = await repo.repairPlaystateEpisodeIdAliases({ findCached });
  const keys = new Set(db.prepare("SELECT media_key FROM playstate WHERE title_lower LIKE 'parkside alias%'").all().map((row) => row.media_key));

  assert.equal(keys.has(olderAlias), false, "an alias older than the show-keyed row is deleted");
  assert.equal(keys.has(seriesKey(1)), true);
  assert.equal(keys.has(newerConflict), true, "a newer alias with a conflicting state is not auto-resolved");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].aliasKey, newerConflict);
  assert.equal(keys.has(orphanAlias), false);
  const rekeyed = db.prepare("SELECT * FROM playstate WHERE media_key = ?").get(seriesKey(3));
  assert.equal(rekeyed?.state, "watched", "an alias with no show-keyed row is rekeyed onto the show");
  assert.equal(rekeyed.imdb_id, show.imdb_id);
  assert.equal(keys.has(mismatch), true, "a coordinate mismatch is left alone");
  assert.equal(keys.has(realSeries), true, "an id TMDB resolves as a series is left alone");
  assert.equal(keys.has(uncached), true);
  assert.deepEqual(result.pendingLookups, [{ source: "imdb_id", id: "tt9100016" }]);
  assert.equal(result.deleted, 1);
  assert.equal(result.rekeyed, 1);

  const again = await repo.repairPlaystateEpisodeIdAliases({ findCached });
  assert.equal(again.deleted + again.rekeyed, 0, "the repair is idempotent");
});

test("tier 2: a TVDB episode lookup proves aliases TMDB find cannot (plan playstate-episode-id-repair)", { concurrency: false }, async () => {
  const insertPlaystate = db.prepare(`
    INSERT INTO playstate (media_key, title, title_lower, media_type, state, watched_at, last_source, sources, imdb_id, tmdb_id, tvdb_id, season, episode, updated_at)
    VALUES (@media_key, @title, @title_lower, 'episode', 'watched', '2026-09-01T00:00:00.000Z', 'emby', '["emby"]', @imdb_id, @tmdb_id, @tvdb_id, 1, @episode, 1000)
  `);
  const playstate = (showTitle, episode, ids) => {
    const title = `${showTitle} - S01E0${episode}`;
    const record = { media_type: "episode", season: 1, episode, imdb_id: ids.imdb_id || null, tmdb_id: null, tvdb_id: ids.tvdb_id || null };
    const media_key = repo.mediaKeyFor(record);
    insertPlaystate.run({ ...record, media_key, title, title_lower: title.toLowerCase() });
    return media_key;
  };
  const showA = "Tvdb Proof";
  const profileA = { imdb_id: "tt9300001", tmdb_id: "9301", tvdb_id: "93001" };
  const showB = "Tvdb Only Proof";
  const profileB = { imdb_id: "tt9400001", tvdb_id: "94001" };
  for (const episode of [1, 2]) {
    insertHistory({ showTitle: showA, season: 1, episode, ids: profileA });
    insertHistory({ showTitle: showB, season: 1, episode, ids: profileB });
  }
  const seriesKey = (profile, episode) => repo.mediaKeyFor({ media_type: "episode", season: 1, episode, ...profile });

  const findEmpty = playstate(showA, 1, { tvdb_id: "9310001" });
  const tmdbMismatch = playstate(showA, 2, { imdb_id: "tt9310002", tvdb_id: "9310002" });
  const otherSeries = playstate(showA, 3, { tvdb_id: "9310003" });
  const tvdbMismatch = playstate(showA, 4, { tvdb_id: "9310004" });
  const tmdbOtherShow = playstate(showA, 5, { imdb_id: "tt9310005", tvdb_id: "9310005" });
  const tmdbSeries = playstate(showA, 6, { tvdb_id: "9310006" });
  const tvdbUncached = playstate(showA, 7, { tvdb_id: "9310007" });
  const tmdbUncached = playstate(showA, 8, { tvdb_id: "9310008" });
  const tvdbNone = playstate(showA, 9, { tvdb_id: "9310009" });
  const noTmdbProfile = playstate(showB, 1, { tvdb_id: "9410001" });

  const tmdbAnswers = {
    "tvdb_id:9310001": { kind: "none" },
    "imdb_id:tt9310002": { kind: "episode", showId: "9301", season: 1, episode: 3 },
    "tvdb_id:9310002": { kind: "none" },
    "tvdb_id:9310003": { kind: "none" },
    "tvdb_id:9310004": { kind: "none" },
    "imdb_id:tt9310005": { kind: "episode", showId: "7777", season: 1, episode: 5 },
    "tvdb_id:9310005": { kind: "none" },
    "tvdb_id:9310006": { kind: "series", showId: "9301" },
    "tvdb_id:9310007": { kind: "none" },
    "tvdb_id:9310009": { kind: "none" },
    "tvdb_id:9410001": { kind: "episode", showId: "9401", season: 1, episode: 1 },
  };
  const tvdbAnswers = {
    9310001: { kind: "episode", seriesId: "93001", season: 1, episode: 1 },
    9310002: { kind: "episode", seriesId: "93001", season: 1, episode: 2 },
    9310003: { kind: "episode", seriesId: "99999", season: 1, episode: 3 },
    9310004: { kind: "episode", seriesId: "93001", season: 1, episode: 5 },
    9310005: { kind: "episode", seriesId: "93001", season: 1, episode: 5 },
    9310006: { kind: "episode", seriesId: "93001", season: 1, episode: 6 },
    9310008: { kind: "episode", seriesId: "93001", season: 1, episode: 8 },
    9310009: { kind: "none" },
    9410001: { kind: "episode", seriesId: "94001", season: 1, episode: 1 },
  };
  const findCached = (source, id) => tmdbAnswers[`${source}:${id.toLowerCase()}`] || null;
  const tvdbCached = (id) => tvdbAnswers[id] || null;
  const result = await repo.repairPlaystateEpisodeIdAliases({ findCached, tvdbCached });
  const keys = new Set(db.prepare("SELECT media_key FROM playstate WHERE title_lower LIKE 'tvdb %'").all().map((row) => row.media_key));

  assert.equal(keys.has(findEmpty), false, "a find-empty alias is proven by TVDB and rekeyed");
  assert.equal(db.prepare("SELECT state FROM playstate WHERE media_key = ?").get(seriesKey(profileA, 1))?.state, "watched");
  assert.equal(keys.has(tmdbMismatch), false, "a TMDB coordinate that differs from TVDB aired order is proven by TVDB");
  assert.equal(keys.has(seriesKey(profileA, 2)), true);
  assert.equal(keys.has(noTmdbProfile), false, "a profile with no TMDB id is proven by its TVDB id");
  assert.equal(keys.has(seriesKey(profileB, 1)), true);
  assert.equal(keys.has(otherSeries), true, "a TVDB episode of another series is left alone");
  assert.equal(keys.has(tvdbMismatch), true, "a TVDB coordinate mismatch is left alone");
  assert.equal(keys.has(tmdbOtherShow), true, "a TMDB answer naming another show vetoes the TVDB proof");
  assert.equal(keys.has(tmdbSeries), true, "a TMDB series answer is never overridden");
  assert.equal(keys.has(tvdbUncached), true);
  assert.equal(keys.has(tmdbUncached), true);
  assert.equal(keys.has(tvdbNone), true, "an id TVDB does not know as an episode is left alone");
  const ours = (lookup) => /^9[34]1/.test(lookup.id);
  assert.deepEqual(result.pendingTvdbLookups.filter(ours), [{ id: "9310007" }], "TVDB is asked only once the TMDB answers are cached");
  assert.deepEqual(result.pendingLookups.filter(ours), [{ source: "tvdb_id", id: "9310008" }]);
  assert.equal(result.rekeyed, 3);
  assert.equal(result.deleted, 0);

  const again = await repo.repairPlaystateEpisodeIdAliases({ findCached, tvdbCached });
  assert.equal(again.deleted + again.rekeyed, 0, "the repair is idempotent");
});

test("tier 3: a profile with no TMDB id is bridged by its own ids resolving to TMDB's show (plan playstate-episode-id-repair)", { concurrency: false }, async () => {
  const insertPlaystate = db.prepare(`
    INSERT INTO playstate (media_key, title, title_lower, media_type, state, watched_at, last_source, sources, imdb_id, tmdb_id, tvdb_id, season, episode, updated_at)
    VALUES (@media_key, @title, @title_lower, 'episode', 'watched', '2026-09-01T00:00:00.000Z', 'emby', '["emby"]', @imdb_id, NULL, NULL, 1, @episode, 1000)
  `);
  const playstate = (showTitle, episode, imdbId) => {
    const title = `${showTitle} - S01E0${episode}`;
    const record = { media_type: "episode", season: 1, episode, imdb_id: imdbId, tmdb_id: null, tvdb_id: null };
    const media_key = repo.mediaKeyFor(record);
    insertPlaystate.run({ ...record, media_key, title, title_lower: title.toLowerCase() });
    return media_key;
  };
  const shows = {
    bridged: { title: "Bridge Proof", profile: { imdb_id: "tt9500001", tvdb_id: "95001" } },
    otherShow: { title: "Bridge Other", profile: { imdb_id: "tt9500002", tvdb_id: "95002" } },
    split: { title: "Bridge Split", profile: { imdb_id: "tt9500003", tvdb_id: "95003" } },
    pending: { title: "Bridge Pending", profile: { imdb_id: "tt9500004", tvdb_id: "95004" } },
    hasTmdb: { title: "Bridge Kin", profile: { imdb_id: "tt9500005", tmdb_id: "9505" } },
  };
  for (const { title, profile } of Object.values(shows)) {
    for (const episode of [1, 2]) insertHistory({ showTitle: title, season: 1, episode, ids: profile });
  }
  const aliases = {
    bridged: playstate(shows.bridged.title, 3, "tt9510001"),
    otherShow: playstate(shows.otherShow.title, 3, "tt9510002"),
    split: playstate(shows.split.title, 3, "tt9510003"),
    pending: playstate(shows.pending.title, 3, "tt9510004"),
    hasTmdb: playstate(shows.hasTmdb.title, 3, "tt9510005"),
  };

  const episodeOf = (showId) => ({ kind: "episode", showId, season: 1, episode: 3 });
  const answers = {
    "imdb_id:tt9510001": episodeOf("9501"),
    "imdb_id:tt9500001": { kind: "series", showId: "9501" },
    "tvdb_id:95001": { kind: "none" },
    "imdb_id:tt9510002": episodeOf("9502"),
    "imdb_id:tt9500002": { kind: "series", showId: "8888" },
    "tvdb_id:95002": { kind: "series", showId: "8888" },
    "imdb_id:tt9510003": episodeOf("9503"),
    "imdb_id:tt9500003": { kind: "series", showId: "9503" },
    "tvdb_id:95003": { kind: "series", showId: "8888" },
    "imdb_id:tt9510004": episodeOf("9504"),
    "imdb_id:tt9500004": { kind: "series", showId: "9504" },
    "imdb_id:tt9510005": episodeOf("112693"),
    "imdb_id:tt9500005": { kind: "series", showId: "112693" },
  };
  const findCached = (source, id) => answers[`${source}:${id.toLowerCase()}`] || null;
  const tvdbCached = () => null;
  const result = await repo.repairPlaystateEpisodeIdAliases({ findCached, tvdbCached });
  const keys = new Set(db.prepare("SELECT media_key FROM playstate WHERE title_lower LIKE 'bridge %'").all().map((row) => row.media_key));
  const seriesKey = (profile) => repo.mediaKeyFor({ media_type: "episode", season: 1, episode: 3, ...profile });

  assert.equal(keys.has(aliases.bridged), false, "an alias whose show the profile's IMDb id resolves to is rekeyed");
  assert.equal(db.prepare("SELECT state FROM playstate WHERE media_key = ?").get(seriesKey(shows.bridged.profile))?.state, "watched");
  assert.equal(keys.has(aliases.otherShow), true, "a profile whose ids resolve to another show is not bridged");
  assert.equal(keys.has(aliases.split), true, "a profile whose ids resolve to two shows is not bridged");
  assert.equal(keys.has(aliases.pending), true, "a profile with an uncached id is not bridged yet");
  assert.equal(keys.has(aliases.hasTmdb), true, "a profile carrying a TMDB id that disagrees with find is never bridged");
  assert.deepEqual(result.pendingLookups.filter((lookup) => /^(tt)?950/.test(lookup.id)), [{ source: "tvdb_id", id: "95004" }]);
  assert.equal(result.rekeyed, 1);
  assert.equal(result.deleted, 0);

  const again = await repo.repairPlaystateEpisodeIdAliases({ findCached, tvdbCached });
  assert.equal(again.deleted + again.rekeyed, 0, "the repair is idempotent");
});

test("TVDB episode answers are classified and cached for the playstate repair", { concurrency: false }, async (t) => {
  const gateway = await import("../server/src/utils/tvdbGateway.js");
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  let episodeCalls = 0;
  globalThis.fetch = async (url) => {
    const { pathname } = new URL(String(url));
    if (pathname.endsWith("/login")) return json({ data: { token: "test-token" } });
    episodeCalls += 1;
    const id = pathname.split("/").pop();
    if (id === "8000001") return json({ data: { id: 8000001, seriesId: 81189, seasonNumber: 2, number: 7 } });
    if (id === "8000002") return json({ status: "failure" }, 404);
    return json({ status: "failure" }, 500);
  };

  assert.equal(gateway.getCachedTvdbEpisodeKind("8000001"), null);
  assert.deepEqual(await gateway.lookupTvdbEpisodeKind("8000001"), { kind: "episode", seriesId: "81189", season: 2, episode: 7 });
  assert.deepEqual(await gateway.lookupTvdbEpisodeKind("8000002"), { kind: "none" }, "a 404 is cached as not an episode");
  await assert.rejects(gateway.lookupTvdbEpisodeKind("8000003"));
  assert.equal(gateway.getCachedTvdbEpisodeKind("8000003"), null, "a failed request is not cached");
  assert.deepEqual(gateway.getCachedTvdbEpisodeKind("8000001"), { kind: "episode", seriesId: "81189", season: 2, episode: 7 });
  const calls = episodeCalls;
  await gateway.lookupTvdbEpisodeKind("8000002");
  assert.equal(episodeCalls, calls, "a cached answer is not fetched again");
});

test("TMDB find answers are classified and cached for the playstate repair", { concurrency: false }, async (t) => {
  const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
  const gateway = await import("../server/src/utils/tmdbGateway.js");
  await saveMediaConfig({ tmdb: { apiKey: "test-key" } });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const bodies = {
    tt7000001: { tv_results: [{ id: 42 }], tv_episode_results: [] },
    tt7000002: { tv_results: [], tv_episode_results: [{ show_id: 42, season_number: 3, episode_number: 4 }] },
    tt7000003: { tv_results: [], tv_episode_results: [] },
  };
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    const id = decodeURIComponent(new URL(String(url)).pathname.split("/").pop());
    return new Response(JSON.stringify(bodies[id] || {}), { status: 200, headers: { "content-type": "application/json" } });
  };

  assert.equal(gateway.getCachedTmdbExternalIdKind("imdb_id", "tt7000002"), null);
  assert.deepEqual(await gateway.lookupTmdbExternalIdKind("imdb_id", "tt7000001"), { kind: "series", showId: "42" });
  assert.deepEqual(await gateway.lookupTmdbExternalIdKind("imdb_id", "tt7000002"), { kind: "episode", showId: "42", season: 3, episode: 4 });
  assert.deepEqual(await gateway.lookupTmdbExternalIdKind("imdb_id", "tt7000003"), { kind: "none" });
  assert.equal(calls, 3);
  assert.deepEqual(gateway.getCachedTmdbExternalIdKind("imdb_id", "TT7000002"), { kind: "episode", showId: "42", season: 3, episode: 4 });
  await gateway.lookupTmdbExternalIdKind("imdb_id", "tt7000002");
  assert.equal(calls, 3, "a cached answer is not fetched again");
});
