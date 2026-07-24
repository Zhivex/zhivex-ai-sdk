import { generateText } from "@zhivex-ai/sdk";
import { createAnthropic } from "@zhivex-ai/anthropic";

import { requiredEnv } from "../_shared";

const anthropic = createAnthropic({
  apiKey: requiredEnv("ANTHROPIC_API_KEY")
});

const result = await generateText({
  model: anthropic("claude-opus-5"),
  prompt: "Say hello from the Anthropic adapter.",
  maxTokens: 4096,
  reasoning: {
    effort: "high"
  }
});

console.log(result.text);
