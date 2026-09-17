# SDK-TS external-effect reconciliation regression

This fixture derives from ZHX-EXP-001 v0.3 A3/A4, baseline source
`6577e2aefc0d80ebf1e996a656508a766b508734`. The original experiment directory
and baseline are unchanged. The synthetic order service uses SQLite WAL/FULL,
holds the HTTP response after committing the mutation, and kills the Node worker
with SIGKILL. Recovery first demonstrates a technically completed run with typed
`needs_reconciliation`, then verifies the external receipt and continues via the
public SDK API. A3 kills/reloads the approval checkpoint and denies the mutation.

Run in an isolated consumer directory, installing a freshly built core tarball
with Bun, along with Zod. Copy `runner.ts`, `worker.ts`, `fixture.ts`, and
`evaluator.ts` there. Keep the core tarball at
`artifacts/zhivex-ai-core-1.17.0.tgz` for the manifest hash. Install it under a
SHA256-based filename to avoid Bun reusing a cached local tarball with the same
name/version. Verify the installed `dist/agent-reconciliation.js` bytes against
the candidate build before running:

```sh
bun build worker.ts --target=node --packages=external --outdir=dist
bun run runner.ts
```

The consumer needs `package.json`, `bun.lock`, Node, and permission to bind a
loopback HTTP socket. Default matrix: 10 cases × 3 repetitions × A3/A4 = 60.
`CASES=1 REPETITIONS=1` runs a pilot. Output is written under `runs/`, with
`latest-zhivex.json` pointing to the finished run. The checked-in `evidence/`
contains final results, summary, and artifact/runtime/code hashes. This is an
offline correctness fixture; it does not certify live providers or npm publication.
The task outcome supplements the independent order/attempt oracle. Mutant POST
attempts are counted independently of the service's own idempotency protection.

Core unit tests additionally cover mismatched/untrusted evidence, contradictory
reconciliation, concurrent callers, journal CAS, lost ownership, and recovery
between the durable decision and state projection. SDK contract tests ensure that
technical completion with pending reconciliation never passes evaluation.
