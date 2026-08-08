# @zhivex-ai/anthropic

Anthropic adapter for Zhivex AI SDK, with first-class Claude Opus 5 support.

## Install

```bash
bun add @zhivex-ai/core @zhivex-ai/anthropic
```

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

Authenticated Anthropic requests reject redirects so a `307` or `308` cannot replay `x-api-key` or the prompt body to another origin. The adapter's explicit `rawFetch` escape hatch remains uncredentialed.

Official references:

- [Claude Opus 5](https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5)
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
- [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
