# Zhivex AI SDK

Zhivex AI SDK is a TypeScript monorepo for Bun and Node that provides a unified, provider-agnostic API for modern LLM workflows.

It is designed around a small shared contract in `@zhivex-ai/core` and thin provider adapters on top of it, so application code can stay stable while models and vendors change underneath.

## Stability And Support

The SDK now documents its public contract and release expectations more explicitly:

- [STABILITY.md](./STABILITY.md)
- [SUPPORT.md](./SUPPORT.md)
- [VERSIONING.md](./VERSIONING.md)

For production integrations, prefer supported public package entrypoints and use the provider capability matrix below as the source of truth for cross-provider behavior.

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

### Providers

- `@zhivex-ai/openai`
- `@zhivex-ai/azure-openai`
- `@zhivex-ai/anthropic`
- `@zhivex-ai/gemini`
- `@zhivex-ai/vertex`
- `@zhivex-ai/qwen`
- `@zhivex-ai/kimi`
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
bun add @zhivex-ai/gemini
bun add @zhivex-ai/vertex
bun add @zhivex-ai/qwen
bun add @zhivex-ai/kimi
bun add @zhivex-ai/openrouter
bun add @zhivex-ai/azure-openai
bun add @zhivex-ai/bedrock
bun add @zhivex-ai/ollama
bun add @zhivex-ai/gateway
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

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Describe Zhivex AI SDK in one sentence."
});

console.log(result.text);
console.log(result.usage);
```

The high-level API accepts either a `prompt` or explicit `messages`, and returns normalized output including text, messages, finish reason, usage, tool results, and execution steps.

## Provider Compatibility

The SDK aims to keep the application-facing contract stable, but capability parity is not identical across providers yet. Use this matrix as the source of truth for the currently implemented SDK behavior.

| Provider | `streamText` | Tools | `toolChoice` | Structured output | Embeddings | Audio in | Audio out | Realtime sessions | Browser tokens | Reasoning | Web search | Hosted tools / MCP | Agent tier |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | yes | yes | yes | native | yes | yes | yes | yes | yes | `effort` | yes | yes | Tier A |
| Azure OpenAI | yes | yes | yes | native | yes | yes | yes | yes | no | `effort` | yes | yes | Tier A |
| Anthropic | yes | yes | yes | prompted | no | no | no | no | no | model-dependent | yes | native MCP + web search | Tier B |
| Gemini | yes | yes | yes | native | yes | yes | yes | yes | yes | model-dependent | yes | native | Tier B |
| Vertex | yes | yes | yes | native | yes | yes | yes | yes | no | model-dependent | yes | native | Tier B |
| OpenRouter | yes | yes | yes | native | no | no | no | no | no | `effort` + `budgetTokens` | yes | server tools | Tier C |
| Qwen | yes | yes | yes | native | yes | no | no | no | no | model-dependent | no | no | Tier C |
| Kimi | yes | yes | yes | native | no | no | no | no | no | model-dependent | no | no | Tier C |
| Bedrock | yes | yes | partial | native | no | no | no | no | no | no | no | no | Tier C |
| Ollama | yes | yes | no | native | yes | no | no | no | no | no | no | no | Tier C |

Compatibility notes:

- `structured output` means the SDK can use the shared `generateObject()` / `streamObject()` contract. `native` means schema-aware provider support; `prompted` means SDK fallback prompting instead of provider-native schema enforcement.
- `Realtime sessions` means the provider package exposes `realtimeModel().connect()` through the shared `RealtimeSession` contract. `Browser tokens` means the provider also exposes `realtimeModel().createBrowserToken()` for short-lived client-side credentials.
- Gemini, Vertex, Azure OpenAI, and the current OpenAI `gpt-realtime` / `gpt-realtime-mini` models support `session.sendMedia()` for image inputs such as `image/jpeg`, which is useful for browser camera-frame loops. Older OpenAI realtime preview models such as `gpt-4o-realtime-preview` and `gpt-4o-mini-realtime-preview` do not currently support image input.
- `model-dependent` means the provider package exposes the shared capability, but the exact accepted config depends on the selected model family. Anthropic reasoning currently maps `effort` on Claude Opus 4.5, Opus 4.6, Sonnet 4.6, and Opus 4.7+, while `budgetTokens` remains available only on Anthropic models that still accept manual thinking. Gemini and Vertex reasoning currently map `effort` for Gemini 3 models and `budgetTokens` for Gemini 2.5 and earlier models. Qwen reasoning currently maps to `enable_thinking` plus optional `thinking_budget` on supported model families such as `qwen-plus`, `qwen-turbo`, `qwq`, and `qwen3*`. Kimi reasoning is currently limited to thinking-capable models such as `kimi-k2.5` and `kimi-k2-thinking`.
- `partial` for Bedrock `toolChoice` means the SDK supports selecting a specific tool or requiring any tool, but does not currently support `toolChoice: "none"`.
- Kimi thinking mode has an extra provider rule reflected in the SDK: when reasoning is enabled, forced tool choice is not supported and `toolChoice` must remain `auto` or `none`.
- `Hosted tools / MCP` refers to provider-native hosted tools or SDK-level MCP mappings, not local callable tools defined with `tool()`. For OpenRouter this currently means server tools such as `openrouter:web_search`.
- `Agent tier` summarizes how far the provider currently goes for the agent runtime:
- `Tier A`: native agent building blocks including approval-capable remote MCP or equivalent hosted tools.
- `Tier B`: strong tool-using agent support, but with more provider-specific gaps or fewer hosted-agent features.
- `Tier C`: usable for basic tool loops, but not yet something the SDK should market as full agent support.

## Core Capabilities

### Text Generation

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createAnthropic } from "@zhivex-ai/anthropic";

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const result = await generateText({
  model: anthropic("claude-opus-4-7"),
  system: "Be concise and technical.",
  prompt: "Explain what a provider adapter does."
});

console.log(result.text);
```

