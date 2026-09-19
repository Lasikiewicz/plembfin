# Application speed remediation: Sync Activity event split

Date: 18 September 2026  
Environment: authenticated Chrome, `http://localhost:5055`, existing local data

This is a focused R7 verification after moving Sync Activity's route-specific search,
paging, retry, match-fix, dismiss, log, and keyboard row handlers out of the global
`app-events.js` module and into `sync-activity.js`. It is not the six-load benchmark or
a settled-shell budget measurement.

## Chrome results

| Route | Event/module result | Render result | Console errors/warnings |
| --- | --- | --- | --- |
| `/about` | `app-events.js` and `status-indicators.js` loaded; `sync-activity.js` did not | About rendered with Manual Watch count 5 and Sync - Idle | 0 |
| `/sync-activity` | `sync-activity.js` loaded and owned the route-specific event initializer | Sync Activity rendered 398 media groups and no current sync | 0 |

## Verification

- Focused route/lazy-graph, startup, and artwork suites: 32/32 passed.
- `node --check public/modules/app-events.js`: passed.
- `node --check public/modules/sync-activity.js`: passed.
- `npm run build`: 1,014/1,014 tests passed, documentation consistency passed, asset
  version checks passed (`312` literal and `48` dynamic references), and the Plembfin
  build check passed.
- `git diff --check`: passed.

The six-load, provider-quiet TTFB, TV-detail inventory, mutating-action, and settled
critical-shell gates remain open.
