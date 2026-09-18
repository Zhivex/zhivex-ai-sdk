# Zhivex AI SDK

Zhivex AI SDK is a TypeScript monorepo for Bun and Node that provides a unified, provider-agnostic API for modern LLM workflows.

It is designed around a small shared contract in `@zhivex-ai/core` and thin provider adapters on top of it, so application code can stay stable while models and vendors change underneath.

## Stability And Support

The SDK now documents its public contract and release expectations more explicitly:

- [STABILITY.md](./STABILITY.md)
- [SUPPORT.md](./SUPPORT.md)
- [VERSIONING.md](./VERSIONING.md)

For production integrations, prefer supported public package entrypoints and use the provider capability matrix below as the source of truth for cross-provider behavior.

Runtime exports from `@zhivex-ai/core` are also classified by a verifiable API manifest:

```ts
import { getApiStability } from "@zhivex-ai/sdk";

console.log(getApiStability("createWorkflow")?.stability); // "stable"
```

Runtime export drift is guarded by that manifest, and public declaration drift is guarded by type snapshot tests for `@zhivex-ai/core`, `@zhivex-ai/sdk`, and `@zhivex-ai/react`.

The stable boundary covers the shared generation primitives, portable agent runtime, safety and evaluation helpers, `Runner + SessionService`, declarative workflows, every built-in workflow state service, workflow evaluation baselines/gates, Artifact Service, Model Catalog, OpenTelemetry adapters, the `zhivex-ai` CLI, and the dedicated Agent Control Plane contract. Provider-native resource lifecycles and other APIs named in the manifest remain Beta or Experimental.

### Installing The Stable Package

The current stable package is published on npm under the `latest` dist-tag:

```bash
bun add @zhivex-ai/sdk
```

Use `@next` only for prerelease validation:

```bash
bun add @zhivex-ai/sdk@next
```

Use the SDK from server runtimes: Node.js, Bun, Next.js route handlers/server actions, API servers, or background workers. Browser React clients should call your backend instead of importing provider-backed runners directly, because provider credentials, tools, database clients, and durable stores must stay server-side.

Repository development requires Node.js 22.12+ and Bun 1.4.2+. Provider runtime requirements vary: Bedrock requires Node.js 20+, and Vertex requires Node.js 22+. See the [support policy](./SUPPORT.md) for consumer compatibility and the [historical dependency migration report](docs/history/DEPENDENCY_UPGRADE_2026_09.md) for that update.

For local development, file-backed stores are convenient. For serverless and production deployments, prefer database-backed services such as `createPostgresSessionService()` over file stores, because serverless filesystems are usually ephemeral and not shared across instances.

For multimodal React applications and voice, see the [React Omni and realtime example](./examples/react-omni/README.md) and [React package guide](./packages/react/README.md).

## Start Here

Use these guides when adopting the SDK in a real app:

- [Quickstart](./docs/QUICKSTART.md): install the stable package and run a multi-turn `Runner`.
- [Agents Guide](./docs/AGENTS.md): build portable, resumable, governable agents with tools, approvals, streaming, stores, tracing, evaluations, and provider routing.
- [Next.js Runner Guide](./docs/NEXTJS.md): route handler plus React client shape.
- [Production Guide](./docs/PRODUCTION.md): store choices, server-only boundaries, identity mapping, safety, observability, workflows, and artifacts.
- [Workflows Guide](./docs/WORKFLOWS.md): deterministic multi-step agent workflows, durable state, replay, and workflow evaluations.
- [Artifact Service Contract](./docs/ARTIFACTS.md): bounded payloads, integrity, backend semantics, maintenance, and release evidence.
- [Model Catalog Contract](./docs/MODEL_CATALOG.md): immutable snapshots, data-update policy, pricing metadata, and capability boundaries.
- [AI SDK UI Compatibility](./docs/AI_SDK_UI_COMPAT.md): version-pinned `useChat` transport, message adapters, stream protocol, limits, and part matrix.
- [Optional Model Resolver](./docs/MODEL_RESOLVER.md): Beta `provider/model` resolution through an explicit, instance-local registry.
- [CLI Contract](./docs/CLI.md): command compatibility, JSON and exit behavior, local execution, and safety boundaries.
- [Comparative Model Evaluations](./docs/MODEL_EVALUATIONS.md): candidate matrices, scorers, cost/latency summaries, thresholds, and CLI usage.
- [Agent Observability Guide](./docs/OBSERVABILITY.md): traces, audit records, ledgers, golden traces, evaluations, and local inspection.
- [Workspace Agents Guide](./docs/WORKSPACE_AGENTS.md): shell/apply-patch harnesses, app-owned execution boundaries, approvals, and safety requirements.
- [Migration Guide](./docs/MIGRATION.md): move from direct provider SDKs, Vercel AI SDK core usage, or simple tool loops.
- [RAG Guide](./docs/RAG.md): lightweight retrieval contracts, semantic memory boundaries, and app-owned vector store recipes.
- [Examples](./examples/README.md): runnable TypeScript examples, including a deterministic runner/session example and a Next.js reference.

