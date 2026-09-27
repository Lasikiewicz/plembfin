import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

// Automatic playlists on the Playlists page (public/modules/playlist-rules.js
// and its hooks in playlists.js): the rule summary and panel, hidden hand
// edits, the create and edit dialogs, the rule read from the form, and the
// requests the panel's buttons send.
globalThis.Element ??= class Element {};

const { state } = await import("../public/modules/state.js");
const { initPlaylists, renderPlaylists, openPlaylistDialog, handlePlaylistClick, playlistAcceptsItem } = await import("../public/modules/playlists.js");
const { playlistRuleSummary, readRuleFromForm } = await import("../public/modules/playlist-rules.js");

const requests = [];
const cardOptions = [];
let dialogBody = "";
let confirmAnswer = true;
const messages = [];

initPlaylists({
  normalizeItem: (item) => item,
  personalCard: (item, options) => { cardOptions.push(options); return `<card key="${item.media_key}" ${options.attributesHtml}>${options.actionsHtml}</card>`; },
  emptyPersonalState: (title) => `<empty>${title}</empty>`,
  personalRequest: async (payload) => { requests.push(payload); return payload.action === "list-refresh-rule" ? { ok: true, status: "changed", added: 2, removed: 1, reordered: false } : { ok: true }; },
  loadPersonalMedia: async () => {},
  setMessage: (text, kind) => messages.push([text, kind]),
  dialogFrame: (title, body) => { dialogBody = `${title}\n${body}`; return { querySelector: () => null, isConnected: true }; },
  closePersonalDialog: () => {},
  confirm: async () => confirmAnswer,
});

const rule = { source: "library", genres: ["Comedy", "Drama"], genreMatch: "any", yearFrom: 1990, yearTo: 1999, watched: "unwatched", addedWithinDays: 30, limit: 50, order: "newest" };

function automatic(overrides = {}) {
  return {
    id: "a1",
    name: "Nineties comedy",
    kind: "movie",
    rule,
    rule_checked_at: Date.UTC(2026, 8, 26, 12, 0),
    rule_error: "",
    rule_hold: null,
    providers: [{ provider: "plex", status: "synced" }],
    held_changes: [],
    items: [
      { media_key: "movie:tmdb:1", title: "One", availability: {} },
      { media_key: "movie:tmdb:2", title: "Two", availability: {} },
    ],
    ...overrides,
  };
}

let lastButton = null;
// The heading's spinner, found from the clicked menu item's section.
const indicator = { hidden: true, isConnected: true };
const section = { querySelector: (selector) => (selector === "[data-playlist-refresh-indicator]" ? indicator : null) };
function clickOn(selectorName, dataset) {
  const classes = new Set();
  const attributes = new Map();
  const button = Object.assign(new Element(), {
    dataset, disabled: false, isConnected: true, textContent: "Button",
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    getAttribute: (name) => attributes.get(name) ?? null,
    closest: (selector) => (selector === ".personal-media-list-section" ? section : null),
  });
  lastButton = button;
  const target = Object.assign(new Element(), { closest: (selector) => (selector === selectorName ? button : null) });
  return handlePlaylistClick({ target, preventDefault: () => {} });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the rule summary reads as one line", () => {
  // A rule saved without a type reads as Top rated (decision 72).
  assert.equal(playlistRuleSummary(automatic()), "From your libraries · Top rated · Comedy or Drama · the 1990s · Unwatched titles only · Added in the last 30 days · Newest first · Up to 50");
  assert.equal(
    playlistRuleSummary({ kind: "tv", rule: { source: "catalogue", type: "trending", genres: ["Drama", "Crime"], genreMatch: "all", yearFrom: 2015, yearTo: null, watched: "watched", addedWithinDays: null, limit: 1, order: "rating" } }),
    "From the whole TMDB catalogue · Trending this week · Drama and Crime · 2015 or later · Next episode of each show · Highest rated · Up to 1 show",
  );
  assert.equal(playlistRuleSummary({ kind: "movie", rule: { source: "library", type: "popular", genres: [], order: "title" } }), "From your libraries · Popular · Any genre · Title A to Z");
  assert.equal(playlistRuleSummary({ kind: "movie", rule: null }), "");
  assert.equal(
    playlistRuleSummary({ kind: "movie", rule: { source: "library", type: "new", genres: ["Horror"], languages: ["en", "ko", "xq"], order: "ranked", limit: 20 } }),
    "From your libraries · New releases · Horror · English or Korean or XQ · Up to 20",
    "the default Ranked order is not spelled out",
  );
});

