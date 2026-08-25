# Onboarding plan

Based on [TODO.md](C:/Github/plembfin/TODO.md) and the existing Plembfin architecture. No implementation is included in this plan.

## 1. Goals and guardrails

The onboarding experience should let a new administrator:

- Secure the instance without needing to retrieve a generated console password.
- Connect and test at least one Plex, Emby, or Jellyfin server.
- Configure TMDB and understand which optional metadata remains unavailable.
- Configure webhooks with exact provider-specific instructions and prerequisite tier guidance.
- Optionally connect Trakt for bidirectional watch-state sync.
- Choose whether to import, push, or defer watched-state synchronization.
- Resume setup across browsers and sessions.
- Finish with a useful dashboard checklist for deferred work.

Guardrails:

- Reuse the canonical Settings configuration and connection records.
- Support connecting up to one server per provider (Plex, Emby, and Jellyfin), adhering to the core schema constraint of one active connection per provider.
- Never automatically import or overwrite watched state without user consent.
- Hard-gate outbound Push Sync against empty local databases to prevent accidental wiping of remote playstates.
- Do not redirect populated existing installations into onboarding.
- Keep Settings available through Exit to Settings with a persistent resume banner.
- Preserve the existing dark-first, compact operational UI.
- Avoid a marketing-style wizard, decorative gradients, or a full-flow modal.

## 2. User journey

### A. Secure the instance

Extend the existing authentication panel in [public/index.html](C:/Github/plembfin/public/index.html).

Resolve authentication state into three explicit modes:

1. **Pristine install (`!authManagedInApp && !ADMIN_PASSWORD && !accountClaimed`)**:
   - Show **Create administrator account**.
   - Collect username, password, and password confirmation.
   - Show password requirements and a show/hide control.
   - Explain that the first account controls the instance.
   - Submit to a one-time claim endpoint (`POST /api/auth/claim`).
   - On success, rotate the session secret, audit the claim, sign the administrator in, and route to `/setup`.
   - Make race conditions and repeated claims return a neutral conflict response (`CLAIM_CONFLICT`), then switch the winner/other client to sign-in.
   - Apply the same rate limiting used by the login endpoint to the claim endpoint.
   - Require CSRF token or origin check.
   - Add an artificial delay on the claim endpoint to prevent brute-force timing attacks.
   - **Endpoint Whitelisting**: While unclaimed, all API endpoints except `GET /api/auth/status`, `POST /api/auth/claim`, and public assets must reject requests with `403 Forbidden` (`code: "CLAIM_REQUIRED"`).

2. **Environment-managed credentials (`!authManagedInApp && Boolean(ADMIN_PASSWORD)`)**:
   - Keep the existing sign-in flow.
   - Explain that credentials are supplied by the deployment environment.
   - After sign-in, route to `/setup` when onboarding is incomplete.

3. **In-app managed credentials (`authManagedInApp === true`)**:
   - Keep the normal sign-in flow.
   - After sign-in, route directly to the dashboard (or `/setup` if onboarding was explicitly reopened or incomplete).

Preserve forced password changes, restore flows, and active synchronization operations as higher-priority states.

### B. Setup overview

Add `/setup` inside the existing application shell.

The overview should include:

- A concise title and explanation of what remains.
- Five progress groups: Account, Media servers, Metadata, Integrations, and Review.
- A clear current-step and completion status derived from server-side state.
- Persistent Saved/Saving feedback.
- Continue setup as the primary action.
- Exit to Settings after the account is secured. When exited early, show a persistent compact notification banner at the top of Settings: *"Setup is in progress. [Resume Setup Guide] · [Dismiss]"*.
- A compact vertical progress treatment on mobile, using the existing responsive breakpoints from [public/styles.css](C:/Github/plembfin/public/styles.css).
- The existing two-column Settings rhythm on desktop.

### C. Connect media servers

Reuse the provider flows from [public/modules/settings-services.js](C:/Github/plembfin/public/modules/settings-services.js) and [server/src/routes/mediaAuth.js](C:/Github/plembfin/server/src/routes/mediaAuth.js):

