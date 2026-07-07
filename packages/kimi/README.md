# @zhivex-ai/kimi

Kimi adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/kimi
```

## Official Formula tools

Kimi official tools are exposed through Formula URIs. The SDK helpers load or declare the Formula tool schema, pass it as a Chat Completions function tool, and execute the matching Formula fiber when Kimi returns a tool call.

```ts
import { createKimi, kimiFormulaTools, kimiWebSearchTool } from "@zhivex-ai/kimi";
import { generateText } from "@zhivex-ai/core";

const kimi = createKimi({ apiKey: process.env.KIMI_API_KEY });

await generateText({
  model: kimi("kimi-k2.7-code"),
  prompt: "Search for current information and summarize it.",
  maxSteps: 2,
  tools: {
    web_search: kimiWebSearchTool()
  }
});

const tools = await kimiFormulaTools({
  apiKey: process.env.KIMI_API_KEY,
  formulas: ["moonshot/web-search:latest", "moonshot/fetch:latest"]
});
```

Built-in shortcuts include `kimiWebSearchTool()`, `kimiFetchTool()`, `kimiCodeRunnerTool()`, `kimiExcelTool()`, and `kimiDateTool()`. Current first-class model IDs are `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.6`, and `kimi-k2.5`. The older `kimi-k2-0905-preview` and `kimi-k2-thinking` IDs are kept for passthrough compatibility but are deprecated upstream.

`kimi-k2.7-code` and `kimi-k2.7-code-highspeed` always use thinking mode, so the SDK rejects `reasoning.effort: "none"`, `providerOptions.thinking.type: "disabled"`, custom `temperature`, custom `top_p`, and `providerOptions.n` values other than `1` before the request is sent. Thinking-capable Kimi models keep the official restriction that forced tool choice is unsupported while reasoning is enabled; use `toolChoice: "auto"` or `toolChoice: "none"` in that mode.

Kimi K2.7 Code and K2.6 support image and video understanding. The SDK maps shared `image` parts plus `file` parts whose media type starts with `image/` or `video/` into Kimi multimodal content blocks.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
