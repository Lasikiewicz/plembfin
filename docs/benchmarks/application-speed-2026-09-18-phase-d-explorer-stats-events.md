# Application speed remediation: Explorer and Stats event split

Date: 18 September 2026  
Environment: authenticated Chrome, `http://localhost:5055`, existing local data

This is a focused R7 verification after moving Explorer/History search, filter, view,
sort, poster-size, and list-header handlers into `explorer.js`, and Stats filters and
media-link handlers into `stats.js`. It is not the six-load benchmark or a settled-shell
budget measurement.

## Chrome results

| Route | Expected module | Render result | Console errors/warnings |
| --- | --- | --- | --- |
| `/about` | Neither `explorer.js` nor `stats.js` | About rendered with Manual Watch count 5 and Sync - Idle | 0 |
| `/movies` | `explorer.js` | Movies library rendered with search, size, and sort controls | 0 |
| `/history` | `explorer.js` and its Stats dependency | Watch History rendered with search, filter, and media rows | 0 |
| `/stats` | `stats.js` | Stats rendered with media and period controls plus report content | 0 |

## Verification

- Focused route/lazy-graph and startup suites: 24/24 passed.
- `node --check` passed for `app-events.js`, `explorer.js`, and `stats.js`.
- `npm run build`: 1,014/1,014 tests passed, documentation consistency passed, asset
  version checks passed (`312` literal and `48` dynamic references), and the Plembfin
  build check passed.
- `git diff --check`: passed.

The six-load, provider-quiet TTFB, TV-detail inventory, mutating-action, and settled
critical-shell gates remain open.
