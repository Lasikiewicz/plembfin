# Stats Page

The `/stats` view: all-time, yearly, and monthly watch reports — KPI cards,
leaderboards, movies-vs-TV split, platform breakdown, first/last plays, and a monthly
activity chart.

## Files

| File | Role |
| --- | --- |
| `public/modules/stats.js` | All stats rendering and period/filter logic |
| `server/src/index.js` | `handleHistory` — stats are served from `GET /api/history?stats=only` |
| `server/src/utils/dataRepo.js` | `getWatchStats` — computes the full stats payload |
| `public/app.js` | Route `/stats` → stats view |

## Data flow

One request — `GET /api/history?stats=only` — returns everything the page needs
(`getWatchStats` in `dataRepo.js`, memoized against `dataVersion` like the other
derived caches):

- totals: watch count, unique movies, TV episodes tracked
- `sourceBreakdown` — per-platform counts
- `topShows` / top movies leaderboards
- `monthlyActivity` — counts per calendar month
- `reports` — one pre-computed report per period: `all`, each year, each month, so
  changing the period filter never re-queries the server

The payload lands in `state.stats`; `loadStats({ force })` skips the fetch when already
loaded and history hasn't changed.

## Frontend behavior (`stats.js`)

- **Period picker** — all time / a year / a month (`state.statsPeriodType` /
  `statsPeriodValue`, options built by `syncStatsPeriodOptions` from the available
  reports; `selectedStatsReport()` picks the active one).
- **Media filter** — all / movies / shows (`state.statsMediaFilter`,
  `statsFilteredRows`).
- **Sections** — intro cards (`statsIntroCards`), KPI tiles (`renderStatsKpis`),
  poster-backed leaderboards (`renderStatsLeaderboard`, `renderRankingTable`),
  movies-vs-TV split (`renderStatsMoviesTvSplit`), platform rows
  (`renderStatsPlatformRows`), first/last plays (`renderStatsBookends`), and the
  month chart (`renderMonthChart`).
- Leaderboard posters hydrate through the standard poster pipeline
  ([posters-artwork.md](posters-artwork.md)).

## Gotchas

- All filtering happens client-side against the pre-computed reports; if a new
  breakdown is needed, extend `getWatchStats` server-side rather than fetching raw
  history into the page.
- Mobile (≤ 760px) must be re-verified after any stats layout change — the stats grid
  has broken on mobile after desktop-only redesigns before.
