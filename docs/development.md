# Development, CI & Release Pipeline

How to run, check, ship, and release the app: npm scripts, the build check, git hooks,
GitHub Actions, Docker, and the changelog/versioning machinery.

## Local development

```bash
npm install       # prebuilt binaries for better-sqlite3 + sharp; also installs git hooks (prepare)
npm start         # serve UI + API + scheduler on http://localhost:5055
npm run dev       # same, with --watch auto-reload
npm test          # focused node:test suite for parser/sync/key behavior
npm run test:multiprocess # real isolated web/worker replica test
npm run docs:check # verify README setup guidance matches package/runtime requirements
npm run build     # syntax check + npm test + server boot gate
npm run seed:demo # insert fictional demo movies/shows with generated posters
```

### Windows provider-backed server launches

`npm start` is still the canonical application command. When the server is started by
Codex on Windows, the command must run through the approved elevated network-enabled
execution path; do not launch it from the restricted sandbox. The restricted sandbox
can allow the UI/API to listen on port `5055` while denying outbound connections to
Plex, Emby, Jellyfin, Trakt, TMDB, or TVDB with `EACCES`.

This is an execution-environment requirement, not a second app mode: an ordinary
PowerShell window on the host can continue to use `npm start` or `npm run dev` directly.
After an agent start, verify both the local health endpoint and the network bind:

```powershell
Invoke-WebRequest http://127.0.0.1:5055/api/ping
netstat -ano -p tcp | Select-String ':5055\s+.*LISTENING'
```

There is no separate linter configured. A local `.env` at the repo root is loaded by
`server/src/env.js` (existing env vars win). Data lands in `<repo>/data/` (override
with `DATA_DIR`).

When implementation work completes an item in [`TODO.md`](../TODO.md), remove it in
the same change and refresh the relevant documentation and README section if the
completed work changes user-visible behavior.

## The build check (`scripts/build-check.js`)

`npm run build` is the gate used by the pre-push hook and every CI job. It:

1. runs `node --check` over every `.js` file in `public/`, `server/`, `scripts/`
2. runs the `node:test` suite (the same tests exposed by `npm test`)
3. runs `scripts/docs-check.js` to keep the README's Node.js and password setup guidance
   aligned with the enforced package/runtime configuration
4. parses `package.json`, `package-lock.json`, `changelog.json`
5. verifies every routed API handler is either intentionally public or calls
   `requireAdmin`, `resolveAdminPrincipal`, or `verifyWebhookToken`
6. **rejects any bare `fetch(` outside `server/src/utils/outbound.js`** - outbound
   calls must use `fetchWithTimeout`, which enforces timeouts and validates both
   initial and redirected URLs
7. boots the real server once against a temp `DATA_DIR` with
   `PLEMBFIN_BUILD_CHECK=1` (the server exits immediately after `listening`)

## Git hooks

`npm install` runs `scripts/install-git-hooks.js` (via the `prepare` script), which
points `core.hooksPath` at `.githooks/`. The `.githooks/commit-msg` hook rejects
user-visible release commits whose body has no meaningful changelog bullet (a repeat
of the subject does not count). The `.githooks/pre-push` hook reads the actual push
refspec from stdin: for a same-name push (e.g. `alpha` → `alpha`) it runs
`git pull --no-rebase origin <branch>` first; for every push to `develop` it then
validates the changelog in the exact commit being pushed with
`node scripts/rebuild-develop-changelog.js --check`; finally it runs `npm run build`.
A stale or missing develop changelog blocks the push and prints the local rebuild
command. A cross-ref push (e.g. the alpha-onto-main force-push in "Force to main")
skips the sync step entirely, since that content has already been deliberately
reconciled by hand. The sync merges rather than rebases deliberately - `alpha`'s
history routinely contains a real merge commit folding a release commit back in from
`main`, and `--rebase` walks full ancestry rather than just the first-parent chain, so
it silently drops merge commits and replays both sides' commits individually instead
of leaving the already-resolved merge alone.

A failed pre-push test run leaves the remote branch unchanged. For the known transient
test-run failure, rerun `npm test` once. If it passes, retry the original push normally;
the hook runs the complete `npm run build` gate again and that full rerun must pass. If
the focused rerun or the second full gate fails, treat it as repeatable and investigate
it. Do not use `--no-verify` to promote any branch.

