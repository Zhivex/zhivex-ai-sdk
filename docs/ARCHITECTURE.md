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
| `@zhivex-ai/core/evals` | Evaluation helpers | No persistence backends or default inventory |
| `@zhivex-ai/core/realtime` | Live agent runtime | No persistence backends or default inventory |
| `@zhivex-ai/core/control-plane` | Agent governance | Explicit control-plane surface |
| `@zhivex-ai/core/ops` | Persistence, tracing and operational helpers | Server-side; includes backends intentionally |
| `@zhivex-ai/core/beta` / `experimental` | Existing maturity cohorts | Compatibility surfaces without root aggregation |
| `@zhivex-ai/core/provider-google` | Legacy Google hosted-tool bridge | Shared by Gemini and Vertex; no new native policy |
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

## Provider implementation boundaries

Core, OpenAI and Azure share `streamChatCompletions` for stream parsing and tool assembly. Authentication, endpoints, model capabilities and request mapping remain adapter-owned. See the [stream contract](../packages/openai/README.md#chat-completions-stream-contract) for terminal usage and tool validation. Internal implementation modules are not public deep imports.

The existing Google hosted-tool helpers are available from Gemini and Vertex. Core keeps their original implementation and exports as a compatibility bridge so function identity and both hosts remain supported without a reverse dependency. The helpers retain their Experimental classification and host/model limitations; exports alone do not establish model support. New native helpers and configurations belong to provider packages. Removing the legacy bridge requires a separately planned compatibility boundary.

Dependency tests traverse static and literal dynamic imports, check external dependency edges explicitly, and validate focused consumer facades. A dynamically loaded storage driver remains an allowed operational dependency, not proof of browser portability.

## Model policy and maintenance

Model inventory and serving policy have separate owners. SDK catalog fragments own aliases, pricing, lifecycle, limits and provenance. Provider-local model profiles own capabilities, reasoning controls, protocol selection and request restrictions for the actual API host. Adapters never import the SDK inventory. OpenAI keeps family policy in `model-profiles.ts`; Gemini's current text profiles drive both advertised reasoning efforts and generation/interaction validation. Gemini also separates message/schema mapping, usage normalization and media encoding from its root implementation. Internal profile and mapping modules are not public deep imports.

Unrecognized OpenAI and OpenRouter language model IDs use conservative capabilities. Explicit provider configuration can declare verified private-model capabilities or opt into historical assumptions during migration. Recognition is not live certification, and catalog presence does not establish support for every operation. SDK consumer tests check that unverified tool routes fail before network requests and that explicitly declared models work without catalog registration.

Gateway applies catalog lifecycle before constructing candidate models across generation, streaming and agent operations. Deployment-scoped retirement overrides are explicit trusted configuration. Evidence routing uses task quality profiles instead of name heuristics; the legacy routing mode remains available, and adaptive routing continues to use measured signals. Detailed cost accounting and scalar rate budgets remain distinct contracts.

The maintenance-only registry in `scripts/provider-registry.ts` generates CLI package/default metadata and catalog fragment composition. `bun run provider:check` verifies generated files and package inventories against Gateway IDs, factory exports and TypeScript references. Published packages do not load the registry. Versioning regenerates CLI versions from package manifests. See [model onboarding](./maintainers/MODEL_ONBOARDING.md) for the update workflow.

## Documentation ownership

The root README is the entry point. Application guides own adoption and operational guidance; `docs/reference/` contains extended API recipes. Historical reports record dated evidence, not current certification. [Release procedures](./maintainers/RELEASE.md) have one canonical home; [versioning policy](../VERSIONING.md) defines bump decisions.
