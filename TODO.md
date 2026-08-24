# TODO / Feature Backlog

Tracked ideas for future work. Not scheduled - pick up when ready.

## 1. Additional import sources (Simkl, etc.)

Expand import beyond the current Trakt/CSV import (`public/modules/tools.js`) to more services (e.g. Simkl).

- Status: not started
- Watch history merge/import logic needs to be verified first - must handle clashes (duplicate records, conflicting watch dates/ids) cleanly rather than duplicating entries.
- Take an automatic backup (existing backup system - see `docs/backups.md`, `public/modules/tools-backups.js`) immediately before any merge/import runs, so a bad merge can be rolled back.

## 2. Onboarding

First-run / onboarding experience for new users.

- Status: not started
- Currently a fresh install just generates an admin password to the console log and drops the user straight into a bare login screen, with no guided setup for connecting Plex/Emby/Jellyfin, TMDB keys, etc.

### Outcome

A new administrator should be able to open Plembfin, secure the instance, connect at
least one media server, add the metadata needed for useful library pages, and understand
the remaining server-side setup without having to search the documentation or guess what
to do next. Setup must be resumable, must not hide normal Settings pages, and must leave
the dashboard with a short, actionable checklist if optional work remains.

### Product decisions

- Use a dedicated `/setup` route inside the existing app shell after authentication. It
  should reuse the current logo, dark-first tokens, form controls, status pills, provider
  icons, service dialogs, inline help, and mobile breakpoints rather than introduce a new
  visual language or a marketing-style wizard.
- Treat account security as required. On a pristine install with no explicit
  `ADMIN_PASSWORD`, replace the generated-password login dead end with a one-time account
  claim screen. Deployments that supply admin credentials continue to show the normal
  sign-in screen, then enter `/setup` after signing in.
- Treat one successfully tested Plex, Emby, or Jellyfin connection as required. Users may
  connect more than one server during setup.
- Treat TMDB as required for the complete Plembfin experience, but allow **Finish later**
  so an unavailable third-party service cannot trap the administrator in setup. Explain
  exactly which artwork and discovery features remain limited.
- Treat webhooks, Trakt, Seerr, optional metadata keys, backups, and the first history
  import as follow-up tasks. Show them in context, but do not turn initial setup into a
  long sequence of credential forms.
- Never run a library-wide import or push watched state merely because setup was
  completed. The administrator must choose and confirm an initial sync action after its
  source, destination, and effect have been explained.
- Keep onboarding available later from Settings and make every wizard action write to the
  same configuration and connection records as the existing Settings UI. There must not
  be a second setup-only configuration model.

### User flow

1. **Secure this instance**
   - If `ADMIN_PASSWORD` was supplied by the deployment, show the existing sign-in form
     with concise copy explaining which credentials to use and a link to the authentication
     troubleshooting guide.
   - If this is a pristine install without supplied or in-app-managed credentials, show
     **Create administrator account** with username, password, confirmation, password
     requirements, show/hide controls, and an explicit warning that the first account
     controls the instance.
   - The one-time claim endpoint must be available only while setup is unclaimed, perform
     the state check and credential write atomically, audit the claim, rotate the session
     secret, and sign in the new administrator. Concurrent or repeated claims return a
     neutral conflict response and fall back to sign-in. Do not reveal secrets or whether
     a submitted username exists.

2. **Welcome and setup overview**
   - State the job in plain language: connect the services that hold the user's media and
     let Plembfin keep watched state in sync.
   - Show the four core stages—account, media servers, metadata, and review—with current
     status. Use a compact vertical step list on mobile and the existing two-column
     settings rhythm on desktop.
   - Explain that progress saves automatically and that optional tasks can be completed
     later. Provide **Continue setup** as the single primary action.

3. **Connect media servers**
   - Reuse the existing Plex account flow, Emby login flow, Jellyfin Quick Connect/login
     flow, manual credential fallback, connection test, and provider-specific help.
   - Start with three provider choices using existing icons and short descriptions. Once
     connected, replace the choice with the normal configured card, connection identity,
     server name/URL, enabled state, and test result; retain **Add another server**.
   - Do not mark the step complete for saved-but-untested credentials. Offer Retry and
     Edit in place on failure and preserve entered non-secret values. Error messages must
     identify the failing operation and the next useful check.
   - Link advanced/manual setup to the relevant in-app help and repository documentation:
     `docs/plex.md`, `docs/emby.md`, and `docs/jellyfin.md`.

