import { generateText } from "@zhivex-ai/sdk";
import { createVertex } from "@zhivex-ai/vertex";

import { requiredEnv } from "../_shared";

const vertex = createVertex({
  accessToken: requiredEnv("VERTEX_ACCESS_TOKEN"),
  projectId: requiredEnv("VERTEX_PROJECT_ID"),
  location: process.env.VERTEX_LOCATION ?? "us-central1"
});

const result = await generateText({
  model: vertex("gemini-2.0-flash"),
  prompt: "Say hello from the Vertex adapter."
});

console.log(result.text);