## Branching model (`develop` → `alpha` → `main`)

Day-to-day work lands on `develop`. `alpha` only moves when `develop` is deliberately
promoted to it, and `main` only moves when `alpha` is deliberately promoted to it -
each promotion to `main` becomes exactly one release.

Changelog content for all three branches is computed **locally**, before each push, as
part of running the command itself - never by a CI job reading GitHub's push-event
commit list afterward. That payload is only reliable for a plain incremental push;
`alpha` and `main` are always reached by a force-push, for which it's empty or
incomplete. See [`architecture.md`](architecture.md#changelog--update-check) for the
full generation/rendering detail; the summary here is what each publish workflow itself
does, which in every case is now just "verify, then build and publish the image using
values already committed" - none of them write anything back to their branch.

- **"Push all to git"** includes every relevant local worktree change and every pending
  local `develop` commit, rebuilds `changelog.develop.json` from its `resetCommit`
  anchor, consolidates the pending work into one commit, and pushes it to `develop`.
  **"Push to git"** uses the same changelog/build workflow but scopes staging and
  committing to work created in the current chat only. The agent records the chat's
  baseline first, leaves pre-existing edits and commits untouched, and stops for
  clarification if changes are mixed or older local commits are already ahead of
  `origin/develop`; it never uses `git add .` for this narrow-scope command. In both
  cases, the pre-push hook independently verifies that the committed changelog covers
  every user-facing commit before allowing the push. `docker-publish-develop.yml` checks README
  consistency, then builds, verifies, and publishes a rolling image to
  `ghcr.io/lasikiewicz/plembfin:develop` (also tagged `develop-<build>`) using the build
  number already in the pushed commit. `develop` carries the current main release in
  `changelog.develop.json` and starts each release cycle at build 1. Its build counter
  increments when a rebuild finds user-facing work; "Force to alpha" clears the current
  entry and anchor while carrying the version/build, and "Force to main" resets the
version to the released semver and the build to 1. The sidebar and About
  show this as `<version> Build <n>`.
  **`develop` is covered by `secret-scan.yml`** (while `security.yml` runs on `main` and
  `alpha` alongside scheduled scans).
- **"Force to alpha"** runs `scripts/promote-develop-to-alpha.js` locally (packages
  develop's current entry as its own standalone alpha build entry, prepended to alpha's
  `entries` array - one entry per "Force to alpha" call, not a rolling merge - self-healing
  to a fresh `baseVersion`/build 1/empty `entries` whenever `main`'s version has moved on
  since the last alpha build, and resets develop for the next cycle), commits, then
  force-pushes `develop`'s state onto `alpha` (`git push origin HEAD:alpha --force`; merge
  `origin/main` into `develop` first if it has moved on). The alpha publish workflow
  checks README consistency before building and publishing. This is where
  secret/vulnerability scanning first applies. `docker-publish-alpha.yml` builds,
  verifies, and publishes to `ghcr.io/lasikiewicz/plembfin:alpha` (also tagged
  `alpha-<build>`) using the build number already in the pushed commit, then posts that
  one build's own changelog entry to Discord (see "Discord release notifications"
  below). Afterward, push develop's own reset state to `origin/develop` too (a plain
  push, not a force-push) - that push only ever changes
  `changelog.develop.json`/`changelog.alpha.json`, so `docker-publish-develop.yml`'s
  `paths-ignore` skips rebuilding and republishing a develop image over it; the point is
  getting the correct file onto `origin/develop` for the app's own live remote-fetch
  changelog comparison (`fetchRemoteDevelopChangelog` in `routes/maintenance.js`), not a
  new image. `secret-scan.yml` still runs regardless of which files changed.
- **"Force to main"** first runs the mandatory website update gate against the current
  development checkout so the tracked Astro documentation and captures cover the latest
  application changes. It then checks out `alpha`'s actual tip locally, writes a concise,
  single-line `releaseMessage` to `changelog.alpha.json`, then runs
  `scripts/promote-alpha-to-main.js --preview` so the would-be release entry can be
  shown to the user and confirmed. Only after approval does the operator run
  `scripts/promote-alpha-to-main.js --confirm` (consolidates every alpha build entry
  accumulated this cycle into one clean release entry - bumps the real semver, writes
  `changelog.json`/`package.json`/`package-lock.json`/`CHANGELOG.md`, resets alpha, and
  resets develop to the released version at build 1 for the next cycle), commit, and
  force-push that commit to `main`
  (`git push origin HEAD:main --force`), which triggers the release pipeline below. A
  first pre-push test failure follows the bounded retry procedure above instead of
  bypassing the gate or prematurely ending the promotion. The promotion command
  refuses to mutate anything without `--confirm`.