4. **Add metadata**
   - Lead with TMDB, explain what it enables, link directly to TMDB's official API-key
     instructions, and reuse the current save/test behavior. Open external links in a new
     tab with the usual security attributes and state that a free account is required.
   - Show TheTVDB and Fanart.tv as already available through built-in project keys when
     that is true; do not imply that the user must obtain personal keys. Place personal
     TVDB, Fanart.tv, OMDb, and YouTube keys under **Optional metadata providers** using
     progressive disclosure.
   - A failed provider test must not erase a saved key. Clearly distinguish **saved**,
     **verified**, **using built-in access**, and **needs attention**.

5. **Enable reliable updates**
   - Generate the same complete webhook URL shown in Settings and provide Copy buttons
     plus the existing provider-specific webhook instructions only for connected servers.
   - Use numbered instructions, exact menu names, required event lists, and links to the
     detailed webhook guide (`docs/webhooks.md`). Explain that webhooks send playback
     changes to Plembfin and that scheduled polling is only a backstop.
   - Let the administrator mark each server's instructions as done; label this as a
     self-attestation because Plembfin cannot reliably inspect every remote webhook
     configuration. Keep **Do this later** available and carry unfinished items to the
     final checklist.

6. **Choose the initial watched-state action**
   - Present three choices: **Start with new activity only** (safest default), **Import
     watched status into Plembfin**, or **Set Plembfin as source of truth**.
   - Reuse the existing Force Sync planner, preview, confirmation, lock, progress, cancel,
     and activity log. Never reduce the existing destructive-action explanation.
   - Disable impossible choices until their required servers are connected and tested.
     Make it clear that this choice can be run later from Settings → Sync → Sync Tools.

7. **Review and finish**
   - Summarize account security, connected/tested servers, metadata state, webhook
     acknowledgements, and whether an initial sync was run. Each row links back to its
     setup step and to the canonical Settings location.
   - **Open dashboard** completes onboarding even when optional items remain. Persist the
     completion version and timestamp, then show a dismissible **Finish setting up
     Plembfin** checklist on the otherwise-empty dashboard until the remaining recommended
     items are done.
   - Recommend, without requiring, a full encrypted backup and the safe storage of the
     credential-vault key. Link to Settings → Backup / Restore and `docs/backups.md`.

### State, routing, and API design

- Store onboarding state in server-owned configuration, not local storage, so it follows
  the instance across browsers: `onboarding.version`, `startedAt`, `completedAt`, and
  explicit acknowledgements such as webhook setup. Derive provider completion from the
  canonical config/connection records instead of duplicating it.
- Add a browser-safe authenticated setup-status endpoint returning only booleans, labels,
  step state, and recommended next action. It must never return credentials, API keys,
  tokens, or the webhook secret. Fetch the webhook URL through the existing authenticated
  secret path only when that step is open.
- Route authenticated administrators to `/setup` when the current onboarding version is
  incomplete. Preserve a requested safe destination and return to it after completion;
  do not interrupt forced password changes, restores, or an already-running sync.
- Allow **Exit to Settings** after the account is secure. Leaving the wizard does not mark
  onboarding complete; Settings should expose **Resume setup** and **Restart setup guide**.
  Restarting resets guide progress/acknowledgements only and never deletes configuration.
- Existing upgraded installations must not be mistaken for pristine installs. The
  migration should mark onboarding complete when any durable evidence of prior use exists
  (managed credentials, configured media connection, watch history, or saved settings),
  while still exposing **Run setup guide** manually.
- Version the flow so future releases can add a short new step without replaying the full
  wizard. Completion of version 1 remains recorded even when a later version introduces a
  recommended task.
- Make the one-time account-claim state explicit in `appConfig` rather than inferring it
  solely from the generated password. Preserve the current environment-variable precedence
  and secure-overlay behavior. Document the small first-claim race inherent to exposing a
  brand-new self-hosted service and recommend completing setup before exposing it publicly.

### UI and content requirements

- Use one clear page title and a short sentence per step. Avoid eyebrow labels, oversized
  hero copy, nested cards, decorative gradients, and a modal for the overall flow.
- Keep a persistent progress summary, Back/Continue controls, and a visible **Saved** or
  **Saving** status. Disable Continue only for the account and media-server requirements;
  explain beside the disabled action what remains to be done.
- Use real links for external prerequisites and canonical Settings deep links for actions
  available inside Plembfin. Never say only “configure this in Settings” without linking to
  the exact section.
