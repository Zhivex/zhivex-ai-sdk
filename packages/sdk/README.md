# @zhivex-ai/sdk

Recommended entry point for Zhivex AI SDK. Re-exports the high-level public API for agents, sessions, text generation, streaming, structured output, tools, multimodal messages, embeddings, workflows, artifacts, and local CLI utilities.

## Install

```bash
bun add @zhivex-ai/sdk @zhivex-ai/openai
```

Install only the provider packages your application uses. For prerelease validation, install the SDK from `next` and use the matching provider prerelease whenever that provider is part of the same release:

```bash
bun add @zhivex-ai/sdk@next
```

## Quick Start

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Explain the unified SDK in one sentence."
});

console.log(result.text);
```

Use provider-backed models from Bun, Node.js, route handlers, workers, or other server runtimes. Keep provider credentials and effectful tools out of browser bundles.

## Start Here

- Quickstart: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/QUICKSTART.md>
- Agents guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/AGENTS.md>
- Next.js guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/NEXTJS.md>
- Production guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/PRODUCTION.md>
- Workflows guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/WORKFLOWS.md>
- Observability guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/OBSERVABILITY.md>

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
