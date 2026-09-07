import { generateText } from "@zhivex-ai/sdk";
import { createVertex } from "@zhivex-ai/vertex";

import { requiredEnv } from "../_shared";

const vertex = createVertex({
  accessToken: requiredEnv("VERTEX_ACCESS_TOKEN"),
  projectId: requiredEnv("VERTEX_PROJECT_ID"),
  location: process.env.VERTEX_LOCATION ?? "global"
});

const result = await generateText({
  // Set VERTEX_MODEL to a Claude ID enabled in your Google Cloud project to use Anthropic on Vertex.
  model: vertex(process.env.VERTEX_MODEL ?? "gemini-3.7-flash"),
  prompt: "Say hello from the Vertex adapter."
});

console.log(result.text);
