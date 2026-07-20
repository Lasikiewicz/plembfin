# Sync capacity guidance

Plembfin publishes measured ranges rather than a universal library limit. Run
`BENCHMARK_ITEMS=1000 node scripts/benchmark-sync.js` with the deployment's normal
Node.js and storage configuration, and keep the workload and environment beside the
result. Larger or provider-heavy installations should use a Force Sync preview and a
smaller scope before expanding coverage.

The in-app health endpoint reports current history scale, matching failures, and outbound
pressure. Being outside the tested range is guidance to reduce scope or enrich less; it
does not disable synchronization.
