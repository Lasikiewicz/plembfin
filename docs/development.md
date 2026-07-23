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
5. **rejects any bare `fetch(` outside `server/src/utils/outbound.js`** — outbound
   calls must use `fetchWithTimeout`, which enforces timeouts and validates both
   initial and redirected URLs
6. boots the real server once against a temp `DATA_DIR` with
   `PLEMBFIN_BUILD_CHECK=1` (the server exits immediately after `listening`)

## Git hooks

`npm install` runs `scripts/install-git-hooks.js` (via the `prepare` script), which
points `core.hooksPath` at `.githooks/`. The `.githooks/commit-msg` hook rejects
user-visible release commits whose body has no meaningful changelog bullet (a repeat
of the subject does not count). The `.githooks/pre-push` hook runs `git pull --rebase
origin main` and then `npm run build` — so a push always goes out rebased and
build-checked.

## Release pipeline (push to `main`)

`.github/workflows/update-changelog.yml` runs on every push to `main`:

1. build check
2. `scripts/update-changelog.js` bumps the patch version (honouring a manually-set
   higher `package.json` version) and appends a `changelog.json` entry — the entry's
   headline comes from the head commit's subject line (conventional-commit prefixes
   become labels: `feat:` → "Feature - …"), and its `details` are backfilled from the
   bullet points of **every** commit in the push. User-visible `feat`, `fix`,
   `security`, `enhance`, and `docs` commits are rejected unless they contain at
   least one meaningful body bullet; maintenance commits can fall back to their
   subject, so multi-commit pushes lose nothing
3. commits `changelog.json` + `package.json` + `package-lock.json` back to `main` as
   `chore: update changelog for <sha>` — this is why `origin/main` is usually one
   commit ahead right after a push (expected; see the "Push to git" section of
   [`../CLAUDE.md`](../CLAUDE.md))
4. builds and pushes the Docker image to GHCR tagged `latest` + the new version

A second job in the same workflow re-publishes the image when the triggering push *is*
the changelog commit. `docker-publish.yml` is a manual (`workflow_dispatch`) image
build that skips the changelog step.

The in-app update check compares the bundled `changelog.json` against the published one
on GitHub — see the changelog section of [architecture.md](architecture.md).

## Other CI

| Workflow | What it does |
| --- | --- |
| `security.yml` | `npm audit --audit-level=high` + CodeQL, on push/PR/daily. CodeQL loads `.github/codeql/codeql-config.yml`, which excludes the `js/request-forgery` query repo-wide — every outbound request funnels through the centralized, validated fetch guard in `server/src/utils/outbound.js`, and admin-configured LAN media server URLs make that query permanently false-positive for this app |
| `secret-scan.yml` | TruffleHog verified-secret scan on push/PR |
| `dependabot.yml` | Dependency update PRs |

## Docker

- **`Dockerfile`** — `node:22-slim`, production deps only, non-root `plembfin` user
  (uid 1000), `VOLUME /data`, healthcheck against `/api/ping`, entrypoint
  (`scripts/docker-entrypoint.sh`) chowns `/data` and drops privileges via gosu when
  started as root.
- **`docker-compose.yml`** — base setup: port 5055, `./data:/data`, admin env vars,
  `no-new-privileges`, cpu/memory limits.
- **`docker-compose.split.yml`** — optional same-host overlay that runs one
  `ROLE=web` service and one HTTP-less `ROLE=worker` service on the same local data
  volume: `docker compose -f docker-compose.yml -f docker-compose.split.yml up -d`.
- **`docker-compose.secure.yml`** — hardened overlay (read-only rootfs, tmpfs `/tmp`,
  required secrets, forced `COOKIE_SECURE`); usage in
  [hardening.md](hardening.md).
- **`.dockerignore`** — keeps `data/`, `docs/`, markdown, and scratch files out of the
  image; whitelists only the install, entrypoint, and worker-health scripts the image needs.

## One-shot operational scripts

| Script | Purpose |
| --- | --- |
| `scripts/exportPlexHistory.js` | Import a Plex server's watch history into Plembfin via `/api/import` (env: `PLEX_URL`, `PLEX_TOKEN`, `API_KEY`) |
| `scripts/forcePushHistory.js` | Replay Plembfin's `/api/history` against Plex/Emby/Jellyfin as mark-played calls (env: all three platforms' credentials + `API_KEY`) |
| `scripts/seed-demo-content.js` | Seed fictional demo content for screenshots/dev |

## Conventions that CI enforces or assumes

- Commit messages follow `type: summary` with `- ` bullet bodies — the commit hook
  and changelog generator both reject user-visible release messages with missing or
  title-repeating details (full workflow in [`../CLAUDE.md`](../CLAUDE.md)).
- The version in `package.json`/`changelog.json` is CI-managed; only set it manually
  for a deliberate major/minor bump.
- `data/` is never committed and never in the image; all state must live under
  `DATA_DIR`.
