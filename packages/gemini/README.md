# @zhivex-ai/gemini

Gemini adapter for Zhivex AI SDK.

Supports Gemini text, audio understanding, multimodal embeddings, speech, realtime sessions, grounded generation, Files API, File Search stores, URL Context, Context Caching, Batch API, Interactions, raw prediction calls, and Google generative media models exposed through Gemini API endpoints such as Gemini Image / Nano Banana, Imagen, Veo, and Lyria 3.

| Surface | Support |
| --- | --- |
| Text, tools, structured output, audio input | `generateText()` |
| Multimodal embeddings | `embeddingModel("gemini-embedding-2")` |
| Text-to-speech | `speechModel()` |
| Live audio/text/image sessions | `realtimeModel()` |
| Files API, File Search stores, Context Caching, Batch API, Interactions | high-level |
| Google Search, URL Context, File Search, Code Execution, Computer Use | hosted tool helpers |
| Image, video, music generation | high-level |
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
  googleUrlContextTool,
  predictRaw,
  uploadFile
} from "@zhivex-ai/core";
import { createGemini } from "@zhivex-ai/gemini";

const gemini = createGemini({ apiKey: process.env.GEMINI_API_KEY });

await generateImage({
  model: gemini.imageGenerationModel!("gemini-3.1-flash-image"),
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

await createInteraction({
  provider: gemini,
  modelId: "gemini-3.5-flash",
  input: "Run a deep research style interaction."
});

await predictRaw({
  model: gemini.predictionModel!("custom-gemini-endpoint"),
  instances: [{ prompt: "provider-specific request" }]
});
```

Model Garden-style coverage is intentionally raw/prediction based. The adapter does not add a dedicated wrapper for every Google model family.

## Install

```bash
bun add @zhivex-ai/gemini
```

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
