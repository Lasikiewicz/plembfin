import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Creates a fresh temp data directory and points DATA_DIR at it. Must be
// called before any server module is imported, because db.js opens the SQLite
// database at import time. Typical usage at the top of a test file:
//
//   import { makeTempDataDir } from "./helpers.js";
//   makeTempDataDir("plembfin-mytest-");
//   const { db } = await import("../server/src/db.js");
export function makeTempDataDir(prefix = "plembfin-test-") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DATA_DIR = dataDir;
  return dataDir;
}
