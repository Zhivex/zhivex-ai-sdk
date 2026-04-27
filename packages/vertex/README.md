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
  accessToken: process.env.VERTEX_ACCESS_TOKEN,
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  location: "us-central1"
});

await generateImage({
  model: vertex.imageGenerationModel!("imagen-4.0-generate-001"),
  prompt: "Create a product photo"
});

await generateVideo({
  model: vertex.videoGenerationModel!("veo-3.1-generate-preview"),
  prompt: "Create a cinematic establishing shot"
});

await generateMusic({
  model: vertex.musicGenerationModel!("lyria-002"),
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
  provider: vertex,
  modelId: "gemini-2.5-flash",
  contents: [{ role: "user", parts: [{ type: "file", data: "gs://bucket/large.pdf", mediaType: "application/pdf" }] }]
});

await createBatch({
  provider: vertex,
  modelId: "gemini-2.5-flash",
  fileName: "files/batch-input"
});

await predictRaw({
  model: vertex.predictionModel!("publisher-model-id"),
  instances: [{ prompt: "provider-specific request" }],
  parameters: { temperature: 0.2 }
});
```

Model Garden coverage is intentionally raw/prediction based. The adapter does not add a dedicated wrapper for every publisher model.

## Install

```bash
bun add @zhivex-ai/vertex
```

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
