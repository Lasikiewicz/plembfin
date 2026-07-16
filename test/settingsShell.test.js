import test from "node:test";
import assert from "node:assert/strict";

import { parseSettingsRoute, settingsPathForLegacy, SETTINGS_SECTIONS } from "../public/modules/settings-shell.js";

test("settings routes resolve flat sections and panels", () => {
  assert.equal(parseSettingsRoute("/settings").kind, "overview");
  assert.equal(parseSettingsRoute("/settings/media-servers").group, "media-servers");
  assert.equal(parseSettingsRoute("/settings/media-servers").panel, "apps");
  assert.equal(parseSettingsRoute("/settings/metadata").panel, "api-keys");
  assert.equal(parseSettingsRoute("/settings/storage").panel, "cache");
  assert.equal(parseSettingsRoute("/settings/restore").backupTab, "restore");
  assert.deepEqual(parseSettingsRoute("/settings/account").subPanels, ["general-login"]);
  assert.equal(parseSettingsRoute("/settings/sync").path, "/settings/sync");
});

test("every section produces a routable canonical path", () => {
  for (const id of Object.keys(SETTINGS_SECTIONS)) {
    const route = parseSettingsRoute(`/settings/${id}`);
    assert.equal(route.kind, "task");
    assert.equal(route.group, id);
    assert.equal(route.path, `/settings/${id}`);
    assert.ok(route.panel, `section ${id} maps to a panel`);
  }
});

test("legacy and invalid settings routes normalize safely", () => {
  assert.equal(parseSettingsRoute("/settings/general").path, "/settings/account");
  assert.equal(parseSettingsRoute("/settings/account/login").path, "/settings/account");
  assert.equal(parseSettingsRoute("/settings/apps").path, "/settings/media-servers");
  assert.equal(parseSettingsRoute("/settings/connections/plex").path, "/settings/media-servers");
  assert.equal(parseSettingsRoute("/settings/connections/webhooks").path, "/settings/webhooks");
  assert.equal(parseSettingsRoute("/settings/metadata/tmdb").path, "/settings/metadata");
  assert.equal(parseSettingsRoute("/settings/data/backups").path, "/settings/backups");
  assert.equal(parseSettingsRoute("/settings/data/restore").path, "/settings/restore");
  assert.equal(parseSettingsRoute("/settings/data/import").path, "/settings/import");
  assert.equal(parseSettingsRoute("/settings/system/health").path, "/settings/health");
  assert.equal(parseSettingsRoute("/settings/system/advanced").path, "/settings/advanced");
  assert.equal(parseSettingsRoute("/settings/tools").path, "/settings/advanced");
  assert.equal(parseSettingsRoute("/sync").path, "/settings/sync");
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