Production adoption path:

1. Start with `Runner + SessionService`.
2. Use `createPostgresSessionService()` for shared/serverless production state.
3. Keep provider credentials, tools, database clients, and safety policies on the server.
4. Wrap tool-using agents with `createProductionSafetyPolicy()` before exposing them to real users.
5. Export redacted trace summaries and tool-call audit records from server-side runs.
6. Use app-owned retrievers/vector stores for long-term semantic memory.

## Why Zhivex AI SDK

- Unified primitives for text generation, streaming, structured output, tools, multimodal messages, and embeddings.
- Consistent message and event contracts across providers.
- Provider adapters that focus on API translation instead of re-implementing business logic.
- ESM-first TypeScript packages intended for server runtimes such as Bun and modern Node.js.
- Incremental adoption: install only the providers your application uses.

## Supported Packages

### Aggregator

- `@zhivex-ai/sdk`: recommended entry point for most applications. Re-exports the public high-level API from `core`.

### Core

- `@zhivex-ai/core`: shared types, message helpers, runtime utilities, stream helpers, middleware, model catalog, and generation primitives.

### Agents

- `@zhivex-ai/agents`: agent-first facade over `core` for applications that only need the portable agent runtime, stores, memory, safety, tracing, evaluation, and provider support helpers.

### React

- `@zhivex-ai/react`: headless chat state, fetch/SSE transport, and customizable accessible React components for Zhivex applications.

### Providers

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

### Routing

- `@zhivex-ai/gateway`: policy-based routing and fallback layer across registered provider adapters.

## Installation

Install the SDK plus the provider packages you need:

```bash
bun add @zhivex-ai/sdk @zhivex-ai/openai
```

If you use structured output or tool schemas in your application code, install `zod` as well:

```bash
bun add zod
```

Additional providers are opt-in:

```bash
bun add @zhivex-ai/anthropic
bun add @zhivex-ai/xai
bun add @zhivex-ai/meta
bun add @zhivex-ai/gemini
bun add @zhivex-ai/vertex
bun add @zhivex-ai/qwen
bun add @zhivex-ai/kimi
bun add @zhivex-ai/deepseek
bun add @zhivex-ai/zai
bun add @zhivex-ai/openrouter
bun add @zhivex-ai/azure-openai
bun add @zhivex-ai/bedrock
bun add @zhivex-ai/ollama
bun add @zhivex-ai/gateway
bun add @zhivex-ai/agents
bun add @zhivex-ai/react react react-dom
```

If you prefer working directly with the shared contract:

```bash
bun add @zhivex-ai/core @zhivex-ai/openai
```

## Examples

The repository includes runnable examples under [`examples/`](./examples/README.md) covering:

- high-level SDK flows
- agent runtime, lifecycle streaming, and UI/SSE transport
- structured output, tools, embeddings, UI helpers, and middleware
- provider-specific setup for each adapter package
- gateway routing and fallback