- Plex authentication and server selection.
- Emby username/password authentication.
- Jellyfin Quick Connect.
- Jellyfin and Emby manual-connection fallback.
- Existing test and help behavior.

The onboarding step should:

- Start with Plex, Emby, and Jellyfin choices.
- Support connecting up to one server per provider (Plex, Emby, and Jellyfin), allowing multi-server setups across distinct providers.
- Show configured server cards with identity, URL, enabled state, and validation state.
- Preserve non-secret fields after validation errors.
- Distinguish saved, connected, tested, failed, and reauthentication-required states.
- Provide retry and edit actions.
- Disable progression until at least one server has successfully tested.
- Treat manually entered credentials as incomplete until persisted validation metadata confirms a successful test; saved-but-untested is not sufficient.

Once a server passes its connection test, show a checkbox per server:

- **Import watched status from [server name]** — enabled by default.
- When enabled, immediately enqueue a background pull for that server via the Onboarding Import Coordinator. This is safe and additive: it only pulls watched state into Plembfin and never sends outbound changes.
- Show a compact progress indicator on the server card (e.g. "Importing… 342 items" → "Import complete: 1,204 items").
- Imports run asynchronously in a dedicated queue; the administrator may continue to the next step at any time without waiting.
- If the checkbox is unchecked before or during import, cancel any running import for that server and persist the opt-out.
- Errors during background import should be non-blocking: show a warning on the server card with a Retry action, but do not prevent progression.

### D. Add metadata

For TMDB:

- Explain which features depend on the API key (posters, backdrops, episode details, search).
- Link to the official TMDB API-key instructions (opening in a new tab with secure attributes).
- Explain the free account/API-key path.
- Save and test the key without erasing it on failure.
- Handle upstream TMDB rate limits or outages gracefully with informative error messages.
- Offer **Finish later** with limited features so third-party downtime does not block setup.

For built-in and optional providers:

- The server exposes `builtInAvailable: true/false` in `/api/setup/status` without exposing the actual project keys to the client.
- Show TVDB/Fanart as **Using built-in access** when project keys are available.
- Offer personal TVDB/Fanart keys under **Optional metadata providers** via progressive disclosure.
- Keep OMDb and YouTube behind progressive disclosure.
- Use statuses such as Saved, Verified, Using built-in access, Needs attention, and Not configured.

### E. Enable reliable updates

For every connected and tested server:

- Fetch the webhook secret lazily only when this step opens, reusing `fetchAndCacheWebhookToken()` in [public/modules/auth.js](C:/Github/plembfin/public/modules/auth.js).
- Show the complete webhook URL formatted specifically for the server type.
- Provide Copy button.
- Provide numbered, provider-specific instructions and note tier/plugin requirements:
  - **Plex**: Requires Plex Pass for webhooks.
  - **Jellyfin**: Requires the Jellyfin Webhook plugin.
  - **Emby**: Requires Emby Premiere or the Webhook notification plugin.
- Include exact menu/event names, relevant documentation, and a webhooks link (`docs/webhooks.md`).
- Explain that webhooks provide timely updates while polling remains a scheduled backstop.
- Let the administrator self-attest each server ("I have configured webhooks on this server").
- Provide **Do this later**.

Store acknowledgements by provider and stable server identity so they survive refreshes and edits.

### F. Connect Trakt (optional)

This step is optional. The administrator may skip it entirely and connect Trakt later from Settings → Import.

Reuse the existing device-authorization flow from [server/src/routes/trackerAuth.js](C:/Github/plembfin/server/src/routes/trackerAuth.js) and [public/modules/tracker-settings.js](C:/Github/plembfin/public/modules/tracker-settings.js):

