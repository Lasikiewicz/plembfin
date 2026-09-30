# Step 4: Website phase C — place and check

## Work

- Reconcile the release lock, pinned alpha hash, approved build, and phase B results.
- Inspect every staged image and its joins/bottom sections; reject stale views, missing
  coverage, errors, or visible secrets. Place only accepted files in `website/`.
- Finish captions, links, themes, affected-page checks, and the image privacy manifest.
- Run the capture inventory, website checks, and build. Commit the reviewed website changes
  on local `develop`; do not push it or rerun Force to alpha.

## Tests

- Every published image has a reviewed privacy-manifest entry and matches its caption/page.
- `npm run captures:inventory`, `npm run check`, and `npm run build` pass.
- Website changes are committed on `develop`, and no release guide remains unreviewed unless
  the user explicitly accepted it.

## Results

(Add dated evidence, image decisions, checks, website commit, remaining accepted items, and
the next phase.)
