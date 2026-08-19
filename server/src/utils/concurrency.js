// Runs `handler` over `items` with bounded concurrency, awaiting every task
// before resolving. Outbound HTTP calls made by `handler` are still safely
// throttled per-host by acquireOutboundSlot in outbound.js, so raising this
// concurrency only shortens wall-clock time - it does not increase pressure
// on Plex/Emby/Jellyfin beyond what the governor already allows.
export async function runWithConcurrency(items, handler, concurrency = 6) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await handler(items[index], index);
    }
  });
  await Promise.all(workers);
}
