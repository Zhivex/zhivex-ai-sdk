# Zhivex AI SDK

TypeScript SDK for Node and Bun with a unified API for OpenAI, Azure OpenAI, Anthropic, Gemini, Bedrock, Ollama, and OpenRouter.

The recommended experience lives in `@zhivex-ai/sdk`:

- text generation and streaming,
- structured output with Zod,
- automatic tool loops,
- multimodal messages,
- embeddings,
- provider switching without rewriting app logic.

## Quickstart

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const result = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Describe Zhivex AI SDK in one sentence."
});

console.log(result.text);
```

## Installation

Install the lightweight SDK plus only the providers you need:

```bash
bun add @zhivex-ai/sdk @zhivex-ai/openai
```

Additional providers are opt-in:

```bash
bun add @zhivex-ai/anthropic
bun add @zhivex-ai/gemini
bun add @zhivex-ai/openrouter
bun add @zhivex-ai/azure-openai
bun add @zhivex-ai/bedrock
bun add @zhivex-ai/ollama
bun add @zhivex-ai/gateway
```

Individual packages:

```bash
bun add @zhivex-ai/core
bun add @zhivex-ai/openai
```

## Simple streaming

`streamText()` exposes `textStream` as the happy path for simple cases and `eventStream` for advanced flows.

```ts
import { streamText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

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

## HTTP and Web Streams

You can turn SDK streams into Web `Response` objects directly.

```ts
import { streamText, toTextStreamResponse } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const result = streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Stream a short answer."
});

return toTextStreamResponse(result);
```

For SSE or richer payloads:

```ts
import { streamText, toUIMessageStreamResponse } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const result = streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Stream a short answer."
});

return toUIMessageStreamResponse(result);
```

## Structured output

```ts
import { generateObject } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";
import { z } from "zod";

const gemini = createGemini({ apiKey: process.env.GEMINI_API_KEY! });

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
```

## Structured output streaming

```ts
import { streamObject } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

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

## Tools

```ts
import { generateText, tool, user } from "@zhivex-ai/sdk";
import { createAnthropic } from "@zhivex-ai/anthropic";
import { z } from "zod";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

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
      execute: async ({ city }) => ({ city, forecast: "sunny" })
    })
  }
});

console.log(result.text);
console.log(result.toolResults);
```

## Switch providers

Your high-level app code stays the same. Only the provider factory changes:

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createAnthropic } from "@zhivex-ai/anthropic";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

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

## Multimodal

Use `messages` when you need fine-grained control, multimodal input, or richer conversation state:

```ts
import { generateText, user } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

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

## Embeddings

```ts
import { embedMany } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const result = await embedMany({
  model: openai.embeddingModel("text-embedding-3-small"),
  value: ["Zhivex AI SDK", "Unified providers"]
});

console.log(result.embeddings.length);
```

## Additional providers

### Azure OpenAI

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createAzureOpenAI } from "@zhivex-ai/azure-openai";

const azure = createAzureOpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY!,
  endpoint: process.env.AZURE_OPENAI_ENDPOINT!
});

const result = await generateText({
  model: azure("gpt-4o-mini"),
  prompt: "Respond in one sentence."
});

console.log(result.text);
```

### OpenRouter

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenRouter } from "@zhivex-ai/openrouter";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
  appName: "Zhivex Demo",
  appURL: "https://example.com"
});

const result = await generateText({
  model: openrouter("openai/gpt-4o-mini"),
  prompt: "Respond in one sentence."
});

console.log(result.text);
```

### Bedrock

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createBedrock } from "@zhivex-ai/bedrock";

const bedrock = createBedrock({ region: process.env.AWS_REGION! });

const result = await generateText({
  model: bedrock("anthropic.claude-3-5-sonnet-20240620-v1:0"),
  prompt: "Respond in one sentence."
});

