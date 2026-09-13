import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-up-next-provider-sync-");
const { planUpNextProviderSync, syncUpNextToProviders } = await import("../server/src/utils/upNextProviderSync.js");

test("disabled Up Next provider sync returns without contacting media servers", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("fetch should not be called when Up Next sync is disabled");
  };
  try {
    const summary = await syncUpNextToProviders({
      desiredItems: [{ id: "item-1", title: "Item 1" }],
      config: { upNextSync: { enabled: false } },
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.disabled, true);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Up Next provider reconciliation preserves visible ids and dismisses only stale removable resume items", () => {
  const plan = planUpNextProviderSync({
    desiredItems: [
      { provider_items: { plex: ["plex-keep"], emby: ["emby-keep"], jellyfin: ["jelly-keep"] } },
    ],
    feeds: [
      {
        provider: "plex",
        feed_kind: "resume",
        status: "succeeded",
        supportsDismissal: true,
        items: [
          { provider_item_id: "plex-keep", title: "Keep" },
          { provider_item_id: "plex-remove", title: "Remove" },
        ],
      },
      {
        provider: "emby",
        feed_kind: "resume",
        status: "succeeded",
        supportsDismissal: true,
        items: [{ provider_item_id: "emby-keep", title: "Keep" }],
      },
    ],
  });

  assert.deepEqual(plan.desiredProviderIds, {
    plex: ["plex-keep"],
    emby: ["emby-keep"],
    jellyfin: ["jelly-keep"],
  });
  assert.deepEqual(plan.dismissals, [{
    provider: "plex",
    feed_kind: "resume",
    provider_item_id: "plex-remove",
    title: "Remove",
  }]);
  assert.deepEqual(plan.unsupported, []);
});

test("native Emby Next Up items are reported as unsupported instead of being marked watched or hidden", () => {
  const plan = planUpNextProviderSync({
    desiredItems: [{ provider_items: { emby: ["emby-keep"] } }],
    feeds: [{
      provider: "emby",
      feed_kind: "next_up",
      status: "succeeded",
      supportsDismissal: false,
      items: [
        { provider_item_id: "emby-keep", title: "Keep" },
        { provider_item_id: "emby-other", title: "Other" },
      ],
    }],
  });

  assert.deepEqual(plan.dismissals, []);
  assert.deepEqual(plan.unsupported, [{
    provider: "emby",
    feed_kind: "next_up",
    provider_item_id: "emby-other",
    title: "Other",
  }]);
});

