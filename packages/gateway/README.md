# @zhivex-ai/gateway

## Vertex partner routing

Register one Vertex adapter with Google Cloud credentials. The publisher stays
inside `modelId`; the gateway provider remains `vertex` for Google-hosted models.

```ts
import { createGateway } from "@zhivex-ai/gateway";
import { createVertex } from "@zhivex-ai/vertex";

const gateway = createGateway({
  adapters: { vertex: createVertex({
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
    location: "global"
  }) },
  maxRetries: 0
});

const result = await gateway.generate({
  primary: { provider: "vertex", modelId: "openai/gpt-oss-120b-maas" },
  fallbacks: [{ provider: "vertex", modelId: "gemini-3.7-flash" }],
  messages: [{ role: "user", content: "Explain a binary search." }]
});
```

This requires working ADC or another bearer credential resolved by Vertex.
Model permissions, regional availability and quotas apply separately to each
target. See the [Vertex provider](../vertex/README.md) for route-specific limits.

Routing and fallback package for Zhivex AI SDK.

The gateway now supports:

- `generate()`
- `streamText()`
- `generateObject()`
- `streamObject()`
- `runAgent()`
- `streamAgent()`

Tool loops run in one Core execution; later model steps can fail over without replaying completed tools. Streaming fallbacks are resolved before the first provider event is emitted.

For agent routing, the gateway can also filter by `agentCapabilities`, such as provider support tier or approval-capable MCP support, before selecting the final target.

## Install

```bash
bun add @zhivex-ai/gateway @zhivex-ai/core @zhivex-ai/anthropic @zhivex-ai/openai @zhivex-ai/ollama @zhivex-ai/vertex
```

Install the provider packages used by your own adapter map; these examples use OpenAI, Ollama, Anthropic and Vertex.

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

The gateway also supports `streamText()`, `generateObject()`, and `streamObject()` through one Core generation loop. A provider is fixed once its stream emits, while a later model step in the same tool loop can still fail over before emitting provider output. Object routes skip incompatible targets before making a provider call: native mode requires `structuredOutput`, prompted mode requires `jsonMode`, and auto mode accepts either capability. In auto mode, the gateway prepares native output or a schema prompt for each destination independently, and `objectMode` reports the mode used by the final provider.

## Routing guarantees

- Text, object, and agent operations retry eligible failures on the current target and then continue through the ordered fallback targets. Agent routing happens inside one `runAgent()` or `streamAgent()` execution, so a fallback does not restart the agent, duplicate its run, or replay completed tools.
- Text and object streaming fallback is resolved before the first event is exposed. Agent streams may expose lifecycle events such as `agent-run-start` first, but provider fallback is resolved before the first provider event. Once a provider stream emits an event, an error from that stream is propagated without mixing in another provider's transcript.
- `attemptTimeoutMs` and the per-provider `attemptTimeoutsMs` do more than reject the gateway promise: they abort a non-streaming provider call or a streaming call that has not produced its first event. After the first event, `streamIdleTimeoutMs` and `streamIdleTimeoutsMs` abort a provider that stops producing events; the default is 60 seconds and `false` explicitly disables it. A request-level `abortSignal` remains active for the full operation and stops pending retries, backoff, fallback routing, observers, and active streams.
- `ProviderHTTPError` is classified by its typed HTTP status. Status `408`, `429`, and `5xx` errors are retryable on the same target. Other `4xx` errors are not retried on that target, but an eligible fallback can still handle a provider- or model-specific rejection.
- Stream attempts record `provider-success` only after the provider iterator completes; `latencyMs` covers the full attempt. Failures after the first event, including provider error events and cancellation, produce a failed attempt without retry/fallback. `onAgentRoute` still fires on selection after the first provider event, before the terminal attempt exists. Iterator cleanup is best-effort and never delays timeout/cancellation or replaces the original failure.
- Retry waits honor finite non-negative `ProviderHTTPError.retryAfterMs`, taking the greater of that value and the configured linear backoff, capped at 60 seconds per wait. Caller cancellation interrupts the wait.
- Attempt diagnostics redact credential-like URL parameters and bearer tokens before they are exposed through `attempts[].errorMessage` or observers.
- When `maxCostPer1kTokens` is set, a target without configured or catalog pricing is rejected by default. Set `unknownCostPolicy: "allow"` on `createGateway()` only when routing to models with unknown cost is acceptable.
- Requests containing image attachments only route to models that declare `capabilities.vision: true`. The gateway never removes images to make a target appear compatible; if one target cannot accept the original request, it is skipped in favor of a compatible fallback.
- `scoreTarget(context)` can replace the built-in name-based heuristic with application metrics. It must return a finite number; higher scores route first.
- Routing amplification is bounded even if a request is assembled from external input: requests accept at most `maxFallbacks` targets (default 8, hard maximum 32), `maxRetries` cannot exceed 5, and `maxTotalAttempts` caps provider calls across the whole routed operation including later agent steps (default 32, hard maximum 128). Model IDs are non-empty, limited to 256 characters, and cannot contain control characters. `maxCostPer1kTokens` and configured/catalog costs must be finite and non-negative.
- `onAttempt` and `onAgentRoute` are best-effort observers. Legacy callbacks run detached; `observerMode: "await"` explicitly awaits attempt callbacks and `"background"` queues them with bounded capacity. They receive an `abortSignal` and are allowed `observerTimeoutMs` to finish (default 1 second); rejection, timeout, or request cancellation cannot retry successful provider work or block routing indefinitely.

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
| `runAgent`, `streamAgent` | Fresh canonical history imports; durable resumes use state/runId without resupplying messages |
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

