import { fetchPlexWatchedItems } from "../functions/src/utils/plexClient.js";

const email = process.env.LOCAL_ADMIN_EMAIL || "lasikie@hotmail.co.uk";
const password = process.env.LOCAL_ADMIN_PASSWORD || "PlembfinLocal123!";
const origin = process.env.LOCAL_SITE_ORIGIN || "http://127.0.0.1:5000";
const batchSize = Number(process.env.PLEX_IMPORT_BATCH_SIZE || 100);

function dateOnlyIso(value = "") {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`).toISOString();
}

function releaseDateForPlexItem(item = {}) {
  return dateOnlyIso(
    item.originallyAvailableAt ||
      item.OriginallyAvailableAt ||
      (item.year ? `${item.year}-01-01T00:00:00.000Z` : ""),
  );
}

function idsFromPlexItem(item = {}) {
  const guids = [item.guid, ...(item.Guid || []).map((guid) => guid.id || guid)].filter(Boolean);
  const ids = {};
  for (const guid of guids) {
    const guidText = String(guid);
    const value = guidText.split(/:\/\/|\//).pop();
    if (guidText.includes("imdb")) ids.imdb = value;
    if (guidText.includes("tmdb") || guidText.includes("themoviedb")) ids.tmdb = value;
    if (guidText.includes("tvdb") || guidText.includes("thetvdb")) ids.tvdb = value;
  }
  return ids;
}

function posterPath(item = {}) {
  if (item.type === "episode") {
    return item.grandparentThumb || item.parentThumb || item.thumb || "";
  }
  return item.thumb || item.parentThumb || item.grandparentThumb || "";
}

function watchRecordFromPlexItem(item = {}) {
  const ids = idsFromPlexItem(item);
  const watchedAt = item.lastViewedAt || item.viewedAt
    ? new Date(Number(item.lastViewedAt || item.viewedAt) * 1000).toISOString()
    : releaseDateForPlexItem(item);

  if (!watchedAt) return null;

  if (item.type === "episode") {
    const season = Number(item.parentIndex || 0) || "";
    const episode = Number(item.index || 0) || "";
    return {
      title: `${item.grandparentTitle || item.title || "Unknown Show"} - S${String(season || "?").padStart(2, "0")}E${String(episode || "?").padStart(2, "0")}`,
      media_type: "episode",
      watched_at: watchedAt,
      source: "plex_initial_sync",
      imdb_id: ids.imdb || "",
      tmdb_id: ids.tmdb || "",
      tvdb_id: ids.tvdb || "",
      season,
      episode,
      poster_url: posterPath(item),
    };
  }

  if (item.type === "movie") {
    return {
      title: item.title || "Unknown Movie",
      media_type: "movie",
      watched_at: watchedAt,
      source: "plex_initial_sync",
      imdb_id: ids.imdb || "",
      tmdb_id: ids.tmdb || "",
      tvdb_id: ids.tvdb || "",
      poster_url: posterPath(item),
    };
  }

  return null;
}

async function signIn() {
  const response = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error?.message || `Local auth sign-in failed with HTTP ${response.status}`);
  }
  return body.idToken;
}

async function localApi(token, path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || body.details || `${path} failed with HTTP ${response.status}`);
  }
  return body;
}

const token = await signIn();
const configBody = await localApi(token, "/api/config");
const plexConfig = configBody.config?.plex || {};
if (!plexConfig.baseUrl || !plexConfig.token) {
  throw new Error("Local emulator Plex config is missing baseUrl or token.");
}

console.log("Fetching watched items from Plex...");
const items = await fetchPlexWatchedItems(plexConfig);
const records = items.map(watchRecordFromPlexItem).filter(Boolean);
console.log(`Plex returned ${items.length} watched items; ${records.length} importable archive records.`);

const totals = { inserted: 0, updated: 0, skipped: 0, rejected: 0 };
for (let index = 0; index < records.length; index += batchSize) {
  const batch = records.slice(index, index + batchSize);
  const result = await localApi(token, "/api/import", {
    method: "POST",
    body: JSON.stringify({ records: batch }),
  });
  totals.inserted += Number(result.inserted || 0);
  totals.updated += Number(result.updated || 0);
  totals.skipped += Number(result.skipped || 0);
  totals.rejected += Number(result.rejected || 0);
  console.log(`Imported ${index + 1}-${Math.min(index + batch.length, records.length)} / ${records.length}`);
}

console.log(`Done. Inserted: ${totals.inserted}, updated: ${totals.updated}, skipped: ${totals.skipped}, rejected: ${totals.rejected}`);
