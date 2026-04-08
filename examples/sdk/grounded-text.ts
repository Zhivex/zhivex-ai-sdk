import { generateGroundedText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

import { requiredEnv, section } from "../_shared";

const openai = createOpenAI({
  apiKey: requiredEnv("OPENAI_API_KEY")
});

section("Grounded Search");

const result = await generateGroundedText({
  model: openai.groundedLanguageModel!("gpt-4o-search-preview"),
  prompt: "What are the latest capabilities highlighted for Zhivex AI SDK style provider abstractions?"
});

console.log(result.text);
console.log(result.sources);
