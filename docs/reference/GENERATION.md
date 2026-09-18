# Generation recipes

Text, structured output, streaming, reasoning, and HTTP response recipes.

[Documentation index](../README.md)

## Text Generation

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createAnthropic } from "@zhivex-ai/anthropic";

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const result = await generateText({
  model: anthropic("claude-opus-5"),
  system: "Be concise and technical.",
  prompt: "Explain what a provider adapter does."
});

console.log(result.text);
```

`createAnthropic()` also supports zero-argument authentication through `ANTHROPIC_AUTH_TOKEN`, named
Anthropic profiles, or Workload Identity Federation. Multi-workspace personal/service-account keys use
`workspaceId` or `ANTHROPIC_WORKSPACE_ID`. Async `apiKey` providers are resolved before every request,
while `credentials` providers and WIF/profile tokens are cached, refreshed before expiry, and retried
once with a forced refresh after a `401`.

## Streaming

`streamText()` exposes both a text-only stream for simple UX flows and a lower-level event stream for advanced handling.

```ts
import { streamText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Answer in two short sentences."
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}

const final = await result.collect();
console.log(final.finishReason);
```

## Reasoning Configuration

Use the shared `reasoning` option when you want to control reasoning behavior without coupling your app to provider-specific request fields.

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-5"),
  prompt: "Compare BFS and DFS for pathfinding.",
  maxTokens: 600,
  reasoning: {
    effort: "high"
  }
});

console.log(result.text);
```

Provider compatibility for the common `reasoning` option:

- OpenAI: supports `effort`; GPT-5.6 adds `effort: "max"` and the Responses-only `mode` / `context` controls
- Azure OpenAI: supports `effort`
- OpenRouter: supports `effort` and `budgetTokens`
- Anthropic:
  - Claude Opus 5 supports `low`, `medium`, `high`, `xhigh`, and `max` effort, adaptive thinking by default, native structured output, files, a 1M-token context window, and up to 128K output tokens
  - omit `thinking` to use Opus 5's default adaptive thinking; `thinking.disabled` is valid only with `low`, `medium`, or `high`, and manual `thinking.enabled + budget_tokens` is rejected
  - Opus 5 accepts only default sampling (`temperature: 1`, `top_p >= 0.99`, and no `top_k`) and does not support assistant prefill
  - for `xhigh` and `max`, Anthropic recommends starting with `maxTokens: 64_000` and tuning with evals
  - `providerOptions.speed = "fast"` adds the required fast-mode beta header automatically; fast mode is a separately provisioned, premium-priced research preview
  - `providerOptions.fallbacks = "default"` enables Anthropic-managed refusal fallback; explicit fallback arrays remain available with up to three unique models
  - `providerOptions.output_config.task_budget` and `providerOptions.midConversationToolChanges` add their required beta headers automatically
  - Claude Sonnet 5 supports `effort`, adaptive thinking, files, and mid-conversation system messages
  - Claude Fable 5 and Claude Mythos 5 support `effort`; adaptive thinking is always on, so the adapter sends only `output_config.effort` for common reasoning requests
  - current Claude families expose native structured output through `output_config.format`; this includes Opus 5, Sonnet 5, Fable/Mythos 5, Opus 4.6–4.8, Sonnet 4.5–4.6, and Haiku 4.5
  - Claude Opus 4.6 and later, Claude Sonnet 4.6 and later, and Claude Fable/Mythos 5 reject assistant prefill locally
  - Claude Mythos 5 remains limited-availability upstream; use it only for approved Anthropic accounts
  - Claude Fable 5 server-side refusal fallback is available with `providerOptions.fallbacks`; the adapter adds the required `server-side-fallback-2026-06-01` beta header automatically
  - Claude Opus 4.7 and later, including Claude Opus 4.8, support `effort`; `budgetTokens` is rejected
  - Claude Opus 4.5, Claude Opus 4.6, and Claude Sonnet 4.6 support `effort`; integration checks use `effort` instead of deprecated undersized manual thinking budgets
  - Claude Haiku 4.5 supports extended thinking through `budgetTokens`; it does not use the modern `effort` mapping
  - `budgetTokens` remains available only on Anthropic models that still accept manual thinking
  - Claude Opus 5, Claude Opus 4.8, and Claude Opus 4.7 accept provider-specific `providerOptions.speed = "fast"` for fast mode
- Gemini and Vertex:
  - Gemini 3 models support `effort`
  - Gemini 2.5 and earlier models support `budgetTokens`
- Qwen:
  - supported on reasoning-capable model families such as `qwen3.8-flash`, `qwen3.8-max`, `qwen3.8-max-preview`, `qwen3.7-plus`, `qwen3.7-max`, `qwen-plus`, `qwen-turbo`, `qwq`, and `qwen3*`
  - production `qwen3.8-flash` and `qwen3.8-max` are hybrid and expose all seven shared efforts in Responses; Chat normalizes them to native `low`, `medium`, or `xhigh`, while `none` disables thinking
  - production and preview Chat requests preserve `reasoning_content`, reject simultaneous effort and budget controls, cap thinking budgets at 262144, and send `maxTokens` as `max_completion_tokens`
  - while Qwen 3.8 thinking is active, forced or named tool choices are rejected; production Flash and Max can use them after thinking is disabled
  - `qwen3.8-flash` supports native JSON Schema structured output; Omni 3.8 uses prompted structured output with local validation; other supported Qwen models retain JSON-object mode
  - automatic API routing selects Chat for token budgets, audio/video inputs, structured output, and `tool_stream`; hosted tools, OCR files, and response continuations use Responses
  - older families retain the generic Responses mapping where shared `low` becomes Qwen `minimal`
