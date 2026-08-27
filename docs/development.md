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
`git pull --no-rebase origin <branch>` first, then always runs `npm run build`. A
cross-ref push (e.g. the alpha-onto-main force-push in "Merge alpha with main") skips
the sync step entirely, since that content has already been deliberately reconciled by
hand. The sync merges rather than rebases deliberately - `alpha`'s history routinely
contains a real merge commit folding a changelog-bump commit back in from `main`, and
`--rebase` walks full ancestry rather than just the first-parent chain, so it silently
drops merge commits and replays both sides' commits individually instead of leaving the
already-resolved merge alone.

A failed pre-push test run leaves the remote branch unchanged. For the known transient
test-run failure, rerun `npm test` once. If it passes, retry the original push normally;
the hook runs the complete `npm run build` gate again and that full rerun must pass. If
the focused rerun or the second full gate fails, treat it as repeatable and investigate
it. Do not use `--no-verify` to promote any branch.

## Branching model (`develop` → `alpha` → `main`)

Day-to-day work lands on `develop`. `alpha` only moves when `develop` is deliberately
promoted to it, and `main` only moves when `alpha` is deliberately promoted to it -
each promotion to `main` becomes exactly one release.

- **"Push to git"** commits and pushes to `develop`. `docker-publish-develop.yml`
  checks README consistency, then builds, verifies, and publishes a rolling image to `ghcr.io/lasikiewicz/plembfin:develop`
  (also tagged `develop-<build>`) on every push. `develop` never touches
  `changelog.json`/`changelog.alpha.json` or the package version. It bumps its own
  standalone `changelog.develop.json` build counter via `scripts/update-develop-changelog.js`,
  committed back as `chore: bump develop build for <sha>`. Unlike alpha's counter, this
  one is never inferred from a comparison against a parent branch's version - it only
  resets when a "Force to alpha" promotion explicitly zeroes it, so it can never appear
  to regress. **`develop` is covered by `secret-scan.yml`** (while `security.yml` runs on
  `main` and `alpha` alongside scheduled scans).
