# Plembfin Firebase

## Local Site

To run the site locally, use:

```bash
npx firebase emulators:start --only functions,hosting
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