console.log(result.text);
```

### Ollama

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOllama } from "@zhivex-ai/ollama";

const ollama = createOllama({ baseURL: process.env.OLLAMA_HOST });

const result = await generateText({
  model: ollama("llama3.2"),
  prompt: "Summarize this in one line."
});

console.log(result.text);
```

## Gateway

```ts
import { createBedrock } from "@zhivex-ai/bedrock";
import { createGateway } from "@zhivex-ai/gateway";
import { createGemini } from "@zhivex-ai/gemini";
import { createOpenRouter } from "@zhivex-ai/openrouter";

const gateway = createGateway({
  adapters: {
    gemini: createGemini({ apiKey: process.env.GEMINI_API_KEY! }),
    bedrock: createBedrock({ region: process.env.AWS_REGION! }),
    openrouter: createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! })
  }
});

const result = await gateway.generate({
  primary: { provider: "gemini", modelId: "gemini-2.0-flash" },
  fallbacks: [{ provider: "openrouter", modelId: "openai/gpt-4o-mini" }],
  messages: [{ role: "user", content: "Say hello in Spanish." }],
  routingMode: "balanced"
});

console.log(result.text);
console.log(result.attempts);
```

## `prompt` vs `messages`

Use `prompt` when:

- you want the shortest path,
- the input is plain text,
- you do not need explicit roles or parts.

Use `messages` when:

- you need multimodal input,
- you want full role-based control,
- you are working directly with tools or parts.

`prompt` and `messages` are mutually exclusive. If you pass both, the SDK throws a clear error.

## Providers and capabilities

| Provider | Streaming | Tools | Tool Choice | JSON Mode | Structured Output | Vision | Reasoning | Embeddings |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Azure OpenAI | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Anthropic | Yes | Yes | Yes | No | Prompted | Yes | Yes | No |
| Gemini | Yes | Yes | No | Yes | Yes | Yes | Yes | Yes |
| OpenRouter | Yes | Yes | Yes | Yes | Yes | Yes | Yes | No |
| Bedrock | No | No | No | No | No | Yes | No | No |
| Ollama | No | No | No | No | No | Yes | No | No |

`Prompted` means the SDK can still generate validated objects through prompting and schema validation even if the provider does not expose native structured output.

Every `LanguageModel` now exposes a richer `model.capabilities` contract, including:

- `jsonMode`
- `toolChoice`
- `parallelToolCalls`
- `audioInput`
- `audioOutput`
- `reasoning`
- `webSearch`

## Typed provider options

`providerOptions` remains a provider passthrough, but it is now typed from the selected model.

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Say hello",
  providerOptions: {
    top_p: 0.8,
    user: "demo-user"
  }
});
```

Exported provider option types:

- `@zhivex-ai/openai`: `OpenAILanguageModelOptions`
- `@zhivex-ai/azure-openai`: `AzureOpenAILanguageModelOptions`
- `@zhivex-ai/anthropic`: `AnthropicLanguageModelOptions`
- `@zhivex-ai/gemini`: `GeminiLanguageModelOptions`
- `@zhivex-ai/openrouter`: `OpenRouterLanguageModelOptions`
- `@zhivex-ai/bedrock`: `BedrockLanguageModelOptions`
- `@zhivex-ai/ollama`: `OllamaLanguageModelOptions`

## UI message helpers

`UIMessage` gives you a serializable message shape for client/server boundaries, persistence, and chat UIs.

```ts
import { toUIMessage, user } from "@zhivex-ai/sdk";