## Usage accounting

`generate`, `generateObject`, `streamText().collect()` and `streamObject().collect()` preserve all reported `TokenUsage` fields, including `cachedInputTokens`, `cacheWriteTokens`, `reasoningTokens` and `speed`. Reported zeros remain zeros; missing optional details remain absent. Only missing `inputTokens`/`outputTokens` are estimated from text and a missing `totalTokens` is derived from those base counters. `estimated` is true if any of those three base counters was missing, including a derived total. Reasoning/cache details are never added again to the total. Agent results retain their existing usage aggregation without an `estimated` flag.

## Detailed cost valuation

Opt in with `costAccounting: { unknownCostPolicy: "allow" }` and an immutable `modelCatalog` carrying pricing metadata. `routeDecision.estimatedCosts` contains cold-cache preflight estimates from input length and `expectedOutputTokens` (or request `maxTokens`). They are estimates, not spending limits. With `unknownCostPolicy: "reject"`, destinations with unknown quotes are excluded before a call. The existing `maxCostPer1kTokens` budget remains independent.

Each actual `attempt` carries its reported `usage` and `cost`, including provider/model, currency, catalog/pricing versions, optional provenance source, components, assumptions and unknown reasons. A failed attempt without usage has `amount: null`; a successful fallback does not make that failure free. Sum amounts only when every actual attempt is known or explicitly estimated; otherwise total cost remains unknown. Streams use terminal usage, and partial stream failures preserve any usage already received.

`calculateModelCost()` is also exported from Core and SDK for standalone valuation. Input tokens must include cached reads and cache writes; these are subtracted from ordinary input before applying their separate prices. Missing cache counters remain unknown unless `cacheAssumption: "none"` explicitly assumes zeros. Missing relevant prices or base usage never become a free estimate. Long-context multipliers apply above the catalog threshold to all input classes and output. Zero tokens incur zero cost even when that unused category has no rate; its rate remains null.

Reasoning semantics vary between adapters. Set `reasoningAccounting: { openai: "included", gemini: "additional" }` only for the provider protocols you have verified: included leaves the output count unchanged, additional adds reasoning once. Without an explicit setting, a positive reasoning counter produces an unknown valuation. For standalone valuation this setting is a single string. The catalog does not describe fast-tier pricing, so `speed: "fast"` remains unknown. Invalid reported counters produce unknown accounting without retrying a successful model call. This API is neither billing nor a strict monetary budget.

## Local destination metrics

Pass `metrics: createGatewayMetrics({ windowMs: 60_000, maxTargets: 128, maxSamplesPerTarget: 256 })` to opt in. Query `metrics.snapshot({ provider, modelId })` for in-flight count, recent successes/errors/cancellations, full-attempt p50/p95 and first-text p95. Cold destinations return undefined; expired samples have no latency estimates. Client cancellation is excluded from provider error and latency samples. The clock is injectable through `now` for deterministic tests.

Storage is bounded by targets and samples. The least recently touched idle destination is evicted when full; if all target slots are active, a new destination remains untracked until capacity is available. No prompts, outputs, error payloads or credentials are retained. The default store is local to the process; applications may inject the synchronous `GatewayMetricsStore` contract. Hook failures are best effort. Do not put expensive synchronous work in a metrics hook.

