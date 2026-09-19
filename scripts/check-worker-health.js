#!/usr/bin/env node
import path from "node:path";
import Database from "better-sqlite3";

try {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
  const db = new Database(path.join(dataDir, "plembfin.db"), { readonly: true, fileMustExist: true });
  // This probe runs in a separate Node process so a synchronous maintenance
  // batch in the application cannot make a healthy worker look dead. Keep the
  // query deliberately small; a full quick_check here would recreate the same
  // false timeout for large SQLite files.
  const lease = db.prepare("SELECT holder_id, expires_at FROM scheduler_lease WHERE id='scheduler'").get();
  const schema = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='scheduler_lease'").get();
  db.close();
  const role = String(process.env.ROLE || "all").trim().toLowerCase();
  const workerHealthy = role === "web"
    || (lease?.holder_id && Number(lease.expires_at) > Date.now());
  process.exit(schema?.ok === 1 && workerHealthy ? 0 : 1);
} catch {
  process.exit(1);
}
