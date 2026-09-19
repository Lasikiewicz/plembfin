# Application speed Phase B mixed follow-up

This 18 September 2026 follow-up ran two navigations for each of the 12 main routes and
four representative media routes in an isolated Chrome tab after the startup, Up Next, and
changelog deferrals. Thirty-one loads completed and one `/movies` attempt exhausted the
CDP event window; no completed load exceeded five seconds.

The slowest completed route was `/history` at 2,327 ms load / 1,846 ms TTFB. Other routes
under two seconds included `/`, `/movies`, Ludwig, Reacher, and both movie pages. TV Shows,
Upcoming, Discover, Watchlist, and History still have TTFB above the 500 ms budget, and the
sample is only two loads per route, so this is evidence of improvement, not a passing gate.

Raw route medians are in
[`application-speed-2026-09-18-phase-b-mixed-followup.json`](application-speed-2026-09-18-phase-b-mixed-followup.json).
