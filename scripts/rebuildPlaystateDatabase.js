import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const HISTORY_BATCH_SIZE = 400;
const CONVERGENCE_DELAY_MS = 100;
const RESET_COLLECTIONS = [
  "watchHistory",
  "playstate",
  "playbackProgress",
  "syncHistory",
  "activeSessions",
  "liveTrackingCache",
  "derivedCache",
  "derivedShowSummaries",
];

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    traktDir: "",
    write: false,
    skipConvergence: false,
    traktOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") args.write = true;
    else if (arg === "--skip-convergence") args.skipConvergence = true;
    else if (arg === "--trakt-only") args.traktOnly = true;
    else if (arg === "--trakt-dir") args.traktDir = argv[++index] || "";
    else if (arg.startsWith("--trakt-dir=")) args.traktDir = arg.slice("--trakt-dir=".length);
  }

  if (!args.traktDir) {
    args.traktDir = "C:\\Users\\lasik\\Downloads\\trakt-export-lasikie";
  }

  return args;
}

async function configureFirebaseCredentials() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return;
  const candidate = path.resolve("service-account-key.json");
  try {
    await fs.access(candidate);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = candidate;
  } catch {
    // Fall back to Application Default Credentials.
  }
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function dateOnlyIso(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function releaseDateFromObject(value = {}) {
  return dateOnlyIso(
    value.released ||
      value.first_aired ||
      value.aired_at ||
      value.PremiereDate ||
      value.OriginalReleaseDate ||
      value.originallyAvailableAt ||
      (value.year || value.ProductionYear ? `${value.year || value.ProductionYear}-01-01T00:00:00.000Z` : ""),
  );
}

function yearReleaseDate(year) {
  const number = Number(year);
  return Number.isFinite(number) && number > 1800 ? `${number}-01-01T00:00:00.000Z` : "";
}

function normalizeIds(ids = {}) {
  return {
    imdb_id: ids.imdb ? String(ids.imdb) : "",
    tmdb_id: ids.tmdb ? String(ids.tmdb) : "",
    tvdb_id: ids.tvdb ? String(ids.tvdb) : "",
  };
}

function idsFromPlexItem(item = {}) {
  const ids = { imdb_id: "", tmdb_id: "", tvdb_id: "" };
  const rawGuids = [
    item.guid,
    ...(Array.isArray(item.Guid) ? item.Guid.map((guid) => guid.id || guid) : []),
  ].filter(Boolean);

  for (const rawGuid of rawGuids) {
    const guid = String(rawGuid);
    const value = guid.split(/:\/\/|\//).pop();
    if (guid.includes("imdb")) ids.imdb_id = value;
    if (guid.includes("tmdb") || guid.includes("themoviedb")) ids.tmdb_id = value;
    if (guid.includes("tvdb") || guid.includes("thetvdb")) ids.tvdb_id = value;
  }

  return ids;
}

function normalizePlexIdentity(value = "") {
  return String(value || "").trim().toLowerCase();
}

function isOwnerPlexUsername(username = "") {
  return username === "admin" || username === "owner";
}

function plexAccountIdFromItem(item = {}) {
  const value = item.accountID ?? item.accountId ?? item.account_id ?? item.userID ?? item.userId;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function plexUsernamesFromItem(item = {}) {
  const user = item.User || item.user || {};
  const account = item.Account || item.account || {};
  return [
    item.username,
    item.user,
    item.userName,
    item.account,
    item.accountName,
    item.accountTitle,
    user.title,
    user.name,
    account.title,
    account.name,
  ]
    .map(normalizePlexIdentity)
    .filter(Boolean);
}

function accountMatchesUsername(account = {}, username = "") {
  return [
    account.name,
    account.title,
    account.username,
    account.accountName,
  ]
    .map(normalizePlexIdentity)
    .some((value) => value === username);
}

async function resolvePlexTargetAccountId(config = {}) {
  const username = normalizePlexIdentity(config.username);
  if (!username) return null;
  if (isOwnerPlexUsername(username)) return 1;
  if (!config?.baseUrl || !config?.token) return null;

  try {
    const accountsUrl = new URL(`${String(config.baseUrl).replace(/\/+$/, "")}/accounts`);
    accountsUrl.searchParams.set("X-Plex-Token", config.token);
    const accountsRes = await fetch(accountsUrl, { headers: { Accept: "application/json" } });
    if (!accountsRes.ok) {
      console.warn(`Plex account mapping failed with HTTP ${accountsRes.status}`);
      return null;
    }

    const accountsData = await accountsRes.json();
    const accounts = accountsData?.MediaContainer?.Account || [];
    const matchedAccount = accounts.find((account) => accountMatchesUsername(account, username));
    const accountId = Number(matchedAccount?.id);
    return Number.isFinite(accountId) ? accountId : null;
  } catch (error) {
    console.warn(`Plex account mapping failed: ${error.message}`);
    return null;
  }
}

function plexHistoryItemMatchesConfiguredUser(item = {}, { username = "", accountId = null } = {}) {
  if (!username) return true;

  const itemAccountId = plexAccountIdFromItem(item);
  if (itemAccountId != null && accountId != null) {
    return itemAccountId === accountId;
  }

  const itemUsernames = plexUsernamesFromItem(item);
  if (itemUsernames.length) {
    return itemUsernames.includes(username);
  }

  return false;
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function traktFiles(traktDir, pattern) {
  const entries = await fs.readdir(traktDir);
  return entries
    .filter((name) => pattern.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => path.join(traktDir, name));
}

async function tmdbReleaseDate(record, apiKey) {
  if (!apiKey || !record.tmdb_id) return "";
  const base = "https://api.themoviedb.org/3";
  const url = record.media_type === "episode"
    ? new URL(`${base}/tv/${record.tmdb_id}/season/${record.season}/episode/${record.episode}`)
    : new URL(`${base}/movie/${record.tmdb_id}`);
  url.searchParams.set("api_key", apiKey);

  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return "";
    const body = await response.json();
    return dateOnlyIso(body.release_date || body.air_date || body.first_air_date);
  } catch {
    return "";
  }
}

async function watchedAtOrRelease(record, candidates, tmdbApiKey, unresolved) {
  const watchedAt = candidates.map(isoDate).find(Boolean);
  if (watchedAt) return watchedAt;

  const embeddedRelease = candidates.map(dateOnlyIso).find(Boolean);
  if (embeddedRelease) return embeddedRelease;

  const tmdbRelease = await tmdbReleaseDate(record, tmdbApiKey);
  if (tmdbRelease) return tmdbRelease;

  unresolved.push({
    title: record.title,
    media_type: record.media_type,
    season: record.season ?? null,
    episode: record.episode ?? null,
    source: record.source,
    reason: "No watched date or release date",
  });
  return "";
}

async function traktHistoryRecord(event, tmdbApiKey, unresolved) {
  const type = String(event.type || "").toLowerCase();
  if (type === "movie") {
    const movie = event.movie || {};
    const base = {
      title: movie.title || event.title || "",
      media_type: "movie",
      source: "trakt_import",
      ...normalizeIds(movie.ids || event.ids),
    };
    const watchedAt = await watchedAtOrRelease(base, [event.watched_at, movie.released, yearReleaseDate(movie.year)], tmdbApiKey, unresolved);
    return watchedAt ? { ...base, watched_at: watchedAt } : null;
  }

  if (type === "episode") {
    const show = event.show || {};
    const episode = event.episode || {};
    const seasonNumber = numberOrNull(episode.season ?? event.season);
    const episodeNumber = numberOrNull(episode.number ?? event.episode_number);
    const base = {
      title: `${show.title || "Unknown Show"} - S${String(seasonNumber ?? "?").padStart(2, "0")}E${String(episodeNumber ?? "?").padStart(2, "0")}`,
      media_type: "episode",
      source: "trakt_import",
      season: seasonNumber,
      episode: episodeNumber,
      ...normalizeIds(show.ids || event.ids),
    };
    const watchedAt = await watchedAtOrRelease(base, [event.watched_at, episode.first_aired, yearReleaseDate(show.year)], tmdbApiKey, unresolved);
    return watchedAt ? { ...base, watched_at: watchedAt } : null;
  }

  return null;
}

async function traktCurrentMovieRecord(row, tmdbApiKey, unresolved) {
  const movie = row.movie || {};
  const base = {
    title: movie.title || row.title || "",
    media_type: "movie",
    source: "trakt_current",
    ...normalizeIds(movie.ids || row.ids),
  };
  const watchedAt = await watchedAtOrRelease(base, [row.last_watched_at, movie.released, yearReleaseDate(movie.year)], tmdbApiKey, unresolved);
  return watchedAt ? { ...base, watched_at: watchedAt } : null;
}

async function traktCurrentShowRecords(row, tmdbApiKey, unresolved) {
  const show = row.show || {};
  const records = [];
  for (const season of row.seasons || []) {
    for (const episode of season.episodes || []) {
      const seasonNumber = numberOrNull(season.number);
      const episodeNumber = numberOrNull(episode.number);
      const base = {
        title: `${show.title || "Unknown Show"} - S${String(seasonNumber ?? "?").padStart(2, "0")}E${String(episodeNumber ?? "?").padStart(2, "0")}`,
        media_type: "episode",
        source: "trakt_current",
        season: seasonNumber,
        episode: episodeNumber,
        ...normalizeIds(show.ids || row.ids),
      };
      const watchedAt = await watchedAtOrRelease(base, [episode.last_watched_at, row.last_watched_at, episode.first_aired, yearReleaseDate(show.year)], tmdbApiKey, unresolved);
      if (watchedAt) records.push({ ...base, watched_at: watchedAt });
    }
  }
  return records;
}

function plexWatchedAt(item = {}) {
  if (item.lastViewedAt) return new Date(Number(item.lastViewedAt) * 1000).toISOString();
  if (item.viewedAt) return new Date(Number(item.viewedAt) * 1000).toISOString();
  return "";
}

async function plexItemRecord(item, source, tmdbApiKey, unresolved) {
  if (item.type !== "movie" && item.type !== "episode") return null;
  const isEpisode = item.type === "episode";
  const season = isEpisode ? numberOrNull(item.parentIndex) : null;
  const episode = isEpisode ? numberOrNull(item.index) : null;
  const base = {
    title: isEpisode
      ? `${item.grandparentTitle || "Unknown Show"} - S${String(season ?? "?").padStart(2, "0")}E${String(episode ?? "?").padStart(2, "0")}`
      : item.title || "Unknown Movie",
    media_type: isEpisode ? "episode" : "movie",
    source,
    season,
    episode,
    ...idsFromPlexItem(item),
  };
  const watchedAt = await watchedAtOrRelease(base, [plexWatchedAt(item), item.originallyAvailableAt, yearReleaseDate(item.year)], tmdbApiKey, unresolved);
  return watchedAt ? { ...base, watched_at: watchedAt } : null;
}

function plexMetadataRecord(item, source) {
  if (item.type !== "movie" && item.type !== "episode") return null;
  const isEpisode = item.type === "episode";
  const season = isEpisode ? numberOrNull(item.parentIndex) : null;
  const episode = isEpisode ? numberOrNull(item.index) : null;
  return {
    title: isEpisode
      ? `${item.grandparentTitle || "Unknown Show"} - S${String(season ?? "?").padStart(2, "0")}E${String(episode ?? "?").padStart(2, "0")}`
      : item.title || "Unknown Movie",
    media_type: isEpisode ? "episode" : "movie",
    source,
    season,
    episode,
    ...idsFromPlexItem(item),
  };
}

async function fetchPlexHistory(config, tmdbApiKey, unresolved) {
  if (!config?.baseUrl || !config?.token) return [];
  const records = [];
  const pageSize = 500;
  let start = 0;
  let lastFirstItemKey = "";
  const username = normalizePlexIdentity(config.username);
  const targetAccountId = await resolvePlexTargetAccountId(config);
  if (username && targetAccountId == null) {
    console.warn(`Plex configured user "${config.username}" was not resolved to an account id; rows without a matching username will be skipped.`);
  }

  while (true) {
    const url = new URL(`${String(config.baseUrl).replace(/\/+$/, "")}/status/sessions/history/all`);
    url.searchParams.set("X-Plex-Token", config.token);
    url.searchParams.set("X-Plex-Container-Start", String(start));
    url.searchParams.set("X-Plex-Container-Size", String(pageSize));
    if (targetAccountId != null) {
      url.searchParams.set("accountID", String(targetAccountId));
    }

    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Plex history fetch failed with HTTP ${response.status}`);
    const body = await response.json();
    const items = body?.MediaContainer?.Metadata || [];
    if (!items.length) break;

    const firstItemKey = String(items[0]?.historyKey || items[0]?.viewedAt || "");
    if (firstItemKey && firstItemKey === lastFirstItemKey) break;
    lastFirstItemKey = firstItemKey;

    for (const item of items) {
      if (!plexHistoryItemMatchesConfiguredUser(item, { username, accountId: targetAccountId })) continue;
      const record = await plexItemRecord(item, "plex_initial_sync", tmdbApiKey, unresolved);
      if (record) records.push(record);
    }

    start += pageSize;
  }

  return records;
}

function embyLikeRecord(item, source) {
  const ids = item.ProviderIds || {};
  const isEpisode = item.Type === "Episode";
  const season = isEpisode ? numberOrNull(item.ParentIndexNumber) : null;
  const episode = isEpisode ? numberOrNull(item.IndexNumber) : null;
  const watchedAt = isoDate(item.UserData?.LastPlayedDate) || releaseDateFromObject(item);
  if (!watchedAt) return null;
  return {
    title: isEpisode
      ? `${item.SeriesName || "Unknown Show"} - S${String(season ?? "?").padStart(2, "0")}E${String(episode ?? "?").padStart(2, "0")}`
      : item.Name || "Unknown Movie",
    media_type: isEpisode ? "episode" : "movie",
    source,
    watched_at: watchedAt,
    season,
    episode,
    imdb_id: ids.Imdb || ids.imdb || "",
    tmdb_id: ids.Tmdb || ids.tmdb || "",
    tvdb_id: ids.Tvdb || ids.tvdb || "",
  };
}

function embyLikeMetadataRecord(item, source) {
  const ids = item.ProviderIds || {};
  const isEpisode = item.Type === "Episode";
  const season = isEpisode ? numberOrNull(item.ParentIndexNumber) : null;
  const episode = isEpisode ? numberOrNull(item.IndexNumber) : null;
  return {
    title: isEpisode
      ? `${item.SeriesName || "Unknown Show"} - S${String(season ?? "?").padStart(2, "0")}E${String(episode ?? "?").padStart(2, "0")}`
      : item.Name || "Unknown Movie",
    media_type: isEpisode ? "episode" : "movie",
    source,
    season,
    episode,
    imdb_id: ids.Imdb || ids.imdb || "",
    tmdb_id: ids.Tmdb || ids.tmdb || "",
    tvdb_id: ids.Tvdb || ids.tvdb || "",
  };
}

function plexLibraryUrl(baseUrl, token, sectionId, type) {
  const url = new URL(`${String(baseUrl).replace(/\/+$/, "")}/library/sections/${sectionId}/all`);
  url.searchParams.set("X-Plex-Token", token);
  url.searchParams.set("type", type === "movie" ? "1" : "4");
  return url;
}

async function fetchPlexLibraryRecords(config) {
  if (!config?.baseUrl || !config?.token || config.disabled) return [];
  const baseUrl = String(config.baseUrl).replace(/\/+$/, "");
  const sectionsUrl = new URL(`${baseUrl}/library/sections`);
  sectionsUrl.searchParams.set("X-Plex-Token", config.token);

  const sectionsRes = await fetch(sectionsUrl, { headers: { Accept: "application/json" } });
  if (!sectionsRes.ok) throw new Error(`Plex library sections fetch failed with HTTP ${sectionsRes.status}`);

  const sectionsData = await sectionsRes.json();
  const sections = sectionsData?.MediaContainer?.Directory || [];
  const records = [];

  for (const section of sections) {
    if (section.type !== "movie" && section.type !== "show") continue;
    const url = plexLibraryUrl(baseUrl, config.token, section.key, section.type === "movie" ? "movie" : "episode");
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      console.warn(`Plex section ${section.key} library fetch failed with HTTP ${response.status}`);
      continue;
    }

    const data = await response.json();
    for (const item of data?.MediaContainer?.Metadata || []) {
      const record = plexMetadataRecord(item, "plex_library");
      if (record) records.push(record);
    }
  }

  return records;
}

function embyLikeAuthHeaders(config = {}) {
  const apiKey = config.apiKey || config.api_key || config.token;
  return {
    Accept: "application/json",
    "X-Emby-Token": apiKey,
    "X-MediaBrowser-Token": apiKey,
  };
}

async function fetchEmbyLikeLibraryRecords(config, source) {
  const apiKey = config?.apiKey || config?.api_key || config?.token;
  if (!config?.baseUrl || !apiKey || !config?.userId || config.disabled) return [];

  const url = new URL(`${String(config.baseUrl).replace(/\/+$/, "")}/Users/${config.userId}/Items`);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("IncludeItemTypes", "Movie,Episode");
  url.searchParams.set("Fields", "ProviderIds,UserData,PremiereDate,ProductionYear");
  url.searchParams.set("api_key", apiKey);

  const response = await fetch(url, { headers: embyLikeAuthHeaders(config) });
  if (!response.ok) throw new Error(`${source} library fetch failed with HTTP ${response.status}`);

  const data = await response.json();
  return (data?.Items || [])
    .map((item) => embyLikeMetadataRecord(item, `${source}_library`))
    .filter(Boolean);
}

function mediaFromRecord(record, source = record.source) {
  return {
    title: record.title,
    type: record.media_type,
    source,
    ids: {
      imdb: record.imdb_id || undefined,
      tmdb: record.tmdb_id || undefined,
      tvdb: record.tvdb_id || undefined,
    },
    season: record.season == null ? undefined : Number(record.season),
    episode: record.episode == null ? undefined : Number(record.episode),
    isValid: Boolean(record.title && ["movie", "episode"].includes(record.media_type)),
  };
}

function canonicalTitleKey(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function showTitleFromRecord(record = {}) {
  const title = cleanString(record.title);
  const match = title.match(/^(.*?)(?:\s+-\s+S\d{1,3}E\d{1,3})(?:\s+-\s+.*)?$/i);
  return cleanString(match?.[1] || title.split(" - ")[0] || title);
}

function convergenceKeyFor(record = {}) {
  const type = cleanString(record.media_type || record.type).toLowerCase();
  if (type === "episode") {
    return [
      "episode",
      canonicalTitleKey(showTitleFromRecord(record)),
      `s${Number(record.season ?? -1)}`,
      `e${Number(record.episode ?? -1)}`,
    ].join("|");
  }

  if (type === "movie") {
    const titleKey = canonicalTitleKey(record.title);
    if (titleKey) return `movie|title:${titleKey}`;
    if (record.imdb_id || record.ids?.imdb) return `movie|imdb:${record.imdb_id || record.ids.imdb}`;
    if (record.tmdb_id || record.ids?.tmdb) return `movie|tmdb:${record.tmdb_id || record.ids.tmdb}`;
    if (record.tvdb_id || record.ids?.tvdb) return `movie|tvdb:${record.tvdb_id || record.ids.tvdb}`;
  }

  return `${type || "unknown"}|${canonicalTitleKey(record.title)}`;
}

function historicalImportTelemetry(source = "import") {
  return [
    `Origin: ${source}`,
    "Loop-check: Skipped propagation",
    "Dispatch status: skipped",
    "Details: Historical import stored locally without outbound sync; canonical playstate handles convergence.",
    "Target plex status: not attempted",
    "Target emby status: not attempted",
    "Target jellyfin status: not attempted",
  ].join("\n");
}

function dedupeHistory(records, mediaKeyFor) {
  const seen = new Set();
  const unique = [];
  for (const record of records) {
    const key = `${record.source}|${mediaKeyFor(record)}|${record.watched_at}|${record.sync_action || "watched"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
  }
  return unique;
}

function addCanonical(map, record, source, mediaKeyFor) {
  const mediaKey = mediaKeyFor(record);
  const existing = map.get(mediaKey);
  const sources = new Set(existing?.sources || []);
  sources.add(source);
  if (!existing || String(record.watched_at) > String(existing.watched_at)) {
    map.set(mediaKey, { ...record, source, mediaKey, sources });
  } else {
    existing.sources = sources;
  }
}

function buildConvergenceMap(records = []) {
  const map = new Map();
  for (const record of records) {
    const key = convergenceKeyFor(record);
    if (key) map.set(key, record);
  }
  return map;
}

async function deleteCollection(db, collectionName) {
  let deleted = 0;
  while (true) {
    const snapshot = await db.collection(collectionName).limit(HISTORY_BATCH_SIZE).get();
    if (snapshot.empty) break;
    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += snapshot.size;
  }
  return deleted;
}

async function resetMediaData(db) {
  const deleted = {};
  for (const collection of RESET_COLLECTIONS) {
    deleted[collection] = await deleteCollection(db, collection);
  }
  return deleted;
}

async function writeHistory(db, FieldValue, watchRecordToFirestoreData, records) {
  let inserted = 0;
  let rejected = 0;
  let batch = db.batch();
  let batchCount = 0;

  for (const record of records) {
    try {
      const { data } = watchRecordToFirestoreData(
        {
          ...record,
          sync_dispatch_telemetry: record.sync_dispatch_telemetry || historicalImportTelemetry(record.source),
        },
        record.source,
      );
      batch.set(db.collection("watchHistory").doc(), {
        ...data,
        createdAt: FieldValue.serverTimestamp(),
      });
      inserted += 1;
      batchCount += 1;
      if (batchCount >= HISTORY_BATCH_SIZE) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    } catch (error) {
      rejected += 1;
      console.warn(`Rejected history row "${record.title || "unknown"}": ${error.message}`);
    }
  }

  if (batchCount) await batch.commit();
  return { inserted, rejected };
}

async function writePlaystate(db, FieldValue, watchRecordToFirestoreData, canonicalRows) {
  let written = 0;
  let batch = db.batch();
  let batchCount = 0;

  for (const row of canonicalRows) {
    const { record } = watchRecordToFirestoreData(row, row.source);
    const mediaKey = row.mediaKey;
    batch.set(db.collection("playstate").doc(mediaKey), {
      mediaKey,
      title: record.title,
      titleLower: record.title.toLowerCase(),
      mediaType: record.media_type,
      state: "watched",
      watchedAt: record.watched_at,
      lastSource: row.source,
      sources: [...(row.sources || new Set([row.source]))].sort(),
      ids: {
        imdb: record.imdb_id || null,
        tmdb: record.tmdb_id || null,
        tvdb: record.tvdb_id || null,
      },
      season: record.season,
      episode: record.episode,
      posterUrl: record.poster_url || null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    written += 1;
    batchCount += 1;
    if (batchCount >= HISTORY_BATCH_SIZE) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (batchCount) await batch.commit();
  return written;
}

function applyResult(bucket, result) {
  if (result?.status === "not_found") bucket.notFound += 1;
  else bucket.success += 1;
}

function sampleRow(row = {}) {
  return {
    title: row.title || "Unknown media",
    type: row.media_type || row.type || "unknown",
    season: row.season ?? null,
    episode: row.episode ?? null,
    watchedAt: row.watched_at || "",
  };
}

function addSample(bucket, name, row, limit = 8) {
  if (!bucket.samples) bucket.samples = { markWatched: [], markUnwatched: [], unavailable: [] };
  if (bucket.samples[name]?.length < limit) bucket.samples[name].push(sampleRow(row));
}

async function delay(ms) {
  if (!ms) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function converge({ write, canonicalMap, serverMaps, libraryMaps, serverOk, config, clients }) {
  const summary = {};
  const canonicalByConvergenceKey = new Map();
  for (const row of canonicalMap.values()) {
    const key = convergenceKeyFor(row);
    const existing = canonicalByConvergenceKey.get(key);
    if (!existing || String(row.watched_at) > String(existing.watched_at)) {
      canonicalByConvergenceKey.set(key, row);
    }
  }

  const activeTargets = Object.entries({
    plex: Boolean(config.plex?.baseUrl && config.plex?.token && !config.plex?.disabled),
    emby: Boolean(config.emby?.baseUrl && config.emby?.apiKey && config.emby?.userId && !config.emby?.disabled),
    jellyfin: Boolean(config.jellyfin?.baseUrl && config.jellyfin?.apiKey && config.jellyfin?.userId && !config.jellyfin?.disabled),
  })
    .filter(([, active]) => active)
    .map(([target]) => target);

  for (const target of activeTargets) {
    summary[target] = {
      markWatched: 0,
      markUnwatched: 0,
      unavailable: 0,
      success: 0,
      notFound: 0,
      error: 0,
      skipped: 0,
      samples: { markWatched: [], markUnwatched: [], unavailable: [] },
    };
    if (!serverOk[target]) {
      summary[target].skipped = canonicalMap.size;
      continue;
    }

    const currentMap = serverMaps[target] || new Map();
    const libraryMap = libraryMaps[target] || new Map();
    const currentByConvergenceKey = new Map();
    for (const row of currentMap.values()) {
      currentByConvergenceKey.set(convergenceKeyFor(row), row);
    }

    for (const [key, row] of canonicalByConvergenceKey.entries()) {
      if (currentMap.has(key)) continue;
      if (currentByConvergenceKey.has(key)) continue;
      if (libraryMap.size && !libraryMap.has(key)) {
        summary[target].unavailable += 1;
        addSample(summary[target], "unavailable", row);
        continue;
      }
      summary[target].markWatched += 1;
      addSample(summary[target], "markWatched", row);
      if (!write) continue;
      try {
        const result = await clients.played[target](config[target], mediaFromRecord(row, target));
        applyResult(summary[target], result);
      } catch (error) {
        summary[target].error += 1;
        console.warn(`${target}: failed to mark watched "${row.title}": ${error.message}`);
      }
      await delay(CONVERGENCE_DELAY_MS);
    }

    for (const row of currentMap.values()) {
      const key = convergenceKeyFor(row);
      if (canonicalMap.has(key)) continue;
      if (canonicalByConvergenceKey.has(key)) continue;
      summary[target].markUnwatched += 1;
      addSample(summary[target], "markUnwatched", row);
      if (!write) continue;
      try {
        const result = await clients.unplayed[target](config[target], mediaFromRecord(row, target));
        applyResult(summary[target], result);
      } catch (error) {
        summary[target].error += 1;
        console.warn(`${target}: failed to mark unwatched "${row.title}": ${error.message}`);
      }
      await delay(CONVERGENCE_DELAY_MS);
    }
  }

  return { activeTargets, summary };
}

async function main() {
  const args = parseArgs();
  await configureFirebaseCredentials();

  const { db, FieldValue } = await import("../functions/src/firebase.js");
  const { loadMediaConfig, setRuntimeState } = await import("../functions/src/utils/configStore.js");
  const {
    fetchPlexWatchedItems,
    markPlexPlayed,
    markPlexUnplayed,
  } = await import("../functions/src/utils/plexClient.js");
  const {
    fetchEmbyWatchedItems,
    markEmbyPlayed,
    markEmbyUnplayed,
  } = await import("../functions/src/utils/embyClient.js");
  const {
    fetchJellyfinWatchedItems,
    markJellyfinPlayed,
    markJellyfinUnplayed,
  } = await import("../functions/src/utils/jellyfinClient.js");
  const {
    invalidateHistoryDerivedCaches,
    mediaKeyFor,
    watchRecordToFirestoreData,
  } = await import("../functions/src/utils/firestoreRepo.js");

  const config = await loadMediaConfig();
  const tmdbApiKey = config.tmdb?.apiKey || "";
  const unresolved = [];

  console.log(`Mode: ${args.write ? "WRITE" : "DRY RUN"}`);
  if (args.traktOnly) {
    console.log("Source of truth: TRAKT ONLY");
  }
  console.log(`Trakt export: ${args.traktDir}`);

  if (args.write) {
    console.log("Setting rebuildActive flag in Firestore...");
    await setRuntimeState({ rebuildActive: true });
  }

  try {
    const traktHistory = [];
    for (const file of await traktFiles(args.traktDir, /^watched-history-\d+\.json$/i)) {
      const rows = await readJsonFile(file);
      for (const row of rows) {
        const record = await traktHistoryRecord(row, tmdbApiKey, unresolved);
        if (record) traktHistory.push(record);
      }
      console.log(`Parsed ${path.basename(file)}: ${traktHistory.length} Trakt history rows total`);
    }

    const traktCurrent = [];
    const watchedMovies = await readJsonFile(path.join(args.traktDir, "watched-movies.json")).catch(() => []);
    for (const row of watchedMovies) {
      const record = await traktCurrentMovieRecord(row, tmdbApiKey, unresolved);
      if (record) traktCurrent.push(record);
    }
    const watchedShows = await readJsonFile(path.join(args.traktDir, "watched-shows.json")).catch(() => []);
    for (const row of watchedShows) {
      traktCurrent.push(...(await traktCurrentShowRecords(row, tmdbApiKey, unresolved)));
    }

    console.log(`Parsed Trakt current watched rows: ${traktCurrent.length}`);

    const plexHistory = args.traktOnly ? [] : await fetchPlexHistory(config.plex, tmdbApiKey, unresolved);
    if (!args.traktOnly) {
      console.log(`Fetched Plex history events: ${plexHistory.length}`);
    } else {
      console.log("Trakt-only mode: skipping Plex history fetch.");
    }

    const plexCurrentRaw = !args.traktOnly && config.plex?.baseUrl && config.plex?.token ? await fetchPlexWatchedItems(config.plex) : [];
    const plexCurrent = [];
    for (const item of plexCurrentRaw) {
      const record = await plexItemRecord(item, "plex_current", tmdbApiKey, unresolved);
      if (record) plexCurrent.push(record);
    }
    if (!args.traktOnly) {
      console.log(`Fetched Plex current watched rows: ${plexCurrent.length}`);
    } else {
      console.log("Trakt-only mode: skipping Plex current watched fetch.");
    }

    const serverMaps = { plex: new Map(), emby: new Map(), jellyfin: new Map() };
    const libraryMaps = { plex: new Map(), emby: new Map(), jellyfin: new Map() };
    const serverOk = { plex: true, emby: true, jellyfin: true };
    for (const record of plexCurrent) serverMaps.plex.set(mediaKeyFor(record), record);

    try {
      const records = await fetchPlexLibraryRecords(config.plex);
      libraryMaps.plex = buildConvergenceMap(records);
      console.log(`Fetched Plex library availability rows: ${libraryMaps.plex.size}`);
    } catch (error) {
      serverOk.plex = false;
      console.warn(`Plex library availability fetch failed; convergence for Plex will be skipped: ${error.message}`);
    }

    try {
      const raw = config.emby?.baseUrl && config.emby?.apiKey && config.emby?.userId ? await fetchEmbyWatchedItems(config.emby) : [];
      raw.map((item) => embyLikeRecord(item, "emby")).filter(Boolean).forEach((record) => serverMaps.emby.set(mediaKeyFor(record), record));
      console.log(`Fetched Emby current watched rows: ${serverMaps.emby.size}`);
      const libraryRecords = await fetchEmbyLikeLibraryRecords(config.emby, "emby");
      libraryMaps.emby = buildConvergenceMap(libraryRecords);
      console.log(`Fetched Emby library availability rows: ${libraryMaps.emby.size}`);
    } catch (error) {
      serverOk.emby = false;
      console.warn(`Emby current/library fetch failed; convergence for Emby will be skipped: ${error.message}`);
    }

    try {
      const raw = config.jellyfin?.baseUrl && config.jellyfin?.apiKey && config.jellyfin?.userId ? await fetchJellyfinWatchedItems(config.jellyfin) : [];
      raw.map((item) => embyLikeRecord(item, "jellyfin")).filter(Boolean).forEach((record) => serverMaps.jellyfin.set(mediaKeyFor(record), record));
      console.log(`Fetched Jellyfin current watched rows: ${serverMaps.jellyfin.size}`);
      const libraryRecords = await fetchEmbyLikeLibraryRecords(config.jellyfin, "jellyfin");
      libraryMaps.jellyfin = buildConvergenceMap(libraryRecords);
      console.log(`Fetched Jellyfin library availability rows: ${libraryMaps.jellyfin.size}`);
    } catch (error) {
      serverOk.jellyfin = false;
      console.warn(`Jellyfin current/library fetch failed; convergence for Jellyfin will be skipped: ${error.message}`);
    }

    const canonicalMap = new Map();
    traktCurrent.forEach((record) => addCanonical(canonicalMap, record, "trakt_current", mediaKeyFor));
    plexCurrent.forEach((record) => addCanonical(canonicalMap, record, "plex_current", mediaKeyFor));
    plexHistory.forEach((record) => addCanonical(canonicalMap, record, "plex_history", mediaKeyFor));

    const history = dedupeHistory([...traktHistory, ...plexHistory], mediaKeyFor);
    console.log(`Canonical watched rows: ${canonicalMap.size}`);
    console.log(`Unique history events to write: ${history.length}`);
    console.log(`Unresolved unknown-date rows skipped: ${unresolved.length}`);

    const plannedConvergence = args.skipConvergence
      ? { activeTargets: [], summary: {} }
      : await converge({
          write: false,
          canonicalMap,
          serverMaps,
          libraryMaps,
          serverOk,
          config,
          clients: {
            played: { plex: markPlexPlayed, emby: markEmbyPlayed, jellyfin: markJellyfinPlayed },
            unplayed: { plex: markPlexUnplayed, emby: markEmbyUnplayed, jellyfin: markJellyfinUnplayed },
          },
        });

    console.log("Convergence plan:");
    console.log(JSON.stringify(plannedConvergence.summary, null, 2));

    if (!args.write) {
      console.log("Dry run complete. Re-run with --write to clear Firestore, write rebuilt rows, and apply server changes.");
      return;
    }

    console.log("Clearing media history/sync collections...");
    const deleted = await resetMediaData(db);
    console.log(JSON.stringify({ deleted }, null, 2));

    console.log("Writing watchHistory events...");
    const historyResult = await writeHistory(db, FieldValue, watchRecordToFirestoreData, history);
    console.log(JSON.stringify(historyResult, null, 2));

    console.log("Writing canonical playstate rows...");
    const playstateWritten = await writePlaystate(db, FieldValue, watchRecordToFirestoreData, [...canonicalMap.values()]);
    console.log(JSON.stringify({ playstateWritten }, null, 2));

    await invalidateHistoryDerivedCaches().catch(() => null);

    if (!args.skipConvergence) {
      console.log("Applying convergence to media servers...");
      const convergenceResult = await converge({
        write: true,
        canonicalMap,
        serverMaps,
        libraryMaps,
        serverOk,
        config,
        clients: {
          played: { plex: markPlexPlayed, emby: markEmbyPlayed, jellyfin: markJellyfinPlayed },
          unplayed: { plex: markPlexUnplayed, emby: markEmbyUnplayed, jellyfin: markJellyfinUnplayed },
        },
      });
      console.log("Convergence result:");
      console.log(JSON.stringify(convergenceResult.summary, null, 2));
    }

    console.log("Rebuild complete.");
  } finally {
    if (args.write) {
      console.log("Clearing rebuildActive flag in Firestore...");
      await setRuntimeState({ rebuildActive: false }).catch(() => null);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
