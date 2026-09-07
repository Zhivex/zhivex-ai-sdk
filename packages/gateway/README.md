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
bun add @zhivex-ai/gateway @zhivex-ai/core @zhivex-ai/anthropic @zhivex-ai/openai @zhivex-ai/ollama
```

Install the provider packages used by your own adapter map; the examples below use OpenAI, Ollama and Anthropic.

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

## Continuing canonical tool history

`GatewayRequest.messages` accepts `GatewayInputMessage[]`, a union of the existing
`GatewayMessage` (role/content/images) and core `ModelMessage` (role/parts).
Existing text/image requests remain valid. Each message must use exactly one
representation; `content` or `images` combined with `parts` is rejected.

```ts
import type { ModelMessage } from "@zhivex-ai/core";
import { createAnthropic } from "@zhivex-ai/anthropic";
import { createGateway, type GatewayRequest } from "@zhivex-ai/gateway";

const gateway = createGateway({ adapters: { anthropic: createAnthropic() } });
const messages: ModelMessage[] = [
  { role: "user", parts: [{ type: "text", text: "What is the temperature in Buenos Aires?" }] },
  { role: "assistant", parts: [{
    type: "tool-call",
    toolCall: { id: "call_weather_1", name: "weather", input: { city: "Buenos Aires" } }
  }] },
  { role: "tool", parts: [{
    type: "tool-result",
    toolResult: {
      toolCallId: "call_weather_1", toolName: "weather",
      output: { temperatureC: 18 }, isError: false
    }
  }] }
];
const request: GatewayRequest = {
  messages,
  primary: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
  fallbacks: [{ provider: "anthropic", modelId: "claude-opus-4-6" }]
};
const answer = await gateway.generate(request);
const streamedAnswer = await gateway.streamText(request).collect();
```

Historical results are input to the model and never invoke a tool executor.
New tool calls retain the existing `tools`, `toolExecution`, and `maxSteps` policy.
For an error result, set `isError: true` and `error: { message: "..." }` instead of
`output`. Successful results require a JSON `output`, including strings or null.
Tool inputs must be JSON objects. IDs must be unique across the request; results
must match both ID and tool name, occur after their calls, and resolve every call
before another conversation turn. Multiple calls and results retain input order;
results can arrive in a different ID order, grouped in one or consecutive tool
messages. System messages must precede conversation turns.

| Surface / destination | Canonical history support |
| --- | --- |
| `generate`, `streamText` | Supported, including usage estimates, attempts, finish reasons, cancellation and routing |
| `generateObject`, `streamObject` | Same input validation and routing; destination must also support the requested object mode |
| `runAgent`, `streamAgent` | Legacy `GatewayMessage[]` only; canonical input is explicitly rejected |
| Anthropic Messages | Text, user images, assistant tool calls, tool results and native `is_error` |
| OpenAI Chat / Responses | Callable tool history, including multiple results; explicit JSON success/error envelopes |
| DeepSeek Chat | Same JSON envelope support; portable replay defaults to non-thinking; reasoning-only models are excluded |
| Qwen Chat / Responses | Same JSON envelope support; portable replay defaults to non-thinking; thinking-only models are excluded |
| Other / older provider adapters | Must explicitly advertise `capabilities.toolHistory`; otherwise skipped with `model-capabilities`, even if `tools` is true |

The gateway is extensible through `ModelCapabilities.toolHistory`: `"native"`
means the adapter preserves error state natively, and `"json"` means it honors
`ModelGenerateInput.toolResultFormat: "envelope"`. Anthropic is also accepted for
backward compatibility with its existing native mapping. An older OpenAI,
DeepSeek or Qwen adapter without the declaration is skipped safely. Custom
adapters can declare support after implementing and testing the same contract;
there is no provider-name allowlist for opting in.

For JSON transports, each tool result is a separate Chat tool message or Responses
`function_call_output`. Its content/output string contains `{ "output": <JSON> }`
on success or `{ "error": { "message": "..." } }` on failure. This discriminant
keeps an error-shaped successful value distinguishable from an actual failure.
Calls and results retain their IDs and order. The original canonical messages and
`isError` remain unchanged. Direct SDK calls keep their prior raw result format
unless they explicitly request the new low-level format. Anthropic keeps native
`is_error`; it does not receive a JSON envelope. Hosted/provider-native tools are
not part of this portable callable-history contract.

DeepSeek/Qwen portable replay has no private thinking state: it defaults to
`thinking.type: "disabled"` / `enable_thinking: false` on those destinations only.
Explicit reasoning/thinking requests are skipped before HTTP; thinking-only
models do not advertise this capability. Text before assistant tool calls is
supported. JSON destinations reject text interleaved after calls instead of
moving it to the beginning. Anthropic can preserve that interleaving natively.

Tool-free canonical text/image messages continue to use normal capability checks.
Audio, files, provider-data, provider metadata, unsupported roles/parts and unknown
fields are rejected before provider calls.
Validation errors contain no message content. Provider failures and caller abort
reasons for tool-history requests use fixed, sanitized diagnostics. Once a stream
emits an event, a failure terminates it without retry/fallback; `collect()` rejects
on both thrown errors and provider error events.

Run `bun run test packages/gateway/tests` for regressions. After `bun run build`,
run `bun run scripts/gateway-history-package-smoke.ts` for a tarball consumer with
TypeScript compilation and generation/streaming on all six transport variants
(Anthropic; OpenAI Chat/Responses; DeepSeek Chat; Qwen Chat/Responses). It installs
candidate core/gateway/provider tarballs without checkout links. Add
`--live --provider=openai` (or `deepseek`, `qwen`, `anthropic`) to require an
authorized credential and perform two bounded live calls for one provider. A missing credential is a blocked live check, not
a passing certification. Publication evidence and the actual version are recorded
in [the delivery record](../../docs/GATEWAY_TOOL_HISTORY_DELIVERY.md).
