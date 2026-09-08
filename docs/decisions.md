# Decision record

Why the non-obvious calls in this codebase were made, and what was rejected.

The rest of `docs/` states what the system does today. `CHANGELOG.md` states what
shipped. This file states *why*, for the small number of decisions where a reasonable
alternative existed and was deliberately not taken. It exists so that the reasoning
survives a squashed commit history, and so that a decision made after a production
incident is not quietly undone by someone who never saw the incident.

## When to add an entry

Add one when all three are true:

1. A plausible alternative existed and was rejected.
2. The reason is not visible from reading the code.
3. Undoing it later would cost real time, data, or user trust.

Do not add an entry for ordinary implementation choices, for anything already stated in a
feature doc, or for release bookkeeping. A dozen entries a year is the expected volume.

## Format

Entries are numbered, appended in date order (oldest first), and never renumbered.
Superseded entries stay in place with their status changed and a pointer to the entry that
replaced them, so the trail stays readable.

```
### N. Short title
**Date:** YYYY-MM-DD  |  **Status:** Active | Superseded by #M | Relaxed by #M
**Context:** what forced the decision.
**Decision:** what was chosen.
**Rejected:** what was not chosen, and why.
**Enforced by:** the code, test, hook, or workflow that keeps it true.
```

---

### 1. Ambiguous sync signals are dropped, not recorded
**Date:** 2026-07-26  |  **Status:** Active (one scoped relaxation, see #5)

**Context:** Phantom rewatches were appearing in watch history. Emby and Jellyfin
`item.markplayed`, and Plex `lastViewedAt`, are all set by Plembfin's own outbound sync and
can be read back hours or days later, at which point they look like fresh plays.

**Decision:** Accurate tracking is the product. When an inbound signal is ambiguous, drop it
rather than record a watch that may not have happened. A phantom watch is a worse failure
than a missed one. Require real playback evidence, and prefer the timestamp reported by the
source server over `Date.now()`, since webhook delivery can lag by hours.

**Rejected:** Treating a media server's played flag as evidence of a play, and relying on
time-based echo guards (short loop windows, same-calendar-day checks) to catch the resulting
false positives. Those guards are not sufficient on their own, because the read back can
happen well outside any reasonable window.

**Enforced by:** `server/src/utils/watchDates.js`, the source-played-date handling in
`server/src/scheduled.js`, and the phantom-watch audit and repair endpoints added in
`f725da31` (2026-07-27).

---

### 2. Data repairs ship as a read-only audit plus a separate confirmed repair
**Date:** 2026-07-27  |  **Status:** Active

**Context:** Fixing bad rows in a user's live watch history is irreversible, and the data has
no upstream source of truth to re-derive from.

**Decision:** Every bulk data repair is two endpoints: a `GET` audit that only counts and
samples what would change, and a `POST` repair that performs it after the operator has seen
the audit. New repairs mirror this shape rather than inventing a new one.

**Rejected:** A single "fix it" action. The audit step is what makes a wrong repair
survivable, and it is also what makes a support conversation possible before anything is
written.

**Enforced by:** `/api/phantom-watch-audit` and `/api/phantom-watch-repair`, later
`/api/stale-trakt-import-audit` and `/api/stale-trakt-import-repair`, in
`server/src/routes/maintenance.js` and `server/src/utils/dataRepo.js`.

---

### 3. Release notes are gated on content, not on reviewer attention
**Date:** 2026-07-13  |  **Status:** Active

**Context:** Single-line commits were producing empty Settings → Changelog entries, and
release-process bookkeeping ("consolidate changelog", "reset build counter") was leaking into
user-facing release notes.

**Decision:** Enforce changelog quality mechanically at three independent points. The
`commit-msg` hook rejects `feat`, `fix`, `security`, `enhance`, and `docs` commits with no
meaningful bullet. The changelog rebuild re-runs the same validation while walking real git
history, so a commit made with hooks bypassed still cannot reach a published entry. And
recognized release-process text is stripped by content at the alpha and main boundaries.

**Rejected:** Relying on review discipline alone. The rules are correct, but they are applied
at the end of a long session, which is exactly when they get skipped.

**Enforced by:** `.githooks/commit-msg`, `validateReleaseMessage` and
`changelogEntryProcessViolations` in `scripts/changelog-message.js`.

---

### 4. A new `watch_history` row must carry settled dispatch telemetry
**Date:** 2026-08-19  |  **Status:** Active

**Context:** A feature that imported every individual Trakt play inserted watch rows with no
`sync_dispatch_telemetry`. `syncPendingManualDispatches` in `server/src/scheduled.js` treats
incomplete telemetry as pending work, so it re-dispatched each row to every active target on
every scheduler tick. Trakt's `/sync/history` is not idempotent: every POST adds a new play.
Each push produced a new Trakt history id, which the next poll re-imported as a new play and
pushed again. That is an unbounded once-a-minute loop. It flooded the user's real Trakt
account within minutes of deployment, the container had to be force-stopped from Portainer,
and the duplicated history had to be cleaned up by hand with no tooling for it.

**Decision:** Any code path inserting a row with `sync_action: "watched"` outside the normal
webhook and `applyWatchedTransition` path must either run it through `syncMediaPlaystate`
once immediately, so real telemetry is written, or set `sync_dispatch_telemetry` explicitly
to a settled shape covering every possible active target. Changes to Trakt outbound dispatch
or watch-history insertion get a regression test rather than manual review.

**Rejected:** Leaving telemetry null and letting the retry sweep sort it out, which is the
exact failure above. Also rejected: making the sweep smarter about what counts as pending,
which would have made the invariant implicit instead of explicit at the insertion site.

**Note:** the outbound echo guard in `server/src/utils/trackerDispatcher.js` matches
`source.includes("trakt")`, not `=== "trakt"`, because two Trakt-sourced values exist
(`trakt` for live sync, `trakt_import` for both importers) and both must be excluded. A new
Trakt-sourced ingest path must keep a source string containing `trakt`, or update the guard.

**Enforced by:** `test/trackerPlayHistoryImport.test.js`, `importTraktPlayHistory` in
`server/src/utils/trackerSync.js`.

---

### 5. Detail-page Force Sync may import a flagged play, anchored to the release date
**Date:** 2026-08-21  |  **Status:** Active (scoped relaxation of #1)

**Context:** Episodes bulk-marked watched through a media server's own library UI carry a
played flag with no reliable played timestamp, so #1 caused them to be skipped entirely,
including when the user explicitly asked Plembfin to import that title's state.

**Decision:** Import them, but only through the detail-page Force Sync "Import Watched
Status" action, and use the episode's own release date as `watched_at`.

**Rejected:** Using `Date.now()`, which recreates the original failure by fabricating "just
watched" timestamps that corrupt recency. Also rejected: extending the relaxation to
scheduled, background, or webhook sync. This action is explicit, user-triggered, and scoped
to one title, so it cannot manufacture a library-wide phantom-watch burst the way trusting
the flag in the background poll could. #1 still applies in full to every automatic path.

**Enforced by:** `remoteItemToMedia` in `server/src/utils/mediaForceSync.js`.

---

### 6. Changelog content is computed locally before every push, never by CI
**Date:** 2026-08-29  |  **Status:** Active

**Context:** CI jobs were reading GitHub's push-event commit list to build changelog entries.
That payload is only reliable for a plain incremental push. `alpha` and `main` are always
reached by force-push, where the event's commit list is empty or incomplete, so entries came
out truncated or blank.

**Decision:** All three changelog files are written locally, as part of the push command that
produces them, using real local git history. The publish workflows only build, verify, and
publish using values already committed; none of them writes back to its branch.

**Rejected:** Detecting the force-push case in CI and reconstructing the commit range from the
GitHub API. That is a workaround for a data source that is structurally wrong for this
branching model, and it would keep the failure mode alive in a less obvious form. Local git
history is always complete, so computing there removes the class of bug rather than handling
it.

**Enforced by:** `scripts/rebuild-develop-changelog.js`, `scripts/promote-develop-to-alpha.js`,
`scripts/promote-alpha-to-main.js`, and the pre-push hook's `--check` pass.

---

### 7. Build versions are four segments, not five
**Date:** 2026-08-21  |  **Status:** Active, supersedes the five-segment scheme of 2026-08-20

**Context:** The tiered changelog cascade shipped with a five-segment build version
(`0.8.6.8.0`).

**Decision:** Use `baseVersion.build`, four segments (`0.14.0.3`).

**Rejected:** Keeping the fifth segment. No comparison logic ever read it; it only appeared as
visual noise in the changelog UI and in the sidebar.

**Enforced by:** `scripts/promote-develop-to-alpha.js`.

---

### 8. `main` is not synced back into `alpha` after a release
**Date:** 2026-08-26  |  **Status:** Active

**Context:** The Force to main procedure ended by folding the release commit back into both
`develop` and `alpha`.

**Decision:** Fold it into local `develop` only.

**Rejected:** Also syncing `alpha`. The next Force to alpha force-pushes `develop`'s tip onto
`alpha` regardless of what `alpha` holds, so anything synced there is discarded rather than
built on. The alpha half cost an extra checkout, merge, push, and CI run for nothing.

**Enforced by:** the "Force to main" step 5 procedure in `CLAUDE.md`.

---

### 9. A changelog-only push to `develop` does not rebuild the develop image
**Date:** 2026-08-31  |  **Status:** Active

**Context:** Force to alpha step 4 pushes a commit to `develop` that contains only the reset
`changelog.develop.json` and the promoted `changelog.alpha.json`, no app code. That triggered
a full image build and publish.

**Decision:** `paths-ignore` skips the develop publish job when every changed file is one of
those two changelog files. Any push that also touches real code still builds normally.

**Rejected:** Dropping the push. It exists so `origin/develop` holds the correct file for the
app's own live changelog comparison, which reads GitHub's copy directly
(`fetchRemoteDevelopChangelog` in `server/src/routes/maintenance.js`) and is therefore
independent of what any built image bundles. The push is needed; the rebuild was not.

**Enforced by:** `paths-ignore` in `.github/workflows/docker-publish-develop.yml`.

---

### 10. Alpha promotion restamps every public asset URL
**Date:** 2026-09-05  |  **Status:** Active

**Context:** Public assets are served with a one-year immutable cache keyed on their `?v=`
query string. Every build in a cycle shared one asset version, so a tester who pulled a new
alpha image kept running the previous build's JavaScript against the new server.

**Decision:** Promotion to alpha rewrites every local asset reference with the new build's
version. This produces a large, entirely mechanical diff across `public/` on every promotion,
which is expected.

**Rejected:** Shortening the cache lifetime, which gives up the performance win for every end
user in order to fix a problem that only affects testers mid-cycle.

**Enforced by:** the `scripts/asset-versions.js --write` step inside
`scripts/promote-develop-to-alpha.js`.

---

### 11. TMDB image URLs are not treated as cached artwork
**Date:** 2026-09-05  |  **Status:** Active

**Context:** `isCachedStorageImageUrl()` decides whether an artwork URL is already a local
cached file. TMDB URLs are always resolvable and superficially look like a reasonable thing to
include.

**Decision:** It returns true only for `/media/posters/` and `/media/backdrops/`.
`image.tmdb.org` URLs are not cached storage.

**Rejected:** Including TMDB URLs. They are a remote dependency, not a local file, so counting
them as cached skips the poster pipeline that would otherwise fetch, resize, and persist a
local copy, leaving artwork dependent on TMDB availability at render time.

**Enforced by:** `isCachedStorageImageUrl` in `public/modules/images.js`, alongside the
separate `isLocalArtworkUrl` for the same-origin endpoints that are safe to render directly.
