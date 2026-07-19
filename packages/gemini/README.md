# @zhivex-ai/gemini

Gemini adapter for Zhivex AI SDK.

Supports Gemini text, audio understanding, multimodal embeddings, speech, realtime sessions, grounded generation, Files API, File Search stores, URL Context, Context Caching, Batch API, Interactions, managed agents, raw prediction calls, and current Google generative media models such as Gemini Image / Nano Banana, Gemini Omni Flash, Veo 3.1, and Lyria 3.

| Surface | Support |
| --- | --- |
| Text, tools, structured output, audio input | `generateText()` |
| Multimodal embeddings | `embeddingModel("gemini-embedding-2")` |
| Text-to-speech | `generateSpeech()` and `streamSpeech()`; Gemini 3.1 TTS streams |
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
  googleFileSearchTool,
  googleMapsTool,
  googleUrlContextTool,
  predictRaw,
  resumeInteraction,
  streamSpeech,
  uploadFile
} from "@zhivex-ai/core";
import { createGemini } from "@zhivex-ai/gemini";

const gemini = createGemini({ apiKey: process.env.GEMINI_API_KEY });

await generateImage({
  model: gemini.imageGenerationModel!("gemini-3.1-flash-lite-image"),
  prompt: "Create a product photo"
});

await generateText({
  model: gemini("gemini-3.5-flash"),
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
  model: gemini("gemini-3.5-flash"),
  prompt: "Use the indexed docs and URL context.",
  tools: {
    docs: googleFileSearchTool([store.name]),
    urls: googleUrlContextTool()
  }
});

await createContextCache({
  provider: gemini,
  modelId: "gemini-3.5-flash",
  contents: [{ role: "user", parts: [{ type: "file", data: file.uri ?? file.name, mediaType: "text/plain" }] }]
});

await createBatch({
  provider: gemini,
  modelId: "gemini-3.5-flash",
  requests: [{ request: { contents: [{ parts: [{ text: "Summarize this." }] }] } }]
});

const nearby = await createInteraction({
  provider: gemini,
  modelId: "gemini-3.5-flash",
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
  modelId: "gemini-omni-flash-preview",
  input: "A marble rolling through a chain-reaction track.",
  responseFormat: { type: "video", aspect_ratio: "16:9" }
});

await predictRaw({
  model: gemini.predictionModel!("custom-gemini-endpoint"),
  instances: [{ prompt: "provider-specific request" }]
});
```

For new Gemini projects, Google recommends the generally available Interactions API. `createInteraction()` and `streamInteraction()` expose that API, including typed `steps`, convenience outputs such as `outputText` / `outputImage` / `outputAudio` / `outputVideo`, server-side continuation with `previousInteractionId`, background execution, and model or managed-agent calls. Request controls use the portable camel-case fields `systemInstruction`, `responseFormat`, `generationConfig`, `agentConfig`, `environment`, and `labels`; `resumeInteraction()` reconnects to background SSE and accepts `lastEventId` for event-safe continuation, while `getInteraction()`, `cancelInteraction()`, and `deleteInteraction()` manage stored or background work. `generateText()` remains the portable Zhivex path and uses Google's still-supported `generateContent` API; Batch API, explicit Context Caching, video metadata, and custom safety settings are not currently available through Interactions upstream.

Gemini 3.1 TTS supports buffered audio through `generateSpeech()` and incremental audio through `streamSpeech()`. Each streamed value is a `SpeechOutput` chunk; consume or forward `chunk.audio` as it arrives instead of waiting for the complete recording.

Current model guidance:

- Default text/agentic work: `gemini-3.5-flash`; high-volume low-latency work: `gemini-3.1-flash-lite`.
- Managed agents: pass `deep-research-preview-04-2026`, `deep-research-max-preview-04-2026`, or `antigravity-preview-05-2026` through the `agent` field instead of `modelId`.
- Image generation: `gemini-3.1-flash-lite-image` for 1K low-cost output, `gemini-3.1-flash-image` for up to 4K/high-volume work, or `gemini-3-pro-image` for highest-quality composition.
- Video: `gemini-omni-flash-preview` is an Interactions-only preview for conversational 3-10 second video generation/editing. The `generateVideo()` helper uses the separate Veo family, including `veo-3.1-lite-generate-preview`, `veo-3.1-generate-preview`, and `veo-3.1-fast-generate-preview`.
- Imagen 4 IDs are intentionally no longer recommended: Google has announced shutdown for August 17, 2026. Gemini 2.0 model IDs and the old image preview IDs are already shut down.

The built-in catalog records Gemini 3.5 Flash Standard text-token pricing as separate input, cached-input, and output rates; it does not treat the input price as a blended per-token estimate. Audio, media output, tools, agents, Batch, Flex, Priority, and storage have separate upstream prices.

Interactions store resources by default upstream. Pass `store: false` when you do not need server-side continuation, background execution, or stored interaction logs. Preview models and managed agents can have narrower availability and rate limits than GA models.

Google Maps grounding returns place-citation annotations in the interaction's model-output content. Applications must display the associated Google Maps source names and links immediately after the grounded content, following Google's attribution rules; do not discard `steps` when rendering a Maps answer.

See Google's current [Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview), [TTS guide](https://ai.google.dev/gemini-api/docs/speech-generation), [Maps grounding requirements](https://ai.google.dev/gemini-api/docs/maps-grounding), [model list](https://ai.google.dev/gemini-api/docs/models), [deprecation schedule](https://ai.google.dev/gemini-api/docs/deprecations), [pricing](https://ai.google.dev/gemini-api/docs/pricing), and [Gemini Omni Flash guide](https://ai.google.dev/gemini-api/docs/omni).

Model Garden-style coverage is intentionally raw/prediction based. The adapter does not add a dedicated wrapper for every Google model family.

## Install

```bash
bun add @zhivex-ai/gemini
```

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
