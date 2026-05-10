# Stability

Zhivex AI SDK for TypeScript uses three stability levels so downstream consumers can understand which surfaces are intended to remain predictable over time.

Supported public imports should come from published package entrypoints such as:

- `@zhivex-ai/sdk`
- `@zhivex-ai/core`
- `@zhivex-ai/openai`
- `@zhivex-ai/azure-openai`
- `@zhivex-ai/anthropic`
- `@zhivex-ai/gemini`
- `@zhivex-ai/vertex`
- `@zhivex-ai/bedrock`
- `@zhivex-ai/ollama`
- `@zhivex-ai/openrouter`
- `@zhivex-ai/qwen`
- `@zhivex-ai/kimi`
- `@zhivex-ai/gateway`

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

This stable boundary promotes only the Runner/session family to Stable. Workflows, artifacts, workflow state services, durable artifact helpers, CLI inspection/execution UX, and their schema/versioning helpers remain Beta. Advanced tool registry helpers remain Experimental.

The current stable npm package is published under the `latest` dist-tag. Install it with `@zhivex-ai/sdk`. Use `@next` only for prerelease validation.

## Stable

These APIs are the supported public contract for application code and production integrations:

- Text generation: `generateText`, `streamText`
- Structured output: `generateObject`, `streamObject`
- Grounded text: `generateGroundedText`
- Embeddings: `embed`, `embedMany`
- Audio: `transcribeAudio`, `generateSpeech`
- Agent runtime: `createAgent`, `runAgent`, `resumeAgent`, `streamAgent`
- Runner/session APIs: `createRunner`, in-memory/file/SQLite/Postgres `SessionService` implementations, `AgentSession`, `SessionEvent`, session schema v1 normalization/migration helpers, and file-backed session pruning helpers
- Agent persistence contracts: `AgentRunStore`, `AgentMemoryStore`
- Durable agent helpers: `cancelAgentRun`, schema-versioned `AgentRunState`, and `idempotencyKey` support on built-in run stores
- Native subagent helpers: `AgentDefinition.subagents`, `createSubAgentTool`, `prepareSubagentsForAgent`, `runAgentGroup`, `AgentRunInput.parentRunId`, `AgentRunState.childRuns`, `AgentRunStore.findByParentRunId`, shared child-run budget accounting, and `cancelAgentRunTree`
- Agent replay and evaluation helpers: `createAgentRunSnapshot`, `replayAgentRun`, `createMockLanguageModel`, `createMockTool`, `runAgentEvaluation`, `createAgentEvaluationFixture`, `runAgentEvaluationFixture`, `createAgentEvaluationReport`, multi-agent child-run expectations, and `judgeAgentEvaluation`
- Agent trace and cost helpers: `createAgentTraceArtifact`, `createAgentRunTreeSnapshot`, `createHierarchicalAgentTrace`, `createAgentTraceCollector`, `summarizeAgentTrace`, `estimateTokenCost`, and `estimateAgentRunCost`
- Safety/policy helpers: `createSafetyPolicy`, `createApprovalPolicy`, `createRedactionPolicy`, `createBudgetGuard`, and `applySafetyPolicyToAgent`
- Provider parity helpers: `inspectProviderAgentSupport`, `createProviderSupportMatrix`, `renderProviderSupportMatrix`, and `createProviderSupportDriftReport`
- Default agent stores: in-memory, file-backed, SQLite, and Postgres run and memory stores
- MCP integration: `createMcpToolSet`
- Gateway: `createGateway` and its documented request/response surface
- Middleware helpers for caching, circuit breaking, telemetry, and model wrapping
- UI and SSE helpers exported from `@zhivex-ai/sdk` and `@zhivex-ai/core`
- Core shared types that are exported from package entrypoints

The stable surface is intentionally narrower than the total number of exported symbols. Stable means Zhivex should avoid unnecessary breaking changes and should document meaningful behavior changes in release notes and changesets.

## Beta

These APIs are supported and documented, but they may still change between minor releases as the SDK matures:

- Agent telemetry event details and observer patterns
- Declarative workflow APIs: `createWorkflow`, `runWorkflow`, `replayWorkflowRun`, schema-versioned workflow state helpers, dedicated `WorkflowStateService` implementations, workflow artifact helpers, sequential workflow types, parallel workflow groups, loop workflow steps, workflow evaluation/report helpers, and workflow evaluation diff helpers
- Artifact service APIs: `createInMemoryArtifactService`, `createFileArtifactService`, `createSqliteArtifactService`, `createPostgresArtifactService`, `createBase64ArtifactData`, schema-versioned artifact records, binary artifact helpers, `ArtifactService`, and `ArtifactRecord`
- Schema/versioning and migration helpers for Beta artifact, workflow run, and workflow state records
- Artifact integrity verification, external artifact references, file artifact cleanup/pruning helpers, and workflow state pruning helpers
- CLI / Dev UX: the `zhivex-ai` local inspection and local workflow execution CLI, including workflow artifact save, workflow state inspection, and evaluation report compare commands
- OTEL observability helpers
- Model catalog helpers
- Hosted-tool classification helpers
- Gateway route metadata and policy selection ergonomics

Beta APIs still require changelog-quality release notes when they change, but they do not yet carry the same compatibility expectations as the stable surface.

## Experimental

These areas are available for evaluation, but they should not be treated as long-term compatibility contracts yet:

- Provider-native hosted tools and escape hatches that do not map cleanly to the shared contract
- Advanced tool registry helpers: `createAdvancedToolRegistry`, `AdvancedToolRegistry`, `createHttpTool`, `testToolDefinition`, `testToolRegistry`, `createToolTestFixture`, `recordToolTestFixture`, `runToolTestFixture`, `createToolPermissionPreset`, and `inspectToolRegistry`
- Provider-specific `providerOptions` shapes beyond the documented shared behavior
- Agent/provider features currently described as support-tier dependent
- Future realtime or live-agent surfaces until they are explicitly promoted

Experimental areas may change faster than the rest of the SDK. Production adopters should isolate them behind an application-owned service layer.

## Provider Scope

The SDK aims to keep the application-facing contract stable, but capability parity is not identical across providers.

For production work, prefer:

- Tier A providers when you need approvals, remote MCP, or the strongest hosted-agent story
- Tier B providers when you want strong portable tool-using agents with fewer hosted-agent guarantees
- Tier C providers when basic loops are enough and expectations are narrower

Provider support tiers are documented in [SUPPORT.md](./SUPPORT.md) and summarized in the repository README.
