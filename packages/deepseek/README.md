# @zhivex-ai/deepseek

DeepSeek adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/deepseek
```

## Usage

```ts
import { generateText } from "@zhivex-ai/core";
import { createDeepSeek } from "@zhivex-ai/deepseek";

const deepseek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY
});

const result = await generateText({
  model: deepseek("deepseek-v4-pro"),
  prompt: "Compare BFS and DFS for pathfinding.",
  reasoning: {
    effort: "high"
  }
});

console.log(result.text);
```

The adapter targets DeepSeek's OpenAI-compatible Chat Completions API at `https://api.deepseek.com`.
It supports text generation, streaming, function tool calls, tool choice, JSON output mode, and DeepSeek thinking mode.
Provider-hosted tools are not exposed by this adapter.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
