# Zhivex AI SDK

Zhivex AI SDK is a TypeScript monorepo for Bun and Node that provides a unified, provider-agnostic API for modern LLM workflows.

It is designed around a small shared contract in `@zhivex-ai/core` and thin provider adapters on top of it, so application code can stay stable while models and vendors change underneath.

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

The repository includes runnable examples under [`examples/`](/Users/mikeortiz/dev/zhivex-ai-sdk/examples/README.md) covering:

- high-level SDK flows
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

## Core Capabilities

### Text Generation

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createAnthropic } from "@zhivex-ai/anthropic";

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const result = await generateText({
  model: anthropic("claude-3-5-sonnet"),
  system: "Be concise and technical.",
  prompt: "Explain what a provider adapter does."
});

console.log(result.text);
```

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
- Anthropic: supports `budgetTokens`
- Gemini and Vertex:
  - Gemini 3 models support `effort`
  - Gemini 2.5 and earlier models support `budgetTokens`
- Ollama and Bedrock: not supported
- Qwen and Kimi: currently reject the common config until a provider mapping is added

When a provider or model does not support the requested `reasoning` field, the SDK throws an explicit error instead of silently ignoring it.

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
  model: anthropic("claude-3-5-sonnet"),
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

When the selected model supports tool selection, you can control it through the common `toolChoice` option instead of dropping to provider-specific request fields.

```ts
const forcedToolResult = await generateText({
  model: anthropic("claude-3-5-sonnet"),
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
  model: anthropic("claude-3-5-sonnet"),
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

## Public API Surface

The recommended package, `@zhivex-ai/sdk`, re-exports the high-level primitives from `core`, including:

- `generateText`, `streamText`
- `generateObject`, `streamObject`
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

## Design Principles

- `core` is the single source of truth for shared contracts, capabilities, errors, and high-level helpers.
- Provider packages should translate between external APIs and the shared contract, while keeping provider-specific behavior explicit.
- New capabilities should be introduced in the shared contract first, then implemented by adapters as supported.
- Unsupported features should be represented through capabilities or explicit errors rather than implicit behavior.

## License

MIT
