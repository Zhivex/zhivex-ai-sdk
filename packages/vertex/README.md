# @zhivex-ai/vertex

Vertex AI / Gemini Enterprise Agent Platform adapter for Zhivex AI SDK.

Supports Vertex Gemini text, multimodal embeddings, speech, realtime sessions, grounded generation, Context Caching, Batch API, raw prediction calls, and current Google generative media endpoints for Gemini Image, Veo 3.1, and Lyria 2.

Google is transitioning Vertex AI into Gemini Enterprise Agent Platform. The SDK keeps the package name `@zhivex-ai/vertex`, the factory `createVertex()`, and provider id `"vertex"` for backwards compatibility and because the public API endpoints still use `aiplatform.googleapis.com`. Treat "Vertex" in this package as the Google Cloud Agent Platform / Vertex API surface, not as a separate deprecated wire contract.

| Surface | Support |
| --- | --- |
| Text, tools, structured output, audio input | `generateText()` |
| Multimodal embeddings | `embeddingModel("gemini-embedding-2")` |
| Speech and realtime sessions | `generateSpeech()`, `streamSpeech()`, and `realtimeModel()`; model and location dependent |
| Context Caching and Batch API | high-level |
| Google Search, Google Maps, URL Context, Code Execution, Computer Use | hosted tool helpers where the selected endpoint supports them |
| Image, video, music generation | high-level |
| Vertex publisher models / Model Garden | `predictionModel()` raw/prediction |
| Gemini Files API, Gemini File Search stores, Interactions | explicit unsupported surface in this adapter |

```ts
import {
  createBatch,
  createContextCache,
  generateImage,
  generateMusic,
  generateText,
  generateVideo,
  googleMapsTool,
  googleUrlContextTool,
  predictRaw,
  streamSpeech
} from "@zhivex-ai/core";
import { createVertex } from "@zhivex-ai/vertex";

const vertex = createVertex({
  apiKey: process.env.GOOGLE_API_KEY
});

const productionVertex = createVertex({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION ?? "global"
});

const advancedProductionVertex = createVertex({
  getAccessToken: async () => {
    // Optional: supply your own service-account or token-broker integration.
    return process.env.VERTEX_ACCESS_TOKEN!;
  },
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION ?? "global"
});

for await (const chunk of await streamSpeech({
  model: productionVertex.speechModel!("gemini-3.1-flash-tts-preview"),
  input: "Read this announcement as it is generated.",
  voice: "Kore"
})) {
  console.log(chunk.mediaType, chunk.audio.byteLength);
}

await generateImage({
  model: productionVertex.imageGenerationModel!("gemini-3.1-flash-lite-image"),
  prompt: "Create a product photo"
});

await generateVideo({
  model: productionVertex.videoGenerationModel!("veo-3.1-generate-001"),
  prompt: "Create a cinematic establishing shot"
});

await generateMusic({
  model: productionVertex.musicGenerationModel!("lyria-002"),
  prompt: "Create a short instrumental intro"
});

await generateText({
  model: vertex("gemini-3.5-flash"),
  prompt: "Use URL context for the linked source.",
  tools: {
    urls: googleUrlContextTool()
  }
});

const nearby = await generateText({
  model: vertex("gemini-3.5-flash"),
  prompt: "Find well-reviewed cafes near this location.",
  tools: {
    maps: googleMapsTool({ latitude: 34.050481, longitude: -118.248526 })
  }
});
console.log(nearby.text, nearby.rawResponse);

await createContextCache({
  provider: productionVertex,
  modelId: "gemini-3.5-flash",
  contents: [{ role: "user", parts: [{ type: "file", data: "gs://bucket/large.pdf", mediaType: "application/pdf" }] }]
});

await createBatch({
  provider: productionVertex,
  modelId: "gemini-3.5-flash",
  fileName: "files/batch-input"
});

await predictRaw({
  model: advancedProductionVertex.predictionModel!("publisher-model-id"),
  instances: [{ prompt: "provider-specific request" }],
  parameters: { temperature: 0.2 }
});
```