## Quick Start

This is step 1 of the canonical [Quickstart](./docs/QUICKSTART.md). It continues with the same `gpt-6-astra` provider setup through `Agent`, persistent `Runner` sessions, and the [Next.js React starter](./examples/next-runner/README.md).

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Set OPENAI_API_KEY in the server environment.");

const result = await generateText({
  model: createOpenAI({ apiKey })("gpt-6-astra"),
  prompt: "Describe Zhivex AI SDK in one sentence.",
  maxTokens: 64,
  timeoutMs: 30_000
});

console.log(result.text);
```

Keep the credential server-side. The high-level API accepts either a `prompt` or explicit `messages`, and returns normalized output including text, messages, finish reason, usage, tool results, and execution steps.

## React Chat UI

`@zhivex-ai/react` provides a browser-safe controller, multimodal chat input,
bounded fetch/SSE transport, controlled sessions, accessible auto-following
components, explicit send outcomes with draft/attachment recovery, cursor-based
reconnection, optional Markdown and virtualization, and a default theme:

```tsx
"use client";

import { ZhivexChat, useZhivexChat } from "@zhivex-ai/react";
import "@zhivex-ai/react/styles.css";

export function Chat() {
  const chat = useZhivexChat({ endpoint: "/api/chat" });
  return <ZhivexChat controller={chat} />;
}
```

Use the `/hooks` and `/components` subpaths for client UI, or `/headless` and
`/transport` for server-safe state and transport imports that do not import
React at runtime. The server route owns `Runner`, provider credentials, tools,
authorization, and session persistence. See the [React package guide](./packages/react/README.md) and [Next.js example](./examples/next-runner/README.md).

## Provider Compatibility

The SDK aims to keep the application-facing contract stable, but capability parity is not identical across providers yet. Use this matrix as the source of truth for the currently implemented SDK behavior.

Status shorthand:

- `yes`: implemented in the SDK adapter.
- `model-dependent`: implemented, but gated by the selected model family.
- `endpoint-dependent`: implemented only on a specific provider endpoint or API mode.
- `env/live-tested`: included in the integration registry and skipped unless credentials are present.

<!-- provider-matrix:start -->
| Provider | `streamText` | Tools | `toolChoice` | Structured output | Embeddings | Audio in | Audio out | Realtime sessions | Browser tokens | Reasoning | Web search | Hosted tools / MCP | Agent tier |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | yes | yes | yes | native | yes | yes | yes | yes | yes | model-dependent; GPT-5.6 `max` / `pro` / context | yes | model-dependent Responses hosted tools including image generation, remote MCP, shell/apply patch harness | Tier A |
| xAI | yes | yes | yes | native | no | no | no | no | no | Grok 4.6 `low` / `medium` / `high` / `xhigh`; Grok 4.5 up to `high` | yes | Responses Web Search, X Search, code execution, Collections search, Files API, prompt caching | Tier B |
| Meta | yes | yes | yes | native | no | yes | no | no | no | `effort` | yes | Responses web search, tool search, Files API, prompt caching | Tier B |
| Azure OpenAI | yes | yes | yes | native | yes | yes | yes | yes | yes | `effort` | yes | model-dependent Responses hosted tools, remote MCP, shell/apply patch harness | Tier A |
| Anthropic | yes | yes | yes | native | no | no | no | no | no | Opus 5 `low` / `medium` / `high` / `xhigh` / `max` | yes | native MCP, web search, code execution | Tier B |
| Gemini | yes | yes | yes | native | yes | yes | yes | yes | yes | model-dependent | yes | native | Tier B |
| Vertex | yes | yes | yes | native | yes | yes | yes | yes | no | model-dependent | yes | native | Tier B |
| OpenRouter | yes | yes | yes | native | no | no | no | no | no | `effort` + `budgetTokens` | yes | server tools | Tier C |
| Qwen | yes | yes | yes | JSON object + schema prompt | yes | model-dependent | yes | yes | no | Responses effort / Chat budget | yes | Responses hosted tools; Cloud files, batch, multimodal embeddings, rerank, ASR, TTS, image, video, realtime | Tier B |
| Kimi | yes | yes | yes | native | no | no | no | no | no | K3 `max`; K2.x model-dependent | Formula tool | Formula tools via Chat Completions | Tier C |
| DeepSeek | yes | yes | yes | JSON object | no | no | no | no | no | `none` / `high` / `max` | no | no | Tier B |
| Z.ai | yes | yes | no | JSON object + schema prompt | no | no | no | no | no | 5.3/5.3 Flash `low` / `high` / `max`; 5.2 mapped | no | no | Tier B |
| Bedrock | yes | yes | endpoint-dependent | native | no | no | no | no | no | endpoint-dependent | endpoint-dependent | Converse baseline or Mantle/OpenAI-compatible Responses hosted tools and remote MCP | Tier C / A by runtime |
| Ollama | yes | yes | no | native | yes | no | no | no | no | model-dependent | no | no | Tier C |
<!-- provider-matrix:end -->

Compatibility notes:

- `structured output` means the SDK can use the shared `generateObject()` / `streamObject()` contract. `native` means schema-aware provider support; `prompted` means SDK fallback prompting instead of provider-native schema enforcement.
- Qwen structured output uses Chat Completions JSON-object mode plus a schema system prompt, followed by SDK-side schema validation. DashScope does not currently expose strict JSON Schema enforcement for this API.
- `Realtime sessions` means the provider package exposes `realtimeModel().connect()` through the shared `RealtimeSession` contract. `Browser tokens` means the provider also exposes `realtimeModel().createBrowserToken()` for short-lived client-side credentials.
- Gemini, Vertex, Azure OpenAI, and the current OpenAI `gpt-realtime`, `gpt-realtime-2`, `gpt-realtime-2.1`, `gpt-realtime-mini`, and `gpt-realtime-2.1-mini` models support `session.sendMedia()` for image inputs such as `image/jpeg`, which is useful for browser camera-frame loops. Older OpenAI realtime preview models such as `gpt-4o-realtime-preview` and `gpt-4o-mini-realtime-preview` do not currently support image input.
- Gemini and Vertex expose current Google generative media endpoints through `generateImage()`, `generateVideo()`, and `generateMusic()` where the selected model and endpoint support them, including Gemini Image / Nano Banana and Veo 3.1. Gemini supports Lyria 3 through `generateMusic()`; Vertex's high-level music helper supports the GA `lyria-002`, while Lyria 3 on Agent Platform requires an Interactions API surface that the Vertex adapter does not expose. Gemini Omni Flash is exposed separately through Gemini's Interactions API because it uses a conversational video contract rather than the Veo long-running operation contract.
- Gemini exposes Files API, File Search stores, URL Context, Context Caching, Batch API, the GA Interactions API, managed-agent calls, hosted Google tools, and raw prediction helpers. Vertex exposes Gemini Context Caching, Batch API and hosted Google tools, plus Claude text/tools/streaming through `vertex("claude-...")`. Explicit `predictionModel("publishers/<publisher>/models/<id>")` resources provide raw prediction transport; they do not imply complete Model Garden compatibility.
- `model-dependent` means the provider package exposes the shared capability, but the exact accepted config depends on the selected model family. OpenAI exposes GPT-5.6 Sol, Terra, Luna, and the `gpt-5.6` alias through Responses by default, with Programmatic Tool Calling, Multi-agent, explicit prompt cache breakpoints, and model-gated agent tools. Tool Search and Computer Use are also accepted on GPT-5.5 base and GPT-5.4 base/mini; shell, apply patch, and skills have their own documented gates. Unsupported combinations are rejected before a request is sent. Azure OpenAI retains its deployment- and API-version-dependent capability mapping. Current Anthropic families expose native structured output through `output_config.format`; model-specific effort, thinking, sampling, and prefill constraints are validated before network requests. Claude Opus 5 exposes the complete `low` / `medium` / `high` / `xhigh` / `max` effort ladder and adaptive thinking by default. `budgetTokens` remains available only on models that still accept manual thinking such as Claude Haiku 4.5. Gemini and Vertex reasoning currently map `effort` for Gemini 3 models and `budgetTokens` for Gemini 2.5 and earlier models. Qwen maps reasoning differently by protocol: Responses sends `reasoning.effort`, while Chat Completions sends `enable_thinking` and optional `thinking_budget`. Kimi K3 maps shared `reasoning.effort: "max"` to top-level `reasoning_effort: "max"`, while K2.6, K2.5, and legacy thinking models use `thinking.enabled/disabled`; `kimi-k2.7-code` and `kimi-k2.7-code-highspeed` keep preserved thinking enabled. DeepSeek reasoning maps `effort` to `thinking` plus `reasoning_effort` for `deepseek-v4-flash` and `deepseek-v4-pro`. Z.ai GLM-5.3 and GLM-5.3 Flash require thinking with `low`, `high`, or `max`; GLM-5.2 maps the broader shared effort ladder to its documented enabled/disabled and `high`/`max` controls.
- xAI uses Responses by default. Grok 4.6 supports `low`, `medium`, `high`, and `xhigh`; Grok 4.5 supports up to `high`. Reasoning is always active on both families and defaults to `high`. Use `providerOptions.conversationId` to route Responses requests through `prompt_cache_key`; Chat compatibility mode sends the same value through `x-grok-conv-id`.
- Meta uses `muse-spark-1.2` as the current documented application default, uses the reduced-cost `muse-spark-1.2-contributor` variant by default only in authenticated integration smoke, and retains Muse Spark 1.1 for existing applications. The Contributor catalog entry intentionally omits unverified pricing. The direct Meta Model API adapter exposes Chat and Responses generation, callable tools, native structured output, vision, MP3/WAV audio input, reasoning effort, Responses web search/tool search, Files API, and prompt caching. Computer use remains a developer-defined function-and-screenshot harness rather than a Meta-hosted tool, so the native `computerUse` capability flag remains disabled.
- Meta accepts only `toolChoice: "auto"`, which is also the default; `"none"`, `"required"`, and named-tool choices are rejected locally because the live API rejects them.
- Muse Glimmer 30B is available through the existing OpenRouter adapter as `meta/muse-glimmer-30b` and through Ollama as `muse-glimmer:30b` or `muse-glimmer:30b-mlx`. These routes are first-class catalog entries. They do not turn the direct Meta Model API package into a Glimmer host, and exact local vision/tool support still depends on the installed Ollama build and model artifact.
- Bedrock native Converse supports common `toolChoice` values by mapping specific tools and required tools to AWS-native `toolConfig`, and by omitting tool configuration for `toolChoice: "none"`. Bedrock native Converse uses the AWS SDK credential chain by default; it also supports Amazon Bedrock API keys through `AWS_BEARER_TOKEN_BEDROCK` or `createBedrock({ region, apiKey })` for development and exploration. Bedrock OpenAI-compatible mode uses a Mantle/OpenAI-compatible base URL and sends Requests to `/responses`; pass AWS's `OPENAI_API_KEY` / `OPENAI_BASE_URL` values explicitly as `apiKey` / `baseURL` if you use that naming. In the SDK's agent matrix, Bedrock Tier A applies to `createBedrock({ runtime: "openai" })`, which exposes Responses hosted tools, remote MCP, and approval requests. AWS-native AgentCore MCP is exposed separately as SDK-managed MCP tools for Converse or any shared agent loop; it does not promote Converse itself to a provider-emitted approval runtime.
- Kimi K3 always reasons and accepts `toolChoice: "auto"`, `"none"`, or `"required"`; selecting a specific function is incompatible with thinking. K2.6 and K2.7 Code do not accept `"required"`, and specific tools remain unavailable while thinking is enabled.
- Ollama uses the native `/api/chat` contract. Recognized Qwen 3/3.5, DeepSeek R1/v3.1, and Gemma 4 models preserve native `low`, `medium`, `high`, and `max` reasoning levels. Muse Glimmer preserves `none`, `low`, `medium`, and `high`; `max` is rejected because Ollama does not document that strength for Glimmer. GPT-OSS accepts only `low`, `medium`, and `high` and cannot disable thinking. Returned thinking is preserved through streamed and non-streamed tool loops. Direct `ollama.com` access accepts `apiKey`/`OLLAMA_API_KEY`, while authenticated custom fetchers remain supported. Direct Cloud disables embedding and structured-output capability metadata; `cloud`/`*-cloud` model IDs reached through a local daemon also disable structured output. Exact tools, vision, thinking, and embedding support still depend on the installed or selected model.
- DeepSeek is Tier B for portable tool loops plus documented thinking mode on `deepseek-v4-flash` and `deepseek-v4-pro`. Both models have a 1M-token context window, up to 384K output tokens, JSON output, function tools, and automatic upstream context caching. The experimental `deepseek-v4-flash-vision-exp` model matches Flash's text capabilities and pricing, and adds ordered JPEG, PNG, GIF, and WebP input through inline data, external URLs, or DeepSeek Files API IDs; the provider exposes typed upload/list/get/delete helpers for that path. Image inputs add up to 384 billed tokens each. The adapter reports cached-input and reasoning-token usage and preserves streaming chat/FIM logprobs when DeepSeek returns those details. DeepSeek documents account-level concurrency limits of 2,500 for Flash and 500 for Pro; `user_id` must not contain private information. This adapter still does not expose hosted tools, remote MCP, provider-hosted web search, embeddings, audio, or realtime sessions; DeepSeek separately exposes web search through its Anthropic-compatible endpoint for supported agent integrations.
- Use the V4 model IDs directly. DeepSeek retired the compatibility aliases `deepseek-chat` and `deepseek-reasoner` on July 24, 2026 at 15:59 UTC, so they are intentionally not catalog aliases.
- Strict function schemas are an opt-in DeepSeek Beta feature. Set `providerOptions.strictTools: true`; the adapter routes that request through DeepSeek's Beta endpoint automatically, marks every callable function as strict, and validates DeepSeek's restricted JSON Schema subset locally before network I/O.
- Native DeepSeek `generateObject()` / `streamObject()` requests automatically receive the provider-required JSON instruction plus the requested schema; DeepSeek guarantees a JSON object and the SDK performs the Zod schema validation locally.
- `providerOptions.prefix` exposes Beta chat prefix completion and also routes automatically. The provider additionally exposes `deepseek.fim.generate()` / `deepseek.fim.stream()` for Beta FIM completion on `deepseek-v4-flash` and `deepseek-v4-pro`, typed `deepseek.models.list()` / `deepseek.balance.get()` clients, and `deepseek.files` for the Vision Files API. FIM is non-thinking. Although the official FIM guide/reference still describe older Pro/4K constraints, the pricing table and live API support both V4 models and values above 4,096; the adapter therefore accepts a positive integer and lets the API enforce its current model ceiling.
- DeepSeek V4 thinking mode supports tool loops but does not accept an explicit `tool_choice` field. Leave `toolChoice` unset while thinking is enabled; disable thinking with `reasoning: { effort: "none" }` before using `none`, `required`, or a specific-tool choice.
- Z.ai is Tier B for portable text/tool loops. The adapter preserves `reasoning_content` across streamed and non-streamed tool turns, supports JSON-object structured output with schema prompting and local validation, and exposes only automatic tool selection. `glm-5.3-flash` adds native ordered image input and is available through both the general Model API and GLM Coding Plan; `glm-5.3` and Flash require thinking. `createZAI()` defaults to the general endpoint, while `createZAI({ endpoint: "coding" })` remains explicit for Coding Plan credentials. Offline contract tests do not certify authenticated availability.
- Kimi Formula tools are exposed as public helpers in `@zhivex-ai/kimi`. The SDK loads or declares Formula tool schemas, maps them into Chat Completions function tools, tracks `function.name -> formula_uri`, and executes the official Formula fiber after a Kimi tool call. Moonshot currently marks Formula web search as being updated and not recommended for near-term production use.
- `Hosted tools / MCP` refers to provider-native hosted tools or SDK-level MCP mappings, not local callable tools defined with `tool()`. Kimi Formula helpers are called out separately because they are official provider tools executed through Formula fibers. For OpenRouter this currently means server tools such as `openrouter:web_search`.
- `Agent tier` summarizes how far the provider currently goes for the agent runtime:
- `Tier A`: native agent building blocks including approval-capable remote MCP or equivalent hosted tools.
- `Tier B`: strong tool-using agent support, but with more provider-specific gaps or fewer hosted-agent features.
- `Tier C`: usable for basic tool loops, but not yet something the SDK should market as full agent support.

## API Recipes

Detailed examples are organized by task:

- [Generation](./docs/reference/GENERATION.md)
- [Agents](./docs/reference/AGENTS.md)
- [Tools](./docs/reference/TOOLS.md)
- [Realtime](./docs/reference/REALTIME.md)
- [Media](./docs/reference/MEDIA.md)
- [Providers](./docs/reference/PROVIDERS.md)

## Switching Providers

The application-facing API remains the same. In most cases, switching providers only requires replacing the adapter factory and model identifier.

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createAnthropic } from "@zhivex-ai/anthropic";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const prompt = "Respond in one short sentence.";

const fromOpenAI = await generateText({
  model: openai("gpt-4o-mini"),
  prompt
});

const fromAnthropic = await generateText({
  model: anthropic("claude-sonnet-5"),
  prompt
});

console.log(fromOpenAI.text);
console.log(fromAnthropic.text);
```

