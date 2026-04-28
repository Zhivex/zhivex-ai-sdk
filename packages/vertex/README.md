# @zhivex-ai/vertex

Vertex AI adapter for Zhivex AI SDK.

Supports Vertex Gemini text, embeddings, speech, realtime sessions, grounded generation, Context Caching, Batch API, raw prediction calls, and Google generative media endpoints for Gemini Image, Imagen, Veo, and Lyria.

| Surface | Support |
| --- | --- |
| Text, tools, structured output, embeddings | high-level |
| Context Caching and Batch API | high-level |
| Google Search, URL Context, Code Execution, Computer Use | hosted tool helpers where the selected endpoint supports them |
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
  googleUrlContextTool,
  predictRaw
} from "@zhivex-ai/core";
import { createVertex } from "@zhivex-ai/vertex";

const vertex = createVertex({
  apiKey: process.env.GOOGLE_API_KEY
});

const productionVertex = createVertex({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1"
});

const advancedProductionVertex = createVertex({
  getAccessToken: async () => {
    // Optional: supply your own service-account or token-broker integration.
    return process.env.VERTEX_ACCESS_TOKEN!;
  },
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1"
});

await generateImage({
  model: productionVertex.imageGenerationModel!("imagen-4.0-generate-001"),
  prompt: "Create a product photo"
});

await generateVideo({
  model: productionVertex.videoGenerationModel!("veo-3.1-generate-preview"),
  prompt: "Create a cinematic establishing shot"
});

await generateMusic({
  model: productionVertex.musicGenerationModel!("lyria-002"),
  prompt: "Create a short instrumental intro"
});

await generateText({
  model: vertex("gemini-2.5-flash"),
  prompt: "Use URL context for the linked source.",
  tools: {
    urls: googleUrlContextTool()
  }
});

await createContextCache({
  provider: productionVertex,
  modelId: "gemini-2.5-flash",
  contents: [{ role: "user", parts: [{ type: "file", data: "gs://bucket/large.pdf", mediaType: "application/pdf" }] }]
});

await createBatch({
  provider: productionVertex,
  modelId: "gemini-2.5-flash",
  fileName: "files/batch-input"
});

await predictRaw({
  model: advancedProductionVertex.predictionModel!("publisher-model-id"),
  instances: [{ prompt: "provider-specific request" }],
  parameters: { temperature: 0.2 }
});
```

Authentication follows the current Google guidance for Gemini on Vertex AI: API keys are supported for testing with `apiKey`, `VERTEX_API_KEY`, or `GOOGLE_API_KEY`, while production can use automatic ADC with `createVertex({ projectId, location })` or explicit service-account integrations through `authClient`, `getAccessToken`, or `accessToken`. See Google's guides for [API keys](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/api-keys), the [Vertex AI quickstart](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start?usertype=apikey), and [Vertex AI authentication](https://docs.cloud.google.com/vertex-ai/docs/authentication).

Model Garden coverage is intentionally raw/prediction based. The adapter does not add a dedicated wrapper for every publisher model.

## Install

```bash
bun add @zhivex-ai/vertex
```

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
