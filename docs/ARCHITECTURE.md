# SDK architecture

## Dependency direction

Provider adapters translate external protocols into Core contracts. Core does not import provider packages. SDK and Agents are application facades over Core; Gateway composes its runtime rather than defining a second agent loop.

| Entry | Purpose | Runtime boundary |
| --- | --- | --- |
| `@zhivex-ai/core/contracts` | Shared types | Type-only |
| `@zhivex-ai/core/runtime` | Portable primitives | No transitive Node built-ins |
| `@zhivex-ai/core/provider` | Adapter helpers, HTTP parsing, SSE, message normalization | Server-side; no persistence or agent orchestration |
| `@zhivex-ai/core/agents` | Agent runtime and safety | Server-side; no storage backends or default catalog |
| `@zhivex-ai/core/generation` | Generation and model wrapping | Server-side; no persistence, agent orchestration, or default catalog |
| `@zhivex-ai/core/catalog` | Catalog contracts and factory | No default inventory |
| `@zhivex-ai/sdk/catalog` | Release-managed catalog | SDK-owned provider fragments |
| `@zhivex-ai/core` / `node` | Compatibility aggregation | Complete server surface |

`@zhivex-ai/sdk/runtime` delegates to Core generation. New adapters should import runtime helpers from `core/provider` and types from `core/contracts`. Existing roots remain supported. All provider packages, including Qwen, use the focused helper or contract imports. The Agents root facade remains server-side and re-exports from `core/agents`; operational subpaths continue to expose their separate server surfaces.

## Internal persistence modules

Agent stores, workflow state services, and artifact services each have separate `memory`, `file`, `sqlite`, and `postgres` modules. Their `shared` modules own normalization and common validation. The original modules remain compatibility facades; internal backend modules are not supported deep imports.

Database and memory implementations do not load filesystem modules or sibling backends. Store-key hashing is separate from private file operations. File generation caching is also separate from runtime middleware. This is a dependency refactor: schemas, keys, CAS, leases, retention, and file permissions retain their existing behavior.

## Compatibility and validation

Public re-exports preserve function identity. Entrypoint tests validate runtime classification and dependency boundaries; installed-package checks validate emitted exports. Backend behavior remains covered by the existing agent, workflow, artifact, concurrency, and security suites. Public type snapshots must be reviewed separately from implementation paths.

The legacy Core default catalog stays frozen until the documented major-version removal boundary. It must not be updated alongside SDK inventory.

## Agent runtime and shared contracts

`agent.ts` is a compatibility facade over the internal `agent/` modules. Execution and streaming share context resolution, approval handling, state persistence, telemetry, guardrails, tool journaling, compaction, and lease/cancellation helpers. Recursive subagent calls stay with the execution loop to avoid circular runtime imports. The extraction preserves the run-view streaming and realtime work already present in the runtime.

`types.ts` is a type-only compatibility facade over `types/`. Domains separate common values, messages, stream events, media, provider resources, generation, persisted agent state, persistence contracts, agent definitions, middleware, and UI. Mutually recursive model/tool/realtime contracts stay together in `model-tools.ts`; this keeps domain dependencies acyclic without weakening types or changing public signatures. These internal paths are not supported consumer deep imports.

Dependency and facade-identity tests guard these boundaries. All public root and focused imports retain their existing names and schemas.

## Documentation ownership

The root README is the entry point. Application guides own adoption and operational guidance; `docs/reference/` contains extended API recipes. Historical reports record dated evidence, not current certification. [Release procedures](./maintainers/RELEASE.md) have one canonical home; [versioning policy](../VERSIONING.md) defines bump decisions.
