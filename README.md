# Zhivex AI SDK

A TypeScript SDK for portable, durable AI agents — native provider features, your own database, and a stability contract you can check in code.

Switch models, not code. The same `generateText`, `streamText`, tools, and agents run on Bun and Node.js. Install only the adapters you use.

[![npm](https://img.shields.io/npm/v/@zhivex-ai/sdk)](https://www.npmjs.com/package/@zhivex-ai/sdk)
[![CI](https://github.com/Zhivex/zhivex-ai-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/Zhivex/zhivex-ai-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/Zhivex/zhivex-ai-sdk)](./LICENSE)
[![SLSA provenance](https://img.shields.io/badge/provenance-SLSA-blue)](https://www.npmjs.com/package/@zhivex-ai/sdk)

## Quick Start

Install the current release from the npm `latest` tag. The `next` tag can lag `latest`, so these commands install the current stable release.

```bash
bun add @zhivex-ai/sdk @zhivex-ai/openai
npm install @zhivex-ai/sdk @zhivex-ai/openai
```

pnpm and Yarn install the same packages. See the [consumer compatibility matrix](./SUPPORT.md#installation-and-consumer-compatibility). Keep provider keys on the server. Install `zod` when your app defines tool or object schemas. This is step 1 of the [Quickstart](./docs/QUICKSTART.md).

The call below is the same with OpenAI or Qwen. Only the model line changes. `gpt-6-astra` and `qwen3.8-flash` are both in the SDK catalog.

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
// import { createQwen } from "@zhivex-ai/qwen";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Set OPENAI_API_KEY in the server environment.");

const result = await generateText({
  model: createOpenAI({ apiKey })("gpt-6-astra"),
  // model: createQwen({ apiKey: process.env.QWEN_API_KEY })("qwen3.8-flash"),
  prompt: "Describe Zhivex AI SDK in one sentence."
});

console.log(result.text);
```

Server runtimes only: Node.js, Bun, route handlers, or workers. Browser clients call your backend. Bedrock requires Node.js 20+, and Vertex requires Node.js 22+. See [SUPPORT.md](./SUPPORT.md).

## Why Zhivex

1. **Portable.** The same `generateText`, `streamText`, tools, and agents. You change the adapter.
2. **Native provider features.** Qwen Cloud audio and realtime, DeepSeek FIM, Gemini and Vertex media, and Kimi Formula tools stay reachable on the shared contract.
3. **Durable on your own database.** Sessions and `resumeAgent` are stored in Postgres, SQLite, or a file you operate. Use `createPostgresSessionService()` in production. File stores are for local development.
4. **An honest stability contract.** Every runtime export is `stable`, `beta`, or `experimental`. `getApiStability()` reads that label, and CI fails if an export is unclassified. See [STABILITY.md](./STABILITY.md).

Human approval queues (`createAgentApprovalQueue`) are (beta).

## Providers

Capability differs by adapter. Tiers describe agent support in this SDK:

| Tier | Providers |
| --- | --- |
| Tier A | OpenAI, Azure OpenAI, and Bedrock with `runtime: "openai"` |
| Tier B | xAI, Meta, Anthropic, Gemini, Vertex, Qwen, DeepSeek, and Z.ai |
| basic (Tier C) | OpenRouter, Kimi, Ollama, and Bedrock Converse |

Tier A includes approval-capable hosted tools or remote MCP. Tier B is strong tool-using agent support with provider-specific gaps. basic (Tier C) covers basic tool loops. Many unsupported combinations are rejected before the request is sent.

The [full capability matrix](./docs/reference/PROVIDERS.md#provider-compatibility) is the source of truth.

## When to use Zhivex

Use Zhivex for a TypeScript service that calls more than one provider, needs those providers' native features, and stores agent sessions in a database you already operate.

| Choose | When it fits |
| --- | --- |
| Zhivex AI SDK | Portable generation and agents, native features on Qwen, DeepSeek, Kimi, Z.ai, Meta, and xAI, sessions in your own Postgres or SQLite, and a per-export stability manifest. |
| [Vercel AI SDK](https://ai-sdk.dev) | You want the largest provider ecosystem, `useChat` as the default UI, or durable human-in-the-loop inside Vercel Workflows (`WorkflowAgent`). |
| [Mastra](https://mastra.ai) | You want a full agent framework rather than a thin SDK layer. |
| [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) | The product stays on OpenAI, including that SDK's multi-agent, voice, and `RunState` approvals. |

Vercel AI SDK, Mastra, and OpenAI Agents also implement durable human-in-the-loop. Approvals here are (beta). Coming from Vercel AI SDK Core, start with the [migration guide](./docs/MIGRATION.md). An existing `useChat` UI can call a Zhivex backend through `@zhivex-ai/react/compat` (beta). The optional model resolver is (beta); see [MODEL_RESOLVER.md](./docs/MODEL_RESOLVER.md).

This SDK is server-side, and one person maintains it.

## The Zhivex family

**Powers Zhivex Code.** The coding agent and its governed runtime live in [Zhivex Harness](https://github.com/Zhivex/zhivex-harness). This SDK is the layer underneath: generation, tools, agents, sessions, and gateway.

The same concepts exist for Python in the [Zhivex AI SDK for Python](https://github.com/Zhivex/zhivex-ai-sdk-py) (`zhivex-ai-sdk` on [PyPI](https://pypi.org/project/zhivex-ai-sdk/)).

## Documentation

- [Docs site](https://sdk.zhivex.ai) and the [guide index](./docs/README.md)
- [Quickstart](./docs/QUICKSTART.md), [agents](./docs/AGENTS.md), [production](./docs/PRODUCTION.md), and [Next.js](./docs/NEXTJS.md)
- [Migration](./docs/MIGRATION.md), [workflows](./docs/WORKFLOWS.md), [MCP HTTP](./docs/MCP_HTTP.md), and [gateway routing](./docs/GATEWAY.md)
- [Examples](./examples/README.md), [stability](./STABILITY.md), [support](./SUPPORT.md), and [versioning](./VERSIONING.md)

## Supported Packages

- `@zhivex-ai/sdk`: public entry point. Re-exports the high-level API from core.
- `@zhivex-ai/core`: shared contracts, streams, catalog utilities, and generation primitives.
- `@zhivex-ai/agents`: agent-only facade for the portable runtime, stores, and safety helpers.
- `@zhivex-ai/react`: headless chat state, SSE transport, and accessible components.
- `@zhivex-ai/openai`
- `@zhivex-ai/xai`
- `@zhivex-ai/meta`
- `@zhivex-ai/azure-openai`
- `@zhivex-ai/anthropic`
- `@zhivex-ai/gemini`
- `@zhivex-ai/vertex`
- `@zhivex-ai/qwen`
- `@zhivex-ai/kimi`
- `@zhivex-ai/deepseek`
- `@zhivex-ai/zai`
- `@zhivex-ai/openrouter`
- `@zhivex-ai/bedrock`
- `@zhivex-ai/ollama`
- `@zhivex-ai/gateway`: in-process policy routing and fallback across registered adapters.

## Repository Layout

```text
packages/
  core/           Shared contracts, runtime helpers, streams, middleware, catalog
  sdk/            Aggregated public API
  agents/         Agent-first facade over the core runtime
  react/          React chat state, transport, components, and styles
  openai/         OpenAI adapter
  xai/            xAI Grok adapter
  meta/           Meta Model API adapter
  azure-openai/   Azure OpenAI adapter
  anthropic/      Anthropic adapter
  gemini/         Gemini adapter
  vertex/         Vertex AI adapter
  qwen/           Qwen adapter
  kimi/           Kimi adapter
  deepseek/       DeepSeek adapter
  zai/            Z.ai GLM adapter
  openrouter/     OpenRouter adapter
  bedrock/        AWS Bedrock adapter
  ollama/         Ollama adapter
  gateway/        Routing and fallback package
```

Development uses Bun workspaces, TypeScript project references, and Vitest. See [CONTRIBUTING.md](./CONTRIBUTING.md).

```bash
bun install
bun run docs:check
bun run typecheck
bun run test
bun run build
```

## License

MIT
