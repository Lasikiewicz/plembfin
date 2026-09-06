# Sync capacity guidance

Plembfin publishes measured ranges rather than a universal library limit. Run
`BENCHMARK_ITEMS=1000 node scripts/benchmark-sync.js` with the deployment's normal
Node.js and storage configuration, and keep the workload and environment beside the
result. Larger or provider-heavy installations should use a Force Sync preview and a
smaller scope before expanding coverage.

The in-app health endpoint reports current history scale, matching failures, and outbound
pressure. Being outside the tested range is guidance to reduce scope or enrich less; it
does not disable synchronization.

## Measuring a library larger than yours

`scripts/generate-synthetic-library.js` builds a disposable library at a stated scale,
and `scripts/benchmark-surfaces.js` records the server-side surfaces against it:

```bash
node scripts/generate-synthetic-library.js --data-dir /tmp/plembfin-scale --movies 6000 --shows 1200 --episodes-per-show 24 --history-rows 90000
node scripts/benchmark-surfaces.js --data-dir /tmp/plembfin-scale --runs 5 --output docs/benchmarks/surfaces-scale.json
```

The generator writes only to the directory it is given and refuses one holding a database
it did not create. Results land in `docs/benchmarks/`, each carrying the library scale and
the hardware it was taken on, so a number always travels with its workload.

**One scale limit is worth knowing before reading a result.** The Movies and TV Shows
libraries and the dashboard preview read the whole watch history and are not capped.
**Watch stats are.** `getWatchStats` loads rows through `loadHistoryRows`, which clamps to
`MAX_HISTORY_LIMIT` (25,000, in [`dataRepo.js`](../server/src/utils/dataRepo.js)), so a
library holding more than 25,000 watches reports its totals, per-period reports and source
breakdown over the newest 25,000 rows rather than over everything. On a 90,000-row test
library that means Stats reports 25,000 lifetime watches. Nothing warns about this on
screen; the benchmark report records where a library sits against the ceiling.

Reading the full history instead of a 25,000-row window costs memory and rebuild time, and
both grow with the library. Measured on a 90,000-row library (6,000 movies, 1,200 shows,
28,800 episodes): heap after building every derived cache rose from 221.2MB to 283.7MB, the
history cache build from 107.4ms to 392.5ms, and the TV Shows build from 362.7ms to
1,002.4ms. A library below the ceiling pays none of this, because the cap never engages.
