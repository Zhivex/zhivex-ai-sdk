# Vertex verification

The [internal historical archive in Notion](https://www.notion.so/418777b104f681a089c1c27e90679725) retains the 2026-09-19 implementation snapshot, blockers and delivery follow-up. It is historical and requires workspace access.

For public technical boundaries and remaining limitations, use the [provider verification table](../../packages/vertex/README.md#verification-and-remaining-limits) and the generated [catalog matrix](./VERTEX_CATALOG_MATRIX.md). Factory construction and successful transport responses do not establish live certification or output quality. Training, tuning, deployment/evaluation administration and MLOps are outside the documented adapter scope.

## Reproduce package and transport evidence

Use Bun for repository commands:

```bash
bun run typecheck
bun run test --maxWorkers=2
bun run build
bun run docs:check
bun scripts/vertex-package-smoke.ts --versioned
```

The package smoke prints its disposable consumer directory. Use that directory
with the transport smoke to test the installed artifact and its dependency graph:

```bash
bun scripts/vertex-grpc-transport-smoke.ts --consumer /absolute/consumer
node --experimental-strip-types scripts/vertex-grpc-transport-smoke.ts --consumer /absolute/consumer
```

The Node flag runs the internal TypeScript test script; the package itself is
compiled JavaScript. The transport smoke creates a local TLS server and removes
its temporary certificates. It does not call Google or create cloud resources.
