import { generateText } from "@zhivex-ai/sdk";
import { createAnthropic } from "@zhivex-ai/anthropic";

import { requiredEnv } from "../_shared";

const anthropic = createAnthropic({
  apiKey: requiredEnv("ANTHROPIC_API_KEY")
});

const result = await generateText({
  model: anthropic("claude-3-5-sonnet"),
  prompt: "Say hello from the Anthropic adapter."
});

console.log(result.text);
