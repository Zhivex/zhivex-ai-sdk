# @zhivex-ai/deepseek

DeepSeek V4 adapter for Zhivex AI SDK. It targets DeepSeek's OpenAI-compatible Chat Completions API at `https://api.deepseek.com`.

## Install

```bash
bun add @zhivex-ai/deepseek
```

## Usage

```ts
import { generateText } from "@zhivex-ai/core";
import { createDeepSeek } from "@zhivex-ai/deepseek";

const deepseek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY
});

const result = await generateText({
  model: deepseek("deepseek-v4-pro"),
  prompt: "Compare BFS and DFS for pathfinding.",
  reasoning: {
    effort: "high"
  }
});

console.log(result.text);
```

## Current models

| Model | Context | Maximum output | Cached input / 1M | Input / 1M | Output / 1M |
| --- | ---: | ---: | ---: | ---: | ---: |
| `deepseek-v4-flash` | 1M | 384K | $0.0028 | $0.14 | $0.28 |
| `deepseek-v4-pro` | 1M | 384K | $0.003625 | $0.435 | $0.87 |

Flash is the fast, economical default. Pro is intended for the strongest reasoning and agentic workloads. Pricing is in USD and should be checked against the [official models and pricing page](https://api-docs.deepseek.com/quick_start/pricing) before making cost-sensitive decisions.

Use these V4 model IDs directly. DeepSeek scheduled the legacy `deepseek-chat` and `deepseek-reasoner` aliases for retirement on July 24, 2026 at 15:59 UTC.

## Capabilities

- text generation and streaming
- function tools, parallel tool calls, and `toolChoice`
- JSON object output through the shared structured-output API
- thinking and non-thinking modes on both V4 models
- automatic upstream context caching, including cached-input usage reporting
- preservation of `reasoning_content` across multi-step tool loops

DeepSeek thinking defaults to enabled upstream. In the shared `reasoning` option, `effort: "none"` disables it, `high` and `max` map directly, `low` and `medium` map to `high`, and `xhigh` maps to `max`. Manual `budgetTokens` is not supported.

Thinking mode supports tool loops, but DeepSeek V4 does not accept an explicit `tool_choice` field in that mode. Leave `toolChoice` unset while thinking is enabled. To use `toolChoice: "none"`, `"required"`, or a specific function choice, first select non-thinking mode with `reasoning: { effort: "none" }`.

Official Chat Completions fields such as `user_id`, `logprobs`, and `top_logprobs` are available through `providerOptions`. The adapter rejects deprecated `user`, `frequency_penalty`, and `presence_penalty` fields instead of silently sending ineffective values. DeepSeek does not support sampling controls such as `temperature` or `top_p` while thinking is enabled; use `reasoning: { effort: "none" }` for non-thinking sampling.

DeepSeek's stable JSON mode guarantees a JSON object but does not enforce an arbitrary JSON Schema. Ask explicitly for JSON in the prompt and set a sufficient token limit; DeepSeek notes that JSON mode can occasionally return empty content. Strict tool schemas are available as an opt-in Beta feature: pass `providerOptions: { strictTools: true }`. The adapter routes that request through DeepSeek's Beta endpoint automatically and marks every function as strict. DeepSeek applies a restricted JSON Schema subset in this mode.

## Chat prefix completion

`providerOptions.prefix` appends the required assistant prefix and routes the request through the Beta endpoint automatically:

```ts
const prefixed = await generateText({
  model: deepseek("deepseek-v4-pro"),
  prompt: "Write an iterative binary search function in TypeScript.",
  reasoning: { effort: "none" },
  providerOptions: {
    prefix: {
      content: "```ts\n"
    },
    stop: "```"
  }
});

console.log(prefixed.text);
```

For thinking-mode prefix completion, `prefix.reasoningContent` can provide the optional reasoning prefix.

## FIM, models, and balance

The callable provider also exposes DeepSeek's provider-specific clients:

```ts
const fim = await deepseek.fim.generate({
  prompt: "function fib(value: number): number {\n",
  suffix: "\n}",
  maxTokens: 256
});

for await (const event of await deepseek.fim.stream({
  prompt: "const answer = ",
  maxTokens: 64
})) {
  if (event.type === "text-delta") {
    process.stdout.write(event.textDelta);
  }
}

const { models } = await deepseek.models.list();
const balance = await deepseek.balance.get();

console.log(fim.text, models, balance.isAvailable);
```

FIM uses the Beta `/completions` endpoint automatically. The typed client currently permits only `deepseek-v4-pro`, non-thinking completion, and `maxTokens` from 1 through 4,096. This conservative model restriction follows the current FIM API schema; DeepSeek's broader pricing table lists both V4 models, so Flash should not be assumed without a live upstream confirmation. `models.list()` and `balance.get()` use the stable API.

This OpenAI Chat Completions adapter does not expose provider-hosted tools, remote MCP, hosted web search, embeddings, audio, vision, files, or realtime sessions. DeepSeek separately exposes web search through its Anthropic-compatible endpoint for supported agent integrations.

## Live validation

With a real DeepSeek key, run the opt-in extended integration suite from the repository root:

```bash
DEEPSEEK_EXTENDED_INTEGRATION=1 \
DEEPSEEK_API_KEY=... \
bun run test:integration:deepseek
```

It validates the shared text, streaming, tools, structured-output, and reasoning paths plus live model listing, balance lookup, FIM generate/stream, and chat prefix completion. `DEEPSEEK_BASE_URL` and `DEEPSEEK_BETA_BASE_URL` are optional endpoint overrides. A run without the opt-in flag or API key is skipped and does not count as live validation.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
