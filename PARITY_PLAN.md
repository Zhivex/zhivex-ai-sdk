# TypeScript vs Python Parity Plan

This document compares the current TypeScript SDK in this repository against the Python SDK in `../zhivex-ai-sdk-py` and defines the shortest path to reach feature parity or exceed it.

Scope date: 2026-04-15

## Executive Summary

The TypeScript SDK is already strong in package architecture, provider modularity, gateway composition, and the shared cross-provider contract.

The Python SDK is currently ahead in product maturity for agent workloads. Its advantages are not mostly in the basic generation surface, but in the higher-level platform story around:

- explicit stability and support policy
- richer agent runtime features
- durable storage options
- realtime/live voice support
- observability surface
- broader tests and operational documentation

The TypeScript SDK should aim for:

1. feature parity on the stable agent/platform surface
2. clearer public contract and support policy
3. better-than-Python ergonomics for Node/Bun production users

## Scorecard

Legend:

- `Strong`: already competitive or better
- `Partial`: present but narrower than Python
- `Gap`: missing or not yet productized

| Area | TypeScript SDK | Python SDK | Assessment |
| --- | --- | --- | --- |
| Core text generation | yes | yes | Strong parity |
| Streaming text | yes | yes | Strong parity |
| Structured output | yes | yes | Strong parity |
| Embeddings | yes | yes | Strong parity |
| Audio transcription / speech | yes | yes | Strong parity |
| Grounded text | yes | yes | Strong parity |
| Provider adapters | yes | yes | Strong parity |
| Gateway routing / fallback | yes | yes | Strong parity |
| Agent runtime | yes | yes | Partial |
| Agent suspend/resume for approvals | yes | yes | Strong parity |
| Agent handoffs | yes | yes | Strong parity |
| Agent memory | in-memory + file | in-memory + sqlite + postgres | Partial |
| Agent run persistence | in-memory + file | in-memory + sqlite + postgres | Partial |
| MCP tool integration | yes | yes | Partial |
| Shared tool registry model | basic MCP toolset | richer registry surface | Partial |
| Guardrails | no first-class API | yes | Gap |
| Approval policies for local tools | not first-class | yes | Gap |
| Shared sessions | limited through run state | first-class | Partial |
| Realtime / live voice | no public equivalent found | yes | Gap |
| Observability / OTEL helpers | telemetry hooks and middleware | explicit OTEL observer | Partial |
| Stability / support docs | not explicit enough | explicit Stable/Beta/Experimental + support docs | Gap |
| Packaging modularity | monorepo, per-package npm publishing | single PyPI package | TypeScript stronger |
| Public API modularity | very strong | strong | TypeScript stronger |
| Test breadth | good but narrower | broader | Partial |
| Release readiness narrative | changesets-ready, but less product messaging | strong product/release contract | Partial |

## What TypeScript Already Does Very Well

- Clean split between `@zhivex-ai/core`, `@zhivex-ai/sdk`, providers, and `@zhivex-ai/gateway`
- Thin adapter strategy that keeps provider logic out of shared contracts
- Strong shared contracts for generation, tools, streaming, embeddings, audio, and grounding
- Good gateway story, including agent-aware routing
- Good approval-aware remote MCP flow for Tier A providers
- Good file-backed and in-memory primitives for a first version of agent persistence

## Main Gaps vs Python

### 1. Stability and product contract

Python has a clearer promise to downstream consumers with:

- `STABILITY.md`
- `SUPPORT.md`
- `VERSIONING.md`
- `CHANGELOG.md`
- production-facing guidance

TypeScript has strong code and release mechanics, but not yet the same public contract.

### 2. Durable agent state

TypeScript currently exposes:

- `createInMemoryAgentRunStore()`
- `createFileAgentRunStore()`
- `createInMemoryAgentMemoryStore()`
- `createFileAgentMemoryStore()`

Python goes further with ready-made durable stores for:

- sqlite
- postgres

That difference matters for production adoption.

### 3. Guardrails and local approval policies

Python has first-class concepts for:

- input guardrails
- output guardrails
- tool approval policies
- permission-aware tool execution

TypeScript has approval handling for provider-driven MCP approval requests, but does not yet expose the same first-class runtime controls for local tools and safety policy hooks.

### 4. Realtime and live voice

Python exposes a public realtime layer and live-agent support.

TypeScript currently has strong streaming, but not the same public realtime/live voice platform surface.

### 5. Observability

TypeScript has telemetry hooks and middleware, which is a good base.

Python is ahead in productization because it also offers an explicit observability entrypoint and OTEL-oriented story for agent runs.

### 6. Agent platform narrative

