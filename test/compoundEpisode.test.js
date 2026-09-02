import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCompoundEpisodeIndex,
  canonicalCompoundEpisodeMedia,
  canonicalizeCompoundEpisodeRows,
  compoundEpisodeForMedia,
  compoundEpisodeItemsForMedia,
} from "../server/src/utils/compoundEpisode.js";

function grimmRow(episode, watchedAt, episodeTitle = null) {
  return {
    title: `Grimm - S05E${String(episode).padStart(2, "0")}`,
    show_title: "Grimm",
    media_type: "episode",
    season: 5,
    episode,
    episode_title: episodeTitle,
    watched_at: watchedAt,
  };
}

test("compound episode mapping projects Grimm's combined S05E21 and split S05E22 to Trakt S05E21", () => {
  const rows = [
    grimmRow(22, "2016-08-17T20:49:00.000Z"),
    grimmRow(21, "2016-08-22T22:29:00.000Z", "Beginning of the End, Parts One and Two"),
  ];

  const result = canonicalizeCompoundEpisodeRows(rows);
  assert.equal(result.mapped, 1);
  assert.equal(result.collapsed, 0);
  assert.deepEqual(result.rows.map((row) => [row.season, row.episode]), [[5, 21], [5, 21]]);
  assert.equal(result.rows[0].compound_episode.sourceRepresentation, "split");
  assert.equal(result.rows[1].compound_episode.sourceRepresentation, "combined");
});
test("tracker metadata can make a differently numbered combined episode canonical", () => {
  const rows = [
    { ...grimmRow(20, "2023-08-28T00:36:00.000Z", "Moving Up"), title: "Parks and Recreation - S06E20", show_title: "Parks and Recreation", source: "trakt_import" },
    { ...grimmRow(21, "2014-04-24T00:00:00.000Z", "Moving Up"), title: "Parks and Recreation - S06E21", show_title: "Parks and Recreation", source: "plex" },
    { ...grimmRow(22, "2014-04-24T00:00:00.000Z", "Moving Up (2)"), title: "Parks and Recreation - S06E22", show_title: "Parks and Recreation", source: "plex" },
  ];
  const result = canonicalizeCompoundEpisodeRows(rows.sort((left, right) => left.watched_at.localeCompare(right.watched_at)));
  assert.deepEqual(result.rows.filter((row) => row.compound_episode).map((row) => [row.episode, row.compound_source_episode]), [[20, 21], [20, 20]]);
  assert.equal(result.collapsed, 1);
  assert.equal(result.mapped, 2);
});

test("a lone part-two title is left unresolved until matching evidence exists", () => {
  const result = canonicalizeCompoundEpisodeRows([
    grimmRow(1, "2019-04-24T18:41:00.000Z", "Mercy (2)"),
  ]);
  assert.equal(result.mapped, 0);
  assert.equal(result.collapsed, 0);
  assert.equal(result.rows[0].compound_episode, undefined);
});

test("split parts watched in one session become one logical Trakt play", () => {
  const result = canonicalizeCompoundEpisodeRows([
    grimmRow(21, "2016-08-22T20:00:00.000Z", "Beginning of the End (1)"),
    grimmRow(22, "2016-08-22T21:08:00.000Z", "Beginning of the End (2)"),
  ]);
  assert.equal(result.mapped, 1);
  assert.equal(result.collapsed, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].watched_at, "2016-08-22T20:00:00.000Z");
});

test("a split source falls back to the canonical item only when the target lacks the split coordinate", () => {
  const index = buildCompoundEpisodeIndex([
    grimmRow(21, "2016-08-22T20:00:00.000Z", "Beginning of the End (1)"),
    grimmRow(22, "2016-08-22T21:08:00.000Z", "Beginning of the End (2)"),
  ]);
  const splitSource = compoundEpisodeForMedia({
    type: "episode",
    title: "Grimm - S05E22",
    showTitle: "Grimm",
    season: 5,
    episode: 22,
    episodeTitle: "Beginning of the End (2)",
  });
  const combinedTarget = new Map([["5:21", [{ id: "combined" }]]]);
  const splitTarget = new Map([
    ["5:21", [{ id: "part-1" }]],
    ["5:22", [{ id: "part-2" }]],
  ]);
  assert.deepEqual(compoundEpisodeItemsForMedia(combinedTarget, splitSource), [{ id: "combined" }]);
  assert.deepEqual(compoundEpisodeItemsForMedia(splitTarget, splitSource), [{ id: "part-2" }]);
  assert.equal(index.get("grimm:5:22").canonicalEpisode, 21);
});

test("a combined source marks every split target alias", () => {
  const combined = canonicalCompoundEpisodeMedia({
    type: "episode",
    title: "Grimm - S05E21",
    showTitle: "Grimm",
    season: 5,
    episode: 21,
    episodeTitle: "Beginning of the End, Parts One and Two",
  });
  const target = new Map([
    ["5:21", [{ id: "part-1" }]],
    ["5:22", [{ id: "part-2" }]],
  ]);
  assert.deepEqual(compoundEpisodeItemsForMedia(target, combined), [{ id: "part-1" }, { id: "part-2" }]);
});