## Gateway Routing

Gateway object routing resolves `auto` per destination, including fallback between native structured output and prompted JSON. Stream attempt diagnostics report terminal success/failure, and retries honor bounded provider `retryAfterMs`.

`@zhivex-ai/gateway` is the optional SDK-local routing and fallback package for multi-provider setups. It is separate from the main `@zhivex-ai/sdk` facade and separate from any Zhivex-hosted Gateway API. See [`packages/gateway/README.md`](./packages/gateway/README.md) for routing examples and package-specific behavior.

`GatewayRequest.messages` also accepts canonical core `ModelMessage` entries. Text/object generation and streaming preserve resolved tool history on Anthropic, OpenAI, DeepSeek and Qwen, with explicit validation and cross-provider fallback. Adapters declare native or JSON-envelope history support; older/incompatible destinations are skipped. Portable DeepSeek/Qwen replay uses non-thinking mode; agent operations accept canonical history on fresh runs and resume durable state without resupplying history. See the gateway README for the supported subset and the [delivery evidence](./docs/GATEWAY_TOOL_HISTORY_DELIVERY.md) for artifact and publication status.

`generateObject()` and `streamObject()` now route through the same gateway metadata path as text generation. Native object mode requires `structuredOutput`; prompted object mode requires `jsonMode`; auto mode accepts either capability and skips targets that cannot satisfy object output before making a provider call.

