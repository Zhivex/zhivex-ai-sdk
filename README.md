# Zhivex AI SDK

SDK TypeScript para Node y Bun con una API unificada para trabajar con OpenAI, Anthropic, Gemini, Bedrock y Ollama sin reescribir la lógica principal de tu aplicación.

La experiencia recomendada vive en `@zhivex-ai/sdk`:

- texto y streaming,
- structured output con Zod,
- tools con loop automático,
- mensajes multimodales,
- embeddings,
- cambio de provider sin cambiar la capa de negocio.

## Quickstart

```ts
import { createOpenAI, generateText } from "@zhivex-ai/sdk";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const result = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Describe Zhivex AI SDK en una frase."
});

console.log(result.text);
```

## Instalación

Mientras el paquete no esté publicado, podés consumirlo por ruta local:

```bash
bun add /Users/mikeortiz/dev/zhivex-ai-sdk/packages/sdk
```

Paquetes individuales:

```bash
bun add /Users/mikeortiz/dev/zhivex-ai-sdk/packages/core
bun add /Users/mikeortiz/dev/zhivex-ai-sdk/packages/openai
```

## Streaming simple

`streamText()` expone `textStream` como camino principal para casos simples y `eventStream` para casos avanzados.

```ts
import { createOpenAI, streamText } from "@zhivex-ai/sdk";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const result = streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Respondé en dos oraciones cortas."
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}

const final = await result.collect();
console.log(final.finishReason);
```

## Structured output

```ts
import { createGemini, generateObject } from "@zhivex-ai/sdk";
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

## Structured output en streaming

```ts
import { createOpenAI, streamObject } from "@zhivex-ai/sdk";
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
import { createAnthropic, generateText, tool, user } from "@zhivex-ai/sdk";
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

## Cambiar de provider

La API de alto nivel no cambia. Solo cambia la factory del provider:

```ts
import { createAnthropic, createOpenAI, generateText } from "@zhivex-ai/sdk";

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

Usá `messages` cuando necesites control fino, multimodalidad o contexto avanzado:

```ts
import { createOpenAI, generateText, user } from "@zhivex-ai/sdk";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const result = await generateText({
  model: openai("gpt-4o-mini"),
  messages: [
    user([
      { type: "text", text: "Describe esta imagen." },
      { type: "image", image: "https://example.com/cat.jpg" }
    ])
  ]
});

console.log(result.text);
```

## Embeddings

```ts
import { createOpenAI, embedMany } from "@zhivex-ai/sdk";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const result = await embedMany({
  model: openai.embeddingModel("text-embedding-3-small"),
  value: ["Zhivex AI SDK", "Unified providers"]
});

console.log(result.embeddings.length);
```

## Otros providers

### Bedrock

```ts
import { createBedrock, generateText } from "@zhivex-ai/sdk";

const bedrock = createBedrock({ region: process.env.AWS_REGION! });

const result = await generateText({
  model: bedrock("anthropic.claude-3-5-sonnet-20240620-v1:0"),
  prompt: "Respond in one sentence."
});

console.log(result.text);
```

### Ollama

```ts
import { createOllama, generateText } from "@zhivex-ai/sdk";

const ollama = createOllama({ baseURL: process.env.OLLAMA_HOST });

const result = await generateText({
  model: ollama("llama3.2"),
  prompt: "Summarize this in one line."
});

console.log(result.text);
```

## Gateway multi-provider

```ts
import { createBedrock, createGateway, createGemini, createOllama } from "@zhivex-ai/sdk";

const gateway = createGateway({
  adapters: {
    gemini: createGemini({ apiKey: process.env.GEMINI_API_KEY! }),
    bedrock: createBedrock({ region: process.env.AWS_REGION! }),
    ollama: createOllama({ baseURL: process.env.OLLAMA_HOST })
  }
});

const result = await gateway.generate({
  primary: { provider: "gemini", modelId: "gemini-2.0-flash" },
  fallbacks: [{ provider: "bedrock", modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0" }],
  messages: [{ role: "user", content: "Say hello in Spanish." }],
  routingMode: "balanced"
});

console.log(result.text);
console.log(result.attempts);
```

## Prompt vs messages

Usá `prompt` cuando:

- querés la ruta más corta,
- el input es solo texto,
- no necesitás controlar roles ni parts.

Usá `messages` cuando:

- necesitás multimodalidad,
- querés contexto completo por rol,
- trabajás con tools o parts de forma explícita.

`prompt` y `messages` son excluyentes. Si pasás ambos, el SDK falla con un error claro.

## Providers y capacidades

| Provider | Streaming | Tools | Tool Choice | JSON Mode | Structured Output | Vision | Reasoning | Embeddings |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Anthropic | Yes | Yes | Yes | No | Prompted | Yes | Yes | No |
| Gemini | Yes | Yes | No | Yes | Yes | Yes | Yes | Yes |
| Bedrock | No | No | No | No | No | Yes | No | No |
| Ollama | No | No | No | No | No | Yes | No | No |

`Prompted` significa que el SDK puede producir objetos usando prompting y validación, aunque el provider no tenga modo nativo.

Cada `LanguageModel` ahora expone un contrato de capacidades más fino en `model.capabilities`, incluyendo:

- `jsonMode`
- `toolChoice`
- `parallelToolCalls`
- `audioInput`
- `audioOutput`
- `reasoning`
- `webSearch`

## Provider options tipadas

`providerOptions` sigue siendo passthrough al provider, pero ahora queda tipado según el modelo que uses.

```ts
import { createOpenAI, generateText } from "@zhivex-ai/sdk";

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

Tipos exportados por provider:

- `OpenAILanguageModelOptions`
- `AnthropicLanguageModelOptions`
- `GeminiLanguageModelOptions`
- `BedrockLanguageModelOptions`
- `OllamaLanguageModelOptions`

## API principal

Helpers recomendados:

- `generateText(...)`
- `streamText(...)`
- `generateObject(...)`
- `streamObject(...)`
- `embed(...)`
- `embedMany(...)`
- `tool(...)`
- `system(...)`
- `user(...)`
- `assistant(...)`

Factories de provider:

- `createOpenAI(...)`
- `createAnthropic(...)`
- `createGemini(...)`
- `createBedrock(...)`
- `createOllama(...)`

## Migración desde la API anterior

Antes:

```ts
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const model = openai.languageModel("gpt-4o-mini");
```

Ahora:

```ts
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const model = openai("gpt-4o-mini");
```

Antes:

```ts
messages: [createTextMessage("user", "Hello")]
```

Ahora:

```ts
messages: [user("Hello")]
```

La forma `.languageModel(...)` sigue disponible, pero la forma recomendada es invocar el provider directamente.

## Desarrollo local

Requisitos:

- Bun 1.3+
- Node 20+

Comandos base:

```bash
bun install
bun run typecheck
bun run test
bun run build
```
