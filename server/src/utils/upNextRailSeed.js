import { setPlexProgress } from "./plexClient.js";
import { hideEmbyFromResume, reportEmbyResumePosition, setEmbyProgress } from "./embyClient.js";
import { setJellyfinProgress } from "./jellyfinClient.js";
import { watchedThresholdPercent } from "./tuning.js";
import { upNextLookupMedia } from "./upNextLibraryLookup.js";
import { forgetUpNextRailSeed, listUpNextRailSeeds, recordUpNextRailSeeds } from "./upNextSeedLedger.js";
import { runWithConcurrency } from "./concurrency.js";

// Plex Continue Watching, Emby Resume, and Jellyfin Resume are calculated
// rails: their APIs can hide a row or report membership, but there is no
// "add this episode" operation. The only thing that puts an arbitrary item on
// them is a playback position.
//
// The first attempt used five seconds, on the theory that staying under
// Plembfin's own resume threshold made the write self-evidently safe. It was
// safe and it did not work. Plex accepted the request with a 200 and stored no
// viewOffset at all; Emby stored 0.19% of runtime and then filtered it out of
// Resume; only Jellyfin surfaced it. All three apply a minimum resume
// percentage (5% by default) before an item counts as in progress.
//
// So the position has to be a real fraction of the runtime, which necessarily
// puts it above Plembfin's own resume threshold. Size can no longer prove a
// position is synthetic, so each seed is recorded in the up_next_rail_seeds
// ledger and rejected by identity everywhere it would otherwise be taken for
// real progress. See docs/decisions.md entry 21.
const SEED_PERCENT = 6;
const MAX_SEED_ITEMS = 100;
const SEED_CONCURRENCY = 4;

