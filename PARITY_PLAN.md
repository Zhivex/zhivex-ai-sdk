# TypeScript vs Python Parity Plan

This document compares the current TypeScript SDK in this repository against the Python SDK in `../zhivex-ai-sdk-py` and defines the shortest path to reach feature parity or exceed it.

Scope date: 2026-04-29

## Executive Summary

The TypeScript SDK is already strong in package architecture, provider modularity, gateway composition, and the shared cross-provider contract.

The TypeScript SDK has closed the first agent-platform foundation gaps. The remaining work is less about basic runtime parity and more about richer SDK primitives for tools, safety policies, observability, evaluation, and provider conformance.

- richer tool platform primitives
- reusable safety and budget policy helpers
- replay/debug helpers for agent traces
- evaluation harnesses for agent regressions
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
| Agent runtime | yes | yes | Strong parity |
| Agent suspend/resume for approvals | yes | yes | Strong parity |
| Agent handoffs | yes | yes | Strong parity |
| Agent memory | in-memory + file + sqlite + postgres | in-memory + sqlite + postgres | Strong parity |
| Agent run persistence | in-memory + file + sqlite + postgres + idempotency + cancellation | in-memory + sqlite + postgres | Strong parity |
| MCP tool integration | yes | yes | Partial |
| Shared tool registry model | tool registry + MCP registry | richer registry surface | Partial |
| Guardrails | yes | yes | Strong parity |
| Approval policies for local tools | yes | yes | Strong parity |
| Shared sessions | serializable run state + live runtime | first-class | Strong parity |
| Realtime / live voice | yes | yes | Strong parity |
| Observability / OTEL helpers | telemetry hooks + OTEL helpers | explicit OTEL observer | Strong parity |
| Stability / support docs | Stable/Beta/Experimental + support docs | explicit Stable/Beta/Experimental + support docs | Strong parity |
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
- Durable agent run primitives: schema-versioned state, idempotency-key lookup, cooperative cancellation, and in-memory/file/SQLite/Postgres stores

## Main Remaining Gaps

### 1. Tool platform depth

The next SDK gap is a richer tool platform surface: remote HTTP tools, stronger typed registry metadata, permission presets, tool audit metadata, and first-class test utilities for tool definitions.

### 2. Safety and budget policy helpers

The runtime has guardrails and local approval policies. The next layer should add reusable presets for secrets/PII redaction, dangerous-tool approvals, per-run budgets, tool-call limits, and timeout/retry policy composition.

### 3. Replay, debugging, and evaluation

The SDK emits telemetry and serializable run state, but agent teams still need replay helpers, mock providers/tools, dataset runners, judge helpers, and regression reports to validate agent changes before release.

### 4. Agent platform narrative

Python presents the SDK as an agent platform:

- sessions
- registries
- traces
- summaries
- checkpoints
- live runtime flows

TypeScript now contains the core building blocks. The remaining work is to package the SDK story around production agent services without turning this repository into a UI or control plane.

## Priority Roadmap

## P0: Runtime foundation - complete

Completed foundation items:

- `STABILITY.md`, `SUPPORT.md`, and `VERSIONING.md`
- SQLite and Postgres run/memory stores
- first-class input and output guardrails
- local tool approval policies
- realtime sessions and `streamLiveAgent()`
- OTEL-oriented helpers
- schema-versioned `AgentRunState`
- idempotency-key support on built-in run stores
- cooperative `cancelAgentRun()`

## P1: Tool platform SDK-first - complete

The experimental tool platform layer is now available without changing the stable `ToolSet` contract.

- `createAdvancedToolRegistry()` and `AdvancedToolRegistry`
- advanced entries with `source`, `permissions`, and `audit` metadata
- `createHttpTool()` for fetch-backed remote HTTP tools
- `testToolDefinition()` and `testToolRegistry()` for local validation
- `createToolTestFixture()`, `recordToolTestFixture()`, and `runToolTestFixture()` for fixture-based tool regression tests
- `createToolPermissionPreset()` for reusable permission/audit presets
- `inspectToolRegistry()` for portable registry metadata
- conversion back to stable `ToolSet`

Expected outcome:

- app teams can combine and validate tools without inventing their own registry, permission, and audit conventions

## P2: Safety and budget policy helpers - complete

- `createSafetyPolicy()` composes approvals, redaction, budget guards, tool execution defaults, and existing guardrails.
- `createApprovalPolicy()` ships `permissive`, `review-sensitive`, and `locked-down` presets.
- `createRedactionPolicy()` covers common secrets and optional email/custom regex redaction.
- `createBudgetGuard()` enforces step, tool-call, tool-error, and token usage limits.
- `applySafetyPolicyToAgent()` wraps agent definitions without mutating the original agent.

Expected outcome:

