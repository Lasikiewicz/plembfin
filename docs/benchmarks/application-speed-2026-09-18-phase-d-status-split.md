# Application speed remediation: status-page route split

Date: 18 September 2026  
Environment: authenticated Chrome, `http://localhost:5055`, existing local data

This is a focused route-loading smoke check after moving the compact sidebar status
helpers into `public/modules/status-indicators.js`. It is not the six-load benchmark
or a settled-shell budget measurement.

## Results

| Route | Expected route modules observed | Render result | Console errors/warnings |
| --- | --- | --- | --- |
| `/about` | `status-indicators.js`; no `sync-activity.js` or `manual-watch-review.js` | About page rendered; Manual Watch count and Sync indicator remained visible | 0 |
| `/` | `dashboard.js`, `up-next.js`, `poster-menu.js` | Dashboard and Up Next rail rendered | 0 |
| `/manual-watch-review` | `manual-watch-review.js` | Manual Watch review rendered 5 pending items | 0 |
| `/sync-activity` | `sync-activity.js` | Sync Activity rendered 398 media groups and current progress state | 0 |

The About check also excluded the Dashboard, Up Next, and backup-tool route modules.
The full route modules were loaded by their direct deep links, so the split did not
remove either status page from the application.

## Verification

- Focused route/lazy-graph tests: 24/24 passed.
- `npm run build`: 1,014/1,014 tests passed, documentation consistency passed, asset
  version checks passed (`302` literal and `47` dynamic references), and the build check
  passed.
- `git diff --check`: passed.

The remaining six-load, provider-quiet TTFB, TV-detail inventory, and settled critical
shell measurements are still open and must be rerun against this graph.
