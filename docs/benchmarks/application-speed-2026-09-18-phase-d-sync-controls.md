# Application speed remediation: Sync Activity control ownership - 18 September 2026

This R7 slice moved the Sync Activity page's pause, refresh, retry-all, and failed-only
summary handlers from the global `app-events.js` wiring into `sync-activity.js`. The page
already owned its search, paging, row, retry, match-fix, dismiss, log, and keyboard handlers;
all of those route-specific controls now share one route initializer.

Verification:

- Focused route/lazy-graph/startup tests: 24/24 passed.
- `node --check` passed for `app-events.js` and `sync-activity.js`.
- Chrome `/sync-activity` rendered 399 media groups with `Pause page updates` and `Refresh`
  controls visible, with zero console errors or warnings.
- Chrome `/about` rendered without `sync-activity.js`, `explorer.js`, or `stats.js` in the
  observed module list, with zero console errors or warnings.
- `npm run build` passed with 1,014/1,014 tests, documentation consistency, asset-version
  checks, and the Plembfin build check.
- `git diff --check` passed.

This is a route-ownership cleanup, not a claim that the settled shell, full benchmark, or
browser mutation gates have passed.
