---
name: force-to-main
description: "Promote plembfin alpha current tip onto main as a single release. Use when the user says \"Force to main\" exactly. Runs the mandatory website and README checks, then covers the changelog preview and required user approval, promote-alpha-to-main.js --confirm, the force-push to main, the OCI public-demo refresh, and the synchronized develop update."
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
git add README.md changelog.json changelog.alpha.json changelog.develop.json CHANGELOG.md package.json package-lock.json
git commit -m "chore: promote alpha to main v<version>"
```

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

### 7 - Synchronize develop to the new main version
```bash
git fetch origin
git checkout develop
git merge --ff-only origin/develop
git merge origin/main --no-edit
git push origin develop
```
This final plain push is required. It publishes the release commit from step 4 and its
reset `changelog.alpha.json`/`changelog.develop.json` plus the new `changelog.json` version
to `origin/develop`, with `changelog.develop.json` at build 1. Keeping the released
`main` commit in remote `develop` means the next "Force to alpha" starts from an already
reconciled branch and does not have to merge an old release stamp into newer work. The
`develop` push runs the normal changelog and build gates; it is not a force-push and does
not touch `alpha` or `main`.

Do not fold the release into `alpha` separately. The next "Force to alpha" force-pushes
`develop`'s tip onto `alpha` regardless, so an additional alpha sync would be overwritten
instead of built on.
