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
  model: kimi("kimi-k2.5"),
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

Built-in shortcuts include `kimiWebSearchTool()`, `kimiFetchTool()`, `kimiCodeRunnerTool()`, `kimiExcelTool()`, and `kimiDateTool()`. Thinking-capable models such as `kimi-k2.5` and `kimi-k2-thinking` keep the official Kimi restriction that forced tool choice is unsupported while reasoning is enabled; use `toolChoice: "auto"` or `toolChoice: "none"` in that mode.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