- Explain that Trakt provides bidirectional watch-state sync: watches flow both ways every minute, including individual rewatches.
- Explain that no Trakt VIP subscription or personal API credentials are required (built-in app credentials are used by default).
- Recommend disabling any existing Emby/Jellyfin Trakt plugins so Plembfin is the only Trakt writer.
- Start the device-authorization flow: display the user code and verification URL, poll for completion, and show the connected Trakt username on success.
- Show statuses: Not connected, Authorizing, Connected, Importing, Import complete, Expired code (with Retry), and Failed.
- Offer personal Trakt app credentials under progressive disclosure for users who prefer their own API application.
- Provide **Skip for now** as a prominent secondary action. Skipping carries the item to the dashboard checklist.

Once Trakt is successfully connected, show a checkbox:

- **Import watch history from Trakt** — enabled by default.
- When enabled, immediately trigger the initial baseline snapshot (the existing first-sync path that reads the complete Trakt watched state) in the background.
- Show progress on the Trakt card (e.g. "Reading Trakt history…" → "Import complete: 2,847 items").
- The import runs asynchronously; the administrator may continue to the next step at any time without waiting.
- If the checkbox is unchecked, skip the baseline snapshot. The administrator can trigger it later from Settings → Import. Bidirectional minute-by-minute sync still activates once onboarding completes.
- Errors during the baseline snapshot should be non-blocking: show a warning with a Retry action.

Do not block progression on this step. The administrator may continue to the next step at any time regardless of Trakt connection or import state.

### G. Import progress and sync options

This step shows the combined status of all background imports started in the media-server (§2C) and Trakt (§2F) steps:

- For each server where import was enabled, show the current state: Importing, Import complete (with item count), or Failed (with Retry).
- For Trakt (if connected and import enabled), show the baseline snapshot state: Reading Trakt history, Import complete (with item count), or Failed (with Retry).
- If no imports were started (all checkboxes were unchecked), show a brief note: "No imports were requested. Plembfin will track new activity from this point forward."
- Allow the administrator to toggle import checkboxes retroactively: enabling a previously-unchecked import starts it now; disabling a running import cancels it.

Separately, offer an advanced option under progressive disclosure:

- **Set Plembfin as the source of truth** (Push Sync):
  - **Empty-DB Guardrail**: If `watch_history` row count is 0, this option is **disabled** with an explanatory tooltip: *"Plembfin has no local watch history to push. Complete an import from a server or Trakt first."*
  - When enabled, require explicit double confirmation with a clear item count summary of what will be pushed.
  - This pushes Plembfin's watched state outward to connected servers using the existing planner, preview, confirmation, lock, progress, cancel, and activity paths.
  - The push option remains unavailable until at least one server has been tested. A cancelled or partially completed push operation keeps onboarding incomplete and exposes a resume/retry path.

Background imports (the safe, additive pull operations) do not block onboarding completion. The administrator may proceed to Review even while imports are still running; they will continue in the background after onboarding completes.

### H. Review and finish

Show review rows for:

- Account security.
- Connected media servers (with import status per server: complete, in progress, not requested).
- TMDB and optional metadata.
- Webhook acknowledgement.
- Trakt connection and import status (Connected + importing / Connected + complete / Connected + not requested / Skipped).
- Encrypted backup and credential-key recommendation.

Show deferred follow-up items with Settings deep links for:

- Trakt connection, if skipped (`/#settings/import`).
- Seerr integration (`/#settings/media`).
- Backups (`/#settings/backup`).
- Safe storage of the credential-vault key (see `docs/backups.md`).

Each row should link to its setup step and the canonical Settings tab. Opening the dashboard should validate required account/server state server-side, persist onboarding completion version and time, allow optional items to remain incomplete, and provide a retry path if completion persistence fails.

## 3. Durable state and API

### Authentication

Update [server/src/appConfig.js](C:/Github/plembfin/server/src/appConfig.js) to represent account claim state explicitly (`accountClaimed: false` on pristine installs).

Requirements:

