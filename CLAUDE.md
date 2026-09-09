# CLAUDE.md

Agent instructions for working with this codebase.

> **Before changing anything, read [`docs/architecture.md`](docs/architecture.md).**
> It is the master guide: the big picture, a complete map of every file in the repo,
> request flow, the data layer, auth, and environment variables. The table at the end
> of this file routes you to the doc that owns the area you are touching.

> **For website update requests, also follow [`docs/websiteupdate.md`](docs/websiteupdate.md).**
> Start by discovering the verification baseline recorded by the website, then review
> and document all changes after that baseline and visually check affected pages locally.

> **For website publishing setup, follow [`docs/website-deployment.md`](docs/website-deployment.md).**
> The website is a static Astro site in `website/`; do not push or deploy it without an
> explicit user request.

## Local testing context

When local-server or connected-browser testing is explicitly requested, check whether
`.claude/local-environment.md` exists and read it before testing. It contains
machine-specific local URLs and signed-in browser-session context, and is intentionally
gitignored. Treat it as optional because it is absent from fresh clones and other
machines.

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
written locally, by the push command that produces them, from real local git history.
No CI job ever writes changelog content or a version back to a branch; the publish
workflows only build, verify, and publish using values already committed.

The reason: `alpha` and `main` are always reached by force-push, and a force-push's
GitHub push event carries an empty or incomplete commit list, so anything computed from
it comes out truncated. Local git history is always complete. See `docs/decisions.md`
entry 6 for what was rejected and why.

- **`develop`**: `scripts/rebuild-develop-changelog.js` recomputes the single entry from
  every real commit between `resetCommit` and `HEAD`. Shows as `<version> Build <n>`.
- **`alpha`**: `scripts/promote-develop-to-alpha.js` prepends develop's entry as its own
  standalone build entry, so a tester sees each build separately. Version is four
  segments, `baseVersion.build`. Shows as `v<version> alpha`.
- **`main`**: `scripts/promote-alpha-to-main.js` consolidates the cycle's alpha entries
  into one release, headlined by the `releaseMessage` the operator writes and the user
  approves, then bumps the real semver.

Both promotion scripts run `changelogEntryProcessViolations` (`scripts/changelog-message.js`)
and refuse to write an entry containing recognized release-process text.

Full detail, including the per-branch file formats, image tags, and the publish
workflows, is in [`docs/development.md`](docs/development.md). The step-by-step
procedures live in the `push-to-git`, `force-to-alpha`, and `force-to-main` skills.

## Release commands: use the matching skill

Three phrases trigger a full release procedure. Each one lives in its own skill so the
whole procedure arrives fresh at invocation instead of competing for attention here.
**Invoke the skill and follow it exactly. Never improvise or reconstruct these
procedures from memory.**

| The user says | Invoke |
| --- | --- |
| "Push to git", "Push all to git", "push all the git" (any case) | `push-to-git` |
| "Force to alpha" (exactly) | `force-to-alpha` |
| "Force to main" (exactly) | `force-to-main` |

These hold regardless of which skill is running, so they are repeated here:

- Never run `git push` because one of these phrases appeared. The phrase means run the
  workflow; the push is one late step inside it, after every gate has passed.
- Never deploy, and never push to any remote, unless the user explicitly asked in that
  request.
- Never bypass a hook with `--no-verify`, and never bypass the changelog rebuild.
- Before any of the three, check that GHCR Cleanup is not mid-run
  (`gh run list --workflow ghcr-cleanup.yml --limit 1`); each skill repeats this as its
  first step.
- "Force to alpha" and "Force to main" are force-pushes to shared branches. Show the user
  what is about to land first. "Force to main" runs the mandatory website update gate and
  additionally requires explicit user approval of the previewed changelog in chat before
  anything is staged.
- Day-to-day work lands on `develop`, never directly on `alpha` or `main`.

## Documentation and backlog sync

When implementing or finishing work described in `TODO.md`, remove the completed
item from the TODO file in the same change. If the completed work changes user-visible
behavior, also update the relevant `docs/` page and README section. Before removing
an item, verify that the code and documentation both describe the current behavior.

### Decision records