### Agent Runtime

For reusable multi-step assistants, `createAgent()` and `runAgent()` provide a small agent runtime on top of the shared tool loop. Agent runs return a serializable `state` object so you can inspect or resume the run later.

Relevant runnable examples:

- [`examples/sdk/agent-runtime.ts`](./examples/sdk/agent-runtime.ts)
- [`examples/sdk/agent-stream.ts`](./examples/sdk/agent-stream.ts)

```ts
import { createAgent, runAgent, tool } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const weatherAgent = createAgent({
  model: openai("gpt-5"),
  instructions: "Be concise and use tools when they help.",
  maxSteps: 4,
  tools: {
    weather: tool({
      name: "weather",
      schema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, forecast: "sunny" })
    })
  }
});

const run = await runAgent(weatherAgent, {
  prompt: "How's the weather in Madrid?"
});

console.log(run.status);
console.log(run.outputText);
console.log(run.state);
```

What the runtime guarantees:

- `runAgent()` always returns the final `state`, including `steps`, `toolResults`, `messages`, `usage`, and `pendingApprovals`.
- `state` is JSON-serializable and can be persisted by your app.
- `createAgent()` keeps reusable defaults such as `instructions`, `tools`, `maxSteps`, `reasoning`, and provider options in one place.
- `resumeAgent()` continues from a previous `state` instead of rebuilding the run manually.

### Realtime Sessions

The shared realtime contract lets provider adapters expose low-latency audio/text sessions without changing the rest of your app architecture.

```ts
import { tool } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const session = await openai.realtimeModel!("gpt-realtime").connect({
  instructions: "Keep answers short.",
  tools: {
    weather: tool({
      name: "weather",
      schema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, forecast: "sunny" })
    })
  }
});

await session.sendText("How is Madrid today?");

for await (const event of session.eventStream()) {
  if (event.type === "realtime-text-delta") {
    process.stdout.write(event.textDelta);
  }
}
```

Current shared provider coverage for realtime sessions:

- OpenAI
- Azure OpenAI
- Gemini
- Vertex

