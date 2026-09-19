import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capturesRoot = path.join(websiteRoot, "public", "assets", "app-captures");

// These source captures are full app views. The docs figures are intended to
// show the corresponding Settings section only, without the app chrome.
const crops = {
  "settings-general-account": { top: 65, height: 270 },
  "settings-general-integrity": { top: 315, height: 245 },
  "settings-general-storage-cache": { top: 550, height: 170 },
  "settings-backup-local": { top: 65, height: 235 },
  "settings-backup-remote": { top: 300, height: 320 },
  "settings-media-servers-plex": { top: 65, height: 345 },
  "settings-media-servers-emby": { top: 405, height: 155 },
  "settings-media-servers-jellyfin": { top: 595, height: 165 },
  "settings-metadata-providers": { top: 65, height: 480 },
  "settings-metadata-refresh": { top: 540, height: 240 },
  "settings-metadata-refresh-tmdb": { top: 540, height: 240 },
  "settings-metadata-refresh-tvdb": { top: 540, height: 240 },
  "settings-restore-merge-replace": { top: 65, height: 500 },
  "settings-restore-watch-history": { top: 65, height: 660 },
  "settings-sync-tuning": { top: 65, height: 125 },
  "settings-sync-tools": { top: 185, height: 380 },
  "settings-sync-history": { top: 565, height: 155 },
  "settings-tools-database-repairs": { top: 65, height: 450 },
  "settings-tools-library-rebuilds": { top: 520, height: 235 },
  "settings-tools-wipe-data": { top: 750, height: 430 },
  "settings-webhooks-setup": { top: 65, height: 730 },
  "settings-webhooks-secret": { top: 790, height: 170 },
  "settings-logs-controls": { top: 65, height: 1080 },
};

const focusedCrops = {
  "settings-index": { outputBase: "settings-index-focused", left: 160, width: 1440, top: 0, height: 759 },
  "settings-restore": { outputBase: "settings-restore-focused", top: 0, height: 520 },
};

async function cropVariant(baseName, theme, crop, outputBase = baseName) {
  const inputPath = path.join(capturesRoot, `${baseName}-${theme}.png`);
  if (!fs.existsSync(inputPath)) return false;

  const image = sharp(inputPath);
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error(`Could not read ${inputPath}`);

  const left = crop.left ?? 260;
  const top = Math.min(crop.top, metadata.height - 1);
  const width = Math.min(crop.width ?? 1335, metadata.width - left);
  const height = Math.min(crop.height, metadata.height - top);
  const output = await image.extract({ left, top, width, height }).png().toBuffer();
  const outputPath = path.join(capturesRoot, `${outputBase}-${theme}.png`);
  fs.writeFileSync(outputPath, output);
  return true;
}

let changed = 0;
for (const [baseName, crop] of Object.entries(crops)) {
  for (const theme of ["light", "dark"]) {
    if (await cropVariant(baseName, theme, crop)) changed += 1;
  }
}

for (const [baseName, crop] of Object.entries(focusedCrops)) {
  for (const theme of ["light", "dark"]) {
    if (await cropVariant(baseName, theme, crop, crop.outputBase)) changed += 1;
  }
}

console.log(`Cropped ${changed} settings capture variants.`);
