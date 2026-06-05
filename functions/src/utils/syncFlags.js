export function watchedPlayedSyncEnabled() {
  const raw = String(
    process.env.WATCHED_PLAYED_SYNC_ENABLED ??
      process.env.ENABLE_WATCHED_PLAYED_SYNC ??
      "true",
  )
    .trim()
    .toLowerCase();

  return !["0", "false", "no", "off", "disabled"].includes(raw);
}
