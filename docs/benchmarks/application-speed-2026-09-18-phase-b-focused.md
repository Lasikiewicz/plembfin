# Application speed Phase B focused verification

Captured 18 September 2026 in an isolated Chrome tab against the warm authenticated
application at `http://localhost:5055/`.

This probe follows the worker-startup and Up Next stale-while-revalidate changes. It is
focused evidence, not a replacement for the six-load all-route Phase A matrix: it does not
include cold-cache, FCP/LCP, decoded-byte, or full-route coverage.

| Route | Runs | Median load | p95 load | Median TTFB | Requests | API requests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `/` | 5 | 923 ms | 1,361 ms | 642 ms | 110–113 | 21–24 |
| `/media/movie/a-quiet-place` | 5 | 932 ms | 2,209 ms | 659 ms | 113–116 | 21–22 |

The dashboard p95 improved from 2,806 ms immediately before the deferred cache-rebuild
change (and from 6,940 ms in the earlier matrix), but the TTFB budget and full Phase B gate
remain open. Raw values are in
[`application-speed-2026-09-18-phase-b-focused.json`](application-speed-2026-09-18-phase-b-focused.json).
