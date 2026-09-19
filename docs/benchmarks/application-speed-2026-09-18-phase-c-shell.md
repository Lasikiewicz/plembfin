# Phase C shell probe - 18 September 2026

This probe checks the post-split dashboard shell separately from the deferred route graph.
It used the authenticated Chrome session against `http://localhost:5055/` and read Chrome
Navigation/Resource Timing through CDP after the page had settled for 3.5 seconds.

| Measure | Result |
| --- | ---: |
| Static `modulepreload` declarations | 13 (baseline 46) |
| Document TTFB | 12.7 ms |
| Document load event | 545.9 ms |
| Document transfer / decoded | 31.5 KB / 223.4 KB |
| Resources after 3.5 s | 133 |

## Critical shell snapshots

| Resource start cutoff | Requests | Transfer | Decoded | Budget result |
| ---: | ---: | ---: | ---: | --- |
| 50 ms | 16 | 473.7 KB | 1.52 MB | Pass |
| 100 ms | 17 | 474.0 KB | 1.52 MB | Pass |
| 200 ms | 22 | 511.3 KB | 1.66 MB | Pass |
| 300 ms | 29 | 531.5 KB | 1.80 MB | Decoded budget exceeded |

The 200 ms snapshot is the selected critical-shell checkpoint because the dashboard is
already rendered and deferred imports begin after the initial shell work. The full settled
resource count is kept visible so deferred work is not hidden in the budget accounting.

Chrome smoke verification also rendered Dashboard, Movies, and Settings; a back/forward
transition returned to Dashboard and Settings respectively. A clean-start log window had
zero new console errors or warnings.

This is a shell-budget result, not a completion of the full Phase C/Phase G matrix. The
remaining work is the six-load route/media matrix and the TV-detail request budget.
