import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import "./domStubs.js";

// Small core and route helpers split out of app.js, app-events.js, and the
// larger route modules during the application-speed work. These run in Node
// against the real modules with a minimal DOM and a stubbed fetch.
globalThis.document.querySelector = () => null;
globalThis.document.querySelectorAll = () => [];

const read = (file) => fs.readFileSync(path.resolve(import.meta.dirname, "..", file), "utf8");
const appSource = read("public/app.js");

const { state } = await import("../public/modules/state.js");
const utils = await import("../public/modules/utils.js");
const { nowPlayingHref } = await import("../public/modules/media-routing.js");
const { dedupeMediaRecords, mediaRecordIdentity } = await import("../public/modules/media-records.js");
const { isShowInUpNext, manualShowMatches, upNextShowActionHtml } = await import("../public/modules/up-next-shared.js");
const { loadManualWatchReviewSummary } = await import("../public/modules/status-indicators.js");
const { hydratePersonalMetadata } = await import("../public/modules/personal-media-metadata.js");
const { refreshRatingSyncStatus } = await import("../public/modules/rating-sync-settings.js");
const { loadSyncHistory } = await import("../public/modules/sync.js");
const { applyLiveHistoryChanges } = await import("../public/modules/media-detail-events.js");

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const body = await handler(String(url), options);
    return { ok: true, status: 200, json: async () => body };
  };
  return calls;
}

test("build versions format in core utils, so the sidebar badge never waits for Settings", () => {
  assert.equal(utils.formatBuildVersion("1.1.1.0.0"), "1.1.1");
  assert.equal(utils.formatBuildVersion("v1.1.1.2.0"), "1.1.1.2");
  assert.equal(utils.formatBuildVersion("1.1.1.0.3"), "1.1.1.0.3");
  assert.equal(utils.versionDisplayLabel("1.1.1", "release"), "1.1.1");
  assert.equal(utils.versionDisplayLabel("1.1.1", "alpha", { version: "1.1.1.2.0" }), "1.1.1.2 (Alpha)");
  assert.equal(utils.versionDisplayLabel("1.1.1", "develop", null, { version: "1.1.1.0.4" }), "1.1.1.0.4");
  // Regression: app.js once read formatBuildVersion from the Settings-only
  // changelog module, so every other page rendered a bare "v" badge.
  assert.doesNotMatch(appSource, /formatBuildVersion = lazyNoop/);
  assert.match(appSource, /versionDisplayLabel \} from "\.\/modules\/utils\.js/);
});

test("list dates format without the Stats route module", () => {
  assert.match(utils.formatListDate("2026-09-14"), /2026/);
  assert.equal(utils.formatListDate(""), "");
  assert.equal(utils.formatListDate("not a date"), "");
});

test("Now Playing links resolve TV sessions to the show and movies by id or title", () => {
  assert.equal(
    nowPlayingHref({ mediaType: "episode", ids: { tmdb: 1399 }, showTitle: "Game of Thrones" }),
    utils.tvShowTmdbHref(1399, utils.showName("Game of Thrones")),
  );
  assert.equal(nowPlayingHref({ season: 1, episode: 2, showTitle: "Ludwig" }), `/tvshow/${utils.slug("Ludwig")}`);
  assert.equal(nowPlayingHref({ mediaType: "movie", tmdb_id: 447332, title: "A Quiet Place" }), utils.movieTmdbHref(447332, "A Quiet Place"));
  const movie = { id: "hist-7", media_type: "movie", title: "Bad Grandpa" };
  state.history = [movie];
  assert.equal(nowPlayingHref({ mediaType: "movie", id: "hist-7", title: "Bad Grandpa" }), utils.movieHref(movie));
  state.history = [];
});

test("Now Playing TV fallback reuses a loaded local show identity when the provider omits ids", () => {
  state.showsRaw = [{ title: "Ludwig", tmdb_id: 243360 }];
  assert.equal(
    nowPlayingHref({ mediaType: "episode", season: 2, episode: 3, showTitle: "Ludwig (2024)" }),
    utils.tvShowTmdbHref(243360, "Ludwig"),
  );
  state.showsRaw = [];
});

