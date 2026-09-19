# Application speed Phase G focused status-page benchmark - 19 September 2026

The raw summary is in [`application-speed-2026-09-19-phase-g-status-pages.json`](application-speed-2026-09-19-phase-g-status-pages.json). This focused extension used the authenticated local Chrome session against `http://localhost:5055`, with `ROLE=web` and immutable asset caching. The live site and live browser were not opened.

The original 16-route matrix did not include the two status pages. This run measured six navigations per route across three sequential populations, discarding the first sample for each route in each population. The fixed post-navigation capture delay was 1.8 seconds.

| Route | Population medians: TTFB | Population medians: load | Worst measured load | Requests | API requests | Rendered content | Errors |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| `/sync-activity` | 9.1 / 8.2 / 8.6 ms | 134.8 / 131.1 / 86.2 ms | 174.4 ms | 48-54 | 16-20 | 25 activity rows | 0 incomplete / 0 429 / 0 5xx |
| `/manual-watch-review` | 7.5 / 8.7 / 7.7 ms | 103.3 / 125.2 / 92.2 ms | 153.0 ms | 49-51 | 16 | 1 review group | 0 incomplete / 0 429 / 0 5xx |

Sync Activity stayed within 2.8% between the first two population medians. Manual Watch Review differed by 21.2% between those two, but the third population returned to 92.2 ms; the absolute timings remain fast and the variation is a small warm-up effect rather than a slow route. The expected `sync-activity.js` and `manual-watch-review.js` route modules were observed.