const uiMessage = toUIMessage(user("Hello"), "msg_1");
```

Useful helpers:

- `toUIMessage(...)`
- `toUIMessages(...)`
- `fromUIMessage(...)`
- `fromUIMessages(...)`
- `serializeUIMessage(...)`
- `deserializeUIMessage(...)`
- `toUIMessageStream(...)`
- `toUIMessageStreamResponse(...)`

## Provider conformance

The repo now includes a shared provider contract harness for adapters. New providers should verify:

- stable model identity,
- declared capabilities,
- embedding identity when supported,
- provider option passthrough,
- behavior coverage for text, streaming, tools, and structured output where applicable.

## Middleware and observability

You can add operational behavior by wrapping a model before passing it to `generateText()` or `generateObject()`.

```ts
import {
  createInMemoryGenerateCache,
  createTelemetryMiddleware,
  generateText,
  wrapLanguageModel
} from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const cache = createInMemoryGenerateCache();

const model = wrapLanguageModel(openai("gpt-4o-mini"), [
  createTelemetryMiddleware({
    onEvent(event) {
      console.log(event.type, event.model.modelId);
    }
  })
]);

const result = await generateText({
  model,
  prompt: "Say hello"
});

console.log(result.text);
```

Built-in helpers:

- `wrapLanguageModel(...)`
- `createTelemetryMiddleware(...)`
- `createCachedGenerateMiddleware(...)`
- `createInMemoryGenerateCache(...)`
- `createFileGenerateCache(...)`
- `createCircuitBreakerMiddleware(...)`

## Gateway policies

The gateway now supports higher-level operational routing:

- required capabilities via `requiredCapabilities`
- cost budgets via `maxCostPer1kTokens`
- provider cost hints via `providerCostsPer1kTokens`
- latency bias via `latencyBiasMs`
- attempt telemetry with `onAttempt`
- catalog-aware cost hints with `modelCatalog`

## Durable cache and request helpers

Use a filesystem-backed cache when you want generate caching to survive process restarts:

```ts
import {
  createCachedGenerateMiddleware,
  createFileGenerateCache,
  generateText,
  wrapLanguageModel
} from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const model = wrapLanguageModel(openai("gpt-4o-mini"), [
  createCachedGenerateMiddleware({
    cache: createFileGenerateCache({ dir: ".cache/zhivex" })
  })
]);

const result = await generateText({
  model,
  prompt: "Say hello"
});
```

Fetch-first helpers are also available for `UIMessage[]` request/response handling:

- `parseUIMessageRequest(...)`
- `createUIMessageJsonResponse(...)`
- `createUIMessageLinesResponse(...)`

## Model catalog

The SDK now ships a lightweight model catalog utility:

- `createModelCatalog(...)`
- `defaultModelCatalog`

This can be used directly, or plugged into the gateway to inform routing and cost policies.

## Public API

Recommended helpers:

- `generateText(...)`
- `streamText(...)`
- `generateObject(...)`
- `streamObject(...)`
- `embed(...)`
- `embedMany(...)`
- `toTextStreamResponse(...)`
- `toSSEResponse(...)`
- `toUIMessageStreamResponse(...)`
- `tool(...)`
- `system(...)`
- `user(...)`
- `assistant(...)`

Provider factories:

- `@zhivex-ai/openai`: `createOpenAI(...)`
- `@zhivex-ai/azure-openai`: `createAzureOpenAI(...)`
- `@zhivex-ai/anthropic`: `createAnthropic(...)`
- `@zhivex-ai/gemini`: `createGemini(...)`
- `@zhivex-ai/openrouter`: `createOpenRouter(...)`
- `@zhivex-ai/bedrock`: `createBedrock(...)`
- `@zhivex-ai/ollama`: `createOllama(...)`
- `@zhivex-ai/gateway`: `createGateway(...)`

## Migration from the previous API

Before:

```ts
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const model = openai.languageModel("gpt-4o-mini");
```

Now:

```ts
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const model = openai("gpt-4o-mini");
```

Before:

```ts
messages: [createTextMessage("user", "Hello")]
```

Now:

```ts
messages: [user("Hello")]
```

`.languageModel(...)` still works, but directly invoking the provider is the recommended style.

## Local development

Requirements:

- Bun 1.3+
- Node 20+

Core commands:

```bash
bun install
bun run typecheck
bun run test
bun run build
```