`runAgent()` and `streamAgent()` use the same retry and ordered-fallback behavior as text and object operations, but keep one Core agent execution so fallback does not restart the run or replay completed tools. Text and object streaming resolve fallback before the first event; agent streaming resolves it before the first provider event, after any initial agent lifecycle events. Once a provider stream emits, later failure is propagated without mixing provider transcripts. Attempt timeouts abort non-streaming calls and streaming startup before the first event; a request `abortSignal` remains active for the full operation and stops active streams, backoff, retry, and fallback work.

Gateway retries use typed `ProviderHTTPError` status codes: `408`, `429`, and `5xx` are retryable on the same target, while other `4xx` responses can move directly to an eligible fallback. If a request sets `maxCostPer1kTokens`, targets with unknown pricing are rejected by default; `unknownCostPolicy: "allow"` explicitly opts into those targets. Applications can replace the default name-based ordering heuristic with a finite `scoreTarget(context)` score.

Image requests are routed only to models declaring `capabilities.vision: true`. Images are never removed silently to accommodate an incompatible target. The unused `GatewayConfig.groundedAdapters` option has been removed; register adapters through `adapters`, and do not rely on this package for a grounded-generation route.

## Public API Surface

Object generation preserves tool approval policies and lifecycle hooks. Provider stream error events terminate the operation and reject `collect()` before pending tools execute. OpenAI, Anthropic, Gemini and Qwen language-model routes validate HTTP status inside their retry boundary; DeepSeek also cancels retry waits when its timeout expires.

