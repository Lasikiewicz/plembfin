import { hidePlexFromContinueWatching, markPlexUnplayed } from "./plexClient.js";
import { hideEmbyFromResume, setEmbyProgress } from "./embyClient.js";
import { hideJellyfinFromResume, updateJellyfinUserData } from "./jellyfinClient.js";
import { forgetUpNextRailSeed, listUpNextRailSeeds } from "./upNextSeedLedger.js";
import { runWithConcurrency } from "./concurrency.js";

const PROVIDERS = ["plex", "emby", "jellyfin"];
const SEED_CONCURRENCY = 4;

function text(value = "") {
  return String(value ?? "").trim();
}

// The old alpha implementation used a 6% position to make a future episode
// enter a calculated native rail. The writer has deliberately been removed.
// This clear-only operation remains so an upgrade can safely remove a legacy
// position without treating it as a real viewer resume.
export async function clearLegacyUpNextRailSeed(config, seed, { lane = "interactive" } = {}) {
  const provider = text(seed?.provider).toLowerCase();
  const providerItemId = text(seed?.providerItemId || seed?.provider_item_id);
  if (!providerItemId || !PROVIDERS.includes(provider)) {
    return { platform: provider || "unknown", status: "not_found" };
  }
  const media = {
    type: "episode",
    media_type: "episode",
    title: seed?.title || "Untitled",
    provider_items: { [provider]: [providerItemId] },
    provider_item_id: providerItemId,
    provider,
    source: provider,
    positionMs: 0,
    offsetMs: 0,
    lane,
    isValid: true,
  };

  let result;
  if (provider === "plex") {
    // Plex's /:/progress?time=0 endpoint does not clear a stored viewOffset;
    // unscrobble is the native clear operation. Dismiss the separate rail
    // membership too, because it can outlive the progress row.
    result = await markPlexUnplayed(config.plex, media);
    if (result?.status === "fulfilled") await hidePlexFromContinueWatching(config.plex, providerItemId, { lane });
  } else if (provider === "emby") {
    result = await setEmbyProgress(config.emby, media);
    if (result?.status === "fulfilled") await hideEmbyFromResume(config.emby, providerItemId, { lane });
  } else {
    // Jellyfin UserData updates merge only the fields supplied, so clearing
    // PlaybackPositionTicks does not alter the watched flag or play count.
    result = await updateJellyfinUserData(
      config.jellyfin,
      providerItemId,
      { PlaybackPositionTicks: 0 },
      { lane },
    );
    if (result?.status === "fulfilled") await hideJellyfinFromResume(config.jellyfin, providerItemId, { lane });
  }

  if (result?.status === "fulfilled") forgetUpNextRailSeed(provider, providerItemId);
  return result;
}

// Remove only stale legacy rows here. A desired legacy row stays until the
// provider rail refresh has verified its episode and predecessor, which lets
// that path acknowledge the clear as an outbound synthetic update.
export async function clearLegacyUpNextRailSeeds({ config = {}, providers = [], desiredIdsByProvider = {} } = {}) {
  const results = [];
  const selected = [...new Set((Array.isArray(providers) ? providers : []).map((provider) => text(provider).toLowerCase()))]
    .filter((provider) => PROVIDERS.includes(provider));
  for (const provider of selected) {
    const desired = desiredIdsByProvider[provider] instanceof Set
      ? desiredIdsByProvider[provider]
      : new Set(desiredIdsByProvider[provider] || []);
    const stale = listUpNextRailSeeds(provider).filter((seed) => !desired.has(seed.providerItemId));
    await runWithConcurrency(stale, async (seed) => {
      try {
        const result = await clearLegacyUpNextRailSeed(config, seed);
        results.push({
          provider,
          provider_item_id: seed.providerItemId,
          title: seed.title || "Untitled",
          status: result?.status === "fulfilled" ? "cleared" : "failed",
          reason: result?.status === "fulfilled" ? undefined : result?.detail || "Provider rejected legacy rail cleanup.",
        });
      } catch (error) {
        results.push({
          provider,
          provider_item_id: seed.providerItemId,
          title: seed.title || "Untitled",
          status: "failed",
          reason: text(error?.message || error) || "Legacy rail cleanup failed.",
        });
      }
    }, SEED_CONCURRENCY);
  }
  return results;
}
