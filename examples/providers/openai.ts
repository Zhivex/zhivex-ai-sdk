import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

import { requiredEnv } from "../_shared";

const openai = createOpenAI({
  apiKey: requiredEnv("OPENAI_API_KEY")
});

const result = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Say hello from the OpenAI adapter."
});

console.log(result.text);