With metrics enabled, explicitly returning an event/text/object stream iterator cancels that routed operation and releases the in-flight slot. This applies to all consumers of that operation, including collect. Consume the stream fully if you also need its final result. Caller abort and timeout also release slots even when a provider ignores its signal. An operation with no explicit return/abort continues until completion or timeout; the SDK cannot detect garbage collection as abandonment.

## Circuit breaker and adaptive routing

Pass `circuitBreaker: createGatewayCircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 })` to opt in to local closed/open/half-open circuits. Retryable errors (including 429/5xx and attempt timeouts) accumulate; validation, authentication and client cancellation do not. Open circuits receive no calls. Recovery allows one concurrent probe by default; successful probes close the circuit, failed probes reopen it. Late results from an older circuit epoch cannot close a newly opened circuit. When all eligible circuits are unavailable the operation raises `GatewayCircuitOpenError`.

Cooldown is `min(maxCooldownMs, max(cooldownMs, Retry-After))`, with defaults of 60 seconds maximum and 30 seconds minimum. The circuit never sleeps until recovery: it skips the target. Existing bounded retry backoff applies only while the circuit remains closed. Target storage is bounded; closed idle entries may be evicted, while capacity exhausted by active/open entries refuses admission. State observers receive only target IDs, state and timestamps, and run best effort. Metrics/circuit-enabled stream iterator return cancels the operation. Neither feature coordinates across processes.

`adaptiveRouting` is an explicit alternative to legacy scoring. Supply a policy version, nonnegative weights for `latency`, `cost`, `quality`, `load`, `errorRate`, positive `latencyScaleMs`/`costScale`, and explicit `coldStart`, `unknownCost`, `missingQuality` policies (`allow`/`reject`). Quality profiles carry a target, task `intent`, score in [0,1] and evaluation version. There are no model-name quality heuristics in this mode.

The score is quality reward minus normalized p95 latency, estimated request cost, in-flight load and observed error rate penalties. Enable `metrics` and `costAccounting` for those signals. Missing penalty signals under `allow` receive a conservative normalized penalty (default 1), missing quality/throughput receive no reward, and all remain listed as missing; `reject` excludes the destination. Expired samples become cold start. Capabilities and circuits are filtered before ordering, and circuits are rechecked atomically before each call. Ties preserve primary/fallback input order. `routeDecision.adaptive` records policy version, signals, profile versions and exclusions. Do not configure both `scoreTarget` and `adaptiveRouting`. These rules are transparent heuristics, not a claim of globally optimal routing.

## Composing configured agents

Pass `agent: configuredAgent` to `runAgent` or `streamAgent`. The gateway substitutes a routed LanguageModel and uses the existing Core runtime. Context schema, guardrails, output schema, compactor, approval signer, subagents, harness binding, environment, hooks and store remain on the definition. Supply ephemeral `context` on each invocation. Defined request options override definition defaults; policy and metadata merge shallowly. `compaction: false` explicitly disables the default for an invocation. The original definition is not mutated.

Configured gateway runs persist a `gatewayAgentRouteBinding` metadata value for agent ID, primary/fallback targets, routing policy version and harness fingerprint. Resume must retain that binding; changing it fails before provider work. An older direct run without this binding requires a separately designed migration instead of silent adoption. Core still validates harness/environment fingerprints. Reserve `gatewayAgentRouteBinding` and `gatewayPortableHistory` for runtime use.

For canonical history, import a fresh run with `messages` only. Do not combine import with prompt, state, runId, handoff, approvals or idempotencyKey. Resolved historical tools are input, never effects to replay. Then resume with store/runId or state and approvals as needed, without messages. Portable-history capability checks survive store reloads and compaction. Legacy inputs remain supported. Provider-specific approval data stays in durable state; it is not part of the portable history import format.


## Production controls

All controls below are optional and compose with text, object and agent routing.
They do not require provider-specific changes. Existing default adapter maps and
legacy scoring remain supported. Adaptive missing-data penalties are intentionally
more conservative than the previous zero-penalty behavior.

