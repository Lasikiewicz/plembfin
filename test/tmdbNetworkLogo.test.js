import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-network-logo-test-"));
process.env.DATA_DIR = dataDir;
process.env.TMDB_API_KEY = "test-key";

const { db, toJson } = await import("../server/src/db.js");
const { getTmdbDetails } = await import("../server/src/utils/tmdbGateway.js");

test("TV metadata keeps TMDB network logo data when TVDB supplies the network name", async () => {
  db.prepare(
    `INSERT INTO tvdb_metadata_cache (id, tvdb_id, title, details, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("series_123", "123", "Network Show", toJson({
    id: 123,
    name: "Network Show",
    overview: "",
    status: { name: "Ended" },
    firstAired: "2005-01-01",
    episodes: [],
    seasons: [],
    originalNetwork: { id: 6, name: "NBC" },
    remoteIds: [{ sourceName: "TheMovieDB.com", id: "456" }],
  }), Date.now());

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      id: 456,
      networks: [{ id: 6, name: "NBC", logo_path: "/nbc-logo.png" }],
      external_ids: { tvdb_id: "123", imdb_id: "tt1234567" },
    }),
  });

  try {
    const details = await getTmdbDetails({
      mediaType: "tv",
      tmdbId: "456",
      title: "Network Show",
      ids: { tvdbId: "123" },
      light: true,
    });
    assert.equal(details.networks[0].name, "NBC");
    assert.equal(details.networks[0].logo_path, "/nbc-logo.png");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
