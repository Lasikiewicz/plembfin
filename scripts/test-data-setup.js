// Loaded before each test file's imports. Some unit tests import server modules
// statically, and db.js opens its database during import. Keep those tests away
// from the application's real data directory, with one database per test worker.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-test-worker-"));
process.env.DATA_DIR = testDataDir;
process.on("exit", () => {
  try { fs.rmSync(testDataDir, { recursive: true, force: true }); } catch { /* Windows may still hold an open SQLite file */ }
});
