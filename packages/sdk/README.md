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

The local `zhivex-ai agents ledger` command omits full output text by default; use `--include-output-text` only for a reviewed local export. `zhivex-ai init agent` creates a private `.env` with mode `0600` on POSIX systems, and `doctor` reports unsafe environment-file permissions.

## Stability

The shared realtime session and `streamLiveAgent` lifecycle is Stable. Provider
model IDs, provider-specific options, and upstream preview availability remain
provider-scoped. The root export also contains Beta and Experimental surfaces;
check runtime symbols with `getApiStability()` and review
<https://github.com/Zhivex/zhivex-ai-sdk/blob/main/STABILITY.md> before upgrading.

## Start Here

- Quickstart: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/QUICKSTART.md>
- Agents guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/AGENTS.md>
- Next.js guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/NEXTJS.md>
- Production guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/PRODUCTION.md>
- Workflows guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/WORKFLOWS.md>
- Artifact Service: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/ARTIFACTS.md>
- Model Catalog: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/MODEL_CATALOG.md>
- CLI contract: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/CLI.md>
- Observability guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/OBSERVABILITY.md>

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