- After the release pipeline publishes from that commit, the procedure merges
  `origin/main` into `develop` and pushes the synchronized state to `origin/develop`.
  The next "Force to alpha" therefore starts with `main` already represented in remote
  `develop`; its merge step remains as a repair path for an older or interrupted release.

### Promotion commands

Use the following refspecs for the supported branch promotions. Review the commit range
before each force-push and wait for the corresponding GitHub Actions workflow to finish.
See CLAUDE.md's "Push to git" / "Force to alpha" / "Force to main" sections for the full
step-by-step, including the local changelog-generation step each one runs first.

```bash
# Push work to develop
node scripts/rebuild-develop-changelog.js && git add changelog.develop.json && git commit -m "chore: rebuild develop changelog"
git push origin develop

# Promote develop to alpha
git fetch origin
git checkout develop
git merge --ff-only origin/develop
git merge origin/main --no-edit
node scripts/promote-develop-to-alpha.js && git add changelog.alpha.json changelog.develop.json && git commit -m "chore: promote develop changelog to alpha"
git log origin/alpha..HEAD --oneline
git push origin HEAD:alpha --force
git push origin develop

# Promote alpha to main
git fetch origin
git checkout -B alpha origin/alpha
node scripts/promote-alpha-to-main.js --preview   # show the concise release changelog and get user approval before continuing
node scripts/promote-alpha-to-main.js --confirm && git add changelog.json changelog.alpha.json changelog.develop.json CHANGELOG.md package.json package-lock.json && git commit -m "chore: promote alpha to main"
git log origin/main..HEAD --oneline
git push origin HEAD:main --force

# Synchronize develop to the new main version
git checkout develop
git merge --ff-only origin/develop
git merge origin/main --no-edit
git push origin develop
```

The alpha workflow reads the alpha build metadata already committed and publishes
`:alpha` plus an `alpha-<build>` tag. The main workflow reads the version already
committed and publishes `:latest` plus the version tag. After that commit lands, the
"Force to main" procedure publishes its merge into `origin/develop` so the branch graph
is reconciled before the next alpha promotion. It does not sync `alpha` separately.

## Release pipeline (push to `main`)

Building the release itself happens locally, as part of "Force to main" (see
[CLAUDE.md](../CLAUDE.md) and the "Promotion commands" above) - `promoteAlphaToMain()`
in `scripts/promote-alpha-to-main.js`, run before the force-push:

1. Consolidates every alpha build entry accumulated since the last release - each one
   already has a clean headline and bullet-point `details` from when
   `scripts/promote-develop-to-alpha.js` built it, since that already happened locally on
   `develop` (`scripts/rebuild-develop-changelog.js`) and `alpha` - so there is nothing
   left to backfill from individual commits at this point, only multiple builds' worth of
   already-clean entries to fold into one.
2. Merges each entry's own `entry.sections` directly (`mergeSections`, exported from
   `promote-develop-to-alpha.js`) rather than re-running `categorizeEntries()` over the
   entries themselves - an entry's `message` is a synthesized cross-commit headline
   sentence, not a commit-message bullet, and re-categorizing it would land it in tweaks
   as a garbled duplicate. Uses the reviewed, single-line `releaseMessage` from
   `changelog.alpha.json` as the Main headline instead of concatenating every alpha
   build headline. The command refuses to mutate without `--confirm` after the preview
   has been approved. Bumps the real semver - the patch segment, honouring a manually-set higher
   `package.json` version instead (a deliberate major/minor bump). `public/app.js` and
   `generate-changelog-md.js` render `entry.sections` -
   `newFeatures`/`majorBugFixes`/`tweaks` - as separate "New Features" / "Major Bug
   Fixes" / "Tweaks" headed groups in Settings → Changelog and `CHANGELOG.md` whenever
   any section is populated, falling back to the flat `entry.details` list otherwise.
