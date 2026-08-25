# Stability

Zhivex AI SDK for TypeScript uses three stability levels so downstream consumers can understand which surfaces are intended to remain predictable over time.

Supported public imports should come from published package entrypoints such as:

- `@zhivex-ai/sdk`
- `@zhivex-ai/core`
- `@zhivex-ai/agents`
- `@zhivex-ai/react`
- `@zhivex-ai/openai`
- `@zhivex-ai/xai`
- `@zhivex-ai/meta`
- `@zhivex-ai/azure-openai`
- `@zhivex-ai/anthropic`
- `@zhivex-ai/gemini`
- `@zhivex-ai/vertex`
- `@zhivex-ai/bedrock`
- `@zhivex-ai/ollama`
- `@zhivex-ai/openrouter`
- `@zhivex-ai/qwen`
- `@zhivex-ai/kimi`
- `@zhivex-ai/deepseek`
- `@zhivex-ai/zai`
- `@zhivex-ai/gateway`

Focused published entrypoints are also supported: `@zhivex-ai/core/contracts`,
`@zhivex-ai/core/runtime`, `@zhivex-ai/core/workflows`, `@zhivex-ai/core/ui`,
`@zhivex-ai/core/node`, `@zhivex-ai/core/testing`,
`@zhivex-ai/sdk/runtime`, `@zhivex-ai/sdk/workflows`, `@zhivex-ai/sdk/ui`,
`@zhivex-ai/sdk/evals`, `@zhivex-ai/sdk/catalog`, `@zhivex-ai/sdk/beta`, and
`@zhivex-ai/sdk/experimental`. The package roots remain backward compatible.

Deep imports from internal files are not part of the stable contract unless this document names an explicit exception.

Related documents:

- [README.md](./README.md)
- [SUPPORT.md](./SUPPORT.md)
- [VERSIONING.md](./VERSIONING.md)

## Stable Release Boundary

The verifiable runtime boundary for `@zhivex-ai/core` is `API_STABILITY_MANIFEST`, exported from both `@zhivex-ai/core` and `@zhivex-ai/sdk`.

Use these helpers when checking a public symbol:

```ts
import { getApiStability, listApiStability } from "@zhivex-ai/sdk";

getApiStability("generateText")?.stability; // "stable"
listApiStability("beta");
```

The manifest classifies runtime exports as `stable`, `beta`, or `experimental`. Contract tests fail if `packages/core/src/index.ts` adds a runtime export that is not classified. Type-only exports are guarded separately by declaration snapshots for `@zhivex-ai/core` and `@zhivex-ai/sdk`; intentional public type changes should update those snapshots and the relevant docs together.

The stable boundary includes shared generation, media, agent runtime, realtime sessions and live agents, safety, evaluation, replay, trace, Runner/session APIs, declarative workflows, every built-in workflow state service, workflow evaluation gates, the Artifact Service, Model Catalog, OpenTelemetry adapters, the `zhivex-ai` CLI, and the dedicated Agent Control Plane contract listed by the manifest. Provider-native resource helpers remain Beta. Advanced tool registry helpers remain Experimental.

The current stable npm package is published under the `latest` dist-tag. Install it with `@zhivex-ai/sdk`. Use `@next` only for prerelease validation.

## Stable

These APIs are the supported public contract for application code and production integrations:

