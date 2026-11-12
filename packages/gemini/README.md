# @zhivex-ai/gemini

Model serving policy is maintained internally in `src/model-profiles.ts`: the current text-model profiles declare supported reasoning efforts, provider-managed sampling and assistant-prefill policy. Capabilities and request validation consume the same profile. Adding a model served by an existing protocol requires updating its profile, the SDK catalog fragment and conformance fixtures; a new protocol still requires adapter implementation. Message/schema mapping, usage normalization and media encoding have separate internal modules. These source paths are not public package imports. See [model onboarding](../../docs/maintainers/MODEL_ONBOARDING.md).

Gemini adapter for Zhivex AI SDK.

Supports Gemini text, audio understanding, multimodal embeddings, speech, realtime sessions, grounded generation, Files API, File Search stores, URL Context, Context Caching, Batch API, Interactions, managed agents, raw prediction calls, and current Google generative media models such as Gemini Image / Nano Banana, Gemini Omni Flash, Veo 3.1, and Lyria 3.

## Install

```bash
bun add @zhivex-ai/core @zhivex-ai/gemini
```

| Surface | Support |
| --- | --- |
| Text, tools, structured output, audio input | `generateText()` |
| Decisions: predicates, choices and scores over text, image, audio, video and PDF | `decisionModel("gemini-decision-1").decide()` |
| Multimodal embeddings | `embeddingModel("gemini-embedding-2")` |
| Text-to-speech | `generateSpeech()` and `streamSpeech()`; Gemini 3.1 TTS streams |
| Speech-to-text | `transcribeAudio()` with Gemini 3.5 Transcribe; rich annotations remain in `rawResponse` |
| Live audio/text/image sessions | `realtimeModel()` |
| Interactions API, Deep Research, Antigravity / managed agents | high-level |
| Files API, File Search stores, Context Caching, Batch API | high-level |
| Google Search, URL Context, File Search, Code Execution, Computer Use | hosted tool helpers |
| Google Maps grounding | `googleMapsTool()` through Interactions; model dependent |
| Image, Veo video, Lyria music generation | high-level |
| Gemini Omni Flash video generation/editing | Interactions API |
| Other Gemini model endpoints | `predictionModel()` raw/prediction |

