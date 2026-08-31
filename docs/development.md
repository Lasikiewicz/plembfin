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

- **"Push to git"** runs `scripts/rebuild-develop-changelog.js` locally (recomputes
  `changelog.develop.json`'s single entry from git history since its `resetCommit`
  anchor), commits, and pushes to `develop`; the pre-push hook independently verifies
  that the committed changelog covers every user-facing commit before allowing the
  push. `docker-publish-develop.yml` checks README
  consistency, then builds, verifies, and publishes a rolling image to
  `ghcr.io/lasikiewicz/plembfin:develop` (also tagged `develop-<build>`) using the build
  number already in the pushed commit. `develop` never touches
  `changelog.json`/`changelog.alpha.json` or the package version. Its build counter is
  never inferred from a comparison against a parent branch's version - it only resets
  (specifically its `resetCommit` anchor and `entries`, not `build` itself) when a
  "Force to alpha" promotion explicitly does so, so it can never appear to regress.
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
- **"Force to main"** checks out `alpha`'s actual tip locally, runs
  `scripts/promote-alpha-to-main.js` (consolidates every alpha build entry accumulated
  this cycle into one clean release entry - bumps the real semver, writes
  `changelog.json`/`package.json`/`package-lock.json`/`CHANGELOG.md`, and resets alpha
  and develop for the next cycle), commits, then force-pushes that commit to `main`
  (`git push origin HEAD:main --force`), which triggers the release pipeline below. A
  first pre-push test failure follows the bounded retry procedure above instead of
  bypassing the gate or prematurely ending the promotion.
- After the release pipeline publishes from that commit, both `alpha` and `develop` merge
  `origin/main` back in and push, so the next round of work starts from a matching base
  instead of immediately diverging.

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
node scripts/promote-alpha-to-main.js && git add changelog.json changelog.alpha.json changelog.develop.json CHANGELOG.md package.json package-lock.json && git commit -m "chore: promote alpha to main"
git log origin/main..HEAD --oneline
git push origin HEAD:main --force

# Update local develop to the new main version (local only - do not push)
git checkout develop
git merge --ff-only origin/develop
git merge origin/main --no-edit
```

The alpha workflow reads the alpha build metadata already committed and publishes
`:alpha` plus an `alpha-<build>` tag. The main workflow reads the version already
committed and publishes `:latest` plus the version tag. After that commit lands, merging
`origin/main` into local `develop` is optional and local-only (not pushed) - see CLAUDE.md's
"Force to main" step 4 for why it isn't required for correctness.

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
   as a garbled duplicate. Folds every build's headline into one sentence, in the order
   the builds happened, with `synthesizeHeadline()` (`scripts/changelog-message.js`).
   Bumps the real semver - the patch segment, honouring a manually-set higher
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