- Text generation: `generateText`, `streamText`
- Structured output: `generateObject`, `streamObject`
- Grounded text: `generateGroundedText`
- Embeddings: `embed`, `embedMany`
- Audio: `transcribeAudio`, `generateSpeech`, `streamSpeech`
- Generative media: `generateImage`, `generateVideo`, `generateMusic`
- Agent runtime: `createAgent`, `runAgent`, `resumeAgent`, `streamAgent`
- Realtime/live runtime: `CallbackRealtimeSession`, `streamLiveAgent`, browser-safe frame encoders, and the default WebSocket transport helpers
- Runner/session APIs: `createRunner`, in-memory/file/SQLite/Postgres `SessionService` implementations, `AgentSession`, `SessionEvent`, session schema v1 normalization/migration helpers, and file-backed session pruning helpers
- Declarative workflows: `createWorkflow`, `runWorkflow`, `replayWorkflowRun`, sequential/parallel/loop step contracts, approval resume, schema-versioned `WorkflowRunState`, and its normalization/migration helpers
- Workflow state: the `WorkflowStateService` contract, `loadWorkflowState`, `saveWorkflowState`, schema-versioned records and migration helpers, plus the in-memory, file-backed, SQLite, and Postgres implementations
- Workflow evaluation: datasets, fixtures, reports, deterministic/model judges, report diffs, versioned deterministic baselines, and fail-closed regression gates
- Artifact Service: schema-versioned JSON and binary records, in-memory/file/SQLite/Postgres services, bounded payload policies, integrity verification, external references, local inspection/cleanup/pruning, and explicit workflow artifact helpers
- Model Catalog: immutable provider-scoped snapshots, aliases, recommendations, versioned pricing metadata, and explicit pinned/rolling data policy
- OpenTelemetry adapters: the versioned GenAI mapping, `createOtelObserver`, `createOtelAgentObserver`, `createOtelTelemetryMiddleware`, `createOtelWorkflowObserver`, trace-context hierarchy, recommended runtime metrics, streaming timing, and documented privacy defaults
- CLI / Dev UX: the installed `zhivex-ai` command grammar, schema-backed JSON output, fail-closed argument validation, local workflow execution and inspection commands, and dry-run-by-default pruning
- Agent Control Plane: capsules, approval queues, ledgers, capability routing, tool policy, control-plane run/resume/stream operations, schema normalization/migration, and durable single-consumer approval resume exported from `@zhivex-ai/agents/control-plane`
- Agent persistence contracts: `AgentRunStore`, `AgentMemoryStore`
- Durable agent helpers: `cancelAgentRun`, schema-versioned `AgentRunState`, and `idempotencyKey` support on built-in run stores
- Native subagent helpers: `AgentDefinition.subagents`, `createSubAgentTool`, `prepareSubagentsForAgent`, `runAgentGroup`, `AgentRunInput.parentRunId`, `AgentRunState.childRuns`, `AgentRunStore.findByParentRunId`, shared child-run budget accounting, and `cancelAgentRunTree`
- Agent replay and evaluation helpers: `createAgentRunSnapshot`, `replayAgentRun`, `createMockLanguageModel`, `createMockTool`, `runAgentEvaluation`, `createAgentEvaluationFixture`, `runAgentEvaluationFixture`, `createAgentEvaluationReport`, multi-agent child-run expectations, and `judgeAgentEvaluation`
- Agent trace and cost helpers: `createAgentTraceArtifact`, `createAgentRunTreeSnapshot`, `createHierarchicalAgentTrace`, `createAgentTraceCollector`, `summarizeAgentTrace`, `estimateTokenCost`, and `estimateAgentRunCost`
- Safety/policy helpers: `createSafetyPolicy`, `createApprovalPolicy`, `createRedactionPolicy`, `createBudgetGuard`, and `applySafetyPolicyToAgent`
- Typed failures: `ProviderToolCallError` and its sanitized durable `AgentRunError` projection
- Provider parity helpers: `inspectProviderAgentSupport`, `createProviderSupportMatrix`, `renderProviderSupportMatrix`, and `createProviderSupportDriftReport`
- Default agent stores: in-memory, file-backed, SQLite, and Postgres run and memory stores
- MCP integration: `createMcpToolSet`
- Gateway: `createGateway` and its documented request/response surface
- Middleware helpers for caching, circuit breaking, telemetry, and model wrapping
- UI and SSE helpers exported from `@zhivex-ai/sdk` and `@zhivex-ai/core`
- React chat state, transport, and component APIs exported from `@zhivex-ai/react`
- Core shared types that are exported from package entrypoints

The stable surface is intentionally narrower than the total number of exported symbols. Stable means Zhivex should avoid unnecessary breaking changes and should document meaningful behavior changes in release notes and changesets.

## Beta

These APIs are supported and documented, but they may still change between minor releases as the SDK matures:

- Agent telemetry event details and observer patterns
- File workflow-state pruning
- Hosted-tool classification helpers
- Gateway route metadata and policy selection ergonomics
- Callable-provider construction and explicit merged-abort cleanup
- Discriminated model capability profiles and legacy-capability derivation
- Comparative model evaluation suites, scorers, reports, comparisons, and gates

New application code can import these runtime values explicitly from
`@zhivex-ai/sdk/beta` so the compatibility risk is visible at the import site.

Beta APIs still require changelog-quality release notes when they change, but they do not yet carry the same compatibility expectations as the stable surface.

`createModelResolver()` and `ModelResolutionError` are Beta and are exposed from
`@zhivex-ai/sdk/beta`. The resolver is an optional, instance-local
`provider/model` lookup over an injected catalog and explicit adapters/backend;
direct provider factories remain the canonical Stable path.

## Experimental

These areas are available for evaluation, but they should not be treated as long-term compatibility contracts yet:

- Provider-native hosted tools and escape hatches that do not map cleanly to the shared contract
- Advanced tool registry helpers: `createAdvancedToolRegistry`, `AdvancedToolRegistry`, `createHttpTool`, `testToolDefinition`, `testToolRegistry`, `createToolTestFixture`, `recordToolTestFixture`, `runToolTestFixture`, `createToolPermissionPreset`, and `inspectToolRegistry`
- Provider-specific `providerOptions` shapes beyond the documented shared behavior
- Explicit raw provider-option passthrough created with `experimentalRawProviderOptions()`
- Agent/provider features currently described as support-tier dependent

Experimental areas may change faster than the rest of the SDK. Production adopters should isolate them behind an application-owned service layer.
The same runtime cohort is available from `@zhivex-ai/sdk/experimental`.

## Provider Scope

The SDK aims to keep the application-facing contract stable, but capability parity is not identical across providers.

For production work, prefer:

- Tier A providers when you need approvals, remote MCP, or the strongest hosted-agent story
- Tier B providers when you want strong portable tool-using agents with fewer hosted-agent guarantees
- Tier C providers when basic loops are enough and expectations are narrower

Provider support tiers are documented in [SUPPORT.md](./SUPPORT.md) and summarized in the repository README.

The shared realtime/live contract is Stable, while individual provider model IDs and upstream preview availability remain provider-scoped. Production releases must rerun the fail-closed Gemini/Qwen/OpenAI live gate and the installed-tarball smoke described in [the maintainer certification guide](./docs/maintainers/AGENT_REALTIME_CERTIFICATION.md).