Authentication follows the current Google guidance for Gemini on Vertex AI: API keys are supported for testing with `apiKey`, `VERTEX_API_KEY`, or `GOOGLE_API_KEY`, while production can use automatic ADC with `createVertex({ projectId, location })` or explicit service-account integrations through `authClient`, `getAccessToken`, or `accessToken`. See Google's guides for [API keys](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/api-keys), the [Vertex AI quickstart](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start?usertype=apikey), and [Vertex AI authentication](https://docs.cloud.google.com/vertex-ai/docs/authentication).

Use `location: "global"` for the broadest current Gemini 3 availability. The global REST host is `aiplatform.googleapis.com`; regional hosts use `<location>-aiplatform.googleapis.com`. Because Veo 3.1 is not served from the global endpoint, `videoGenerationModel("veo-...")` automatically routes a global Vertex provider to `us-central1`; explicit non-global locations and custom `baseURL` values remain unchanged. Gemini 3.5 Flash also supports the `us` and `eu` jurisdictional multi-regions and a limited set of regional endpoints, but model features, pricing, data residency, and Provisioned Throughput differ by location. Choose a non-global location only after checking the selected model's location table.

Current model guidance:

- Default text/agentic work: `gemini-3.5-flash`; high-volume low-latency work: `gemini-3.1-flash-lite`.
- Image generation: `gemini-3.1-flash-lite-image`, `gemini-3.1-flash-image`, or `gemini-3-pro-image`. The Flash-Lite image model has shorter lifecycle guarantees than the 12-month GA image models.
- Video: use the Google Cloud IDs `veo-3.1-generate-001`, `veo-3.1-fast-generate-001`, and `veo-3.1-lite-generate-001`. The Gemini Developer API uses different Veo `*-preview` IDs.
- Embeddings: `gemini-embedding-2` is the current multimodal model and is available on `global`, `us`, and `eu`.
- Speech: `gemini-3.1-flash-tts-preview` supports buffered `generateSpeech()` and incremental `streamSpeech()` output. It is currently available through the Vertex AI API on `global`; older Gemini 2.5 TTS models have broader regional coverage.
- Music: `lyria-002` is the GA model supported by `musicGenerationModel()`. Lyria 3 currently uses Agent Platform's Interactions API, which this adapter does not expose.
- Imagen 4 and older Veo endpoints are intentionally no longer recommended here; Google Cloud required migration away from them by June 30, 2026.

The built-in catalog's Gemini 3.5 Flash rates represent Standard global text-token pricing. Non-global Vertex endpoints currently cost more, and media, tools, Batch/Flex, Priority, tuning, and Provisioned Throughput use separate pricing.

Gemini Omni Flash and the Gemini Developer API Interactions/Managed Agents surface are not exposed by this Vertex adapter. Do not substitute `gemini-omni-flash-preview` into `videoGenerationModel()`; use `@zhivex-ai/gemini` with `createInteraction()` for that preview.

When Google Maps grounding is enabled, retain the provider response metadata and render the returned source names and Google Maps links directly after the grounded content. Google requires those sources and its text attribution to remain visible to the end user.

See Google's current [Agent Platform model lifecycle](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions), [Gemini 3.5 Flash model card](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash), [Gemini TTS on Vertex](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts), [Maps grounding requirements](https://ai.google.dev/gemini-api/docs/maps-grounding), [deployment locations](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations), [pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing), and [release notes](https://docs.cloud.google.com/gemini-enterprise-agent-platform/release-notes).

Google's current product page labels this surface as [Gemini Enterprise Agent Platform, formerly Vertex AI](https://cloud.google.com/products/gemini-enterprise-agent-platform), and Google's migration docs say Vertex AI is transitioning to become part of Agent Platform. This package intentionally does not rename the provider id yet; doing so would be a breaking API change without a corresponding endpoint-level migration requirement.

Model Garden coverage is intentionally raw/prediction based. The adapter does not add a dedicated wrapper for every publisher model.

## Install

```bash
bun add @zhivex-ai/vertex
```

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
