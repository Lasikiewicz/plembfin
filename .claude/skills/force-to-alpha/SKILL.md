---
name: force-to-alpha
description: "Promote everything queued on plembfin develop onto the alpha branch. Use when the user says \"Force to alpha\" exactly. Covers bringing develop up to date with main, reviewing and checking README.md, running promote-develop-to-alpha.js, the asset restamp, the force-push to alpha, and pushing develop reset state."
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
if git merge-base --is-ancestor origin/main origin/develop; then
  echo "origin/develop already contains origin/main"
else
  git merge origin/main --no-edit
fi
```
`Force to main` publishes its post-release synchronization to `origin/develop`, so this
check should normally be a no-op. It remains as a repair path for an older checkout or a
previously interrupted promotion and keeps `develop`'s own copy of `changelog.json` (used
by `promote-develop-to-alpha.js` to self-heal alpha's base version) current. Stop and ask
the user if the repair merge produces a real application-code conflict; never resolve one
by silently choosing a branch.

### 2 - Review and update README before promoting

Review `README.md` against the user-visible changes currently on `develop` and update
it before creating the promotion commit. At minimum, confirm the feature list, setup
guidance, Docker channel table, screenshots/links, and the top released-version marker
still describe the application. The marker must match the current stable version in
`package.json`/`changelog.json`; it is not the pending alpha build number.

Run the mechanical check after any edit:
```bash
npm run docs:check
```
The alpha workflow runs this check again, but CI cannot update a stale README. Keep any
README change in the same promotion commit so the alpha image and prerelease are built
from the documentation that was reviewed.

### 3 - Add develop's changelog as a new alpha build entry, locally
```bash
node scripts/promote-develop-to-alpha.js
git add README.md changelog.alpha.json changelog.develop.json public
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

### 4 - Force alpha to match develop
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

### 5 - Push develop's reset state
The commit from step 3 also reset `changelog.develop.json` for the next cycle - publish
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