3. Runs the same release-content check (`changelogEntryProcessViolations` in
   `scripts/changelog-message.js`) the alpha promotion already ran, and throws instead
   of writing the entry if any recognized release-process text survives (changelog
   consolidation, folded-in or trimmed bullets, branch build-counter resets, and
   similar) - it cannot tell a bullet inside an otherwise legitimate `feat`/`fix` commit
   apart from one that just narrates an investigation with no resulting product change
   (e.g. "diagnosed a report of X; turned out to be a stale session, no code change
   needed"); avoid writing that kind of bullet in a release commit's body in the first
   place, or keep it as unbulleted prose so `bulletPointsFrom` skips it. A release built
   from many small iterative alpha commits (a feature added, then throttled, then
   disabled, then re-enabled within the same day) can still read as noisy because the
   generator cannot infer which product bullet supersedes another; consolidate those
   product bullets on `develop` before promotion rather than fixing it up after.
4. Writes `changelog.json` + `package.json` + `package-lock.json` + regenerates
   `CHANGELOG.md`, and resets `changelog.alpha.json`/`changelog.develop.json` for the
   next cycle - all committed locally as one commit, force-pushed straight to `main`.

`.github/workflows/update-changelog.yml` (workflow name "Publish Main Release") then
runs on the push to `main` - in practice this means every "Force to main" run, not every
individual commit - reads the version already committed, runs the full build gate again
in CI, builds and pushes the Docker image to GHCR tagged `latest` + the version, then
posts the `changelog.json` entry to Discord via `scripts/notify-discord-release.js main`
(see "Discord release notifications" below). It does not write anything back to `main`.
`docker-publish.yml` is a manual (`workflow_dispatch`) image build that skips the
changelog step.

Pushes to `main` and `alpha` trigger `.github/workflows/windows-installer.yml`. That job
runs on a Windows runner, installs and probes the Windows builds of `better-sqlite3` and
`sharp`, stages the self-contained Node runtime plus the optional notification-area
companion, compiles the Inno Setup installer, and uploads a checksum alongside it.
Release-channel installers built from `main` are attached to a `v<version>` GitHub
Release; alpha installers and manual builds remain available as Actions artifacts. The
workflow also supports manual builds for any of the three channels. Configure
`WINDOWS_SIGNING_CERTIFICATE_BASE64` and `WINDOWS_SIGNING_CERTIFICATE_PASSWORD` as
repository secrets to sign the installer; signing is skipped, without failing the
build, when those secrets are absent.
The force-push events used by the promotion procedures are mapped explicitly: `Force to
alpha` builds the alpha manifest/build from `alpha`, and `Force to main` builds the
release manifest/version from `main`. Manual runs default to following the selected
branch (`auto`) unless an explicit channel is chosen.

The in-app update check compares the bundled `changelog.json` against the published one
on GitHub - see the changelog section of [architecture.md](architecture.md).

### Discord release notifications

Both `update-changelog.yml` (main) and `docker-publish-alpha.yml` (alpha) end with a
"Notify Discord releases channel" step that runs
`node scripts/notify-discord-release.js <main|alpha>`. The script reads the changelog
file already committed by the local promotion step (`changelog.json`'s `entries[0]` for
main, `changelog.alpha.json`'s `entries[0]` for alpha), builds a Discord embed from it,
and posts it to the webhook URL in the `DISCORD_RELEASES_WEBHOOK` repository secret. If
that secret is unset the script logs a message and exits `0` - it never fails the
build, so forks and clones without the secret configured are unaffected. Run it locally
with a trailing `--dry-run` to print the embed JSON instead of posting it, useful for
checking formatting without a webhook. The webhook itself is configured on the Discord
side (Server Settings → the target channel → Integrations → Webhooks); paste its URL
into the GitHub repository secret to wire it up, or omit the secret to leave the
channel silent.

### Reddit release announcements

r/plembfin gets release announcements too, but not via this repo's CI - Reddit's Data
API now requires manual review to grant script-app access, and that path was declined
for this use case with a recommendation to build on Reddit's own Devvit platform
instead, which has no mechanism for an external system to push a trigger in. Instead,
[`reddit-app/`](../reddit-app) is a separate Devvit app, installed only in r/plembfin,
that polls this repo's public `changelog.json` on a schedule and posts + pins an
announcement when a new release appears (un-pinning whichever post it pinned before).
It has its own build/deploy tooling independent of this repo's CI - see
[`reddit-app/README.md`](../reddit-app/README.md).

## Other CI

| Workflow | What it does |
| --- | --- |
| `security.yml` | `npm audit --audit-level=high` + CodeQL, on push to `main`/`alpha`, PRs targeting `main`, and daily. CodeQL loads `.github/codeql/codeql-config.yml`, which excludes the `js/request-forgery` query repo-wide - every outbound request funnels through the centralized, validated fetch guard in `server/src/utils/outbound.js`, and admin-configured LAN media server URLs make that query permanently false-positive for this app |
| `secret-scan.yml` | TruffleHog verified-secret scan on push to `main`/`alpha`/`develop` and PRs targeting `main`/`develop` |
| `docker-build-check.yml` | Checks README consistency, then builds the image on every PR targeting `main`, without pushing anything, and runs `better-sqlite3` and `sharp` inside it, so a broken Dockerfile or dependency install is caught before a PR merges. The runtime probe matters because production dependencies install with `--ignore-scripts`: a native module with no usable binary for the platform still builds cleanly and would fail on first database open |
| `docker-publish-alpha.yml` | On every push to `alpha`: checks README consistency, builds the image, runs the same native-module probe as `docker-build-check.yml`, then pushes it to `ghcr.io/lasikiewicz/plembfin:alpha` and `ghcr.io/lasikiewicz/plembfin:alpha-<build>` (reading the build number already committed by "Force to alpha"), and posts the changelog entry to Discord (see "Discord release notifications"). Never writes anything back to `alpha`; never touches `changelog.json`, the package version, or the `:latest` tag |
| `windows-installer.yml` | On every push to `main` or `alpha` (and on manual dispatch), builds the x64 Windows installer on a Windows runner, probes native modules, packages the Node server as a Windows service with an opt-in notification-area companion, uploads a checksum, and publishes main installers to GitHub Releases plus alpha installers to numbered GitHub prereleases |
| `ghcr-cleanup.yml` | Weekly (and on manual dispatch): prunes numbered `develop-<n>`/`alpha-<n>` tags beyond the newest 15 of each, and deletes untagged images older than a day left behind whenever a mutable tag (`latest`/`develop`/`alpha`) moves to a new manifest. Never touches those mutable tags or a semantic-version release tag |
| `dependabot.yml` | Dependency update PRs |

## Docker

- **`Dockerfile`** - `node:22-slim`, production deps only, non-root `plembfin` user
  (uid 1000), `VOLUME /data`, healthcheck against `/api/ping`, entrypoint
  (`scripts/docker-entrypoint.sh`) chowns `/data` and drops privileges via gosu when
  started as root. Dependencies install with `npm ci --omit=dev --ignore-scripts`:
  better-sqlite3 ships a `binding.gyp`, and npm runs `node-gyp rebuild` for any package
  that has one, which needs a Python and compiler toolchain the image does not carry.
  Skipping install scripts leaves the prebuilt binary that already ships in the package
  for this platform, which is the binary its loader prefers. better-sqlite3 is the only
  production dependency with an install script.
- **`docker-compose.yml`** - base setup: port 5055, `./data:/data`, admin env vars,
  `no-new-privileges`, cpu/memory limits.
- **`docker-compose.split.yml`** - optional same-host overlay that runs one
  `ROLE=web` service and one HTTP-less `ROLE=worker` service on the same local data
  volume: `docker compose -f docker-compose.yml -f docker-compose.split.yml up -d`.
- **`docker-compose.secure.yml`** - hardened overlay (read-only rootfs, tmpfs `/tmp`,
  required secrets, forced `COOKIE_SECURE`); usage in
  [hardening.md](hardening.md).
- **`.dockerignore`** - keeps `data/`, `docs/`, markdown, and scratch files out of the
  image; whitelists only the install, entrypoint, and worker-health scripts the image needs.

## One-shot operational scripts

| Script | Purpose |
| --- | --- |
| `scripts/exportPlexHistory.js` | Import a Plex server's watch history into Plembfin via `/api/import` (env: `PLEX_URL`, `PLEX_TOKEN`, `API_KEY`) |
| `scripts/forcePushHistory.js` | Replay Plembfin's `/api/history` against Plex/Emby/Jellyfin as mark-played calls (env: all three platforms' credentials + `API_KEY`) |
| `scripts/seed-demo-content.js` | Seed fictional demo content for screenshots/dev |
| `scripts/generate-synthetic-library.js` | Build a disposable library at a stated scale for performance measurement: `node scripts/generate-synthetic-library.js --data-dir <path> [--movies 3000] [--shows 400] [--episodes-per-show 24] [--history-rows N] [--tmdb-entries N] [--tmdb-blob-kb 24] [--posters 8] [--seed 1]`. Refuses the repository's own `data/` directory and any directory holding a database it did not create. |
| `scripts/benchmark-surfaces.js` | Record the server-side surface baseline against a generated library: `node scripts/benchmark-surfaces.js --data-dir <path> [--runs 5] [--output docs/benchmarks/<file>.json]` |
| `npm run assets:update` | Restamp every local `public/` asset reference with the current build's version. Both promotion scripts run it automatically; run it by hand after editing frontend files locally, since versioned assets are cached immutably and the browser will otherwise keep the previous copy |

## Performance measurement

Two debug env flags produce numbers without a profiler, in the same style as
`PLEMBFIN_DEBUG_OUTBOUND`. Both log through the diagnostic logger, so their output is
visible in Settings → Logs as well as the console.

- `PLEMBFIN_DEBUG_CACHE_REBUILDS=1` logs one line per derived-cache rebuild: which cache,
  the generation it rebuilt for, the labelled caller that advanced that generation, and
  how long the rebuild took. Counting invalidations alone cannot tell an expensive one
  from a free one, because a bump only costs something when a cache it invalidated is
  then read.
- `PLEMBFIN_DEBUG_SCHEDULER=1` logs each scheduler step's name, its start offset within
  the tick, its duration, and whether it exhausted its time budget, plus a per-tick
  summary carrying the achieved interval between tick starts.

The counters behind both are collected whether or not the flag is set; the flag only
controls logging. They cost one timestamp pair per rebuild or per step, never per row.

Repeatable benchmarks live in `docs/benchmarks/`, which is committed so a result travels
with the workload that produced it. `scripts/benchmark-surfaces.js` records the
server-side surfaces against a library from `scripts/generate-synthetic-library.js`; see
[`capacity.md`](capacity.md) for the two commands and the one scale limit worth knowing
before reading a result. Frontend first-paint timing is a manual browser protocol and is
deliberately not scripted here.

## Asset versions track the build

Public assets are referenced at a canonical `?v=<version>` query and served with a one-year
immutable cache, so that query has to change whenever the files do.

The version is **the alpha build's version while a cycle is open** (`0.15.0.4`), and the
package version once a release to main resets alpha (`0.15.1`). `scripts/asset-versions.js`
derives it, and both `promote-develop-to-alpha.js` and `promote-alpha-to-main.js` restamp
every reference while promoting, so each published build serves its own asset URLs.

Before this, every alpha build in a cycle shared one asset version: a tester who pulled a new
image could still be running the previous build's JavaScript, and the same caught local
development after editing a module. If you edit frontend files and the browser does not pick
them up, run `npm run assets:update`.

Tests must not assert a specific asset version for this reason - assert that a URL is
versioned, not which version it carries today.

The checker reads references two ways, because a URL built at runtime is not a literal. The
first pass matches a complete quoted reference such as `"/modules/utils.js?v=0.15.0.5"`. The
second reads the version query on its own, wherever it sits on a managed `/icons/`,
`/modules/`, `/app.js` or `/styles.css` path, so an assembled URL like
`` `/icons/${target}.svg?v=0.15.0.5` `` is checked and restamped as well. Both passes run in
`npm run assets:check` and in `--write`. A reference the first pass cannot see is exactly how
a hardcoded token once survived several releases while the browser fetched the same icon
under two different URLs.

## Conventions that CI enforces or assumes

- Commit messages follow `type: summary` with `- ` bullet bodies. The commit hook and
  the local changelog scripts (`rebuild-develop-changelog.js`,
  `promote-develop-to-alpha.js`, `promote-alpha-to-main.js`) reject user-visible release
  messages with missing or title-repeating details. Release-process notes such as
  changelog consolidation and branch build-counter resets are filtered from every
  branch's entry and rejected by the same scripts' release-content check.
- The version in `package.json`/`changelog.json` is set locally by
  `scripts/promote-alpha-to-main.js` as part of "Force to main"; only set it manually
  for a deliberate major/minor bump.
- `data/` is never committed and never in the image; all state must live under
  `DATA_DIR`.