[`docs/decisions.md`](docs/decisions.md) holds the reasoning behind deliberate calls, so
it survives a squashed history and a later reader does not undo an incident-driven
safeguard without seeing the incident. Add a numbered entry only when all three are true:
a plausible alternative existed and was rejected, the reason is not visible from reading
the code, and undoing it later would cost real time, data, or user trust. Ordinary
implementation choices, anything already stated in a feature doc, and release bookkeeping
do not get entries. Append in date order, never renumber, and mark a reversed decision as
superseded with a pointer to the entry that replaced it rather than deleting it.

Before changing behavior that looks unnecessarily cautious - a dropped sync signal, an
extra confirmation step, a guard that seems redundant - check `docs/decisions.md` first.


## Commands

```bash
# Install dependencies (native modules better-sqlite3 + sharp install via prebuilt binaries)
npm install

# Run the app locally (serves UI + API + scheduler on http://localhost:5055).
# On Windows, use the approved elevated network-enabled execution path.
npm start

# Run with auto-reload during development (also use the elevated path on Windows)
npm run dev

# Build & run as a container
docker compose up --build
```

### Local-server launch standard

On Windows, every local server opened for browser, provider-backed, or connected-service
testing must be started through the approved elevated network-enabled execution path by
default. Do not start `npm start` or `npm run dev` inside the restricted sandbox: outbound
provider requests can fail with `EACCES` even when the application and provider are healthy.
Offline unit tests and static checks may still run in the restricted sandbox.

This is a launch-environment rule, not a replacement npm command: `npm start` remains the
canonical server command. A normal host PowerShell terminal is already network-enabled;
agent-launched starts must explicitly request the elevated network-enabled execution path.

### Network-backed local testing

Provider-backed flows (TMDB, TVDB, Plex, Emby, Jellyfin, or Trakt) must be tested
with the local server started using the approved network-enabled execution path on
Windows. A server started inside the restricted sandbox can report `EACCES` while
opening an outbound provider connection even though the application and provider
are healthy. Stop that process, start the same command with approved elevated
network access, confirm `http://localhost:5055` responds, and only then diagnose
provider or application behavior. Treat an outbound-fetch `EACCES` from the
restricted process as an execution-environment failure, not an application result.

### Restricted Windows Git checks

The managed workspace may deny Git access to the user-level excludes file at
`C:\Users\<user>\.config\git\ignore`. For read-only status checks in that
environment, use a per-command repository-local excludes file instead of changing
global Git configuration:

```powershell
git -c core.excludesFile=C:\path\to\plembfin\.git\info\exclude status --short --branch
```

Do not modify global Git configuration or the repository config to work around that
host permission boundary.

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

#### Grandfathered files (already over, measured 2026-09-08)

These are already past the limits above. The limits still apply in full to every file
not on this list.

| File | Lines | Limit |
| --- | --- | --- |
| `public/app.js` | 3428 | 3000 |
| `public/modules/media-detail-show.js` | 2541 | 1500 |
| `public/modules/app-events.js` | 2225 | 1500 |
| `public/modules/sync-activity.js` | 2199 | 1500 |
| `public/modules/explorer.js` | 2098 | 1500 |
| `public/modules/edit-dialogs.js` | 1932 | 1500 |
| `public/modules/media-detail-events.js` | 1774 | 1500 |
| `public/modules/watch-action.js` | 1680 | 1500 |
| `public/modules/tools-maintenance.js` | 1541 | 1500 |
| `public/modules/onboarding.js` | 1442 | 1200 soft |
| `public/modules/sync.js` | 1355 | 1200 soft |
| `public/modules/tools-backups.js` | 1307 | 1200 soft |

**Do not grow them.** New code for these feature areas goes into a new or existing
sibling module, not onto the end of one of these.

**Do not split one on your own initiative.** Being over the limit is not a task. Split
only when the work you were already asked to do is touching that file anyway, and even
then say what you propose to extract and get the user's explicit go-ahead first. An
unrequested refactor is a violation of the Agent Guidelines above, and these files are
large precisely because they own a lot of behavior, so a careless split breaks more than
it tidies.

**When a split is approved, do it properly:** move whole feature units rather than
arbitrary line ranges, keep the existing named exports working or update every importer,
add the `modulepreload` link in `index.html`, update the module table below, and check
that nothing else imported what you moved.

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
| Personal Rating Sync settings, provider directions, status polling, and manual actions | `modules/rating-sync-settings.js` |
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

