---
name: force-to-main
description: "Promote plembfin alpha current tip onto main as a single release. Use when the user says \"Force to main\" exactly. Runs the mandatory website and README checks, then covers the changelog preview and required user approval, promote-alpha-to-main.js --confirm, the release-history verification gate, the force-push to main, and the OCI public-demo refresh. It does not push develop."
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

Then take the release lock, so a second session cannot rewrite history in this
checkout at the same time:

```bash
node scripts/release-lock.js acquire "force to main"
```

Release it when the workflow finishes, or if you abandon it:

```bash
node scripts/release-lock.js release
```

Two agents running overlapping `git reset --soft` and `git commit` sequences in one
worktree once amended the published v1.1.0 release commit and diverged `develop` from
`origin/develop`. If this refuses, do not work around it: wait for the other session, or
clear the lock only once you know it is gone.
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
source and release metadata.

Before reviewing the site, refresh the local committed-change inventory:

```bash
npm run updates:refresh
```

Read `plan/updates.md`. Use its **Website check targets** section
to focus the review on the guides, captures, and shared site surfaces mapped to the app
paths changed since `origin/main`; then use **Changelog-ready changes** and the commit
inventory to confirm the website copy covers the same user-visible outcomes. The ledger is
regenerated from history and groups each website guide once, so a follow-up commit touching
the same area updates the existing target instead of creating a duplicate checklist item.

**Commit any website change it produces on `develop` before continuing.** Updating the
website is part of this release, not a reason to abandon it: step 1a takes `develop`'s
reviewed `website/` tree into the release commit, so there is no need to run "Force to
alpha" again and restart.

`website/` is the one directory the release takes from `develop` rather than from the
alpha tip. That is deliberate:

- Website content has to live somewhere permanent. The release commit is never merged
  back into `develop`, so website work committed only onto the alpha checkout would be
  lost and every release would redo the same edits and screenshots.
- Nothing publishes it before release anyway. Cloudflare Pages builds only `main`;
  `develop` and `alpha` pushes start no Pages build. So the website tree on those
  branches is never public, and the only moment it has to be right is this one.

**One thing to watch while reviewing.** `develop` can be ahead of the alpha tip being
released, so its website tree may describe application work that is not in this release.
Check for that during the review and leave those pages describing the released behaviour.
Documenting an unreleased feature on the public site is the failure mode this trade
introduces, and the review is what catches it.

### 1 - Check out alpha's actual current tip
```bash
git fetch origin
git checkout -B alpha origin/alpha
```
Not a stale local `alpha` branch, which may not exactly match `origin/alpha` - this
resets the local branch to the remote tip every time.

### 1a - Take develop's reviewed website into the release
```bash
git checkout origin/develop -- website/
git status --short website/
```
The application ships from the alpha tip; the website ships from `develop`. This is what
lets step 0 update the website without restarting the command, and what stops each
release redoing the previous release's website work, since the release commit is never
merged back into `develop`.

Show the user what this brought in. If it is empty, `develop`'s website tree already
matches the alpha tip and there is nothing to carry. If it brings in a page describing
application work that is not in this release, fix that page now, before the release
commit - see the warning in step 0.

### 2 - Review and update README before promoting

Review `README.md` against the user-visible changes in the alpha tip and update it if
anything is stale. At minimum, confirm the feature list, setup guidance, Docker channel
table, screenshots/links, and the top released-version marker still describe the
application. The marker must match the stable version in `package.json`/`changelog.json`,
not the pending release version that the preview may calculate.

Run the mechanical check after any edit:
```bash
npm run docs:check
```
The main release workflow repeats this check, but CI cannot update a stale README. Keep
any README change in the single release commit below; do not leave it for a follow-up
commit after `main` has been force-pushed.

### 3 - Create the concise changelog, preview it, and get explicit approval
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

