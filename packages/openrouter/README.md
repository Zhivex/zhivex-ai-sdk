# @zhivex-ai/openrouter

OpenRouter adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/sdk @zhivex-ai/openrouter
```

## Usage

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenRouter, openRouterWebSearchTool } from "@zhivex-ai/openrouter";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  appName: "my-zhivex-app",
  appURL: "https://example.com"
});

const result = await generateText({
  model: openrouter("openai/gpt-4o-mini"),
  prompt: "Summarize current TypeScript runtime news.",
  tools: {
    search: openRouterWebSearchTool({
      search_context_size: "medium"
    })
  }
});

console.log(result.text);
```

Current Meta routes can be selected without a provider-specific fork:

```ts
const spark = openrouter("meta/muse-spark-1.2");
const glimmer = openrouter("meta/muse-glimmer-30b");
```

Muse Spark 1.2 provides the hosted 1M-context route. Muse Glimmer 30B is the smaller open-weight agent model route. Both are represented in the shared model catalog with separate input, cached-input, and output rates; the selected OpenRouter endpoint remains the operational source of truth for availability and billing.

`createOpenRouter()` reads `OPENROUTER_API_KEY` and defaults to `https://openrouter.ai/api/v1`. `appName` and `appURL` populate OpenRouter's optional attribution headers.

The adapter supports streaming, callable tools, tool choice, native structured output, reasoning controls, vision, and OpenRouter web search. It does not expose embeddings, audio, files, remote MCP, approval requests, or provider-hosted code execution through the shared contract. Model-level support can be narrower than the adapter surface, so select a model that implements every requested capability.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
