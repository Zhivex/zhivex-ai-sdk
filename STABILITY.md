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

## Stable

These APIs are the supported public contract for application code and production integrations:

- Text generation: `generateText`, `streamText`
- Structured output: `generateObject`, `streamObject`
- Grounded text: `generateGroundedText`
- Embeddings: `embed`, `embedMany`
- Audio: `transcribeAudio`, `generateSpeech`
- Agent runtime: `createAgent`, `runAgent`, `resumeAgent`, `streamAgent`
- Agent persistence contracts: `AgentRunStore`, `AgentMemoryStore`
- Default agent stores: in-memory and file-backed run and memory stores
- MCP integration: `createMcpToolSet`
- Gateway: `createGateway` and its documented request/response surface
- Middleware helpers for caching, circuit breaking, telemetry, and model wrapping
- UI and SSE helpers exported from `@zhivex-ai/sdk` and `@zhivex-ai/core`
- Core shared types that are exported from package entrypoints

The stable surface is intentionally narrower than the total number of exported symbols. Stable means Zhivex should avoid unnecessary breaking changes and should document meaningful behavior changes in release notes and changesets.

## Beta

These APIs are supported and documented, but they may still change between minor releases as the SDK matures:

- Agent telemetry event details and observer patterns
- OTEL observability helpers
- Model catalog helpers
- Hosted-tool classification helpers and agent capability inspection helpers
- Gateway route metadata and policy selection ergonomics

Beta APIs still require changelog-quality release notes when they change, but they do not yet carry the same compatibility expectations as the stable surface.

## Experimental

These areas are available for evaluation, but they should not be treated as long-term compatibility contracts yet:

- Provider-native hosted tools and escape hatches that do not map cleanly to the shared contract
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
