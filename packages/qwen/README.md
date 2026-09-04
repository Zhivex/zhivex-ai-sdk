# @zhivex-ai/qwen

Qwen and Alibaba Cloud Model Studio adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/sdk @zhivex-ai/qwen zod
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

Supported region values are `singapore`, `beijing`, `hong-kong`, `tokyo`, `frankfurt`, and `virginia`. `baseURL`, `taskBaseURL`, and `realtimeURL` remain available for explicit regional endpoints. They require HTTPS/WSS and a consistent trusted host; a server-side private gateway must opt in explicitly with `allowUnsafeEndpoints: true`.

Qwen speech downloads accept HTTPS audio URLs only, validate every redirect manually, and never forward the provider API key to the media host.

### Qwen 3.8 Flash

`qwen3.8-flash` is the low-latency Qwen 3.8 production model exposed through standard QwenCloud/Alibaba Cloud Model Studio credentials and compatible endpoints. It provides a 1M-token context window, up to 128K output tokens, text/image/video input, hybrid reasoning, function calling, built-in tools, parallel function calls, and native JSON Schema structured output. Published pay-as-you-go pricing is $0.16 per million input tokens, $0.47 per million output tokens, and $0.016 per million implicit-cache input tokens.

```ts
const qwen = createQwen({
  apiKey: process.env.DASHSCOPE_API_KEY
});

const model = qwen("qwen3.8-flash");
```

