# @zhivex-ai/openai

OpenAI adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/openai
```

## Capability notes

The adapter exposes model-specific agent capabilities at runtime. Hosted Responses tools such as `tool_search`, `computer_use_preview`, shell, apply patch, and skills are validated before a request is sent, so unsupported model/tool combinations fail with `UnsupportedFeatureError` instead of relying on a provider-side 400.

```ts
import { createOpenAI, openAIToolSearchTool } from "@zhivex-ai/openai";
import { generateText, getAgentCapabilities } from "@zhivex-ai/core";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

console.log(getAgentCapabilities(openai("gpt-5.5")).computerUse);
console.log(getAgentCapabilities(openai("gpt-5.4")).toolSearch);
console.log(getAgentCapabilities(openai("gpt-5.4-nano")).toolSearch);

await generateText({
  model: openai("gpt-5.4"),
  prompt: "Inspect the available project tools.",
  tools: {
    search: openAIToolSearchTool()
  }
});
```

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
