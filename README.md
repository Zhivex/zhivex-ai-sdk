# Zhivex AI SDK

The TypeScript SDK for governed AI agents. Budgets, redaction, audit records, and signed approvals ship in the same layer as `generateText`, tools, and durable sessions. [Zhivex Harness](https://github.com/Zhivex/zhivex-harness) is the reference implementation.

Switch models, not code. The same calls run on Bun and Node.js. Install only the adapters you use.

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
import { createEgressPolicy, generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Set OPENAI_API_KEY in the server environment.");

const egressPolicy = createEgressPolicy({
  allow: [{
    provider: "openai",
    model: "gpt-6-astra",
    region: "*",
    endpoint: "api.openai.com"
  }]
});

const result = await generateText({
  model: createOpenAI({ apiKey })("gpt-6-astra"),
  prompt: "Describe Zhivex AI SDK in one sentence.",
  egressPolicy,
  egress: { endpoint: "api.openai.com" }
});

console.log(result.text);
```

`createEgressPolicy` is experimental public beta. The full governed path, including budgets, redaction, and audit records, is in the [Governance kit](./docs/GOVERNANCE.md). A mock-provider walkthrough that CI executes is `examples/sdk/governed-quickstart.ts`.

Server runtimes only: Node.js, Bun, route handlers, or workers. Browser clients call your backend. Bedrock requires Node.js 20+, and Vertex requires Node.js 22+. See [SUPPORT.md](./SUPPORT.md).

## Why Zhivex

1. **Governed by default.** Budgets, redaction, audit records, signed tool approvals, and an experimental egress allowlist live on the shared agent contract. See the [Governance kit](./docs/GOVERNANCE.md).
2. **Portable.** The same `generateText`, `streamText`, tools, and agents. You change the adapter.
3. **Native provider features.** Qwen Cloud audio and realtime, DeepSeek FIM, Gemini and Vertex media, and Kimi Formula tools stay reachable on the shared contract.
4. **Durable on your own database.** Sessions and `resumeAgent` are stored in Postgres, SQLite, or a file you operate. Use `createPostgresSessionService()` in production. File stores are for local development.
5. **An honest stability contract.** Every runtime export is `stable`, `beta`, or `experimental`. `getApiStability()` reads that label, and CI fails if an export is unclassified. See [STABILITY.md](./STABILITY.md).

Human approval queues (`createAgentApprovalQueue`) are (beta).

## Providers

Capability differs by adapter. Tiers describe agent support in this SDK:

| Tier | Surfaces |
| --- | --- |
| Tier A | OpenAI text and realtime conversation, Azure OpenAI text and realtime, Bedrock with `runtime: "openai"`, Qwen 3.8 Omni Flash realtime |
| Tier B | xAI, Meta, Anthropic, Gemini and Vertex text, Qwen text Responses, Qwen Audio realtime, DeepSeek, Z.ai, Bedrock Converse |
| Tier C | OpenRouter, Kimi, Ollama, Qwen Omni language models, Qwen LiveTranslate, and other tool-less media or realtime surfaces |

`deriveAgentSupportTier()` computes the tier from capability flags. Tier A requires callable tools, approval-capable remote MCP, and hosted web search, or the same approvals on a tool-capable realtime session. Tier B requires callable tools and `durableAgent`. Tier C is everything else. Live certification is a separate column in the capability matrix. Many unsupported combinations are rejected before the request is sent.

The [full capability matrix](./docs/reference/PROVIDERS.md#provider-compatibility) is the source of truth.

## When to use Zhivex

Use Zhivex for a TypeScript service that calls more than one provider, needs those providers' native features, and stores agent sessions in a database you already operate.

| Choose | When it fits |
| --- | --- |
| Zhivex AI SDK | Governed TypeScript agents: budgets, redaction, audit records, signed approvals, sessions in your own Postgres or SQLite, and a per-export stability manifest. |
| [Vercel AI SDK](https://ai-sdk.dev) | You want the largest provider ecosystem, `useChat` as the default UI, or durable human-in-the-loop inside Vercel Workflows (`WorkflowAgent`). |
| [Mastra](https://mastra.ai) | You want a full agent framework rather than a thin SDK layer. |
| [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) | The product stays on OpenAI, including that SDK's multi-agent, voice, and `RunState` approvals. |

Vercel AI SDK, Mastra, and OpenAI Agents also implement durable human-in-the-loop. Approvals here are (beta). Coming from Vercel AI SDK Core, start with the [migration guide](./docs/MIGRATION.md). An existing `useChat` UI can call a Zhivex backend through `@zhivex-ai/react/compat` (beta). The optional model resolver is (beta); see [MODEL_RESOLVER.md](./docs/MODEL_RESOLVER.md).

This SDK is server-side, and one person maintains it.

## The Zhivex family

**Reference implementation.** [Zhivex Harness](https://github.com/Zhivex/zhivex-harness) is the governed runtime built on this SDK, including the coding agent Zhivex Code. The SDK remains the public TypeScript contract underneath: generation, tools, agents, sessions, and gateway.

The same concepts exist for Python in the [Zhivex AI SDK for Python](https://github.com/Zhivex/zhivex-ai-sdk-py) (`zhivex-ai-sdk` on [PyPI](https://pypi.org/project/zhivex-ai-sdk/)).

## Documentation

- [Docs site](https://sdk.zhivex.ai) and the [guide index](./docs/README.md)
- [Quickstart](./docs/QUICKSTART.md), [governance kit](./docs/GOVERNANCE.md), [agents](./docs/AGENTS.md), [production](./docs/PRODUCTION.md), and [Next.js](./docs/NEXTJS.md)
- [Migration](./docs/MIGRATION.md), [workflows](./docs/WORKFLOWS.md), [MCP HTTP](./docs/MCP_HTTP.md), [experimental MCP server](./docs/MCP_SERVER.md), and [gateway routing](./docs/GATEWAY.md)
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