This same step also runs the website content-impact gate (`scripts/site-impact.js`): if a
changed application surface since the last main release has no matching website update and
no commit carries a `site-impact:` decision, `--preview` throws here instead of printing the
changelog. See ["Content-impact check"](docs/websiteupdate.md#content-impact-check-automated-fail-closed)
for how to resolve it - fix it on `develop`, repeat "Force to alpha", and retry this command.

**Do not continue past this step until the user has confirmed the changelog in chat.**
This is a required gate, not a formality: "Force to main" is a force-push onto the
shared `main` branch, and the release notes in Settings → Changelog /
`changelog.json` / `CHANGELOG.md` come from exactly this entry. Present the preview
output to the user. Incorporate any wording changes the user dictates by refining
`releaseMessage` or the relevant committed `changelog.alpha.json` entry text (or
reverting the offending `develop` commit and re-promoting to alpha), re-running
`--preview` until the entry reads correctly, and only proceed once the user approves.

### 4 - Build the release, locally, after approval
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
The command also refuses to run without `--confirm`; use that flag only after the step 3
approval - it is the first mutating step of promotion.
Then stage and commit:
```bash
git add README.md changelog.json changelog.alpha.json changelog.develop.json CHANGELOG.md package.json package-lock.json public website
git commit -m "chore: promote alpha to main v<version>"
```

`public` and `website` must both be staged.

`promote-alpha-to-main.js` restamps every `?v=` asset reference to the release version and
rewrites the About page's version fallback in `public/index.html`. Committing the version
bump without those assets fails the release build: `scripts/asset-versions.js` checks every
reference against the version derived from the committed manifests, and `npm run build`
runs that check in the main publish workflow. The v1.1.0 release commit carried 44
`public/` files for this reason.

`website` carries the tree taken from `develop` in step 1a, plus the `sourceVersion`
markers the same script stamps with the release version. Leaving it out would publish a
site documenting the previous release, which `website/scripts/check-doc-baseline.mjs`
then fails on.

### 4a - Final review: show the user the exact state about to be published

Everything is committed locally now and nothing has left the machine. This is the last
point at which the release can be changed, so show the user what is actually going to be
published rather than describing it.

Stop every local server first, so nothing is left serving the pre-release state and
mistaken for the release:

```bash
# Windows: find and stop anything on the app and website ports
Get-NetTCPConnection -LocalPort 5055,4321 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false }
```

Then start both against this commit, using the approved elevated network-enabled path:

```bash
npm start                 # application, http://localhost:5055
cd website && npm run dev # website, http://localhost:4321
```

Report all four of these together:

1. **The changelog that will go live.** Print the new release entry in full - version,
   headline, and every bullet under each section - from `changelog.json`. Not a summary:
   this is the text that reaches the GitHub Release, the app, and the website.
2. **What the documentation now says.** State which `website/` pages changed in this
   release and that their `sourceVersion` markers are stamped to the new version, so the
   user knows the published documentation describes this release and not the previous one.
3. **The application, running this exact commit**, at `http://localhost:5055`. Name the
   version it reports so the user can confirm it matches the release.
4. **The website, running this exact commit**, at `http://localhost:4321`, and point at
   `http://localhost:4321/changelog` specifically, since that is where the release entry
   and the Stable/Alpha tabs appear.

Wait for the user here. Do not continue to the force-push until they have looked and said
to go ahead. If they ask for a change, make it, re-run step 4, and show this again.

### 5 - Force main to match this commit
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
in this commit, checks README consistency, runs the build gate again in CI, and publishes
`:latest` + `:<version>` - it does not write anything back. Wait for this workflow to
finish successfully before checking the OCI demo deployment. Optionally confirm it succeeded:
```bash
gh run list --branch main --limit 1
```

### 6 - Rebuild and verify the OCI public demo

Publishing GHCR does not pull or restart the public demo. The live demo at
`https://demo.plembfin.com/` is served by the dedicated Oracle Cloud Compute instance
in `uk-london-1`, behind the Cloudflare reverse proxy. Portainer is local-only and is
not part of this release gate.

The `Publish Main Release` workflow now builds an AMD64/ARM64 image and its dependent
`Deploy public demo to OCI` job copies `scripts/deploy-oracle-demo.sh` to the instance
over pinned SSH, pulls the exact `ghcr.io/lasikiewicz/plembfin:<version>` tag, and
recreates only the configured demo container while preserving its `/data` mount. It
then runs `scripts/verify-oracle-demo.js` against `https://demo.plembfin.com/`.

Before the first release using this gate, configure the repository's GitHub Actions
variables `OCI_DEMO_HOST`, `OCI_DEMO_KNOWN_HOSTS`, `OCI_DEMO_CONTAINER`,
`OCI_DEMO_DATA_DIR`, and `OCI_DEMO_RUNTIME` (`podman` or `docker`). The optional
variables `OCI_DEMO_USER` and `OCI_DEMO_PORT` default to `opc` and `80`. Configure
`OCI_DEMO_SSH_KEY` as a repository or environment secret for the `opc` account. The
instance must have the selected runtime installed and passwordless `sudo` for `opc`.
If any setting is missing, the deploy, or the released-version verification fails, stop
and report the release as incomplete rather than claiming that the demo is current.

Do not call `npm run demo:assets` or `npm run demo:seed` as part of this refresh; those
commands prepare fixture content and are separate from pulling the released image.

### 7 - Stop. Do not synchronize develop.

There is no step 7 any more. Do not merge `origin/main` into `develop`, and do not push
`develop`.

The old step merged the release commit into `develop` and pushed it. That push carried the
`public/` asset restamp, `package.json`, and `package-lock.json`, so
`docker-publish-develop.yml`'s `paths-ignore` never matched and every release published a
second, meaningless develop image on top of the release one.

Nothing needs carrying. `promote-alpha-to-main.js` reads the released history from
`origin/main` rather than the working tree, and every changelog generation point writes the
release version from the manifests, so `develop` reconciles itself on its next "Push to
git" with no merge.

This supersedes `docs/decisions.md` entry 16; see entry 18 for the reasoning and for why
entry 16's conflict concern no longer applies. Entry 8 still stands: do not fold the
release into `alpha` either, because the next "Force to alpha" force-pushes `develop`'s tip
onto `alpha` regardless.