test("compound episode mapping detects split (1) and (2) episodes with the same base name (Brooklyn Nine-Nine)", () => {
  const rows = [
    {
      title: "Brooklyn Nine-Nine - S08E09",
      show_title: "Brooklyn Nine-Nine",
      media_type: "episode",
      season: 8,
      episode: 9,
      episode_title: "The Last Day (1)",
      watched_at: "2021-09-24T19:22:00.000Z",
    },
    {
      title: "Brooklyn Nine-Nine - S08E10",
      show_title: "Brooklyn Nine-Nine",
      media_type: "episode",
      season: 8,
      episode: 10,
      episode_title: "The Last Day (2)",
      watched_at: "2021-08-13T20:05:00.000Z",
    },
  ];

  const result = canonicalizeCompoundEpisodeRows(rows);
  assert.equal(result.mapped, 1);
  assert.equal(result.rows.length, 2);
  const ep10Projected = result.rows.find((r) => r.compound_source_episode === 10);
  assert.ok(ep10Projected);
  assert.equal(ep10Projected.episode, 9);
  assert.equal(ep10Projected.season, 8);
  assert.equal(ep10Projected.compound_episode.canonicalEpisode, 9);
  assert.equal(ep10Projected.compound_episode.sourceRepresentation, "split");
});

test("compound episode mapping recognizes (Part 1)/(Part 2), (Pt 1)/(Pt 2), and bracketed markers", () => {
  const variations = [
    ["Finale (Part 1)", "Finale (Part 2)"],
    ["Finale (Pt 1)", "Finale (Pt 2)"],
    ["Finale [1]", "Finale [2]"],
    ["Finale [Part 1]", "Finale [Part 2]"],
    ["Finale - Part 1", "Finale - Part 2"],
  ];

  for (const [part1Title, part2Title] of variations) {
    const rows = [
      { title: "Show - S01E01", show_title: "Show", media_type: "episode", season: 1, episode: 1, episode_title: part1Title, watched_at: "2020-01-01T00:00:00.000Z" },
      { title: "Show - S01E02", show_title: "Show", media_type: "episode", season: 1, episode: 2, episode_title: part2Title, watched_at: "2020-01-02T00:00:00.000Z" },
    ];
    const result = canonicalizeCompoundEpisodeRows(rows);
    assert.equal(result.mapped, 1, `Failed to map variation ${part1Title} / ${part2Title}`);
    assert.equal(result.rows.find((r) => r.compound_source_episode === 2)?.episode, 1);
  }
});

test("compound episode mapping discovers split episodes from season metadata resolver even when rows lack episode titles", () => {
  const rows = [
    {
      title: "Brooklyn Nine-Nine - S08E09",
      show_title: "Brooklyn Nine-Nine",
      media_type: "episode",
      season: 8,
      episode: 9,
      episode_title: "The Last Day",
      watched_at: "2021-09-24T19:22:00.000Z",
    },
    {
      title: "Brooklyn Nine-Nine - S08E10",
      show_title: "Brooklyn Nine-Nine",
      media_type: "episode",
      season: 8,
      episode: 10,
      episode_title: null,
      watched_at: "2021-08-13T20:05:00.000Z",
    },
  ];

  const seasonEpisodesResolver = ({ showTitle, season }) => {
    if (showTitle === "Brooklyn Nine-Nine" && season === 8) {
      return [
        { number: 9, name: "The Last Day (1)" },
        { number: 10, name: "The Last Day (2)" },
      ];
    }
    return [];
  };

  const result = canonicalizeCompoundEpisodeRows(rows, { seasonEpisodesResolver });
  assert.equal(result.mapped, 1);
  const ep10 = result.rows.find((r) => r.compound_source_episode === 10);
  assert.ok(ep10);
  assert.equal(ep10.episode, 9);
  assert.equal(ep10.compound_episode.canonicalEpisode, 9);
});

test("canonicalCompoundEpisodeMedia projects split part 2 to canonical episode via season metadata", () => {
  const seasonEpisodesResolver = ({ showTitle, season }) => {
    if (showTitle === "Brooklyn Nine-Nine" && season === 8) {
      return [
        { number: 9, name: "The Last Day (1)" },
        { number: 10, name: "The Last Day (2)" },
      ];
    }
    return [];
  };

  const media = {
    type: "episode",
    title: "Brooklyn Nine-Nine - S08E10",
    showTitle: "Brooklyn Nine-Nine",
    season: 8,
    episode: 10,
  };

  const canonical = canonicalCompoundEpisodeMedia(media, { seasonEpisodesResolver });
  assert.equal(canonical.season, 8);
  assert.equal(canonical.episode, 9);
  assert.equal(canonical.compound_episode.canonicalEpisode, 9);
  assert.equal(canonical.compound_episode.sourceCoordinate.episode, 10);
});
