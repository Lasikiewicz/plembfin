# CLAUDE.md

Agent instructions for working with this codebase.

> **Before changing anything, read [`docs/architecture.md`](docs/architecture.md).**
> It is the master guide: the big picture, a complete map of every file in the repo,
> and a task router that points to the feature doc covering the area you are touching.

## Agent Guidelines

- **No Git Pushes** - Never execute `git push` or push commits to any remote repository unless the user explicitly instructs you to push in their request.
- **No Deployments** - Never deploy the application or run deployment commands unless explicitly instructed by the user.
- **No Unsolicited Actions** - Do only exactly what the user asks. Do not perform unsolicited refactorings, add extra features, or modify files outside the direct scope of the request.
- **No Browser Actions Unless Asked** - Never open web browsers/browser tools unless the user has explicitly requested it. Test commands are part of the normal project checks: run `npm test` or `npm run build` when a change touches code covered by those checks or when the user asks for verification.
- **Act immediately on simple requests** - If the user describes a clear, specific change, make it directly without preamble, planning steps, or explanation. Save analysis for genuinely complex or ambiguous tasks.

## Branching model: `develop` → `alpha` → `main`

Day-to-day work lands on the `develop` branch, never directly on `alpha` or `main`.
`alpha` only moves when the separate "Force to alpha" command explicitly promotes
`develop` onto it; `main` only moves when "Force to main" explicitly promotes `alpha`
onto it, and each promotion to `main` becomes exactly one release (one changelog entry,
one version bump, one `:latest` + versioned Docker image publish).

### Changelog content is computed locally, before every push - never by CI

All three of `changelog.develop.json`, `changelog.alpha.json`, and `changelog.json` are
written locally, as part of running "Push to git" / "Force to alpha" / "Force to main"
themselves, using real local git history - never by a CI job reading GitHub's push-event
commit list after the fact. That payload is only reliable for a plain incremental push;
`alpha` and `main` are always reached by a force-push (see below), for which the push
event's commit list is empty or incomplete. Computing content locally, where full git
history is always available, removes that failure mode entirely rather than working
around it. Consequently none of the three publish workflows write anything back to their
branch: they only build, verify, and publish the Docker image using values that were
already committed.

- **`develop`**: `scripts/rebuild-develop-changelog.js`, run as part of "Push to git",
  fully recomputes `changelog.develop.json`'s single entry from every real commit between
  `changelog.develop.json`'s own `resetCommit` anchor and `HEAD` - not an accumulating
  list of one entry per push. There is only ever one entry to read, and it is always
  current; nothing needs a later consolidation pass. `build` bumps by one on every
  rebuild that finds real content and otherwise counts up for the lifetime of the
  branch - it never compares against alpha's or main's version, so it can't appear to
  regress. `resetCommit` and `entries` are the only fields "Force to alpha" resets;
  `build` is not. The running develop build shows this as `Develop Build <n>` in the
  sidebar and Settings → About. `docker-publish-develop.yml` publishes a rolling image to
  `ghcr.io/lasikiewicz/plembfin:develop` (also tagged `develop-<build>`) on every push,
  reading the build number that's already in the pushed commit.

- **`alpha`**: `scripts/promote-develop-to-alpha.js`, run as part of "Force to alpha"
  (before the force-push), merges develop's current entry into alpha's own current
  entry - not a separate entry per "Force to alpha" call. alpha also keeps exactly one
  entry: a fresh "Force to alpha" call folds new develop work into it in place, so the
  entry a user reads is always the complete, current picture of everything pending for
  the next release, not one of several stacked build entries. It self-heals to a fresh
  `baseVersion` and build 1 whenever `main`'s version has moved on since the last alpha
  build, and resets again on the next "Force to main". Never touches `changelog.json` or
  the package version. The running alpha build shows this as `v<version>.<build> alpha`
  (e.g. `v0.8.0.7 alpha`) in the sidebar and Settings → About. `docker-publish-alpha.yml`
  publishes a rolling pre-release image to `ghcr.io/lasikiewicz/plembfin:alpha` (also
  tagged `alpha-<build>`), reading the build number already in the pushed commit.
  `alpha` gets the same secret-scan and security CI coverage as `main`, so problems
  surface as soon as something is promoted to it.

- **`main`**: `scripts/promote-alpha-to-main.js`, run as part of "Force to main" (before
  the force-push), takes alpha's current entry directly - already merged and correct -
  bumps the real semver, and writes `changelog.json`, `package.json`,
  `package-lock.json`, and `CHANGELOG.md`. `update-changelog.yml` (workflow name
  "Publish Main Release") runs the full build gate against what was already committed and
  publishes `:latest` + `:<version>`.

