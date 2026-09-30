# Step 5: Promote and final review

## Work

- Carry the committed website from local `develop` into the same pinned alpha checkout.
- Restore the approved release message, review README and release files, and run the final
  website-impact gate, docs check, and promotion preview. Resolve any difference or blocker
  before confirming.
- Run `--confirm` only after the website gate passes and the approved release entry still
  matches. Commit the release locally, then start the app and website from that exact commit.
- Show the complete release entry, changed website pages/baselines, app URL/version, and
  website URL to the user. Wait for approval of this exact state before pushing.

## Tests

- Final preview matches the approved version, headline, and every bullet; no website guide is
  outstanding.
- README/docs checks and release build gates pass; only intended release files are committed.
- The running app and website both serve the exact local release commit.

## Results

(Add dated evidence, release commit/hash, preview, checks, review URLs/version, and final user
approval.)
