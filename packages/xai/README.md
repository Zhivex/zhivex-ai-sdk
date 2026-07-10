# @zhivex-ai/xai

xAI Grok adapter for Zhivex AI SDK. It uses the xAI Responses API by default and supports Chat Completions as an explicit compatibility mode.

## Install

```bash
bun add @zhivex-ai/xai
```

## Usage

```ts
import { generateText } from "@zhivex-ai/core";
import { createXAI, xAIXSearchTool, xAIWebSearchTool } from "@zhivex-ai/xai";

const xai = createXAI({
  apiKey: process.env.XAI_API_KEY
});

const result = await generateText({
  model: xai("grok-4.5"),
  prompt: "Summarize the latest xAI release with sources.",
  reasoning: { effort: "medium" },
  providerOptions: { conversationId: "release-research" },
  tools: {
    web: xAIWebSearchTool(),
    x: xAIXSearchTool()
  }
});

console.log(result.text);
```

The adapter defaults to `https://api.x.ai/v1` and reads `XAI_API_KEY` when no API key is passed explicitly.

## Supported Grok 4.5 features

- text and image input
- streaming
- function calling and tool choice
- native structured output
- `low`, `medium`, and `high` reasoning effort
- hosted Web Search, X Search, code execution, and Collections file search
- Files API attachments
- prompt caching through `conversationId` or `prompt_cache_key`
- Responses conversation continuity and encrypted reasoning preservation when `store: false`

Use `providerOptions: { apiMode: "chat" }` only when Chat Completions compatibility is required. In Chat mode, `conversationId` is sent through the `x-grok-conv-id` header.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
