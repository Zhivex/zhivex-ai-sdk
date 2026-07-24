# @zhivex-ai/qwen

Qwen and Alibaba Cloud Model Studio adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/qwen
```

## Configure

```ts
import { createQwen } from "@zhivex-ai/qwen";

const qwen = createQwen({
  apiKey: process.env.DASHSCOPE_API_KEY
});
```

For Alibaba Cloud Model Studio workspace endpoints, configure the workspace once and the adapter derives the compatible HTTP, native task, and realtime URLs:

```ts
const qwen = createQwen({
  apiKey: process.env.DASHSCOPE_API_KEY,
  workspaceId: process.env.QWEN_WORKSPACE_ID,
  region: "singapore"
});
```

Supported region values are `singapore`, `beijing`, `hong-kong`, `tokyo`, `frankfurt`, and `virginia`. `baseURL`, `taskBaseURL`, and `realtimeURL` remain available for private gateways or an explicit regional endpoint.

## Text, tools, and structured output

The default `apiMode: "auto"` selects the protocol required by the request:

- Responses for hosted tools, Qwen OCR file URLs, and `previous_response_id` continuation.
- Chat Completions for structured output, audio input, `maxTokens`, or `reasoning.budgetTokens`.
- Either path for ordinary text and local function tools; automatic mode prefers Responses.

Use `providerOptions: { apiMode: "responses" }` or `{ apiMode: "chat" }` only when you need to force a compatible path. Unsupported combinations fail before the network request instead of silently dropping fields.

`qwen3.5-omni-plus` and `qwen3.5-omni-flash` are streaming-only Chat Completions models. Use `streamText()` for them; the adapter rejects `generateText()`, Responses-only hosted tools, file inputs, and reasoning controls that those models do not support. Text output is selected by default with `modalities: ["text"]`, while an explicit compatible `modalities` option is preserved.

Qwen Chat Completions supports JSON-object mode but does not currently enforce a JSON Schema natively. `generateObject()` therefore sends JSON mode plus a schema system prompt and validates the result locally:

```ts
import { generateObject } from "@zhivex-ai/sdk";
import { z } from "zod";

const result = await generateObject({
  model: qwen("qwen3.7-plus"),
  prompt: "Return the city and temperature.",
  schema: z.object({ city: z.string(), temperature: z.number() })
});
```

Responses reasoning maps shared `effort` to `reasoning.effort` (`low` becomes Qwen `minimal`). Chat reasoning maps to `enable_thinking`; `budgetTokens` maps to `thinking_budget`.

### Hosted tools

```ts
import { generateText } from "@zhivex-ai/sdk";
import {
  qwenCodeInterpreterTool,
  qwenFileSearchTool,
  qwenMcpTool,
  qwenWebExtractorTool,
  qwenWebSearchTool
} from "@zhivex-ai/qwen";

