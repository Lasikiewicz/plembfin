import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plembfin-related-tv-miss-");
const { db } = await import("../server/src/db.js");
const { resolveTvdbSeriesId, RELATED_TV_SEARCH_MISS_TTL_MS } = await import("../server/src/utils/tvdbGateway.js");

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const HOUR_MS = 60 * 60 * 1000;

function seedMiss(title, ageMs) {
  const canonical = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const id = `search_${crypto.createHash("sha256").update(canonical).digest("hex")}`;
  db.prepare(`INSERT INTO tvdb_metadata_cache (id, tvdb_id, title, details, updated_at_ms)
    VALUES (?, '', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET tvdb_id='', details=excluded.details, updated_at_ms=excluded.updated_at_ms`)
    .run(id, title, JSON.stringify({ tvdb_id: "", matched_name: "", match_schema_version: 3 }), Date.now() - ageMs);
  return id;
}

async function countingFetch(fn) {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input?.url || input);
    calls.push(url);
    const body = url.endsWith("/login") ? { data: { token: "test-token" } } : { data: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = previousFetch;
  }
  return calls;
}

test("the related-TV rail reads a two-hour-old title-search miss without asking TVDB", async () => {
  assert.equal(RELATED_TV_SEARCH_MISS_TTL_MS, 7 * 24 * HOUR_MS);
  seedMiss("Frankenweenie", 2 * HOUR_MS);
  const calls = await countingFetch(async () => {
    assert.equal(await resolveTvdbSeriesId({ title: "Frankenweenie", missTtlMs: RELATED_TV_SEARCH_MISS_TTL_MS }), "");
  });
  assert.deepEqual(calls, []);
});

test("sync title resolution still retries the same miss after an hour", async () => {
  const id = seedMiss("Anthropoid", 2 * HOUR_MS);
  const calls = await countingFetch(async () => {
    assert.equal(await resolveTvdbSeriesId({ title: "Anthropoid" }), "");
  });
  assert.ok(calls.some((url) => url.includes("/search?")), `expected a TVDB search, got ${JSON.stringify(calls)}`);
  const row = db.prepare("SELECT updated_at_ms FROM tvdb_metadata_cache WHERE id = ?").get(id);
  assert.ok(Date.now() - row.updated_at_ms < 60_000, "the retried miss refreshes the shared row");
});

test("the rail still asks TVDB once a miss is older than a week", async () => {
  seedMiss("Iron Man 2", 8 * 24 * HOUR_MS);
  const calls = await countingFetch(async () => {
    await resolveTvdbSeriesId({ title: "Iron Man 2", missTtlMs: RELATED_TV_SEARCH_MISS_TTL_MS });
  });
  assert.ok(calls.some((url) => url.includes("/search?")));
});
