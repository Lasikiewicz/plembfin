# Application speed follow-up - 18 September 2026

This Chrome pass repeated all 12 main routes and four representative media pages six
times each in two sequential warm populations. The first sample per route was discarded.
It is a current diagnostic artifact, not a release-gate result: both populations used one
authenticated tab, and no primary-data-ready milestone was captured.

| Route | A median load / p95 | B median load / p95 | A median TTFB / p95 | B median TTFB / p95 |
| --- | ---: | ---: | ---: | ---: |
| `/` | 168 / 825 ms | 97 / 107 ms | 35 / 582 ms | 8 / 10 ms |
| `/movies` | 95 / 114 ms | 66 / 74 ms | 9 / 32 ms | 8 / 8 ms |
| `/tvshows` | 168 / 234 ms | 67 / 80 ms | 31 / 117 ms | 9 / 9 ms |
| `/upcoming` | 114 / 230 ms | 91 / 506 ms | 10 / 31 ms | 8 / 407 ms |
| `/discover` | 147 / 495 ms | 151 / 189 ms | 20 / 408 ms | 22 / 85 ms |
| `/watchlist` | 90 / 114 ms | 118 / 141 ms | 17 / 24 ms | 11 / 23 ms |
| `/ratings` | 91 / 135 ms | 106 / 114 ms | 19 / 21 ms | 29 / 32 ms |
| `/custom-lists` | 110 / 111 ms | 102 / 476 ms | 22 / 26 ms | 13 / 22 ms |
| `/history` | 560 / 637 ms | 548 / 716 ms | 403 / 543 ms | 395 / 551 ms |
| `/stats` | 85 / 648 ms | 88 / 101 ms | 7 / 582 ms | 10 / 21 ms |
| `/settings` | 86 / 109 ms | 96 / 111 ms | 18 / 22 ms | 8 / 13 ms |
| `/about` | 85 / 91 ms | 73 / 377 ms | 15 / 17 ms | 8 / 314 ms |
| Ludwig (TV) | 218 / 392 ms | 214 / 236 ms | 126 / 289 ms | 124 / 141 ms |
| Reacher (TV) | 83 / 268 ms | 208 / 449 ms | 11 / 126 ms | 111 / 306 ms |
| Bad Grandpa (movie) | 69 / 77 ms | 68 / 77 ms | 8 / 9 ms | 8 / 11 ms |
| A Quiet Place (movie) | 69 / 79 ms | 68 / 79 ms | 9 / 9 ms | 8 / 8 ms |

The document-load and TTFB results are substantially better than the earlier contention
matrix, but the spread between populations and the settled decoded/request totals mean the
benchmark gates are still open. The slowest current document sample was below five seconds,
but that is not sufficient to close the required isolated-population protocol. TV-detail
primary-ready timing, request inventories, and Slow 4G Settings verification remain open.
