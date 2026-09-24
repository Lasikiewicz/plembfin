import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-plex-same-title-search-");

const { __resetPlexIdentityCache, findPlexItem } = await import("../server/src/utils/plexClient.js");
const { resetOutboundGovernor } = await import("../server/src/utils/outboundGovernor.js");

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Live shape (23 September 2026): the guid lookup finds nothing, /search lists
// both Scrubs shows without Guids, and the 2001 show comes first.
const shows = {
  3258: { ratingKey: "3258", type: "show", title: "Scrubs", year: 2001, Guid: [{ id: "imdb://tt0285403" }, { id: "tmdb://4556" }, { id: "tvdb://76156" }] },
  3307: { ratingKey: "3307", type: "show", title: "Scrubs (2026)", year: 2026, Guid: [{ id: "imdb://tt40197357" }, { id: "tmdb://295778" }, { id: "tvdb://465690" }] },
};
const leaves = {
  3258: [{ ratingKey: "3262", type: "episode", parentIndex: 1, index: 3 }],
  3307: [{ ratingKey: "3311", type: "episode", parentIndex: 1, index: 3 }],
};

function stubPlex({ withGuids = true } = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/search") {
      return response({ MediaContainer: { Metadata: Object.values(shows).map(({ Guid, ...rest }) => rest) } });
    }
    const leavesMatch = url.pathname.match(/^\/library\/metadata\/(\d+)\/allLeaves$/);
    if (leavesMatch) return response({ MediaContainer: { Metadata: leaves[leavesMatch[1]] || [] } });
    const metaMatch = url.pathname.match(/^\/library\/metadata\/(\d+)$/);
    if (metaMatch) {
      const show = shows[metaMatch[1]];
      if (!show) return response({}, 404);
      return response({ MediaContainer: { Metadata: [withGuids ? show : { ...show, Guid: [] }] } });
    }
    return response({ MediaContainer: { Metadata: [] } });
  };
  return () => { globalThis.fetch = originalFetch; };
}

const config = { baseUrl: "http://127.0.0.1:32400", token: "token" };
const episode = (ids) => ({ type: "episode", title: "Scrubs - S01E03", season: 1, episode: 3, ids });

test("a year-less title search does not resolve the reboot to the same-title 2001 show", async () => {
  resetOutboundGovernor();
  __resetPlexIdentityCache();
  const restore = stubPlex();
  try {
    const reboot = await findPlexItem(config, episode({ imdb: "tt40197357", tmdb: "295778", tvdb: "465690" }));
    assert.equal(reboot?.ratingKey, "3311");
    const original = await findPlexItem(config, episode({ imdb: "tt0285403", tmdb: "4556", tvdb: "76156" }));
    assert.equal(original?.ratingKey, "3262");
  } finally {
    restore();
  }
});

test("a watch record mixing episode imdb/tvdb ids with the show tmdb id still finds its show", async () => {
  resetOutboundGovernor();
  __resetPlexIdentityCache();
  const restore = stubPlex();
  try {
    // Live 23 September 2026: rejecting any differing id sent this 2001 watch to
    // Plex as NOT FOUND. The reboot's record shape must still find the reboot.
    assert.equal((await findPlexItem(config, episode({ imdb: "tt0696544", tmdb: "4556", tvdb: "184607" })))?.ratingKey, "3262");
    __resetPlexIdentityCache();
    assert.equal((await findPlexItem(config, episode({ imdb: "tt39758825", tmdb: "295778", tvdb: "11426444" })))?.ratingKey, "3311");
  } finally {
    restore();
  }
});

test("a lone title match whose ids contradict the request's show ids is not the show", async () => {
  resetOutboundGovernor();
  __resetPlexIdentityCache();
  const restore = stubPlex();
  const saved = shows[3307];
  delete shows[3307];
  try {
    // Live 23 September 2026 (Jellyfin): the Australian "The Assembly" card,
    // whose show is in no library, resolved to the UK show's S01E01.
    const other = { ...episode({ imdb: "tt40197357", tmdb: "295778", tvdb: "465690" }), show_tmdb_id: "295778", show_tvdb_id: "465690" };
    assert.equal(await findPlexItem(config, other), undefined);
    __resetPlexIdentityCache();
    // The same show ids on the only show in the library still resolve.
    const same = { ...episode({ tmdb: "4556" }), show_tmdb_id: "4556", show_tvdb_id: "76156" };
    assert.equal((await findPlexItem(config, same))?.ratingKey, "3262");
  } finally {
    shows[3307] = saved;
    restore();
  }
});

test("a show Plex titles with a trailing qualifier resolves only when its Guids share an id", async () => {
  resetOutboundGovernor();
  __resetPlexIdentityCache();
  // Live 23 September 2026: the UK The Assembly card had no Plex link because
  // Plex titles the show "The Assembly (UK)" and the guid lookup finds nothing.
  const savedShows = { ...shows };
  const savedLeaves = { ...leaves };
  for (const key of Object.keys(shows)) delete shows[key];
  shows[3575] = { ratingKey: "3575", type: "show", title: "The Assembly (UK)", year: 2024, Guid: [{ id: "imdb://tt8064568" }, { id: "tmdb://290057" }, { id: "tvdb://453869" }] };
  leaves[3575] = [{ ratingKey: "3581", type: "episode", parentIndex: 1, index: 5 }];
  const restore = stubPlex();
  const assembly = (ids, showIds = {}) => ({ type: "episode", title: "The Assembly - S01E05", season: 1, episode: 5, ids, ...showIds });
  try {
    const uk = assembly({ imdb: "tt8064568", tmdb: "290057", tvdb: "453869" }, { show_tmdb_id: "290057", show_tvdb_id: "453869" });
    assert.equal((await findPlexItem(config, uk))?.ratingKey, "3581");
    __resetPlexIdentityCache();
    // The Australian show (no library holds it) and an id-less request stay unresolved.
    const australian = assembly({ tmdb: "262100", tvdb: "452480" }, { show_tmdb_id: "262100", show_tvdb_id: "452480" });
    assert.equal(await findPlexItem(config, australian), undefined);
    __resetPlexIdentityCache();
    assert.equal(await findPlexItem(config, assembly({})), undefined);
  } finally {
    for (const key of Object.keys(shows)) delete shows[key];
    Object.assign(shows, savedShows);
    delete leaves[3575];
    Object.assign(leaves, savedLeaves);
    restore();
  }
});

test("id-less requests, requests sharing no id, and Guid-less candidates keep the first title match", async () => {
  resetOutboundGovernor();
  __resetPlexIdentityCache();
  let restore = stubPlex();
  try {
    assert.equal((await findPlexItem(config, episode({})))?.ratingKey, "3262");
    __resetPlexIdentityCache();
    assert.equal((await findPlexItem(config, episode({ imdb: "tt9999999" })))?.ratingKey, "3262");
  } finally {
    restore();
  }
  __resetPlexIdentityCache();
  restore = stubPlex({ withGuids: false });
  try {
    assert.equal((await findPlexItem(config, episode({ imdb: "tt40197357" })))?.ratingKey, "3262");
  } finally {
    restore();
  }
});