function text(value = "") {
  return String(value ?? "").trim();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// 6% clears the providers' 5% minimum with room for their own rounding and
// stays far below the watched threshold at the other end. Without a runtime
// there is no percentage to take, and a guessed absolute would be under the
// minimum for a feature film and over it for a short, so such an item is
// reported as skipped rather than seeded with a number we cannot justify.
export function railSeedPositionMs(durationMs) {
  const duration = Math.max(0, Math.round(number(durationMs, 0)));
  if (duration <= 0) return 0;
  const position = Math.round((duration * SEED_PERCENT) / 100);
  const ceiling = Math.floor((duration * watchedThresholdPercent()) / 100);
  if (position <= 0 || position >= ceiling) return 0;
  return position;
}

async function writeSeed(provider, config, item, positionMs, providerItemId) {
  const media = {
    ...upNextLookupMedia(item),
    provider_items: { ...(item.provider_items || item.providerItems || {}), [provider]: [providerItemId] },
    positionMs,
    durationMs: Math.max(0, Math.round(number(item.duration_ms ?? item.durationMs, 0))),
    lane: "interactive",
    source: "manual",
    isValid: true,
  };
  if (provider === "plex") return setPlexProgress(config.plex, media);
  if (provider === "jellyfin") return setJellyfinProgress(config.jellyfin, media);
  // Emby alone needs the position reported as a playback session; a UserData
  // write stores it but never reaches the Resume rail. See the comment on
  // reportEmbyResumePosition.
  return reportEmbyResumePosition(config.emby, providerItemId, positionMs);
}

// A seed is only correct while its item is still in the queue. Once the queue
// moves on, the position Plembfin wrote keeps that episode pinned to the
// provider's Continue Watching rail forever - which is how Jellyfin ended up
// offering Reacher S04E07 and Ted Lasso S04E06 long after Plembfin had moved
// to S04E06 and S04E03. Clearing is therefore part of the push, not an
// afterthought: every seeded item that is no longer desired has its position
// zeroed and its ledger row dropped.
async function clearStaleSeeds(provider, config, desiredIds) {
  const stale = listUpNextRailSeeds(provider).filter((seed) => !desiredIds.has(seed.providerItemId));
  if (!stale.length) return [];
  const results = Array(stale.length);
  await runWithConcurrency(stale, async (seed, index) => {
    const media = {
      type: "episode",
      media_type: "episode",
      title: seed.title || "Untitled",
      provider_items: { [provider]: [seed.providerItemId] },
      positionMs: 0,
      lane: "interactive",
      source: "manual",
      isValid: true,
    };
    try {
      if (provider === "plex") await setPlexProgress(config.plex, media);
      else if (provider === "jellyfin") await setJellyfinProgress(config.jellyfin, media);
      else {
        // Zeroing the position is not enough on Emby: the rail is driven by the
        // playback index, so the entry is also hidden explicitly.
        await setEmbyProgress(config.emby, media);
        await hideEmbyFromResume(config.emby, seed.providerItemId, { lane: "interactive" }).catch(() => null);
      }
      forgetUpNextRailSeed(provider, seed.providerItemId);
      results[index] = { title: seed.title || "Untitled", status: "cleared" };
    } catch (error) {
      // Leave the ledger row in place so the next push retries; forgetting it
      // here would strand the position on the provider with nothing tracking it.
      results[index] = { title: seed.title || "Untitled", status: "failed", reason: text(error?.message || error) || "Could not clear the seeded position." };
    }
  }, SEED_CONCURRENCY);
  return results.filter(Boolean);
}

// `targetsByProvider` is the shared resolution pass from upNextLibraryLookup:
// it carries each item's native id and the runtime the position is calculated
// from. `existingResumeIds` holds the ids already on that provider's
// successfully refreshed resume feed; those are skipped unconditionally,
// because an item already on the rail needs no seed and overwriting it would
// replace a real playback position with a synthetic one.
export async function seedUpNextProviderRails({
  config = {},
  providers = [],
  targetsByProvider = {},
  existingResumeIds = {},
} = {}) {
  const summaries = [];

  for (const provider of providers) {
    const targets = (targetsByProvider[provider]?.resolved || []).slice(0, MAX_SEED_ITEMS);
    const onRail = existingResumeIds[provider] instanceof Set
      ? existingResumeIds[provider]
      : new Set(existingResumeIds[provider] || []);
    const results = Array(targets.length);
    const seeded = [];

    await runWithConcurrency(targets, async (target, index) => {
      const item = target.item || {};
      const title = text(item.title || item.show_title || "Untitled");
      if (onRail.has(target.providerItemId)) {
        results[index] = { title, status: "skipped", reason: "Already on the provider's resume rail." };
        return;
      }
      const positionMs = railSeedPositionMs(target.runtimeMs);
      if (!positionMs) {
        results[index] = { title, status: "skipped", reason: "The provider did not report a runtime to size the position from." };
        return;
      }
      try {
        const outcome = await writeSeed(provider, config, item, positionMs, target.providerItemId);
        const status = text(outcome?.status);
        if (status === "fulfilled") {
          results[index] = { title, status: "seeded", position_ms: positionMs };
          seeded.push({
            provider,
            providerItemId: target.providerItemId,
            positionMs,
            durationMs: target.runtimeMs,
            mediaKey: text(item.media_key || item.mediaKey),
            title,
          });
        } else if (status === "not_found") {
          results[index] = { title, status: "skipped", reason: "The item was not found in the provider library." };
        } else {
          results[index] = {
            title,
            status: "failed",
            reason: text(outcome?.detail || outcome?.error) || `The provider reported "${status || "no result"}".`,
          };
        }
      } catch (error) {
        results[index] = { title, status: "failed", reason: text(error?.message || error) || "Resume seed failed." };
      }
    }, SEED_CONCURRENCY);

    // Record before reporting. A seed the ledger does not know about is
    // indistinguishable from a real part-watch on its way back in.
    if (seeded.length) recordUpNextRailSeeds(seeded);

    const cleared = await clearStaleSeeds(
      provider,
      config,
      new Set(targets.map((target) => target.providerItemId)),
    );

    const applied = results.filter(Boolean);
    const failures = applied.filter((entry) => entry.status === "failed");
    summaries.push({
      provider,
      status: failures.length ? (failures.length === applied.length ? "failed" : "partial") : "succeeded",
      seeded_count: applied.filter((entry) => entry.status === "seeded").length,
      skipped_count: applied.filter((entry) => entry.status === "skipped").length,
      failed_count: failures.length + cleared.filter((entry) => entry.status === "failed").length,
      cleared_count: cleared.filter((entry) => entry.status === "cleared").length,
      seed_percent: SEED_PERCENT,
      results: [...applied, ...cleared],
    });
  }

  return summaries;
}

export const UP_NEXT_RAIL_SEED_PERCENT = SEED_PERCENT;
