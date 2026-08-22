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

Focused entrypoints are available for smaller and more explicit imports:

- `@zhivex-ai/sdk/runtime` for generation and runtime helpers
- `@zhivex-ai/sdk/workflows` for declarative workflows and state services
- `@zhivex-ai/sdk/ui` for UI message and SSE contracts
- `@zhivex-ai/sdk/evals` for agent, workflow, and Beta comparative model evaluations
- `@zhivex-ai/agents` for the dedicated agent-first facade

The release-managed default model inventory is available from the SDK root or
`@zhivex-ai/sdk/catalog`. `@zhivex-ai/core` keeps catalog contracts and the
`createModelCatalog` mechanism plus a deprecated, frozen compatibility snapshot
until the next major. Later inventory updates are shipped only by the SDK, so
new applications should not import the core compatibility copy. Inject an
application-owned catalog when model availability or pricing must be pinned
independently from SDK releases.

The local `zhivex-ai agents ledger` command omits full output text by default; use `--include-output-text` only for a reviewed local export. `zhivex-ai init agent` creates a private `.env` with mode `0600` on POSIX systems, and `doctor` reports unsafe environment-file permissions.

## Stability

The shared realtime session and `streamLiveAgent` lifecycle is Stable. Provider
model IDs, provider-specific options, and upstream preview availability remain
provider-scoped. The root export also contains Beta and Experimental surfaces;
new code can make that risk explicit with `@zhivex-ai/sdk/beta` and
`@zhivex-ai/sdk/experimental`. Existing root imports remain compatible. Check
runtime symbols with `getApiStability()` and review
<https://github.com/Zhivex/zhivex-ai-sdk/blob/main/STABILITY.md> before upgrading.

## Start Here

- Quickstart: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/QUICKSTART.md>
- Agents guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/AGENTS.md>
- Next.js guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/NEXTJS.md>
- Production guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/PRODUCTION.md>
- Workflows guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/WORKFLOWS.md>
- Artifact Service: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/ARTIFACTS.md>
- Model Catalog: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/MODEL_CATALOG.md>
- Comparative model evaluations: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/MODEL_EVALUATIONS.md>
- CLI contract: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/CLI.md>
- Observability guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/OBSERVABILITY.md>

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