Both promotion scripts run the same release-content check
(`changelogEntryProcessViolations` in `scripts/changelog-message.js`) on the entry they
just assembled and refuse to write it if any recognized release-process text survives -
this is the only gate now; there is no separate CI validation step to wait for.

### Before pushing anything: make sure GHCR Cleanup isn't running

`ghcr-cleanup.yml` deletes images from the same `ghcr.io/lasikiewicz/plembfin`
package that every push described below (`Push to git`, `Force to alpha`, `Force
to main`) publishes new tags to. The cleanup action's own docs warn it isn't safe
to run in parallel against the same package it targets, so before starting any of
the three commands below, check it isn't mid-run:
```bash
gh run list --workflow ghcr-cleanup.yml --limit 1
```
If the latest run shows `in_progress`, wait for it to complete before pushing.

## "Push to git" command

Any request to push the current work to Git—including lowercase wording or phrases
such as **"push all to git"**—means this complete workflow; it never means running
`git push` by itself. Run the full pre-push workflow before committing to `develop`:

### 1 - Review all pending changes
```bash
git diff --stat HEAD
```
Read the list of changed files to understand what was touched in this session.

### 2 - Sync docs and README
For every changed file, check whether the corresponding doc **and** the relevant section of `README.md` need updating:

| Changed area | Doc to check | README section to check |
| --- | --- | --- |
| Webhook auth / `parsers.js` / webhook flow | `docs/webhooks.md` | ⚡ Webhook Setup |
| Scheduler / `scheduled.js` / `cron-sync` | `docs/scheduled-sync.md` | 🛠️ Architecture |
| Now-playing / `live_tracking_cache` | `docs/now-playing.md` | - |
| `schema.sql` / new SQLite tables | `docs/sqlite-schema.md` | ⚙️ Configuration Reference |
| Plex client / notification listener | `docs/plex.md` | ⚡ Webhook Setup |
| Emby client | `docs/emby.md` | ⚡ Webhook Setup |
| Jellyfin client | `docs/jellyfin.md` | ⚡ Webhook Setup |
| TMDB / TVDB / Fanart / OMDb gateways or caches | `docs/metadata.md` | ⚙️ Configuration Reference |
| Poster pipeline (`posterCache.js` / `images.js`) | `docs/posters-artwork.md` | - |
| Dashboard (`dashboard.js`) | `docs/dashboard.md` | 🌟 Key Features |
| Movies page | `docs/movies.md` | 🌟 Key Features |
| TV Shows page / show progress / next-airing | `docs/tv-shows.md` | 🌟 Key Features |
| Media detail / person pages / edit dialogs / watch actions | `docs/media-detail.md` | 🌟 Key Features |
| History page / search | `docs/history-search.md` | 🌟 Key Features |
| Stats page | `docs/stats.md` | 🌟 Key Features |
| Settings tabs / config store / maintenance tools | `docs/settings.md` | 🔧 Full Setup Guide |
| Auth / sessions / cookies / secrets | `docs/auth.md` + `docs/architecture.md` | 🔧 Full Setup Guide |
| Backups / destinations / backup UI | `docs/backups.md` | 💾 Backup & Restore System |
| SPA routing / state / module layout | `docs/frontend.md` | - |
| Scripts / CI workflows / Docker / release pipeline | `docs/development.md` | 🚀 Getting Started |
| New feature or setting | `docs/architecture.md` + the matching feature doc | 🌟 Key Features / 🔧 Full Setup Guide |
| New env variable | `docs/architecture.md` | ⚙️ Configuration Reference |
| New file, or a file moved/renamed | file map in `docs/architecture.md` | - |
| Any server-side breaking change | `docs/troubleshooting.md` | relevant setup section |
| Overall architecture change | `docs/architecture.md` + `docs/README.md` | 🛠️ Architecture |
| Docker / deployment change | `docs/development.md` | 🚀 Getting Started |
| Key Features list in README | - | 🌟 Key Features |
| Push-to-git / agent workflow change | `CLAUDE.md` | 🧑‍💻 Development Workflow |

**Important**: Always read the actual README sections that correspond to changed areas - do not assume they are already up to date. README prose can become stale even when docs/ files are current.

Update any doc **and** the matching README section that is out of date before proceeding.

Documentation and README copy must stand on its own for a first-time reader. State the current behavior as a fact; avoid historical or relative wording such as "still", "previously", "formerly", "same as before", "no longer", or "new" unless the sentence is explicitly about an upgrade, migration, or changelog entry. For metadata source descriptions, say which source provides which data instead of referencing what another source used to provide.

### Backlog and documentation sync

When implementing or finishing work described in `TODO.md`, remove the completed
item from the TODO file in the same change. If the completed work changes user-visible
behavior, also update the relevant `docs/` page and README section. Before removing
an item, verify that the code and documentation both describe the current behavior.

