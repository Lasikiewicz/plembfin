#!/usr/bin/env node
// One-time migration: copy data out of the old Firebase project (Firestore +
// Storage) into the local SQLite database and data/media artwork folder.
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account-key.json \
//   FIREBASE_STORAGE_BUCKET=plembfin.firebasestorage.app \
//   node scripts/migrate-firestore-to-sqlite.js
//
// It is idempotent (INSERT OR REPLACE), so it can be re-run safely.

import fs from "node:fs";
import path from "node:path";
import admin from "firebase-admin";
import { db } from "../server/src/db.js";
import { MEDIA_DIR } from "../server/src/paths.js";

const SERVICE_ACCOUNT = process.env.GOOGLE_APPLICATION_CREDENTIALS || "./service-account-key.json";
const STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || "";

function initFirebase() {
  const credPath = path.resolve(SERVICE_ACCOUNT);
  if (!fs.existsSync(credPath)) {
    console.error(`Service account key not found at ${credPath}. Set GOOGLE_APPLICATION_CREDENTIALS.`);
    process.exit(1);
  }
  const serviceAccount = JSON.parse(fs.readFileSync(credPath, "utf8"));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: STORAGE_BUCKET || undefined,
  });
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object") {
    if (typeof v.toMillis === "function") return v.toMillis();
    if (typeof v._seconds === "number") return v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function json(v) {
  return v == null ? null : JSON.stringify(v);
}

async function migrateCollection(firestore, name, handler) {
  const snapshot = await firestore.collection(name).get();
  let count = 0;
  const run = db.transaction((docs) => {
    for (const doc of docs) {
      handler(doc.id, doc.data() || {});
      count += 1;
    }
  });
  run(snapshot.docs);
  console.log(`  ${name}: ${count} docs`);
  return count;
}

