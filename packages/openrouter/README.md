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

### Model capability profiles

Unrecognized language model IDs default to text and streaming support. Tools, vision,
native structured output and reasoning require a known provider profile or explicit
per-model declarations. Direct requests reject undeclared advanced features before
sending them to the provider. The model ID remains usable for ordinary text requests.

For a new model or a private deployment, declare only features verified for that route:

```ts
const provider = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  modelCapabilities: {
    "private-model": { tools: true, toolChoice: true, structuredOutput: true },
  },
});
```

`unknownModelCapabilities: "legacy"` explicitly restores the historical optimistic
capabilities for unrecognized IDs during migration. Exact per-ID declarations take
precedence over the selected defaults; nested `agentCapabilities` declarations merge
with the profile. Known profiles keep their existing behavior.

OpenRouter web search is a host plugin capability, so `webSearch` and
`hostedWebSearch` remain enabled for unknown model IDs. Function tools and model
vision/native schema support are independent of that host capability. Registered
host profiles currently preserve the existing behavior for `openai/gpt-4o-mini`,
`meta/muse-spark-1.2` and `meta/muse-glimmer-30b`.
