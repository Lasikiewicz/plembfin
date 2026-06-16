import Database from "better-sqlite3";
import { 
  insertWatchRecord, 
  upsertPlaystateForMedia, 
  updateWatchTelemetry, 
  requireDb,
  invalidateHistoryDerivedCaches
} from "../server/src/utils/firestoreRepo.js";
import { syncMediaPlaystate } from "../server/src/utils/syncOrchestrator.js";
import { loadMediaConfig } from "../server/src/utils/configStore.js";
import { createLoopStore } from "../server/src/utils/loopStore.js";

async function run() {
  console.log("Simulating handleManualWatch for 118 episodes...");
  const config = await loadMediaConfig();
  const loopStore = createLoopStore();

  const episodes = [];
  // Generate 118 mock episodes (e.g. 6 seasons, ~20 episodes each)
  let count = 0;
  for (let s = 1; s <= 6; s++) {
    for (let e = 1; e <= 20; e++) {
      count++;
      if (count > 118) break;
      episodes.push({
        media_type: "episode",
        title: `Lost - S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")} - Episode ${e}`,
        watched_at: new Date().toISOString(),
        source: "manual",
        tmdb_id: "2734",
        season: s,
        episode_number: e,
        poster_url: null,
      });
    }
  }

  console.log(`Generated ${episodes.length} episodes.`);
  
  const startTime = Date.now();
  let inserted = 0;
  let skipped = 0;
  let rejected = 0;

  for (const [index, rawRecord] of episodes.entries()) {
    const itemStart = Date.now();
    try {
      const pending = {
        ...rawRecord,
        source: rawRecord.source || "manual",
        sync_action: "watched",
        sync_dispatch_telemetry: "Origin: manual\nLoop-check: Passed\nDispatch status: pending\nDetails: Manual watch propagation queued.",
      };
      
      // We simulate watchRecordToFirestoreData logic
      const record = {
        title: pending.title,
        media_type: pending.media_type,
        watched_at: pending.watched_at,
        source: pending.source,
        imdb_id: null,
        tmdb_id: pending.tmdb_id,
        tvdb_id: null,
        season: pending.season,
        episode: pending.episode_number,
        poster_url: pending.poster_url,
        sync_action: "watched",
        sync_dispatch_telemetry: pending.sync_dispatch_telemetry,
        episode_title: `Episode ${pending.episode_number}`,
      };

      const insertResult = await insertWatchRecord(requireDb(), record, { skipInvalidate: true });
      inserted++;

      const media = {
        title: record.title,
        type: record.media_type,
        source: "manual",
        ids: { tmdb: record.tmdb_id },
        season: record.season,
        episode: record.episode,
        posterUrl: record.poster_url,
        isValid: true,
      };

      await upsertPlaystateForMedia(requireDb(), media, "watched", record.watched_at, { skipInvalidate: true });

      // Simulate sync
      const syncStart = Date.now();
      const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
        skipped: false,
        status: "error",
        details: `Manual watch propagation failed: ${error.message || String(error)}`,
        targetStates: [],
      }));
      const syncDuration = Date.now() - syncStart;

      await updateWatchTelemetry(requireDb(), insertResult.id, "Simulated telemetry", { skipInvalidate: true });

      const itemDuration = Date.now() - itemStart;
      console.log(`Episode ${index + 1}/${episodes.length}: Inserted in ${itemDuration - syncDuration}ms, Synced in ${syncDuration}ms.`);
      
      // Stop early if it's taking too long
      if (index >= 5) {
        console.log("Stopping simulation early after 6 episodes to avoid long run time.");
        break;
      }
    } catch (error) {
      rejected++;
      console.error(`Failed at index ${index}:`, error);
    }
  }

  await invalidateHistoryDerivedCaches().catch(() => null);
  console.log(`Simulation complete in ${Date.now() - startTime}ms. Inserted: ${inserted}, Skipped: ${skipped}, Rejected: ${rejected}`);
}

run().catch(console.error);