```ts
import {
  createGateway, createGatewayAdmissionController, createGatewayBudgetStore,
  createGatewayMetrics, createGatewayRoutingPolicy
} from "@zhivex-ai/gateway";
import { createInMemoryGenerateCache, createModelCatalog } from "@zhivex-ai/core";
import { createOpenAI } from "@zhivex-ai/openai";

// Supply a verified catalog snapshot for your actual models before enabling cost routing.
const catalog = createModelCatalog([{
  provider: "openai", modelId: "your-model",
  inputCostPer1kTokens: 0.001, outputCostPer1kTokens: 0.003
}], { snapshotVersion: "example-only", pricing: {
  version: "example-only", currency: "USD", unit: "per_1k_tokens"
} });
const budgets = createGatewayBudgetStore({ limit: 20, currency: "USD" });
const gateway = createGateway({
  adapters: { openai: createOpenAI() },
  modelCatalog: catalog,
  costAccounting: { unknownCostPolicy: "reject", cacheAssumption: "none" },
  timeoutMs: 20_000,
  metrics: createGatewayMetrics(),
  adaptiveRouting: createGatewayRoutingPolicy("interactive"),
  admission: createGatewayAdmissionController({
    maxConcurrent: 16, requestsPerMinute: 600, tokensPerMinute: 100_000,
    maxQueue: 32, queueTimeoutMs: 500
  }),
  budget: { store: budgets, currency: "USD", reserveAmount: 0.10 },
  cache: { store: createInMemoryGenerateCache(), scope: "credential-revision-1" },
  affinity: { ttlMs: 300_000, maxEntries: 1000, maxScoreLoss: 0.1 },
  observerMode: "background", observerQueueCapacity: 256
});
const result = await gateway.generate({
  primary: { provider: "openai", modelId: "your-model" },
  messages: [{ role: "user", content: "Explain binary search." }],
  maxTokens: 200, budgetScope: "tenant-123:2026-09", cacheScope: "tenant-123",
  affinityKey: "conversation-456"
});
await gateway.flushObservers();
await gateway.flushControls();
console.log(result.text, gateway.diagnostics(), budgets.snapshot("tenant-123:2026-09"));
```

### Deadline and admission

`timeoutMs` covers one invocation, including queueing, retries, backoff, tools,
observers and streamed output. A request may shorten the configured deadline but
cannot extend it. Expiration raises `GatewayDeadlineError` and aborts downstream
signals. Providers/tools must cooperate to stop external effects; ignoring abort
cannot keep the gateway response pending indefinitely. Durable resumes start a
new invocation deadline. Normal completion removes timers and signal listeners.

Admission is per provider/model/deployment and happens before every upstream
call, including retries and later agent steps. Concurrency slots are released on
completion, abort or stream iterator return. The global queue is bounded and
waits at most `queueTimeoutMs`; the local implementation polls at up to 10 ms
intervals and does not promise strict FIFO fairness. Capacity denial skips to an
eligible fallback without marking the destination unhealthy.

RPM and TPM use fixed 60-second windows. TPM reserves serialized input length / 4
plus `maxTokens`, and requires `maxTokens`; this is an estimate, not provider token
parity. Reported total tokens reconcile reservations in the same window; unknown
usage keeps the reservation. RPM is not refunded after admission. Capacity
pressure never evicts an unexpired quota window. Set upstream provider limits as
the final boundary for usage the provider may continue after cancellation.

### Monetary reservations

Each dispatched model attempt reserves `budget.reserveAmount` in the trusted
`budgetScope`. Successful known usage reconciles that amount against catalog
pricing; failed, cancelled, partial or unpriceable usage retains the reservation
as uncertain spend. No reservation is made for an exact cache hit. Budget denial
stops the operation without retry or fallback. The configured currency must
match the catalog valuation to release any unused reservation.

This limits **admitted reservations**, not the exact provider invoice. Choose a
conservative per-attempt reservation alongside `maxTokens`; actual reported cost
can exceed the reservation and is recorded fully, blocking subsequent work when
the scope is exhausted. Unknown spend remains blocked until the application
reconciles its accounting externally. Local scopes never evict or automatically
reset; use explicit period scopes and bounded `maxScopes`. Do not use arbitrary
client-supplied scope values. For authoritative billing, implement the store
against the service's durable ledger.

`GatewayBudgetStore` and `GatewayAdmissionController` are asynchronous injection
contracts for shared backends. The supplied factories are process-local; they do
not implement Redis or cross-process coordination. Remote implementations must
reserve atomically, expire abandoned concurrency leases, honor abort and make
settlement/release idempotent. Settlement runs outside the provider response path. Failed or timed-out settlement
cannot retry successful provider work; diagnostics report it and further budgeted dispatches fail closed on that
gateway instance. Recover the backend/ledger before replacing the instance.

