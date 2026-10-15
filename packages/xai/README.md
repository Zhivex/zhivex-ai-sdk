# @zhivex-ai/xai

xAI Grok adapter for Zhivex AI SDK. It uses the xAI Responses API by default and supports Chat Completions as an explicit compatibility mode for models that still accept it. `grok-4.7` is Responses-only.

## Install

```bash
bun add @zhivex-ai/core @zhivex-ai/xai
```

## Usage

```ts
import { generateText } from "@zhivex-ai/core";
import { createXAI, xAIXSearchTool, xAIWebSearchTool } from "@zhivex-ai/xai";

const xai = createXAI({
  apiKey: process.env.XAI_API_KEY
});

const result = await generateText({
  model: xai("grok-4.7"),
  prompt: "Summarize the latest xAI release with sources.",
  reasoning: { effort: "medium" },
  providerOptions: { conversationId: "release-research" },
  tools: {
    web: xAIWebSearchTool(),
    x: xAIXSearchTool()
  }
});

console.log(result.text);
```

The adapter defaults to `https://api.x.ai/v1` and reads `XAI_API_KEY` when no API key is passed explicitly.

## Supported Grok 4.7, 4.6, and 4.5 features

- text and image input
- streaming
- function calling and tool choice
- native structured output
- `low`, `medium`, `high` (the provider default), and `xhigh` reasoning effort
- always-on reasoning for these model families (`none` is rejected, and penalty or stop controls are rejected while reasoning is active)
- hosted Web Search, X Search, and code execution
- Collections file search on models whose capability flag is `fileSearch: true`. The grok-4.7 model page does not list file search, so that flag is false. The collections guide still shows `file_search` requests for `grok-4.7`, and this adapter does not reject that tool
- Files API attachments
- prompt caching through `conversationId` or `prompt_cache_key`
- Responses conversation continuity and encrypted reasoning preservation when `store: false`

Use `providerOptions: { apiMode: "chat" }` only when Chat Completions compatibility is required. `grok-4.7` rejects that mode. In Chat mode, `conversationId` is sent through the `x-grok-conv-id` header.

`createXAI({ region: "us" })` calls `https://us.api.x.ai/v1`. xAI currently documents that regional host for `grok-4.7` and `grok-4.6`, with a 10% token premium. Do not pass `region` and `baseURL` together.

## Imagine and voice

```ts
import { generateImage, generateSpeech, generateVideo, transcribeAudio } from "@zhivex-ai/core";
import { createXAI } from "@zhivex-ai/xai";

const xai = createXAI({ apiKey: process.env.XAI_API_KEY });

const image = await generateImage({
  model: xai.imageGenerationModel("grok-imagine-image-2.0"),
  prompt: "A collage of London landmarks"
});

const video = await generateVideo({
  model: xai.videoGenerationModel("grok-imagine-video-1.5"),
  prompt: "A serene lake at sunrise",
  durationSeconds: 8,
  pollIntervalMs: 5_000
});

const speech = await generateSpeech({
  model: xai.speechModel("grok-tts"),
  input: "Hello from Grok.",
  voice: "eve"
});

const transcript = await transcribeAudio({
  model: xai.transcriptionModel("grok-voice-transcribe-2.0"),
  audio: { data: audioBytes, mediaType: "audio/mpeg" }
});
```

Image models are `grok-imagine-image` and `grok-imagine-image-2.0`. Prefer `grok-imagine-image-2.0`. Its `quality` option accepts `low`, `medium`, and `auto` (the default when `quality` is omitted). `grok-imagine-image-quality` is deprecated as of 2026-09-02 and retires on 2026-11-02. Existing callers can keep sending that slug until then. After retirement, xAI serves it as `grok-imagine-image-2.0` with `quality` set to `low`. See the [migration guide](https://docs.x.ai/developers/migration/imagine-image-quality-nov-2). Video models are `grok-imagine-video`, `grok-imagine-video-1.5`, and `grok-imagine-video-1.5-lite`. Video generation polls `GET /v1/videos/{request_id}` and returns the temporary video URL.

`grok-tts` is text-to-speech (`POST /v1/tts`). `grok-voice-transcribe-2.0` is speech-to-text (`POST /v1/stt`). `grok-voice-3.0` is the speech-to-speech model. `grok-voice-2.0` is deprecated and is rejected.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>

File uploads preserve the exact bytes of a supplied `Uint8Array` or `Buffer` view, including slices with nonzero offsets.