Python presents the SDK as an agent platform:

- sessions
- registries
- traces
- summaries
- checkpoints
- live runtime flows

TypeScript already contains several building blocks, but the surface still reads more like an SDK with agent features than a full agent platform.

## Priority Roadmap

## P0: Match Python on product maturity

These items should come first because they improve trust and adoption even before new runtime features ship.

- Add `STABILITY.md` to define `Stable`, `Beta`, and `Experimental` surfaces for TypeScript.
- Add `SUPPORT.md` to define provider support tiers and expectations.
- Add `VERSIONING.md` to explain changeset-driven compatibility and release rules.
- Expand `README.md` with a narrower, explicit stable surface section.
- Add a generated or maintained support matrix per provider and feature tier.

Expected outcome:

- downstream consumers know what is safe to build on
- npm releases feel intentional, not just technically publishable

## P1: Close the biggest runtime gaps

These are the highest-value functional gaps against Python.

- Add `createSqliteAgentRunStore()` and `createSqliteAgentMemoryStore()`
- Add `createPostgresAgentRunStore()` and `createPostgresAgentMemoryStore()`
- Add first-class input and output guardrails to the agent runtime
- Add local tool approval policies for SDK-defined tools
- Add a first-class tool registry abstraction above raw MCP toolsets when multiple tool sources are combined

Expected outcome:

- TypeScript becomes viable for production agent systems without forcing users to build core persistence and policy layers themselves

## P2: Realtime and observability parity

- Add a public realtime abstraction for providers that support bidirectional realtime sessions
- Add `streamLiveAgent()` or equivalent live-agent runtime for voice-first workflows
- Add an OTEL helper package or core helper for agent spans and lifecycle events
- Expand telemetry event coverage and document recommended ingestion patterns

Expected outcome:

- TypeScript reaches Python parity for interactive and voice-first systems

## P3: Better-than-Python platform surface

These are the opportunities where TypeScript can surpass Python rather than just match it.

- First-class edge/runtime-safe adapters for Bun, Node, and fetch-native environments
- Better typed policy system for guardrails, approvals, and tool permissions
- Better UI transport story for React/Next.js/SSE/Web Streams
- Stronger plugin model for combining local tools, hosted tools, and MCP with typed capability inspection
- More opinionated testing harness for provider contract conformance

Expected outcome:

- TypeScript becomes the best SDK choice for app teams building agent products on web and server runtimes

## Suggested Work Breakdown

### Phase 1: Contract and maturity

- Add `STABILITY.md`
- Add `SUPPORT.md`
- Add `VERSIONING.md`
- tighten README around supported public surface

### Phase 2: Durable stores

- add sqlite stores in `packages/core`
- add postgres stores in `packages/core` or a dedicated storage package if dependency isolation matters
- add tests covering resume, memory load/save, and concurrent runs

### Phase 3: Runtime policy layer

- introduce `InputGuardrail`, `OutputGuardrail`, and approval policy types
- wire guardrail lifecycle into `runAgent()` and `streamAgent()`
- expose telemetry for guardrail triggers and approval decisions

### Phase 4: Realtime platform

- add realtime model/session contracts to `packages/core`
- implement OpenAI and Gemini first
- add live-agent orchestration on top

### Phase 5: Product polish

- OTEL helpers
- richer examples
- provider parity tests
- release checklist for stable vs experimental surfaces

## Proposed Definition Of Done

The TypeScript SDK should be considered at least equal to Python when all of the following are true:

- TypeScript has explicit `STABILITY`, `SUPPORT`, and `VERSIONING` docs
- agent persistence includes sqlite and postgres options
- first-class guardrails exist for agent input and output
- first-class approval policies exist for local tools
- realtime and live-agent support are public and documented
- observability includes an OTEL-ready path
- provider support and feature-tier expectations are documented and tested

The TypeScript SDK should be considered better than Python when, in addition:

- the public typed API is simpler to integrate
- UI streaming and web transport are stronger
- provider and tool capability inspection is more ergonomic
- app teams can build production agent systems with less custom glue code

## Recommended Immediate Next Steps

1. Ship the maturity contract docs first: `STABILITY.md`, `SUPPORT.md`, `VERSIONING.md`
2. Implement sqlite stores next because they unlock durable local workflows with low integration cost
3. Add guardrails and local approval policies before expanding the agent platform further
4. Add realtime only after the persistence and policy model is stable

## Notes

This plan intentionally does not recommend copying Python one-to-one. The right goal is:

- parity where the Python surface is materially better
- TypeScript-native ergonomics where Node/Bun can be better

The existing architecture in this repository is already good enough to support that direction without a large rewrite.
