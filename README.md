# Zhivex AI SDK

The TypeScript SDK for governed AI agents. Budgets, redaction, audit records, and signed approvals ship in the same layer as `generateText`, tools, and durable sessions. [Zhivex Harness](https://github.com/Zhivex/zhivex-harness) is the reference implementation.

Switch models, not code. The same calls run on Bun and Node.js across OpenAI, Anthropic, Gemini, Bedrock, Qwen, and 9 more adapters. Install only the adapters you use.

[![npm](https://img.shields.io/npm/v/@zhivex-ai/sdk)](https://www.npmjs.com/package/@zhivex-ai/sdk)
[![CI](https://github.com/Zhivex/zhivex-ai-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/Zhivex/zhivex-ai-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/Zhivex/zhivex-ai-sdk)](./LICENSE)
[![SLSA provenance](https://img.shields.io/badge/provenance-SLSA-blue)](https://www.npmjs.com/package/@zhivex-ai/sdk)

## Quick Start

### 1. Hello world

Install the current release from the npm `latest` tag. Keep the API key on the server.

```bash
bun add @zhivex-ai/sdk
```

```ts
import { generateText, openaiCompatible } from "@zhivex-ai/sdk";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Set OPENAI_API_KEY.");

openaiCompatible({
  name: "openai",
  baseURL: "https://api.openai.com/v1",
  apiKey,
  register: true
});

const { text } = await generateText({
  model: "openai/gpt-6-astra",
  prompt: "Hello"
});

console.log(text);
```

`register: true` makes the `"provider/model"` string resolve. Unknown providers and a missing `apiKey` throw `ModelResolutionError` before any request. pnpm and Yarn install the same package. See the [consumer compatibility matrix](./SUPPORT.md#installation-and-consumer-compatibility).

### 2. Governance

The same agent, with a step and token budget, credential and email redaction, approval for sensitive tools, and an audit ledger that does not store the raw prompt.

```bash
bun add @zhivex-ai/sdk @zhivex-ai/openai
```

```ts
import {
  applySafetyPolicyToAgent,
  createAgent,
  createAgentRunLedger,
  createProductionSafetyPolicy,
  runAgent
} from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const agent = applySafetyPolicyToAgent(
  createAgent({
    model: openai("gpt-6-astra"),
    instructions: "Answer support questions in one paragraph."
  }),
  createProductionSafetyPolicy()
);

const result = await runAgent(agent, {
  prompt: "Customer jane@example.com cannot sign in. Draft a reply."
});

console.log(result.outputText);
console.log(createAgentRunLedger(result.state));
```

`createProductionSafetyPolicy()` sets a budget of 6 steps, 8 tool calls, and 20,000 tokens, redacts credentials and email addresses, and requires approval for sensitive tool names. Signed approvals, Latin American ID redaction, and an egress allowlist are in the [Governance kit](./docs/GOVERNANCE.md). A credential-free walkthrough that CI executes is `examples/sdk/governed-quickstart.ts`. The longer path is the [Quickstart](./docs/QUICKSTART.md).

Server runtimes only: Node.js, Bun, route handlers, or workers. Browser clients call your backend. Bedrock requires Node.js 20+, and Vertex requires Node.js 22+. See [SUPPORT.md](./SUPPORT.md).

## Why Zhivex

1. **Governed by default.** Budgets, redaction, audit records, signed tool approvals, and an experimental egress allowlist live on the shared agent contract. Human approval queues (`createAgentApprovalQueue`) are beta. See the [Governance kit](./docs/GOVERNANCE.md).
2. **Portable.** The same `generateText`, `streamText`, tools, and agents. You change the adapter.
3. **Native provider features.** Qwen Cloud audio and realtime, DeepSeek FIM, Gemini and Vertex media, and Kimi Formula tools stay reachable on the shared contract.
4. **Durable on your own database.** Sessions and `resumeAgent` are stored in Postgres, SQLite, or a file you operate. Use `createPostgresSessionService()` in production. File stores are for local development.
5. **An honest stability contract.** Every runtime export is `stable`, `beta`, or `experimental`. `getApiStability()` reads that label, and CI fails if an export is unclassified. See [STABILITY.md](./STABILITY.md).

## When to use Zhivex

Use Zhivex for a TypeScript service that calls more than one provider, needs those providers' native features, and stores agent sessions in a database you already operate.

| Choose | When it fits |
| --- | --- |
| Zhivex AI SDK | Governed TypeScript agents: budgets, redaction, audit records, signed approvals, sessions in your own Postgres or SQLite, and a per-export stability manifest. |
| [Vercel AI SDK](https://ai-sdk.dev) | You want the largest provider ecosystem, `useChat` as the default UI, or durable human-in-the-loop inside Vercel Workflows (`WorkflowAgent`). |
| [Mastra](https://mastra.ai) | You want a full agent framework rather than a thin SDK layer. |
| [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) | The product stays on OpenAI, including that SDK's multi-agent, voice, and `RunState` approvals. |

Vercel AI SDK, Mastra, and OpenAI Agents also implement durable human-in-the-loop. Approvals here are (beta). Coming from Vercel AI SDK Core, start with the [migration guide](./docs/MIGRATION.md). An existing `useChat` UI can call a Zhivex backend through `@zhivex-ai/react/compat` (beta). The model resolver is stable. `@zhivex-ai/sdk/beta` still exports it as a deprecated alias. See [MODEL_RESOLVER.md](./docs/MODEL_RESOLVER.md).

This SDK is server-side, and one person maintains it.

## Providers

Capability differs by adapter. Tiers describe agent support in this SDK:

| Tier | Surfaces |
| --- | --- |
| Tier A | OpenAI text and realtime conversation, Azure OpenAI text and realtime, and Bedrock with `runtime: "openai"` |
| Tier B | xAI, Meta, Anthropic, Gemini and Vertex text, Qwen text Responses, Qwen Audio realtime, Qwen 3.8 Omni Flash realtime, DeepSeek, Z.ai, and Bedrock Converse |
| Tier C | OpenRouter, Kimi, Ollama, Qwen Omni language models, Qwen LiveTranslate, Gemini and Vertex live translate/transcribe, Vertex chat without tools, and other tool-less media or realtime surfaces |

`deriveAgentSupportTier()` computes the tier from capability flags. Tier A requires callable tools, approval-capable remote MCP, and hosted web search, or the same approvals on a tool-capable realtime session that already declares them. Tier B requires callable tools and `durableAgent`. Tier C is everything else. A new Tier A declaration needs a passed live certification; provider documentation alone does not promote a surface. Qwen 3.8 Omni Flash realtime stays Tier B. Live certification is a separate column in the capability matrix. Many unsupported combinations are rejected before the request is sent.

The [full capability matrix](./docs/reference/PROVIDERS.md#provider-compatibility) is the source of truth.

Recent model additions, including GPT-6.2 Astra and Sol, Qwen4-Max, Claude Fable 5.2, and Gemini 4, are summarized in [model and provider updates](./docs/MODEL_UPDATES.md). Each adapter README has the setup details.

## Supported Packages

| Package | Purpose |
| --- | --- |
| `@zhivex-ai/sdk` | Start here. Public entry point that re-exports the high-level API from core. |
| `@zhivex-ai/agents` | Agent-only facade for the portable runtime, stores, and safety helpers. |
| `@zhivex-ai/core` | Shared contracts, streams, catalog utilities, and generation primitives. Installed with every adapter. |
| `@zhivex-ai/react` | Headless chat state, SSE transport, and accessible components. |
| `@zhivex-ai/gateway` | In-process policy routing and fallback across registered adapters. |
| `@zhivex-ai/trace-viewer` | Local read-only viewer for governance ledgers and OpenTelemetry span files. |
| `@zhivex-ai/ag-ui` | Opt-in AG-UI 1.0 stream adapter and client approval gate. Not part of `@zhivex-ai/sdk`. |
| `@zhivex-ai/sandbox-docker` | Experimental reference Docker execution environment for workspace agents. |

Provider adapters: `@zhivex-ai/openai`, `@zhivex-ai/anthropic`, `@zhivex-ai/gemini`, `@zhivex-ai/vertex`, `@zhivex-ai/azure-openai`, `@zhivex-ai/bedrock`, `@zhivex-ai/xai`, `@zhivex-ai/meta`, `@zhivex-ai/qwen`, `@zhivex-ai/kimi`, `@zhivex-ai/deepseek`, `@zhivex-ai/zai`, `@zhivex-ai/openrouter`, and `@zhivex-ai/ollama`.

## Documentation

- [Docs site](https://sdk.zhivex.ai) and the [guide index](./docs/README.md)
- [Quickstart](./docs/QUICKSTART.md), [governance kit](./docs/GOVERNANCE.md), [agents](./docs/AGENTS.md), [production](./docs/PRODUCTION.md), and [Next.js](./docs/NEXTJS.md)
- [Migration](./docs/MIGRATION.md), [workflows](./docs/WORKFLOWS.md), [MCP HTTP](./docs/MCP_HTTP.md), [experimental MCP stdio](./docs/MCP_STDIO.md), [experimental MCP server](./docs/MCP_SERVER.md), [experimental A2A](./docs/A2A.md), and [gateway routing](./docs/GATEWAY.md)
- [Model and provider updates](./docs/MODEL_UPDATES.md), [performance tuning](./docs/PERFORMANCE.md), and [release notes](https://github.com/Zhivex/zhivex-ai-sdk/releases)
- [Examples](./examples/README.md), [stability](./STABILITY.md), [support](./SUPPORT.md), and [versioning](./VERSIONING.md)

## The Zhivex family

**Reference implementation.** [Zhivex Harness](https://github.com/Zhivex/zhivex-harness) is the governed runtime built on this SDK, including the coding agent Zhivex Code. The SDK remains the public TypeScript contract underneath: generation, tools, agents, sessions, and gateway.

The same concepts exist for Python in the [Zhivex AI SDK for Python](https://github.com/Zhivex/zhivex-ai-sdk-py) (`zhivex-ai-sdk` on [PyPI](https://pypi.org/project/zhivex-ai-sdk/)).

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
  sandbox-docker/ Reference Docker execution environment
  trace-viewer/   Local ledger and OpenTelemetry span viewer
  ag-ui/          Opt-in AG-UI stream adapter and client approval gate
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