- Kimi:
  - `kimi-k3` always reasons and maps `effort: "max"` to top-level `reasoning_effort: "max"`; lower efforts are rejected until upstream enables them
  - K2.6, K2.5, and legacy thinking models map to Kimi `thinking.enabled/disabled`; K2.7 Code uses preserved `thinking.enabled` with `keep: "all"`
  - K3 and K2.7 Code reject non-default `temperature`, `top_p`, `n`, `presence_penalty`, and `frequency_penalty` values
  - K3 maps shared `maxTokens` to `max_completion_tokens` and accepts values up to 1,048,576
  - `budgetTokens` is not supported in the common mapping
  - K3 supports `toolChoice: "required"`; selecting one specific tool remains incompatible with reasoning
  - K3, K2.7 Code, and K2.6 accept base64 or `ms://` image/video references; public HTTP(S) media URLs are rejected
- DeepSeek:
  - supported on `deepseek-v4-flash` and `deepseek-v4-pro`
  - `effort: "none"` disables thinking; `high` and `max` map directly to DeepSeek `reasoning_effort`
  - for compatibility with the shared contract, `low` and `medium` map to DeepSeek `high`, while `xhigh` maps to `max`
- Z.ai:
  - `glm-5.3` and `glm-5.3-flash` require thinking and accept `low`, `high`, or `max`; unsupported efforts and disabled thinking fail before network I/O
  - `glm-5.3-flash` accepts ordered image inputs as public HTTP(S) URLs, image Data URLs, or raw base64 normalized by the adapter; other Z.ai model IDs remain text-only
  - `glm-5.2` maps `none`/`minimal` to disabled thinking, `low`/`medium` to `high`, and `xhigh` to `max`
  - use the default general endpoint for pay-as-you-go access or `endpoint: "coding"` with Coding Plan credentials
  - leave `toolChoice` unset while thinking is enabled; explicit choices require non-thinking mode
  - `budgetTokens` is not supported in the common mapping
- Ollama:
  - shared reasoning is enabled for recognized Qwen 3/3.5, GPT-OSS, DeepSeek R1/v3.1, Gemma 4, and Muse Glimmer model IDs; custom models can use `providerOptions.think`
  - most recognized families preserve `low`, `medium`, `high`, and `max`; `none` maps to `think: false`
  - Muse Glimmer accepts `none`, `low`, `medium`, or `high`; `max` is rejected
  - GPT-OSS accepts only `low`, `medium`, or `high` and cannot disable thinking
  - returned thinking is preserved as provider data and replayed through multi-step tool loops
- Bedrock: not supported through the shared reasoning option

Claude Opus 5 production controls:

```ts
const result = await generateText({
  model: anthropic("claude-opus-5"),
  prompt: "Plan and review this migration.",
  maxTokens: 64_000,
  reasoning: { effort: "xhigh" },
  providerOptions: {
    fallbacks: "default",
    output_config: {
      task_budget: {
        type: "tokens",
        total: 64_000
      }
    },
    midConversationToolChanges: true
  }
});
```

Fast mode is opt-in: add `speed: "fast"` under `providerOptions` only after Anthropic enables the research preview for the account. The adapter composes and deduplicates the fast, task-budget, fallback, MCP, Files API, and mid-conversation beta headers. It also preserves fallback and other provider-native response blocks as `provider-data`.

Claude Fable 5 explicit refusal fallback:

```ts
const result = await generateText({
  model: anthropic("claude-fable-5"),
  prompt: "Help me assess this request.",
  reasoning: { effort: "high" },
  providerOptions: {
    fallbacks: [{ model: "claude-opus-4-8" }]
  }
});

console.log(result.providerFinishReason, result.text);
```

When a provider or model does not support the requested `reasoning` field, the SDK throws an explicit error instead of silently ignoring it. For the broader matrix, see [Provider Compatibility](../../README.md#provider-compatibility).

For Qwen, Kimi, DeepSeek, and Z.ai, the SDK also preserves provider reasoning state across multi-step loops by storing `reasoning_content` inside assistant `provider-data` parts and replaying it on subsequent requests when needed.

## HTTP Responses and UI Streams

The SDK can convert streaming results into Web `Response` objects for server frameworks and edge runtimes.

```ts
import { streamText, toTextStreamResponse } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Stream a short answer."
});

return toTextStreamResponse(result);
```

For richer event payloads and UI-oriented transport:

```ts
import { streamText, toUIMessageStreamResponse } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Stream a short answer."
});

return toUIMessageStreamResponse(result);
```

Existing AI SDK UI applications can keep `useChat` and their message reducer by
using the Beta `@zhivex-ai/react/compat` entrypoint. It certifies `ai` 7.x with
`@ai-sdk/react` 4.x, maps Zhivex events to the AI SDK UI v1 stream protocol, and
retains bounded parsing, abort propagation, safe errors, and redirect rejection.
See [AI SDK UI Compatibility](../AI_SDK_UI_COMPAT.md).

## Structured Output

Structured generation supports `native`, `prompted`, and `auto` modes. `native` should be preferred when the selected provider/model supports schema-constrained responses.

```ts
import { generateObject } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";
import { z } from "zod";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const recipe = await generateObject({
  model: gemini("gemini-3.7-flash"),
  prompt: "Return JSON with title and servings.",
  mode: "native",
  schema: z.object({
    title: z.string(),
    servings: z.number()
  })
});

console.log(recipe.object);
console.log(recipe.objectMode);
```

## Structured Output Streaming

```ts
import { streamObject } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = streamObject({
  model: openai("gpt-4o-mini"),
  prompt: "Return JSON with title and servings.",
  mode: "native",
  schema: z.object({
    title: z.string(),
    servings: z.number()
  })
});

for await (const partial of result.partialObjectStream) {
  console.log(partial);
}

const final = await result.collect();
console.log(final.object);
```

