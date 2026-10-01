# Step 1: Release candidate and approvals

## Work

- Record starting branch/status, local develop tip, `origin/main` and pinned `origin/alpha`
  hashes, and release-lock owner/expiry. Preserve existing work.
- Create and record the detached alpha worktree and its data directory. Record the develop
  server PID and how it will be restored if release work stops.
- Verify the preview can list outstanding website guides without stopping. Write the
  single-line `releaseMessage`; save the complete preview for approval.
- Install the worktree, run `--confirm` inside it, start the resulting MAIN build (channel
  `release`), confirm its source hash/version and server PID, and show the app and the
  changelog entry to the user. Record one explicit approval of both the changelog and the
  running build before phase A. Never ask for changelog approval before the app is running.
  Once it is serving, recommend specific changelog changes (drop, reword, merge, add, and the
  `releaseMessage`) with reasons, or state that none are needed; edit only after the user agrees.

## Tests

- `--preview` reports the expected version, headline, and bullets and does not stop on
  outstanding website guides.
- The running app serves the pinned hash, reports `<version>` on channel `release`, and shows
  the new Stable changelog entry; the user approves both together.
- Website work has not started before both approvals are recorded.

## Results

(Add dated evidence, exact hashes, paths, PIDs, preview text, approved `releaseMessage`, and
approval evidence.)
