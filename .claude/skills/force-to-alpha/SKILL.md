---
name: force-to-alpha
description: "Promote everything queued on plembfin develop onto the alpha branch. Use when the user says \"Force to alpha\" exactly. Covers bringing develop up to date with main, running promote-develop-to-alpha.js, the asset restamp, the force-push to alpha, and pushing develop reset state."
---

# Force to alpha

## Step 0 - Make sure GHCR Cleanup is not running

`ghcr-cleanup.yml` deletes images from the same `ghcr.io/lasikiewicz/plembfin`
package that this command publishes new tags to. The cleanup action's own docs warn it isn't safe
to run in parallel against the same package it targets, so before starting this
command, check it is not mid-run:
```bash
gh run list --workflow ghcr-cleanup.yml --limit 1
```
If the latest run shows `in_progress`, wait for it to complete before pushing.


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

### 2 - Add develop's changelog as a new alpha build entry, locally
```bash
node scripts/promote-develop-to-alpha.js
git add changelog.alpha.json changelog.develop.json public
git commit -m "chore: promote develop changelog to alpha"
```

`public` is staged because the promotion also restamps every local asset reference
with the new build's version (`?v=0.15.0.5`). Versioned assets are served with a
one-year immutable cache, so without that restamp every build in a cycle shares
one asset URL and a tester who pulls a new image keeps running the previous
build's JavaScript. Expect a large, entirely mechanical diff across `public/`.
This is `promoteDevelopToAlpha()` in `scripts/promote-develop-to-alpha.js`: it packages
develop's current entry as its own standalone alpha build entry and prepends it to
alpha's `entries` array (or starts a fresh array if main has moved on since the last
promotion), bumps the alpha build, and resets develop's `entries` and `resetCommit` for
the next cycle while carrying its release version and build number. If it
refuses with a release-process violation, that means a commit folded into develop's entry
still contains recognized process text; fix it on `develop` and repeat from step 1. There
is nothing to review afterward - the entry this writes is what will actually publish.

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
This push only ever changes `changelog.develop.json`/`changelog.alpha.json`, so
`docker-publish-develop.yml`'s `paths-ignore` skips rebuilding and republishing a develop
image over it - the point of this push is getting the correct file onto `origin/develop`
for the app's own live remote-fetch changelog comparison, not producing a new image.
`secret-scan.yml` still runs on every push regardless of which files changed.