Notes:

- Providers that require auth headers during the WebSocket handshake, such as OpenAI server-side sessions and Vertex, should be given a custom `realtimeConnectionFactory` in Node/Bun.
- Browser-token helpers are currently exposed for OpenAI and Gemini.
- Gemini, Vertex, and Azure OpenAI sessions support `sendMedia()` for image inputs such as `image/jpeg`.
- OpenAI supports `sendMedia()` for image inputs on `gpt-realtime` and `gpt-realtime-mini`, but not on the older `gpt-4o-*-realtime-preview` models.
- Advanced provider-specific session fields can still be passed through `RealtimeSessionConfig.providerOptions`.

For browser-driven interview-style flows, you can send camera frames through the shared contract on providers that support realtime image input:

```ts
import { createGemini } from "@zhivex-ai/gemini";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const session = await gemini.realtimeModel!("gemini-live-2.5-flash-native-audio").connect({
  instructions: "Observe the camera feed and give concise interview feedback.",
  outputAudioMediaType: "audio/pcm"
});

await session.sendMedia({
  data: jpegFrameBase64,
  mediaType: "image/jpeg"
});
```

### Live Agent Runtime

`streamLiveAgent()` sits one level above raw realtime sessions. It wires a realtime-capable model to local tools, tool approval policies, guardrails, telemetry, and optional state persistence.

```ts
import { streamLiveAgent, tool } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";
import { z } from "zod";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const live = streamLiveAgent(
  {
    id: "voice-weather",
    model: gemini.realtimeModel!("gemini-live-2.5-flash-native-audio"),
    instructions: "Speak briefly and use tools when needed.",
    tools: {
      weather: tool({
        name: "weather",
        schema: z.object({ city: z.string() }),
        execute: async ({ city }) => ({ city, forecast: "sunny" })
      })
    }
  },
  {
    prompt: "How is Madrid today?"
  }
);

for await (const chunk of live.textStream) {
  process.stdout.write(chunk);
}

const result = await live.collect();
console.log(result.outputText);
```

### Agent Persistence And Memory

The agent runtime now supports pluggable run stores and memory stores. Use a run store when you want to save and reload full `AgentRunState` snapshots by `runId`, and use a memory store when you want fresh runs to inherit compact prior context automatically.

```ts
import {
  createAgent,
  createFileAgentRunStore,
  createInMemoryAgentMemoryStore,
  runAgent
} from "@zhivex-ai/sdk";

const agent = createAgent({
  model: openai("gpt-5"),
  store: createFileAgentRunStore({
    directory: "./tmp/agent-runs"
  }),
  memory: createInMemoryAgentMemoryStore()
});

const first = await runAgent(agent, {
  prompt: "Remember that I prefer museums in Madrid."
});

const resumed = await runAgent(agent, {
  runId: first.state.runId
});

console.log(resumed.state.runId);
```

The default in-memory and file-backed helpers are intentionally small. They are meant to give applications a stable contract they can later replace with Redis, Postgres, S3, or any other storage layer.

The SDK now also ships durable SQL-backed helpers:

- `createSqliteAgentRunStore()`
- `createSqliteAgentMemoryStore()`
- `createPostgresAgentRunStore()`
- `createPostgresAgentMemoryStore()`

These helpers intentionally depend on small driver interfaces instead of bundling a database client into `@zhivex-ai/core`. In practice that means you can pair them with:

- SQLite drivers that expose `db.exec()` plus `db.prepare()` or `db.query()`, such as `better-sqlite3` or Bun SQLite
- Postgres clients or pools that expose `query(sql, params)`, such as `pg`

### Agent Handoffs

For multi-agent workflows, create a handoff from one completed run and pass it into another agent. The runtime preserves the parent run relationship in `state.parentRunId` and records the handoff on the downstream state.