#### Grandfathered files (already over, measured 2026-09-08)

These are already past the limits above. The limits still apply in full to every file
not on this list. `server/src/index.js` is well inside its own limit at 190 lines.

| File | Lines | Limit |
| --- | --- | --- |
| `server/src/routes/sync.js` | 3389 | 1500 |
| `server/src/routes/metadata.js` | 1505 | 1500 |
| `server/src/routes/maintenance.js` | 1399 | 1200 soft |
| `server/src/routes/media.js` | 1311 | 1200 soft |

The same three rules apply as for the frontend list: **do not grow them**, **do not
split one on your own initiative** (only when the work at hand is already touching the
file, and only after proposing the extraction and getting the user's explicit
go-ahead), and **when a split is approved, do it properly** - move whole handler groups,
update the `dispatch()` entries in `server/src/index.js`, keep shared helpers in
`server/src/utils/` only when more than one module needs them, and update the API area
table below.

`sync.js` deserves particular care: it owns webhook ingestion, manual watch and unwatch,
playback progress, the sync job and history APIs, cron and force sync, preview plans, and
now playing. Several of the incident-driven rules in [`docs/decisions.md`](docs/decisions.md)
constrain code in this file.

### Where new route code goes
- Add the route entry in `dispatch()` inside `server/src/index.js`.
- Put the handler in the owning `server/src/routes/*.js` module.
- Keep shared helpers in `server/src/utils/` only when more than one route module needs them.
- Avoid circular imports back into `server/src/index.js`; route modules may import utilities and data-layer modules directly.

| API area | Module |
| --- | --- |
| Config, appearance, Seerr/app links, connection tests | `server/src/routes/admin.js` |
| Personal Rating Sync status, snapshot, explicit push, and retry | `server/src/routes/ratingSync.js` |
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

## Architecture: read the docs, do not rely on this file

[`docs/architecture.md`](docs/architecture.md) is the master guide: the big picture, the
complete file map, request flow, data layer, auth, and environment variables. Read it
before changing anything. This table routes you to the doc that owns the area you are
touching.

| Touching | Read |
| --- | --- |
| Anything, first time in a session | [`docs/architecture.md`](docs/architecture.md) |
| Why a guard or a cautious-looking behavior exists | [`docs/decisions.md`](docs/decisions.md) |
| A watch that looks wrong, or an episode that will not match | [`docs/troubleshooting.md`](docs/troubleshooting.md) |
| Webhook parsing, phases, auth | [`docs/webhooks.md`](docs/webhooks.md) |
| Scheduler, catch-up polling, manual dispatch queue | [`docs/scheduled-sync.md`](docs/scheduled-sync.md) |
| Plex / Emby / Jellyfin clients | [`docs/plex.md`](docs/plex.md), [`docs/emby.md`](docs/emby.md), [`docs/jellyfin.md`](docs/jellyfin.md) |
| TMDB / TVDB / Fanart / OMDb | [`docs/metadata.md`](docs/metadata.md) |
| Posters, backdrops, the image cache | [`docs/posters-artwork.md`](docs/posters-artwork.md) |
| SQLite tables, columns, migrations | [`docs/sqlite-schema.md`](docs/sqlite-schema.md) |
| SPA routing, state, module layout | [`docs/frontend.md`](docs/frontend.md) |
| Login, sessions, API key, webhook secret | [`docs/auth.md`](docs/auth.md) |
| Backups and restore | [`docs/backups.md`](docs/backups.md) |
| Build checks, git hooks, CI, Docker, releases | [`docs/development.md`](docs/development.md) |

Three things are worth knowing before you open any of them:

- **One process, one SQLite file.** The default `ROLE=all` process serves the UI, the
  `/api/*` surface, and the per-minute scheduler against `data/plembfin.db`. There is no
  cloud function, no external database, and no separate production environment.
- **`dispatch()` in `server/src/index.js` is the whole route table.** Handlers live in
  the owning `server/src/routes/*.js` module, never in `index.js`.
- **Derived caches are memoized against a shared data version.** `bumpDataVersion()` in
  `server/src/db.js` is what makes every process reload; forgetting it is why a change
  can look like it did not take effect.
