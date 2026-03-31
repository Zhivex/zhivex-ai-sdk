import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

import { requiredEnv } from "../_shared";

const openai = createOpenAI({
  apiKey: requiredEnv("OPENAI_API_KEY")
});

const result = await generateText({
  model: openai("gpt-4o-mini"),
  system: "Be concise and technical.",
  prompt: "Explain what the Zhivex AI SDK gives me over using a provider SDK directly."
});

console.log(result.text);
console.log(result.finishReason);
console.log(result.usage);
