# @zhivex-ai/anthropic

Anthropic adapter for Zhivex AI SDK, with model-specific Claude thinking and tool controls.

## Claude Sonnet 5.5

Use `createAnthropic()("claude-sonnet-5-5")`. Adaptive thinking is on by default with API effort `high`; shared `reasoning.effort` accepts `low`, `medium`, `high`, `xhigh`, and `max`. Shared `reasoning.effort: "none"` maps to `thinking: { type: "between_tools" }`: it turns off up-front thinking, while progress between tools may still appear as signed thinking blocks. This is the model's lowest thinking setting, not a promise of no thinking blocks.

```ts
import { generateText } from "@zhivex-ai/core";
import { createAnthropic } from "@zhivex-ai/anthropic";

const result = await generateText({
  model: createAnthropic()("claude-sonnet-5-5"),
  prompt: "Reply with one short greeting.",
  reasoning: { effort: "none" },
  maxTokens: 1024,
});
console.log(result.text);
```

Alternatively, set `providerOptions.thinking: { type: "between_tools" }` with effort `low`, `medium`, or `high`. This mode takes no other thinking fields: `display`, `budget_tokens`, and `block_binding` are rejected, as are `xhigh`/`max` effort. Raw `thinking.disabled`, manual budgets, forced tool choice (`required`, named tools, native `any`/`tool`), assistant prefill, and non-default sampling controls fail locally before generation or streaming. Use automatic tools and native structured output for schemas. Sonnet 5 retains its existing disabled-thinking and forced-tool behavior.

With adaptive thinking, `display: "updates"` and `block_binding: { prefix_mismatch_behavior: "drop_block" }` use the corresponding beta headers. Generation preserves signed blocks and streaming exposes thinking/signature deltas as provider data. Replay returned history unchanged and append new turns: thinking is bound to the model, account, and conversation. With `between_tools`, binding controls are unavailable; applications editing history must remove affected thinking blocks themselves.

On the direct API, use `computer_toolset_20260801`; `computer_20250124` and `computer_20251124` are rejected. The toolset declaration omits `name`, and member calls/results retain `toolset_name`. A native `advisor_20260301` tool must select an Opus 5/5.5, Fable 5/5.1, Mythos 5/5.1, or Sonnet 5.5 advisor; rejected legacy pairings fail locally. `providerOptions.fallbacks: "default"` is accepted with its beta header. On-demand compaction uses the existing `compaction` option. Per-message effort and inline tool definitions do not yet have dedicated shared helpers.

The SDK-owned catalog includes direct API input/output and cache pricing; Vertex has a separate entry without inferred prices. This does not certify Bedrock or other hosts. The opt-in direct smoke covers text/usage, streaming, native JSON, a tool loop, and progress/binding controls with history replay:

```bash
ZHIVEX_SONNET55_LIVE=1 bun --env-file=.env run test:integration packages/anthropic/tests/sonnet55.integration.test.ts
```

Missing credentials skip these tests and do not constitute live certification. The [September 28 validation report](../../docs/maintainers/SONNET_55_SUPPORT_2026_09_28.md) records the five passing direct live checks and their scope. Sources: [Sonnet 5.5 specifications](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), [breaking changes](https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5).

## Claude Opus 5.5

Use `createAnthropic()("claude-opus-5-5")`. Adaptive thinking is always on; omit thinking configuration or use `thinking.type: "adaptive"`. Supported reasoning efforts are `low`, `medium` (provider default), `high`, `xhigh`, and `max`. Disabling thinking, manual token budgets, and forced tool choice (`required` or a named tool, including native `any`/`tool`) fail locally. Use `auto` or `none` tool choice and native structured output for schema-constrained responses.

Progress between tools arrives in thinking blocks. Set `providerOptions.thinking.display: "updates"` to receive progress, and optionally `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` when editing earlier context. The adapter adds the corresponding beta headers and preserves opaque thinking blocks in generation history; keep history append-only when replaying signatures.

On the direct API, replace `computer_20251124` with a generic `hostedTool` whose provider is `anthropic` and type is `computer_toolset_20260801`. The adapter emits the toolset without a `name` field. Your application must handle member tool calls, batch actions, and `toolset_name`; this does not install a computer executor. Old computer tool requests fail locally on Opus 5.5. Existing Opus 5 behavior is preserved.

