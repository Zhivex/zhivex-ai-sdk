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
bun add @zhivex-ai/gateway @zhivex-ai/openai @zhivex-ai/ollama
```

Install the provider packages used by your own adapter map; OpenAI and Ollama are included above because the example below uses both.

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
  maxFallbacks: 8,
  maxRetries: 1,
  maxTotalAttempts: 16,
  attemptTimeoutMs: 15_000,
  streamIdleTimeoutMs: 60_000,
  observerTimeoutMs: 1_000,
  unknownCostPolicy: "reject"
});

const abortController = new AbortController();

const result = await gateway.generate({
  primary: { provider: "openai", modelId: "gpt-4o-mini" },
  fallbacks: [{ provider: "ollama", modelId: "llama3.2" }],
  messages: [{ role: "user", content: "Summarize the benefits of fallback routing." }],
  routingMode: "balanced",
  maxCostPer1kTokens: 0.01,
  abortSignal: abortController.signal
});

console.log(result.text);
console.log(result.providerUsed);
console.log(result.attempts);
```

The gateway also supports `streamText()`, `generateObject()`, and `streamObject()` through one Core generation loop. A provider is fixed once its stream emits, while a later model step in the same tool loop can still fail over before emitting provider output. Object routes skip incompatible targets before making a provider call: native mode requires `structuredOutput`, prompted mode requires `jsonMode`, and auto mode accepts either capability.

## Routing guarantees

- Text, object, and agent operations retry eligible failures on the current target and then continue through the ordered fallback targets. Agent routing happens inside one `runAgent()` or `streamAgent()` execution, so a fallback does not restart the agent, duplicate its run, or replay completed tools.
- Text and object streaming fallback is resolved before the first event is exposed. Agent streams may expose lifecycle events such as `agent-run-start` first, but provider fallback is resolved before the first provider event. Once a provider stream emits an event, an error from that stream is propagated without mixing in another provider's transcript.
- `attemptTimeoutMs` and the per-provider `attemptTimeoutsMs` do more than reject the gateway promise: they abort a non-streaming provider call or a streaming call that has not produced its first event. After the first event, `streamIdleTimeoutMs` and `streamIdleTimeoutsMs` abort a provider that stops producing events; the default is 60 seconds and `false` explicitly disables it. A request-level `abortSignal` remains active for the full operation and stops pending retries, backoff, fallback routing, observers, and active streams.
- `ProviderHTTPError` is classified by its typed HTTP status. Status `408`, `429`, and `5xx` errors are retryable on the same target. Other `4xx` errors are not retried on that target, but an eligible fallback can still handle a provider- or model-specific rejection.
- Attempt diagnostics redact credential-like URL parameters and bearer tokens before they are exposed through `attempts[].errorMessage` or observers.
- When `maxCostPer1kTokens` is set, a target without configured or catalog pricing is rejected by default. Set `unknownCostPolicy: "allow"` on `createGateway()` only when routing to models with unknown cost is acceptable.
- Requests containing image attachments only route to models that declare `capabilities.vision: true`. The gateway never removes images to make a target appear compatible; if one target cannot accept the original request, it is skipped in favor of a compatible fallback.
- `scoreTarget(context)` can replace the built-in name-based heuristic with application metrics. It must return a finite number; higher scores route first.
- Routing amplification is bounded even if a request is assembled from external input: requests accept at most `maxFallbacks` targets (default 8, hard maximum 32), `maxRetries` cannot exceed 5, and `maxTotalAttempts` caps provider calls across the whole routed operation including later agent steps (default 32, hard maximum 128). Model IDs are non-empty, limited to 256 characters, and cannot contain control characters. `maxCostPer1kTokens` and configured/catalog costs must be finite and non-negative.
- `onAttempt` and `onAgentRoute` are best-effort observers. They receive an `abortSignal` and are allowed `observerTimeoutMs` to finish (default 1 second); rejection, timeout, or request cancellation cannot retry successful provider work or block routing indefinitely.

Keep primary/fallback selection and these ceilings under application control when mapping an HTTP request into `GatewayRequest`. `maxCostPer1kTokens` limits model price, not the final invoice; use `maxTotalAttempts`, provider-side spend limits, authentication, and rate limiting for a complete cost boundary.

For agent workloads, use `runAgent()` or `streamAgent()` to route by both regular model capabilities and agent-specific capabilities such as `supportTier`, `approvalRequests`, or `remoteMcp`.

```ts
const agentResult = await gateway.runAgent({
  primary: { provider: "kimi", modelId: "kimi-k3" },
  fallbacks: [{ provider: "qwen", modelId: "qwen-plus" }],
  prompt: "Use hosted retrieval and an MCP map server.",
  requiredAgentCapabilities: {
    supportTier: "tier-b",
    hostedFileSearch: true,
    remoteMcp: true
  }
});

console.log(agentResult.providerUsed);
console.log(agentResult.attempts);
console.log(agentResult.routeDecision);
```

Agent requests also forward the durable Core controls `runId`, `scope`, `idempotencyKey`, `parentRunId`, `policy`, and `toolApprovalPolicy`. Use a durable store plus `idempotencyKey` for effectful production runs.

## Migration note

`GatewayConfig.groundedAdapters` has been removed because it was not used by any gateway operation. Register provider adapters through `adapters`; `@zhivex-ai/gateway` does not currently expose a grounded-generation route.

This package is the SDK-local routing layer. It is not the Zhivex-hosted Gateway API and it is not re-exported from `@zhivex-ai/sdk`.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
