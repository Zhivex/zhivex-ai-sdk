# @zhivex-ai/kimi

Kimi adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/kimi
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

K3 always reasons. The shared `reasoning.effort: "max"` option maps to Kimi's top-level `reasoning_effort: "max"`; K2.x `thinking` options are rejected. `maxTokens` maps to `max_completion_tokens`, whose K3 range is 1 through 1,048,576.

K3 uses fixed sampling values (`temperature=1`, `top_p=0.95`, `n=1`, and zero presence/frequency penalties). The adapter accepts those exact values but omits them from the request, and rejects incompatible values before calling the API.

K3's 1M-token context uses automatic server-side prefix caching. The model advertises `contextCaching: true`, and Kimi `cached_tokens` usage is normalized as `usage.cachedInputTokens`.

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

Built-in shortcuts include `kimiWebSearchTool()`, `kimiFetchTool()`, `kimiCodeRunnerTool()`, `kimiExcelTool()`, and `kimiDateTool()`. Current first-class model IDs are `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.6`, and `kimi-k2.5`. The older `kimi-k2-0905-preview` and `kimi-k2-thinking` IDs are kept for passthrough compatibility but are deprecated upstream.

Moonshot currently marks its Formula web-search tool as being updated and not recommended for near-term production workflows. The helper remains available for compatibility, but production use should follow the current upstream status.

`kimi-k2.7-code` and `kimi-k2.7-code-highspeed` always use preserved thinking mode. When common reasoning is supplied, the SDK maps it to `thinking: { type: "enabled", keep: "all" }`; disabled thinking, `toolChoice: "required"`, specific forced tools, and non-default sampling controls are rejected before the request is sent. K2.6 also does not accept `toolChoice: "required"`.

Kimi K3, K2.7 Code, and K2.6 support image and video understanding. The SDK preserves message-part order, accepts base64 data and `ms://` file references, and rejects unsupported public HTTP(S) media URLs before fetch.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
