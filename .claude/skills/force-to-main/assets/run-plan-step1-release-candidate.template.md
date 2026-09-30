# Step 1: Release candidate and approvals

## Work

- Record starting branch/status, local develop tip, `origin/main` and pinned `origin/alpha`
  hashes, and release-lock owner/expiry. Preserve existing work.
- Create and record the detached alpha worktree and its data directory. Record the develop
  server PID and how it will be restored if release work stops.
- Verify the preview can list outstanding website guides without stopping. Write the
  single-line `releaseMessage`; save the complete preview for approval.
- Install and start the pinned candidate, confirm its source hash/version and server PID, and
  show the app to the user. Record explicit approval of both the changelog and running build
  before phase A.

## Tests

- `--preview` reports the expected version, headline, and bullets and does not stop on
  outstanding website guides.
- The running app serves the pinned alpha hash and reported version; the user approves it.
- Website work has not started before both approvals are recorded.

## Results

(Add dated evidence, exact hashes, paths, PIDs, preview text, approved `releaseMessage`, and
approval evidence.)
