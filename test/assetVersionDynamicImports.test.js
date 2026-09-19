import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

// Runs the real asset-version check against a throwaway tree, so the test
// proves what `npm run assets:check` does rather than re-implementing it.
function runAssetCheck(appSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-asset-check-"));
  try {
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.mkdirSync(path.join(dir, "public", "modules"), { recursive: true });
    fs.copyFileSync(path.join(root, "scripts", "asset-versions.js"), path.join(dir, "scripts", "asset-versions.js"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "9.9.9", type: "module" }));
    fs.writeFileSync(path.join(dir, "public", "modules", "route.js"), "export const route = true;\n");
    fs.writeFileSync(path.join(dir, "public", "app.js"), appSource);
    return spawnSync(process.execPath, ["scripts/asset-versions.js", "--version=9.9.9"], { cwd: dir, encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a stamped dynamic module import passes the asset check", () => {
  const result = runAssetCheck('import("./modules/route.js?v=9.9.9");\n');
  assert.equal(result.status, 0, result.stderr);
});

test("an unstamped dynamic module import fails the asset check", () => {
  const result = runAssetCheck('import("./modules/route.js");\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /public\/app\.js: \.\/modules\/route\.js \(unversioned\)/);
});

test("an unstamped template-literal dynamic import fails the asset check", () => {
  const result = runAssetCheck("const name = \"route\";\nimport(`./modules/${name}.js`);\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unversioned/);
});

test("a dynamic import stamped with an old version fails the asset check", () => {
  const result = runAssetCheck('import("./modules/route.js?v=1.0.0");\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /route\.js\?v=1\.0\.0/);
});
