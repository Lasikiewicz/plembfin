---
name: force-to-alpha
description: "Promote everything queued on plembfin develop onto the alpha branch. Use when the user says \"Force to alpha\" exactly. Covers fast-forwarding develop, reviewing and checking README.md, running promote-develop-to-alpha.js, the asset restamp, the required approval of the alpha changelog entry, and the force-push to alpha. It does not push develop."
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

### 1 - Bring develop up to date
```bash
git fetch origin
git checkout develop
git merge --ff-only origin/develop
```
No merge of `origin/main` and no ancestry check. `Force to main` no longer pushes a
post-release synchronization to `origin/develop`, so `origin/main` is never an ancestor of
`develop` and the old `git merge-base --is-ancestor origin/main origin/develop` gate could
never pass. See `docs/decisions.md` entry 18, which supersedes entries 9 and 16.

The release version `develop` needs is not carried through a merge any more: every
changelog generation point writes it from the manifests directly, and
`promote-develop-to-alpha.js` takes `baseVersion` from `changelog.json`. If `develop`'s
`changelog.json` version does not match the current release, that means a previous
promotion was interrupted - stop and ask the user rather than promoting on a stale base.

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
```

Then complete step 3a below and wait for the user's approval. Only after that:

```bash
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
still contains recognized process text; fix it on `develop` and repeat from step 1.

### 3a - Show the alpha entry and get explicit approval

**Do not commit or push until the user approves the entry in chat.** Print the new alpha
build entry that `promote-develop-to-alpha.js` just wrote - its version, headline, and
every bullet under New Features / Major Bug Fixes / Tweaks:

```bash
node -e "const a=require('./changelog.alpha.json'); const e=a.entries[0]; console.log(JSON.stringify({version:e.version,build:e.build,message:e.message,sections:e.sections},null,2))"
```

Ask the user to approve it or give replacement wording. If they revise it, edit
`changelog.alpha.json`'s top entry (`message`, and the `sections` bullets if they change
those), re-run the process-text check, and show it again. Only then stage and commit.

This gate is deliberate even though the entry is generated verbatim from develop's commit
messages: alpha builds are what testers read, and the wording is worth a look before it is
force-pushed. Note that the same text is reviewed again when "Force to main" consolidates
the cycle, so expect to approve it twice per cycle.

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

### 5 - Stop. Do not push develop.

There is no step 5 push any more. The promotion commit reset
`changelog.develop.json` locally and that is where it stays; the next ordinary
"Push to git" publishes it.

The old step pushed that commit to `origin/develop` and claimed it "only ever changes
`changelog.develop.json`/`changelog.alpha.json`". That was false: the same commit carries
the `public/` asset restamp and `README.md`, so `docker-publish-develop.yml`'s
`paths-ignore` never matched and every "Force to alpha" published a second, meaningless
develop image on top of the alpha one.

Dropping the push is safe for the app's live develop indicator.
`describePendingDevelopBuild()` in `server/src/routes/maintenance.js` flags a pending build
only when the remote build is greater at equal version; with no sync, `origin/develop` and
any running develop image sit at the same pre-promotion build, so it correctly reports
nothing pending until the next "Push to git" bumps it.

See `docs/decisions.md` entry 18.
