import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capturesRoot = path.join(websiteRoot, "public", "assets", "app-captures");
const bases = [
  "settings-general-account",
  "settings-general-integrity",
  "settings-general-storage-cache",
  "settings-backup-local",
  "settings-backup-remote",
  "settings-media-servers-plex",
  "settings-media-servers-emby",
  "settings-media-servers-jellyfin",
  "settings-metadata-providers",
  "settings-metadata-refresh",
  "settings-metadata-refresh-tmdb",
  "settings-metadata-refresh-tvdb",
  "settings-restore-merge-replace",
  "settings-restore-watch-history",
  "settings-sync-tuning",
  "settings-sync-tools",
  "settings-sync-history",
  "settings-tools-database-repairs",
  "settings-tools-library-rebuilds",
  "settings-tools-wipe-data",
  "settings-webhooks-setup",
  "settings-webhooks-secret",
  "settings-logs-controls",
];

function neutralizeGold(data) {
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const isGoldAccent = red > 30 && red - blue >= 12 && green - blue >= 8;
    if (!isGoldAccent) continue;

    const luminance = Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
    data[index] = luminance;
    data[index + 1] = Math.min(255, Math.round(luminance * 1.02));
    data[index + 2] = Math.min(255, Math.round(luminance * 1.08));
  }
}

let changed = 0;
for (const base of bases) {
  const inputPath = path.join(capturesRoot, `${base}-dark.png`);
  if (!fs.existsSync(inputPath)) continue;

  const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  neutralizeGold(data);
  const output = await sharp(data, { raw: info }).png().toBuffer();
  fs.writeFileSync(inputPath, output);
  changed += 1;
}

console.log(`Neutralized dark capture highlights in ${changed} assets.`);
