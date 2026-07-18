import { sendJson, notFound } from "./utils/http.js";
import { handleLogin, handleLogout, handleAuthStatus, handleAuthApiKey, handleAuthWebhookSecret, handleAuthCredentials, handleRevokeAllSessions } from "./utils/auth.js";
import { backfillUnknownShowTitles } from "./utils/dataRepo.js";
import { runScheduledTick, startPlexNotificationListener, stopPlexNotificationListener } from "./scheduler.js";
import { handleBackupExport, handleBackupImport, handleImport, handlePlembfinBackups, handleWatchBackups } from "./routes/backups.js";
import { handleAppearance, handleConfig, handleMediaAppLinks, handleSeerrMediaStatus, handleSeerrRequest, handleSeerrStatus, handleTestConnection, handleTestPlexNotifications } from "./routes/admin.js";
import { handleClearMissingTelemetry, handleDeleteMedia, handleFullSyncWatchstates, handleHistory, handleMergeShows, handleMovies, handleRematchShow, handleShow, handleShows, handleUpdateWatch } from "./routes/media.js";
import { handleActiveSessions, handleCronSync, handleCronSyncStatus, handleForceSync, handleManualUnwatch, handleManualWatch, handleNowPlaying, handlePlaybackProgressList, handlePlaybackProgressUnwatch, handlePlaybackProgressWatch, handleRetrySync, handleStopForceSync, handleSyncHistory, handleSyncJobs, handleWebhook } from "./routes/sync.js";
import { handleFanartImages, handleMediaSearch, handleOmdbRating, handlePoster, handleTmdbDetails, handleTmdbDetailsBatch, handleTmdbImages, handleTmdbPerson, handleTmdbPoster, handleTmdbProfile, handleTmdbSearch, handleTmdbSeason, handleTvdbImages, handleTvdbSearch, handleUpcoming, handleYoutubeMeta } from "./routes/metadata.js";
import { handleAdminFixHistory, handleBackfillStatus, handleBackfillTrakt, handleCacheStats, handleChangelog, handleClearCache, handleDedupHistory, handleDiagnosticLogs, handleMaintenanceStub, handlePing, handleRefreshTmdbMetadata, handleRematchTvShows, handleSyncMatchReport } from "./routes/maintenance.js";

function routePath(req) {
  const path = req.path || new URL(req.originalUrl || req.url, "https://local").pathname;
  return path.replace(/^\/api\/?/, "").replace(/^\/+/, "") || "";
}