```ts
import {
  audioPart,
  createBatch,
  createContextCache,
  createFileSearchStore,
  createInteraction,
  embed,
  generateImage,
  generateMusic,
  generateSpeech,
  generateText,
  generateVideo,
  predictRaw,
  resumeInteraction,
  streamSpeech,
  transcribeAudio,
  uploadFile
} from "@zhivex-ai/core";
import { createGemini, googleFileSearchTool, googleMapsTool, googleUrlContextTool } from "@zhivex-ai/gemini";

const gemini = createGemini({ apiKey: process.env.GEMINI_API_KEY });

await generateImage({
  model: gemini.imageGenerationModel!("gemini-3.1-flash-lite-image"),
  prompt: "Create a product photo"
});

await generateText({
  model: gemini("gemini-3.7-flash"),
  messages: [
    {
      role: "user",
      parts: [
        { type: "text", text: "Summarize this recording." },
        audioPart({
          data: "BASE64_AUDIO",
          mediaType: "audio/wav"
        })
      ]
    }
  ]
});

await generateSpeech({
  model: gemini.speechModel!("gemini-3.1-flash-tts-preview"),
  input: "Welcome to Zhivex."
});

for await (const chunk of await streamSpeech({
  model: gemini.speechModel!("gemini-3.1-flash-tts-preview"),
  input: "Read this announcement as it is generated.",
  voice: "Kore"
})) {
  console.log(chunk.mediaType, chunk.audio.byteLength);
}

const live = await gemini.realtimeModel!("gemini-3.1-flash-live-preview").connect({
  inputAudioTranscription: true,
  outputAudioTranscription: true,
  outputAudioMediaType: "audio/pcm"
});
await live.close();

const transcript = await transcribeAudio({
  model: gemini.transcriptionModel!("gemini-3.5-transcribe"),
  audio: {
    data: "BASE64_AUDIO",
    mediaType: "audio/wav",
    filename: "meeting.wav"
  },
  language: "es-419",
  providerOptions: {
    custom_vocabulary: ["Zhivex"],
    mode: {
      type: "verbatim",
      diarization_mode: "speaker",
      timestamp_granularities: ["word"]
    }
  }
});
console.log(transcript.text, transcript.rawResponse);

const liveTranscript = await gemini.realtimeModel!("gemini-3.5-transcribe-live").connect({
  mode: "transcription",
  inputAudioTranscription: {
    languageCodes: [],
    customVocabulary: ["Zhivex"]
  }
});
await liveTranscript.close();

await embed({
  model: gemini.embeddingModel("gemini-embedding-2"),
  value: {
    uri: "gs://my-bucket/product-photo.png",
    mediaType: "image/png"
  }
});

await generateVideo({
  model: gemini.videoGenerationModel!("veo-3.1-generate-preview"),
  prompt: "Create a cinematic establishing shot"
});

await generateMusic({
  model: gemini.musicGenerationModel!("lyria-3-clip-preview"),
  prompt: "Create a short acoustic intro"
});

const file = await uploadFile({
  provider: gemini,
  data: "Gemini notes",
  mediaType: "text/plain",
  displayName: "notes.txt"
});

const store = await createFileSearchStore({ provider: gemini, displayName: "Docs" });

await generateText({
  model: gemini("gemini-3.7-flash"),
  prompt: "Use the indexed docs and URL context.",
  tools: {
    docs: googleFileSearchTool([store.name]),
    urls: googleUrlContextTool()
  }
});

await createContextCache({
  provider: gemini,
  modelId: "gemini-3.7-flash",
  contents: [{ role: "user", parts: [{ type: "file", data: file.uri ?? file.name, mediaType: "text/plain" }] }]
});

await createBatch({
  provider: gemini,
  modelId: "gemini-3.7-flash",
  requests: [{ request: { contents: [{ parts: [{ text: "Summarize this." }] }] } }]
});

const nearby = await createInteraction({
  provider: gemini,
  modelId: "gemini-3.7-flash",
  input: "Find well-reviewed cafes within walking distance.",
  store: false,
  tools: {
    maps: googleMapsTool({ latitude: 34.050481, longitude: -118.248526 })
  }
});
console.log(nearby.outputText);

const research = await createInteraction({
  provider: gemini,
  agent: "deep-research-preview-04-2026",
  input: "Research current multimodal retrieval techniques.",
  background: true
});

for await (const event of await resumeInteraction({
  provider: gemini,
  id: research.id
})) {
  console.log(event.type);
}

await createInteraction({
  provider: gemini,
  modelId: "gemini-omni-1.1-flash",
  input: "A marble rolling through a chain-reaction track.",
  responseFormat: { type: "video", aspect_ratio: "16:9" },
  generationConfig: { video_config: { task: "text_to_video", resolution: "4k" } }
});

await predictRaw({
  model: gemini.predictionModel!("custom-gemini-endpoint"),
  instances: [{ prompt: "provider-specific request" }]
});
```

For new Gemini projects, Google recommends the generally available Interactions API. `createInteraction()` and `streamInteraction()` expose that API, including typed `steps`, convenience outputs such as `outputText` / `outputImage` / `outputAudio` / `outputVideo`, server-side continuation with `previousInteractionId`, background execution, and model or managed-agent calls. Request controls use the portable camel-case fields `systemInstruction`, `responseFormat`, `generationConfig`, `agentConfig`, `environment`, and `labels`; `resumeInteraction()` reconnects to background SSE and accepts `lastEventId` for event-safe continuation, while `getInteraction()`, `cancelInteraction()`, and `deleteInteraction()` manage stored or background work. `generateText()` remains the portable Zhivex path and uses Google's still-supported `generateContent` API; Batch API, explicit Context Caching, video metadata, and custom safety settings are not currently available through Interactions upstream.

Diagnostic response-size errors strip query strings, fragments, and embedded credentials from endpoint URLs before they are exposed, so the Gemini `key` query parameter is never copied into error messages.

