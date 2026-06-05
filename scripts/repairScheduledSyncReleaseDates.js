process.env.GCLOUD_PROJECT ||= "plembfin";
process.env.GOOGLE_CLOUD_PROJECT ||= "plembfin";

const write = process.argv.includes("--write");
const verbose = process.argv.includes("--verbose");

const { db, FieldValue } = await import("../functions/src/firebase.js");
const { loadMediaConfig } = await import("../functions/src/utils/configStore.js");
const { fetchEmbyWatchedItems } = await import("../functions/src/utils/embyClient.js");
const { fetchJellyfinWatchedItems } = await import("../functions/src/utils/jellyfinClient.js");
const { normalizeProviderIds } = await import("../functions/src/utils/parsers.js");
const { invalidateHistoryDerivedCaches, mediaKeyFor } = await import("../functions/src/utils/firestoreRepo.js");

function dateOnlyIso(value = "") {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`).toISOString();
}

function releaseDateForItem(item = {}) {
  return dateOnlyIso(
    item.PremiereDate ||
      item.OriginalReleaseDate ||
      (item.ProductionYear ? `${item.ProductionYear}-01-01T00:00:00.000Z` : ""),
  );
}

function mediaFromItem(item = {}, source = "") {
  const ids = normalizeProviderIds(item.ProviderIds);
  return {
    title: item.Type === "Episode"
      ? `${item.SeriesName} - S${String(item.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(item.IndexNumber ?? "?").padStart(2, "0")}`
      : item.Name,
    type: item.Type === "Episode" ? "episode" : "movie",
    season: item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null,
    episode: item.IndexNumber != null ? Number(item.IndexNumber) : null,
    source,
    imdb: ids.imdb || undefined,
    tmdb: ids.tmdb || undefined,
    tvdb: ids.tvdb || undefined,
  };
}

async function buildReleaseMap(source, fetchItems, serverConfig) {
  if (serverConfig?.disabled || !serverConfig?.baseUrl) return new Map();
  const items = await fetchItems(serverConfig);
  const releases = new Map();
  for (const item of items) {
    const releaseDate = releaseDateForItem(item);
    if (!releaseDate) continue;
    const media = mediaFromItem(item, source);
    releases.set(mediaKeyFor(media), { releaseDate, title: media.title });
  }
  return releases;
}

function isScheduledLibraryHistory(data = {}, label = "") {
  const telemetry = String(data.syncDispatchTelemetry || data.sync_dispatch_telemetry || "");
  return telemetry.includes(`Watch event fetched from ${label} library history`);
}

function hasSyntheticMidnightWatchedAt(data = {}) {
  return /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(String(data.watchedAt || ""));
}

async function repairSource(source, label, releases) {
  if (!releases.size) return { source, scanned: 0, scheduled: 0, synthetic: 0, changed: 0, skippedNoRelease: 0 };

  const snapshot = await db.collection("watchHistory").where("source", "==", source).get();
  let scanned = 0;
  let scheduled = 0;
  let synthetic = 0;
  let changed = 0;
  let skippedNoRelease = 0;
  let batch = db.batch();
  let batchCount = 0;

  for (const doc of snapshot.docs) {
    scanned++;
    const data = doc.data() || {};
    if (!isScheduledLibraryHistory(data, label)) continue;
    scheduled++;
    if (!hasSyntheticMidnightWatchedAt(data)) continue;
    synthetic++;

    const key = data.mediaKey || mediaKeyFor({
      mediaType: data.mediaType,
      title: data.title,
      season: data.season,
      episode: data.episode,
      imdb: data.ids?.imdb,
      tmdb: data.ids?.tmdb,
      tvdb: data.ids?.tvdb,
    });
    const release = releases.get(key);
    if (!release?.releaseDate) {
      skippedNoRelease++;
      continue;
    }
    if (data.watchedAt === release.releaseDate) continue;

    changed++;
    if (verbose) {
      console.log(`${write ? "Updating" : "Would update"} ${source}: ${data.title} :: ${data.watchedAt} -> ${release.releaseDate}`);
    }

    if (write) {
      batch.update(doc.ref, {
        watchedAt: release.releaseDate,
        updatedAt: FieldValue.serverTimestamp(),
      });
      batchCount++;
      if (batchCount >= 400) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    }
  }

  if (write && batchCount) await batch.commit();
  return { source, scanned, scheduled, synthetic, changed, skippedNoRelease };
}

const config = await loadMediaConfig();
const embyReleases = await buildReleaseMap("emby", fetchEmbyWatchedItems, config.emby);
const jellyfinReleases = await buildReleaseMap("jellyfin", fetchJellyfinWatchedItems, config.jellyfin);

const results = [
  await repairSource("emby", "Emby", embyReleases),
  await repairSource("jellyfin", "Jellyfin", jellyfinReleases),
];

if (write && results.some((result) => result.changed > 0)) {
  await invalidateHistoryDerivedCaches();
}

console.log(JSON.stringify({ mode: write ? "write" : "dry-run", results }, null, 2));