See the official [Opus 5.5 overview](https://platform.claude.com/docs/en/models/opus-5-5/overview) and [breaking changes](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5).

## Install

```bash
bun add @zhivex-ai/core @zhivex-ai/anthropic
```

## Authentication

`createAnthropic()` resolves the current Anthropic credential chain automatically. Existing
`ANTHROPIC_API_KEY` configurations continue to send `x-api-key`; `ANTHROPIC_AUTH_TOKEN` sends a
Bearer token. With neither variable set, the adapter resolves an explicit `profile`,
`ANTHROPIC_PROFILE`, the complete Workload Identity Federation environment, or the active Anthropic
profile. WIF and profile tokens are cached, refreshed before expiry, and force-refreshed once after a
`401` response.

```ts
// ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, a profile, or WIF environment.
const anthropic = createAnthropic();
```

For a personal or service-account API key that spans multiple workspaces, select the workspace with
`workspaceId` or `ANTHROPIC_WORKSPACE_ID`:

```ts
const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  workspaceId: process.env.ANTHROPIC_WORKSPACE_ID
});
```

Long-running applications can rotate API keys without rebuilding the provider, or supply a custom
access-token provider with expiry metadata:

```ts
const anthropic = createAnthropic({
  apiKey: async () => secrets.get("anthropic-api-key")
});

const federatedAnthropic = createAnthropic({
  credentials: async ({ forceRefresh } = {}) => tokenBroker.getAnthropicToken({ forceRefresh })
});
```

Credential precedence matches Anthropic: explicit constructor authentication, environment API key or
auth token, explicit/named profile, federation environment, then the active profile. An explicit
`profile` suppresses ambient `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`. API keys take precedence
over Bearer credentials when both are explicitly configured.

## Claude Opus 5

```ts
import { generateText } from "@zhivex-ai/core";
import { createAnthropic } from "@zhivex-ai/anthropic";

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const result = await generateText({
  model: anthropic("claude-opus-5"),
  prompt: "Review this architecture and identify the highest-risk assumption.",
  maxTokens: 64_000,
  reasoning: {
    effort: "xhigh"
  }
});

console.log(result.text);
```

The model advertises the complete shared effort ladder: `none`, `low`, `medium`, `high`, `xhigh`, and
`max`. Omitting `reasoning` leaves Opus 5's default adaptive thinking untouched. `none` maps to
`thinking.disabled`; disabling thinking with `xhigh` or `max` is rejected before the network request.
Manual thinking budgets, non-default sampling, and assistant prefills are also rejected locally.

Native structured output is available through `generateObject()` and `streamObject()` across current
Claude families, including Opus 5, Sonnet 5, Fable/Mythos 5, Opus 4.6–4.8, Sonnet 4.5–4.6, and Haiku
4.5. The adapter maps the shared schema to `output_config.format` without a legacy beta header.

Provider-specific Opus 5 controls are typed:

```ts
const result = await generateText({
  model: anthropic("claude-opus-5"),
  prompt: "Run the task within the declared token budget.",
  maxTokens: 64_000,
  reasoning: { effort: "max" },
  providerOptions: {
    fallbacks: "default",
    output_config: {
      task_budget: {
        type: "tokens",
        total: 64_000,
        remaining: 48_000
      }
    },
    midConversationToolChanges: true
  }
});
```

The adapter automatically adds and composes the beta headers required for task budgets, managed or
explicit server-side fallbacks, mid-conversation tool changes, MCP, and Files API. Set
`providerOptions.speed = "fast"` only when Anthropic has enabled the premium fast-mode research preview
for the account; the adapter then adds `fast-mode-2026-02-01`.

Usage maps uncached input, cache reads, cache writes, output, thinking tokens, total tokens, and the
reported standard/fast speed. Unknown provider-native blocks—including fallback metadata—are preserved
as `provider-data`.

The package also supports current Claude families such as Claude Sonnet 5, Claude Fable 5, Claude
Mythos 5, Claude Opus 4.8, and Claude Haiku 4.5, with model-specific capability validation. Models
that reject assistant-prefilled conversations fail locally before an API request is attempted.

Authenticated Anthropic requests and WIF token exchanges reject redirects so a `307` or `308` cannot
replay an API key, Bearer token, identity assertion, or prompt body to another origin. The adapter's
explicit `rawFetch` escape hatch remains uncredentialed.

Official references:

- [Claude Opus 5](https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5)
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
- [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)
- [Authentication](https://platform.claude.com/docs/en/manage-claude/authentication)
- [Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation)

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>

## Claude Fable 5.1 and Mythos 5.1

`claude-fable-5-1` and `claude-mythos-5-1` use the existing adaptive-thinking, structured-output, and streaming mappings. Forced tools (`required` or a named tool, including raw `tool_choice`) are rejected before fetch. Use automatic tool choice or disable tools with `none`. Mythos 5.1 is invitation-only and is not included in catalog recommendations.

`providerOptions.thinking.display: "updates"` automatically adds `thinking-display-updates-2026-08-18`. The optional `thinking.block_binding.prefix_mismatch_behavior` accepts `error` or `drop_block` and adds `thinking-binding-controls-2026-08-01`. Keep conversations append-only when preserving thinking: changing earlier messages, system instructions, or tools can invalidate later blocks. The SDK never silently drops or rewrites those blocks; opt into upstream `drop_block` explicitly when needed and inspect the raw response for input transformations.

See [Anthropic's migration contract](https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1). Per-message effort and turn-scoped system-message metadata are not yet exposed as dedicated shared helpers.

## Reusing the Messages protocol for cloud hosts

`createAnthropicMessagesModel({ modelId, transport, provider, capabilities })` is an advanced adapter-building helper. It reuses Claude message, tool, reasoning, structured-output, and stream mapping without resolving direct Anthropic credentials. The `AnthropicMessagesTransport.send(body, signal, withMcpToolset, withFilesApi, betas)` callback owns authentication, routing, unsupported-feature checks, and HTTP status handling. Capability overrides are shallow; cloud hosts must constrain them to their own supported contract. Application code should use `createAnthropic()` for the direct API or `createVertex()` from `@zhivex-ai/vertex` for Claude on Google Cloud.

### Generation retries

Language-model generation and streaming startup validate HTTP failures inside the retry boundary. `maxRetries` applies to HTTP 408, 429 and 5xx responses, with bounded `Retry-After` waits. Other 4xx responses are not retried. Timeout and caller cancellation interrupt retry waits; successful stream bodies remain unread until consumption.

## On-demand compaction (Beta)

```ts
const model = anthropic("claude-opus-5");
const summary = await model.generate({
  messages: history,
  maxTokens: 4096,
  providerOptions: { compaction: { type: "summarize" } }
});
// Only replace the submitted prefix when a signed summary was returned.
if (summary.providerFinishReason === "compaction" && summary.messages[0]?.parts.length) {
  history = summary.messages;
}
```

The adapter automatically sends `compact-2026-09-04` for summarization and replay of a signed block. Keep the returned `provider-data` block, including its signature, unchanged and first in the non-system history. For background/keep-tail compaction, replace exactly the submitted prefix and retain later turns; preserve the same system/tools when relying on preserved thinking. A completed assistant turn can be summarized without being treated as an assistant prefill. No history is replaced automatically. Empty or refused summaries remain visible in `providerFinishReason`; retain the original history.

`compaction` cannot be combined with `context_management`, stop sequences, structured output, or forced tool choice. Optional `instructions` must be non-blank and at most 16,384 characters. Usage aggregates billed `usage.iterations` rather than the zero top-level counters of summary-only responses. Raw responses retain the provider breakdown. See [Anthropic compaction](https://platform.claude.com/docs/en/build-with-claude/compaction).

## Managed Agents (native Beta)

`createAnthropic(options).managedAgents` exposes the installed official SDK's `agents`, `environments`, and `sessions` resources, including session event streaming, pagination, cancellation via input events, and tool confirmations. Types and errors are native Anthropic SDK types. Zhivex supplies its existing credential chain, refresh handling, endpoint policy, and `managed-agents-2026-04-01` header. Automatic request retries are disabled; caller request options can explicitly opt in using the native SDK.

```ts
const native = anthropic.managedAgents;
const agent = await native.agents.create({
  name: "Support", model: "claude-opus-5", system: "Help with support requests.",
  tools: [{ type: "agent_toolset_20260401", default_config: { permission_policy: { type: "auto" } } }]
});
const session = await native.sessions.create({ agent: agent.id, environment_id: "env_existing" });
const events = await native.sessions.events.stream(session.id);
try {
  await native.sessions.events.send(session.id, { events: [{ type: "user.message", content: [{ type: "text", text: "Inspect the project" }] }] });
  for await (const event of events) {
    console.log(event); // evaluated_permission and evaluation are preserved
    if (event.type === "session.status_idle") break;
  }
} finally { events.controller.abort(); }
```

`auto` is a server decision and can execute a call without human review. Use `always_ask` when a human checkpoint is required. These resources run on Anthropic's platform and do not use Zhivex's local agent persistence or approval queues. The September certification additionally exercises a real managed session, automatic permission evaluation, a successful tool result, idle state, and cleanup; see the [scoped evidence report](../../docs/maintainers/WEEKLY_PROVIDER_LIVE_2026_09_16.md). See [permission policies](https://platform.claude.com/docs/en/managed-agents/permission-policies).