async function dispatch(req, res) {
  try {
    const path = routePath(req);
    if (path === "ping") return handlePing(req, res);
    if (path === "changelog") return handleChangelog(req, res);
    if (path === "diagnostic-logs") return handleDiagnosticLogs(req, res);
    if (path === "login") return handleLogin(req, res);
    if (path === "logout") return handleLogout(req, res);
    if (path === "auth/status" || path === "auth-status") return handleAuthStatus(req, res);
    if (path === "auth/apikey") return handleAuthApiKey(req, res);
    if (path === "auth/webhook-secret") return handleAuthWebhookSecret(req, res);
    if (path === "auth/sessions/revoke-all") return handleRevokeAllSessions(req, res);
    if (path === "auth/credentials") return handleAuthCredentials(req, res);
    if (path === "config") return handleConfig(req, res);
    if (path === "appearance") return handleAppearance(req, res);
    if (path === "history") return handleHistory(req, res);
    if (path === "sync-jobs") return handleSyncJobs(req, res);
    if (path === "sync-match-report") return handleSyncMatchReport(req, res);
    if (path === "sync-history") return handleSyncHistory(req, res);
    if (path === "clear-missing-telemetry") return handleClearMissingTelemetry(req, res);
    if (path === "movies") return handleMovies(req, res);
    if (path === "delete-media") return handleDeleteMedia(req, res);
    if (path === "shows") return handleShows(req, res);
    if (path === "show") return handleShow(req, res);
    if (path === "upcoming") return handleUpcoming(req, res);
    if (path === "full-sync-watchstates") return handleFullSyncWatchstates(req, res);
    if (path === "import") return handleImport(req, res);
    if (path === "backup/export") return handleBackupExport(req, res);
    if (path === "backup/import") return handleBackupImport(req, res);
    if (path === "watch-backups") return handleWatchBackups(req, res);
    if (path === "plembfin-backups") return handlePlembfinBackups(req, res);
    if (path === "manual-watch") return handleManualWatch(req, res);
    if (path === "manual-unwatch") return handleManualUnwatch(req, res);
    if (path === "playback-progress") return handlePlaybackProgressList(req, res);
    if (path === "playback-progress/watch") return handlePlaybackProgressWatch(req, res);
    if (path === "playback-progress/unwatch") return handlePlaybackProgressUnwatch(req, res);
    if (path === "retry-sync") return handleRetrySync(req, res);
    if (path === "update-watch") return handleUpdateWatch(req, res);
    if (path === "rematch-show") return handleRematchShow(req, res);
    if (path === "merge-shows") return handleMergeShows(req, res);
    if (path === "now-playing") return handleNowPlaying(req, res);
    if (path === "active-sessions") return handleActiveSessions(req, res);
    if (path === "cron-sync") return handleCronSync(req, res);
    if (path === "cron-sync/status") return handleCronSyncStatus(req, res);
    if (path === "force-sync") return handleForceSync(req, res);
    if (path === "stop-force-sync") return handleStopForceSync(req, res);
    if (path === "dedup-history") return handleDedupHistory(req, res);
    if (path === "tmdb-details") return handleTmdbDetails(req, res);
    if (path === "tmdb-details-batch") return handleTmdbDetailsBatch(req, res);
    if (path === "refresh-tmdb-metadata") return handleRefreshTmdbMetadata(req, res);
    if (path === "rematch-tv-shows") return handleRematchTvShows(req, res);
    if (path === "media-details") return handleTmdbDetails(req, res);
    if (path === "tmdb-search") return handleTmdbSearch(req, res);
    if (path === "tvdb-search") return handleTvdbSearch(req, res);
    if (path === "media-search") return handleMediaSearch(req, res);
    if (path === "tmdb-season") return handleTmdbSeason(req, res);
    if (path === "tmdb-images") return handleTmdbImages(req, res);
    if (path === "tvdb-images") return handleTvdbImages(req, res);
    if (path === "fanart-images") return handleFanartImages(req, res);
    if (path === "tmdb-person") return handleTmdbPerson(req, res);
    if (path === "youtube-meta") return handleYoutubeMeta(req, res);
    if (path === "omdb-rating") return handleOmdbRating(req, res);
    if (path === "webhook") return handleWebhook(req, res);
    if (path === "test-connection") return handleTestConnection(req, res);
    if (path === "test-plex-notifications") return handleTestPlexNotifications(req, res);
    if (path === "seerr/status") return handleSeerrStatus(req, res);
    if (path === "seerr/media-status") return handleSeerrMediaStatus(req, res);
    if (path === "seerr/request") return handleSeerrRequest(req, res);
    if (path === "media-app-links") return handleMediaAppLinks(req, res);
    if (path === "tmdb-poster") return handleTmdbPoster(req, res);
    if (path === "tmdb-profile") return handleTmdbProfile(req, res);
    if (path === "poster") return handlePoster(req, res);
    if (path === "cache-stats") return handleCacheStats(req, res);
    if (path === "clear-cache") return handleClearCache(req, res);
    if (path === "admin-backfill-status") return handleBackfillStatus(req, res);
    if (path === "admin-backfill-trakt") return handleBackfillTrakt(req, res);
    if (path === "admin-fix-history") return handleAdminFixHistory(req, res);
    if (["admin-ensure-columns", "admin-clear-mock"].includes(path)) return handleMaintenanceStub(req, res, path);
    return notFound(res);
  } catch (error) {
    console.error("API route failed", error);
    const status = Number(error?.status);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return sendJson(res, { error: error.message || "Request failed" }, status);
    }
    return sendJson(res, { error: "API route failed" }, 500);
  }
}

export { dispatch, runScheduledTick, startPlexNotificationListener, stopPlexNotificationListener, backfillUnknownShowTitles };
