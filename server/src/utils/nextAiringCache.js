import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../paths.js";

const CACHE_VERSION = 1;
const CACHE_FILE = path.join(DATA_DIR, "next-airing-cache.json");
const TEMP_FILE = `${CACHE_FILE}.tmp`;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_TTL_MS = 6 * 60 * 60 * 1000;
const INACTIVE_TTL_MS = 7 * DAY_MS;

let memoryCache = null;
let memoryMtimeMs = 0;

function normalizeTitle(value = "") {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function nextAiringCacheKey(tmdbId = "", title = "") {
  const id = String(tmdbId || "").trim();
  if (id) return `tv_${id}`;
  const titleKey = normalizeTitle(title);
  return titleKey ? `title_${titleKey}` : "";
}

function emptyCache() {
  return { version: CACHE_VERSION, updatedAt: 0, entries: {} };
}

async function readFileCache() {
  try {
    const [stat, raw] = await Promise.all([fs.stat(CACHE_FILE), fs.readFile(CACHE_FILE, "utf8")]);
    if (memoryCache && memoryMtimeMs === stat.mtimeMs) return memoryCache;
    const parsed = JSON.parse(raw);
    const cache = {
      version: CACHE_VERSION,
      updatedAt: Number(parsed?.updatedAt || 0),
      entries: parsed?.entries && typeof parsed.entries === "object" ? parsed.entries : {},
    };
    memoryCache = cache;
    memoryMtimeMs = stat.mtimeMs;
    return cache;
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("Failed to read next airing cache", error);
    memoryCache = emptyCache();
    memoryMtimeMs = 0;
    return memoryCache;
  }
}

async function writeFileCache(cache) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload = JSON.stringify({ ...cache, version: CACHE_VERSION, updatedAt: Date.now() }, null, 2);
  await fs.writeFile(TEMP_FILE, payload, "utf8");
  await fs.rename(TEMP_FILE, CACHE_FILE);
  memoryCache = { ...cache, version: CACHE_VERSION, updatedAt: Date.now() };
  memoryMtimeMs = 0;
}

export async function readNextAiringCache() {
  return readFileCache();
}

export function cachedNextAiringFor(entries = {}, tmdbId = "", title = "") {
  const key = nextAiringCacheKey(tmdbId, title);
  if (!key) return null;
  const entry = entries[key];
  if (!entry) return null;
  const today = new Date().toISOString().slice(0, 10);
  return {
    ...entry,
    nextAiringDate: entry.nextAiringDate && entry.nextAiringDate >= today ? entry.nextAiringDate : "",
  };
}

export async function mergeNextAiringCacheEntries(updates = []) {
  const filtered = updates.filter((entry) => entry?.key);
  if (!filtered.length) return { written: 0 };
  const cache = await readFileCache();
  const entries = { ...cache.entries };
  const now = Date.now();
  for (const update of filtered) {
    entries[update.key] = {
      title: update.title || entries[update.key]?.title || "",
      tmdbId: update.tmdbId ? String(update.tmdbId) : entries[update.key]?.tmdbId || "",
      nextAiringDate: update.nextAiringDate || "",
      status: update.status || "",
      updatedAt: now,
    };
  }
  await writeFileCache({ ...cache, entries });
  return { written: filtered.length };
}

export function nextAiringCacheEntryStale(entry = null, status = "") {
  const safeEntry = entry && typeof entry === "object" ? entry : {};
  const updatedAt = Number(safeEntry.updatedAt || 0);
  if (!updatedAt) return true;
  const ttl = ["Ended", "Canceled"].includes(status || safeEntry.status) ? INACTIVE_TTL_MS : ACTIVE_TTL_MS;
  return Date.now() - updatedAt > ttl;
}
