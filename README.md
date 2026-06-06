# Plembfin Firebase

## Local Site

To run a safe local copy of the live Firebase stack, use:

```powershell
npm install
npm --prefix functions install
Copy-Item functions\.env.example functions\.env
npm run emulators
```

Set `ADMIN_EMAILS` in `functions/.env` to the email you will create in the Auth emulator.

Local emulator URLs:

- Site: `http://127.0.0.1:5000`
- Emulator UI: `http://127.0.0.1:4000`
- Auth emulator: `127.0.0.1:9099`
- Firestore emulator: `127.0.0.1:8180`
- Storage emulator: `127.0.0.1:9199`
- Functions emulator: `127.0.0.1:5001`
- Pub/Sub emulator: `127.0.0.1:8085`

Create a local admin user in the Emulator UI under Authentication, then sign in on the local site with that email and password. The local browser app connects to the Auth emulator automatically on `localhost`, `127.0.0.1`, or `::1`; the Functions emulator connects to the local Auth, Firestore, and Storage emulators when all emulators are started together. Pub/Sub is included so the every-minute `scheduledSync` function can be exercised locally too.

The default emulator command imports from `./emulator-data` and exports back to that folder on exit, so local Auth, Firestore, and Storage state persists between restarts.

You can also start the same persistent emulator stack explicitly with:

```bash
npm run emulators:import
```

Export the current local emulator data with:

```bash
npm run emulators:export
```

Fresh Firebase implementation of Plembfin. The original Cloudflare repo remains untouched as the rollback path.

## Stack

- Firebase Hosting serves the static dashboard from `public/`.
- Cloud Functions for Firebase v2 serves all `/api/*` routes through `api`.
- `scheduledSync` runs every minute through Firebase Scheduler/Cloud Scheduler.
- Cloud Firestore stores watch history, live session cache, resume progress, settings, loop keys, and runtime logs.
- Firebase Auth email/password signs in dashboard admins.

## Required Setup

1. Create a Firebase project and update `.firebaserc` if the project ID is not `plembfinfire`.
2. Enable Firebase Authentication -> Email/Password.
3. Create the admin user.
4. Edit `public/firebase-config.js` with the Firebase web app config.
5. Configure Functions environment variables. For local/deploy-time dotenv configuration, copy `functions/.env.example` to `functions/.env` and set at least:

```text
ADMIN_EMAILS=your-admin@example.com
FUNCTIONS_REGION=europe-west2
```

`ADMIN_UIDS` is optional. If neither `ADMIN_EMAILS` nor `ADMIN_UIDS` is set, dashboard APIs reject requests.

## Deploy

```bash
npm install
npm --prefix functions install
firebase deploy
```

After deployment:

1. Sign in to the dashboard with the Firebase Auth admin user.
2. Save Plex, Emby, Jellyfin, and optional TMDB settings.
3. Point Plex, Emby, and Jellyfin webhooks at `https://YOUR_HOSTING_DOMAIN/api/webhook`.
4. Confirm `scheduledSync` appears in Firebase Functions and runs every minute.
5. Use `/api/cron-sync` only as an authenticated manual trigger.

## Data Migration

No D1 data is migrated by design. This repo starts with a fresh Firestore archive.
