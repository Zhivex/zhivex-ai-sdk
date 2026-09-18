# Media recipes

Multimodal messages, embeddings, audio, media, and provider-native resources.

[Documentation index](../README.md)

## Multimodal Messages

Use explicit messages when you need full control over roles, parts, or multimodal inputs.

```ts
import { generateText, user } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-4o-mini"),
  messages: [
    user([
      { type: "text", text: "Describe this image." },
      { type: "image", image: "https://example.com/cat.jpg" }
    ])
  ]
});

console.log(result.text);
```

## Embeddings

```ts
import { embedMany } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await embedMany({
  model: openai.embeddingModel("text-embedding-3-small"),
  value: ["Zhivex AI SDK", "Unified providers"]
});

console.log(result.embeddings.length);
```

Ollama also supports the shared embeddings contract through its `/api/embed` endpoint:

```ts
import { embed } from "@zhivex-ai/sdk";
import { createOllama } from "@zhivex-ai/ollama";

const ollama = createOllama();

const result = await embed({
  model: ollama.embeddingModel("embeddinggemma"),
  value: "Zhivex AI SDK"
});

console.log(result.embeddings[0]?.length);
```

Gemini supports multimodal embedding values through `gemini-embedding-2`; other embedding providers remain text-only unless their adapter explicitly documents media support.

```ts
import { embed } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const imageEmbedding = await embed({
  model: gemini.embeddingModel("gemini-embedding-2"),
  value: {
    uri: "gs://my-bucket/product-photo.png",
    mediaType: "image/png"
  }
});

console.log(imageEmbedding.embeddings[0]?.length);
```

For RAG-backed agents, use `chunkText()`, `embedRetrievalDocuments()`, `retrieveContext()`, and `createRetrievalContextMessage()` with an app-owned vector store. See [RAG Guide](../RAG.md).

## Audio

Use the shared audio primitives when you want a provider-agnostic contract for transcription or text-to-speech.

Audio adapters bound provider responses before buffering or parsing them. The defaults are 16 MiB for decoded speech, 4 MiB for transcription JSON, and 64 KiB for provider error bodies. Configure stricter application limits when creating OpenAI, Azure OpenAI, or Qwen providers:

```ts
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  responseLimits: {
    speechBytes: 16 * 1024 * 1024,
    transcriptionBytes: 1024 * 1024,
    errorBodyBytes: 64 * 1024,
    toolCallArgumentChars: 256 * 1024
  }
});
```

`Content-Length` is used for early rejection, while chunked bodies are counted as they are read. Oversized successful responses throw `ProviderResponseTooLargeError`; oversized provider error bodies remain `ProviderHTTPError` instances with a bounded, truncated `responseBody`. Qwen validates decoded base64 size before allocation and omits the encoded audio payload from `rawResponse` after decoding.

OpenAI Responses function calls are assembled with the configured argument bound and released to Core only after terminal `response.completed`. Malformed, inconsistent, failed, incomplete, or truncated calls throw the sanitized `ProviderToolCallError` with code `OPENAI_RESPONSES_TOOL_CALL_INVALID`; the error contains diagnostic metadata but never raw arguments, prompts, provider bodies, or tool names. Retry only when `retryable` is `true` and `effectsPossible` is `false`. Durable agent state preserves the same safe diagnostic fields under `state.error`.

```ts
import { generateSpeech, transcribeAudio } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const transcript = await transcribeAudio({
  model: openai.transcriptionModel("gpt-4o-mini-transcribe"),
  audio: {
    data: "BASE64_AUDIO",
    mediaType: "audio/wav",
    filename: "sample.wav"
  }
});

const speech = await generateSpeech({
  model: openai.speechModel("gpt-4o-mini-tts"),
  input: transcript.text
});

console.log(transcript.text);
console.log(speech.mediaType, speech.audio.length);
```

Audio-capable chat models can also receive and return audio through normal language-model generation:

```ts
import { audioPart, generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const answer = await generateText({
  model: openai("gpt-audio-mini"),
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
  ],
  providerOptions: {
    modalities: ["text", "audio"],
    audio: { voice: "alloy", format: "wav" }
  }
});

console.log(answer.text);
console.log(answer.audio?.[0]?.mediaType);
```

Gemini language models can receive audio parts for understanding and summarization through `generateText()`:

```ts
import { audioPart, generateText } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const summary = await generateText({
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

console.log(summary.text);
```

For dedicated speech-to-text, Gemini 3.5 Transcribe uses the Files and Interactions APIs and preserves word timestamps and diarization annotations in `rawResponse`:

```ts
import { transcribeAudio } from "@zhivex-ai/sdk";

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
```

For Gemini audio output, use `speechModel()` with `generateSpeech()` for buffered TTS, `streamSpeech()` for incremental Gemini 3.1 TTS audio, or `realtimeModel()` for Live sessions; regular Gemini `generateText()` keeps audio output disabled.

