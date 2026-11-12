# Zhivex AI SDK

The TypeScript SDK for governed AI agents. Budgets, redaction, audit records, and signed approvals ship in the same layer as `generateText`, tools, and durable sessions. [Zhivex Harness](https://github.com/Zhivex/zhivex-harness) is the reference implementation.

Switch models, not code. The same calls run on Bun and Node.js. Install only the adapters you use.

[![npm](https://img.shields.io/npm/v/@zhivex-ai/sdk)](https://www.npmjs.com/package/@zhivex-ai/sdk)
[![CI](https://github.com/Zhivex/zhivex-ai-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/Zhivex/zhivex-ai-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/Zhivex/zhivex-ai-sdk)](./LICENSE)
[![SLSA provenance](https://img.shields.io/badge/provenance-SLSA-blue)](https://www.npmjs.com/package/@zhivex-ai/sdk)

## Quick Start

### 1. Hello world

Install the current release from the npm `latest` tag. The `next` tag can lag `latest`. Keep the API key on the server.

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
  model: "openai/gpt-4o-mini",
  prompt: "Hello"
});

console.log(text);
```

`register: true` makes the `"provider/model"` string resolve. Unknown providers and a missing `apiKey` throw `ModelResolutionError` before any request. A model object from `createOpenAI()` still works. pnpm and Yarn install the same package. See the [consumer compatibility matrix](./SUPPORT.md#installation-and-consumer-compatibility).

### 2. Governance

Install `zod` when the app defines tool or object schemas, and install only the adapter packages you call. The call below is the same with OpenAI or Qwen. Only the model line changes. `gpt-6-astra` and `qwen3.8-flash` are both in the SDK catalog.

```bash
bun add @zhivex-ai/sdk @zhivex-ai/openai
```

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

`createEgressPolicy` is experimental public beta. The full governed path, including budgets, redaction, and audit records, is in the [Governance kit](./docs/GOVERNANCE.md). A mock-provider walkthrough that CI executes is `examples/sdk/governed-quickstart.ts`. This is also step 1 of the longer [Quickstart](./docs/QUICKSTART.md).

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
| Tier A | OpenAI text and realtime conversation, Azure OpenAI text and realtime, and Bedrock with `runtime: "openai"` |
| Tier B | xAI, Meta, Anthropic, Gemini and Vertex text, Qwen text Responses, Qwen Audio realtime, Qwen 3.8 Omni Flash realtime, DeepSeek, Z.ai, and Bedrock Converse |
| Tier C | OpenRouter, Kimi, Ollama, Qwen Omni language models, Qwen LiveTranslate, Gemini and Vertex live translate/transcribe, Vertex chat without tools, and other tool-less media or realtime surfaces |

`deriveAgentSupportTier()` computes the tier from capability flags. Tier A requires callable tools, approval-capable remote MCP, and hosted web search, or the same approvals on a tool-capable realtime session that already declares them. Tier B requires callable tools and `durableAgent`. Tier C is everything else. A new Tier A declaration needs a passed live certification; provider documentation alone does not promote a surface. Qwen 3.8 Omni Flash realtime stays Tier B. Live certification is a separate column in the capability matrix. Many unsupported combinations are rejected before the request is sent.

The [full capability matrix](./docs/reference/PROVIDERS.md#provider-compatibility) is the source of truth.

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

## The Zhivex family

**Reference implementation.** [Zhivex Harness](https://github.com/Zhivex/zhivex-harness) is the governed runtime built on this SDK, including the coding agent Zhivex Code. The SDK remains the public TypeScript contract underneath: generation, tools, agents, sessions, and gateway.

The same concepts exist for Python in the [Zhivex AI SDK for Python](https://github.com/Zhivex/zhivex-ai-sdk-py) (`zhivex-ai-sdk` on [PyPI](https://pypi.org/project/zhivex-ai-sdk/)).

## Documentation

- [Docs site](https://sdk.zhivex.ai) and the [guide index](./docs/README.md)
- [Quickstart](./docs/QUICKSTART.md), [governance kit](./docs/GOVERNANCE.md), [agents](./docs/AGENTS.md), [production](./docs/PRODUCTION.md), and [Next.js](./docs/NEXTJS.md)
- [Migration](./docs/MIGRATION.md), [workflows](./docs/WORKFLOWS.md), [MCP HTTP](./docs/MCP_HTTP.md), [experimental MCP stdio](./docs/MCP_STDIO.md), [experimental MCP server](./docs/MCP_SERVER.md), [experimental A2A](./docs/A2A.md), and [gateway routing](./docs/GATEWAY.md)
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
- `@zhivex-ai/sandbox-docker`: experimental reference Docker execution environment for workspace agents.
- `@zhivex-ai/trace-viewer`: local read-only viewer for governance ledgers and OpenTelemetry span files.
- `@zhivex-ai/ag-ui`: opt-in AG-UI 1.0 stream adapter and client approval gate. It is not part of `@zhivex-ai/sdk`.

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

### November 2026 provider alignment

The release-managed catalog includes GLM FlashX/Legal and Qwen TTS 3.1, current
Meta Spark prices, GPT-5.6 Sol promotional cache/input/output rates, and Gemini
3.8 Flash pricing. Optional `ModelCatalogEntry.pricingTerms` records verified
promotion dates and source notes. `validThrough` means a confirmed end date;
`guaranteedThrough` means a minimum promised duration, not an automatic expiry.
Catalog snapshots remain immutable and never switch to future prices by clock.
Review promotions after those dates before relying on estimates. Meta
Contributor variants require permission to use content for training; their
catalog prices do not opt in or replace Standard IDs.

Provider packages also expose explicit Anthropic message-thread controls,
DeepSeek Search/Fetch, and Meta's native computer protocol. Gemini GenerateContent
routes now default to `store: false`; consumers that intentionally want request
logging must pass `providerOptions.store: true`. See the individual package
READMEs for privacy, route, and compatibility details.

### November 2026 model updates

The SDK catalog includes Claude Fable 5.2 / Mythos 5.2, Gemini 4 Carbon / Hydrogen, and
Gemini Omni 1.2 Flash. Claude 5.2 uses always-on adaptive thinking, rejects forced
tools, and requires a 5.2 advisor. Preserve signed thinking blocks and the preceding
conversation unchanged; prefix checks are enforced by Anthropic. Explicit
`thinking.block_binding.prefix_mismatch_behavior: "drop_block"` opts into the
provider's beta fallback. Fast mode uses `speed: "fast"` without a fast-mode beta.
Mythos access remains restricted by the provider.

Carbon uses `low`, `medium`, or `high` thinking and implicit caching only. Its
catalog records the 65,536-token synchronous output limit; larger outputs require
background long decode. Introductory token prices expire November 30, 2026;
future rates are documented but never activated automatically.

Hydrogen (`gemini-4-hydrogen`) is supported by Gemini and Vertex with
`reasoning: { effort: "xhigh" }`, alongside `low`, `medium`, and `high`.
Omitting effort preserves the provider default (`high`). It uses implicit caching
only and provider-managed sampling; the adapters reject explicit caches, thinking
budgets, `minimal`/`none`, sampling controls, and assistant prefill.
The catalog records a shared 1,048,576-token context and 65,536 tokens per foreground
segment. For longer output, use Interactions background execution with
`generationConfig: { thinking_level: "xhigh", max_output_tokens: 100000 }`.
Vertex supports `global`, `us`, and `eu`; catalog prices describe Standard global
inference ($1.50 input, $0.075 cached input, $7.50 output per million tokens).
Non-global Vertex prices are 10% higher. Future cache-write fees are not applied.
See [thinking levels](https://aistudio.google.com/docs/thinking) and the
[Vertex Hydrogen guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-hydrogen).

Use `gemini.interactions.create` with `modelId: "gemini-omni-1.2-flash"` for video.
Set `responseFormat: { type: "video", duration: "15s" }` for up to 15 seconds.
Interpolation and extension remain limited to 10 seconds per turn; the service
validates these prompt-dependent modes. Omni 1.1 automatically routes to 1.2 from
December 3, 2026. These additions have mocked contract coverage, not live certification.

Sources: [Claude 5.2 migration](https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2),
[Carbon](https://aistudio.google.com/docs/whats-new-gemini-4-carbon),
[Omni](https://aistudio.google.com/docs/omni).

## Multimodal Decisions

Gemini Decisions evaluates closed questions over text, images, audio, video and
PDF through the shared `DecisionModel` contract:

```ts
import { createGemini } from "@zhivex-ai/gemini";

const result = await createGemini().decisionModel().decide({
  input: [{ type: "document", uri: "https://example.com/invoice.pdf", mimeType: "application/pdf" }],
  questions: { invoice: { type: "predicate", instructions: "Is this an invoice?" } }
});
console.log(result.answers.invoice);
```

Install `@zhivex-ai/gemini` and set `GEMINI_API_KEY`; replace the URL with your
own accessible document. This uses `gemini-decision-1` on the Decisions endpoint.
OpenAI and Qwen also expose decision surfaces, with provider-specific input
capabilities. The gateway supports explicit decision routing and fallback.
See [Gemini Decisions examples and limits](./packages/gemini/README.md#decisions-api).