- Do not generate or log an initial password hash on pristine installs.
- Preserve environment-managed credentials and current precedence rules.
- Treat existing installations conservatively; do not introduce an unexpected redirect.
- Apply login rate-limiting and CSRF/origin checks to `/api/auth/claim`.
- Restrict all protected API endpoints with `403 Forbidden` (`code: "CLAIM_REQUIRED"`) while `accountClaimed: false`.
- Make claiming process-safe:
  1. Acquire the claim lock (`utils/concurrency.js`).
  2. Read fresh configuration under the lock.
  3. Verify that the instance is still unclaimed.
  4. Write credentials, `authManagedInApp: true`, `accountClaimed: true`, and a new session secret atomically to `data/config.json`.
  5. Release the lock.
  6. Return success to the winner (issuing a signed session cookie) and a neutral conflict (`CLAIM_CONFLICT`) to concurrent claim attempts.

### Onboarding persistence

Store onboarding state in the SQLite `settings` row under key `onboarding`, not in browser local storage. The `onboardingStore` helper wraps the existing `configStore` settings mechanism (the JSON field within the settings row managed by [server/src/utils/configStore.js](C:/Github/plembfin/server/src/utils/configStore.js)); it does not create a separate table.

Recommended shape:

```json
{
  "version": 0,
  "runState": "not_started",
  "startedAt": null,
  "completedAt": null,
  "currentStep": "overview",
  "acknowledgements": {
    "webhooks": {},
    "traktSkipped": false
  },
  "backgroundImports": {
    "servers": {},
    "trakt": {
      "enabled": null,
      "status": "not_started",
      "startedAt": null,
      "completedAt": null,
      "itemCount": null
    }
  },
  "pushSync": {
    "status": "not_started",
    "startedAt": null,
    "completedAt": null
  },
  "checklistDismissedAt": null
}
```

Field semantics:

- `version`: The highest completed onboarding flow version.
- `runState`: Distinguishes `not_started`, `in_progress`, `completed`, and `restartable` states.
- `currentStep`: Resumable step hint, not the source of truth for completion.
- `acknowledgements.webhooks`: Keyed by provider/server ID to persist self-attestations.
- `acknowledgements.traktSkipped`: Records whether the Trakt step was explicitly skipped.
- `backgroundImports.servers`: Keyed by stable server identity; each entry records `{ enabled, status, startedAt, completedAt, itemCount, error }`.
- `backgroundImports.trakt`: Tracks the Trakt baseline snapshot; `enabled` is null until the step is reached, true/false once the checkbox is set.
- `pushSync`: Tracks the optional destructive push operation from §2G.
- Never duplicate credentials or connection records in onboarding state.
- Idempotent writes so refreshes and repeated requests are safe.

### Background Import & Concurrency Architecture

To prevent lock contention with the global `force_sync` background job queue:

- Introduce an **Onboarding Import Coordinator** (`server/src/utils/onboardingImportCoordinator.js`) that manages per-server and Trakt background pull jobs.
- Scoped pull operations execute without acquiring the full-library destructive sync lock, allowing concurrent or sequential imports across connected providers (e.g. Plex and Jellyfin pulling simultaneously).
- Import progress, scanned item counts, and statuses are written to the `onboarding` settings state and exposed via `GET /api/setup/status`.
- Browser reloads and multi-tab sessions read live counts directly from the status endpoint or live-update broadcasts.

### Versioning contract

The constant `CURRENT_ONBOARDING_VERSION = 1` is defined in the server and incremented when a new release adds a recommended onboarding step:

- `version` tracks the highest completed onboarding schema version for this instance.
- When `CURRENT_ONBOARDING_VERSION > user.version`, the dashboard checklist surfaces the new recommended steps without forcing re-entry into the full wizard.
- Completing the new steps updates `version` to `CURRENT_ONBOARDING_VERSION`.
- Prior completion is never invalidated; a user who completed version 1 is never treated as having an incomplete installation.

### Upgrade migration detection

The database migration in `server/src/db.js` introduces onboarding state and distinguishes pristine installs from existing upgraded installations. Mark onboarding as completed (`version: 1`, `runState: "completed"`) when ANY of the following is true:

- `config.authManagedInApp === true` (credentials were modified in-app).
- `SELECT 1 FROM media_connections LIMIT 1` returns a row.
- `SELECT 1 FROM watch_history LIMIT 1` returns a row.
- `configStore` has user-modified settings beyond defaults (e.g. TMDB key, provider keys, sync tuning).