### 3 - Sync in-app help
For every changed feature or setting, check the relevant frontend module in `public/modules/` or `public/app.js`:
- **Feature-owned help renderers and modal `helpHtml`** - update any setup copy if flows changed
- **`renderSettingsInlineHelp()`** - check that the inline help content in each settings panel still matches the current behaviour
- **`webhookWarning()` / `plexWebhookSetup()` / `embyWebhookSetup()` / `jellyfinWebhookSetup()`** - update if webhook setup steps changed (live in `modules/help-content.js` after refactor)
- **`cronSyncGuide()`** - update if scheduler endpoint or behaviour changed
- **`adminTokenGuide()`** - update if auth flow changed

### 4 - Write the commit message
Use this format - the first line becomes the changelog `message`; bullet-point body lines are parsed into `details` by `scripts/rebuild-develop-changelog.js` in step 6:

```
<type>: <concise one-line summary of the session>

- Key change 1 (user-visible description, no code jargon)
- Key change 2
- Key change 3
...
```

Types: `feat` (new feature), `fix` (bug fix), `security` (security change), `chore` (maintenance), `docs` (docs only).

Keep bullet points to the 3-8 most significant user-visible changes. Skip internal refactors that don't affect behaviour.

Keep release-process bookkeeping - such as consolidating changelog entries, trimming
folded-in bullets, or resetting a branch build counter - out of release bullets. The
shared changelog filter removes recognized process notes at the alpha/main boundary,
and the target workflow rejects any recognized process text that survives.

Do not create single-line commits for user-visible changes. If the change affects behavior, UI, docs, setup, data sources, sync, caching, or settings, the commit body must include bullet-point details. The changelog generator only reads body lines that start with `- ` or `* `; without them, the Settings → Changelog entry will be sparse. If you are about to commit without bullet details, stop and rewrite the commit message before committing.

This is an enforced release requirement, not optional guidance. Before committing, compare the staged diff with the bullet list and make sure every significant user-visible outcome is represented. A bullet that merely repeats the subject is not a detail. Use separate `-m` arguments (or a commit-message file) so the body is actually recorded:

```bash
git commit -m "fix: concise summary" \
  -m "- First concrete user-visible outcome
- Second concrete user-visible outcome"
```

The `.githooks/commit-msg` hook rejects `feat`, `fix`, `security`, `enhance`, and `docs` commits that have no meaningful bullet, and `rebuild-develop-changelog.js` in step 6 applies the same `validateReleaseMessage` check again while walking real git history, so bypassing local hooks (or a commit from before this repo had the hook) still cannot reach a published changelog entry. After committing, verify the recorded message with `git log -1 --format=full` before pushing.

### 5 - Stage and commit
Stage all modified files **except** `data/`, `node_modules/`, and any secrets. Commit using the message written in step 4.

### 6 - Rebuild the develop changelog
```bash
node scripts/rebuild-develop-changelog.js
git add changelog.develop.json
git commit -m "chore: rebuild develop changelog"
```
This walks every real commit from `changelog.develop.json`'s `resetCommit` anchor (set by
the last "Force to alpha") through the commit just made in step 5, inclusive, and
recomputes the single develop entry from scratch - so it picks up not just this session's
work but anything pushed in an earlier "Push to git" run since the last reset too. If it
prints "No user-facing commits since the last reset", nothing changed the file; skip
`git add`/`git commit` for it. If it exits with a validation error, fix the offending
commit message(s) it names before continuing - do not bypass it.

### 7 - Consolidate pending local commits
Check what is about to be pushed:
```bash
git log origin/develop..HEAD --oneline
```
This is normally at least two commits now (the step 5 commit plus step 6's changelog
commit); squash them into one clean commit before pushing so history on `develop` stays
one commit per push, same as before:
```bash
git reset --soft origin/develop
git commit -m "<type>: <consolidated summary>" \
  -m "- consolidated bullet 1
- consolidated bullet 2"
```
Take the commit message from step 4's product commit - step 6's "chore: rebuild develop
changelog" commit has no product bullets of its own and contributes nothing to the
message. `git reset --soft` preserves the working tree exactly, so the changelog file step
6 already rebuilt is included in this final commit untouched. If more than one *product*
commit is being squashed (e.g. this session added to a commit still pending from an
earlier interrupted "Push to git" run), combine their bullet lists into one consolidated
list using the same standard as step 4 (3-8 of the most significant user-visible changes;
drop a bullet that just restates another one in the group more briefly) - this is exactly
what turned one evening's worth of commits into a 38-bullet release note once (see
`docs: consolidate v0.12.9 changelog entry into higher-level bullets` for the correction
this required) - and re-run step 6 afterward so the rebuilt entry reflects the final,
consolidated message rather than the pre-squash one.

### 8 - Push