async function main() {
  initFirebase();
  const firestore = admin.firestore();

  console.log("Migrating Firestore collections to SQLite...");

  const insertWatch = db.prepare(
    `INSERT OR REPLACE INTO watch_history (id, title, title_lower, media_type, watched_at, source, imdb_id, tmdb_id, tvdb_id, season, episode, poster_url, youtube_url, sync_action, sync_dispatch_telemetry, media_key, show_title, show_title_lower, episode_title, created_at, updated_at)
     VALUES (@id,@title,@title_lower,@media_type,@watched_at,@source,@imdb_id,@tmdb_id,@tvdb_id,@season,@episode,@poster_url,@youtube_url,@sync_action,@sync_dispatch_telemetry,@media_key,@show_title,@show_title_lower,@episode_title,@created_at,@updated_at)`,
  );
  await migrateCollection(firestore, "watchHistory", (id, d) => {
    insertWatch.run({
      id, title: d.title || "", title_lower: d.titleLower || String(d.title || "").toLowerCase(),
      media_type: d.mediaType || "", watched_at: d.watchedAt || "", source: d.source || "",
      imdb_id: d.ids?.imdb || null, tmdb_id: d.ids?.tmdb || d.tmdbId || null, tvdb_id: d.ids?.tvdb || null,
      season: d.season ?? null, episode: d.episode ?? null, poster_url: d.posterUrl || null, youtube_url: d.youtubeUrl || null,
      sync_action: d.syncAction || "watched", sync_dispatch_telemetry: d.syncDispatchTelemetry || null,
      media_key: d.mediaKey || null, show_title: d.showTitle || null, show_title_lower: d.showTitleLower || null,
      episode_title: d.episodeTitle || null, created_at: toMs(d.createdAt), updated_at: toMs(d.updatedAt),
    });
  });

  const insertPlaystate = db.prepare(
    `INSERT OR REPLACE INTO playstate (media_key, title, title_lower, media_type, state, watched_at, last_source, sources, imdb_id, tmdb_id, tvdb_id, season, episode, poster_url, updated_at)
     VALUES (@media_key,@title,@title_lower,@media_type,@state,@watched_at,@last_source,@sources,@imdb_id,@tmdb_id,@tvdb_id,@season,@episode,@poster_url,@updated_at)`,
  );
  await migrateCollection(firestore, "playstate", (id, d) => {
    insertPlaystate.run({
      media_key: d.mediaKey || id, title: d.title || "", title_lower: d.titleLower || String(d.title || "").toLowerCase(),
      media_type: d.mediaType || "", state: d.state || "watched", watched_at: d.watchedAt || "",
      last_source: d.lastSource || d.source || "", sources: json(Array.isArray(d.sources) ? d.sources : []),
      imdb_id: d.ids?.imdb || null, tmdb_id: d.ids?.tmdb || null, tvdb_id: d.ids?.tvdb || null,
      season: d.season ?? null, episode: d.episode ?? null, poster_url: d.posterUrl || null, updated_at: toMs(d.updatedAt),
    });
  });

  const insertProgress = db.prepare(
    `INSERT OR REPLACE INTO playback_progress (media_key, title, media_type, source, imdb_id, tmdb_id, tvdb_id, season, episode, position_ms, duration_ms, progress, updated_at, sync_dispatch_telemetry)
     VALUES (@media_key,@title,@media_type,@source,@imdb_id,@tmdb_id,@tvdb_id,@season,@episode,@position_ms,@duration_ms,@progress,@updated_at,@sync_dispatch_telemetry)`,
  );
  await migrateCollection(firestore, "playbackProgress", (id, d) => {
    insertProgress.run({
      media_key: d.mediaKey || id, title: d.title || "", media_type: d.mediaType || "", source: d.source || "",
      imdb_id: d.ids?.imdb || null, tmdb_id: d.ids?.tmdb || null, tvdb_id: d.ids?.tvdb || null,
      season: d.season ?? null, episode: d.episode ?? null, position_ms: d.positionMs ?? 0, duration_ms: d.durationMs ?? null,
      progress: d.progress ?? 0, updated_at: toMs(d.updatedAt) ?? Date.now(), sync_dispatch_telemetry: d.syncDispatchTelemetry || null,
    });
  });

  const insertLive = db.prepare(
    `INSERT OR REPLACE INTO live_tracking_cache (session_id, title, source_platform, last_progress, updated_at, completed_at, payload, expire_at)
     VALUES (@session_id,@title,@source_platform,@last_progress,@updated_at,@completed_at,@payload,@expire_at)`,
  );
  await migrateCollection(firestore, "liveTrackingCache", (id, d) => {
    insertLive.run({
      session_id: id, title: d.title || "", source_platform: d.sourcePlatform || "", last_progress: d.lastProgress ?? 0,
      updated_at: toMs(d.updatedAt) ?? Date.now(), completed_at: toMs(d.completedAt), payload: json(d.payload || {}),
      expire_at: toMs(d.expireAt),
    });
  });

  const insertSync = db.prepare(
    `INSERT INTO sync_history (timestamp, media_type, title, source, status, details, action, target_states, raw_payload_debug, created_at)
     VALUES (@timestamp,@media_type,@title,@source,@status,@details,@action,@target_states,@raw_payload_debug,@created_at)`,
  );
  await migrateCollection(firestore, "syncHistory", (id, d) => {
    insertSync.run({
      timestamp: toMs(d.timestamp) ?? Date.now(), media_type: d.mediaType || "unknown", title: d.title || "",
      source: d.source || "unknown", status: d.status || "unknown", details: d.details || "", action: d.action || "watched",
      target_states: json(Array.isArray(d.targetStates) ? d.targetStates : []), raw_payload_debug: json(d.rawPayloadDebug || {}),
      created_at: toMs(d.createdAt) ?? Date.now(),
    });
  });

  const settingsDoc = await firestore.collection("settings").doc("mediaConfig").get();
  if (settingsDoc.exists) {
    db.prepare("INSERT OR REPLACE INTO settings (id, data, updated_at) VALUES (?, ?, ?)").run("mediaConfig", json(settingsDoc.data()), Date.now());
    console.log("  settings/mediaConfig: migrated");
  }
  const runtimeDoc = await firestore.collection("runtimeState").doc("main").get();
  if (runtimeDoc.exists) {
    db.prepare("INSERT OR REPLACE INTO runtime_state (id, data, updated_at) VALUES (?, ?, ?)").run("main", json(runtimeDoc.data()), Date.now());
    console.log("  runtimeState/main: migrated");
  }

  const insertLoop = db.prepare("INSERT OR REPLACE INTO loop_keys (id, key, value, created_at, expire_at) VALUES (@id,@key,@value,@created_at,@expire_at)");
  await migrateCollection(firestore, "loopKeys", (id, d) => {
    insertLoop.run({ id, key: d.key || "", value: d.value || "", created_at: toMs(d.createdAt), expire_at: toMs(d.expireAt) });
  });

  // TMDB caches
  const insertMeta = db.prepare("INSERT OR REPLACE INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, schema_version, updated_at_ms) VALUES (@id,@tmdb_id,@media_type,@title,@details,@schema_version,@updated_at_ms)");
  await migrateCollection(firestore, "tmdbMetadataCache", (id, d) => {
    insertMeta.run({ id, tmdb_id: d.tmdbId != null ? String(d.tmdbId) : null, media_type: d.mediaType || null, title: d.title || null, details: d.details != null ? json(d.details) : null, schema_version: d.schemaVersion ?? null, updated_at_ms: d.updatedAtMs ?? toMs(d.updatedAt) });
  });
  const insertSearch = db.prepare("INSERT OR REPLACE INTO tmdb_search_cache (id, query, media_type, page, response, missing, updated_at_ms) VALUES (@id,@query,@media_type,@page,@response,@missing,@updated_at_ms)");
  await migrateCollection(firestore, "tmdbSearchCache", (id, d) => {
    insertSearch.run({ id, query: d.query || "", media_type: d.mediaType || null, page: d.page ?? 1, response: json(d.response), missing: d.missing ? 1 : 0, updated_at_ms: d.updatedAtMs ?? toMs(d.updatedAt) });
  });
  const insertSeason = db.prepare("INSERT OR REPLACE INTO tmdb_season_cache (id, tmdb_id, season_number, show_status, details, updated_at_ms) VALUES (@id,@tmdb_id,@season_number,@show_status,@details,@updated_at_ms)");
  await migrateCollection(firestore, "tmdbSeasonCache", (id, d) => {
    insertSeason.run({ id, tmdb_id: d.tmdbId != null ? String(d.tmdbId) : null, season_number: d.seasonNumber ?? null, show_status: d.showStatus || null, details: json(d.details), updated_at_ms: d.updatedAtMs ?? toMs(d.updatedAt) });
  });
  const insertPerson = db.prepare("INSERT OR REPLACE INTO tmdb_person_cache (id, person_id, details, schema_version, updated_at_ms) VALUES (@id,@person_id,@details,@schema_version,@updated_at_ms)");
  await migrateCollection(firestore, "tmdbPersonCache", (id, d) => {
    insertPerson.run({ id, person_id: d.personId != null ? String(d.personId) : null, details: json(d.details), schema_version: d.schemaVersion ?? null, updated_at_ms: d.updatedAtMs ?? toMs(d.updatedAt) });
  });

  // Poster cache + Storage binaries
  await migratePosterCache(firestore);

  console.log("Migration complete.");
  process.exit(0);
}

