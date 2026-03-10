# Zhivex AI SDK

SDK TypeScript modular para Node y Bun con una capa unificada para OpenAI, Anthropic y Gemini.

El objetivo es ofrecer una API de alto nivel para:

- generar texto,
- streamear respuestas multi-step,
- producir objetos validados con Zod,
- producir objetos validados con Zod, incluso en streaming,
- ejecutar tools con loop automático,
- enviar mensajes multimodales,
- generar embeddings,
- cambiar de provider sin reescribir la lógica de aplicación.

## Estado actual

El proyecto ya incluye:

- monorepo con paquetes separados por provider,
- API unificada en `@zhivex-ai/core`,
- paquete agregador `@zhivex-ai/sdk`,
- tests unitarios e integraciones mockeadas,
- build con TypeScript project references.

La v2 introduce un contrato común basado en `messages + parts`, capacidades declarativas por modelo y structured output nativo cuando el provider lo soporta.

## Paquetes

- `@zhivex-ai/core`: tipos, errores, helpers y contratos comunes.
- `@zhivex-ai/openai`: adapter para OpenAI.
- `@zhivex-ai/anthropic`: adapter para Anthropic.
- `@zhivex-ai/gemini`: adapter para Gemini.
- `@zhivex-ai/sdk`: reexports para usar todo desde un solo punto.

## Estructura

```text
packages/
  core/
  openai/
  anthropic/
  gemini/
  sdk/
```

## Requisitos

- Bun 1.3+
- Node 20+

## Desarrollo local

Instalar dependencias:

```bash
bun install
```

Compilar todos los paquetes:

```bash
bun run build
```

Ejecutar tests:

```bash
bun run test
```

## Uso desde otro proyecto

Mientras el paquete no esté publicado, podés consumirlo por ruta local.

Instalación del paquete agregador:

```bash
bun add /Users/mikeortiz/dev/zhivex-ai-sdk/packages/sdk
```

O por paquetes individuales:

```bash
bun add /Users/mikeortiz/dev/zhivex-ai-sdk/packages/core
bun add /Users/mikeortiz/dev/zhivex-ai-sdk/packages/openai
```

## Ejemplo básico

```ts
import { createOpenAI, createTextMessage, generateText } from "@zhivex-ai/sdk";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!
});

const result = await generateText({
  model: openai.languageModel("gpt-4o-mini"),
  messages: [createTextMessage("user", "Describe Zhivex AI SDK en una frase.")]
});

console.log(result.text);
console.log(result.messages.at(-1));
```

## Streaming

```ts
import { createOpenAI, streamText } from "@zhivex-ai/sdk";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!
});

const result = streamText({
  model: openai.languageModel("gpt-4o-mini"),
  prompt: "Respondé en dos oraciones cortas."
});

for await (const event of result.eventStream) {
  if (event.type === "text-delta") {
    process.stdout.write(event.textDelta);
  }
}

const final = await result.collect();
console.log(final.finishReason);
```

## Structured output con Zod

```ts
import { createGemini, generateObject } from "@zhivex-ai/sdk";
import { z } from "zod";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY!
});

const recipe = await generateObject({
  model: gemini.languageModel("gemini-2.0-flash"),
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

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!
});

const result = streamObject({
  model: openai.languageModel("gpt-4o-mini"),
  prompt: "Return JSON with title and servings.",
  mode: "native",
  schema: z.object({
    title: z.string(),
    servings: z.number()
  })
});

for await (const event of result.eventStream) {
  if (event.type === "object-partial") {
    console.log(event.partialObject);
  }
}

const final = await result.collect();
console.log(final.object);
```

## Tools

```ts
import { createAnthropic, createTextMessage, generateText } from "@zhivex-ai/sdk";
import { z } from "zod";

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!
});

const result = await generateText({
  model: anthropic.languageModel("claude-3-5-sonnet"),
  messages: [createTextMessage("user", "What is the weather in Madrid?")],
  maxSteps: 2,
  tools: {
    weather: {
      name: "weather",
      description: "Get weather by city",
      schema: z.object({
        city: z.string()
      }),
      execute: async ({ city }) => {
        return { city, forecast: "sunny" };
      }
    }
  }
});

console.log(result.text);
console.log(result.toolResults);
```

## Mensajes multimodales

```ts
import { createOpenAI, generateText } from "@zhivex-ai/sdk";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!
});

const result = await generateText({
  model: openai.languageModel("gpt-4o-mini"),
  messages: [
    {
      role: "user",
      parts: [
        { type: "text", text: "Describe esta imagen." },
        { type: "image", image: "https://example.com/cat.jpg" }
      ]
    }
  ]
});

console.log(result.text);
```

## Embeddings

```ts
import { createOpenAI, embedMany } from "@zhivex-ai/sdk";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!
});

const result = await embedMany({
  model: openai.embeddingModel("text-embedding-3-small"),
  value: ["Zhivex AI SDK", "Unified providers"]
});

console.log(result.embeddings.length);
```

## API principal

Helpers de alto nivel:

- `generateText(...)`
- `streamText(...)`
- `generateObject(...)`
- `streamObject(...)`
- `embed(...)`
- `embedMany(...)`
- `createTextMessage(...)`

Factories de provider:

- `createOpenAI(...)`
- `createAnthropic(...)`
- `createGemini(...)`

## Notas de diseño

- La API unificada vive en `@zhivex-ai/core`.
- Cada provider traduce requests y responses al mismo contrato rico de mensajes.
- Los providers se implementan sobre `fetch`, sin depender de SDKs oficiales externos.
- Los modelos exponen `capabilities` para detectar soporte de streaming, tools, vision, structured output y embeddings.
- Anthropic, en esta versión, no expone embeddings desde el adapter.

## Publicación

La base del monorepo ya está preparada para publicar los paquetes a npm:

- cada paquete tiene `package.json`,
- cada paquete exporta `dist`,
- el build genera tipos y JavaScript ESM.

Antes de publicar conviene definir:

- nombres finales de paquetes,
- estrategia de versionado,
- changelog,
- pipeline de release.
