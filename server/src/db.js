import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { DB_PATH, ensureDataDirs } from "./paths.js";

ensureDataDirs();

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
db.exec(schema);

// ---------------------------------------------------------------------------
// In-process derived-cache version. In the old Firebase deployment, ephemeral
// Cloud Run instances tracked a "version" marker doc in Firestore to invalidate
// caches across instances. A single long-lived process can just keep an integer
// in memory and bump it on every write that changes history-derived results.
// ---------------------------------------------------------------------------
let dataVersion = 1;
export function getDataVersion() {
  return dataVersion;
}
export function bumpDataVersion() {
  dataVersion += 1;
  return dataVersion;
}

// JSON column helpers -------------------------------------------------------
export function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function toJson(value) {
  if (value == null) return null;
  return JSON.stringify(value);
}

export function now() {
  return Date.now();
}

// Run a function inside a single transaction (replaces Firestore batch()).
export function transaction(fn) {
  return db.transaction(fn)();
}