When none of these conditions hold, the instance is pristine and onboarding starts from the beginning. Existing upgraded installations can still launch the guide manually via Settings → Run setup guide.

### Restart behavior

`POST /api/setup/restart` resets guide progress and acknowledgements only. It never deletes configuration.

Restart resets:

- `runState` → `"in_progress"`
- `currentStep` → `"overview"`
- `acknowledgements` → `{}`
- `checklistDismissedAt` → `null`

Restart preserves:

- All media connections, credentials, and API keys.
- All metadata configuration.
- All sync history and watch state.
- `version` (the highest previously completed version).
- `data/config.json` (no modifications).

### Consolidated API surface

The API surface is consolidated into a cohesive REST contract:

| Endpoint | Method | Purpose |
|---|---|---|
| `POST /api/auth/claim` | `POST` | One-time atomic administrator account creation for pristine installs. |
| `GET /api/setup/status` | `GET` | Aggregated setup state: current step, derived completion flags, connected servers, built-in metadata availability flags, background import progress, and checklist items. |
| `POST /api/setup/step` | `POST` | Update current step and persist step-specific acknowledgements (`webhooks`, `traktSkipped`). |
| `POST /api/setup/import` | `POST` | Trigger, toggle, or cancel a background import for a specific server or Trakt. |
| `POST /api/setup/complete` | `POST` | Finalize onboarding (`runState: "completed"`, record `completedAt` & update `version`). |
| `POST /api/setup/restart` | `POST` | Reset setup progress and acknowledgements without wiping saved credentials. |
| `POST /api/setup/checklist/dismiss` | `POST` | Dismiss the deferred checklist on the dashboard. |

The status response may expose labels, booleans, safe status values, timestamps, server names, and recommended actions. It must never expose passwords, API keys, access tokens, webhook secrets, or complete webhook URLs containing secrets.

### Standard error-response contract

All setup endpoints use a consistent error shape:

```json
{
  "error": "Human-readable message describing the problem",
  "code": "CLAIM_CONFLICT | CLAIM_REQUIRED | STEP_GATED | EMPTY_DATABASE | SYNC_LOCKED | VALIDATION_FAILED",
  "retryable": true
}
```

### Dashboard checklist derivation

The dashboard checklist is derived server-side from canonical configuration. Checklist items and their display conditions:

- **Connect TMDB** — shown when no valid TMDB key is configured.
- **Set up webhooks** — shown for each connected server without a persisted acknowledgement.
- **Connect Trakt** — shown when no Trakt connection exists and the step was skipped or not yet reached.
- **Import watched status** — shown for any connected server where the import checkbox was unchecked during onboarding.
- **Configure Seerr** — shown when no Seerr connection exists.
- **Create encrypted backup** — shown when no full Plembfin backup has been taken.
- **Store credential key** — shown once, always dismissible.

Items are hidden once their condition is met. The checklist section on the dashboard is hidden entirely after all items are resolved or explicitly dismissed via `POST /api/setup/checklist/dismiss`.

## 4. Planned code ownership

### Backend

- `server/src/appConfig.js` — explicit account-claim state (`accountClaimed: false`) and pristine-install detection; defer generated password creation on pristine boot.
- `server/src/utils/auth.js` — claim handler added alongside existing login/logout/credentials handlers; validation, conflict behavior, session rotation, endpoint gating (`CLAIM_REQUIRED`), and audit logging.
- `server/src/index.js` — route dispatch entry for claim and setup endpoints with auth guards.
- `server/src/utils/onboardingStore.js` — onboarding-state read/write helpers wrapping the existing `configStore` settings mechanism.
- `server/src/utils/onboardingImportCoordinator.js` — coordinator managing safe per-server and Trakt background pull jobs without lock conflicts.
- `server/src/routes/onboarding.js` — setup status, step, import, completion, restart, and checklist endpoints.
- `server/src/db.js` — migration and default handling for the onboarding settings row, including fast table-check upgrade detection.
- `server/src/utils/configStore.js` — safe validation status and built-in provider availability flags (`builtInAvailable`).
- `server/src/routes/trackerAuth.js` — Trakt device-authorization flow reused by onboarding.
- `server/src/utils/trackerConnectionRepo.js` — tracker connection persistence used to derive Trakt status.
- `server/src/routes/admin.js` — persisted test-result and metadata-test integration.

