# Step 6: Push, release pipeline, demo, and local develop

## Work

- After final approval, show `git log origin/main..HEAD --oneline` and force-push only the
  approved release commit to `main`.
- Wait for the main release workflow and OCI public-demo verification to pass. Record their
  run/result and the demo's served version.
- Reconcile local `develop` only after verifying the tree is clean and every local develop
  commit/hunk is already represented in the release. Do not push develop.
- Release the lock and record server/worktree cleanup and the previous develop tip.

## Tests

- The pre-push build gate passes; the release workflow publishes the approved version.
- OCI demo health/version verification passes against the public demo URL.
- Local develop reconciliation satisfies all ancestry and diff checks, or is left untouched
  with the reason recorded.

## Results

(Add dated evidence, pushed commit, workflow/demo results, branch status, previous develop tip,
and lock/server/worktree cleanup.)
