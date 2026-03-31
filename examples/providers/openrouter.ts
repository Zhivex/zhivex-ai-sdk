import { generateText } from "@zhivex-ai/sdk";
import { createOpenRouter } from "@zhivex-ai/openrouter";

import { requiredEnv } from "../_shared";

const openrouter = createOpenRouter({
  apiKey: requiredEnv("OPENROUTER_API_KEY"),
  appName: "zhivex-ai-sdk-examples",
  appURL: "https://github.com/Zhivex/zhivex-ai-sdk"
});

const result = await generateText({
  model: openrouter("openai/gpt-4o-mini"),
  prompt: "Say hello from the OpenRouter adapter."
});

console.log(result.text);
