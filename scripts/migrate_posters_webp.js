import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import admin from "firebase-admin";
import sharp from "sharp";

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    project: "plembfin",
    serviceAccount: "service-account-key.json",
    storageBucket: "",
    write: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") args.write = true;
    else if (arg === "--project") args.project = argv[++index] || args.project;
    else if (arg.startsWith("--project=")) args.project = arg.slice("--project=".length);
    else if (arg === "--service-account") args.serviceAccount = argv[++index] || args.serviceAccount;
    else if (arg.startsWith("--service-account=")) args.serviceAccount = arg.slice("--service-account=".length);
    else if (arg === "--storage-bucket") args.storageBucket = argv[++index] || args.storageBucket;
    else if (arg.startsWith("--storage-bucket=")) args.storageBucket = arg.slice("--storage-bucket=".length);
    else if (arg === "--help" || arg === "-h") args.help = true;
  }

  return args;
}

function printHelp() {
  console.log(`
WebP Poster Migration Utility

Finds existing JPG/PNG cached posters in Firebase Storage, resizes them
to 340px width, converts them to WebP format, uploads them back to Storage,
and updates both the posterCache and watchHistory Firestore documents.

Usage:
  node scripts/migrate_posters_webp.js [--write]

Options:
  --write                         Perform actual writes to Storage and Firestore.
  --project <id>                  Firebase project ID. Defaults to plembfin.
  --storage-bucket <name>         Firebase Storage bucket name.
  --service-account <path>        Service account JSON. Defaults to service-account-key.json.
  --help                          Show this help.
`.trim());
}

async function configureFirebase({ project, serviceAccount, storageBucket }) {
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || project;
  process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || project;
  process.env.FIREBASE_CONFIG =
    process.env.FIREBASE_CONFIG ||
    JSON.stringify({
      projectId: project,
      storageBucket: storageBucket || `${project}.firebasestorage.app`,
    });

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return;

  const credentialPath = path.resolve(serviceAccount);
  try {
    await fs.access(credentialPath);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
  } catch {
    throw new Error(`Service account file not found at: ${credentialPath}`);
  }
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    return;
  }

  console.log(`Configuring Firebase connection for project: ${args.project}...`);
  await configureFirebase(args);

  admin.initializeApp();
  const db = admin.firestore();
  const storageBucket = admin.storage().bucket(args.storageBucket || `${args.project}.firebasestorage.app`);

  console.log("Connected. Querying posterCache documents...");

  const snapshot = await db.collection("posterCache").get();
  const candidates = [];

  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    if (data.status !== "cached" || !data.url) continue;

    const isJpgOrPng =
      String(data.contentType).includes("image/jpeg") ||
      String(data.contentType).includes("image/png") ||
      String(data.storagePath).endsWith(".jpg") ||
      String(data.storagePath).endsWith(".png");

    if (isJpgOrPng) {
      candidates.push({ id: doc.id, data });
    }
  }

  console.log(`Found ${candidates.length} candidate posters using JPG/PNG formats.`);

  if (candidates.length === 0) {
    console.log("No posters need migration. Done.");
    return;
  }

  if (!args.write) {
    console.log("\n*** DRY RUN MODE *** (Run with --write to execute migration)");
    for (const candidate of candidates) {
      console.log(`  - Candidate key: "${candidate.data.mediaKey}", path: "${candidate.data.storagePath}", type: "${candidate.data.contentType}"`);
    }
    console.log(`\nDry run complete. Would migrate ${candidates.length} posters.`);
    return;
  }

  console.log(`\nStarting migration of ${candidates.length} posters...\n`);

  let migratedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    const { id, data } = candidates[i];
    const itemLabel = `[${i + 1}/${candidates.length}] Key: "${data.mediaKey}"`;
    console.log(`${itemLabel} - Migrating...`);

    try {
      // 1. Fetch the original image buffer
      const res = await fetch(data.url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} when fetching current poster`);
      }
      const originalBuffer = Buffer.from(await res.arrayBuffer());

      // 2. Convert and resize to WebP using sharp
      const webpBuffer = await sharp(originalBuffer)
        .resize({ width: 340, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();

      // 3. Define new storage path & token
      const token = crypto.randomUUID();
      const newStoragePath = `posters/${id}.webp`;

      console.log(`  -> Resized and converted. Buffer size: ${originalBuffer.length} bytes -> ${webpBuffer.length} bytes.`);
      console.log(`  -> Uploading to Storage at "${newStoragePath}"...`);

      // 4. Upload to Firebase Storage
      await storageBucket.file(newStoragePath).save(webpBuffer, {
        metadata: {
          contentType: "image/webp",
          cacheControl: "public, max-age=31536000, immutable",
          metadata: {
            firebaseStorageDownloadTokens: token,
            mediaKey: data.mediaKey,
            source: data.source || "unknown",
          },
        },
        resumable: false,
      });

      // 5. Build public WebP URL
      const newUrl = `https://firebasestorage.googleapis.com/v0/b/${storageBucket.name}/o/${encodeURIComponent(newStoragePath)}?alt=media&token=${token}`;

      // 6. Update poster cache document
      console.log("  -> Updating posterCache Firestore record...");
      await db.collection("posterCache").doc(id).update({
        contentType: "image/webp",
        storagePath: newStoragePath,
        sizeBytes: webpBuffer.length,
        url: newUrl,
        updatedAtMs: Date.now(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 7. Update watchHistory records referencing this URL
      console.log("  -> Querying watchHistory records to update reference URLs...");
      const historySnapshot = await db.collection("watchHistory")
        .where("posterUrl", "==", data.url)
        .get();

      if (historySnapshot.size > 0) {
        console.log(`  -> Found ${historySnapshot.size} referencing history records. Updating...`);
        const batch = db.batch();
        for (const historyDoc of historySnapshot.docs) {
          batch.update(historyDoc.ref, {
            posterUrl: newUrl,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        await batch.commit();
      }

      // 8. Delete the old storage file
      if (data.storagePath && data.storagePath !== newStoragePath) {
        console.log(`  -> Deleting old poster file at "${data.storagePath}"...`);
        await storageBucket.file(data.storagePath).delete().catch((err) => {
          console.warn(`  [Warn] Failed to delete old file "${data.storagePath}": ${err.message}`);
        });
      }

      console.log(`${itemLabel} - SUCCESS.`);
      migratedCount++;
    } catch (err) {
      console.error(`${itemLabel} - FAILED: ${err.message}`);
      errorCount++;
    }
  }

  console.log(`\nMigration complete. Success: ${migratedCount}, Errors: ${errorCount}.`);
}

main().catch((error) => {
  console.error(`Migration script failed: ${error.message}`);
  process.exitCode = 1;
});