Responses accepts all seven shared reasoning efforts (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`) directly. Chat Completions normalizes them to Qwen's native `low`, `medium`, and `xhigh` values; `none` disables thinking. Chat always preserves thinking history, uses `max_completion_tokens`, and routes video `FilePart` inputs as `video_url`. Reasoning effort and thinking budget are mutually exclusive, and the adapter caps thinking budgets at the documented 262144-token maximum.

The model uses a standard Model Studio endpoint and key. The adapter rejects `QWEN_TOKEN_PLAN_BASE_URL`, which remains exclusive to `qwen3.8-max-preview`. Upstream model availability is still account- and region-dependent.

### Qwen 3.8 Max

`qwen3.8-max` is the production Qwen 3.8 flagship exposed through standard Alibaba Cloud Model Studio credentials and compatible endpoints, including regional workspace endpoints. It has a 1M-token context window and supports text, image and video understanding, hybrid reasoning, function calling, built-in tools, parallel function calls, and JSON structured output.

```ts
const qwen = createQwen({
  apiKey: process.env.DASHSCOPE_API_KEY,
  workspaceId: process.env.QWEN_WORKSPACE_ID,
  region: "beijing"
});

const model = qwen("qwen3.8-max");
```

Thinking is enabled by default but remains hybrid. Responses accepts the shared `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` efforts directly. Chat Completions uses Qwen's native `low`, `medium`, and `xhigh` levels, so `minimal` maps to `low`, while `high` and `max` map to `xhigh`; `none` sends `enable_thinking: false`. A reasoning effort and a thinking budget are mutually exclusive, and budgets cannot exceed 262144 tokens. Chat requests always send `preserve_thinking: true`, while shared `maxTokens` uses the non-deprecated `max_completion_tokens` field.

Video input uses a `FilePart` with a `video/*` MIME type and automatically selects Chat Completions. Public HTTP(S) URLs, data URLs, and raw base64 strings are accepted; non-video `FilePart` values are rejected for this model. Set `providerOptions.parallel_tool_calls` to opt in to upstream parallel tool calls and `providerOptions.tool_stream` to select Chat tool-call streaming. While thinking is active, Qwen permits only `toolChoice: "auto"` or `"none"`; disable thinking before using `"required"` or selecting a named tool.

A standard Model Studio key is region-scoped, so keep the key, workspace, and selected region aligned. The adapter does not hard-code a region allowlist for this final model; model availability still depends on the selected Model Studio region.

Do not configure `QWEN_TOKEN_PLAN_BASE_URL` for `qwen3.8-max`. That endpoint and its dedicated `sk-sp-` credentials belong to the separate preview contract below; the adapter rejects this exact final-model mismatch before fetch.

### Qwen 3.8 Max Preview (Token Plan)

`qwen3.8-max-preview` is a preview model available only through QwenCloud Token Plan Personal or Team Edition in Singapore. Token Plan keys use the `sk-sp-` prefix; they are not interchangeable with pay-as-you-go keys, and the regular `dashscope-intl.aliyuncs.com` endpoint does not serve this model. Configure the dedicated Token Plan Base URL explicitly:

```ts
import {
  createQwen,
  QWEN_TOKEN_PLAN_BASE_URL
} from "@zhivex-ai/qwen";

const qwenTokenPlan = createQwen({
  apiKey: process.env.QWEN_TOKEN_PLAN_API_KEY,
  baseURL:
    process.env.QWEN_TOKEN_PLAN_BASE_URL ??
    QWEN_TOKEN_PLAN_BASE_URL
});

const model = qwenTokenPlan("qwen3.8-max-preview");
```

The adapter rejects `qwen3.8-max-preview` before fetch when `baseURL` is a pay-as-you-go, workspace, non-HTTPS, or otherwise non-Token-Plan endpoint. `QWEN_TOKEN_PLAN_BASE_URL` resolves to the QwenCloud Singapore endpoint `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`; `baseURL` remains explicit so configuration can be managed through environment settings while the adapter validates it against the current QwenCloud contract.

Token Plan terms limit these credentials to interactive use in programming and agent tools. Do not use a Token Plan key for automated scripts, application backends, scheduled jobs, or non-interactive batch processing; use QwenCloud pay-as-you-go with a supported production model for those workloads.

## Text, tools, and structured output

The default `apiMode: "auto"` selects the protocol required by the request:

- Responses for hosted tools, Qwen OCR file URLs, and `previous_response_id` continuation.
- Chat Completions for structured output, audio/video input, `maxTokens`, `reasoning.budgetTokens`, or `providerOptions.tool_stream`.
- Either path for ordinary text and local function tools; automatic mode prefers Responses.

Use `providerOptions: { apiMode: "responses" }` or `{ apiMode: "chat" }` only when you need to force a compatible path. Unsupported combinations fail before the network request instead of silently dropping fields.

`qwen3.5-omni-plus` and `qwen3.5-omni-flash` are streaming-only Chat Completions models. Use `streamText()` for them; the adapter rejects `generateText()`, Responses-only hosted tools, file inputs, and reasoning controls that those models do not support. Text output is selected by default with `modalities: ["text"]`, while an explicit compatible `modalities` option is preserved.

Qwen Chat Completions supports JSON-object mode across the compatible families. `qwen3.8-flash` additionally receives the native `json_schema` request shape; other supported models use JSON mode plus a schema system prompt, and every result is validated locally:

```ts
import { generateObject } from "@zhivex-ai/sdk";
import { z } from "zod";

const result = await generateObject({
  model: qwen("qwen3.7-plus"),
  prompt: "Return the city and temperature.",
  schema: z.object({ city: z.string(), temperature: z.number() })
});
```

For older Qwen families, Responses reasoning maps shared `effort` to `reasoning.effort` (`low` becomes Qwen `minimal`), while Chat reasoning maps to `enable_thinking` and `budgetTokens` to `thinking_budget`.

`qwen3.8-flash` and `qwen3.8-max` use the stricter production mapping described above, accept images through either compatible API, and route video through Chat. With no explicit reasoning option, the provider leaves Qwen's thinking-enabled default intact. Flash uses native JSON Schema; Max retains JSON-object mode with local schema validation.

`qwen3.8-max-preview` has a stricter contract:

- Thinking is always enabled. Shared `effort: "none"`, `providerOptions.enable_thinking: false`, and `providerOptions.reasoning_effort: "none"` are rejected before a request is sent.
- Its native efforts are `low`, `medium`, and `xhigh`. OpenAI-compatible aliases are normalized as documented by Qwen: `minimal` → `low`, `high`/`max` → `xhigh`. The provider default is `xhigh` when no effort is supplied.
- `reasoning.effort`/`providerOptions.reasoning_effort` cannot be combined with `reasoning.budgetTokens`/`providerOptions.thinking_budget`. Shared budgets must be positive and both paths enforce the model maximum of 262144; raw `thinking_budget` also accepts the documented value `0`.
- Automatic mode uses Responses for ordinary text, images, local functions, and hosted tools. A thinking budget selects Chat Completions because `thinking_budget` is not available in Responses. For Chat requests, shared `maxTokens` is sent as `max_completion_tokens`.
- Chat requests always send `preserve_thinking: true`, and reasoning returned by the adapter is kept as Qwen `reasoning_content` provider data so multi-turn and tool-call histories return it in the correct field. Setting `preserve_thinking: false` is rejected.
- Because this preview is always thinking, forced or named tool choices are rejected; use `toolChoice: "auto"` or `"none"`.
- The model supports text, images, function calling, and built-in tools. It does not support native structured output or JSON mode. `generateObject({ mode: "native" })` is rejected through its capabilities; the default `auto` mode can still use prompted output with local schema validation.

For the production model contracts, see QwenCloud's official [Qwen 3.8 Flash model page](https://www.qwencloud.com/models/qwen3.8-flash), [text-model guide](https://docs.qwencloud.com/developer-guides/getting-started/text-generation-models), [vision-model guide](https://docs.qwencloud.com/developer-guides/getting-started/vision-models), [OpenAI-compatible Chat contract](https://docs.qwencloud.com/api-reference/chat/openai-chat), [Responses contract](https://docs.qwencloud.com/api-reference/chat/openai-responses), and [structured-output guide](https://docs.qwencloud.com/developer-guides/text-generation/structured-output). The Qwen 3.8 Max contract is also documented in Alibaba Cloud Model Studio's official [model list](https://help.aliyun.com/en/model-studio/models).

For the preview contract, see QwenCloud's official [Token Plan quickstart](https://docs.qwencloud.com/token-plan/quickstart), [Token Plan terms](https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview), [OpenAI-compatible Chat contract](https://docs.qwencloud.com/api-reference/chat/openai-chat), and [Responses contract](https://docs.qwencloud.com/api-reference/chat/openai-responses).

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

Qwen Realtime supports callable tools with automatic selection. `toolChoice: "none"` is enforced locally by omitting tools from the upstream session; `"required"` and named-tool selection are rejected before the WebSocket opens because the upstream realtime contract does not support them. The adapter also rejects `providerOptions.enable_search: true` when callable tools are present because Qwen Realtime does not allow both in one session.

Sessions request text output by default with `modalities: ["text"]`. Audio output is enabled only when `voice` or `outputAudioMediaType` is configured, in which case the adapter sends `modalities: ["text", "audio"]`. These checks are fail-closed and reflect the provider's current realtime contract.

Authenticated realtime connections use the package's Node/Bun `ws` transport by default. `realtimeConnectionFactory` remains available for custom runtimes. Do not expose a Model Studio API key in browser code.

## Current catalog coverage

The default catalog includes current text and multimodal Qwen families plus the specialized IDs wired above: `qwen3.8-flash` and `qwen3.8-max` for standard Model Studio production traffic, `qwen3.8-max-preview` for Token Plan, `qwen3.7-plus`, `qwen3.7-max`, `qwen3.6-flash`, `qwen3.5-omni-plus`, `qwen3.5-omni-plus-realtime`, `qwen3.5-ocr`, `tongyi-embedding-vision-plus` for international/Singapore, `qwen3-vl-embedding` for Beijing, `qwen3-rerank`, `qwen3-asr-flash`, `qwen3-tts-flash`, `qwen-image-2.0-pro`, and `wan2.7-t2v`.

Run opt-in live coverage with:

```bash
QWEN_EXTENDED_INTEGRATION=1 bun --env-file=.env run test:integration:qwen
```

The shared provider smoke keeps `qwen3.7-plus` as its compatibility default. Certify Flash explicitly with `QWEN_INTEGRATION_MODEL=qwen3.8-flash`, or Max with `QWEN_INTEGRATION_MODEL=qwen3.8-max`. For those two hybrid production IDs only, the tool-loop check disables thinking, forces the named tool on the first model step, and returns to automatic selection for the final answer; earlier Qwen families keep their existing smoke behavior, and the thinking-only preview is not given these overrides. The standard international endpoint can be used when the account exposes the selected model there, while `QWEN_WORKSPACE_ID` and `QWEN_REGION` select an explicit regional workspace. Set only the extended surfaces you want to exercise: `QWEN_MULTIMODAL_EMBEDDING_MODEL`, `QWEN_MULTIMODAL_IMAGE_URL`, `QWEN_RERANK_MODEL`, `QWEN_ASR_MODEL`, `QWEN_ASR_AUDIO_URL`, `QWEN_TTS_MODEL`, `QWEN_IMAGE_MODEL`, `QWEN_VIDEO_MODEL`, and `QWEN_REALTIME_MODEL`. For the default international endpoint, use `tongyi-embedding-vision-plus`; use `qwen3-vl-embedding` only with a Beijing workspace. Workspace and endpoint overrides use `QWEN_WORKSPACE_ID`, `QWEN_REGION`, `QWEN_BASE_URL`, `QWEN_TASK_BASE_URL`, and `QWEN_REALTIME_URL`.

The catalog records QwenCloud's published `qwen3.8-flash` input, output, and implicit-cache rates. It intentionally omits a price for `qwen3.8-max` until Alibaba Cloud publishes a stable public rate for that model.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>

## Qwen 3.8 snapshots

`qwen3.8-max-0902` preserves its exact upstream ID while inheriting the `qwen3.8-max` validation, vision, tools, and token-limit request mapping. Dated four-digit Max/Flash snapshots are recognized separately from Token Plan previews. `qwen3.8-2.4t-a95b` is listed for discovery without automatic recommendations; its specialized behavior has not been live-certified.

See the [QwenCloud model inventory](https://docs.qwencloud.com/developer-guides/getting-started/text-generation-models).
