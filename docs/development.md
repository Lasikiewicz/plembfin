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
3. parses `package.json`, `package-lock.json`, `changelog.json`
4. verifies every routed API handler is either intentionally public or calls
   `requireAdmin`, `resolveAdminPrincipal`, or `verifyWebhookToken`
5. **rejects any bare `fetch(` outside `server/src/utils/outbound.js`** - outbound
   calls must use `fetchWithTimeout`, which enforces timeouts and validates both
   initial and redirected URLs
6. boots the real server once against a temp `DATA_DIR` with
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

## Branching model (`alpha` → `main`)

Day-to-day work lands on `alpha`, not `main`. `main` only moves when work is
deliberately promoted, and every promotion becomes exactly one release.

- The "Push to git" agent workflow commits and pushes to `alpha`. `alpha` gets the
  same `secret-scan.yml` and `security.yml` coverage as `main` (see the table below),
  so a broken dependency or a leaked secret surfaces immediately. `docker-publish-alpha.yml`
  builds, verifies, and publishes a rolling pre-release image to
  `ghcr.io/lasikiewicz/plembfin:alpha` (also tagged `alpha-<build>`) on every push - but
  `alpha` never touches `changelog.json` or the package version, and never updates the
  `:latest` tag. It does bump a separate `changelog.alpha.json` build counter via
  `scripts/update-alpha-changelog.js`, committed back to `alpha` as
  `chore: bump alpha build for <sha>`; that counter resets on the next "Merge alpha with
  main". See [`architecture.md`](architecture.md#changelog--update-check) for how this
  surfaces in the UI.
- The "Merge alpha with main" agent workflow force-pushes `alpha`'s current state onto
  `main` (`git push origin alpha:main --force`), which triggers the release pipeline
  below. Every commit that was queued on `alpha` rides in on that one push, so the
  generated changelog entry combines the bullet points from all of them (see step 2
  below) rather than only the most recent commit.
- After the release pipeline commits its changelog-bump commit back to `main`, `alpha`
  is fast-forwarded onto the new `main` so the next round of work starts from a
  matching base instead of immediately diverging.

Full step-by-step commands for both workflows live in [`../CLAUDE.md`](../CLAUDE.md).

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
   `Merge branch/commit/pull request …` commits), which carry no user-visible content
   of their own. When the head commit itself is one of those - routine for a
   "Merge alpha with main" force-push, since GitHub reports the range's last commit as
   the trigger - the headline falls back to the most recent real commit in the push
   instead of the plumbing commit's subject line. User-visible `feat`, `fix`,
   `security`, `enhance`, `perf`, and `docs` commits are rejected unless they
   contain at least one meaningful body bullet. If a maintenance or legacy commit
   has no body, the generator derives a user-facing summary from its changed file
   areas instead of publishing only a vague subject line. A release built from many
   small iterative alpha commits (a feature added, then throttled, then disabled,
   then re-enabled within the same day) can still read as noisy even with plumbing
   commits excluded, since the generator has no way to know a later commit
   supersedes an earlier one - that kind of entry may need a manual touch-up to
   `changelog.json` after the merge.
3. commits `changelog.json` + `package.json` + `package-lock.json` back to `main` as
   `chore: update changelog for <sha>` - the "Merge alpha with main" workflow folds
   this bump commit back into `alpha` afterward (see the "Merge alpha with main"
   section of [`../CLAUDE.md`](../CLAUDE.md))
4. builds and pushes the Docker image to GHCR tagged `latest` + the new version

A second job in the same workflow re-publishes the image when the triggering push *is*
the changelog commit. `docker-publish.yml` is a manual (`workflow_dispatch`) image
build that skips the changelog step.

The in-app update check compares the bundled `changelog.json` against the published one
on GitHub - see the changelog section of [architecture.md](architecture.md).

## Other CI

| Workflow | What it does |
| --- | --- |
| `security.yml` | `npm audit --audit-level=high` + CodeQL, on push to `main`/`alpha`, PRs targeting `main`, and daily. CodeQL loads `.github/codeql/codeql-config.yml`, which excludes the `js/request-forgery` query repo-wide - every outbound request funnels through the centralized, validated fetch guard in `server/src/utils/outbound.js`, and admin-configured LAN media server URLs make that query permanently false-positive for this app |
| `secret-scan.yml` | TruffleHog verified-secret scan on push to `main`/`alpha` and PRs targeting `main` |
| `docker-build-check.yml` | Builds the image on every PR targeting `main`, without pushing anything, then runs `better-sqlite3` and `sharp` inside it, so a broken Dockerfile or dependency install is caught before a PR merges. The runtime probe matters because production dependencies install with `--ignore-scripts`: a native module with no usable binary for the platform still builds cleanly and would fail on first database open |
| `docker-publish-alpha.yml` | On every push to `alpha`: bumps `changelog.alpha.json`'s build counter and commits it back to `alpha`, builds the image, runs the same native-module probe as `docker-build-check.yml`, then pushes it to `ghcr.io/lasikiewicz/plembfin:alpha` and `ghcr.io/lasikiewicz/plembfin:alpha-<build>`. Never touches `changelog.json`, the package version, or the `:latest` tag |
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

- Commit messages follow `type: summary` with `- ` bullet bodies - the commit hook
  and changelog generator both reject user-visible release messages with missing or
  title-repeating details (full workflow in [`../CLAUDE.md`](../CLAUDE.md)).
- The version in `package.json`/`changelog.json` is CI-managed; only set it manually
  for a deliberate major/minor bump.
- `data/` is never committed and never in the image; all state must live under
  `DATA_DIR`.
