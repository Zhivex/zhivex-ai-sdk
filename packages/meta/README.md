# @zhivex-ai/meta

Meta Model API adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/meta
```

## Usage

```ts
import { generateText } from "@zhivex-ai/core";
import { createMeta } from "@zhivex-ai/meta";

const meta = createMeta({
  apiKey: process.env.MODEL_API_KEY
});

const result = await generateText({
  model: meta("muse-spark-1.1"),
  prompt: "Explain tool calling in one sentence."
});

console.log(result.text);
```

The adapter defaults to `https://api.meta.ai/v1` and reads `MODEL_API_KEY` when no key is passed explicitly.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
