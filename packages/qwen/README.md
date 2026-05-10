# @zhivex-ai/qwen

Qwen adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/qwen
```

## Hosted tools

Qwen uses the DashScope-compatible Responses API by default. The adapter exposes helpers for Qwen built-in hosted tools and remote MCP:

```ts
import { generateText } from "@zhivex-ai/sdk";
import {
  createQwen,
  qwenCodeInterpreterTool,
  qwenFileSearchTool,
  qwenMcpTool,
  qwenWebExtractorTool,
  qwenWebSearchTool
} from "@zhivex-ai/qwen";

const qwen = createQwen({
  apiKey: process.env.DASHSCOPE_API_KEY
});

const result = await generateText({
  model: qwen("qwen-plus"),
  prompt: "Search current docs, extract the relevant page, and validate a calculation.",
  tools: {
    search: qwenWebSearchTool(),
    extract: qwenWebExtractorTool(),
    code: qwenCodeInterpreterTool(),
    files: qwenFileSearchTool({ vector_store_ids: ["store_1"] }),
    maps: qwenMcpTool({
      server_label: "amap-maps",
      server_protocol: "sse",
      server_url: "https://dashscope-intl.aliyuncs.com/api/v1/mcps/amap-maps/sse",
      headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` }
    })
  }
});

console.log(result.text);
```

Use `providerOptions: { apiMode: "chat" }` only for legacy Chat Completions compatibility. Hosted Qwen tools are Responses-only.

## Qwen Cloud clients

The package also exposes broader Qwen Cloud surfaces through the shared SDK helpers:

```ts
import {
  createBatch,
  generateImage,
  generateSpeech,
  transcribeAudio,
  uploadFile
} from "@zhivex-ai/sdk";
import { createQwen } from "@zhivex-ai/qwen";

const qwen = createQwen({
  apiKey: process.env.DASHSCOPE_API_KEY
});

const file = await uploadFile({
  provider: qwen,
  data: new Uint8Array([1, 2, 3]),
  mediaType: "text/plain",
  filename: "notes.txt"
});

await createBatch({
  provider: qwen,
  modelId: "qwen-plus",
  fileName: file.name
});

await transcribeAudio({
  model: qwen.transcriptionModel("qwen-audio-asr"),
  audio: { data: new Uint8Array([1, 2, 3]), mediaType: "audio/wav" }
});

await generateSpeech({
  model: qwen.speechModel("qwen-tts"),
  input: "Hello from Qwen."
});

await generateImage({
  model: qwen.imageGenerationModel("wanx2.1-t2i-turbo"),
  prompt: "A clean product icon"
});
```

For provider-specific surfaces without a shared cross-provider contract, use `qwen.rerankModel()`, `qwen.multimodalEmbeddingModel()`, and `qwen.tasks`.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
