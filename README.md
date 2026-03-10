# Zhivex AI SDK

SDK TypeScript modular inspirado en Vercel AI SDK para Node y Bun.

## Paquetes

- `@zhivex-ai/core`: contratos comunes y helpers de alto nivel.
- `@zhivex-ai/openai`: adapter OpenAI.
- `@zhivex-ai/anthropic`: adapter Anthropic.
- `@zhivex-ai/gemini`: adapter Gemini.
- `@zhivex-ai/sdk`: reexports para una experiencia integrada.

## API principal

```ts
import { createOpenAI, generateObject, generateText, streamText } from "@zhivex-ai/sdk";
import { z } from "zod";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const text = await generateText({
  model: openai.languageModel("gpt-4o-mini"),
  prompt: "Describe el SDK en una frase."
});

const recipe = await generateObject({
  model: openai.languageModel("gpt-4o-mini"),
  prompt: "Return a JSON object with title and servings.",
  schema: z.object({
    title: z.string(),
    servings: z.number()
  })
});

const streamed = streamText({
  model: openai.languageModel("gpt-4o-mini"),
  prompt: "Stream a short response."
});

for await (const chunk of streamed.textStream) {
  process.stdout.write(chunk);
}
```
