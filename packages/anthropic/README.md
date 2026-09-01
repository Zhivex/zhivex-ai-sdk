# @zhivex-ai/anthropic

Anthropic adapter for Zhivex AI SDK, with first-class Claude Opus 5 support.

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
