import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the writable data directory. Defaults to <repo>/data for bare-metal;
// the Docker image sets DATA_DIR=/data with a mounted volume.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(repoRoot, "data"));
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const POSTERS_DIR = path.join(MEDIA_DIR, "posters");
export const BACKDROPS_DIR = path.join(MEDIA_DIR, "backdrops");
export const PROFILES_DIR = path.join(MEDIA_DIR, "profiles");
export const BACKUPS_DIR = path.join(DATA_DIR, "backups");
export const WATCH_HISTORY_BACKUPS_DIR = path.join(BACKUPS_DIR, "watch-history");
export const FULL_BACKUPS_DIR = path.join(BACKUPS_DIR, "plembfin");
export const DB_PATH = path.join(DATA_DIR, "plembfin.db");
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const PUBLIC_DIR = path.join(repoRoot, "public");

export function ensureDataDirs() {
  for (const dir of [DATA_DIR, MEDIA_DIR, POSTERS_DIR, BACKDROPS_DIR, PROFILES_DIR, BACKUPS_DIR, WATCH_HISTORY_BACKUPS_DIR, FULL_BACKUPS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
