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

`createOpenRouter()` reads `OPENROUTER_API_KEY` and defaults to `https://openrouter.ai/api/v1`. `appName` and `appURL` populate OpenRouter's optional attribution headers.

The adapter supports streaming, callable tools, tool choice, native structured output, reasoning controls, vision, and OpenRouter web search. It does not expose embeddings, audio, files, remote MCP, approval requests, or provider-hosted code execution through the shared contract. Model-level support can be narrower than the adapter surface, so select a model that implements every requested capability.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
