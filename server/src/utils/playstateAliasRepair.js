import { enqueueBackgroundJob } from "./backgroundJobs.js";
import { loadMediaConfig } from "./configStore.js";
import { repairPlaystateEpisodeIdAliases as repairAliases } from "./dataRepo.js";
import { isDemoMode } from "./demoMode.js";
import { pendingManualWatchReviewAliasLookups } from "./manualWatchReview.js";
import { dismissedPlaystateAliasKeys } from "./playstateAliasReview.js";
import { lookupTmdbExternalIdKind } from "./tmdbGateway.js";
import { lookupTvdbEpisodeKind } from "./tvdbGateway.js";

// Scheduling for the playstate episode-id alias repair
// (plan/playstate-episode-id-repair.md). The scheduler tick runs the repair
// from cached TMDB `find` and TVDB episode answers only; ids it has no answer
// for are looked up by a background job, which then runs the repair again.
// TVDB (tier 2) ids only become pending once the row's TMDB answers are cached.

export const PLAYSTATE_ALIAS_REPAIR_JOB = "repair_playstate_episode_ids";
const LOOKUPS_PER_JOB = 400;
const TVDB_LOOKUPS_PER_JOB = 200;

function mergeLookups(left, right, keyOf) {
  const merged = new Map(left.map((item) => [keyOf(item), item]));
  for (const item of right) if (!merged.has(keyOf(item))) merged.set(keyOf(item), item);
  return [...merged.values()];
}

// Rows the user marked "Different show" on the Maintenance card are skipped.
// Pending manual watch reviews keyed on episode ids need the same lookups
// before their review can be hidden (manualWatchReview.js).
async function repairPlaystateEpisodeIdAliases() {
  const result = await repairAliases({ skipKeys: dismissedPlaystateAliasKeys() });
  const reviews = pendingManualWatchReviewAliasLookups();
  return {
    ...result,
    pendingLookups: mergeLookups(result.pendingLookups, reviews.pendingLookups, ({ source, id }) => `${source}:${id.toLowerCase()}`),
    pendingTvdbLookups: mergeLookups(result.pendingTvdbLookups, reviews.pendingTvdbLookups, ({ id }) => id),
  };
}

async function tmdbConfigured() {
  if (isDemoMode()) return false;
  const config = await loadMediaConfig().catch(() => null);
  return Boolean(config?.tmdb?.apiKey);
}

// Scheduler entry: no outbound calls.
export async function runScheduledPlaystateAliasRepair() {
  const result = await repairPlaystateEpisodeIdAliases();
  const hasPending = result.pendingLookups.length || result.pendingTvdbLookups.length;
  if (!hasPending || !(await tmdbConfigured())) return { ...result, queued: false };
  try {
    enqueueBackgroundJob(PLAYSTATE_ALIAS_REPAIR_JOB, {
      pending: result.pendingLookups.length,
      pendingTvdb: result.pendingTvdbLookups.length,
    });
    return { ...result, queued: true };
  } catch (error) {
    if (error?.code === "JOB_ACTIVE") return { ...result, queued: false };
    throw error;
  }
}

// Runs lookups until cancelled or a failure that would repeat for every id
// (a rejected key, or TVDB's rate-limit cooldown).
async function runLookups(items, lookup, label, log, isCancelled) {
  let looked = 0;
  let failed = 0;
  for (const item of items) {
    if (await isCancelled()) break;
    try {
      await lookup(item);
      looked += 1;
    } catch (error) {
      failed += 1;
      if ([400, 401, 429].includes(error?.status)) {
        log(`${label} lookup stopped: ${error.message}`);
        break;
      }
    }
  }
  return { looked, failed };
}

export async function runPlaystateAliasRepairJob(log = () => {}, { isCancelled = async () => false } = {}) {
  const before = await repairPlaystateEpisodeIdAliases();
  const pending = before.pendingLookups.slice(0, LOOKUPS_PER_JOB);
  log(`Looking up ${pending.length} of ${before.pendingLookups.length} episode id(s) with TMDB find...`);
  const tmdb = await runLookups(pending, ({ source, id }) => lookupTmdbExternalIdKind(source, id), "TMDB", log, isCancelled);

  // New TMDB answers can leave rows that only TVDB can prove.
  const middle = tmdb.looked ? await repairPlaystateEpisodeIdAliases() : null;
  const tvdbCandidates = (middle || before).pendingTvdbLookups;
  const tvdbPending = tvdbCandidates.slice(0, TVDB_LOOKUPS_PER_JOB);
  log(`Looking up ${tvdbPending.length} of ${tvdbCandidates.length} episode id(s) with TVDB...`);
  const tvdb = await runLookups(tvdbPending, ({ id }) => lookupTvdbEpisodeKind(id), "TVDB", log, isCancelled);

  const after = await repairPlaystateEpisodeIdAliases();
  for (const conflict of after.conflicts) {
    log(`Conflict left for review: ${conflict.title} (${conflict.aliasKey} ${conflict.aliasState} is newer than ${conflict.seriesKey} ${conflict.seriesState})`);
  }
  const passes = [before, middle, after].filter(Boolean);
  const summary = {
    success: true,
    lookups: tmdb.looked,
    failedLookups: tmdb.failed,
    tvdbLookups: tvdb.looked,
    failedTvdbLookups: tvdb.failed,
    deleted: passes.reduce((total, pass) => total + pass.deleted, 0),
    rekeyed: passes.reduce((total, pass) => total + pass.rekeyed, 0),
    conflicts: after.conflicts.length,
    stillPending: after.pendingLookups.length,
    stillPendingTvdb: after.pendingTvdbLookups.length,
  };
  log(`Playstate alias repair: removed ${summary.deleted}, rekeyed ${summary.rekeyed}, ${summary.conflicts} conflict(s), ${summary.stillPending} TMDB and ${summary.stillPendingTvdb} TVDB id(s) still to look up.`);
  return summary;
}
