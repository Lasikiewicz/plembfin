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

**One scale limit is worth knowing before reading a result.** The in-memory history cache
reads the newest 25,000 watch rows (`MAX_HISTORY_LIMIT` in
[`dataRepo.js`](../server/src/utils/dataRepo.js)). Above that, the surfaces derived from
it - the dashboard preview, watch stats, and the TV Shows library - describe that window
rather than the whole library, and a show whose episodes all fall outside the window drops
out of the TV Shows listing. The Movies library is queried separately and is not capped.
The benchmark report records where a library sits against that ceiling.