const result = await generateText({
  model: qwen("qwen3.7-plus"),
  prompt: "Search current docs, extract the relevant page, and validate a calculation.",
  tools: {
    search: qwenWebSearchTool(),
    extract: qwenWebExtractorTool(),
    code: qwenCodeInterpreterTool(),
    files: qwenFileSearchTool({ vector_store_ids: ["existing_knowledge_base_id"] }),
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

`qwenFileSearchTool()` consumes an existing Alibaba Cloud knowledge-base/vector-store identifier. The package intentionally does not expose invented file-search-store CRUD endpoints; DashScope Files remains available for extraction and batch jobs.

## Files and batch

Batch inference requires a JSONL file uploaded with `purpose: "batch"`:

```ts
import { createBatch, uploadFile } from "@zhivex-ai/sdk";

const file = await uploadFile({
  provider: qwen,
  data: batchJsonl,
  mediaType: "application/jsonl",
  filename: "requests.jsonl",
  providerOptions: { purpose: "batch" }
});

const batch = await createBatch({
  provider: qwen,
  modelId: "qwen3.7-plus",
  fileName: file.name
});
```

## Speech and generative media

```ts
import {
  generateImage,
  generateSpeech,
  generateVideo,
  transcribeAudio
} from "@zhivex-ai/sdk";

const transcript = await transcribeAudio({
  model: qwen.transcriptionModel("qwen3-asr-flash"),
  audio: { data: audioBytes, mediaType: "audio/wav" }
});

const speech = await generateSpeech({
  model: qwen.speechModel("qwen3-tts-flash"),
  input: "Hello from Qwen.",
  voice: "Cherry",
  providerOptions: { language_type: "English" }
});

const image = await generateImage({
  model: qwen.imageGenerationModel("qwen-image-2.0-pro"),
  prompt: "A clean product icon",
  size: "1024*1024"
});

const video = await generateVideo({
  model: qwen.videoGenerationModel("wan2.7-t2v"),
  prompt: "A clean product icon rotating slowly",
  providerOptions: { resolution: "720P", watermark: false }
});
```

Speech responses are bounded by `createQwen({ responseLimits })`. The default decoded speech limit is 16 MiB, base64 size is checked before decoding, and encoded audio is removed from `SpeechResult.rawResponse` after decoding to avoid retaining two copies.

Downloaded speech URLs are also protected against server-side request forgery. By default, the adapter accepts the HTTP(S) Alibaba OSS hosts used by Qwen TTS, follows at most three redirects manually, and validates every redirect target without forwarding the Qwen API key. Private gateways can provide an explicit `speechAudioURLValidator`; `speechAudioMaxRedirects` can be set from 0 through 10.

## Multimodal embeddings and reranking

```ts
const embeddings = await qwen
  .multimodalEmbeddingModel("tongyi-embedding-vision-plus")
  .embed({
    values: [
      "product description",
      { uri: "https://example.com/product.png", mediaType: "image/png" }
    ]
  });

const ranked = await qwen.rerankModel("qwen3-rerank").rerank({
  query: "Qwen SDK support",
  documents: ["unrelated", "Zhivex supports Qwen."],
  topN: 1
});
```

`tongyi-embedding-vision-plus` is the multimodal embedding model for the international/Singapore endpoint used by the provider defaults. `qwen3-vl-embedding` is available in Beijing; configure a Beijing workspace and `region: "beijing"` before selecting it.

`qwen3-vl-rerank` and other native multimodal rerank models also accept `MediaInput` query and document values.

## Realtime

```ts
const session = await qwen
  .realtimeModel("qwen3.5-omni-plus-realtime")
  .connect({
    instructions: "Be concise.",
    turnDetection: { type: "server_vad" }
  });

await session.sendText("Hello");
await session.sendMedia({ data: jpegBytes, mediaType: "image/jpeg" });
```

The realtime adapter maps text, audio, transcripts, function calls, response completion, and session completion into the shared `RealtimeEvent` contract. JPEG image frames are supported by Qwen Omni realtime; browser-token minting is not exposed.

Authenticated realtime connections use the package's Node/Bun `ws` transport by default. `realtimeConnectionFactory` remains available for custom runtimes. Do not expose a Model Studio API key in browser code.

## Current catalog coverage

The default catalog includes current text and multimodal Qwen families plus the specialized IDs wired above: `qwen3.7-plus`, `qwen3.7-max`, `qwen3.6-flash`, `qwen3.5-omni-plus`, `qwen3.5-omni-plus-realtime`, `qwen3.5-ocr`, `tongyi-embedding-vision-plus` for international/Singapore, `qwen3-vl-embedding` for Beijing, `qwen3-rerank`, `qwen3-asr-flash`, `qwen3-tts-flash`, `qwen-image-2.0-pro`, and `wan2.7-t2v`.

Run opt-in live coverage with:

```bash
QWEN_EXTENDED_INTEGRATION=1 bun --env-file=.env run test:integration:qwen
```

Set only the surfaces you want to exercise: `QWEN_MULTIMODAL_EMBEDDING_MODEL`, `QWEN_MULTIMODAL_IMAGE_URL`, `QWEN_RERANK_MODEL`, `QWEN_ASR_MODEL`, `QWEN_ASR_AUDIO_URL`, `QWEN_TTS_MODEL`, `QWEN_IMAGE_MODEL`, `QWEN_VIDEO_MODEL`, and `QWEN_REALTIME_MODEL`. For the default international endpoint, use `tongyi-embedding-vision-plus`; use `qwen3-vl-embedding` only with a Beijing workspace. Workspace and endpoint overrides use `QWEN_WORKSPACE_ID`, `QWEN_REGION`, `QWEN_BASE_URL`, `QWEN_TASK_BASE_URL`, and `QWEN_REALTIME_URL`.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
