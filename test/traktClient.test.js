import test from "node:test";
import assert from "node:assert/strict";
import { fetchTraktWatchedSnapshot, pollTraktDeviceAuth, setTraktWatchHistoryBatch, setTraktWatchState, startTraktDeviceAuth, trackerMediaKey, trackerMediaMatches } from "../server/src/utils/traktClient.js";

test("Trakt device authorization uses the API device endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body), headers: options.headers });
    return new Response(JSON.stringify(requests.length === 1
      ? { device_code: "device", user_code: "CODE", verification_url: "https://trakt.tv/activate", expires_in: 600, interval: 5 }
      : { access_token: "access", refresh_token: "refresh", expires_in: 604800 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await startTraktDeviceAuth("client");
    await pollTraktDeviceAuth({ deviceCode: "device", clientId: "client", clientSecret: "secret" });
    assert.equal(requests[0].url, "https://api.trakt.tv/oauth/device/code");
    assert.equal(requests[1].url, "https://api.trakt.tv/oauth/device/token");
    assert.match(requests[0].headers["user-agent"], /^Plembfin/);
    assert.deepEqual(requests[1].body, { code: "device", client_id: "client", client_secret: "secret" });
  } finally { globalThis.fetch = originalFetch; }
});

test("Trakt watched snapshots normalize movies and episodes onto stable series coordinates", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return new Response(JSON.stringify(String(url).includes("/movies") ? [{
      last_watched_at: "2026-08-15T10:00:00.000Z", movie: { title: "Arrival", year: 2016, ids: { trakt: 1, imdb: "tt2543164", tmdb: 329865 } },
    }] : [{
      show: { title: "Reacher", year: 2022, ids: { trakt: 2, tvdb: 366924, tmdb: 108978 } },
      seasons: [{ number: 1, episodes: [{ number: 1, last_watched_at: "2026-08-16T10:00:00.000Z", ids: { trakt: 3, tvdb: 900001 } }] }],
    }]), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const snapshot = await fetchTraktWatchedSnapshot({ clientId: "client", accessToken: "token" });
    assert.equal(snapshot.length, 2);
    assert.equal(snapshot[1].mediaKey, "episode:tmdb:108978:s1e1");
    assert.deepEqual(snapshot[1].media.ids, { trakt: 2, tvdb: 366924, tmdb: 108978 });
    assert.deepEqual(snapshot[1].media.trackerEpisodeIds, { trakt: 3, tvdb: 900001 });
    assert.ok(requestedUrls.some((url) => url.includes("/shows?") && url.includes("extended=progress")));
  } finally { globalThis.fetch = originalFetch; }
});

test("Trakt watched snapshots follow every pagination page", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    urls.push(value);
    const isMovies = value.includes("/movies");
    const page = Number(new URL(value).searchParams.get("page"));
    const rows = isMovies
      ? [{ last_watched_at: "2026-08-15T10:00:00.000Z", movie: { title: `Movie ${page}`, ids: { trakt: page } } }]
      : [{ show: { title: `Show ${page}`, ids: { trakt: 100 + page } }, seasons: [{ number: 1, episodes: [{ number: page, ids: { trakt: 200 + page } }] }] }];
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "content-type": "application/json", "x-pagination-page": String(page), "x-pagination-page-count": "2" },
    });
  };
  try {
    const snapshot = await fetchTraktWatchedSnapshot({ clientId: "client", accessToken: "token" });
    assert.equal(snapshot.length, 4);
    assert.equal(urls.length, 4);
    assert.ok(urls.every((url) => url.includes("limit=250")));
    assert.ok(urls.some((url) => url.includes("page=2")));
    assert.ok(urls.filter((url) => url.includes("/shows?")).every((url) => url.includes("extended=progress")));
  } finally { globalThis.fetch = originalFetch; }
});