The recommended package, `@zhivex-ai/sdk`, re-exports the high-level primitives from `core`, including:

- `generateText`, `streamText`
- `generateObject`, `streamObject`
- `transcribeAudio`, `generateSpeech`, `streamSpeech`
- `generateImage`, `generateVideo`, `generateMusic`
- `generateGroundedText`
- `embed`, `embedMany`
- portable agent, runner, session, safety, evaluation, replay, and trace helpers
- Stable declarative workflows, SQL workflow state, workflow evaluation gates, Artifact Service, Model Catalog, OTEL adapters, CLI, and Agent Control Plane helpers plus Beta provider-native resource helpers, classified by `API_STABILITY_MANIFEST`
- message helpers such as `system`, `user`, `assistant`, `tool`, `textPart`
- shared types such as `ReasoningConfig`, `GenerateTextOptions`, and `GenerateObjectOptions`
- stream and HTTP helpers such as `toTextStreamResponse`, `toUIMessageStreamResponse`, `toSSEStream`, and related UI serialization utilities
- middleware and runtime helpers such as telemetry, caching, circuit breakers, and `wrapLanguageModel`

If you are building custom adapters or lower-level integrations, use `@zhivex-ai/core` directly.

If you are building an agent-focused service and do not want the full aggregator surface, use `@zhivex-ai/agents`. It re-exports the current agent contracts from `core`; it does not define a separate runtime.

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