The pre-push hook is a second, independent safety gate: for every push whose
remote branch is `develop`, it validates the changelog stored in the exact
commit being pushed with `node scripts/rebuild-develop-changelog.js --check`.
If the changelog rebuild/commit step was skipped or is stale, the push is
rejected with the repair command. Never bypass this with `--no-verify`.

```bash
git push origin develop
```
This lands the commit on `develop`, not `alpha` or `main`. `docker-publish-develop.yml`
builds, verifies, and publishes a rolling image to `ghcr.io/lasikiewicz/plembfin:develop`
using the build number already in the pushed commit - it does not write anything back.
Nothing touches `changelog.json`/`changelog.alpha.json` or the package version, `:latest`
is not updated, and - unlike `alpha` - **no secret-scan or security CI runs against this
push**; that coverage only starts once "Force to alpha" promotes it.

If `git status` or a failed push reports `develop` and `origin/develop` have diverged (another
session or the user pushed in the meantime - CI no longer writes back here, so this should
be rare), reconcile as part of the same "Push to git" run:
```bash
git fetch origin
git merge origin/develop --no-edit   # or: git merge --ff-only origin/develop if it's a straight fast-forward
git push origin develop
```
Only pause and ask the user if the merge actually produces a conflict, or if
`origin/develop` contains commits that touch source files you don't recognize - that
would mean unrelated work landed on `develop` and needs a real decision, not an
automatic merge.

## "Force to alpha" command

When the user says **"Force to alpha"** (exactly), promote everything queued on
`develop` onto `alpha`:

### 1 - Bring develop up to date with main
```bash
git fetch origin
git checkout develop
git merge --ff-only origin/develop
git merge origin/main --no-edit
```
This folds in main's actual current state, so `develop`'s own copy of `changelog.json`
(used by `promote-develop-to-alpha.js` to self-heal alpha's base version) stays current.
Stop and ask the user if this step produces a real conflict.

### 2 - Merge develop's changelog into alpha, locally
```bash
node scripts/promote-develop-to-alpha.js
git add changelog.alpha.json changelog.develop.json
git commit -m "chore: promote develop changelog to alpha"
```
This is `promoteDevelopToAlpha()` in `scripts/promote-develop-to-alpha.js`: it merges
develop's current entry into alpha's own current entry (or starts a fresh alpha entry if
main has moved on since the last promotion), bumps the alpha build, and resets develop's
`entries` and `resetCommit` for the next cycle - `build` is not reset (see the branching
model section above). If it refuses with a release-process violation, that means a commit
folded into develop's entry still contains recognized process text; fix it on `develop`
and repeat from step 1. There is nothing to review afterward - the entry this writes is
what will actually publish.

### 3 - Force alpha to match develop
Show the user what is about to land before running this - it is a force push to the
shared `alpha` branch:
```bash
git log origin/alpha..HEAD --oneline
```
Then:
```bash
git push origin HEAD:alpha --force
```
`docker-publish-alpha.yml` reads the build number already in this commit and publishes
the image; it does not write anything back. Optionally confirm it succeeded:
```bash
gh run list --branch alpha --limit 1
```

### 4 - Push develop's reset state
The commit from step 2 also reset `changelog.develop.json` for the next cycle - publish
that to `develop` too (this is a plain push, not a force-push; it does not touch `alpha`
or `main`):
```bash
git push origin develop
```

## "Force to main" command

When the user says **"Force to main"** (exactly), promote `alpha`'s actual current tip
onto `main` as a single release:

### 1 - Check out alpha's actual current tip
```bash
git fetch origin
git checkout -B alpha origin/alpha
```
Not a stale local `alpha` branch, which may not exactly match `origin/alpha` - this
resets the local branch to the remote tip every time.

### 2 - Build the release, locally
```bash
node scripts/promote-alpha-to-main.js
```
This is `promoteAlphaToMain()` in `scripts/promote-alpha-to-main.js`: it takes alpha's
current entry directly (already merged and correct - there is nothing left to
consolidate), bumps the real semver (honouring a manually-set higher `package.json`
version instead of overwriting it with a patch increment), and writes `changelog.json`,
`package.json`, `package-lock.json`, and regenerates `CHANGELOG.md`, then resets
`changelog.alpha.json` and `changelog.develop.json` for the next cycle. If it refuses
with a release-process violation, that means alpha's entry still contains recognized
process text; fix the source commit on `develop`, repeat "Force to alpha", and restart
this command. Otherwise stage and commit:
```bash
git add changelog.json changelog.alpha.json changelog.develop.json CHANGELOG.md package.json package-lock.json
git commit -m "chore: promote alpha to main v<version>"
```

### 3 - Force main to match this commit
Show the user what is about to land before running this - it is a force push to the
shared `main` branch:
```bash
git log origin/main..HEAD --oneline
```
Then:
```bash
git push origin HEAD:main --force
```

The pre-push hook runs the complete build gate before changing `main`. If that gate
reports a test failure, do not bypass the hook and do not report the promotion as
blocked after the first failure. Run `npm test` once to check for the known transient
test-run failure. If that rerun passes, retry the exact same force-push command; its
pre-push hook must then run and pass the complete `npm run build` gate before the push
can proceed. If the focused rerun fails, or the retried full gate fails again, stop the
promotion and investigate the repeatable failure. Never use `--no-verify`.

`update-changelog.yml` (workflow name "Publish Main Release") reads the version already
in this commit, runs the build gate again in CI, and publishes `:latest` +
`:<version>` - it does not write anything back. Optionally confirm it succeeded:
```bash
gh run list --branch main --limit 1
```

### 4 - Update local develop to the new main version
```bash
git fetch origin
git checkout develop
git merge --ff-only origin/develop
git merge origin/main --no-edit
```
Local only - **do not push this to `origin/develop`**. This folds the release commit from
step 2 into the local `develop` checkout, carrying forward its reset
`changelog.alpha.json`/`changelog.develop.json` and the new `changelog.json` version, so
`package.json`/`changelog.json` read back locally as the version just released instead of
the previous one. It is not required for correctness: the next "Force to alpha" already
merges `origin/main` into `develop` as its own step 1, so `origin/develop` picks up main's
new state automatically the next time that command runs, whether or not this step ran
first - skipping it just means `origin/develop`'s bundled `changelog.json` (what a running
develop-channel build's Settings → About reads) shows the previous release as latest until
then, which is cosmetic only. Don't bother folding it into `alpha` either - the next
"Force to alpha" force-pushes develop's tip onto alpha regardless, so anything synced
there now is simply overwritten rather than built on.

## Commands

```bash
# Install dependencies (native modules better-sqlite3 + sharp install via prebuilt binaries)
npm install

# Run the app locally (serves UI + API + scheduler on http://localhost:5055)
npm start

# Run with auto-reload during development
npm run dev

# Build & run as a container
docker compose up --build
```

`npm test` runs the focused `node:test` suite under `test/`. `npm run build` runs the
syntax check, the same `node:test` suite, JSON validation, the server-side outbound-fetch guard, and a
one-shot server boot against a temp `DATA_DIR`. There is no separate linter configured.

The app listens on `PORT` (default `5055`). On a fresh install the admin username defaults
to `admin`; if `ADMIN_PASSWORD` isn't set, a random password is generated and printed once
to the server console/logs. Override with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` environment
variables. On first boot the server writes `data/config.json` with the admin credentials,
a generated API key, and a session secret.

## Frontend Module Discipline

> These rules prevent `app.js` from growing back into a monolith.

### File size limits
- **`public/app.js`** - orchestrator only. Must stay under **3,000 lines**. If it approaches this limit, extract the next logical group into a module.
- **`public/modules/*.js`** - individual modules. Soft limit **1,200 lines**; hard limit **1,500 lines**. If a module exceeds 1,200 lines, split it before adding more to it.

### Where new code goes
When adding frontend code, place it in the most specific existing module that owns that feature area:

| Feature area | Module |
| --- | --- |
| Formatting, string escaping, date helpers | `modules/utils.js` |
| Poster URLs, image caching, `posterMarkup` | `modules/images.js` |
| Static help/guide HTML | `modules/help-content.js` |
| Sync status, sync history, now-playing polling | `modules/sync.js`, `modules/sync-preview.js` |
| Sidebar sync indicator and the Sync Activity page (`/sync-activity`) | `modules/sync-activity.js` |
| Dashboard rendering | `modules/dashboard.js` |
| Stats rendering | `modules/stats.js` |
| Explorer grid, history page, search page | `modules/explorer.js` |
| Upcoming page (scrolling month calendar of upcoming episode air dates) | `modules/upcoming.js` |
| TV/movie detail entry points, lookups, modal-close routing | `modules/media-detail.js` |
| Detail-modal shell/context: callbacks, `authHeaders`, modal DOM root, render-token, debug modal | `modules/media-detail-context.js` |
| Detail-page watch and sync info summary rendering | `modules/media-info-summary.js` |
| Shared TMDB/Seerr rendering fragments (cast, trailers, images, ratings, recommendations) | `modules/media-detail-shared.js` |
| TV show detail rendering (seasons, episodes, show modal) | `modules/media-detail-show.js` |
| Movie detail rendering | `modules/media-detail-movie.js` |
| Person profiles and filmography | `modules/media-person.js` |
| Edit dialogs and watched-date/image/match tools | `modules/edit-dialogs.js` |
| Manual watched/unwatched actions | `modules/watch-action.js` |
| Shared calendar/time picker (used by edit dialogs and mark-watched prompts) | `modules/calendar-picker.js` |
| TMDB detail/season/person enrichment helpers | `modules/tmdb.js` |
| Trailer playback and photo lightbox | `modules/media-lightbox.js` |
| Trakt/CSV import and settings tools bridge | `modules/tools.js` |
| Live Trakt connection and initial-sync controls | `modules/tracker-settings.js` |
| Authenticated live watch-state refresh stream | `modules/live-updates.js` |
| Backup and appearance tools | `modules/tools-backups.js` |
| Maintenance diagnostics, cache tools, sync repair tools, and sync health | `modules/tools-maintenance.js`, `modules/tools-health.js` |
| Library-wide duplicate-watch cleanup (Settings → Tools → Database Repairs) | `modules/tools-duplicates.js` |
| Wipe data (Settings → Tools → Wipe data): watch history, sync history/logs, and full factory reset | `modules/tools-wipe-data.js` |
| Auth, session, tokens | `modules/auth.js` |
| Guided first-run setup (`/setup`), account-claim form wiring, dashboard checklist, Settings resume banner | `modules/onboarding.js` |
| Debug/diagnostic logs & telemetry export | `modules/logs.js` (categorization, local time formatting, export) |
| Connection label formatting | `modules/settings.js` |
| Shared settings modal, picker, and card-grid primitives | `modules/settings-ui.js` |
| Media-server and metadata-provider settings cards/modals | `modules/settings-services.js` |
| Flat settings routes, landing list, sidebar, help panels, and clean path routing (`/settings/media-servers`, `/settings/sync`, etc.) | `modules/settings-shell.js` |
| Shared `state` and `elements` objects | `modules/state.js` |
| App event wiring | `modules/app-events.js` |
| Media-detail modal click delegation (cast/trailers/poster edit/watch actions/card navigation) | `modules/media-detail-events.js` |
| Poster-card three-dot overflow menu (Mark Unwatched / Edit watch date / Fix match) outside the media detail pages | `modules/poster-menu.js` |
| App startup, routing, `bindElements` | `app.js` |

### Creating a new module
If a new feature area doesn't fit any existing module and would exceed 150 lines:
1. Create `public/modules/<feature>.js` using named ES module exports
2. Add `<link rel="modulepreload" href="/modules/<feature>.js" />` to `index.html`
3. Import it in `app.js` (or the owning module)
4. Update this table above

### Dependency rules
- Modules may import from `state.js`, `utils.js`, `images.js`, `auth.js`, `logs.js`, `settings.js`, `settings-ui.js`
- `sync.js` may be imported by `dashboard.js` and `media-detail.js` - not the reverse
- No module may import from `app.js`
- Avoid circular dependencies - if you need A→B and B→A, the shared logic belongs in a third module

## Backend Module Discipline

> These rules prevent `server/src/index.js` from growing back into a monolith.

### File size limits
- **`server/src/index.js`** - route table only. Keep it under **500 lines**.
- **`server/src/routes/*.js`** - owning route modules. Soft limit **1,200 lines**; hard limit **1,500 lines**. Split by feature area before crossing the hard limit.

### Where new route code goes
- Add the route entry in `dispatch()` inside `server/src/index.js`.
- Put the handler in the owning `server/src/routes/*.js` module.
- Keep shared helpers in `server/src/utils/` only when more than one route module needs them.
- Avoid circular imports back into `server/src/index.js`; route modules may import utilities and data-layer modules directly.

| API area | Module |
| --- | --- |
| Config, appearance, Seerr/app links, connection tests | `server/src/routes/admin.js` |
| Plex, Emby, and Jellyfin account connection flows | `server/src/routes/mediaAuth.js` |
| Trakt device authorization and connection management | `server/src/routes/trackerAuth.js` |
| Guided first-run setup status/step/import/complete/restart/checklist API | `server/src/routes/onboarding.js` |
| Authenticated browser watch-state update stream | `server/src/routes/liveUpdates.js` |
| Portable, watch-history, and encrypted backup APIs | `server/src/routes/backups.js` |
| History, library, and watch-record edits | `server/src/routes/media.js` |
| TMDB/TVDB/Fanart/OMDb/YouTube metadata and image APIs | `server/src/routes/metadata.js` |
| Webhooks, manual watch/unwatch, playback progress, sync job/history listing, cron/force sync, preview plans, now playing | `server/src/routes/sync.js` |
| Backfill, repair, dedup, rematch, cache, logs, changelog, ping | `server/src/routes/maintenance.js` |
| Wipe data: watch history, sync history/logs, and full factory reset (also resets `data/config.json` via `appConfig.js`'s `resetAdminAccount()`) | `server/src/routes/wipeData.js` |
| Scheduler tick and Plex notification listener lifecycle | `server/src/scheduler.js` |

## Architecture

This is a **self-hosted app** in the style of Sonarr/Radarr/Jellyseerr. The default
`ROLE=all` process serves the web UI, the `/api/*` surface, and the per-minute scheduler;
split deployments use `web` and `worker` roles against the same local **SQLite** database
and **media folder** under `data/`.

### Process layout

**Entrypoint** (`server/server.js`) - an Express app that:
- static-serves `public/` (the SPA) and `data/media` (cached artwork at `/media/...`)
- mounts the API router at `/api/*` (raw body captured so webhook/JSON handlers parse it themselves)
- runs the per-minute scheduler when its role is `all` or `worker`; a SQLite lease elects one owner
- falls back to `index.html` for client-side routes

**API** (`server/src/index.js`) - a manual `dispatch()` router that strips the `/api/`
prefix and routes to `handleWebhook`, `handleHistory`, `handleMovies`, etc. `dispatch` is
imported and mounted by `server.js`.

**Frontend** (`public/`) - a plain ES module SPA with no build step. `app.js` is the orchestrator (routing, startup, event wiring); feature logic lives in `public/modules/`, including the account/tracker settings and authenticated live-update stream. No framework, bundler, or TypeScript.

### Data layer (`server/src/db.js` + `schema.sql`)

`better-sqlite3` opens `data/plembfin.db` (WAL mode) and applies `schema.sql` on boot. The
repo modules (`dataRepo.js`, `configStore.js`, `posterCache.js`, `activeSessions.js`,
`loopStore.js`, `tmdbGateway.js`) use prepared SQL statements.

Derived caches use **in-process memoization** keyed by a shared SQLite history version
(`getDataVersion()` / `bumpDataVersion()` in `db.js`). `invalidateHistoryDerivedCaches()`
bumps the shared version; each process observes it and reloads the in-memory `historyCache`/`movieCache`/`showCache`/
`scheduledShowCache`/`statsCache` reload on the next read. `getCachedShows()` keeps two
slots because its `includeScheduledLibraryHistory` variant returns a different show set -
both must be memoized or that variant recomputes from the full watch history on every call.

### Auth (`server/src/utils/auth.js` + `server/src/appConfig.js`)

Local username/password login. `appConfig.js` resolves credentials from env or
`data/config.json` (hashing the password with scrypt) and generates an API key + session
secret on first run. `requireAdmin(req,res)` accepts either a signed HttpOnly session cookie
(`plembfin_session`, HMAC over the session secret) **or** the API key (via `X-Api-Key`,
`Authorization: Bearer`, or `?api_key=`). Routes: `POST /api/login`, `POST /api/logout`,
`GET /api/auth/status`. The webhook + now-playing EventSource use the API key.

### Data flow: webhook → sync

When a play event arrives at `/api/webhook`:
1. `normalizeWebhook()` parses Plex (multipart), Emby (JSON), Jellyfin (JSON), or custom JSON into a unified `media` object
2. The `phase` field drives branching: `active` → upsert active session; `ended` → sync resume progress; `unplayed` → delete + propagate unwatched; default → insert watch record + propagate watched
3. `syncMediaPlaystate()` (in `syncOrchestrator.js`) propagates to the other two platforms, with loop detection via `loopStore`
4. Results are written back as `sync_dispatch_telemetry` on the watch record

### Scheduled sync (`runScheduledTick` / `/api/cron-sync`)

`server.js` invokes `runScheduledTick()` (in `scheduler.js`, wrapping `runScheduledSync` in
`scheduled.js`) once per minute, guarded against overlap. It queries recent watch history and
the live tracking cache, checks whether active sessions crossed the "watched" threshold, and
propagates outstanding sync jobs. Force sync (`/api/force-sync`) runs the same logic on demand
and stores progress in `runtime_state` for polling.

### Sync and episode-query troubleshooting

When a watch looks unexpected, start with the show's **Info** export (the data behind
`/api/history-audit`) rather than the displayed timestamp alone. Compare these fields:

- `watch_provenance.source`, `ingest_path`, `event`, `phase`, `source_timestamp`,
  `captured_at`, `item_id`, `user`, `session_id`, `device`, and `client`.
- `sync_dispatch_telemetry`, then the `watch_audit_events` entries for `source_event`,
  `history_added`, `sync_dispatch`, and `sync_target`.
- A `library_history` event with no session/device/client is a scheduled media-server
  library-state import, not proof that playback occurred. An `item.markplayed` event is an
  explicit played-state change; compare the raw server payload's played date and play count.
  A successful `200` target result confirms propagation, not that the source watch was valid.

Trace sync issues in this order:

1. `server/src/scheduled.js` (`syncRecentlyWatchedFromPlex`, `syncRecentlyWatchedFromEmby`,
   `syncRecentlyWatchedFromJellyfin`) and `server/src/utils/watchDates.js` for catch-up
   polling, source played dates, and API-marked items.
2. `server/src/routes/sync.js` and `server/src/utils/parsers.js` for webhook normalization,
   phases, and source-event handling.
3. `server/src/utils/syncOrchestrator.js`, `loopStore.js`, and `syncRoles.js` for target
   selection, outbound results, and echo-loop suppression. Use `docs/scheduled-sync.md`,
   `docs/webhooks.md`, and the relevant platform doc alongside the code. For a detail-page
   Force Sync (`server/src/utils/mediaForceSync.js`) or a manual watch-date edit
   (`propagateCorrectedWatchDate` in `server/src/routes/media.js`), the same
   `syncOrchestrator.js` functions do the outbound work; check `remoteItemToMedia`'s
   played-date handling first if a title was imported with an unexpected watched date.
4. `server/src/utils/watchAudit.js`, `server/src/routes/media.js` (`handleHistoryAudit`),
   and `server/src/utils/dataRepo.js` for the persisted audit trail, watch-history rows,
   playstate, and telemetry.

For episode queries, identity mismatches, or duplicate show episodes, check
`server/src/utils/dataRepo.js` first: `mediaKeyFor`, `findWatchedByAnyMediaKey`,
`queryShowDetail`, and `queryWatchHistory`. Then trace `handleShow`/`handleHistory` in
`server/src/routes/media.js`, the episode fetchers (`fetchPlexSeriesEpisodes`,
`fetchEmbySeriesEpisodes`, `fetchJellyfinSeriesEpisodes`) in the three platform clients,
and the renderer in `public/modules/media-detail-show.js`. Always compare title, show title,
season/episode coordinates, all provider IDs, and `media_key`; `mediaKeyFor` prefers IMDb,
then TMDB, then TVDB, while `findWatchedByAnyMediaKey` also checks alternate IDs and the
coordinate fallback.

### Poster pipeline

1. **Frontend** (`posterMarkup` / `hydratePosterFallbacks` in `modules/images.js`): renders a `poster-fallback` span if no URL is known, then calls `/api/poster?id=<watchRecordId>`. The TMDB prefetch observer (`observeExplorerTmdbPrefetch`) short-circuits this for explorer cards.
2. **Backend** (`/api/poster`, `posterCache.js`): tries candidates in order - stored URL, configured server URL (Plex/Emby/Jellyfin), TMDB fallback - resizes with `sharp`, writes the winner to `data/media/posters` (or `backdrops`), and serves it at `/media/...`. The cache key is `mediaKey` (canonical title + type + IDs); metadata lives in the `poster_cache` table.

**Important**: `isCachedStorageImageUrl()` in `modules/images.js` returns `true` only for `/media/posters/` and `/media/backdrops/` URLs. TMDB `image.tmdb.org` URLs are **not** treated as cached.

### SQLite tables

- `watch_history` - canonical watch records
- `playstate` - per-item watched/unwatched state for sync targets
- `playback_progress` - resume position records
- `active_sessions` - currently-playing sessions from webhook `active` events
- `live_tracking_cache` - richer live session data used by scheduled sync
- `sync_history` - log of all sync dispatch results
- `runtime_state` (single row, JSON blob) - last cron time, force sync state/log, now-playing refresh signal
- `settings` (single row, JSON blob) - Plex/Emby/Jellyfin/TMDB connection settings
- `loop_keys` - loop-detection KV with TTL
- `poster_cache` - cached artwork metadata (binaries live in `data/media`)
- `tmdb_metadata_cache` / `tmdb_search_cache` / `tmdb_season_cache` / `tmdb_person_cache` - TMDB caches

### Frontend state and routing

`app.js` uses a single `state` object (no framework). Navigation is SPA-style via
`navigateTo(url)` / `handleRouting()` / `history.pushState`. Routes: `/` → dashboard,
`/movie/:id`, `/tvshow/:key`, `/person/:id`, `/help/:topic`.

Auth is managed by `onAuthChange()` (`modules/auth.js`) - which checks `/api/auth/status`.
The auth panel becomes visible when no session is active; the app shell shows on successful login.

The explorer grid uses IntersectionObserver (1200px rootMargin) to pre-fetch the next page;
page size 240. A second observer (`observeExplorerTmdbPrefetch`) pre-fetches TMDB details.

### Environment variables

- `PORT` - HTTP port (default `5055`)
- `DATA_DIR` - data directory (default `<repo>/data`; Docker sets `/data`)
- `ADMIN_USERNAME` (default `admin`) / `ADMIN_PASSWORD` - admin login. If `ADMIN_PASSWORD` is unset on a brand-new install, a random password is generated and printed once to the server console.
- `API_KEY` - pin the webhook/integration key (otherwise generated into `data/config.json`)
- `SESSION_SECRET` - pin the session signing secret (otherwise generated)
