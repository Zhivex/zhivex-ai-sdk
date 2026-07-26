# @zhivex-ai/core

Shared contracts, runtime helpers, stream utilities, middleware, catalog helpers, and generation primitives for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/core @zhivex-ai/openai
```

## Usage

Use `@zhivex-ai/core` when you are building custom adapters or need the lower-level shared contract directly.

```ts
import { generateText } from "@zhivex-ai/core";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Describe the shared provider contract."
});

console.log(result.text);
```

If you are implementing an adapter rather than running this example, `@zhivex-ai/core` can be installed on its own. Applications that want the recommended high-level entry point should use `@zhivex-ai/sdk`.

Most applications should install `@zhivex-ai/sdk` and follow the main adoption guides:

- Quickstart: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/QUICKSTART.md>
- Production guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/PRODUCTION.md>

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