## Development

The repository uses Bun workspaces, TypeScript project references, and Vitest.

```bash
bun install
bun run docs:check
bun run typecheck
bun run test
bun run build
```

The integration layer includes provider-specific tests plus capability-first suites under [`packages/core/tests/`](./packages/core/tests). These capability suites exercise the shared contract across providers that have credentials available in the current environment. The Beta provider-conformance contract emits versioned JSON and Markdown that keeps `implemented`, `offline_passed`, `installed_passed`, and `live_passed` evidence separate, treats missing credentials as a non-certifying skip, applies TTL, detects baseline regressions, and redacts persisted diagnostics. See the [maintainer conformance guide](./docs/maintainers/PROVIDER_SMOKE.md).

Maintainer-only release and provider-smoke workflows live under [`docs/maintainers/`](./docs/maintainers/README.md).

CI scans version-controlled candidate files for recognized credential signatures without printing matched values, installs the immutable lockfile with dependency lifecycle scripts disabled, runs `bun audit`, and analyzes TypeScript with CodeQL. Release validation runs without OIDC, builds and tests the source, then packs the exact release batch into commit-bound SHA-512 manifests. A separate minimal OIDC job publishes only those verified tarballs. Post-publish verification requires registry SHA-512 integrity, SLSA provenance, and a `gitHead` matching the immutable release commit before GitHub release metadata is created.

## Design Principles

- `core` is the single source of truth for shared contracts, capabilities, errors, and high-level helpers.
- Provider packages should translate between external APIs and the shared contract, while keeping provider-specific behavior explicit.
- New capabilities should be introduced in the shared contract first, then implemented by adapters as supported.
- Unsupported features should be represented through capabilities or explicit errors rather than implicit behavior.

## License

MIT
