import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

import { requiredEnv } from "../_shared";

const openai = createOpenAI({
  apiKey: requiredEnv("OPENAI_API_KEY")
});

const result = await generateText({
  model: openai("gpt-5"),
  prompt: "Compare a circuit breaker and retries in API client design.",
  maxTokens: 700,
  reasoning: {
    effort: "high"
  }
});

console.log(result.text);
