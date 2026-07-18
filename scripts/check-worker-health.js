#!/usr/bin/env node
import path from "node:path";
import Database from "better-sqlite3";

try {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
  const db = new Database(path.join(dataDir, "plembfin.db"), { readonly: true, fileMustExist: true });
  const lease = db.prepare("SELECT holder_id, expires_at FROM scheduler_lease WHERE id='scheduler'").get();
  const integrity = db.pragma("quick_check", { simple: true });
  db.close();
  process.exit(integrity === "ok" && lease?.holder_id && Number(lease.expires_at) > Date.now() ? 0 : 1);
} catch {
  process.exit(1);
}
