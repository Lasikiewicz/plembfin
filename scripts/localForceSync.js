import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    project: "plembfin",
    serviceAccount: "service-account-key.json",
    storageBucket: "",
    concurrency: 16,
    write: false,
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
    else if (arg === "--concurrency") args.concurrency = Number(argv[++index]) || args.concurrency;
    else if (arg.startsWith("--concurrency=")) args.concurrency = Number(arg.slice("--concurrency=".length)) || args.concurrency;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }

  return args;
}

function printHelp() {
  console.log(`
Local Force Sync

Runs the same full Force Sync logic as the deployed Firebase function, but from
this machine. It reads live Plembfin Firestore data and saved media-server
settings, then pushes watched-state changes to configured Plex, Emby, and
Jellyfin targets.

Usage:
  npm run force-sync:local -- --write

Options:
  --write                         Required. Allows live Firestore/media-server writes.
  --project <id>                  Firebase project id. Defaults to plembfin.
  --storage-bucket <name>         Firebase Storage bucket. Defaults to <project>.firebasestorage.app.
  --service-account <path>        Service account JSON. Defaults to service-account-key.json.
  --concurrency <number>          Parallel media reconciliation workers. Defaults to 16.
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
    // Fall back to Application Default Credentials configured by gcloud.
  }
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    return;
  }

  if (!args.write) {
    printHelp();
    throw new Error("Refusing to run local Force Sync without --write.");
  }

  await configureFirebase(args);

  const { runForceSync } = await import("../functions/src/scheduled.js");

  console.log(`Local Force Sync starting against Firebase project "${args.project}".`);
  console.log("Using live Plembfin Firestore data and saved media server settings.");
  console.log(`Local reconciliation concurrency: ${args.concurrency}`);

  const startedAt = Date.now();
  const result = await runForceSync((message) => console.log(message), { concurrency: args.concurrency });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`Local Force Sync finished in ${seconds}s.`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(`Local Force Sync failed: ${error.message}`);
  process.exitCode = 1;
});