test("Trakt watched snapshots reject show responses without season progress", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes("/movies") ? [] : [{
    show: { title: "Peaky Blinders", ids: { trakt: 60158, tvdb: 270915 } },
  }]), { status: 200, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(
      fetchTraktWatchedSnapshot({ clientId: "client", accessToken: "token" }),
      /did not include season progress/,
    );
  } finally { globalThis.fetch = originalFetch; }
});

test("tracker outbound matching bridges a stale episode id by exact show and coordinates", () => {
  const stale = {
    type: "episode",
    title: "Reacher - S03E01",
    showTitle: "Reacher",
    season: 3,
    episode: 1,
    ids: { tmdb: "old-series-id" },
  };
  const corrected = {
    type: "episode",
    title: "Reacher - S03E01",
    showTitle: "Reacher",
    season: 3,
    episode: 1,
    ids: { tmdb: "new-series-id" },
  };

  assert.equal(trackerMediaMatches(stale, corrected), true);
  assert.equal(trackerMediaMatches(stale, { ...corrected, episode: 2 }), false);
  assert.equal(trackerMediaMatches(stale, { ...corrected, showTitle: "Reachers" }), false);
});

test("Trakt episode writes use show IDs plus season and episode coordinates", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ added: { episodes: 1 } }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    const media = { type: "episode", season: 1, episode: 1, ids: { tvdb: 366924, tmdb: 108978 } };
    await setTraktWatchState({ clientId: "client", accessToken: "token" }, media, "watched");
    assert.equal(request.url, "https://api.trakt.tv/sync/history");
    assert.equal(request.body.shows[0].ids.tvdb, 366924);
    assert.equal(request.body.shows[0].seasons[0].episodes[0].number, 1);
    assert.equal(trackerMediaKey(media), "episode:tmdb:108978:s1e1");
  } finally { globalThis.fetch = originalFetch; }
});

test("Trakt watched writes send an explicit historical watched_at rather than the current time", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ added: { episodes: 1 } }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    const media = { type: "episode", season: 5, episode: 6, ids: { tmdb: 38772847 }, watched_at: "2026-08-12T12:00:00.000Z" };
    await setTraktWatchState({ clientId: "client", accessToken: "token" }, media, "watched");
    assert.equal(request.body.shows[0].seasons[0].episodes[0].watched_at, "2026-08-12T12:00:00.000Z");
  } finally { globalThis.fetch = originalFetch; }
});

test("Trakt restore batches preserve dates for movies and repeated episodes", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ added: { movies: 1, episodes: 2 } }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    await setTraktWatchHistoryBatch({ clientId: "client", accessToken: "token" }, [
      { type: "movie", ids: { tmdb: 329865 }, source: "restore_replay", watched_at: "2020-01-02T03:04:05.000Z" },
      { type: "episode", ids: { tmdb: 108978 }, season: 1, episode: 2, source: "restore_replay", watched_at: "2021-02-03T04:05:06.000Z" },
      { type: "episode", ids: { tmdb: 108978 }, season: 1, episode: 3, source: "restore_replay", watched_at: "2022-03-04T05:06:07.000Z" },
    ], "watched");
    assert.equal(request.url, "https://api.trakt.tv/sync/history");
    assert.equal(request.body.movies[0].watched_at, "2020-01-02T03:04:05.000Z");
    assert.equal(request.body.shows[0].seasons[0].number, 1);
    assert.deepEqual(request.body.shows[0].seasons[0].episodes.map((item) => item.watched_at), [
      "2021-02-03T04:05:06.000Z",
      "2022-03-04T05:06:07.000Z",
    ]);
  } finally { globalThis.fetch = originalFetch; }
});

test("Trakt restore writes fail closed when a historical date is missing", async () => {
  assert.throws(
    () => setTraktWatchHistoryBatch({ clientId: "client", accessToken: "token" }, [{ type: "movie", ids: { tmdb: 1 }, source: "restore_replay" }], "watched"),
    /requires a valid watched_at timestamp/,
  );
});