- **"Force to alpha"** force-pushes `develop`'s current state onto `alpha`
  (`git push origin HEAD:alpha --force`; merge `origin/main` into `develop` first if
  it has moved on, to avoid clobbering a pending main changelog commit). The alpha
  publish workflow checks README consistency before building and publishing. This is where
  secret/vulnerability scanning first applies. `docker-publish-alpha.yml` then builds,
  verifies, and publishes to `ghcr.io/lasikiewicz/plembfin:alpha` (also tagged
  `alpha-<build>`), bumping `changelog.alpha.json`'s build counter via
  `scripts/update-alpha-changelog.js` - self-healing to a fresh `baseVersion`/build 1
  whenever `main`'s version has moved on since the last alpha build. Afterward, sync
  alpha's fresh changelog back into `develop` and explicitly reset `develop`'s build
  counter to 0, so the next push to `develop` starts back at build 1. See
  [`architecture.md`](architecture.md#changelog--update-check) for how both surface in
  the UI. The workflow finishes by posting the new alpha build's changelog entry to
  Discord - see "Discord release notifications" below.
- **"Force to main"** pushes `alpha`'s actual tip (not `develop`) to `main`
  (`git push origin origin/alpha:main --force`), which triggers the release pipeline below.
  Every commit queued on `alpha` since the last release rides in on that one push, so
  the generated changelog entry combines the bullet points from all of them (see step 2
  below) rather than only the most recent commit. A first pre-push test failure follows
  the bounded retry procedure above instead of bypassing the gate or prematurely ending
  the promotion.
- After the release pipeline commits its changelog-bump commit back to `main`, both
  `alpha` and `develop` merge `origin/main` back in and push, so the next round of work
  starts from a matching base instead of immediately diverging.

### Promotion commands

Use the following refspecs for the supported branch promotions. Review the commit range
before each force-push and wait for the corresponding GitHub Actions workflow to finish.

```bash
# Push work to develop
git push origin develop

# Promote develop to alpha
git fetch origin
git checkout develop
git merge --ff-only origin/develop
git merge origin/main --no-edit
git log origin/alpha..HEAD --oneline
git push origin HEAD:alpha --force

# Promote alpha to main after alpha validation
git fetch origin
git log origin/main..origin/alpha --oneline
git push origin origin/alpha:main --force
```

The alpha workflow records the alpha build metadata and publishes `:alpha` plus an
`alpha-<build>` tag. The main workflow creates the release changelog/version commit and
publishes `:latest` plus the version tag. After that commit lands, merge `origin/main`
into both `alpha` and `develop` so all branches share the released base.

## Release pipeline (push to `main`)

`.github/workflows/update-changelog.yml` runs on every push to `main` - in practice
this means every "Merge alpha with main" run, not every individual commit:

1. build check
2. `scripts/update-changelog.js` bumps the patch version (honouring a manually-set
   higher `package.json` version) and appends a `changelog.json` entry - the entry's
   headline comes from the head commit's subject line (conventional-commit prefixes
   become labels: `feat:` → "Feature - …"), and its `details` are backfilled from the
   bullet points of every commit in the push, other than CI plumbing commits
   (`isNoiseCommitMessage` in `scripts/changelog-message.js`: the bot's own
   `chore: bump alpha build for …` / `chore: update changelog for …` commits and
   `Merge branch/commit/pull request …` commits) and commits whose own type isn't
   user-facing (`isReleaseTypeCommitMessage`: only `feat`, `fix`, `security`,
   `enhance`, `perf`, and `docs` commits contribute bullets - a `test:`, `chore:`,
   `refactor:`, `style:`, or `ci:` commit bundled into the same push never surfaces
   its own bullets, even when it isn't otherwise noise). Every commit's headline and
   bullets are also run through `categorizeEntries()` (shared with
   `promote-develop-to-alpha.js`) and stored as `entry.sections` -
   `newFeatures`/`majorBugFixes`/`tweaks`, keyed off each commit's conventional-commit
   type and per-line keywords. `public/app.js` and `generate-changelog-md.js` render
   `entry.sections` as separate "New Features" / "Major Bug Fixes" / "Tweaks" headed
   groups in Settings → Changelog and `CHANGELOG.md` whenever any section is populated,
   falling back to the flat `entry.details` list otherwise. When the head commit itself
   is a plumbing commit - routine for a "Merge alpha with main" force-push, since
   GitHub reports the range's last commit as the trigger - the headline falls back to
   the most recent real commit in the push instead of the plumbing commit's subject
   line. User-visible `feat`, `fix`, `security`, `enhance`, `perf`, and `docs`
   commits are rejected unless they contain at least one meaningful body bullet. If a
   maintenance or legacy commit has no body, the generator derives a user-facing
   summary from its changed file areas instead of publishing only a vague subject
   line. The type filter only screens out bullets from the *wrong kind* of commit -
   it can't tell a bullet inside an otherwise legitimate `feat`/`fix` commit apart
   from one that just narrates an investigation with no resulting product change
   (e.g. "diagnosed a report of X; turned out to be a stale session, no code
   change needed"); avoid writing that kind of bullet in a release commit's body in
   the first place, or keep it as unbulleted prose so `bulletPointsFrom` skips it. A
   release built from many small iterative alpha commits (a feature added, then
   throttled, then disabled, then re-enabled within the same day) can still read as
   noisy even with plumbing and non-release-type commits excluded, since the
   generator has no way to know a later commit supersedes an earlier one - that kind
   of entry may need a manual touch-up to `changelog.json` after the merge.
3. commits `changelog.json` + `package.json` + `package-lock.json` back to `main` as
   `chore: update changelog for <sha>` - the "Merge alpha with main" workflow folds
   this bump commit back into `alpha` afterward (see the "Merge alpha with main"
   branch synchronization step above)

4. builds and pushes the Docker image to GHCR tagged `latest` + the new version, then
   posts the new `changelog.json` entry to Discord via `scripts/notify-discord-release.js main`
   (see "Discord release notifications" below) - all in the same job, against the
   working tree that was just committed. This has to happen in the same job: a commit
   pushed with the default `GITHUB_TOKEN` never triggers another workflow run (GitHub's
   own recursion guard against infinite loops), so a separate job gated on that commit
   arriving as a fresh trigger would never actually run.
`docker-publish.yml` is a manual (`workflow_dispatch`) image build that skips the
changelog step.

The in-app update check compares the bundled `changelog.json` against the published one
on GitHub - see the changelog section of [architecture.md](architecture.md).

### Discord release notifications

Both `update-changelog.yml` (main) and `docker-publish-alpha.yml` (alpha) end with a
"Notify Discord releases channel" step that runs
`node scripts/notify-discord-release.js <main|alpha>`. The script reads the changelog
file that step just wrote (`changelog.json`'s `entries[0]` for main,
`changelog.alpha.json`'s `entries[0]` for alpha), builds a Discord embed from it, and
posts it to the webhook URL in the `DISCORD_RELEASES_WEBHOOK` repository secret. If
that secret is unset the script logs a message and exits `0` - it never fails the
build, so forks and clones without the secret configured are unaffected. Run it locally
with a trailing `--dry-run` to print the embed JSON instead of posting it, useful for
checking formatting without a webhook. The webhook itself is configured on the Discord
side (Server Settings → the target channel → Integrations → Webhooks); paste its URL
into the GitHub repository secret to wire it up, or omit the secret to leave the
channel silent.

## Other CI

| Workflow | What it does |
| --- | --- |
| `security.yml` | `npm audit --audit-level=high` + CodeQL, on push to `main`/`alpha`, PRs targeting `main`, and daily. CodeQL loads `.github/codeql/codeql-config.yml`, which excludes the `js/request-forgery` query repo-wide - every outbound request funnels through the centralized, validated fetch guard in `server/src/utils/outbound.js`, and admin-configured LAN media server URLs make that query permanently false-positive for this app |
| `secret-scan.yml` | TruffleHog verified-secret scan on push to `main`/`alpha`/`develop` and PRs targeting `main`/`develop` |
| `docker-build-check.yml` | Checks README consistency, then builds the image on every PR targeting `main`, without pushing anything, and runs `better-sqlite3` and `sharp` inside it, so a broken Dockerfile or dependency install is caught before a PR merges. The runtime probe matters because production dependencies install with `--ignore-scripts`: a native module with no usable binary for the platform still builds cleanly and would fail on first database open |
| `docker-publish-alpha.yml` | On every push to `alpha`: checks README consistency, bumps `changelog.alpha.json`'s build counter and commits it back to `alpha`, builds the image, runs the same native-module probe as `docker-build-check.yml`, then pushes it to `ghcr.io/lasikiewicz/plembfin:alpha` and `ghcr.io/lasikiewicz/plembfin:alpha-<build>`, and posts the new build's changelog entry to Discord (see "Discord release notifications"). Never touches `changelog.json`, the package version, or the `:latest` tag |
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
  changelog generator reject user-visible release messages with missing or
  title-repeating details.
- The version in `package.json`/`changelog.json` is CI-managed; only set it manually
  for a deliberate major/minor bump.
- `data/` is never committed and never in the image; all state must live under
  `DATA_DIR`.
