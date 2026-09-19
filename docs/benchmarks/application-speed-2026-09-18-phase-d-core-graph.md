# Application speed remediation: core graph extraction

Date: 18 September 2026  
Environment: authenticated Chrome, `http://localhost:5055`, cache disabled for the
request-graph check, existing local data

This is a focused R7 verification after moving media identity routing and cast
disclosure out of the shared media-detail module, and after making TMDB and the
shared media-detail helper route-scoped. It is not the six-load benchmark or a
settled-shell budget measurement.

## Chrome results

| Route | Render result | Relevant modules | Console errors/warnings |
| --- | --- | --- | --- |
| `/about` | About rendered with Manual Watch count 5 and Sync - Idle | `status-indicators.js`, `media-routing.js`, `cast-disclosure.js`; no `media-detail-shared.js`, `tmdb.js`, `sync-activity.js`, or `manual-watch-review.js` | 0 |
| `/` | Dashboard rendered the Up Next rail | `dashboard.js`, `up-next.js`, `media-detail-shared.js`, `tmdb.js` | 0 |
| `/manual-watch-review` | Manual Watch review rendered 5 pending items | `manual-watch-review.js`, `tmdb.js` | 0 |
| `/sync-activity` | Sync Activity rendered 398 media groups and no current sync | `sync-activity.js`, `manual-watch-review.js` | 0 |

The cold About request-graph sample reached `readyState=complete` after 2.2 seconds,
with 54 requests, 52 completed requests, and 884,296 encoded bytes. It remained above
the plan's critical-shell budget and is recorded only as a diagnostic comparison, not
as a passing budget result.

## Verification

- Focused route/lazy-graph tests: 24/24 passed.
- Cast artwork regression test: 8/8 passed.
- `npm run build`: 1,014/1,014 tests passed, documentation consistency passed, asset
  version checks passed (`312` literal and `48` dynamic references), and the Plembfin
  build check passed.
- `git diff --check`: passed.

The six-load, provider-quiet TTFB, TV-detail inventory, mutating-action, and settled
critical-shell gates remain open.
