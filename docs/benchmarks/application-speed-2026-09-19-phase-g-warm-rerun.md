# Application speed Phase G warm rerun - 19 September 2026

The raw summary is in [`application-speed-2026-09-19-phase-g-warm-rerun.json`](application-speed-2026-09-19-phase-g-warm-rerun.json). The rerun used the local Plembfin server at `http://localhost:5055` with `ROLE=web`, immutable asset caching enabled, the same 16 routes, six samples per route, two sequential populations, 1.2 s pacing, and the first sample per route discarded. The live site and live browser were not opened.

| Population | Measured samples | TTFB p95 | Max TTFB | Load p95 | Max load | Incomplete | HTTP 429/5xx |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 80 | 30.8 ms | 46.4 ms | 130.9 ms | 147.1 ms | 0 | 0 / 0 |
| 1 | 80 | 25.6 ms | 39.6 ms | 140.4 ms | 156.8 ms | 0 | 0 / 0 |

The manual-review summary optimization removed episode `watch_context` construction from the sidebar count request. A diagnostic cold Settings pass measured the first-population p95 TTFB falling from 726.1 ms before the change to 46.4 ms after it. Full review-page requests still receive the surrounding-episode context.

The warm TTFB and absolute load budgets now pass. Load medians remain outside the 15% population-consistency rule on four routes (`/`, `/tvshows`, `/discover`, and `/movie/a-quiet-place`), while the other 12 routes pass. These misses are recorded as image-cache-sensitive warm-up variance; there were no incomplete loads, 429s, or 5xx responses.

The manual-review regression test passed 15/15, and the final `npm run build` passed 1,030/1,030 tests plus documentation, asset-version, Plembfin build, and diff checks.