```ts
import { createAgentHandoff, runAgent, runAgentHandoff } from "@zhivex-ai/sdk";

const plannerResult = await runAgent(plannerAgent, {
  prompt: "Plan a museum afternoon in Madrid."
});

const handoff = createAgentHandoff({
  source: plannerResult,
  toAgentId: "booking-agent"
});

const bookingResult = await runAgentHandoff(bookingAgent, handoff);
console.log(bookingResult.state.parentRunId);
```

### Agent Telemetry

Agents can now emit lifecycle telemetry without wrapping the underlying language model yourself. Attach `onTelemetryEvent` to an agent definition when you want hooks for run start/finish, step start/finish, approval requests, memory loads, state saves, and handoffs.

```ts
const agent = createAgent({
  model: openai("gpt-5"),
  onTelemetryEvent(event) {
    console.log(event.type);
  }
});
```

If a provider emits an MCP approval request, the run is suspended instead of failing. You can inspect pending approvals with `getAgentApprovalRequests()` and continue with `resumeAgent()`:

```ts
import { createAgent, getAgentApprovalRequests, resumeAgent, runAgent } from "@zhivex-ai/sdk";

const suspended = await runAgent(weatherAgent, {
  prompt: "Search the docs through MCP."
});

if (suspended.status === "suspended") {
  const [approval] = getAgentApprovalRequests(suspended.messages);

  const resumed = await resumeAgent(weatherAgent, {
    state: suspended.state,
    approvals: [
      {
        provider: approval.provider,
        approvalRequestId: approval.id,
        approve: true
      }
    ]
  });

  console.log(resumed.outputText);
}
```

This approval flow currently matters most for `Tier A` providers such as OpenAI and Azure OpenAI, where remote MCP servers can request explicit user approval mid-run.

For OpenTelemetry-oriented setups, the SDK now also exposes explicit OTEL helpers:

- `createOtelObserver()`
- `createOtelAgentObserver()`
- `createOtelTelemetryMiddleware()`

Those helpers are optional and do not add a required dependency to `@zhivex-ai/core`. Install `@opentelemetry/api` in your application if you want the SDK to create tracers for you automatically, or inject your own tracer-compatible object.

```ts
import { createAgent, createOtelAgentObserver, createOtelTelemetryMiddleware, wrapLanguageModel } from "@zhivex-ai/sdk";

const otelAgentObserver = await createOtelAgentObserver();
const otelModelMiddleware = await createOtelTelemetryMiddleware();

const model = wrapLanguageModel(openai("gpt-5"), [otelModelMiddleware]);

const agent = createAgent({
  model,
  onTelemetryEvent: otelAgentObserver
});
```

For SDK-defined local tools, you can now attach a `toolApprovalPolicy` at the agent or request level. The policy runs before local tool execution and can allow or deny the call with a reason:

```ts
const agent = createAgent({
  model: openai("gpt-5"),
  toolApprovalPolicy({ toolCall }) {
    if (toolCall.name === "shell") {
      return {
        approved: false,
        reason: "Shell access is disabled in this environment."
      };
    }

    return { approved: true };
  }
});
```

Agents also support first-class input and output guardrails. A triggered guardrail fails the run, persists the failed state, and emits telemetry:

```ts
const agent = createAgent({
  model: openai("gpt-5"),
  inputGuardrails: [
    async ({ messages }) => {
      const hasSecrets = messages.some((message) =>
        message.parts.some((part) => part.type === "text" && part.text.includes("api key"))
      );

      return hasSecrets
        ? {
            triggered: true,
            reason: "Requests containing secrets are blocked."
          }
        : undefined;
    }
  ]
});
```

For UI transport, `streamAgent()` now emits agent lifecycle events as well as the underlying text/tool/provider-data stream. You can send that directly over SSE with `toUIAgentStreamResponse()`:

```ts
import { streamAgent, toUIAgentStreamResponse } from "@zhivex-ai/sdk";

const result = streamAgent(weatherAgent, {
  prompt: "Search the docs through MCP."
});

return toUIAgentStreamResponse(result);
```

Agent stream events currently include:

