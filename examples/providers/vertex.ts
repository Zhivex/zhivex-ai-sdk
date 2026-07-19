import { generateText } from "@zhivex-ai/sdk";
import { createVertex } from "@zhivex-ai/vertex";

import { requiredEnv } from "../_shared";

const vertex = createVertex({
  accessToken: requiredEnv("VERTEX_ACCESS_TOKEN"),
  projectId: requiredEnv("VERTEX_PROJECT_ID"),
  location: process.env.VERTEX_LOCATION ?? "global"
});

const result = await generateText({
  model: vertex("gemini-3.5-flash"),
  prompt: "Say hello from the Vertex adapter."
});

console.log(result.text);