- production agent services can adopt default safety controls without building every policy hook from scratch

## P2b: Provider agent parity - complete

- `inspectProviderAgentSupport()` normalizes runtime model capabilities into agent-platform readiness fields.
- `createProviderSupportMatrix()` creates a serializable matrix from models or model entries.
- Provider contract tests continue to validate declared agent tiers and capabilities.

Expected outcome:

- provider/model choices can be validated from SDK capabilities instead of copying README tables into downstream apps

## P3: Replay, debugging, and evaluation - complete

- `createAgentRunSnapshot()` and dry `replayAgentRun()` inspect saved `AgentRunState` without executing effects.
- `createMockLanguageModel()` and `createMockTool()` support deterministic tests.
- `runAgentEvaluation()` runs dataset cases against agents or agent factories.
- `createAgentEvaluationFixture()` and `runAgentEvaluationFixture()` make datasets reproducible.
- `createAgentEvaluationReport()` creates exportable regression summaries.
- `judgeAgentEvaluation()` supports deterministic judges and optional `LanguageModel` judges.

Expected outcome:

- agent behavior can be tested and debugged as an SDK workflow, not only inside a downstream app

## P4: Better-than-Python platform surface

These are the opportunities where TypeScript can surpass Python rather than just match it.

- TypeScript becomes the best SDK choice for app teams building agent products on web and server runtimes

## Suggested Work Breakdown

### Phase 1: Runtime foundation - complete

- Stability/support/versioning docs
- Durable stores
- Guardrails
- Local approval policies
- Realtime/live runtime
- OTEL helpers
- Idempotency and cooperative cancellation

### Phase 2: Tool platform

- remote HTTP tools - complete
- richer registry metadata - complete
- tool test helpers - complete
- registry documentation - complete

### Phase 3: Safety and budgets

- policy presets - complete
- redaction helpers - complete
- runtime/budget caps - complete
- dangerous-tool approval defaults - complete

### Phase 4: Replay and evaluation

- deterministic mock providers/tools - complete
- replay from run state - complete
- dataset runner helpers - complete
- evaluation fixtures and reports - complete
- optional model judge helpers - complete

### Phase 5: Observability depth - complete

- exportable agent trace artifacts
- live trace collector from agent telemetry
- token cost estimates
- latency and run summaries

### Phase 6: Native subagent orchestration - complete

- `AgentDefinition.subagents` exposes specialist agents as compatible callable tools.
- `createSubAgentTool()` supports standalone subagent tool composition.
- Parent states record `childRuns`, and child states preserve `parentRunId`.
- Replay and trace artifacts include subagent child-run links.
- shared budgets include child-run metrics by default
- built-in stores support parent/child lookup
- `cancelAgentRunTree()` provides durable cascade cancellation
- hierarchical tree snapshots and traces export full parent/child run trees
- evaluation helpers include child-run expectations and report totals
- `runAgentGroup()` supports explicit parallel fan-out from application code
- `prepareSubagentsForAgent()` shares operational defaults without mutating definitions

## Proposed Definition Of Done

The TypeScript SDK should be considered at least equal to Python when all of the following are true:

- TypeScript has explicit `STABILITY`, `SUPPORT`, and `VERSIONING` docs
- agent persistence includes file, sqlite, postgres, idempotency, and cooperative cancellation
- first-class guardrails and approval policies exist
- realtime and live-agent support are public and documented
- observability includes an OTEL-ready path plus exportable trace/cost artifacts
- provider support and feature-tier expectations are documented and tested
- safety policies and provider parity helpers are stable public APIs

The TypeScript SDK should be considered better than Python when, in addition:

- the public typed API is simpler to integrate
- UI streaming and web transport are stronger
- provider and tool capability inspection is more ergonomic
- tool testing, replay, and evaluation helpers are first-class
- safety policies are reusable SDK primitives instead of downstream glue
- trace/cost summaries are reusable SDK primitives instead of downstream glue
- provider parity rendering and drift reports are reusable SDK primitives
- native subagent orchestration is available without building a separate control plane
- app teams can build production agent systems with less custom glue code

## Recommended Immediate Next Steps

1. Release channel decision: choose stable, beta, rc, or next before versioning
2. Versioning dry run: apply `bun run version-packages` only when the release channel is chosen
3. Provider parity follow-up: optional README generation from rendered runtime matrix
4. Evaluation follow-up: richer judge adapters and run diff helpers
5. Tool platform follow-up: deeper MCP/hosted-tool metadata
6. Observability follow-up: optional exporters for external trace stores

## Notes

This plan intentionally does not recommend copying Python one-to-one. The right goal is:

- parity where the Python surface is materially better
- TypeScript-native ergonomics where Node/Bun can be better

The existing architecture in this repository is already good enough to support that direction without a large rewrite.