- `agent-run-start`
- `agent-step-start`
- `agent-step-finish`
- `agent-approval-request`
- `agent-approval-resolved`
- `agent-run-finish`

Those events are exposed both through `streamAgent().eventStream` and through UI/SSE helpers such as `toUIAgentStreamResponse()` and `toUIMessageStream()`.

When you need to reason about provider-specific agent features at runtime, inspect `model.capabilities.agentCapabilities` or use helpers such as `getAgentCapabilities()`, `getAgentSupportTier()`, and `getHostedToolClass()`. Hosted tools now carry a normalized `toolClass` like `web-search`, `file-search`, `remote-mcp`, or `computer-use`.

```ts
import { getAgentCapabilities, getAgentSupportTier } from "@zhivex-ai/sdk";

const capabilities = getAgentCapabilities(openai("gpt-5"));

console.log(getAgentSupportTier(openai("gpt-5")));
console.log(capabilities);
```

Use the agent tiers as release guidance, not just metadata:

- `Tier A`: choose this when you need approvals, remote MCP, or the strongest hosted-agent story.
- `Tier B`: good default for portable tool-using agents, especially with local tools or SDK-managed MCP clients.
- `Tier C`: keep expectations narrower; these providers work well for basic loops, but you should avoid marketing them as full hosted-agent support.

### Streaming

`streamText()` exposes both a text-only stream for simple UX flows and a lower-level event stream for advanced handling.

```ts
import { streamText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Answer in two short sentences."
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}

const final = await result.collect();
console.log(final.finishReason);
```

### Reasoning Configuration

Use the shared `reasoning` option when you want to control reasoning behavior without coupling your app to provider-specific request fields.

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-5"),
  prompt: "Compare BFS and DFS for pathfinding.",
  maxTokens: 600,
  reasoning: {
    effort: "high"
  }
});

console.log(result.text);
```

Provider compatibility for the common `reasoning` option:

- OpenAI and Azure OpenAI: support `effort`
- OpenRouter: supports `effort` and `budgetTokens`
- Anthropic:
  - Claude Opus 4.7 and later support `effort`; `budgetTokens` is rejected
  - Claude Opus 4.5, Claude Opus 4.6, and Claude Sonnet 4.6 support `effort`
  - `budgetTokens` remains available only on Anthropic models that still accept manual thinking
- Gemini and Vertex:
  - Gemini 3 models support `effort`
  - Gemini 2.5 and earlier models support `budgetTokens`
- Qwen:
  - supported on reasoning-capable model families such as `qwen-plus`, `qwen-turbo`, `qwq`, and `qwen3*`
  - maps to `enable_thinking`, and `budgetTokens` maps to `thinking_budget`
- Kimi:
  - supported on thinking-capable models such as `kimi-k2.5` and `kimi-k2-thinking`
  - maps to Kimi `thinking.enabled/disabled`
  - `budgetTokens` is not supported in the common mapping
  - when reasoning is enabled, `toolChoice` must stay `auto` or `none`
- Ollama and Bedrock: not supported

When a provider or model does not support the requested `reasoning` field, the SDK throws an explicit error instead of silently ignoring it. For the broader matrix, see [Provider Compatibility](#provider-compatibility).

For Qwen and Kimi, the SDK also preserves provider reasoning state across multi-step loops by storing `reasoning_content` inside assistant `provider-data` parts and replaying it on subsequent requests when needed.

### HTTP Responses and UI Streams

The SDK can convert streaming results into Web `Response` objects for server frameworks and edge runtimes.

```ts
import { streamText, toTextStreamResponse } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Stream a short answer."
});

return toTextStreamResponse(result);
```

For richer event payloads and UI-oriented transport:

```ts
import { streamText, toUIMessageStreamResponse } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Stream a short answer."
});

return toUIMessageStreamResponse(result);
```

### Structured Output

Structured generation supports `native`, `prompted`, and `auto` modes. `native` should be preferred when the selected provider/model supports schema-constrained responses.

```ts
import { generateObject } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";
import { z } from "zod";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const recipe = await generateObject({
  model: gemini("gemini-2.0-flash"),
  prompt: "Return JSON with title and servings.",
  mode: "native",
  schema: z.object({
    title: z.string(),
    servings: z.number()
  })
});