async function migratePosterCache(firestore) {
  const bucket = STORAGE_BUCKET ? admin.storage().bucket() : null;
  const insertPoster = db.prepare(
    `INSERT OR REPLACE INTO poster_cache (id, media_key, variant, status, source, detail, original_url, storage_path, content_type, size_bytes, url, updated_at_ms)
     VALUES (@id,@media_key,@variant,@status,@source,@detail,@original_url,@storage_path,@content_type,@size_bytes,@url,@updated_at_ms)`,
  );
  const snapshot = await firestore.collection("posterCache").get();
  let migrated = 0;
  let downloaded = 0;
  for (const doc of snapshot.docs) {
    const d = doc.data() || {};
    let url = null;
    let status = d.status || "missing";
    if (d.status === "cached" && d.storagePath && bucket) {
      const dest = path.join(MEDIA_DIR, d.storagePath);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await bucket.file(d.storagePath).download({ destination: dest });
        url = `/media/${d.storagePath}`;
        downloaded += 1;
      } catch (error) {
        console.warn(`  poster download failed for ${d.storagePath}: ${error.message}`);
        status = "missing";
      }
    }
    insertPoster.run({
      id: doc.id, media_key: d.mediaKey || null, variant: d.variant || "poster", status,
      source: d.source || "unknown", detail: d.detail || null, original_url: d.originalUrl || null,
      storage_path: d.storagePath || null, content_type: d.contentType || null, size_bytes: d.sizeBytes ?? null,
      url, updated_at_ms: d.updatedAtMs ?? toMs(d.updatedAt),
    });
    migrated += 1;
  }
  console.log(`  posterCache: ${migrated} docs (${downloaded} artwork files downloaded)`);
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
