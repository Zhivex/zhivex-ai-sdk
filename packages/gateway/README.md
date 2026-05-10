# @zhivex-ai/gateway

Routing and fallback package for Zhivex AI SDK.

The gateway now supports:

- `generate()`
- `streamText()`
- `generateObject()`
- `streamObject()`
- `runAgent()`
- `streamAgent()`

Tool loops continue to run on the selected target after routing, and streaming fallbacks are resolved before the first chunk is emitted.

For agent routing, the gateway can also filter by `agentCapabilities`, such as provider support tier or approval-capable MCP support, before selecting the final target.

## Install

```bash
bun add @zhivex-ai/gateway
```

## Usage

```ts
import { createGateway } from "@zhivex-ai/gateway";
import { createOpenAI } from "@zhivex-ai/openai";
import { createOllama } from "@zhivex-ai/ollama";

const gateway = createGateway({
  adapters: {
    openai: createOpenAI({ apiKey: process.env.OPENAI_API_KEY }),
    ollama: createOllama()
  },
  maxRetries: 1
});

const result = await gateway.generate({
  primary: { provider: "openai", modelId: "gpt-4o-mini" },
  fallbacks: [{ provider: "ollama", modelId: "llama3.2" }],
  messages: [{ role: "user", content: "Summarize the benefits of fallback routing." }],
  routingMode: "balanced"
});

console.log(result.text);
console.log(result.providerUsed);
console.log(result.attempts);
```

The gateway also supports `streamText()`, `generateObject()`, and `streamObject()` while preserving the selected target for the full request lifecycle, including tool loops.

For agent workloads, use `runAgent()` or `streamAgent()` to route by both regular model capabilities and agent-specific capabilities such as `supportTier`, `approvalRequests`, or `remoteMcp`.

```ts
const agentResult = await gateway.runAgent({
  primary: { provider: "bedrock", modelId: "anthropic.claude-v2" },
  fallbacks: [{ provider: "openai", modelId: "gpt-5" }],
  prompt: "Use the strongest available agent provider.",
  requiredAgentCapabilities: {
    supportTier: "tier-a",
    approvalRequests: true
  }
});

console.log(agentResult.providerUsed);
console.log(agentResult.routeDecision);
```

This package is the SDK-local routing layer. It is not the Zhivex-hosted Gateway API and it is not re-exported from `@zhivex-ai/sdk`.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