console.log(recipe.object);
console.log(recipe.objectMode);
```

### Structured Output Streaming

```ts
import { streamObject } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = streamObject({
  model: openai("gpt-4o-mini"),
  prompt: "Return JSON with title and servings.",
  mode: "native",
  schema: z.object({
    title: z.string(),
    servings: z.number()
  })
});

for await (const partial of result.partialObjectStream) {
  console.log(partial);
}

const final = await result.collect();
console.log(final.object);
```

### Tool Calling

Tools are modeled in the shared contract, and the SDK preserves a multi-step loop through `maxSteps`.

```ts
import { generateText, tool, user } from "@zhivex-ai/sdk";
import { createAnthropic } from "@zhivex-ai/anthropic";
import { z } from "zod";

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const result = await generateText({
  model: anthropic("claude-opus-4-7"),
  messages: [user("What is the weather in Madrid?")],
  maxSteps: 2,
  tools: {
    weather: tool({
      name: "weather",
      description: "Get weather by city",
      schema: z.object({
        city: z.string()
      }),
      execute: async ({ city }) => ({
        city,
        forecast: "sunny"
      })
    })
  }
});

console.log(result.text);
console.log(result.toolResults);
```

Provider-hosted tools use the same `tools` registry through `hostedTool`. This lets providers expose native capabilities such as OpenAI/Azure Responses tools or Gemini/Vertex built-ins without breaking the common contract.

OpenRouter server tools are available through the same hosted-tool mechanism:

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenRouter, openRouterWebSearchTool } from "@zhivex-ai/openrouter";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY
});

const result = await generateText({
  model: openrouter("openai/gpt-4o-mini"),
  prompt: "What were the major AI announcements this week?",
  tools: {
    web: openRouterWebSearchTool({
      max_results: 5,
      allowed_domains: ["openai.com", "anthropic.com"]
    })
  }
});

console.log(result.text);
```

### MCP

The SDK now exposes MCP helpers across the providers that support it:

- `@zhivex-ai/core` and `@zhivex-ai/sdk`: `createMcpToolSet()` wraps an MCP client that can `listTools()` and `callTool()` into local callable tools.
- `@zhivex-ai/core` and `@zhivex-ai/sdk`: `createToolRegistry()` and `createMcpToolRegistry()` help compose local tools, MCP-derived tools, and hosted tools into one registry before converting to a `ToolSet`.
- `@zhivex-ai/openai` and `@zhivex-ai/azure-openai`: remote MCP servers map to native Responses API MCP tools, including approval request/response flow.
- `@zhivex-ai/anthropic`: MCP toolsets map to Anthropic `mcp_servers` plus `mcp_toolset`.
- `@zhivex-ai/gemini` and `@zhivex-ai/vertex`: `geminiMcpTools()` and `vertexMcpTools()` re-export the shared MCP wrapper for SDK-managed MCP clients.

Use the shared helper when you already have an MCP client in-process:

```ts
import { createMcpToolSet, generateText } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const tools = await createMcpToolSet(myMcpClient);

const result = await generateText({
  model: gemini("gemini-2.0-flash"),
  prompt: "Use the MCP tools if needed.",
  tools
});
```

When you want a richer composition surface, build a registry first and materialize it with `toToolSet()` only at the edge:

```ts
import { createMcpToolRegistry, createToolRegistry, toToolSet, tool } from "@zhivex-ai/sdk";

const localTools = createToolRegistry({
  weather: tool({
    name: "weather",
    schema: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, forecast: "sunny" })
  })
});

const mcpTools = await createMcpToolRegistry(myMcpClient, {
  toolNamePrefix: "docs_"
});

const tools = toToolSet(localTools.merge(mcpTools));
```

