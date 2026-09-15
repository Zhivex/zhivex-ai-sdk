# Agents and Gateway offline baseline

SDK-AGW-HU-03 measures local orchestration using deterministic fixtures. It does not measure provider performance or monetary cost.

```sh
bun run build
node scripts/benchmarks/agents-gateway.mjs --matrix=full --repetitions=5 --warmup=1 --seed=42 --output=artifacts/agw-node-1.json
node scripts/benchmarks/agents-gateway.mjs --matrix=full --repetitions=5 --warmup=1 --seed=42 --output=artifacts/agw-node-2.json
bun scripts/benchmarks/agents-gateway.mjs --matrix=full --repetitions=5 --warmup=1 --seed=42 --output=artifacts/agw-bun-1.json
bun scripts/benchmarks/agents-gateway.mjs --matrix=full --repetitions=5 --warmup=1 --seed=42 --output=artifacts/agw-bun-2.json
```

The default pilot has 28 cases; the full matrix has 126: text, stream, tools, group, fallback, compaction and checkpoints; 1/10/100 model steps; 64/1024-byte tool or prompt payloads; concurrency 1/4/16. Steps for simple text/stream/fallback mean repeated requests per task. Steps for agents mean one multistep run. Group concurrency is member count. These are distinct workloads; compare identical fixture keys only.

Every trial asserts the answer, total model calls, tool effects, failed attempts and (where relevant) usage, unique member runs and compaction. Errors stop the runner without publishing a successful report. Inputs have hard limits: 100 steps, 16 concurrent tasks, 4096 payload bytes, 20 repetitions, five warmups and a ten-minute run deadline checked between trials. There are no network providers or credentials.

Reports include source SHA, dirty status, runtime, machine, fixture seed, warmups/repetitions, and SHA-256 of runner, lockfile, catalog source and built agent/gateway runtime. Keep the JSON and Markdown together. Build immediately before measurement to align source and dist. Raw trials record wall/CPU time, RSS before/after, model/store cumulative time, logical checkpoint bytes and count, first-text latency for streams, correct tasks and effects. The summary computes nearest-rank p50/p95, throughput and observed p95/p50 variability.

The store is in-memory. Checkpoint bytes are the serialized state presented at write boundaries, not physical disk writes. Store time includes the instrumentation's serialization and the store's copies. The residual wall time subtracts the union of model/store intervals; it includes SDK work plus harness overhead. RSS is process-wide at trial boundaries, not a per-request peak. Stream time covers generator lifetime including consumer pauses. These boundaries prevent treating summed overlapping durations as exclusive wall time.

For a proposed regression band, compare two runs on the same runtime and machine: use the maximum of their p95 values and their absolute p95 difference as an observed noise envelope. Freeze that per-fixture envelope before measuring a candidate; flag a candidate p95 above `max(baseline p95) + abs(baseline p95 difference)` for investigation, never as an automatic performance failure. Five repetitions give a preliminary band, not a reliable tail estimate. Increase repetitions and repeat on a quiet dedicated runner before adopting a CI performance gate. Do not compare Node and Bun as if they were repeated samples of the same environment.

Produce the proposed observed bands mechanically after each pair:

```sh
node scripts/benchmarks/compare-baselines.mjs artifacts/agw-node-1.json artifacts/agw-node-2.json artifacts/agw-node-bands.json
node scripts/benchmarks/compare-baselines.mjs artifacts/agw-bun-1.json artifacts/agw-bun-2.json artifacts/agw-bun-bands.json
```

The comparison rejects different source/runtime/environment/fixture metadata. The runner rejects source-commit or hashed-artifact changes during measurement. Run sequentially with no builds or tests competing for CPU; run-level process isolation does not isolate the host from unrelated activity.

The [2026-09-14 artifacts](./benchmarks/2026-09-14/README.md) retain the initial matrices and checkpoint before/after measurements. Reproduce the serialization experiment with `node scripts/benchmarks/checkpoint-serialization.mjs /tmp/checkpoint.json` after building the desired revision. It counts full-state JSON serialization, includes instrumentation overhead, and validates model/tool effects before reporting.
