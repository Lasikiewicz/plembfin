import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-manual-unwatch-restore-queue-");
process.env.WATCHED_PLAYED_SYNC_ENABLED = "true";

const runtime = await import("../server/src/utils/configStore.js");
const repo = await import("../server/src/utils/dataRepo.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");
const { applyManualUnwatch } = await import("../server/src/routes/sync.js");

const config = {
  plex: { baseUrl: "http://plex.test", token: "plex-token" },
  emby: { baseUrl: "http://emby.test", apiKey: "emby-key", userId: "user" },
  jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "jellyfin-key", userId: "user" },
};

async function clearRuntimeState() {
  await runtime.setRuntimeState({
    syncOperation: null,
    restoreSyncActive: false,
    restoreSyncRunId: "",
    restoreSyncKind: "",
    forceSyncActive: false,
    scheduledSyncActive: false,
  });
}

test("manual unwatch commits local state and queues outbound sync during a restore", async () => {
  await clearRuntimeState();
  const watchedAt = "2026-07-17T07:38:26.506Z";
  const media = {
    title: "Restore Queue Movie",
    type: "movie",
    mediaType: "movie",
    source: "plex",
    ids: { tmdb: "restore-queue-movie" },
    watched_at: watchedAt,
    isValid: true,
  };
  const watched = await repo.insertWatchRecord({
    title: media.title,
    media_type: "movie",
    tmdb_id: media.ids.tmdb,
    watched_at: watchedAt,
    source: "plex",
    sync_action: "watched",
    sync_dispatch_telemetry: "Origin: plex\nDispatch status: success",
  });
  await repo.upsertPlaystateForMedia(media, "watched", watchedAt);

  const ownerId = "restore-queue-test";
  const claimed = await runtime.claimSyncOperation({
    kind: runtime.RESTORE_KIND_BACKUP,
    ownerId,
    activeField: "restoreSyncActive",
    values: {
      restoreSyncActive: true,
      restoreSyncRunId: ownerId,
      restoreSyncKind: runtime.RESTORE_KIND_BACKUP,
    },
  });
  assert.equal(claimed.ok, true);

  try {
    const result = await applyManualUnwatch(media, config, createLoopStore(), watched.id, {
      includeSourcePlatform: true,
      trackDispatch: false,
      force: true,
      lane: "interactive",
    });

    assert.equal(result.deferred, true);
    assert.equal(result.summary.deferred, true);

    const row = (await repo.getCachedHistory()).find((entry) => entry.id === watched.id);
    assert.equal(row.sync_action, "unwatched");
    assert.match(row.sync_dispatch_telemetry, /Origin: manual/);
    assert.match(row.sync_dispatch_telemetry, /Dispatch status: pending/);
    assert.equal((await repo.getPlaystateForMedia(media))?.state, "unwatched");
  } finally {
    await runtime.releaseSyncOperation({
      kind: runtime.RESTORE_KIND_BACKUP,
      ownerId,
      values: {
        restoreSyncActive: false,
        restoreSyncRunId: "",
        restoreSyncKind: "",
      },
    });
  }
});
