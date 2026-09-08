---
name: push-to-git
description: "Run the complete plembfin develop-branch push workflow. Use when the user says \"Push to git\", \"Push all to git\", \"push all the git\", or any case variation. Covers scope selection, doc/README sync, in-app help sync, commit message rules, changelog rebuild, commit consolidation, and the push itself."
---

# Push to git / Push all to git

Follow every step in order. Do not improvise or skip a step. Never interpret either
phrase as running `git push` by itself.

## Step 0 - Make sure GHCR Cleanup is not running

`ghcr-cleanup.yml` deletes images from the same `ghcr.io/lasikiewicz/plembfin`
package that this command publishes new tags to. The cleanup action's own docs warn it isn't safe
to run in parallel against the same package it targets, so before starting this
command, check it is not mid-run:
```bash
gh run list --workflow ghcr-cleanup.yml --limit 1
```
If the latest run shows `in_progress`, wait for it to complete before pushing.


Choose the scope from the user's wording before doing anything. Both commands run
the complete local changelog/build workflow below; they differ in which local work
may enter it:

- **"Push all to git"** (also accept **"push all the git"** and case variations)
  includes every relevant local change currently in the worktree and every pending
  local `develop` commit that can be safely consolidated. This is the command for
  publishing all local work.
- **"Push to git"** includes only files, lines, and commits created in the current
  chat. Before the first task edit, record the current `HEAD`, `git status`, and
  the pending `origin/develop..HEAD` commit list as this chat's baseline. Leave
  pre-existing worktree changes and commits untouched; do not use `git add .` in
  this mode. If old and current work are mixed in a file and cannot be separated
  safely, or if the baseline already has unpushed commits, stop and ask whether
  the user wants **"Push all to git"** or a narrower scope.

The selected scope applies to every review, documentation, staging, commit, and
consolidation step. Never interpret either phrase as running `git push` by itself.

### Git permission in the managed workspace

When either **"Push to git"** or **"Push all to git"** is requested, request
elevated repository access before the first Git command that mutates `.git`, and
use that elevated access consistently for the rest of the workflow. This managed
Windows workspace can protect `.git` metadata even when the worktree files are
writable, so the affected commands include `git fetch`, `git checkout`, `git merge`,
`git add`, `git commit`, `git reset --soft`, and `git push`. Read-only inspection
commands such as `git status`, `git diff`, and `git log` may run without elevation.
Do not work around the boundary with an alternate index, global Git configuration,
or indirect file writes. If the elevation request is rejected, stop and ask the
user to approve retrying the repository operation.

### 1 - Review the selected scope
```bash
git diff --stat HEAD
```
For **"Push all to git"**, read every relevant changed file and pending local
commit. For **"Push to git"**, compare the worktree with the baseline recorded at
the start of this chat and review only this chat's changes. A pre-existing local
commit ahead of `origin/develop` cannot be omitted from a normal branch push, so
the scope check must stop before committing when one is present.

### 2 - Sync docs and README
For every selected changed file, check whether the corresponding doc **and** the relevant section of `README.md` need updating:

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
| `syncOrchestrator.js`, `trackerDispatcher.js`, `loopStore.js`, or a `watch_history` insert path | `docs/decisions.md` + `docs/scheduled-sync.md` | - |
| `scripts/promote-*.js`, `scripts/rebuild-develop-changelog.js`, or a publish workflow | `docs/decisions.md` + `docs/development.md` | 🚀 Getting Started |
| Any other deliberate call where a plausible alternative was rejected | `docs/decisions.md` | - |

**Important**: Always read the actual README sections that correspond to changed areas - do not assume they are already up to date. README prose can become stale even when docs/ files are current.

Update any doc **and** the matching README section that is out of date before proceeding.

Documentation and README copy must stand on its own for a first-time reader. State the current behavior as a fact; avoid historical or relative wording such as "still", "previously", "formerly", "same as before", "no longer", or "new" unless the sentence is explicitly about an upgrade, migration, or changelog entry. For metadata source descriptions, say which source provides which data instead of referencing what another source used to provide.


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

