import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import { buildForceSyncPlan } from "../server/src/utils/forceSyncPlanner.js";
import { mediaKeyFor } from "../server/src/utils/dataRepo.js";

const scale = Math.max(1, Math.min(Number(process.env.BENCHMARK_ITEMS || 100), 100000));
const started = performance.now();
const items = Array.from({ length: scale }, (_, index) => ({ title: `Benchmark ${index}`, type: "movie", source: "plex", timestamp: new Date().toISOString() }));
const historyRows = items.map((item, index) => ({ id: String(index), media_key: mediaKeyFor(item), title: item.title, media_type: item.type, sync_action: "watched", watched_at: new Date().toISOString() }));
const plan = buildForceSyncPlan({ itemsByServer: { plex: items, emby: [], jellyfin: [] }, scannedServers: ["plex", "emby"], historyRows });
const result = { version: 1, generatedAt: new Date().toISOString(), workload: { items: scale }, planningDurationMs: performance.now() - started, actions: plan.actions.length, summary: plan.summary };
const output = process.env.BENCHMARK_OUTPUT || "docs/benchmarks/local.json";
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
