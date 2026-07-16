import test from "node:test";
import assert from "node:assert/strict";

import { parseSettingsRoute, settingsDashboardSummary, settingsPathForLegacy } from "../public/modules/settings-shell.js";

test("settings routes resolve groups, defaults, and focused tasks", () => {
  assert.deepEqual(
    { group: parseSettingsRoute("/settings/connections").group, task: parseSettingsRoute("/settings/connections").task },
    { group: "connections", task: "plex" },
  );
  assert.equal(parseSettingsRoute("/settings/connections/jellyfin").path, "/settings/connections/jellyfin");
  assert.equal(parseSettingsRoute("/settings/system/storage").panel, "cache");
  assert.equal(parseSettingsRoute("/settings/data/restore").backupTab, "restore");
});

test("legacy and invalid settings routes normalize safely", () => {
  assert.equal(parseSettingsRoute("/settings/general").path, "/settings/account/login");
  assert.equal(parseSettingsRoute("/settings/tools").path, "/settings/system/advanced");
  assert.equal(parseSettingsRoute("/sync").path, "/settings/system/sync");
  assert.equal(settingsPathForLegacy("api-keys"), "/settings/metadata/tmdb");
  assert.equal(parseSettingsRoute("/settings/not-a-group").path, "/settings");
});

test("forced password changes always resolve to account login", () => {
  const route = parseSettingsRoute("/settings/system/logs", { mustChangePassword: true });
  assert.equal(route.path, "/settings/account/login");
  assert.equal(route.panel, "general");
  assert.deepEqual(route.subPanels, ["general-login"]);
});

test("dashboard distinguishes unknown, configured, and attention states", () => {
  const unknown = settingsDashboardSummary();
  assert.equal(unknown.connections.tone, "unknown");
  assert.equal(unknown.backups.tone, "unknown");
  assert.equal(unknown.sync.tone, "unknown");

  const configured = settingsDashboardSummary({
    configLoaded: true,
    config: {
      plex: { configured: true },
      emby: { disabled: true },
      jellyfin: { disabled: true },
      seerr: { disabled: true },
      tmdb: { configured: true },
    },
    watchBackups: { config: { enabled: false }, runtime: {} },
    syncJobsLoaded: true,
    syncJobs: [],
  });
  assert.equal(configured.connections.tone, "ready");
  assert.equal(configured.metadata.tone, "ready");
  assert.equal(configured.backups.label, "Not scheduled");
  assert.equal(configured.sync.label, "No open issues");

  const attention = settingsDashboardSummary({
    configLoaded: true,
    config: { plex: { configured: false }, tmdb: { configured: false } },
    syncJobsLoaded: true,
    syncJobs: [{ id: 1 }, { id: 2 }],
  });
  assert.equal(attention.connections.tone, "warning");
  assert.equal(attention.metadata.label, "TMDB required");
  assert.equal(attention.sync.label, "2 unresolved");
});

test("dashboard reports loading, failed, stale, and active operations", () => {
  const loading = settingsDashboardSummary({ backupsLoading: true, syncJobsLoading: true });
  assert.equal(loading.backups.tone, "loading");
  assert.equal(loading.sync.tone, "loading");

  const failed = settingsDashboardSummary({
    watchBackups: { config: { enabled: true }, runtime: { lastError: "disk full" } },
    syncActive: true,
  });
  assert.equal(failed.backups.label, "Action required");
  assert.equal(failed.sync.label, "Sync running");

  const stale = settingsDashboardSummary({
    plembfinBackups: {
      config: { enabled: true },
      runtime: { lastSuccessAt: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString() },
    },
  });
  assert.equal(stale.backups.label, "Backup may be stale");
});