test("pushing the merged Up Next rail reconciles the Plex and Emby playlists and native feeds", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const plexPlaylistItems = [
    { ratingKey: "plex-keep", playlistItemID: "plex-entry-keep" },
    { ratingKey: "plex-stale", playlistItemID: "plex-entry-stale" },
  ];
  const embyPlaylistItems = [
    { Id: "emby-keep", PlaylistItemId: "emby-entry-keep" },
    { Id: "emby-stale", PlaylistItemId: "emby-entry-stale" },
  ];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    calls.push({ url, options: { ...options, method } });
    if (method === "PUT" && url.pathname === "/actions/removeFromContinueWatching") {
      return new Response("", { status: 200 });
    }
    if (method === "POST" && url.pathname.endsWith("/HideFromResume")) {
      return new Response("", { status: 200 });
    }
    if (method === "PUT" && url.pathname === "/playlists/plex-up-next/items") {
      const uri = url.searchParams.get("uri") || "";
      const ratingKey = decodeURIComponent(uri.split("/metadata/").pop() || "");
      if (ratingKey && !plexPlaylistItems.some((item) => item.ratingKey === ratingKey)) {
        plexPlaylistItems.push({ ratingKey, playlistItemID: `plex-entry-${ratingKey}` });
      }
      return new Response("", { status: 200 });
    }
    if (method === "DELETE" && url.pathname.startsWith("/playlists/plex-up-next/items/")) {
      const entryId = decodeURIComponent(url.pathname.split("/").pop() || "");
      const index = plexPlaylistItems.findIndex((item) => item.playlistItemID === entryId);
      if (index >= 0) plexPlaylistItems.splice(index, 1);
      return new Response("", { status: 200 });
    }
    if (method === "POST" && url.pathname === "/Playlists/emby-up-next/Items") {
      const ids = String(url.searchParams.get("Ids") || "").split(",").filter(Boolean);
      for (const id of ids) {
        if (!embyPlaylistItems.some((item) => item.Id === id)) {
          embyPlaylistItems.push({ Id: id, PlaylistItemId: `emby-entry-${id}` });
        }
      }
      return new Response(JSON.stringify({ ItemAddedCount: ids.length }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "DELETE" && url.pathname === "/Playlists/emby-up-next/Items") {
      const entryIds = new Set(String(url.searchParams.get("EntryIds") || "").split(",").filter(Boolean));
      for (let index = embyPlaylistItems.length - 1; index >= 0; index -= 1) {
        if (entryIds.has(embyPlaylistItems[index].PlaylistItemId)) embyPlaylistItems.splice(index, 1);
      }
      return new Response("", { status: 200 });
    }

    let body = { Items: [] };
    if (method === "GET" && url.pathname === "/playlists") {
      body = { MediaContainer: { Metadata: [{ type: "playlist", ratingKey: "plex-up-next", title: "Plembfin Up Next" }] } };
    } else if (method === "GET" && url.pathname === "/playlists/plex-up-next/items") {
      body = { MediaContainer: { Metadata: [...plexPlaylistItems] } };
    } else if (method === "GET" && url.pathname === "/Users/emby-user/Items") {
      body = { Items: [{ Id: "emby-up-next", Name: "Plembfin Up Next", Type: "Playlist" }] };
    } else if (method === "GET" && url.pathname === "/Playlists/emby-up-next/Items") {
      body = { Items: [...embyPlaylistItems], TotalRecordCount: embyPlaylistItems.length };
    }
    if (method === "GET" && url.pathname === "/hubs/continueWatching") {
      body = {
        MediaContainer: {
          Hub: [{ Metadata: [
            {
              ratingKey: "plex-keep",
              type: "episode",
              title: "Shared Show - S01E02",
              grandparentTitle: "Shared Show",
              parentIndex: 1,
              index: 2,
            },
            {
              ratingKey: "plex-stale",
              type: "episode",
              title: "Plex stale item",
            },
            {
              ratingKey: "plex-identity",
              type: "episode",
              title: "Identity Show - S01E03",
              grandparentTitle: "Identity Show",
              parentIndex: 1,
              index: 3,
            },
          ] }],
        },
      };
    } else if (method === "GET" && url.pathname.endsWith("/Items/Resume")) {
      body = {
        Items: [
          {
            Id: "emby-keep",
            Type: "Episode",
            Name: "Shared Show - S01E02",
            SeriesName: "Shared Show",
            ParentIndexNumber: 1,
            IndexNumber: 2,
          },
          { Id: "emby-stale", Type: "Episode", Name: "Emby stale item" },
          {
            Id: "emby-identity",
            Type: "Episode",
            Name: "Identity Show - S01E03",
            SeriesName: "Identity Show",
            ParentIndexNumber: 1,
            IndexNumber: 3,
          },
        ],
      };
    } else if (method === "GET" && url.pathname.endsWith("/Shows/NextUp")) {
      body = { Items: [{ Id: "emby-next-up", Type: "Episode", Name: "Emby calculated next up" }] };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const summary = await syncUpNextToProviders({
    desiredItems: [{
      id: "shared-show-s01e02",
      media_key: "shared-show-s01e02",
      media_type: "episode",
      title: "Shared Show - S01E02",
      show_title: "Shared Show",
      season: 1,
      episode: 2,
      provider_items: { plex: ["plex-keep"], emby: ["emby-keep"] },
    }, {
      id: "identity-show-s01e03",
      media_key: "identity-show-s01e03",
      media_type: "episode",
      title: "Identity Show - S01E03",
      show_title: "Identity Show",
      season: 1,
      episode: 3,
      provider_items: { plex: ["plex-identity"], emby: ["emby-identity"] },
    }],
    config: {
      plex: { baseUrl: "http://plex.test", token: "plex-token", serverId: "plex-server-id" },
      emby: { baseUrl: "http://emby.test", apiKey: "emby-key", userId: "emby-user" },
    },
  });

  assert.deepEqual(summary.pushedProviders, ["plex", "emby"]);
  assert.deepEqual(summary.providerDismissals.map(({ provider, feed_kind, provider_item_id, status }) => ({
    provider,
    feed_kind,
    provider_item_id,
    status,
  })), [
    { provider: "plex", feed_kind: "resume", provider_item_id: "plex-stale", status: "fulfilled" },
    { provider: "emby", feed_kind: "resume", provider_item_id: "emby-stale", status: "fulfilled" },
  ]);
  const mutations = calls.filter(({ options }) => options.method !== "GET");
  const mutationKeys = mutations.map(({ url, options }) => `${options.method} ${url.pathname}`);
  assert.ok(mutationKeys.includes("PUT /actions/removeFromContinueWatching"));
  assert.ok(mutationKeys.includes("POST /Users/emby-user/Items/emby-stale/HideFromResume"));
  assert.ok(mutationKeys.includes("PUT /playlists/plex-up-next/items"));
  assert.ok(mutationKeys.includes("DELETE /playlists/plex-up-next/items/plex-entry-stale"));
  assert.ok(mutationKeys.includes("POST /Playlists/emby-up-next/Items"));
  assert.ok(mutationKeys.includes("DELETE /Playlists/emby-up-next/Items"));
  assert.deepEqual(plexPlaylistItems.map((item) => item.ratingKey).sort(), ["plex-identity", "plex-keep"].sort());
  assert.deepEqual(embyPlaylistItems.map((item) => item.Id).sort(), ["emby-identity", "emby-keep"].sort());
  assert.deepEqual(summary.playlists
    .filter((playlist) => playlist.provider !== "jellyfin")
    .map((playlist) => ({ provider: playlist.provider, status: playlist.status, final_count: playlist.final_count, missing_count: playlist.missing_count })), [
    { provider: "plex", status: "succeeded", final_count: 2, missing_count: 0 },
    { provider: "emby", status: "succeeded", final_count: 2, missing_count: 0 },
  ]);
  // Unconfigured here, so it is reported rather than contacted.
  assert.equal(summary.playlists.find((playlist) => playlist.provider === "jellyfin")?.status, "not_configured");
  assert.deepEqual(new Set(summary.unsupported.map(({ provider }) => provider)), new Set(["emby"]));
  assert.deepEqual(summary.feeds.map((feed) => [feed.provider, feed.feed_kind, feed.status]), [
    ["plex", "resume", "succeeded"],
    ["emby", "resume", "succeeded"],
    ["emby", "next_up", "succeeded"],
    ["jellyfin", "resume", "not_configured"],
    ["jellyfin", "next_up", "not_configured"],
  ]);
});

test("configured Jellyfin takes part in the Up Next push", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push(url);
    return new Response(JSON.stringify({ Items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const summary = await syncUpNextToProviders({
      desiredItems: [],
      config: {
        jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "jellyfin-key", userId: "jelly-user" },
      },
    });
    assert.deepEqual(summary.feeds
      .filter((feed) => feed.provider === "jellyfin")
      .map((feed) => [feed.feed_kind, feed.status]), [
      ["resume", "succeeded"],
      ["next_up", "succeeded"],
    ]);
    assert.ok(calls.some((url) => url.hostname === "jellyfin.test"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the Jellyfin push maintains its playlist and seeds its resume rail", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const playlistItems = [{ Id: "jelly-stale", PlaylistItemId: "jelly-entry-stale" }];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    calls.push({ url, method });

    if (method === "POST" && url.pathname === "/Playlists/jelly-up-next/Items") {
      for (const id of String(url.searchParams.get("ids") || "").split(",").filter(Boolean)) {
        if (!playlistItems.some((item) => item.Id === id)) {
          playlistItems.push({ Id: id, PlaylistItemId: `jelly-entry-${id}` });
        }
      }
      return new Response(JSON.stringify({ ItemAddedCount: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "DELETE" && url.pathname === "/Playlists/jelly-up-next/Items") {
      const entryIds = new Set(String(url.searchParams.get("entryIds") || "").split(",").filter(Boolean));
      for (let index = playlistItems.length - 1; index >= 0; index -= 1) {
        if (entryIds.has(playlistItems[index].PlaylistItemId)) playlistItems.splice(index, 1);
      }
      return new Response("", { status: 200 });
    }
    if (method === "POST") return new Response(null, { status: 204 });

    let body = { Items: [] };
    if (url.pathname === "/Users/jelly-user/Items" && url.searchParams.get("IncludeItemTypes") === "Playlist") {
      body = { Items: [{ Id: "jelly-up-next", Name: "Plembfin Up Next", Type: "Playlist" }] };
    } else if (url.pathname === "/Playlists/jelly-up-next/Items") {
      body = { Items: [...playlistItems], TotalRecordCount: playlistItems.length };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const summary = await syncUpNextToProviders({
    desiredItems: [{
      id: "jelly-show-s01e02",
      media_key: "jelly-show-s01e02",
      media_type: "episode",
      title: "Jelly Show - S01E02",
      show_title: "Jelly Show",
      season: 1,
      episode: 2,
      duration_ms: 2700000,
      provider_items: { jellyfin: ["jelly-keep"] },
    }],
    config: {
      jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "jellyfin-key", userId: "jelly-user" },
    },
  });

  const playlist = summary.playlists.find((entry) => entry.provider === "jellyfin");
  assert.equal(playlist.status, "succeeded");
  assert.deepEqual(playlistItems.map((item) => item.Id), ["jelly-keep"]);

  // The item is not on Jellyfin's resume feed (it is empty here), so the push
  // seeds it rather than skipping it, at 6% of the 45-minute runtime.
  const seed = summary.railSeeds.find((entry) => entry.provider === "jellyfin");
  assert.equal(seed.seeded_count, 1);
  assert.equal(seed.results[0].position_ms, 162000);
  assert.ok(calls.some(({ url, method }) => method === "POST" && /\/Items\/jelly-keep\/UserData$/.test(url.pathname)));
});

test("an Emby rail seed is reported as a playback session, then has its play count restored", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    if (method === "POST") {
      calls.push({ path: url.pathname, body: String(options.body || ""), auth: options.headers?.["X-Emby-Authorization"] || "" });
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ Items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { reportEmbyResumePosition } = await import("../server/src/utils/embyClient.js");
  const result = await reportEmbyResumePosition(
    { baseUrl: "http://emby.test", apiKey: "k", userId: "u" },
    "12105",
    162000,
  );

  assert.equal(result.status, "fulfilled");
  const paths = calls.map((call) => call.path);
  assert.deepEqual(paths, [
    "/Sessions/Playing",
    "/Sessions/Playing/Progress",
    "/Sessions/Playing/Stopped",
    "/Users/u/Items/12105/UserData",
  ]);
  // The session calls need a device identity or Emby rejects them.
  assert.match(calls[0].auth, /DeviceId="plembfin-up-next-seed"/);
  // 162000ms in ticks.
  assert.match(calls[1].body, /"PositionTicks":1620000000/);
  // The session increments PlayCount, so the pin puts it back.
  assert.match(calls[3].body, /"PlayCount":0/);
  assert.match(calls[3].body, /"Played":false/);
});

test("an empty Emby resume feed falls back to the legacy resumable query", async (t) => {
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    paths.push(url.pathname + (url.searchParams.get("Filters") ? `?Filters=${url.searchParams.get("Filters")}` : ""));
    let body = { Items: [] };
    // The native endpoint answers 200 with nothing, which on some servers is
    // true even while real part-watches exist.
    if (url.pathname.endsWith("/Items") && url.searchParams.get("Filters") === "IsResumable") {
      body = {
        Items: [{ Id: "emby-real-resume", Type: "Episode", Name: "A Genuine Part Watch", UserData: { PlaybackPositionTicks: 21851513750 } }],
        TotalRecordCount: 1,
      };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { fetchEmbyResumableItems } = await import("../server/src/utils/embyClient.js");
  const items = await fetchEmbyResumableItems({ baseUrl: "http://emby.test", apiKey: "k", userId: "emby-user" }, { limit: 0 });

  assert.deepEqual(items.map((item) => item.Id), ["emby-real-resume"]);
  assert.ok(paths.some((path) => path.endsWith("/Items/Resume")), "the native endpoint is still tried first");
  assert.ok(paths.some((path) => path.includes("Filters=IsResumable")), "and the legacy query is consulted when it comes back empty");
});