The changelog is for changes to the app itself, not to the project's own tooling. When
a session's work also touched git hooks, CI workflows, or the changelog/promotion
scripts, never fold a summary of that into a `feat`/`fix` commit's bullet list just
because it landed in the same push - use a separate `chore:` commit for it instead (see
"Backend Module Discipline" for where chore work belongs). A `fix`/`feat` commit's own
bullets should describe only what changed for someone using the app.
`isReleaseToolingText()` in `scripts/changelog-message.js` strips bullets that describe
the release pipeline's own machinery by content as a safety net, but it isn't a
substitute for keeping the two kinds of work in separate commits to begin with.

Do not create single-line commits for user-visible changes. If the change affects behavior, UI, docs, setup, data sources, sync, caching, or settings, the commit body must include bullet-point details. The changelog generator only reads body lines that start with `- ` or `* `; without them, the Settings → Changelog entry will be sparse. If you are about to commit without bullet details, stop and rewrite the commit message before committing.

This is an enforced release requirement, not optional guidance. Before committing, compare the staged diff with the bullet list and make sure every significant user-visible outcome is represented. A bullet that merely repeats the subject is not a detail. Use separate `-m` arguments (or a commit-message file) so the body is actually recorded:

```bash
git commit -m "fix: concise summary" \
  -m "- First concrete user-visible outcome
- Second concrete user-visible outcome"
```

The `.githooks/commit-msg` hook rejects `feat`, `fix`, `security`, `enhance`, and `docs` commits that have no meaningful bullet, and `rebuild-develop-changelog.js` in step 6 applies the same `validateReleaseMessage` check again while walking real git history, so bypassing local hooks (or a commit from before this repo had the hook) still cannot reach a published changelog entry. After committing, verify the recorded message with `git log -1 --format=full` before pushing.

### 5 - Stage and commit
For **"Push all to git"**, stage all modified files **except** `data/`,
`backups/`, `node_modules/`, and any secrets. For **"Push to git"**, stage only the
files or lines created in this chat and leave the baseline changes unstaged. Commit
using the message written in step 4.

`backups/` holds local data-directory archives containing `data/config.json` (admin
password hash, API key, session secret) and the full watch-history database, at
hundreds of megabytes each. It is gitignored, but never stage it even if an ignore
rule is missing on some checkout. Never use `git add -f` on it.

### 6 - Rebuild the develop changelog
```bash
node scripts/rebuild-develop-changelog.js
git add changelog.develop.json
git commit -m "chore: rebuild develop changelog"
```
For **"Push all to git"**, this intentionally walks every real commit from
`changelog.develop.json`'s `resetCommit` anchor (set by the last "Force to alpha")
through the commit just made in step 5, inclusive, and recomputes the single
develop entry from scratch. For **"Push to git"**, run this step only after the
scope check has confirmed that no older local commit is pending; earlier commits
already published on `origin/develop` remain represented in the rolling entry,
but pre-existing local work is not staged or pushed by this chat. If it prints
"No user-facing commits since the last reset", nothing changed the file; skip
`git add`/`git commit` for it. If it exits with a validation error, fix the
offending commit message(s) it names before continuing - do not bypass it.

### 7 - Consolidate pending local commits
Check what is about to be pushed:
```bash
git log origin/develop..HEAD --oneline
```
For **"Push all to git"**, squash all pending local product/changelog commits into
one clean commit before pushing so history on `develop` stays one commit per push.
For **"Push to git"**, do this only when the baseline had no pending local commits;
then it consolidates only this chat's product/changelog commits. Never use the
consolidation reset to absorb baseline commits in the narrow-scope mode:
```bash
git reset --soft origin/develop
git commit -m "<type>: <consolidated summary>" \
  -m "- consolidated bullet 1
- consolidated bullet 2"
```
Take the commit message from step 4's product commit - step 6's "chore: rebuild develop
changelog" commit has no product bullets of its own and contributes nothing to the
message. `git reset --soft` preserves the working tree exactly, so the changelog file step
6 already rebuilt is included in this final commit untouched. In all-scope mode, if more
than one *product* commit is being squashed, combine their bullet lists into one
consolidated list using the same standard as step 4 (3-8 of the most significant
user-visible changes; drop a bullet that just restates another one in the group more
briefly) - this is exactly what turned one evening's worth of commits into a 38-bullet
release note once (see `docs: consolidate v0.12.9 changelog entry into higher-level
bullets` for the correction this required) - and re-run step 6 afterward so the rebuilt
entry reflects the final, consolidated message rather than the pre-squash one.

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

