import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

// The TV playlist episode picker (public/modules/playlist-episode-picker.js):
// season grouping, episodes already in the playlist, air labels, and the
// picked episodes it sends (plan/archive/custom-playlist-sync/plan.md decisions 13, 17, 20).
const { episodePickerHtml, episodesInPlaylist, pickedEpisodes } = await import("../public/modules/playlist-episode-picker.js");

const episodes = [
  { season: 0, episode: 1, title: "Pilot special", air_date: "2020-01-01" },
  { season: 1, episode: 1, title: "One", air_date: "2020-02-01" },
  { season: 1, episode: 2, title: "Two", air_date: "2020-02-08" },
  { season: 2, episode: 1, title: "Next", air_date: "2099-05-01" },
  { season: 2, episode: 2, title: "", air_date: "" },
];

function seasonBlocks(html) {
  return html.split("<details").slice(1);
}

test("the picker groups every episode by season, specials included, with the first real season open", () => {
  const blocks = seasonBlocks(episodePickerHtml(episodes, new Set(), "2026-09-25"));
  assert.equal(blocks.length, 3);
  assert.match(blocks[0], /^ class="playlist-episode-season">\s*<summary>Specials <span>1 episode<\/span>/, "Season 0 is listed but not opened");
  assert.match(blocks[1], /^ class="playlist-episode-season" open>\s*<summary>Season 1 <span>2 episodes<\/span>/);
  assert.match(blocks[1], /Select all in Season 1/);
  assert.match(blocks[2], /E1 · Next<\/span>\s*<small>Airs 2099-05-01<\/small>/, "a future episode shows when it airs");
  assert.match(blocks[2], /E2<\/span>\s*<small>Unaired<\/small>/, "an episode with no date is still offered");
});

test("episodes already in the playlist show ticked and disabled, and the season counts them", () => {
  const html = episodePickerHtml(episodes, new Set(["1:2"]), "2026-09-25");
  const season1 = seasonBlocks(html)[1];
  assert.match(season1, /2 episodes, 1 in playlist/);
  assert.match(season1, /class="playlist-episode-choice is-held">\s*<input type="checkbox" name="episode" value="1:2" checked disabled \/>/);
  assert.match(season1, /<small>In playlist<\/small>/);
  assert.match(season1, /value="1:1" \/>/, "an episode not in the playlist is a plain choice");
});

test("episodesInPlaylist matches the show by id, or by title for items without ids", () => {
  const list = {
    items: [
      { media_type: "episode", tmdb_id: "100", season: 1, episode: 1 },
      { media_type: "episode", tvdb_id: "900", season: 2, episode: 3 },
      { media_type: "episode", tmdb_id: "555", season: 1, episode: 2 },
      { media_type: "episode", show_title: "The Show!", season: 3, episode: 4 },
      { media_type: "movie", tmdb_id: "100" },
    ],
  };
  const held = episodesInPlaylist(list, { title: "The Show", tmdb_id: "" }, { tmdb_id: "100", tvdb_id: "900" });
  assert.deepEqual([...held].sort(), ["1:1", "2:3", "3:4"], "another show's episode and the movie are not counted");
});

test("pickedEpisodes returns the ticked, enabled choices in episode order", () => {
  const boxes = [{ value: "2:1" }, { value: "0:1" }, { value: "1:2" }];
  let selector = "";
  const form = { querySelectorAll: (query) => { selector = query; return boxes; } };
  assert.deepEqual(pickedEpisodes(form, episodes).map((entry) => `${entry.season}:${entry.episode}`), ["0:1", "1:2", "2:1"]);
  assert.equal(selector, "input[name=episode]:checked:not(:disabled)", "episodes already in the playlist are never re-sent");
  assert.deepEqual(Object.keys(pickedEpisodes(form, episodes)[0]).sort(), ["air_date", "episode", "overview", "season", "title"]);
});
