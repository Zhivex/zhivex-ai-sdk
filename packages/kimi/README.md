# @zhivex-ai/kimi

Kimi adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/core @zhivex-ai/kimi
```

## Kimi K3

`kimi-k3` is the default first-class model for long-horizon coding, knowledge work, reasoning, structured output, tools, and image/video understanding.

```ts
import { generateText } from "@zhivex-ai/core";
import { createKimi } from "@zhivex-ai/kimi";

const kimi = createKimi({ apiKey: process.env.KIMI_API_KEY });

const result = await generateText({
  model: kimi("kimi-k3"),
  prompt: "Analyze this implementation and propose the safest migration.",
  reasoning: { effort: "max" },
  maxTokens: 16_384
});
```

K3 always reasons. `reasoning.effort` maps to Kimi's top-level `reasoning_effort` and accepts `low`, `high`, and `max` (`max` is the provider default). Other efforts, including `medium` and `none`, are rejected before the request is sent. K2.x `thinking` options are rejected. `maxTokens` maps to `max_completion_tokens`, whose K3 range is 1 through 1,048,576.

K3 uses fixed sampling values (`temperature=1`, `top_p=0.95`, `n=1`, and zero presence/frequency penalties). The adapter accepts those exact values but omits them from the request, and rejects incompatible values before calling the API.

K3's 1M-token context uses automatic server-side prefix caching. The model advertises `contextCaching: true`. Cache hits are read from `usage.prompt_tokens_details.cached_tokens` (with a fallback to top-level `cached_tokens`) and normalized as `usage.cachedInputTokens`. Cache writes are read from `usage.prompt_tokens_details.cache_write_tokens` and normalized as `usage.cacheWriteTokens`. `completion_tokens_details.reasoning_tokens` is normalized as `usage.reasoningTokens`.

## Kimi K3.1 Pro

`kimi-k3.1-pro` and `kimi-k3.1-pro-highspeed` use the same K3 request contract: top-level `reasoning_effort` (`low`, `high`, `max`), `max_completion_tokens` up to 1,048,576, fixed sampling values, function tools, and base64 or `ms://` vision input. Requests still go to `https://api.moonshot.ai/v1`. `kimi-k3` remains the package default.

Pass `providerOptions.prompt_cache_options` as `{ ttl: "5m" }` or `{ ttl: "1h" }` when a cache lifetime other than the upstream 5-minute default is required. `mode` accepts only `"implicit"`. Moonshot unlocks K3.1 Pro after a successful platform top-up (minimum $1); the SDK does not add an access gate.

```ts
import { generateText } from "@zhivex-ai/core";
import { createKimi } from "@zhivex-ai/kimi";

const kimi = createKimi({ apiKey: process.env.KIMI_API_KEY });

await generateText({
  model: kimi("kimi-k3.1-pro"),
  prompt: "Review this migration.",
  reasoning: { effort: "high" },
  maxTokens: 16_384,
  providerOptions: {
    prompt_cache_options: { mode: "implicit", ttl: "1h" }
  }
});
```

K3 accepts `toolChoice: "auto"`, `"none"`, or `"required"`. Selecting one specific function is incompatible with always-on reasoning and is rejected locally. The adapter preserves `reasoning_content` across multi-step tool loops, including streaming calls.

## Official Formula tools

Kimi official tools are exposed through Formula URIs. The SDK helpers load or declare the Formula tool schema, pass it as a Chat Completions function tool, and execute the matching Formula fiber when Kimi returns a tool call.

```ts
import { createKimi, kimiFormulaTools, kimiWebSearchTool } from "@zhivex-ai/kimi";
import { generateText } from "@zhivex-ai/core";

const kimi = createKimi({ apiKey: process.env.KIMI_API_KEY });

await generateText({
  model: kimi("kimi-k3"),
  prompt: "Search for current information and summarize it.",
  reasoning: { effort: "max" },
  maxSteps: 2,
  toolChoice: "required",
  tools: {
    web_search: kimiWebSearchTool()
  }
});

const tools = await kimiFormulaTools({
  apiKey: process.env.KIMI_API_KEY,
  formulas: ["moonshot/web-search:latest", "moonshot/fetch:latest"]
});
```

Formula tools require approval by default, reject unsafe Formula resource paths and prototype-sensitive remote tool names, return a prototype-free tool set, and apply a 30-second request timeout. Use `requiresApproval: false` only when the caller has an equivalent policy boundary. `timeoutMs` can set a positive timeout up to 10 minutes; caller and agent abort signals are propagated to both loaded and statically declared Formula tools.

Built-in shortcuts include `kimiWebSearchTool()`, `kimiFetchTool()`, `kimiCodeRunnerTool()`, `kimiExcelTool()`, and `kimiDateTool()`. Current first-class model IDs are `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, and `kimi-k2.6`. Older ids such as `kimi-k2.5`, `kimi-k2-0905-preview`, and `kimi-k2-thinking` can still be passed through to the API, which documents them as retired.

Moonshot currently marks its Formula web-search tool as being updated and not recommended for near-term production workflows. The helper remains available for compatibility, but production use should follow the current upstream status.

`kimi-k2.7-code` and `kimi-k2.7-code-highspeed` always use preserved thinking mode. When common reasoning is supplied, the SDK maps it to `thinking: { type: "enabled", keep: "all" }`; disabled thinking, `toolChoice: "required"`, specific forced tools, and non-default sampling controls are rejected before the request is sent. K2.6 also does not accept `toolChoice: "required"`.

Kimi K3, K2.7 Code, and K2.6 support image and video understanding. The SDK preserves message-part order, accepts base64 data and `ms://` file references, and rejects unsupported public HTTP(S) media URLs before fetch.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>

## Retired model catalog entries

The Open Platform changelog documents that `kimi-k2.5`, the `moonshot-v1` series, and the `kimi-k2` series (including `kimi-k2-0905-preview`) return 404. Those ids are no longer in the release-managed SDK catalog. `kimi-k2.6` and `kimi-k2.7-code` remain. Prefer `kimi-k3` for new work.

See the [platform changelog](https://platform.kimi.ai/docs/platform-changelog).
