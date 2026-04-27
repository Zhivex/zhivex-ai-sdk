# @zhivex-ai/azure-openai

Azure OpenAI adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/azure-openai
```

## Capability notes

The adapter exposes model-specific agent capabilities at runtime and validates hosted Responses tools before sending requests. Tools such as `tool_search`, `computer_use_preview`, shell, apply patch, and skills are therefore accepted only for model families the SDK marks as supported.

```ts
import { createAzureOpenAI, azureOpenAIToolSearchTool } from "@zhivex-ai/azure-openai";
import { generateText, getAgentCapabilities } from "@zhivex-ai/core";

const azure = createAzureOpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  endpoint: process.env.AZURE_OPENAI_ENDPOINT
});

console.log(getAgentCapabilities(azure("gpt-5.4")).toolSearch);
console.log(getAgentCapabilities(azure("gpt-5.4-nano")).toolSearch);

await generateText({
  model: azure("gpt-5.4"),
  prompt: "Inspect the available project tools.",
  tools: {
    search: azureOpenAIToolSearchTool()
  }
});
```

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
