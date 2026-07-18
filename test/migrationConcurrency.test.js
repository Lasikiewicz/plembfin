import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

test("legacy schema migration is idempotent under concurrent process startup", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-legacy-concurrent-"));
  const dbPath = path.join(dataDir, "plembfin.db");
  const legacy = new Database(dbPath);
  legacy.exec(`CREATE TABLE watch_history (
    id TEXT PRIMARY KEY, title_lower TEXT, media_type TEXT, watched_at TEXT,
    media_key TEXT, show_title_lower TEXT
  ); INSERT INTO watch_history (id) VALUES ('legacy-row')`);
  legacy.close();

  const command = "import('./server/src/db.js').then(({db}) => { db.close(); })";
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", command], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(output || `migration child exited ${code}`)));
  });

  try {
    await Promise.all([run(), run()]);
    const upgraded = new Database(dbPath, { readonly: true });
    const columns = new Set(upgraded.pragma("table_info(watch_history)").map((column) => column.name));
    for (const name of ["logo_url", "backdrop_url", "sync_retry_count", "sync_next_retry_at"]) assert.ok(columns.has(name));
    assert.equal(upgraded.prepare("SELECT id FROM watch_history WHERE id='legacy-row'").get()?.id, "legacy-row");
    assert.deepEqual(upgraded.prepare("SELECT id FROM schema_migrations ORDER BY id").all().map((row) => row.id), [1, 2, 3]);
    upgraded.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