test("media records dedupe by show identity and keep the latest watch", () => {
  const older = { media_type: "episode", show_tmdb_id: 100, show_title: "Reacher", watched_at: "2026-01-01" };
  const newer = { media_type: "episode", show_tmdb_id: 100, show_title: "Reacher", watched_at: "2026-02-01" };
  assert.equal(mediaRecordIdentity(older), "show:tmdb:100");
  assert.deepEqual(dedupeMediaRecords([older, newer]), [newer]);
  const poster = { media_type: "movie", title: "Heat", poster_url: "https://image.tmdb.org/t/p/w342/heat.jpg?x=1" };
  assert.equal(mediaRecordIdentity(poster), "movie:poster:tmdb-poster:heat.jpg");
});

test("Up Next show helpers match across id field spellings and escape markup", () => {
  assert.equal(manualShowMatches({ tvdb_id: 42 }, { show_tvdb_id: "42" }), true);
  assert.equal(manualShowMatches({ title: "Ted Lasso" }, { show_title: "ted lasso" }), true);
  assert.equal(manualShowMatches({ title: "Silo" }, { title: "Slow Horses" }), false);
  state.upNextManualShows = [];
  state.upNextItems = [{ media_type: "movie", tmdb_id: 5, title: "Heat" }, { media_type: "episode", show_tmdb_id: 7, show_title: "Silo" }];
  assert.equal(isShowInUpNext({ tmdb_id: 5, title: "Heat" }), false, "a movie item is never a show in Up Next");
  assert.equal(isShowInUpNext({ tmdb_id: 7, title: "Silo" }), true);
  const html = upNextShowActionHtml({ tmdb_id: 7, title: `Bob's "Show"` });
  assert.match(html, /data-up-next-show-action="remove"/);
  assert.doesNotMatch(html, /"Show""/);
  state.upNextItems = [];
});

test("the Manual Watch review summary shares one in-flight request", async () => {
  state.token = "session";
  const calls = stubFetch(async () => ({ ok: true, count: 3 }));
  const [first, second] = await Promise.all([loadManualWatchReviewSummary(), loadManualWatchReviewSummary()]);
  assert.equal(calls.length, 1);
  assert.equal(first, 3);
  assert.equal(second, 3);
  assert.equal(state.manualWatchReviewCount, 3);
  state.token = "";
  assert.equal(await loadManualWatchReviewSummary(), 0, "signed out: no request, count cleared");
  assert.equal(calls.length, 1);
});

test("personal metadata fill asks only about the page being viewed", async () => {
  state.token = "session";
  state.activeView = "custom-lists";
  state.personalMediaTab = "lists";
  state.tmdbDetailsCache = new Map();
  state.personalRatings = [{ media_type: "movie", tmdb_id: 1, title: "Rated" }];
  state.personalWatchlist = [{ media_type: "movie", tmdb_id: 2, title: "Saved" }];
  state.personalLists = [{ id: "l1", items: [{ media_type: "movie", tmdb_id: 3, title: "Listed" }] }];
  const requested = [];
  stubFetch(async (url, options) => {
    const items = JSON.parse(options.body || "{}").items || [];
    requested.push(...items.map((item) => item.tmdbId));
    return { results: items.map((item) => ({ details: { id: item.tmdbId, overview: `About ${item.tmdbId}`, release_date: "2020-01-01" } })) };
  });
  const changed = await hydratePersonalMetadata({ normalizeItem: (item) => item });
  assert.equal(changed, true);
  assert.deepEqual(requested, [3], "ratings and watchlist items are not fetched from Custom Lists");
  assert.equal(state.personalLists[0].items[0].overview, "About 3");
  assert.equal(state.personalRatings[0].overview, undefined);
  state.token = "";
});

test("Settings status reuse: page open and saved-config apply share one request, saves always refetch", async () => {
  state.token = "session";
  const calls = stubFetch(async () => ({ providers: [] }));
  await Promise.all([refreshRatingSyncStatus({ maxAgeMs: 2000 }), refreshRatingSyncStatus({ maxAgeMs: 2000 })]);
  assert.equal(calls.length, 1, "concurrent reuse callers share the request");
  await refreshRatingSyncStatus({ maxAgeMs: 2000 });
  assert.equal(calls.length, 1, "a status fetched moments ago is reused");
  await refreshRatingSyncStatus();
  assert.equal(calls.length, 2, "an explicit refresh (after a save) always fetches");
  state.token = "";
});

test("sync history is reused within one Settings navigation but a forced load refetches", async () => {
  state.token = "session";
  state.syncHistoryLoaded = false;
  const calls = stubFetch(async () => ({ history: [{ id: 1 }] }));
  await loadSyncHistory({ maxAgeMs: 5000 });
  await loadSyncHistory({ maxAgeMs: 5000 });
  assert.equal(calls.length, 1);
  await loadSyncHistory({ force: true });
  assert.equal(calls.length, 2);
  state.token = "";
});

test("provider history changes fall back to the durable record id after identity repair rewrites the key", async () => {
  state.token = "session";
  state.history = [];
  state.partWatchedRaw = [];
  state.showsRaw = [];
  const recordId = "provider-watch-1";
  const calls = stubFetch(async (url) => {
    if (url.includes("/api/history?mediaKey=")) return { items: [{ mediaKey: "episode:2:5:tvdb:11756906", row: null, progress: null }] };
    if (url === `/api/history?id=${recordId}`) {
      return {
        row: {
          id: recordId,
          media_key: "episode:2:5:tvdb:435298",
          media_type: "episode",
          title: "Ludwig - S02E05",
          show_title: "Ludwig",
          season: 2,
          episode: 5,
          watched_at: "2026-09-18T22:33:38.585Z",
          sync_action: "watched",
          source: "emby",
        },
        progress: null,
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  const applied = await applyLiveHistoryChanges([{
    sourceTable: "watch_history",
    changeKind: "upsert",
    mediaKey: "episode:2:5:tvdb:11756906",
    recordId,
    mediaType: "episode",
    season: 2,
    episode: 5,
    showTitle: "Ludwig",
  }]);

  assert.equal(applied, 1);
  assert.equal(state.history[0]?.id, recordId);
  assert.equal(state.history[0]?.media_key, "episode:2:5:tvdb:435298");
  assert.equal(calls.length, 2, "the stale keyed lookup is followed by one durable-id lookup");
  state.token = "";
  state.history = [];
  state.partWatchedRaw = [];
  state.showsRaw = [];
});

test("a finished setup never downloads the onboarding wizard", () => {
  const dashboardSource = read("public/modules/dashboard.js");
  assert.doesNotMatch(dashboardSource, /from "\.\/onboarding\.js/, "the dashboard must not statically import the wizard");
  assert.match(dashboardSource, /ifLoaded\("onboarding", "renderDashboardChecklist"\)/);
  const check = appSource.slice(appSource.indexOf("Keep the large wizard graph out of the first authenticated render"), appSource.indexOf("isConfigSensitiveRoute(fullPath) && !state.mustChangePassword"));
  assert.match(check, /fetch\("\/api\/setup\/status"/);
  assert.match(check, /if \(ok && done && !data\?\.checklist\?\.length\) return;/);
  assert.match(check, /loadRouteModule\("onboarding"\)\.then\(\(\) => loadSetupStatus\(\)\)/);
});

test("refresh-job status is resumed from Settings, not on every page", () => {
  assert.doesNotMatch(appSource, /scheduleDeferredStartupWork\(startDeferredStatusWork\);\s*resumeActiveRefreshJobs\(\);/);
  const lifecycle = appSource.slice(appSource.indexOf("function syncSettingsStatusLifecycle()"), appSource.indexOf("function applyActiveViewNow()"));
  assert.match(lifecycle, /resumeActiveRefreshJobs\(\);/);
});
