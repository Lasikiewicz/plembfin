import fs from "node:fs";
import path from "node:path";

const exportDir = process.argv[2] || "C:\\Users\\lasik\\Downloads\\trakt-export-lasikie";
const email = process.env.LOCAL_ADMIN_EMAIL || "lasikie@hotmail.co.uk";
const password = process.env.LOCAL_ADMIN_PASSWORD || "PlembfinLocal123!";
const origin = process.env.LOCAL_SITE_ORIGIN || "http://127.0.0.1:5000";
const batchSize = 100;

function inferMediaType(type, record) {
  const normalized = String(type || "").toLowerCase();
  if (normalized.includes("movie")) return "movie";
  if (normalized.includes("episode") || normalized.includes("show") || normalized.includes("tv")) return "episode";
  if (record.season || record.episode) return "episode";
  return "movie";
}

function importTitle(record, mediaType) {
  const movie = record.movie || {};
  const show = record.show || {};
  const episode = record.episode || {};

  if (mediaType === "episode") {
    const showTitle = record.show_title || show.title || record.show || "";
    const season = record.season || episode.season || "";
    const episodeNumber = record.episode_number || episode.number || (typeof record.episode === "object" ? "" : record.episode) || "";
    if (showTitle && (season || episodeNumber)) {
      return `${showTitle} - S${String(season || "?").padStart(2, "0")}E${String(episodeNumber || "?").padStart(2, "0")}`;
    }
  }

  return (
    record.title ||
    record.name ||
    record.movie_title ||
    record.show_title ||
    movie.title ||
    show.title ||
    episode.title ||
    record.show ||
    record.movie ||
    record.Title ||
    ""
  );
}

function mapImportRecord(record) {
  const source = record.source || "trakt_import";
  const movie = record.movie || {};
  const show = record.show || {};
  const episode = record.episode || {};
  const ids = record.ids || movie.ids || show.ids || episode.ids || {};
  const rawType = record.media_type || record.mediatype || record.type || record.type || "";
  const mediaType = inferMediaType(rawType, record);
  const title = importTitle(record, mediaType);
  const watchedAt =
    record.watched_at ||
    record.watched_at_utc ||
    record.watchedAt ||
    record.last_watched_at ||
    record.lastWatchedAt ||
    record.scrobbled_at ||
    record.collected_at ||
    record.date ||
    record.watched_date ||
    record.Date ||
    "";

  if (!title || !watchedAt) return undefined;

  return {
    title,
    media_type: mediaType,
    watched_at: watchedAt,
    source,
    imdb_id: record.imdb_id || record.imdb || record.imdbid || ids.imdb || "",
    tmdb_id: record.tmdb_id || record.tmdb || record.tmdbid || ids.tmdb || "",
    tvdb_id: record.tvdb_id || record.tvdb || record.tvdbid || ids.tvdb || "",
    season: record.season || episode.season || "",
    episode: record.episode_number || episode.number || (typeof record.episode === "object" ? "" : record.episode) || "",
  };
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

async function postImportBatch(token, records) {
  const response = await fetch(`${origin}/api/import`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ records }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || body.details || `Import failed with HTTP ${response.status}`);
  }
  return body;
}

const files = fs
  .readdirSync(exportDir)
  .filter((file) => /^watched-history-\d+\.json$/i.test(file))
  .sort((a, b) => Number(a.match(/\d+/)?.[0] || 0) - Number(b.match(/\d+/)?.[0] || 0));

if (!files.length) {
  throw new Error(`No watched-history-*.json files found in ${exportDir}`);
}

const records = [];
for (const file of files) {
  const fullPath = path.join(exportDir, file);
  const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${file} did not contain a JSON array`);
  const mapped = parsed.map(mapImportRecord).filter(Boolean);
  records.push(...mapped);
  console.log(`${file}: ${mapped.length} usable history records`);
}

console.log(`Total queued: ${records.length}`);
const token = await signIn();

const totals = { inserted: 0, updated: 0, skipped: 0, rejected: 0 };
for (let index = 0; index < records.length; index += batchSize) {
  const batch = records.slice(index, index + batchSize);
  const result = await postImportBatch(token, batch);
  totals.inserted += Number(result.inserted || 0);
  totals.updated += Number(result.updated || 0);
  totals.skipped += Number(result.skipped || 0);
  totals.rejected += Number(result.rejected || 0);
  console.log(`Imported ${index + 1}-${Math.min(index + batch.length, records.length)} / ${records.length}`);
}

console.log(`Done. Inserted: ${totals.inserted}, updated: ${totals.updated}, skipped: ${totals.skipped}, rejected: ${totals.rejected}`);
