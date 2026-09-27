import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

// The "Import from apps" dialog (public/modules/playlist-import.js): rows per
// app, merge choices on a name clash, target apps, and the picks it sends
// (plan/archive/custom-playlist-sync/plan.md decisions 21 to 28).
const { importDialogBodyHtml, importMergeOption, importPicks, importResultMessage } = await import("../public/modules/playlist-import.js");

const candidate = (provider, id, title, kind, clash = {}, extra = {}) => ({
  provider, id, title, item_count: 3, kind_guess: kind, other_count: 0, error: "",
  clash: { name_taken: false, merge_into: null, same_name: [], ...clash }, ...extra,
});

const apps = [
  { provider: "plex", status: "ok", smart_skipped: 2, playlists: [
    candidate("plex", "p1", "Favourites", "movie", { name_taken: true, merge_into: { id: "fav", name: "Favourites", kind: "movie" } }),
    candidate("plex", "p2", "Weekend", "movie", { same_name: [{ provider: "emby", id: "e1" }] }),
    candidate("plex", "p3", "Shows", "tv", { name_taken: true }),
    candidate("plex", "p4", "Broken", null, {}, { error: "status 500" }),
    candidate("plex", "p5", "Home", "movie", {}, { other_count: 2 }),
  ] },
  { provider: "emby", status: "ok", smart_skipped: 0, playlists: [
    candidate("emby", "e1", "weekend", "tv", { same_name: [{ provider: "plex", id: "p2" }] }),
    candidate("emby", "e2", "Weekend Mix", "mixed"),
  ] },
  { provider: "jellyfin", status: "error", error: "status 503", smart_skipped: 0, playlists: [] },
];
const candidates = new Map(apps.flatMap((app) => app.playlists).map((entry) => [`${entry.provider}:${entry.id}`, entry]));

function rowOf(html, key) {
  const start = html.indexOf(`data-import-row="${key}"`);
  assert.ok(start > 0, `row ${key} rendered`);
  return html.slice(start, html.indexOf("</li>", start));
}

test("merge options: into a compatible Plembfin playlist, with another app's same-name playlist, never Movies with TV", () => {
  assert.deepEqual(importMergeOption(candidates.get("plex:p1"), candidates), { mergeInto: { id: "fav", name: "Favourites", kind: "movie" } });
  // A Movies and a TV playlist of one name do not merge.
  assert.equal(importMergeOption(candidates.get("plex:p2"), candidates), null);
  assert.equal(importMergeOption(candidates.get("plex:p3"), candidates), null);
  const mixed = new Map(candidates);
  mixed.set("emby:e1", { ...candidates.get("emby:e1"), kind_guess: "mixed" });
  assert.deepEqual(importMergeOption(candidates.get("plex:p2"), mixed), { apps: ["emby"] });
});

test("the dialog lists each app's playlists, its errors, smart playlists, and notes", () => {
  const html = importDialogBodyHtml(apps, ["plex", "emby", "jellyfin"]);
  assert.match(html, /2 smart playlists are not listed/);
  assert.match(html, /Could not read the Jellyfin playlists: status 503/);
  assert.match(rowOf(html, "plex:p4"), /name="import" value="plex:p4" disabled/);
  assert.match(rowOf(html, "plex:p5"), /2 items are not a movie or episode and stay in Plex only/);
  assert.match(rowOf(html, "plex:p1"), /3 items · Movies/);

  const favourites = rowOf(html, "plex:p1");
  assert.match(favourites, /value="merge" checked/);
  assert.match(favourites, /Merge into your &quot;Favourites&quot; playlist|Merge into your "Favourites" playlist/);
  assert.match(favourites, /Import separately as (&quot;|")Favourites \(Plex\)/);
  // Only the source app is ticked, and it cannot be unticked.
  assert.match(favourites, /name="targets:plex:p1" value="plex" checked disabled/);
  assert.match(favourites, /name="targets:plex:p1" value="emby" \/>/);
  assert.match(favourites, /data-import-options hidden/);

  // Name taken by an incompatible playlist: no choice, a note.
  const shows = rowOf(html, "plex:p3");
  assert.doesNotMatch(shows, /type="radio"/);
  assert.match(shows, /so this one is imported as (&quot;|")Shows \(Plex\)/);
  assert.equal(importDialogBodyHtml([], []).includes("Connect Plex, Emby, or Jellyfin"), true);
});

test("only connected apps are offered as targets", () => {
  const html = importDialogBodyHtml(apps, ["plex"]);
  assert.doesNotMatch(rowOf(html, "plex:p1"), /value="emby"/);
  assert.match(rowOf(html, "emby:e2"), /value="emby" checked disabled/);
});

// Stub form: rows keyed by candidate, each with a checked mode and targets.
function stubForm(rows) {
  const boxes = rows.map(({ key, mode, targets }) => {
    const row = {
      querySelector: (query) => (query === "input[type=radio]:checked" && mode ? { value: mode } : null),
      querySelectorAll: (query) => (query === "[data-import-options] input[type=checkbox]:checked" ? targets.map((value) => ({ value })) : []),
    };
    return { value: key, closest: (query) => (query === "[data-import-row]" ? row : null) };
  });
  return { querySelectorAll: (query) => (query === "input[name=import]:checked" ? boxes : []) };
}

test("picks carry mode, merge target, and ticked apps", () => {
  const form = stubForm([
    { key: "plex:p1", mode: "merge", targets: ["plex", "jellyfin"] },
    { key: "plex:p3", mode: null, targets: ["plex"] },
    { key: "emby:e2", mode: null, targets: ["emby"] },
  ]);
  assert.deepEqual(importPicks(form, apps), [
    { provider: "plex", remote_playlist_id: "p1", mode: "merge", merge_into: "fav", targets: ["plex", "jellyfin"] },
    { provider: "plex", remote_playlist_id: "p3", mode: "separate", targets: ["plex"] },
    { provider: "emby", remote_playlist_id: "e2", mode: "separate", targets: ["emby"] },
  ]);
  const separate = importPicks(stubForm([{ key: "plex:p1", mode: "separate", targets: ["plex"] }]), apps);
  assert.equal(separate[0].mode, "separate");
  assert.equal("merge_into" in separate[0], false);
});

test("result message: names, unidentified items, first-sync problems, and a deferred sync", () => {
  assert.equal(
    importResultMessage({ synced: true, lists: [{ name: "Films", unidentified: 1, errors: [] }, { name: "Shows", unidentified: 0, errors: [] }] }),
    'Imported 2 playlists: "Films", "Shows". 1 item could not be identified and stays in the app only.',
  );
  assert.match(importResultMessage({ synced: true, lists: [{ name: "Films", unidentified: 0, errors: ["Plex: status 500"] }] }), /problems: Plex: status 500/);
  assert.match(importResultMessage({ synced: false, lists: [{ name: "Films" }] }), /arrive at the next sync/);
});