```ts
import { streamSpeech } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";

const geminiSpeech = createGemini({ apiKey: process.env.GEMINI_API_KEY });

for await (const chunk of await streamSpeech({
  model: geminiSpeech.speechModel!("gemini-3.1-flash-tts-preview"),
  input: "Read this announcement as it is generated.",
  voice: "Kore"
})) {
  console.log(chunk.mediaType, chunk.audio.byteLength);
}
```

## Generative Media

Use the shared media primitives with Google models that expose image, video, or music generation.

```ts
import { generateImage, generateMusic, generateVideo } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const image = await generateImage({
  model: gemini.imageGenerationModel!("gemini-3.1-flash-lite-image"),
  prompt: "Create a crisp product shot of a matte black espresso cup"
});

const video = await generateVideo({
  model: gemini.videoGenerationModel!("veo-3.1-generate-preview"),
  prompt: "A cinematic dolly shot through a quiet modern library"
});

const music = await generateMusic({
  model: gemini.musicGenerationModel!("lyria-3-clip-preview"),
  prompt: "Create a 30-second optimistic acoustic intro"
});

console.log(image.images[0]?.mediaType);
console.log(video.videos[0]?.uri);
console.log(music.audio[0]?.mediaType);
```

## Google Files, Retrieval, Batch, Interactions, And Raw Prediction

Gemini and Vertex expose Google-native surfaces in two layers:

| Surface | Gemini | Vertex |
| --- | --- | --- |
| Files API | high-level | not exposed by the same Vertex contract |
| File Search stores | high-level + hosted tool | hosted tool only when the selected Vertex endpoint supports it |
| Google Maps grounding | Interactions + hosted tool | hosted tool where the selected endpoint supports it |
| URL Context | hosted tool | hosted tool |
| Context Caching | high-level | high-level |
| Batch API | high-level | high-level |
| Interactions / Deep Research / managed agents | high-level | not exposed by the same Vertex contract |
| Gemini Omni Flash | Interactions API | not exposed by this adapter |
| Model Garden / publisher prediction | raw/prediction | explicit publisher resource, raw contract |

```ts
import {
  createBatch,
  createContextCache,
  createFileSearchStore,
  createInteraction,
  generateText,
  googleComputerUseTool,
  googleFileSearchTool,
  googleMapsTool,
  googleUrlContextTool,
  predictRaw,
  resumeInteraction,
  uploadFile
} from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";
import { createVertex } from "@zhivex-ai/vertex";

const gemini = createGemini({ apiKey: process.env.GEMINI_API_KEY });

const file = await uploadFile({
  provider: gemini,
  data: "SDK notes",
  mediaType: "text/plain",
  displayName: "notes.txt"
});

const store = await createFileSearchStore({ provider: gemini, displayName: "Docs" });

await generateText({
  model: gemini("gemini-3.7-flash"),
  prompt: "Answer from the indexed docs and this URL.",
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

const computer = await createInteraction({
  provider: gemini,
  modelId: "gemini-3.5-flash",
  input: "Open the dashboard and find the failed checkout.",
  tools: {
    computer: googleComputerUseTool({ environment: "browser" })
  }
});

await createInteraction({
  provider: gemini,
  modelId: "gemini-3.5-flash",
  previousInteractionId: computer.id,
  input: [
    {
      screenshot: "data:image/png;base64,...",
      function_response: {
        name: "computer_use",
        response: { status: "clicked" }
      }
    }
  ],
  tools: {
    computer: googleComputerUseTool({ environment: "browser" })
  }
});

const vertex = createVertex({
  apiKey: process.env.GOOGLE_API_KEY
});

const productionVertex = createVertex({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION ?? "global"
});

await generateText({
  model: vertex("gemini-3.7-flash"),
  prompt: "Use the API-key quickstart path."
});

const raw = await predictRaw({
  model: productionVertex.predictionModel!("publisher-model-id"),
  instances: [{ prompt: "provider-specific request" }],
  parameters: { temperature: 0.2 }
});

console.log(raw.rawResponse);
```

