# Application speed Phase A matrix - 18 September 2026

This is the first repeatable warm authenticated matrix after the startup/cache fixes. It
covers six navigations for the 12 main routes plus Ludwig, Reacher, Bad Grandpa, and A Quiet
Place in two isolated Chrome-tab populations. The raw summary is in the companion JSON.

| Route | Repeat A median load / p95 | Repeat B median load / p95 | Repeat A median TTFB | Repeat B median TTFB |
| --- | ---: | ---: | ---: | ---: |
| `/` | 260 / 1,563 ms | 299 / 6,940 ms | 14 ms | 68 ms |
| `/movies` | 1,001 / 1,110 ms | 1,367 / 2,156 ms | 748 ms | 926 ms |
| `/tvshows` | 928 / 1,918 ms | 1,723 / 2,957 ms | 456 ms | 1,176 ms |
| `/upcoming` | 377 / 1,472 ms | 1,284 / 2,150 ms | 14 ms | 955 ms |
| `/discover` | 280 / 1,468 ms | 863 / 1,348 ms | 14 ms | 570 ms |
| `/watchlist` | 651 / 2,557 ms | 503 / 1,782 ms | 389 ms | 246 ms |
| `/ratings` | 518 / 570 ms | 520 / 545 ms | 256 ms | 254 ms |
| `/custom-lists` | 614 / 1,693 ms | 535 / 565 ms | 298 ms | 266 ms |
| `/history` | 1,777 / 2,072 ms | 1,572 / 2,024 ms | 1,449 ms | 1,318 ms |
| `/stats` | 651 / 3,075 ms | 581 / 1,706 ms | 405 ms | 314 ms |
| `/settings` | 566 / 673 ms | 472 / 561 ms | 289 ms | 200 ms |
| `/about` | 548 / 1,802 ms | 534 / 562 ms | 300 ms | 267 ms |
| Ludwig (TV) | 820 / 1,550 ms | 933 / 2,617 ms | 606 ms | 657 ms |
| Reacher (TV) | 958 / 2,190 ms | 943 / 983 ms | 699 ms | 651 ms |
| Bad Grandpa (movie) | 932 / 1,454 ms | 629 / 2,444 ms | 17 ms | 372 ms |
| A Quiet Place (movie) | 342 / 1,536 ms | 674 / 9,068 ms | 15 ms | 369 ms |

## Gate result

The matrix is now repeatable enough to diagnose the next bottleneck, but it does not pass the
release gate. The two populations are not within 15% on several routes, and the second run
contains a 6.94-second dashboard load and a 9.07-second A Quiet Place load. A few samples were
incomplete under contention; they remain explicitly counted in the JSON rather than filled in.

The result confirms that the redundant history shows rebuild and delayed worker pollers reduced
some startup work, but provider/background contention still causes the remaining p95 stalls.
Decoded-byte, paint, and pure cold-cache/SPA populations are still outstanding.