For OpenAI and Azure OpenAI remote MCP servers, use the provider helpers and pass approval responses back as `provider-data` parts:

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI, openAIMcpApprovalResponse, openAIRemoteMcpTool } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-5"),
  prompt: "Search the docs through MCP.",
  tools: {
    docs: openAIRemoteMcpTool({
      server_label: "docs",
      server_url: "https://example.com/mcp"
    })
  }
});

const approval = result.messages
  .at(-1)
  ?.parts.find((part) => part.type === "provider-data" && part.provider === "openai");

if (approval) {
  await generateText({
    model: openai("gpt-5"),
    messages: [
      ...result.messages,
      {
        role: "user",
        parts: [
          openAIMcpApprovalResponse({
            approval_request_id: "mcpr_123",
            approve: true
          })
        ]
      }
    ],
    tools: {
      docs: openAIRemoteMcpTool({
        server_label: "docs",
        server_url: "https://example.com/mcp"
      })
    }
  });
}
```

If you are already on the shared agent runtime, prefer `runAgent()` / `resumeAgent()` for the same flow. That keeps approvals in `state.pendingApprovals` and avoids rebuilding the follow-up message yourself.

```ts
import { generateText, hostedTool, user } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-5"),
  messages: [user("Summarize today's AI news and cite sources.")],
  tools: {
    web: hostedTool({
      name: "web",
      provider: "openai",
      type: "web_search"
    })
  }
});

console.log(result.text);
```

When the selected model supports tool selection, you can control it through the common `toolChoice` option instead of dropping to provider-specific request fields.

```ts
const forcedToolResult = await generateText({
  model: anthropic("claude-opus-4-7"),
  messages: [user("What is the weather in Madrid?")],
  tools: {
    weather: tool({
      name: "weather",
      schema: z.object({
        city: z.string()
      }),
      execute: async ({ city }) => ({
        city,
        forecast: "sunny"
      })
    })
  },
  toolChoice: {
    type: "tool",
    toolName: "weather"
  }
});
```

### Multimodal Messages

Use explicit messages when you need full control over roles, parts, or multimodal inputs.

```ts
import { generateText, user } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-4o-mini"),
  messages: [
    user([
      { type: "text", text: "Describe this image." },
      { type: "image", image: "https://example.com/cat.jpg" }
    ])
  ]
});

console.log(result.text);
```

### Embeddings

```ts
import { embedMany } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await embedMany({
  model: openai.embeddingModel("text-embedding-3-small"),
  value: ["Zhivex AI SDK", "Unified providers"]
});

console.log(result.embeddings.length);
```

Ollama also supports the shared embeddings contract through its `/api/embed` endpoint:

```ts
import { embed } from "@zhivex-ai/sdk";
import { createOllama } from "@zhivex-ai/ollama";

const ollama = createOllama();

const result = await embed({
  model: ollama.embeddingModel("embeddinggemma"),
  value: "Zhivex AI SDK"
});

console.log(result.embeddings[0]?.length);
```

### Audio

Use the shared audio primitives when you want a provider-agnostic contract for transcription or text-to-speech.

```ts
import { generateSpeech, transcribeAudio } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const transcript = await transcribeAudio({
  model: openai.transcriptionModel("gpt-4o-mini-transcribe"),
  audio: {
    data: "BASE64_AUDIO",
    mediaType: "audio/wav",
    filename: "sample.wav"
  }
});

const speech = await generateSpeech({
  model: openai.speechModel("gpt-4o-mini-tts"),
  input: transcript.text
});