Gemini 3.1 TTS supports buffered audio through `generateSpeech()` and incremental audio through `streamSpeech()`. Each streamed value is a `SpeechOutput` chunk; consume or forward `chunk.audio` as it arrives instead of waiting for the complete recording.

Current model guidance:

- Complex text, multimodal, coding, and multi-step agentic work: `gemini-3.7-flash`.
- High-volume extraction, routing, document parsing, and low-latency subagent work: `gemini-3.5-flash-lite`. It defaults to minimal thinking; use medium or high for autonomous multi-step agents.
- Managed agents: pass `deep-research-preview-04-2026`, `deep-research-max-preview-04-2026`, or `antigravity-preview-05-2026` through the `agent` field instead of `modelId`.
- Image generation: `gemini-3.1-flash-lite-image` for 1K low-cost output, `gemini-3.1-flash-image` for up to 4K/high-volume work, or `gemini-3-pro-image` for highest-quality composition.
- Video: `gemini-omni-1.1-flash` is the GA Interactions-only model for conversational video generation/editing, including extension, interpolation, and `360p` through `4k` resolution controls. The catalog keeps `gemini-omni-flash-preview` for migration: the [changelog](https://ai.google.dev/gemini-api/docs/changelog) deprecated it on 2026-09-30, and the [deprecations page](https://ai.google.dev/gemini-api/docs/deprecations) shuts it down on 2026-10-22. The `generateVideo()` helper still accepts `veo-3.1-lite-generate-preview`, `veo-3.1-generate-preview`, and `veo-3.1-fast-generate-preview`; those three shut down on 2026-10-22, with `gemini-omni-1.1-flash` listed as the replacement.
- Live and speech previews: `gemini-3.1-flash-live-preview` and `gemini-3.1-flash-tts-preview` shut down on 2026-11-17. `gemini-robotics-er-1.6-preview` shut down on 2026-08-31. `gemini-2.5-flash-image` shuts down on 2027-03-15. The catalog no longer recommends those IDs. `gemini-3.6-flash` has no Gemini API shutdown date.
- Imagen 4 IDs are intentionally no longer recommended: Google has announced shutdown for August 17, 2026. Gemini 2.0 model IDs and the old image preview IDs are already shut down.

Gemini 3.7 Flash, Gemini 3.6 Flash, and Gemini 3.5 Flash-Lite use provider-managed sampling. Do not pass `temperature`, `topP` / `top_p`, `topK` / `top_k`, `candidateCount` / `candidate_count`, or frequency/presence penalties; the adapter rejects those controls locally for these model IDs. Gemini 3.7 Flash accepts `low`, `medium`, and `high`; it rejects `minimal`. Gemini 3.6 Flash and Gemini 3.5 Flash-Lite accept `minimal`, `low`, `medium`, and `high`. These models also reject a final assistant/model-output prefill: end `generateText()` history with a user or tool-result turn, and use `previousInteractionId` for stateful Interactions continuation.

The mutable aliases `gemini-flash-latest` and `gemini-flash-lite-latest` are available upstream but can be remapped. Prefer the stable IDs above for production workloads and reproducible pricing.

The built-in catalog records Gemini 3.7 Flash, Gemini 3.6 Flash, and Gemini 3.5 Flash-Lite Standard text-token pricing as separate input, cached-input, and output rates; it does not treat the input price as a blended per-token estimate. Audio, media output, tools, agents, Batch, Flex, Priority, and storage have separate upstream prices.

Interactions store resources by default upstream. Pass `store: false` when you do not need server-side continuation, background execution, or stored interaction logs. Preview models and managed agents can have narrower availability and rate limits than GA models.

Google Maps grounding returns place-citation annotations in the interaction's model-output content. Applications must display the associated Google Maps source names and links immediately after the grounded content, following Google's attribution rules; do not discard `steps` when rendering a Maps answer.

See Google's current [latest-model migration guide](https://ai.google.dev/gemini-api/docs/latest-model), [thinking guide](https://ai.google.dev/gemini-api/docs/thinking), [Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview), [TTS guide](https://ai.google.dev/gemini-api/docs/speech-generation), [Maps grounding requirements](https://ai.google.dev/gemini-api/docs/maps-grounding), [model list](https://ai.google.dev/gemini-api/docs/models), [deprecation schedule](https://ai.google.dev/gemini-api/docs/deprecations), [pricing](https://ai.google.dev/gemini-api/docs/pricing), and [Gemini Omni Flash guide](https://ai.google.dev/gemini-api/docs/omni).

Model Garden-style coverage is intentionally raw/prediction based. The adapter does not add a dedicated wrapper for every Google model family.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>

## September model update

`gemini-3.8-flash` follows the current provider-managed sampling rules: temperature, top-p/top-k, candidate count, and penalties are rejected locally, as is assistant prefill. Reasoning supports `low`, `medium`, and `high`; `minimal` is rejected. The SDK catalog includes `lyria-3.5`, usable through `musicGenerationModel("lyria-3.5")` and `generateMusic()` with the existing text/image-to-audio contract.

See [Gemini 3.8 migration](https://ai.google.dev/gemini-api/docs/latest-model) and [Lyria 3.5](https://ai.google.dev/gemini-api/docs/models/lyria-3.5). Catalog presence and offline tests do not certify account access.

### Generation retries

Language-model generation and streaming startup validate HTTP failures inside the retry boundary. `maxRetries` applies to HTTP 408, 429 and 5xx responses, with bounded `Retry-After` waits. Other 4xx responses are not retried. Timeout and caller cancellation interrupt retry waits; successful stream bodies remain unread until consumption.

## Gemini 3.8 Live (September 2026)

Use `gemini.realtimeModel!("gemini-3.8-live")` or `gemini.realtimeModel!("gemini-3.8-live-extended-thinking")`.
The standard model accepts no reasoning effort or token budget. Extended Thinking accepts `reasoning: { effort: "low" | "medium" | "high", includeThoughts: true }`, without a token budget. Both map callable tools to `NON_BLOCKING`. Raw `providerOptions.tools` and `generationConfig` overrides are rejected for these models; use the shared fields.

`session.sendText()` sends an explicit user turn with `turnComplete: true`, which interrupts generation. Tool results retain call IDs. Extended Thinking may finish intermediate spoken fragments while still working: the adapter only reports response completion after `interactionStatus: "IDLE"`. Status and thought summaries are preserved as `realtime-provider-data`, and audio, text and tool calls are all consumed. No scheduling or blocking override is exposed for Extended Thinking.

The [September live evidence report](../../docs/maintainers/WEEKLY_PROVIDER_LIVE_2026_09_16.md) covers text input, a local tool result, output audio, and Extended Thinking returning to `IDLE`. It does not certify microphone input or production latency. See [Google Live capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities) and [background thinking](https://ai.google.dev/gemini-api/docs/live-api/thinking).

### Google Search sources in streaming

`streamText()` with `googleSearchTool()` on GenerateContent emits
`provider-data` with provider `gemini` and data
`{ type: "grounding-metadata", candidateIndex: 0, groundingMetadata: { ... } }`.
It preserves public web `groundingChunks`, `groundingSupports` (segment offsets,
chunk indices and confidence scores) and
`searchEntryPoint.renderedContent`. Metadata arriving only in the last chunk is
emitted before `finish`. Identical snapshots are suppressed; fields supplied in
separate chunks are merged. Consumers **replace** their stored snapshot per
candidate rather than appending its arrays, and leave chunk ordering unchanged.
Invalid/non-web chunks keep an empty placeholder to preserve citation indices.

This is an allowlist, not a raw response: unknown fields are omitted. Bounds are
1024 chunks, 4096 supports, 1024 indices/scores per support, 16384 characters
per string and 262144 characters for attribution HTML. Oversized/invalid fields
are omitted and arrays are capped without reindexing. No sources are invented
when the provider omits grounding. Cancellation stops further emission; already
received snapshots remain usable for a partial answer.

Show inline citations by mapping each support's `groundingChunkIndices` to the
unchanged `groundingChunks` array. Show the required Google Search Suggestions
from `searchEntryPoint.renderedContent` according to the official
[grounding and attribution requirements](https://ai.google.dev/gemini-api/docs/generate-content/google-search).
Treat provider HTML as untrusted content and use an isolated rendering surface;
never inject arbitrary provider-data into the application DOM. An example consumer
is in [search-sources.ts](../../examples/search-sources.ts).

Interactions is a separate API: `provider.interactions.stream()` retains its
native step/source events as provider-data, not the GenerateContent snapshot
shape. Test and certify the chosen API separately. Hosted search charges are
separate from generated token usage.

### Internal hosted-search metering

GenerateContent emits `HostedToolUsage` records in `provider-data`. Follow the
[shared metering contract](../../docs/OBSERVABILITY.md#hosted-search-metering)
for snapshot aggregation, retries, budgeting and UI filtering.

For Gemini 3, quantity counts exact distinct nonempty `webSearchQueries` strings
(whitespace-only entries are empty; case and other whitespace are not normalized).
For Gemini 2.5 and earlier, a nonempty query list establishes one grounded prompt;
an empty list alone does not establish zero billed prompts. Unrecognized model
families use unknown units/quantity. Query text is held only while counting; it is
not included in metering or the public `grounding-metadata` snapshot. Raw provider
responses and native Interactions provider-data remain server-only objects.

An explicit valid terminal list is complete reported evidence; earlier observations
are partial. Missing, invalid or oversized lists never imply zero. Limits are
1024 queries and 16384 characters per query; incomplete data has unknown quantity.
A valid empty terminal list in Gemini 3 reports zero observed queries.

`model.capabilities.hostedTools` declares GenerateContent metering as `derived`
and Interactions metering as `unverified`. Both declare `limit: "unverified"`;
`max_tool_calls` is rejected. No prompt, output-token cap, client abort or timeout
is an effective hosted-search call limit. Interactions needs separate normalized
metering certification before a consumer can use it for budgeting.

Cancellation/truncation leaves the latest snapshot partial/unknown.

### Google hosted-tool ownership

Import Google hosted-tool helpers from this package for new code; Core/SDK imports remain compatible. See [ownership and support boundaries](../../docs/ARCHITECTURE.md#provider-implementation-boundaries).

## GenerateContent request logging

GenerateContent and streamGenerateContent requests (including speech,
transcription, images, music, and grounded text on those routes) now explicitly
send `store: false`. Previously the SDK inherited project logging settings. This
prevents new paid projects from silently inheriting Google's October 26, 2026
storage default. To opt in per request, set `providerOptions: { store: true }`;
explicit `false` is preserved and nonboolean values are rejected. No account
settings are changed. Disabling request logging is not a general ZDR guarantee.

Interactions retains its existing explicit `store`/continuation contract. Inline
Batch requests also default each nested `GenerateContentRequest.store` to false;
explicit true/false is preserved per request. Metadata and caller objects remain
unchanged. Batch-level `providerOptions.store` is rejected: Google defines store
on each request, not on the batch envelope. Raw inline inputConfig overrides
receive the same defaults. File-backed batches are submitted without rewriting
or downloading uploaded JSONL: callers must include `request.store: false` in
each JSONL line to opt out (or explicitly choose true). File contents and account
settings stay under caller control; the SDK cannot guarantee logging opt-out for
an opaque uploaded file.
See [Google's logging controls](https://aistudio.google.com/docs/logs-datasets)
and [the Batch request schema](https://ai.google.dev/api/batch-api).

### November 2026 additions

Gemini 4 Carbon supports `low`, `medium`, and `high` reasoning with implicit caching only. Use Interactions for background long decode. Gemini Omni 1.2 Flash uses `provider.interactions.create({ modelId: "gemini-omni-1.2-flash", input: "A bird flying", responseFormat: { type: "video", duration: "15s" } })`. Interpolation and extension remain limited to 10 seconds per turn; up to six reference images are supported. The service enforces prompt-dependent limits. Omni 1.1 routes to 1.2 on December 3, 2026.

## Decisions API

`createGemini().decisionModel()` defaults to `gemini-decision-1` and calls
`POST /v1beta/decisions`. This is a separate surface from `languageModel()`,
`generateText()`, and Interactions. It evaluates closed choices and returns
probabilities, with zero generated output tokens.

```ts
import { createGemini } from "@zhivex-ai/gemini";

const model = createGemini().decisionModel("gemini-decision-1");
const result = await model.decide({
  input: [
    { type: "text", text: "Review the recording and attached evidence.\n" },
    { type: "audio", uri: "https://example.com/call.mp3", mimeType: "audio/mp3" },
    { type: "video", uri: "https://example.com/inspection.mp4", mimeType: "video/mp4", resolution: "low" },
    { type: "document", uri: "https://example.com/invoice.pdf", mimeType: "application/pdf" }
  ],
  questions: {
    damaged: {
      type: "predicate",
      instructions: "Is the product damaged?",
      trueDescription: "The product is broken or faulty.",
      falseDescription: "Only the packaging is damaged."
    },
    team: {
      type: "choice", instructions: "Which team should handle the claim?",
      choices: [{ value: "returns", description: "Damaged products" }, { value: "billing", description: "Payment issues" }]
    },
    severity: { type: "score", instructions: "Rate the damage.", levels: ["None", "Cosmetic", "Unusable"] }
  },
  timeoutMs: 30_000
});

const answer = result.answers.damaged;
if (answer?.type === "predicate") {
  console.log(answer.probability, answer.providerConfidence);
}
console.log(result.usage.inputTokensByModality);
```

Replace the example URLs with accessible media. The SDK sends URIs directly to
Google; it does not download, transcribe, or convert them. Uploaded Files API
`file.uri` values work too. For local files, read bytes with Bun or Node and pass
base64 in `data` instead of `uri`, for example
`{ type: "document", data: pdfBase64, mimeType: "application/pdf" }`.
Use exactly one source per block. `mimeType` must match the actual file.

- Inputs support text, images (including HEIC/HEIF, BMP and TIFF), audio, video,
  and PDF. Image/video blocks accept `resolution: "low" | "medium" | "high"`;
  images additionally support `"ultra_high"`. Existing inline image `dataURL`
  parts work; remote images use `uri` plus `mimeType`.
- The shared `predicate`, `choice`, and `score` types map to Google's `noul`,
  `choice`, and `score`. Confidence is preserved for all three. Rubric results
  retain your labels alongside probabilities and the fractional weighted score;
  a level with a description is sent as `"label: description"`.
- Up to 1,000 questions, 2–255 choices or score levels, and a 262,144-token
  context across evidence and questions. Question IDs match `[A-Za-z0-9_-]`
  and have 1–64 characters. Choice values are strings, up to 128 characters
  and 512 UTF-8 bytes; descriptions may be omitted or empty.
- Instructions accept strings or text-part arrays. Adjacent text parts are sent
  unchanged; add your own separators. Serialize JSON and conversation history
  as text. Tools, conversation messages, media inside questions, caching,
  streaming, Batch, Flex, and Priority aren't supported on this endpoint.
- Inline media is limited to 100 MiB per request and PDF files to 50 MiB each;
  the SDK bounds the serialized request at 140 MiB to allow base64 overhead.
  Google enforces the 15 MB limit for external URLs and the token limit.
  HTTPS and Files API URIs are supported; YouTube and `gs://` URLs are rejected.
- Each call makes one HTTP attempt. `abortSignal` and `timeoutMs` bound the
  operation. HTTP errors, including safety-blocked requests (400), remain
  provider errors; there is no per-question refusal or automatic fallback.

Register the returned `DecisionModel` in the gateway's `decisions` map to use
`gateway.decide()`. All selected fallback destinations are validated before any
request is sent, including their media capabilities and input-size limits.

Contract source: [Google Decisions API](https://aistudio.google.com/docs/decisions-api),
checked November 11, 2026. Offline tests cover wire mapping, validation, errors,
and cancellation; they do not certify live model quality or latency.
