import { generateText } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";

import { requiredEnv } from "../_shared";

const gemini = createGemini({
  apiKey: requiredEnv("GEMINI_API_KEY")
});

const result = await generateText({
  model: gemini("gemini-2.0-flash"),
  prompt: "Say hello from the Gemini adapter."
});

console.log(result.text);
