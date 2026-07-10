# @zhivex-ai/qwen

Qwen adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/qwen
```

## Audio response limits

`createQwen({ responseLimits })` bounds transcription JSON, binary speech, JSON/base64 speech, and provider error bodies before large allocations. Speech defaults to 16 MiB decoded; base64 size is checked before decoding. The encoded audio field is omitted from `SpeechResult.rawResponse` after decoding so the result does not retain both representations.

```ts
const qwen = createQwen({
  responseLimits: {
    speechBytes: 16 * 1024 * 1024,
    transcriptionBytes: 1024 * 1024,
    errorBodyBytes: 64 * 1024
  }
});
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
  model: qwen("qwen3.7-plus"),
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
  modelId: "qwen3.7-plus",
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
  model: qwen.imageGenerationModel("qwen-image-2.0-pro"),
  prompt: "A clean product icon"
});
```

Current first-class model IDs include `qwen3.7-plus`, `qwen3.7-max`, `qwen3.6-flash`, `qwen3.5-omni-plus`, and `qwen-image-2.0-pro`. `qwen3.7-plus` is marked vision-capable in the SDK; `qwen3.7-max` stays text/reasoning-only until Qwen documents image understanding for that SKU. For provider-specific surfaces without a shared cross-provider contract, use `qwen.rerankModel()`, `qwen.multimodalEmbeddingModel()`, and `qwen.tasks`.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
