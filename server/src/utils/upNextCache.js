import fs from "node:fs/promises";
import path from "node:path";
import { getDataVersion, getUpNextVersion, bumpUpNextVersion } from "../db.js";
import { DATA_DIR } from "../paths.js";

const CACHE_VERSION = 1;
const CACHE_FILE = path.join(DATA_DIR, "up-next-cache.json");
const TEMP_FILE = `${CACHE_FILE}.${process.pid}.tmp`;
const UP_NEXT_TTL_MS = 2 * 60 * 1000;
const REVALIDATE_MIN_INTERVAL_MS = 10 * 60 * 1000;
const MAX_ITEMS = 100;

let memoryCache = null;
let memoryMtimeMs = 0;
let writeChain = Promise.resolve();
let buildInFlight = null;
let lastRevalidateAt = 0;

function emptyCache() {
  return {
    version: CACHE_VERSION,
    builtAt: 0,
    sourceVersion: 0,
    upNextVersion: getUpNextVersion(),
    items: [],
  };
}

function normalizeCache(parsed) {
  return {
    version: CACHE_VERSION,
    builtAt: Number(parsed?.builtAt || 0),
    sourceVersion: Number(parsed?.sourceVersion || 0),
    upNextVersion: Number(parsed?.upNextVersion || getUpNextVersion()),
    items: Array.isArray(parsed?.items) ? parsed.items.slice(0, MAX_ITEMS) : [],
  };
}

async function readCache() {
  try {
    const stat = await fs.stat(CACHE_FILE);
    if (memoryCache && memoryMtimeMs === stat.mtimeMs) return memoryCache;
    const parsed = JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
    memoryCache = normalizeCache(parsed);
    memoryMtimeMs = stat.mtimeMs;
    return memoryCache;
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("Failed to read Up Next cache", error);
    memoryCache = emptyCache();
    memoryMtimeMs = 0;
    return memoryCache;
  }
}

function normalizedItems(items) {
  return (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS);
}

async function storeCache(items, sourceVersion) {
  const nextItems = normalizedItems(items);
  let result;
  writeChain = writeChain.catch(() => {}).then(async () => {
    const current = await readCache();
    const changed = !current.builtAt || JSON.stringify(current.items) !== JSON.stringify(nextItems);
    const upNextVersion = changed
      ? bumpUpNextVersion()
      : Math.max(Number(current.upNextVersion || 1), getUpNextVersion());
    const now = Date.now();
    const next = {
      version: CACHE_VERSION,
      builtAt: now,
      sourceVersion: Number(sourceVersion || getDataVersion()),
      upNextVersion,
      items: nextItems,
    };
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(TEMP_FILE, JSON.stringify(next), "utf8");
    await fs.rename(TEMP_FILE, CACHE_FILE);
    memoryCache = next;
    memoryMtimeMs = 0;
    result = { ...next, changed };
  });
  await writeChain;
  return result;
}

function buildAndStore(build) {
  if (buildInFlight) return buildInFlight;
  const sourceVersion = getDataVersion();
  buildInFlight = Promise.resolve()
    .then(() => build())
    .then((items) => storeCache(items, sourceVersion))
    .finally(() => { buildInFlight = null; });
  return buildInFlight;
}

function publicSnapshot(cache, stale = false) {
  return {
    items: cache.items,
    builtAt: cache.builtAt,
    upNextVersion: cache.upNextVersion,
    stale,
  };
}

function queueBackgroundRebuild(build) {
  if (Date.now() - lastRevalidateAt < REVALIDATE_MIN_INTERVAL_MS) return false;
  lastRevalidateAt = Date.now();
  buildAndStore(build)
    .then((result) => {
      console.log(`Up Next cache background rebuild complete: ${result.items.length} item${result.items.length === 1 ? "" : "s"}${result.changed ? ", cache updated" : ", unchanged"}.`);
    })
    .catch((error) => {
      console.warn(`Up Next cache background rebuild failed: ${error.message}`);
    });
  return true;
}

// Return a warm snapshot immediately when possible. `revalidate` is used by
// the dashboard: stale data remains visible while one deduplicated rebuild
// runs behind the request. Explicit `refresh` keeps the existing manual retry
// semantics and waits for a fresh snapshot.
export async function getUpNextCacheSnapshot(build, { refresh = false, revalidate = false } = {}) {
  if (refresh) return publicSnapshot(await buildAndStore(build));

  const cache = await readCache();
  if (!cache.builtAt) return publicSnapshot(await buildAndStore(build));

  const sourceVersion = getDataVersion();
  const stale = sourceVersion !== cache.sourceVersion || Date.now() - cache.builtAt >= UP_NEXT_TTL_MS;
  if (!stale) return publicSnapshot(cache);
  if (revalidate) {
    queueBackgroundRebuild(build);
    return publicSnapshot(cache, true);
  }
  return publicSnapshot(await buildAndStore(build));
}
