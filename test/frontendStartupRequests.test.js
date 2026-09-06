import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const appSource = fs.readFileSync(path.resolve(import.meta.dirname, "../public/app.js"), "utf8");

test("media-detail startup reads the bundled version without a remote changelog check", () => {
  assert.match(appSource, /checksForUpdates \? "\/api\/changelog\?refresh=1" : "\/changelog\.json"/);
  assert.match(appSource, /pathname === "\/" \|\| pathname === "\/dashboard"/);
});

test("diagnostic logs are fetched only while the Logs panel is visible", () => {
  const logDebugBody = appSource.match(/function logDebug\([\s\S]*?\n}/)?.[0] || "";
  assert.match(logDebugBody, /activeSettingsRoute\?\.panel === "logs"/);
  assert.doesNotMatch(appSource, /renderDbStatus\(false\);\s*renderLogs\(/);
  assert.match(appSource, /if \(!state\.hasLoadedLogsOnce\) renderLogs\(true\)/);
});
