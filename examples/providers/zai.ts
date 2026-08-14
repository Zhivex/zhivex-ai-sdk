import { generateText } from "@zhivex-ai/core";
import { createZAI } from "@zhivex-ai/zai";

const zai = createZAI({
  apiKey: process.env.ZAI_API_KEY,
  endpoint: "coding"
});

const result = await generateText({
  model: zai("glm-5.3"),
  prompt: "Give one concise recommendation for reviewing an authorization boundary.",
  reasoning: { effort: "high" },
  maxTokens: 256
});

console.log(result.text);