console.log(transcript.text);
console.log(speech.mediaType, speech.audio.length);
```

### Grounded Web Search

`generateGroundedText()` runs a grounded generation request and returns normalized sources alongside the final answer.

```ts
import { generateGroundedText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateGroundedText({
  model: openai.groundedLanguageModel("gpt-4o-search-preview"),
  prompt: "What changed recently in multi-provider AI SDKs?"
});

console.log(result.text);
console.log(result.sources);
```

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
  model: anthropic("claude-opus-4-7"),
  prompt
});

console.log(fromOpenAI.text);
console.log(fromAnthropic.text);
```

## Gateway Routing

`@zhivex-ai/gateway` provides a lightweight routing layer for multi-provider setups, including fallback ordering, capability filtering, retry handling, and optional cost-aware decisions.

```ts
import { createGateway } from "@zhivex-ai/gateway";
import { createOpenAI } from "@zhivex-ai/openai";
import { createOllama } from "@zhivex-ai/ollama";

const gateway = createGateway({
  adapters: {
    openai: createOpenAI({ apiKey: process.env.OPENAI_API_KEY }),
    ollama: createOllama()
  },
  maxRetries: 1
});

const result = await gateway.generate({
  primary: { provider: "openai", modelId: "gpt-4o-mini" },
  fallbacks: [{ provider: "ollama", modelId: "llama3.2" }],
  messages: [{ role: "user", content: "Summarize the benefits of fallback routing." }],
  routingMode: "balanced"
});

console.log(result.text);
console.log(result.providerUsed);
console.log(result.attempts);
```

The gateway also supports `streamText()`, `generateObject()`, and `streamObject()` while preserving the selected target for the full request lifecycle, including tool loops.

For agent workloads, the gateway now also supports `runAgent()` and `streamAgent()`. That lets you route by both regular model capabilities and agent-specific capabilities such as `supportTier`, `approvalRequests`, or `remoteMcp`, then execute the whole agent run on the selected provider.

```ts
const agentResult = await gateway.runAgent({
  primary: { provider: "bedrock", modelId: "anthropic.claude-v2" },
  fallbacks: [{ provider: "openai", modelId: "gpt-5" }],
  prompt: "Use the strongest available agent provider.",
  requiredAgentCapabilities: {
    supportTier: "tier-a",
    approvalRequests: true
  }
});

console.log(agentResult.providerUsed);
console.log(agentResult.routeDecision);
```

## Public API Surface

The recommended package, `@zhivex-ai/sdk`, re-exports the high-level primitives from `core`, including:

- `generateText`, `streamText`
- `generateObject`, `streamObject`
- `transcribeAudio`, `generateSpeech`
- `generateGroundedText`
- `embed`, `embedMany`
- message helpers such as `system`, `user`, `assistant`, `tool`, `textPart`
- shared types such as `ReasoningConfig`, `GenerateTextOptions`, and `GenerateObjectOptions`
- stream and HTTP helpers such as `toTextStreamResponse`, `toUIMessageStreamResponse`, `toSSEStream`, and related UI serialization utilities
- middleware and runtime helpers such as telemetry, caching, circuit breakers, and `wrapLanguageModel`

If you are building custom adapters or lower-level integrations, use `@zhivex-ai/core` directly.

## Repository Layout

```text
packages/
  core/           Shared contracts, runtime helpers, streams, middleware, catalog
  sdk/            Aggregated public API
  openai/         OpenAI adapter
  azure-openai/   Azure OpenAI adapter
  anthropic/      Anthropic adapter
  gemini/         Gemini adapter
  vertex/         Vertex AI adapter
  qwen/           Qwen adapter
  kimi/           Kimi adapter
  openrouter/     OpenRouter adapter
  bedrock/        AWS Bedrock adapter
  ollama/         Ollama adapter
  gateway/        Routing and fallback package
```

## Development

The repository uses Bun workspaces, TypeScript project references, and Vitest.

```bash
bun install
bun run typecheck
bun run test
bun run build
```

The integration layer now includes provider-specific tests plus capability-first suites under [`packages/core/tests/`](./packages/core/tests). These capability suites exercise the shared contract across any providers that have credentials available in the current environment.

## Design Principles

- `core` is the single source of truth for shared contracts, capabilities, errors, and high-level helpers.
- Provider packages should translate between external APIs and the shared contract, while keeping provider-specific behavior explicit.
- New capabilities should be introduced in the shared contract first, then implemented by adapters as supported.
- Unsupported features should be represented through capabilities or explicit errors rather than implicit behavior.

## License

MIT