### Frontend

- `public/index.html` — account-claim UI and setup shell entry.
- `public/app.js` — `/setup` routing, guarded navigation, and Settings resume banner.
- `public/modules/onboarding.js` — setup state, step rendering, save/resume behavior, and review.
- `public/modules/auth.js` — claim flow and lazy webhook-secret retrieval (`fetchAndCacheWebhookToken`).
- `public/modules/settings-services.js` — shared provider actions, connection cards, and status rendering.
- `public/modules/tracker-settings.js` — Trakt device-auth UI and connection rendering reused by the onboarding step.
- `public/modules/media-detail-events.js` and `public/modules/sync-preview.js` — shared Force Sync behavior and push confirmation.
- `public/modules/sync-activity.js` — background import progress display during onboarding.
- `public/modules/dashboard.js` — deferred-work checklist rendering and dismissal.
- `public/modules/help-content.js` — provider-specific webhook guidance and tier/plugin prerequisites.
- `public/styles.css` — setup layout, progress states, responsive behavior, and accessibility states.

## 5. Implementation sequence

Implement and verify the work in independently testable slices:

1. Define API contracts, migration defaults, claim security rules, and endpoint whitelisting.
2. Add pristine-install detection and the atomic account-claim flow in `appConfig.js` and `auth.js`.
3. Add durable onboarding persistence (`onboardingStore.js`) and the consolidated status endpoint.
4. Extract or expose shared Settings actions without changing their behavior.
5. Add `/setup` routing, overview, progress, resume handling, and the Settings resume banner.
6. Add media-server selection, authentication, testing, retry, gating, and per-server background import coordinator.
7. Add metadata configuration, TMDB save/test, built-in provider status flags, and optional provider progressive disclosure.
8. Add webhook setup: lazy secret fetch, provider-specific instructions with tier/plugin notices, acknowledgement persistence, and Copy behavior.
9. Add optional Trakt connection: device-authorization flow, skip/connect, baseline snapshot checkbox, background import progress, and status display.
10. Add import progress view: combined server/Trakt status, retroactive toggle, and advanced push-sync option guarded against empty databases.
11. Add review, completion, Settings exit, and the dashboard checklist with deep links.
12. Update documentation and operator guidance.
13. Harden edge cases, accessibility, responsive layout, security redaction, and upgrade behavior.

## 6. Required states and edge cases

Design and test explicit states for:

- Initial authentication loading.
- Account-claim validation errors and rate limiting.
- Protected endpoint calls while unclaimed (verify `403 CLAIM_REQUIRED`).
- Claim conflict and already-claimed responses (`CLAIM_CONFLICT`).
- Invalid sign-in.
- Setup-status skeleton, loading, retry, and server error.
- Saving, saved, and failed-to-save.
- Popup blocked or provider authorization cancelled.
- Expired authentication/session.
- Expired Jellyfin Quick Connect code.
- Saved-but-failed server test.
- Offline mode and reconnect.
- TMDB unavailable, rate-limited, or invalid (with "Finish later" flow).
- Webhook secret unavailable or lazy fetch failure.
- Trakt device code expired during onboarding.
- Trakt authorization cancelled or failed.
- Trakt step skipped and later resumed from Settings.
- Concurrent background imports across multiple servers without lock conflicts.
- Background server import failed partway through (with non-blocking retry).
- Background Trakt baseline snapshot failed partway through.
- Import checkbox toggled while import is running (cancel behavior).
- Import checkbox re-enabled after previous cancellation (restart behavior).
- Onboarding completed while background imports are still running (continues in background).
- Push sync blocked when local watch history has 0 rows (`EMPTY_DATABASE`).
- Force Sync lock busy (push-sync option).
- Cancelled or partially completed push sync.
- Completion persistence failure.
- Existing upgraded installation (auto-marked complete).
- Environment-managed credentials (standard login routed to setup if incomplete).
- Refresh and second-browser resume (background imports survive page reload).
- Mobile layout, keyboard-only navigation, screen readers, reduced motion, and light mode.

