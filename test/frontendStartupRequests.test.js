import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const appSource = fs.readFileSync(path.resolve(import.meta.dirname, "../public/app.js"), "utf8");
const appEventsSource = fs.readFileSync(path.resolve(import.meta.dirname, "../public/modules/app-events.js"), "utf8");

test("media-detail startup reads the bundled version without a remote changelog check", () => {
  assert.match(appSource, /checksForUpdates \? "\/api\/changelog\?refresh=1" : "\/changelog\.json"/);
  assert.match(appSource, /pathname === "\/" \|\| pathname === "\/dashboard"/);
});

test("the version badge opens the dedicated changelog route", () => {
  assert.match(appEventsSource, /elements\.appVersion\?\.addEventListener\("click", \(\) => \{[\s\S]*?navigateTo\("\/settings\/changelog"\)/);
});

test("diagnostic logs are fetched only while the Logs panel is visible", () => {
  const logDebugBody = appSource.match(/function logDebug\([\s\S]*?\n}/)?.[0] || "";
  assert.match(logDebugBody, /activeSettingsRoute\?\.panel === "logs"/);
  assert.doesNotMatch(appSource, /renderDbStatus\(false\);\s*renderLogs\(/);
  assert.match(appSource, /if \(!state\.hasLoadedLogsOnce\) renderLogs\(true\)/);
});

test("dynamic sidebar controls keep their own visibility outside demo mode", () => {
  assert.match(appSource, /if \(demo\) \{\s*element\.classList\.add\("hidden"\)/);
  assert.match(appSource, /element\.classList\.add\("hidden"\)/);
  assert.match(appSource, /element\.removeAttribute\("aria-hidden"\)/);
  assert.doesNotMatch(appSource, /element\.classList\.toggle\("hidden", demo\)/);
});
