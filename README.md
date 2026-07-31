# Zhivex AI SDK

[![CI](https://img.shields.io/github/actions/workflow/status/Zhivex/zhivex-ai-sdk/ci.yml?branch=main&label=CI)](https://github.com/Zhivex/zhivex-ai-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40zhivex-ai%2Fsdk)](https://www.npmjs.com/package/@zhivex-ai/sdk)
[![provenance](https://img.shields.io/badge/npm-provenance-blue)](https://www.npmjs.com/package/@zhivex-ai/sdk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Provider-agnostic TypeScript SDK for generation, streaming, tools, multimodal
AI, routing, React chat, and durable agents across modern LLM providers.

Zhivex keeps application orchestration above the provider layer. Use one
normalized contract for portable workloads, then opt into provider-native
capabilities explicitly when a workload needs them.

## Start Here

- [Quickstart](./docs/QUICKSTART.md)
- [Agents guide](./docs/AGENTS.md)
- [Next.js guide](./docs/NEXTJS.md)
- [Production guide](./docs/PRODUCTION.md)
- [Workflows guide](./docs/WORKFLOWS.md)
- [Observability guide](./docs/OBSERVABILITY.md)
- [RAG guide](./docs/RAG.md)
- [Examples](./examples/README.md)
- [Public roadmap](./ROADMAP.md)

## Installation

Install the high-level SDK and only the providers your application uses:

```bash
bun add @zhivex-ai/sdk @zhivex-ai/openai
```

For the shared low-level contract:

```bash
bun add @zhivex-ai/core @zhivex-ai/openai
```

## Quick Start

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Describe provider-agnostic AI in one sentence."
});

console.log(result.text);
console.log(result.usage);
```

The result uses normalized messages, usage, finish reasons, tool results, and
execution steps regardless of the selected provider.

## Why Zhivex

- **One application contract:** text, streaming, structured output, tools,
  embeddings, audio, multimodal input, retrieval, and UI streams.
- **Explicit portability:** portable APIs reject provider-only options instead
  of silently changing behavior.
- **Native escape hatches:** provider packages expose hosted tools, realtime,
  file, media, batch, and lifecycle APIs where supported.
- **Durable agents:** sessions, handoffs, approvals, replay, evaluation,
  persistence, artifacts, budgets, and hierarchical traces.
- **Production controls:** timeouts, retries, abort signals, circuit breakers,
  routing, fallback, redaction, telemetry, and idempotency.
- **Supply-chain integrity:** protected releases, trusted publishing, pinned
  GitHub Actions, registry verification, and npm provenance.

## Core Capabilities

| Area | Primary APIs |
| --- | --- |
| Generation | `generateText`, `streamText`, `generateObject`, `streamObject` |
| Tools | local tools, hosted tools, MCP, approvals, and multi-step loops |
| Agents | `Agent`, `Runner`, sessions, handoffs, subagents, replay, and stores |
| Workflows | sequential, parallel, loop, and durable workflow coordination |
| Multimodal | files, images, audio, embeddings, retrieval, and generative media |
| UI | SSE helpers, UI messages, transports, React controller and components |
| Routing | capability-aware selection, retries, budgets, and safe fallback |
| Operations | OpenTelemetry, traces, evaluation, redaction, and cost summaries |

## Supported Packages

### Main entry points

- `@zhivex-ai/sdk` — recommended unified application API
- `@zhivex-ai/core` — shared contracts and runtime primitives
- `@zhivex-ai/agents` — agent-first public facade
- `@zhivex-ai/react` — browser-safe chat state, transport, and components
- `@zhivex-ai/gateway` — routing and fallback helpers

### Provider packages

- `@zhivex-ai/openai`
- `@zhivex-ai/azure-openai`
- `@zhivex-ai/anthropic`
- `@zhivex-ai/gemini`
- `@zhivex-ai/vertex`
- `@zhivex-ai/bedrock`
- `@zhivex-ai/qwen`
- `@zhivex-ai/kimi`
- `@zhivex-ai/deepseek`
- `@zhivex-ai/openrouter`
- `@zhivex-ai/ollama`
- `@zhivex-ai/xai`
- `@zhivex-ai/meta`

Each package includes its own installation, authentication, capability, and
provider-specific examples. See [`packages/`](./packages) or the
[npm organization](https://www.npmjs.com/org/zhivex-ai).

## Provider Compatibility

The portable contract is strongest across OpenAI, Azure OpenAI, Anthropic,
Gemini, Vertex, Qwen, Kimi, DeepSeek, and vLLM-compatible deployments.
Bedrock, OpenRouter, Ollama, Meta, and xAI remain available through the
capabilities documented by their provider packages.

Provider support is intentionally capability-based. Before selecting a model,
review the package README and use the catalog or capability metadata instead
of assuming every provider exposes identical semantics.

<!-- provider-matrix:start -->
| Provider | `streamText` | Tools | `toolChoice` | Structured output | Embeddings | Audio in | Audio out | Realtime sessions | Browser tokens | Reasoning | Web search | Hosted tools / MCP | Agent tier |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | yes | yes | yes | native | yes | yes | yes | yes | yes | model-dependent; GPT-5.6 `max` / `pro` / context | yes | model-dependent Responses hosted tools including image generation, remote MCP, shell/apply patch harness | Tier A |
| xAI | yes | yes | yes | native | no | no | no | no | no | Grok 4.5 `low` / `medium` / `high` | yes | Responses Web Search, X Search, code execution, Collections search, Files API, prompt caching | Tier B |
| Meta | yes | yes | yes | native | no | no | no | no | no | `effort` | yes | Responses web search, tool search, Files API, prompt caching | Tier B |
| Azure OpenAI | yes | yes | yes | native | yes | yes | yes | yes | yes | `effort` | yes | model-dependent Responses hosted tools, remote MCP, shell/apply patch harness | Tier A |
| Anthropic | yes | yes | yes | native | no | no | no | no | no | Opus 5 `low` / `medium` / `high` / `xhigh` / `max` | yes | native MCP, web search, code execution | Tier B |
| Gemini | yes | yes | yes | native | yes | yes | yes | yes | yes | model-dependent | yes | native | Tier B |
| Vertex | yes | yes | yes | native | yes | yes | yes | yes | no | model-dependent | yes | native | Tier B |
| OpenRouter | yes | yes | yes | native | no | no | no | no | no | `effort` + `budgetTokens` | yes | server tools | Tier C |
| Qwen | yes | yes | yes | JSON object + schema prompt | yes | model-dependent | yes | yes | no | Responses effort / Chat budget | yes | Responses hosted tools; Cloud files, batch, multimodal embeddings, rerank, ASR, TTS, image, video, realtime | Tier B |
| Kimi | yes | yes | yes | native | no | no | no | no | no | K3 `max`; K2.x model-dependent | Formula tool | Formula tools via Chat Completions | Tier C |
| DeepSeek | yes | yes | yes | JSON object | no | no | no | no | no | `none` / `high` / `max` | no | no | Tier B |
| Bedrock | yes | yes | endpoint-dependent | native | no | no | no | no | no | endpoint-dependent | endpoint-dependent | Converse baseline or Mantle/OpenAI-compatible Responses hosted tools and remote MCP | Tier C / A by runtime |
| Ollama | yes | yes | no | native | yes | no | no | no | no | no | no | no | Tier C |
<!-- provider-matrix:end -->

## React Chat

`@zhivex-ai/react` provides a headless controller, bounded fetch/SSE transport,
accessible components, and an optional default theme:

```tsx
"use client";

import { ZhivexChat, useZhivexChat } from "@zhivex-ai/react";
import "@zhivex-ai/react/styles.css";

export function Chat() {
  const chat = useZhivexChat({ endpoint: "/api/chat" });
  return <ZhivexChat controller={chat} />;
}
```

Provider credentials, authorization, tools, and durable session state stay on
the server. See the [React package guide](./packages/react/README.md) and the
[Next.js example](./examples/next-runner/README.md).

## Gateway Routing

`@zhivex-ai/gateway` selects compatible models before execution, propagates
abort signals through timeouts and retries, and only falls back before a
stream has emitted its first event. Applications can require capabilities such
as tools, structured output, embeddings, media, or tool-choice support.

See the [gateway package guide](./packages/gateway/README.md).

## Stability And Support

Read [STABILITY.md](./STABILITY.md), [SUPPORT.md](./SUPPORT.md), and
[VERSIONING.md](./VERSIONING.md) before depending on beta or experimental
surfaces. Stable APIs are versioned; beta and experimental areas are labeled
and should be isolated behind application-owned boundaries.

Security-sensitive reports must use the repository's
[private vulnerability reporting flow](https://github.com/Zhivex/zhivex-ai-sdk/security/advisories/new).
See [SECURITY.md](./SECURITY.md) for scope and response expectations.

## Repository Layout

```text
packages/
  agents/
  anthropic/
  azure-openai/
  bedrock/
  core/
  deepseek/
  gateway/
  gemini/
  kimi/
  meta/
  ollama/
  openai/
  openrouter/
  qwen/
  react/
  sdk/
  vertex/
  xai/
docs/
examples/
scripts/
```

## Development

Requirements:

- Bun 1.3+
- Node.js 20+ for supported Node consumers

```bash
bun install
bun run docs:check
bun run typecheck
bun run test
bun run build
```

Provider integration tests and live smoke tests require explicit credentials
and are not part of the default offline suite.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) and the organization
[Code of Conduct](https://github.com/Zhivex/.github/blob/main/CODE_OF_CONDUCT.md).
Use [Discussions](https://github.com/Zhivex/zhivex-ai-sdk/discussions) for
questions and design proposals, and issues for reproducible defects or scoped
feature requests.

## License

[MIT](./LICENSE)