## 7. Test plan

Cover the following:

- Pristine install with no environment-managed password (presents claim flow, no generated password logged).
- Environment-managed credentials and precedence rules.
- Existing populated installation with no forced redirect (verified via fast `watch_history` / `media_connections` check).
- Atomic claim behavior, race conditions, repeated claims, session rotation, audit logging, and secret redaction.
- Unauthenticated access restrictions: verify all protected API endpoints return 403 `CLAIM_REQUIRED` while unclaimed.
- Onboarding versioning, idempotent progress writes, restart behavior, and durable resume.
- Status responses that never contain secrets, tokens, or sensitive webhook data.
- Setup guards, safe returns to sign-in, and protected routes.
- Required-step gating, optional-step deferral, refresh, and multi-tab behavior.
- Plex, Emby, and Jellyfin authentication and server selection (adhering to 1 connection per provider).
- Manual connection validation and preservation of failed input.
- TMDB save/test behavior, failure recovery, and built-in availability flags (`builtInAvailable`).
- Provider-specific webhook guidance rendering, tier/plugin notices, and acknowledgement persistence.
- Trakt device-authorization flow during onboarding: connect, skip, expired code retry, and baseline snapshot.
- Trakt skip acknowledgement persistence and checklist derivation.
- Per-server background import coordinator: concurrent execution across providers, progress tracking, cancel/restart, failure recovery, and survival across page reload.
- Trakt background baseline snapshot: checkbox toggle, progress, and failure recovery.
- Import progress view: combined status display, retroactive checkbox toggle, and push-sync confirmation.
- Empty database push sync protection: verify push sync is disabled when `watch_history` count is 0.
- Background imports continuing after onboarding completion.
- Push-sync (source of truth) behavior, including double confirmation, cancellation, and partial completion.
- Dashboard checklist generation, deep links, and dismissal.
- Settings resume banner rendering when setup is exited early.
- Equivalence between setup actions and canonical Settings actions.
- Regression gate: run `npm run build` (the existing pre-push syntax check and clean-directory boot test) as part of every verification cycle.

Acceptance scenarios:

1. A pristine install presents account creation without logging a generated password, blocks protected routes until claimed, and continues to setup after the first administrator is created.
2. An environment-managed installation keeps its normal sign-in behavior and allows setup to resume from another browser.
3. An existing populated installation opens normally and does not get redirected into onboarding without an explicit entry point.
4. An offline or failed provider request gives a recoverable error, keeps safe user input, and does not falsely mark the step complete.
5. A pristine install that connects servers and Trakt, leaves import checkboxes enabled, and completes onboarding arrives at a dashboard with watched items imported concurrently in the background.
6. Push sync is guarded against pushing an empty local database to remote servers.
7. The flow works on desktop and mobile, in both themes, with keyboard navigation, focus management, and accessible status announcements.

## 8. Documentation

Update:

- `README.md`
- `docs/auth.md`
- `docs/settings.md`
- `docs/architecture.md`
- `docs/troubleshooting.md`

Add `docs/onboarding.md` covering:

- Pristine-install account claiming and endpoint whitelisting.
- Environment-managed credentials.
- Claim races and recovery.
- Setup resume and restart behavior.
- Provider authentication, tier prerequisites (Plex Pass, plugins), and reauthentication.
- Webhook configuration, lazy token retrieval, and polling fallback.
- Optional Trakt connection during setup and how to connect later.
- Background import behavior: automatic concurrent pull on server connect and Trakt connect, checkbox control, and what happens after onboarding completes.
- Push-sync (source of truth) implications, empty database guardrails, and when to use it.
- Encrypted backup and credential-key recommendations.
- How to reach setup again from Settings or the dashboard.

Planning status: this file records the implementation plan only; implementation has not started.
