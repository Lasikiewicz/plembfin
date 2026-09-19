# Application speed Phase G warm document matrix - 18 September 2026

This is the durable warm-cache follow-up to the Phase G matrix. The raw result is in
[`application-speed-2026-09-18-phase-g-warm-matrix.json`](application-speed-2026-09-18-phase-g-warm-matrix.json).

## Method

- Direct Playwright control of the existing authenticated Plembfin page at `http://localhost:5055`.
- `ROLE=web` with `PLEMBFIN_DEV_NO_CACHE_ASSETS=0`, so immutable versioned assets could remain warm.
- Six document loads per route, two sequential populations, with the first sample per route discarded.
- Sixteen routes: the twelve main routes plus Ludwig, Reacher, Bad Grandpa, and A Quiet Place.
- Each navigation used a unique `?bench=` query, waited for a quiet resource window, and captured timing,
  requests, transfer, decoded bytes, API/image counts, and detail readiness.

## Population results

| Population | Measured samples | Incomplete | Loads over 5 s | Max load | TTFB p95 | Max TTFB | Max requests |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 96 | 0 | 0 | 3,163.9 ms | 1,009.3 ms | 2,400.2 ms | 154 |
| 1 | 96 | 0 | 0 | 342.4 ms | 39.1 ms | 262.7 ms | 152 |

Both populations had zero HTTP 429s, zero HTTP 5xx responses, and no failed samples. The second
population is stable, but the first-population startup outlier means the warm run does not close the
plan's two-population consistency gate. The result is retained as evidence of a server/cache warm-up
effect, not as a passing budget claim.

The per-route population median ranges were 34.9-76.8 ms load, 6.3-47.4 ms TTFB, and 32-152
requests in population 0; population 1 was 34.7-60.2 ms load, 5.8-31.7 ms TTFB, and 36-152
requests. The raw samples are the source of truth for route-level comparisons.