test("the Language list: English ticked on a new automatic playlist, the saved choice on edit, none for an old rule", () => {
  state.playlistProviders = [];
  openPlaylistDialog();
  assert.match(dialogBody, /Original language/);
  assert.match(dialogBody, /name="ruleLanguage" value="en" checked/);
  assert.match(dialogBody, /name="ruleLanguage" value="ko" \/>/);
  assert.match(dialogBody, /None ticked means any language\./);

  openPlaylistDialog({ list: automatic({ rule: { ...rule, languages: ["ko", "xq"] } }) });
  assert.match(dialogBody, /name="ruleLanguage" value="en" \/>/);
  assert.match(dialogBody, /name="ruleLanguage" value="ko" checked/);
  assert.match(dialogBody, /name="ruleLanguage" value="xq" checked \/> <span>XQ<\/span>/, "a saved language the list does not name stays choosable");

  openPlaylistDialog({ list: automatic() });
  assert.doesNotMatch(dialogBody, /name="ruleLanguage" value="\w+" checked/, "a rule saved before the Language choice ticks none (any language)");
});

test("an automatic playlist shows its rule panel, keeps remove, and hides drag and move", () => {
  cardOptions.length = 0;
  const html = renderPlaylists([automatic({ rule_error: "Emby: HTTP 500" })], []);
  const heading = html.split('class="personal-media-list-row')[0];
  assert.match(heading, /playlist-heading-actions">\s*<span class="playlist-rule-label" title="Last checked [^"]+"[^>]*>Auto<\/span>\s*<details class="playlist-options">/, "Auto sits right, left of Options");
  assert.doesNotMatch(heading, /playlist-rule-summary|From your libraries/, "the rule is in Info, not the heading");
  assert.match(heading, /<span class="source-badge source-badge--icon playlist-provider-icon[^>]*><img [^>]*\/><span>Plex<\/span><\/span>/, "apps show icon and name");
  assert.match(heading, /playlist-options-menu" role="menu">\s*<button[^>]*data-playlist-rule-info="a1">Info<\/button><button[^>]*data-playlist-refresh-rule="a1" title="Check the rule now">Refresh now<\/button><button[^>]*data-playlist-stop-rule="a1"[^>]*>Stop updating<\/button>\s*<button[^>]*data-playlist-edit="a1"[^>]*>Edit<\/button>\s*<button[^>]*data-personal-delete-list="a1"[^>]*>Delete<\/button>/, "every action is in Options");
  assert.match(heading, /data-playlist-refresh-indicator[^>]* hidden><\/span>\s*<h2/, "the idle spinner waits, hidden, left of the title");
  assert.match(html, /The last check failed, so the items were left as they were: Emby: HTTP 500/);
  assert.doesNotMatch(html, /draggable|data-playlist-move/);
  assert.ok(cardOptions.length === 2 && cardOptions.every((options) => options.removable === true), "remove keeps the title out for good (decision 65)");

  const checking = renderPlaylists([automatic({ rule_checking: true })], []);
  assert.match(checking, /data-playlist-refresh-indicator role="status" aria-label="Refreshing" title="Checking the rule"><\/span>\s*<h2/, "a running check spins left of the title after a reload");
  assert.match(checking, /data-playlist-refresh-rule="a1" disabled aria-busy="true">Refreshing</);

  const manualHeading = renderPlaylists([automatic({ rule: null })], []).split('class="personal-media-list-row')[0];
  assert.doesNotMatch(manualHeading, /Auto<|data-playlist-rule-info|data-playlist-refresh-indicator/);
  assert.match(manualHeading, /playlist-options-menu" role="menu">\s*<button[^>]*data-playlist-edit="a1"/, "a hand-made playlist's Options holds Edit and Delete");

  cardOptions.length = 0;
  const manual = renderPlaylists([automatic({ rule: null })], []);
  assert.doesNotMatch(manual, /playlist-rule-panel/);
  assert.match(manual, /draggable="true"/);
  assert.ok(cardOptions.every((options) => options.removable === true));
});

test("Info opens a pop-up with every detail of the rule", () => {
  state.personalLists = [automatic({ remove_watched: true })];
  assert.equal(clickOn("[data-playlist-rule-info]", { playlistRuleInfo: "a1" }), true);
  assert.match(dialogBody, /^Nineties comedy\n/);
  for (const [label, value] of [["Titles from", "Your libraries"], ["Type", "Top rated"], ["Genres", "Comedy or Drama"], ["Original language", "Any language"], ["Years", "the 1990s"], ["Watched", "Unwatched titles only"], ["Recently added", "Added in the last 30 days"], ["Order", "Newest first"], ["Most titles", "Up to 50"], ["Remove items once watched", "On"]]) {
    assert.match(dialogBody, new RegExp(`<dt>${label}</dt><dd>${value}</dd>`));
  }
  assert.match(dialogBody, /<dt>Updates<\/dt><dd>Last checked [^<]+\. Updated every hour; edits made inside an app are put back\.<\/dd>/);

  state.personalLists = [automatic({ kind: "tv", rule: { source: "catalogue", type: "new", genres: ["Drama"], languages: ["en"], yearFrom: 2020, yearTo: 2029, order: "newest", limit: 20 } })];
  clickOn("[data-playlist-rule-info]", { playlistRuleInfo: "a1" });
  assert.match(dialogBody, /<dt>Titles from<\/dt><dd>The whole TMDB catalogue<\/dd><dt>Type<\/dt><dd>New releases<\/dd><dt>Genres<\/dt><dd>Drama<\/dd><dt>Original language<\/dt><dd>English<\/dd><dt>Years<\/dt><dd>the 2020s<\/dd><dt>Episodes<\/dt><dd>The next episode of each show<\/dd><dt>Order<\/dt><dd>Newest first<\/dd><dt>Most shows<\/dt><dd>Up to 20<\/dd><dt>Remove items once watched<\/dt><dd>Off<\/dd>/);
});

test("an empty automatic playlist says whether its rule has been checked", () => {
  assert.match(renderPlaylists([automatic({ items: [], rule_checked_at: null })], []), /Not checked yet\..*Checking the rule, this can take a minute or two\./s);
  assert.match(renderPlaylists([automatic({ items: [] })], []), /No titles match the rule right now/);
});

test("a held rule check offers Confirm and Discard until confirmed, and sends the decision", async () => {
  const held = renderPlaylists([automatic({ rule_hold: { removal_count: 8, item_count: 10, confirmed: false } })], []);
  assert.match(held, /would remove 8 of this playlist&#39;s 10 items at once/);
  assert.match(held, /data-playlist-rule-held="confirm" data-playlist-id="a1"/);
  assert.match(held, /data-playlist-rule-held="discard"/);
  const confirmed = renderPlaylists([automatic({ rule_hold: { removal_count: 8, item_count: 10, confirmed: true } })], []);
  const confirmedHeading = confirmed.split('class="personal-media-list-row')[0];
  assert.match(confirmedHeading, /class="playlist-rule-confirmed" title="Confirmed\. It applies at the next check\.">Confirmed<\/span>/, "a confirmed hold is a tag in the heading");
  assert.doesNotMatch(confirmed, /playlist-held-change/, "and no line under the heading");
  assert.doesNotMatch(confirmed, /data-playlist-rule-held/);

  requests.length = 0;
  assert.equal(clickOn("[data-playlist-rule-held]", { playlistRuleHeld: "discard", playlistId: "a1" }), true);
  await settle();
  assert.deepEqual(requests, [{ action: "list-rule-held", list_id: "a1", decision: "discard" }]);
});

test("Refresh now and Stop updating send their requests; Stop asks first", async () => {
  state.personalLists = [automatic()];
  requests.length = 0;
  messages.length = 0;
  assert.equal(clickOn("[data-playlist-refresh-rule]", { playlistRefreshRule: "a1" }), true);
  const button = lastButton;
  await settle();
  assert.equal(button.textContent, "Refreshing", "the menu item says it is working");
  assert.equal(indicator.hidden, false, "the spinner shows left of the title");
  assert.equal(button.disabled, true);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(button.textContent, "Button", "the label comes back when the check finishes");
  assert.equal(indicator.hidden, true);
  assert.equal(button.disabled, false);
  assert.deepEqual(requests, [{ action: "list-refresh-rule", list_id: "a1" }]);
  assert.deepEqual(messages.at(-1), ["Playlist updated: 2 added, 1 removed.", "success"]);

  requests.length = 0;
  confirmAnswer = false;
  clickOn("[data-playlist-stop-rule]", { playlistStopRule: "a1" });
  await settle();
  assert.deepEqual(requests, [], "keeping it automatic sends nothing");
  confirmAnswer = true;
  clickOn("[data-playlist-stop-rule]", { playlistStopRule: "a1" });
  await settle();
  assert.deepEqual(requests, [{ action: "list-stop-rule", list_id: "a1" }]);
});

test("automatic playlists are not offered by add-to menus", () => {
  assert.equal(playlistAcceptsItem(automatic(), { media_type: "movie" }), false);
  assert.equal(playlistAcceptsItem(automatic({ rule: null }), { media_type: "movie" }), true);
});

test("the create dialog offers Automatic with a hidden rule editor; not when created for a title", () => {
  state.playlistProviders = [];
  openPlaylistDialog();
  assert.match(dialogBody, /name="mode" value="manual" checked/);
  assert.match(dialogBody, /name="mode" value="automatic"/);
  assert.match(dialogBody, /class="playlist-rule-editor" data-playlist-rule-editor/);
  assert.match(dialogBody, /data-wizard-tab="details" aria-current="step"/);
  assert.match(dialogBody, /data-wizard-tab="rule" hidden>/, "the Rule step shows only once Automatic is chosen");
  assert.match(dialogBody, /data-wizard-panel="apps" hidden/);
  assert.match(dialogBody, /data-wizard-finish hidden>Create playlist/, "Create waits for the last step");
  assert.match(dialogBody, /Choose Movies or TV to see its genres\./);

  openPlaylistDialog({ afterCreateItem: { title: "Heat", media_type: "movie" } });
  assert.doesNotMatch(dialogBody, /name="mode"|data-playlist-rule-editor/);

  openPlaylistDialog({ list: automatic({ rule: null }) });
  assert.doesNotMatch(dialogBody, /data-playlist-rule-editor/, "a manual playlist cannot be made automatic");
});

test("editing an automatic playlist shows its rule filled in", () => {
  openPlaylistDialog({ list: automatic() });
  assert.match(dialogBody, /class="playlist-rule-editor" data-playlist-rule-editor/);
  assert.match(dialogBody, /data-wizard-tab="rule">/, "an automatic playlist's Rule step is shown");
  assert.match(dialogBody, /data-wizard-finish>Save/, "Save is offered on every step when editing");
  assert.match(dialogBody, /name="ruleSource" value="library" checked/);
  assert.match(dialogBody, /<option value="1990" selected>1990s<\/option>/);
  assert.match(dialogBody, /<option value="unwatched" selected>Unwatched titles only<\/option>/);
  assert.match(dialogBody, /<option value="30" selected>In the last 30 days<\/option>/);
  assert.match(dialogBody, /name="ruleLimit"[^>]*value="50"/);
  assert.match(dialogBody, /data-selected="\[&quot;Comedy&quot;,&quot;Drama&quot;\]"/);

  openPlaylistDialog({ list: automatic({ kind: "tv", rule: { ...rule, source: "catalogue", yearFrom: 1985, yearTo: 1992, addedWithinDays: null, limit: 100 } }) });
  assert.match(dialogBody, /<option value="custom" selected>Choose years<\/option>/);
  assert.match(dialogBody, /name="ruleAdded" disabled/, "Recently added is for library playlists only");
  assert.match(dialogBody, /class="field-label hidden" data-playlist-rule-watched-field>/, "TV holds the next episode, so Watched is hidden");
  assert.match(dialogBody, /Most shows/);
  assert.match(dialogBody, /the show moves to Up Next for good/);
});

test("the Remove items once watched switch is on for a new playlist, prefilled when editing", () => {
  state.playlistProviders = [];
  openPlaylistDialog();
  assert.match(dialogBody, /Remove items once watched/);
  assert.match(dialogBody, /<input type="checkbox" name="removeWatched" checked \/>/);
  assert.match(dialogBody, /A movie or episode leaves this playlist, and every app, once you watch it\./);
  openPlaylistDialog({ list: automatic({ remove_watched: true }) });
  assert.match(dialogBody, /<input type="checkbox" name="removeWatched" checked \/>/);
  assert.doesNotMatch(dialogBody, /Up Next/, "a movie playlist has no show to hand on");
  openPlaylistDialog({ list: automatic({ rule: null, remove_watched: false }) });
  assert.match(dialogBody, /<input type="checkbox" name="removeWatched" \/>/);
});

function fakeForm(values, { checkedGenres = null, selected = [], languages = [] } = {}) {
  const genres = { dataset: { loaded: checkedGenres ? "1" : "0", selected: JSON.stringify(selected) }, querySelectorAll: () => (checkedGenres || []).map((value) => ({ value })) };
  const editor = {
    querySelectorAll: (selector) => (selector === "input[name=ruleLanguage]:checked" ? languages.map((value) => ({ value })) : []),
    querySelector: (selector) => {
      if (selector === "[data-playlist-rule-genres]") return genres;
      if (selector === "[data-playlist-rule-watched-field]") return { classList: { contains: () => values.watchedHidden === true } };
      if (selector === "input[name=ruleSource]:checked") return { value: values.source };
      const name = selector.match(/name=(\w+)/)?.[1];
      return name && name in values ? { value: values[name] } : null;
    },
  };
  return { querySelector: (selector) => (selector === "[data-playlist-rule-editor]" ? editor : null) };
}

test("the rule is read from the form: decades, chosen years, languages, and genres before and after loading", () => {
  assert.deepEqual(readRuleFromForm(fakeForm({ source: "library", ruleGenreMatch: "all", ruleYears: "1990", ruleWatched: "unwatched", ruleAdded: "30", ruleOrder: "random", ruleLimit: "" }, { checkedGenres: ["Comedy"], languages: ["en", "ko"] })), {
    source: "library", type: "top", genres: ["Comedy"], genreMatch: "all", languages: ["en", "ko"], yearFrom: 1990, yearTo: 1999, watched: "unwatched", addedWithinDays: 30, limit: null, order: "random",
  });
  assert.deepEqual(readRuleFromForm(fakeForm({ source: "catalogue", ruleGenreMatch: "any", ruleYears: "custom", ruleYearFrom: "2001", ruleYearTo: "", ruleWatched: "any", ruleAdded: "30", ruleType: "trending", ruleOrder: "rating", ruleLimit: "25" }, { selected: ["Drama"] })), {
    source: "catalogue", type: "trending", genres: ["Drama"], genreMatch: "any", languages: [], yearFrom: 2001, yearTo: null, watched: "any", addedWithinDays: null, limit: 25, order: "rating",
  });
  assert.equal(readRuleFromForm(fakeForm({ source: "library", ruleYears: "any", ruleWatched: "unwatched", ruleOrder: "newest", watchedHidden: true })).watched, "any", "a hidden Watched (TV) reads as any");
  assert.equal(readRuleFromForm({ querySelector: () => null }), null);
});
