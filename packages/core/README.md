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

## Security Defaults

- File-backed session, workflow, artifact, run, and memory stores create private directories and files (`0700`/`0600`) and use canonical opaque identity keys. Matching legacy delimiter-based records are read for compatibility and migrated on the next write.
- `createHttpTool()` propagates caller cancellation and idempotency, rejects redirects by default, validates its timeout, and bounds response bodies. Override `maxResponseBytes` or `redirect` only for an application-owned endpoint.
- `parseUIMessageRequest()` validates the runtime message/part shape and bounds request bytes, message count, and JSONL line size.
- The default browser WebSocket connection rejects oversized incoming frames. Set `maxIncomingFrameBytes` only when the provider contract requires a different bound.
- `assertTrustedEndpoint()` rejects credentials, unsafe schemes, private/loopback hosts, and allowlist boundary tricks unless a trusted server configuration explicitly opts in.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
