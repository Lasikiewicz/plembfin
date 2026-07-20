import test from "node:test";
import assert from "node:assert/strict";

import { parseSettingsRoute, settingsPathForLegacy, SETTINGS_SECTIONS } from "../public/modules/settings-shell.js";

test("settings routes resolve flat sections and panels", () => {
  assert.equal(parseSettingsRoute("/settings").kind, "overview");
  assert.equal(parseSettingsRoute("/settings/media-servers").group, "media-servers-group");
  assert.equal(parseSettingsRoute("/settings/media-servers").panel, "apps");
  assert.equal(parseSettingsRoute("/settings/metadata").panel, "api-keys");
  assert.equal(parseSettingsRoute("/settings/storage").panel, "cache");
  assert.equal(parseSettingsRoute("/settings/restore").backupTab, "restore");
  assert.deepEqual(parseSettingsRoute("/settings/account").subPanels, ["general-login"]);
  assert.equal(parseSettingsRoute("/settings/sync-issues").path, "/settings/sync-issues");
  assert.equal(parseSettingsRoute("/settings/force-sync").panel, "sync");
  assert.deepEqual(parseSettingsRoute("/settings/force-sync").subPanels, ["sync-tools"]);
});

test("every section produces a routable canonical path with visible content", () => {
  // Panels that render their content inside data-sub-panel rows: a route that
  // resolves to one of these panels but lists no subPanels shows a blank page.
  const subPanelPanels = new Set(["general", "sync", "tools"]);
  for (const id of Object.keys(SETTINGS_SECTIONS)) {
    const route = parseSettingsRoute(`/settings/${id}`);
    assert.equal(route.kind, "task");
    assert.equal(route.section, id);
    assert.equal(route.path, `/settings/${id}`);
    assert.ok(route.panel, `section ${id} maps to a panel`);
    if (subPanelPanels.has(route.panel)) {
      assert.ok(route.subPanels?.length, `section ${id} on panel "${route.panel}" needs at least one visible sub-panel`);
    }
    if (route.panel === "backups") {
      assert.ok(route.backupTab, `section ${id} on the backups panel needs a backupTab`);
    }
  }
});

test("parent group routes aggregate every child's panel into one view list", () => {
  // Media Servers, Backup/Restore, and Advanced fan their children out across
  // different underlying panels (or backup tabs) - the parent route must
  // reveal all of them, not just the first.
  const mediaServers = parseSettingsRoute("/settings/media-servers-group");
  assert.deepEqual(
    mediaServers.views.map((v) => v.panel),
    ["apps", "general"],
  );

  const backupRestore = parseSettingsRoute("/settings/backup-restore-group");
  assert.deepEqual(
    backupRestore.views.map((v) => v.backupTab),
    ["settings", "restore"],
  );

  const advanced = parseSettingsRoute("/settings/advanced-group");
  assert.deepEqual(
    advanced.views.map((v) => v.panel),
    ["tools", "cache"],
  );

  const tools = parseSettingsRoute("/settings/tools-group");
  assert.deepEqual(
    tools.views.map((v) => v.panel),
    ["tools"],
  );
  const sync = parseSettingsRoute("/settings/sync-group");
  assert.deepEqual(sync.subPanels, ["sync-issues", "sync-history", "sync-tools"]);
});

test("legacy and invalid settings routes normalize safely", () => {
  assert.equal(parseSettingsRoute("/settings/general").path, "/settings/general");
  assert.equal(parseSettingsRoute("/settings/account/login").path, "/settings/account");
  assert.equal(parseSettingsRoute("/settings/apps").path, "/settings/media-servers");
  assert.equal(parseSettingsRoute("/settings/connections/plex").path, "/settings/media-servers");
  assert.equal(parseSettingsRoute("/settings/connections/webhooks").path, "/settings/webhooks");
  assert.equal(parseSettingsRoute("/settings/metadata/tmdb").path, "/settings/metadata");
  assert.equal(parseSettingsRoute("/settings/data/backups").path, "/settings/backups");
  assert.equal(parseSettingsRoute("/settings/data/restore").path, "/settings/restore");
  assert.equal(parseSettingsRoute("/settings/data/import").path, "/settings/import");
  assert.equal(parseSettingsRoute("/settings/system/health").path, "/settings/health");
  assert.equal(parseSettingsRoute("/settings/system/advanced").path, "/settings/database-repairs");
  assert.equal(parseSettingsRoute("/settings/tools").path, "/settings/database-repairs");
  assert.equal(parseSettingsRoute("/sync").path, "/settings/sync-issues");
  assert.equal(parseSettingsRoute("/logs").path, "/settings/logs");
  assert.equal(settingsPathForLegacy("api-keys"), "/settings/metadata");
  assert.equal(settingsPathForLegacy("changelog"), "/settings/about");
  assert.equal(parseSettingsRoute("/settings/not-a-section").path, "/settings");
});

test("forced password changes always resolve to account", () => {
  const route = parseSettingsRoute("/settings/logs", { mustChangePassword: true });
  assert.equal(route.path, "/settings/account");
  assert.equal(route.panel, "general");
  assert.deepEqual(route.subPanels, ["general-login"]);
});
