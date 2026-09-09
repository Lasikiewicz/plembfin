---
name: force-to-main
description: "Promote plembfin alpha current tip onto main as a single release. Use when the user says \"Force to main\" exactly. Runs the mandatory website update check, then covers the changelog preview and required user approval, promote-alpha-to-main.js --confirm, the force-push to main, and the local develop sync."
---

# Force to main

## Before you start - make sure GHCR Cleanup is not running

This is a read-only check, so it runs first. Step 0's website update gate comes before
anything is checked out, staged, previewed, or pushed.

`ghcr-cleanup.yml` deletes images from the same `ghcr.io/lasikiewicz/plembfin`
package that this command publishes new tags to. The cleanup action's own docs warn it isn't safe
to run in parallel against the same package it targets, so before starting this
command, check it is not mid-run:
```bash
gh run list --workflow ghcr-cleanup.yml --limit 1
```
If the latest run shows `in_progress`, wait for it to complete before pushing.


When the user says **"Force to main"** (exactly), promote `alpha`'s actual current tip
onto `main` as a single release:

### 0 - Run the website update check immediately

Before checking out a branch, previewing the release, staging files, or force-pushing,
always complete [`docs/websiteupdate.md`](docs/websiteupdate.md) end to end: discover the
baseline, review changes after it, start the local app and website preview, verify affected
content and images, run the privacy/inventory/check/build gates, and report the visual
findings. Do not ask whether to run this gate: the website is part of every main release.

Run the check against the current development checkout so it sees the latest application
source and release metadata. If it creates or updates website source, captures, or generated
data, keep those changes and land them on `develop` before checking out `alpha`; never let
the promotion checkout discard an uncommitted website update. The main promotion must use
the reviewed website tree that is present in the alpha tip.

### 1 - Check out alpha's actual current tip
```bash
git fetch origin
git checkout -B alpha origin/alpha
```
Not a stale local `alpha` branch, which may not exactly match `origin/alpha` - this
resets the local branch to the remote tip every time.

### 2 - Create the concise changelog, preview it, and get explicit approval
Before anything is staged or pushed, review the accumulated alpha sections and write a
single-line `releaseMessage` in `changelog.alpha.json`. It should summarize the main
user-visible themes in one sentence (maximum 240 characters); do not concatenate every
alpha build headline into it. For example:
```json
"releaseMessage": "This update makes media and library pages substantially faster, adds manual watch controls, and redesigns season and episode details."
```
Then show the exact changelog that "Force to main" would publish, using the script's
non-mutating preview pass:
```bash
node scripts/promote-alpha-to-main.js --preview
```
`--preview` runs the same release computation as the real promotion (see
`computeAlphaToMainRelease()` in `scripts/promote-alpha-to-main.js`) but reads only -
it does **not** write `changelog.json`, `package.json`, `package-lock.json`,
`CHANGELOG.md`, or reset `changelog.alpha.json`/`changelog.develop.json`. It prints the
new version (`v<version>` + 5-digit form) and the merged release entry (message, New
Features, Major Bug Fixes, Tweaks) that will be committed to `main`.

**Do not continue past this step until the user has confirmed the changelog in chat.**
This is a required gate, not a formality: "Force to main" is a force-push onto the
shared `main` branch, and the release notes in Settings → Changelog /
`changelog.json` / `CHANGELOG.md` come from exactly this entry. Present the preview
output to the user. Incorporate any wording changes the user dictates by refining
`releaseMessage` or the relevant committed `changelog.alpha.json` entry text (or
reverting the offending `develop` commit and re-promoting to alpha), re-running
`--preview` until the entry reads correctly, and only proceed once the user approves.

### 3 - Build the release, locally, after approval
```bash
node scripts/promote-alpha-to-main.js --confirm
```
This is `promoteAlphaToMain()` in `scripts/promote-alpha-to-main.js`: it consolidates
every alpha build entry accumulated this cycle into one clean release entry - merging
each entry's own already-categorized sections and using the approved concise
`releaseMessage` as the headline - bumps the real semver (honouring a
manually-set higher `package.json` version instead of overwriting it with a patch
increment), and writes `changelog.json`, `package.json`, `package-lock.json`, and
regenerates `CHANGELOG.md`, then resets `changelog.alpha.json` and resets
`changelog.develop.json` to the released version at build 1 for the next cycle. If it refuses with a release-process
violation, that means one of alpha's entries still contains recognized process text; fix
the source commit on `develop`, repeat "Force to alpha", and restart this command.
The command also refuses to run without `--confirm`; use that flag only after the step 2
approval - it is the first mutating step of promotion.
Then stage and commit:
```bash
git add changelog.json changelog.alpha.json changelog.develop.json CHANGELOG.md package.json package-lock.json
git commit -m "chore: promote alpha to main v<version>"
```

### 4 - Force main to match this commit
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

### 5 - Update local develop to the new main version
```bash
git fetch origin
git checkout develop
git merge --ff-only origin/develop
git merge origin/main --no-edit
```
Local only - **do not push this to `origin/develop`**. This folds the release commit from
step 3 into the local `develop` checkout, carrying forward its reset
`changelog.alpha.json`/`changelog.develop.json` and the new `changelog.json` version, so
`package.json`/`changelog.json` and the develop metadata read back locally as the version
just released, with `changelog.develop.json` at build 1. `origin/develop` retains the
pre-release reset state until the next normal develop push; the next "Force to alpha"
already merges `origin/main` into `develop` as its own step 1, so that remote state is
reconciled automatically. Don't bother folding it into `alpha` either - the next
"Force to alpha" force-pushes develop's tip onto alpha regardless, so anything synced
there now is simply overwritten rather than built on.