- Support keyboard-only completion, logical heading order, visible focus, labelled fields,
  `aria-live` status without noisy announcements, focus movement to the step heading after
  navigation, Escape behavior only inside reused dialogs, and reduced motion.
- On narrow screens, stack help after the active task, keep the action bar reachable
  without covering fields, maintain 44px touch targets, and never hide provider status or
  required actions. Test long URLs, validation copy, and translated-length labels even if
  localization is not yet implemented.
- Provide specific empty/loading/offline/error states: status loading skeleton; setup-status
  retry; provider authorization expired; popup blocked; Quick Connect expired; connection
  saved but test failed; TMDB unavailable; webhook URL unavailable; initial-sync lock busy;
  sync cancelled/partially applied; and completion-save retry.

### Implementation sequence

1. **Foundation and migration**
   - Add versioned onboarding state, pristine-install detection, upgrade migration, the
     browser-safe status endpoint, completion/acknowledgement endpoints, audit events, and
     one-time atomic account claim.
   - Extend authentication status just enough to choose between sign-in, claim, setup, and
     normal app states without exposing why credentials are configured.

2. **Shared frontend primitives**
   - Extract callable provider save/test/connect actions from `settings-services.js` where
     needed so Settings and setup use the same behavior.
   - Add a small onboarding module for routing, state, step rendering, focus management,
     save status, and checklist derivation; keep `app.js` responsible for top-level route
     orchestration only.

3. **Core guided flow**
   - Build account, overview, media-server, metadata, webhook, initial-sync, and review
     steps in that order. Reuse `help-content.js`, provider icons, existing dialogs, Force
     Sync UI, and Settings deep links.

4. **Post-setup guidance and documentation**
   - Add the dashboard completion checklist and Settings entry points.
   - Update `README.md`, `docs/auth.md`, `docs/settings.md`, `docs/architecture.md`, and
     `docs/troubleshooting.md`; add `docs/onboarding.md` as the canonical flow and recovery
     reference. Remove text that tells ordinary fresh installs to retrieve a generated
     console password once account claim replaces that path.

5. **Hardening and release**
   - Exercise claim races, upgrade detection, interrupted OAuth/Quick Connect flows,
     browser refresh between steps, multi-tab completion, provider outages, mobile layout,
     screen-reader flow, reduced motion, and light mode.
   - Ship behind a server-side rollout flag for one pre-release cycle if the account-claim
     change cannot be reviewed and tested independently from the guided setup UI.

### Test and acceptance plan

- Unit-test pristine/upgrade classification, onboarding-version migration, checklist
  derivation, route guards, redaction, account-claim atomicity, validation, audit events,
  and environment-managed credential precedence.
- Add API tests proving unauthenticated setup endpoints are inaccessible after claim,
  concurrent claims have one winner, repeated completion is idempotent, secrets never
  appear in setup status, and an upgraded populated instance is not redirected.
- Add frontend DOM tests for each step and state, keyboard navigation, focus restoration,
  required-step gating, optional-step skipping, deep links, refresh/resume, and the
  dashboard checklist.
- Add integration coverage for each existing media authorization method and TMDB test by
  stubbing outbound responses; verify setup and Settings produce identical stored config.
- Run the existing authentication, settings-shell, media-auth, config, Force Sync, build,
  and full test suites to prevent regressions.
- Acceptance scenarios:
  1. A no-env pristine Docker install creates an admin account, connects and tests one
     server, saves TMDB, copies the correct webhook URL, safely skips initial sync, and
     reaches the dashboard without reading console logs.
  2. An install with `ADMIN_USERNAME`/`ADMIN_PASSWORD` signs in normally and resumes setup
     on another browser.
  3. An existing upgraded instance opens its previous route without onboarding and can
     launch the guide manually.
  4. A disconnected or offline provider produces recoverable instructions and retains
     non-secret input.
  5. Setup remains fully usable at desktop and phone widths in dark and light mode with
     keyboard-only navigation.

### Definition of done

- No ordinary pristine installation depends on a generated console password.
- Required steps are secure, resumable, tested, and backed by canonical configuration.
- Every external prerequisite has concise in-context instructions and a working direct
  link; every deferred internal task has an exact Settings deep link.
- Setup never performs an unconfirmed watched-state import or outbound overwrite.
- Existing installations and environment-managed deployments keep their current behavior
  unless they explicitly launch the guide.
- Documentation, automated tests, mobile/accessibility checks, and both themes are complete.