### Adaptive policies and destination identity

`createGatewayRoutingPolicy("interactive" | "economy" | "quality")` returns an
explicit versioned starting policy. Configure quality profiles for economy and
quality presets, which reject missing quality. Calibrate costs and latency scales
on your workload; presets are not measured service-level guarantees.

`latencyMetric: "ttft"` uses first-text latency; `"total"` retains full-attempt
latency. Optional `weights.throughput` uses measured median output tokens/second
with `throughputScale` (default 100). Throughput is an approximation using reported
output tokens minus the first token and elapsed time after first text. Cache hits
and cancellations do not supply provider latency evidence. `minSamples` prevents
single samples from being treated as mature health evidence, and `minQuality`
enforces an evaluated quality floor before ranking.

Allowed missing latency/cost/load/error signals incur `missingSignalPenalty`
(default 1, minimum 1). They are never represented as measured zero cost/latency.
`explorationEvery` optionally probes one eligible cold destination every N
operations; presets use 20. Exploration rotates candidates and cannot bypass
capability, cost, quality-floor or circuit exclusions. It is local and deterministic,
not a learned optimal policy.

A target may supply `deploymentId`. Register it in
`deployments: { "region-a": { provider: "openai", adapter } }` with an adapter
configured for that endpoint, region and credential. Unknown or mismatched IDs
are skipped without silently using the default adapter. Deduplication, metrics,
circuits, quotas, quality profiles, cache partitions and attempt diagnostics
include deployment identity. Catalog pricing still uses provider/model identity;
deployment-specific negotiated tariffs require a separate pricing design.

Optional affinity requires adaptive routing and both `cacheScope` and
`affinityKey`. After a successful attempt, subsequent invocations may reuse that
destination only if it remains eligible and within `maxScoreLoss` of the best
score. Expired entries are ignored; capacity evicts the oldest stored affinity.
Exploration takes precedence. This promotes provider prompt-cache locality; it
does not prove an upstream cache hit or change provider caching parameters.

### Exact cache and observer lifecycle

Gateway caching reuses Core's canonical cache key middleware and configured store.
It requires both a configured authentication scope and a per-request `cacheScope`;
keys additionally include budget scope and deployment. Rotate the configured scope
when credentials/endpoints change. Store TTL/retention belongs to the selected
Core cache implementation. No semantic similarity cache is enabled.

Only non-streaming text-only model steps without tools or `providerOptions` are
eligible. Tool effects, portable tool history, images and provider state bypass
this cache. Identical simultaneous misses share one upstream call (up to 1024
active keys). One caller cancelling does not cancel the other subscribers; all
subscribers leaving aborts the shared call. Cache reads time out after `cache.timeoutMs` (default 50 ms); writes are detached,
bounded to 256 pending operations and use the same timeout. Cache failures do not
retry successful provider work. `flushControls()` waits for the current cache-write
and resource-settlement batch; resource settlements have `resourceTimeoutMs`
(default 1000 ms). Pending counts and dropped cache writes are available in diagnostics. `attempt.cacheHit` identifies reuse, and detailed attempt valuation
uses zero new upstream tokens; response usage still describes the reused output.
A coalesced follower is also a reuse; correlate requests with your application
ledger when attributing the originating call's cost.

The legacy observer behavior stays detached. `observerMode: "background"` adds a
bounded FIFO attempt queue, `diagnostics().droppedObservers`, and
`flushObservers()` for the currently queued batch. Every callback remains bounded
by `observerTimeoutMs`. `"await"` explicitly awaits attempt observers. None of
these modes can preempt synchronous CPU work inside a callback. Route-selection
observers keep their existing detached behavior.


### Verification

Run `bun run test packages/gateway/tests` for routing and resource-lifetime
regressions. After `bun run build`, run
`bun scripts/benchmarks/gateway-controls.mjs /tmp/gateway-controls.json` to compare
local default/control overhead and verify exact-cache/shared-miss provider call
counts. The benchmark asserts correct answers and actual fixture calls, includes
runtime/source/artifact fingerprints, and explicitly excludes live provider
performance or competitive claims. Its five measured trials are a smoke baseline,
not a statistically reliable production tail-latency estimate.