Vertex authentication follows Google's current guidance: use `apiKey`, `VERTEX_API_KEY`, or `GOOGLE_API_KEY` for testing, and use ADC/service-account credentials in production. `createVertex({ projectId, location })` resolves ADC automatically, while `authClient`, `getAccessToken`, and `accessToken` remain available for explicit integrations. See Google's docs for [API keys](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/api-keys), the [Vertex AI quickstart](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start?usertype=apikey), and [Vertex AI authentication](https://docs.cloud.google.com/vertex-ai/docs/authentication).

Naming note: Google now presents this product surface as [Gemini Enterprise Agent Platform, formerly Vertex AI](https://cloud.google.com/products/gemini-enterprise-agent-platform), and its migration docs say Vertex AI is transitioning to become part of Agent Platform. The SDK keeps `@zhivex-ai/vertex`, `createVertex()`, and provider id `"vertex"` for compatibility while Google Cloud's public API surface still uses Vertex/`aiplatform.googleapis.com` endpoints.

For new Gemini Developer API projects, Google recommends Interactions. Zhivex exposes it through `createInteraction()` and `streamInteraction()` while keeping `generateText()` on the still-supported `generateContent` API for portable provider behavior. Interactions support model and managed-agent calls, typed execution `steps`, convenience outputs such as `outputText` / `outputImage` / `outputAudio` / `outputVideo`, server-side continuation, background execution, and multimodal output. Request controls use `systemInstruction`, `responseFormat`, `generationConfig`, `agentConfig`, `environment`, and `labels`; `resumeInteraction()` reconnects to background SSE and accepts `lastEventId` for event-safe continuation, while stored/background interactions can also be read, cancelled, and deleted with `getInteraction()`, `cancelInteraction()`, and `deleteInteraction()`. Upstream does not yet expose Batch API, explicit Context Caching, video metadata, or custom safety settings through Interactions. Interactions are stored by default upstream, so use `store: false` when server-side state and background execution are unnecessary.

Google Maps answers include source annotations in model-output content. Preserve those `steps` and display the associated source names and Google Maps links immediately after the grounded answer; Google requires that attribution in user-facing applications. Vertex Maps grounding returns equivalent provider metadata through its `generateContent` response.

Current Google model selection differs by platform:

- Gemini managed-agent calls use the `agent` field with IDs such as `deep-research-preview-04-2026`, `deep-research-max-preview-04-2026`, and `antigravity-preview-05-2026`; they are not model IDs.
- Gemini Developer API video helpers use `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`, or `veo-3.1-lite-generate-preview`. Conversational video generation/editing uses the GA Interactions-only `gemini-omni-1.1-flash`; `gemini-omni-flash-preview` remains only as a migration entry before its September 30, 2026 deprecation.
- Vertex uses the Veo IDs `veo-3.1-generate-001`, `veo-3.1-fast-generate-001`, and `veo-3.1-lite-generate-001`. Do not copy the Gemini Developer API Veo `*-preview` IDs into Vertex examples.
- Both catalogs prefer `gemini-3.7-flash` for the current general-purpose Flash model and `gemini-3.5-flash-lite` for high-volume, low-cost work, while retaining `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.1-flash-lite`, the current Gemini 3 image models, and `gemini-embedding-2`. Gemini 3.7 supports only `low`, `medium`, and `high` thinking levels and rejects `minimal`. The mutable `gemini-flash-latest` and `gemini-flash-lite-latest` IDs are accepted upstream, but stable IDs are required for reproducible routing and pricing; the catalog therefore keeps only Google's last explicit `gemini-flash-latest` mapping and does not infer a new alias target. Imagen 4 is omitted because its Gemini API shutdown is scheduled for August 17, 2026 and Google Cloud already required migration away from it.
- Vertex defaults to `location: "global"`, which uses `aiplatform.googleapis.com`. Veo models created through `videoGenerationModel()` are routed from that global default to `us-central1`, where Veo 3.1 is available; explicit non-global locations and custom `baseURL` values are preserved. Use `us`, `eu`, or another regional endpoint only after checking model availability, data-residency requirements, and the non-global pricing/features for that model.
- Catalog pricing for Gemini 3.7 Flash, Gemini 3.6 Flash, and Gemini 3.5 Flash-Lite uses separate Standard global input, cached-input, and output text-token rates. It is not a blended estimate; non-global Vertex, tools, agents, Batch/Flex, Priority, tuning, storage, and Provisioned Throughput prices are outside those catalog entries.

Official references: [Gemini Interactions](https://ai.google.dev/gemini-api/docs/interactions-overview), [Gemini TTS and streaming](https://ai.google.dev/gemini-api/docs/speech-generation), [Google Maps grounding requirements](https://ai.google.dev/gemini-api/docs/maps-grounding), [Gemini models](https://ai.google.dev/gemini-api/docs/models), [Gemini deprecations](https://ai.google.dev/gemini-api/docs/deprecations), [Agent Platform model lifecycle](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions), and [Agent Platform locations](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations).

Use `vertex("claude-sonnet-4-6")` for Claude on Vertex with Google Cloud bearer credentials; API-key/Express mode is not supported for this route. Text, client tool loops, streaming, reasoning, and supported native structured output reuse the Anthropic message contract while preserving provider identity `vertex`. Hosted Anthropic tools, Files API IDs, and direct-API beta features are explicitly rejected. See the [Vertex package guide](../../packages/vertex/README.md#claude-on-vertex) for access requirements and limitations.

Use `predictionModel("publishers/<publisher>/models/<id>")` with a model-specific request body and action for raw publisher predictions. Bare prediction IDs default to Google. The SDK preserves `rawResponse`; this transport does not imply normalized support for every Model Garden model or Agent Platform's managed agent services.

## Grounded Web Search

`generateGroundedText()` runs a grounded generation request and returns normalized sources alongside the final answer.

```ts
import { generateGroundedText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateGroundedText({
  model: openai.groundedLanguageModel("gpt-4o-search-preview"),
  prompt: "What changed recently in multi-provider AI SDKs?"
});

console.log(result.text);
console.log(result.sources);
```

